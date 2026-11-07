import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContainerName, checkLocale, LOCALE_QUERY, POSTGRES_IMAGE, POSTGRES_LOCALE, sortMigrationNames } from "./test-hosted-db.mjs";

/** One disposable PostgreSQL for a whole hosted-db run. The migrations are replayed once, by one psql process
 * that opens a fresh session for every file (`\connect` then `\i`), exactly as one `psql` run per file did, but
 * without a `docker exec` and a psql start per file. Along the way it leaves copies at the points the PostgreSQL
 * scripts start from; each script then gets its own database with `CREATE DATABASE … TEMPLATE`, so each still
 * starts from a database no other test has touched. */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS = join(repositoryRoot, "supabase", "migrations");
const TESTS = join(repositoryRoot, "supabase", "tests");
/** Where the files are copied inside the container (psql runs there and reads them with `\i`). */
const IN_CONTAINER = "/qorpera";
const PASSWORD = "qorpera-test-only";
/** Production's function default privileges (Supabase grants EXECUTE on new public functions to the API
 * roles), applied after the test bootstrap and before any migration, so every database built here has
 * production's function ACLs. Scripts that load bootstrap.sql themselves do not get them yet. */
const PLATFORM_DEFAULTS = "platform-function-defaults.sql";
const BOOTSTRAP = [`${IN_CONTAINER}/bootstrap.sql`, `${IN_CONTAINER}/${PLATFORM_DEFAULTS}`];
/** The migrated database every copy is taken from; it is never connected to after the build. */
export const MIGRATED = "qorpera_migrated";
/** Set by the suite for the scripts it starts: the shared container and its snapshots. */
export const CLUSTER_ENV = "QORPERA_HOSTED_DB_CLUSTER";
const DATABASE = /^[a-z][a-z0-9_]{0,62}$/;
const CONTAINER = /^qorpera-hosted-db-\d+-[0-9a-f]{8}$/;

/** A full build is kept on the machine for later runs (a warm copy; `hostedDatabase` says which): its data directory, in a docker volume
 * `qorpera-hosted-db-warm-<link>-<seconds>-<random>`, and a volume of the same name with `-ready` after it once the
 * copy is complete. The link (`warmChain`) covers everything the build came from, so a copy is used only by a run
 * whose image, bootstrap, build scripts and first migrations are byte for byte the ones it was made from. */
const WARM = /^qorpera-hosted-db-warm-([0-9a-f]{32})-(\d{10})-([0-9a-f]{4})(-ready)?$/;
/** How many complete copies a machine keeps, the newest. Scripts with a bootstrap superuser of their own keep theirs too. */
const WARM_KEEP = 10;
/** A run starts only from a copy younger than this. The rows the migrations write carry the time of the build that
 * wrote them (now()), so a run started from a copy finds them that much older than a full replay would leave them. */
const WARM_MAX_AGE_SECONDS = 6 * 3600;
/** A copy still without its `-ready` volume this long after it was named was left by a run that ended first. A
 * complete copy is removed this long after it is too old to start from, when no run that picked it is still starting. */
const WARM_UNFINISHED_SECONDS = 3600;
/** Changes when what a copy holds or how it is made changes, so older copies are not used. */
const WARM_FORMAT = "1";
/** Where a warm start finds the copy, and where a build that is kept is written, inside the container. */
const WARM_IN = "/qorpera-warm";
const WARM_OUT = "/qorpera-warm-out";
/** A warm start copies the data directory in and starts PostgreSQL on it. A copy that cannot be read leaves an empty
 * data directory, so the image initializes a fresh cluster, and `startBuilt` finds no build there. A container restarted
 * with its data on disk (`restartable`) keeps that data: the copy is taken only into an empty directory. */
export const WARM_START = `if [ -d ${WARM_IN}/data ] && [ ! -s "$PGDATA/PG_VERSION" ]; then cp -a ${WARM_IN}/data/. "$PGDATA"/ || find "$PGDATA" -mindepth 1 -delete; fi; exec docker-entrypoint.sh postgres`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function migrationNames() {
	return sortMigrationNames(readdirSync(MIGRATIONS));
}

/** chain[i] is the link of a build of the first i migrations: chain[0] covers the image, the bootstrap superuser, the test
 * bootstrap and the scripts that build it; chain[i] covers chain[i - 1] and migration i's name and bytes. `read` returns a
 * file's bytes. */
export function warmChain(names, read = readFileSync, admin = "postgres") {
	const builders = [
		join(TESTS, "bootstrap.sql"),
		join(TESTS, PLATFORM_DEFAULTS),
		fileURLToPath(import.meta.url),
		join(repositoryRoot, "scripts", "test-hosted-db.mjs"),
	];
	let link = sha256([WARM_FORMAT, POSTGRES_IMAGE, admin, ...builders.map((file) => sha256(read(file)))].join("\n"));
	const chain = [link.slice(0, 32)];
	for (const name of names) {
		link = sha256(`${link}\n${name}\n${sha256(read(join(MIGRATIONS, name)))}`);
		chain.push(link.slice(0, 32));
	}
	return chain;
}

/** A new copy's volume name for `link`. */
export function warmVolumeName(link, nowSeconds = Math.floor(Date.now() / 1000)) {
	return `qorpera-hosted-db-warm-${link}-${String(nowSeconds).padStart(10, "0")}-${randomBytes(2).toString("hex")}`;
}

/** The complete copy to start from: of those younger than WARM_MAX_AGE_SECONDS, the one of the most migrations of
 * `chain`, the newest of those; null without one. */
export function warmCopy(volumes, chain, nowSeconds) {
	const ready = new Set(volumes.filter((volume) => volume.endsWith("-ready")).map((volume) => volume.slice(0, -"-ready".length)));
	const applied = new Map(chain.map((link, index) => [link, index]));
	let best = null;
	for (const volume of volumes) {
		const match = WARM.exec(volume);
		if (!match || match[4] || !ready.has(volume) || !applied.has(match[1])) continue;
		if (nowSeconds - Number(match[2]) >= WARM_MAX_AGE_SECONDS) continue;
		const candidate = { applied: applied.get(match[1]), volume };
		if (!best || candidate.applied > best.applied || (candidate.applied === best.applied && volume > best.volume)) best = candidate;
	}
	return best;
}

/** The volumes to remove, each `-ready` before its copy: complete copies beyond the newest WARM_KEEP or
 * WARM_UNFINISHED_SECONDS past WARM_MAX_AGE_SECONDS, and copies never completed WARM_UNFINISHED_SECONDS after they
 * were named. Docker refuses to remove one a container uses. */
export function warmVolumesToRemove(volumes, nowSeconds) {
	const named = volumes.map((volume) => [volume, WARM.exec(volume)]).filter(([, match]) => match);
	const ready = new Set(named.filter(([, match]) => match[4]).map(([volume]) => volume.slice(0, -"-ready".length)));
	const copies = named.filter(([, match]) => !match[4]);
	const kept = new Set(
		copies
			.filter(([volume]) => ready.has(volume))
			.sort(([left, a], [right, b]) => Number(b[2]) - Number(a[2]) || (left < right ? 1 : -1))
			.slice(0, WARM_KEEP)
			.map(([volume]) => volume),
	);
	const remove = [];
	for (const [volume, match] of copies) {
		const age = nowSeconds - Number(match[2]);
		if (ready.has(volume) && (!kept.has(volume) || age > WARM_MAX_AGE_SECONDS + WARM_UNFINISHED_SECONDS)) remove.push(`${volume}-ready`, volume);
		else if (!ready.has(volume) && age > WARM_UNFINISHED_SECONDS) remove.push(volume);
	}
	// A `-ready` volume whose copy is gone.
	for (const volume of ready) if (!copies.some(([copy]) => copy === volume)) remove.push(`${volume}-ready`);
	return remove;
}

/** The databases a build leaves: a snapshot before each migration in `snapshotBefore` and before the first, and
 * `qorpera_migrated` after the last. */
export function snapshotPlan(names, snapshotBefore = []) {
	const points = new Set([0, names.length]);
	for (const name of snapshotBefore) {
		const index = names.indexOf(name);
		if (index < 0) throw new Error(`Unknown migration ${name}`);
		points.add(index);
	}
	return [...points].sort((a, b) => a - b).map((applied) => ({
		applied,
		database: applied === names.length ? MIGRATED : `qorpera_snapshot_${String(applied).padStart(4, "0")}`,
	}));
}

/** Which of a warm copy's databases (`present`, those named qorpera_…) a build of `snapshots` drops when it goes on
 * from the copy's `applied` migrations; null when they are not what a build leaves there (the snapshots before that
 * point and the migrated database, plus snapshots this build does not take). */
export function warmDatabasesToDrop(present, snapshots, applied) {
	const wanted = [...snapshots.filter((snapshot) => snapshot.applied < applied).map((snapshot) => snapshot.database), MIGRATED];
	if (wanted.some((database) => !present.includes(database))) return null;
	const extra = present.filter((database) => !wanted.includes(database));
	return extra.every((database) => /^qorpera_snapshot_\d{4}$/.test(database)) ? extra : null;
}

function warmVolumes() {
	return run("docker", ["volume", "ls", "--quiet", "--filter", "name=qorpera-hosted-db-warm-"]).split("\n").filter(Boolean);
}

function checkWarmVolume(volume) {
	const match = WARM.exec(volume);
	if (!match || match[4]) throw new Error(`Invalid warm copy volume ${volume}`);
	return volume;
}

/** The newest runtime bundle activation, which test-runtime-office-delete-disposition holds back. */
export function newestBundleActivation(names) {
	const activations = names.filter((name) => /_runtime_bundle_activation_v\d+\.sql$/.test(name));
	const version = (name) => Number(/_v(\d+)\.sql$/.exec(name)[1]);
	return activations.sort((left, right) => version(left) - version(right)).at(-1);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`${command} ${args.slice(0, 4).join(" ")} failed (exit ${result.status})${detail ? `:\n${detail.slice(-8000)}` : ""}`);
	}
	return result.stdout;
}

function checkDatabase(name) {
	if (!DATABASE.test(name)) throw new Error(`Invalid hosted database name ${name}`);
	return name;
}

/** A psql script that applies `files` (paths inside the container) to `database`, each in a fresh session. */
export function sessionPerFile(database, files, { echo = false } = {}) {
	checkDatabase(database);
	return files
		.map((file) => {
			if (!/^[A-Za-z0-9_./-]+$/.test(file)) throw new Error(`Unsafe SQL file path ${file}`);
			return `${echo ? `\\echo Applying ${file.split("/").at(-1)}\n` : ""}\\connect ${database}\n\\i ${file}\n`;
		})
		.join("");
}

/** The migrations `database` needs: every one before `before` (all when absent), without `skip`. The
 * returned `prefix` is how many leading migrations of the full chain that list shares with it. */
export function plannedMigrations(names, { before, skip = [] } = {}) {
	if (before !== undefined && !names.includes(before)) throw new Error(`Unknown migration ${before}`);
	for (const name of skip) if (!names.includes(name)) throw new Error(`Unknown migration ${name}`);
	const wanted = names.filter((name) => (before === undefined || name < before) && !skip.includes(name));
	let prefix = 0;
	while (prefix < wanted.length && wanted[prefix] === names[prefix]) prefix++;
	return { wanted, prefix };
}

/** The snapshot to copy for a database that shares its first `prefix` migrations with the chain:
 * the one with the most migrations that are all among them. Snapshots are `{ applied, database }`. */
export function bestSnapshot(snapshots, prefix) {
	return snapshots.filter((snapshot) => snapshot.applied <= prefix).sort((a, b) => b.applied - a.applied)[0];
}

export class HostedDbCluster {
	/** @type {string} */ container;
	/** @type {{ applied: number, database: string }[]} */ snapshots = [];
	#owned;
	/** The bootstrap superuser, which creates and drops databases (with its own database, as the image makes it). */
	#admin;

	constructor(container, snapshots, owned, admin = "postgres") {
		if (!CONTAINER.test(container)) throw new Error(`Invalid hosted database container ${container}`);
		this.container = container;
		this.snapshots = snapshots;
		this.#owned = owned;
		this.#admin = checkDatabase(admin);
	}

	/** Starts a disposable PostgreSQL and copies the migrations and the test bootstrap into it. The data lives
	 * on tmpfs unless `restartable`: a container restart empties tmpfs. With another `admin`, that role is the
	 * bootstrap superuser and `postgres` an ordinary superuser, which a test may alter (the managed shape).
	 * `warm`: a warm copy's volume, whose data directory it starts on; `keepIn`: the volume `keep()` writes to. */
	static async start({ restartable = false, admin = "postgres", warm = null, keepIn = null } = {}) {
		run("docker", ["info", "--format", "{{.ServerVersion}}"]);
		const container = buildContainerName(process.pid, randomBytes(4).toString("hex"));
		run("docker", [
			"run",
			"--detach",
			"--rm",
			"--network",
			"none",
			"--name",
			container,
			"--env",
			`POSTGRES_PASSWORD=${PASSWORD}`,
			...POSTGRES_LOCALE,
			...(admin === "postgres" ? [] : ["--env", `POSTGRES_USER=${checkDatabase(admin)}`]),
			...(restartable ? [] : ["--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g"]),
			...(warm ? ["--volume", `${checkWarmVolume(warm)}:${WARM_IN}:ro`] : []),
			...(keepIn ? ["--volume", `${checkWarmVolume(keepIn)}:${WARM_OUT}`] : []),
			...(warm ? ["--entrypoint", "/bin/sh", POSTGRES_IMAGE, "-c", WARM_START] : [POSTGRES_IMAGE]),
		]);
		const cluster = new HostedDbCluster(container, [], true, admin);
		try {
			await cluster.waitForPostgres();
			checkLocale(run("docker", cluster.psqlArgs(admin, ["-qAt"], admin), { input: LOCALE_QUERY }));
			// A warm copy of such a cluster holds this role already.
			if (admin !== "postgres") cluster.admin("do $$ begin if not exists (select from pg_roles where rolname = 'postgres') then create role postgres login superuser; end if; end $$;");
			run("docker", ["exec", container, "mkdir", "-p", IN_CONTAINER]);
			run("docker", ["cp", MIGRATIONS, `${container}:${IN_CONTAINER}/migrations`]);
			run("docker", ["cp", join(TESTS, "bootstrap.sql"), `${container}:${IN_CONTAINER}/bootstrap.sql`]);
			run("docker", ["cp", join(TESTS, PLATFORM_DEFAULTS), `${container}:${IN_CONTAINER}/${PLATFORM_DEFAULTS}`]);
		} catch (error) {
			cluster.stop();
			throw error;
		}
		return cluster;
	}

	/** `start()` then `build()`, going on from the machine's warm copy of the most of these migrations when it keeps
	 * one: only the migrations after the copy are replayed. A copy whose databases are not what a build leaves there
	 * means a full replay in a fresh container. A full replay keeps its build for later runs (`keep`), and the
	 * machine's oldest copies are removed; a run that went on from a copy keeps nothing (replaying the migrations
	 * that land in WARM_MAX_AGE_SECONDS costs less than keeping a copy). A cluster with another bootstrap superuser
	 * (`admin`) has copies of its own; `restartable` keeps the data on disk. Returns the cluster and how many migrations
	 * were copied. */
	static async startBuilt({ snapshotBefore = [], progress = true, keep = true, restartable = false, admin = "postgres" } = {}) {
		const names = migrationNames();
		const chain = warmChain(names, readFileSync, admin);
		const warm = warmCopy(warmVolumes(), chain, Math.floor(Date.now() / 1000));
		if (warm) {
			const cluster = await HostedDbCluster.start({ warm: warm.volume, restartable, admin });
			let drop = null;
			try {
				const present = cluster.psql(admin, "select datname from pg_database where datname like 'qorpera\\_%';", ["-qAt"]);
				drop = warmDatabasesToDrop(present.split("\n").filter(Boolean), snapshotPlan(names, snapshotBefore), warm.applied);
				if (drop) {
					if (drop.length) cluster.admin(drop.map((database) => `drop database ${checkDatabase(database)};`).join("\n"));
					cluster.build({ snapshotBefore, progress, from: warm.applied });
				}
			} catch (error) {
				cluster.stop();
				throw error;
			}
			if (drop) return { cluster, copied: warm.applied };
			cluster.stop();
			process.stdout.write(`The warm copy ${warm.volume} does not hold the databases a build leaves; replaying every migration\n`);
		}
		const out = keep ? warmVolumeName(chain.at(-1)) : null;
		const cluster = await HostedDbCluster.start({ keepIn: out, restartable, admin });
		try {
			cluster.build({ snapshotBefore, progress });
		} catch (error) {
			cluster.stop();
			throw error;
		}
		if (out) cluster.keep(out);
		return { cluster, copied: 0 };
	}

	/** Copies this build's data directory into `volume` (mounted by `start({ keepIn })`), marks it complete and removes
	 * the machine's oldest copies. A copy that fails is reported and left for a later run to remove. */
	keep(volume) {
		const started = Date.now();
		try {
			run("docker", ["exec", this.container, "sh", "-c", `mkdir ${WARM_OUT}/data && chown postgres:postgres ${WARM_OUT}/data`]);
			run("docker", [
				"exec",
				"--user",
				"postgres",
				this.container,
				"pg_basebackup",
				"--host",
				"/var/run/postgresql",
				"--username",
				"postgres",
				"--pgdata",
				`${WARM_OUT}/data`,
				"--checkpoint",
				"fast",
				"--no-manifest",
			]);
			run("docker", ["volume", "create", `${checkWarmVolume(volume)}-ready`]);
			process.stdout.write(`Kept this build for later runs in ${volume} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
		} catch (error) {
			process.stdout.write(`Could not keep this build for later runs: ${error.message}\n`);
		}
		for (const old of warmVolumesToRemove(warmVolumes(), Math.floor(Date.now() / 1000)))
			spawnSync("docker", ["volume", "rm", old], { encoding: "utf8" });
	}

	/** The cluster a suite handed to this process, or null when the script runs on its own. */
	static attach(environment = process.env) {
		const value = environment[CLUSTER_ENV];
		if (!value) return null;
		const parsed = JSON.parse(value);
		const snapshots = parsed.snapshots.map(({ applied, database }) => {
			if (!Number.isSafeInteger(applied) || applied < 0) throw new Error("Invalid hosted database snapshot");
			return { applied, database: checkDatabase(database) };
		});
		return new HostedDbCluster(parsed.container, snapshots, false);
	}

	/** What a script started by the suite needs to attach to this cluster. */
	environment() {
		return { [CLUSTER_ENV]: JSON.stringify({ container: this.container, snapshots: this.snapshots }) };
	}

	async waitForPostgres() {
		// The image's initialization server listens only on the socket and restarts once; waiting for TCP twice
		// in a row means the final server is up.
		let ready = 0;
		for (let attempt = 0; attempt < 120 && ready < 2; attempt++) {
			const probe = spawnSync("docker", ["exec", this.container, "pg_isready", "-h", "127.0.0.1", "-U", this.#admin], {
				encoding: "utf8",
				timeout: 5000,
			});
			ready = probe.status === 0 ? ready + 1 : 0;
			if (ready < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		}
		if (ready < 2) throw new Error("Disposable PostgreSQL did not become ready within 30 seconds");
	}

	/** `docker exec` arguments for psql on `database` as `user`; `options` go before the database (e.g. `-qAt`). */
	psqlArgs(database, options = [], user = "postgres") {
		return [
			"exec",
			"-i",
			this.container,
			"psql",
			"-X",
			...options,
			"-U",
			checkDatabase(user),
			"-d",
			checkDatabase(database),
			"-v",
			"ON_ERROR_STOP=1",
		];
	}

	/** Runs `sql` on `database` in one psql session and returns its standard output. */
	psql(database, sql, options = []) {
		return run("docker", this.psqlArgs(database, options), { input: sql });
	}

	/** Runs `sql` as the bootstrap superuser on its own database (creating and dropping databases). */
	admin(sql) {
		return run("docker", this.psqlArgs(this.#admin, [], this.#admin), { input: sql });
	}

	/** Runs a psql script (meta-commands included) with the query output discarded. With `progress` its
	 * `\\echo` lines go to the log as they come; notices are kept back and shown only with a failure, whose
	 * psql message names the file and line. */
	script(database, text, { progress = false } = {}) {
		const result = spawnSync("docker", this.psqlArgs(database, ["-q"]), {
			cwd: repositoryRoot,
			input: `\\o /dev/null\n${text}`,
			stdio: ["pipe", progress ? "inherit" : "pipe", "pipe"],
			maxBuffer: 256 * 1024 * 1024,
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(`psql on ${database} failed (exit ${result.status}):\n${result.stderr.toString().slice(-8000)}`);
	}

	/** `script` without blocking this process: the promise settles when psql ends, and child processes this
	 * process started meanwhile are seen as they exit. */
	scriptInBackground(database, text, { progress = false } = {}) {
		const child = spawn("docker", this.psqlArgs(database, ["-q"]), {
			cwd: repositoryRoot,
			stdio: ["pipe", progress ? "inherit" : "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-8000);
		});
		// psql stopping on an error before it read everything is reported by its exit below.
		child.stdin.on("error", () => {});
		child.stdin.end(`\\o /dev/null\n${text}`);
		return new Promise((resolveScript, rejectScript) => {
			child.on("error", rejectScript);
			child.on("close", (code, signal) => {
				if (code === 0) resolveScript();
				else rejectScript(new Error(`psql on ${database} failed (exit ${code ?? signal}):\n${stderr}`));
			});
		});
	}

	/** Applies these migrations to an existing database, each in a fresh session, in one psql process. */
	migrate(database, names) {
		if (names.length === 0) return;
		this.script(database, sessionPerFile(database, names.map((name) => `${IN_CONTAINER}/migrations/${name}`)));
	}

	/** Builds `qorpera_migrated`: the test bootstrap, then every migration. Before each migration named in
	 * `snapshotBefore` (and before the first, and after the last) it leaves a copy for later databases. `from`: a warm
	 * copy's migrations, which this cluster already holds with the copies before them; the build goes on after them. */
	build({ snapshotBefore = [], progress = true, from = 0 } = {}) {
		const names = migrationNames();
		// The bootstrap superuser's own database, as the image makes it: `postgres` or `admin`'s.
		const home = this.#admin;
		if (names.length === 0) throw new Error("No hosted database migrations were found");
		const snapshots = snapshotPlan(names, snapshotBefore);
		const snapshotAt = (applied) => {
			const snapshot = snapshots.find((candidate) => candidate.applied === applied);
			// CREATE DATABASE … TEMPLATE needs the template without sessions: this one moves to the bootstrap superuser's database first.
			return snapshot && snapshot.database !== MIGRATED
				? `\\connect ${home}\ncreate database ${snapshot.database} template ${MIGRATED};\n`
				: "";
		};
		let text = from === 0 ? `\\connect ${home}\ncreate database ${MIGRATED};\n${sessionPerFile(MIGRATED, BOOTSTRAP)}` : "";
		names.forEach((name, index) => {
			if (index < from) return;
			text += snapshotAt(index);
			text += sessionPerFile(MIGRATED, [`${IN_CONTAINER}/migrations/${name}`], { echo: progress });
		});
		text += `\\connect ${home}\n`;
		this.script(home, text, { progress });
		this.snapshots = snapshots;
		return names.length;
	}

	/** A new database `name` with the migrations `plannedMigrations` chooses: a copy of the nearest snapshot,
	 * then the rest replayed one session per file. Without snapshots it starts from the bootstrap alone.
	 * `empty` gives a database without the bootstrap or any migration. */
	create(name, { before, skip, empty = false } = {}) {
		checkDatabase(name);
		this.admin(`drop database if exists ${name} with (force);`);
		if (empty) {
			// A database like a fresh cluster's own: no bootstrap, no migrations.
			this.admin(`create database ${name} template template1;`);
			return { copied: 0, replayed: 0 };
		}
		const names = migrationNames();
		const { wanted, prefix } = plannedMigrations(names, { before, skip });
		const snapshot = bestSnapshot(this.snapshots, prefix);
		if (snapshot) {
			this.admin(`create database ${name} template ${snapshot.database};${this.#admin === "postgres" ? "" : ` grant all on database ${name} to postgres;`}`);
			this.migrate(name, wanted.slice(snapshot.applied));
			return { copied: snapshot.applied, replayed: wanted.length - snapshot.applied };
		}
		// Owned by the bootstrap superuser, as the image's own database is; postgres gets every right on it.
		this.admin(`create database ${name};${this.#admin === "postgres" ? "" : ` grant all on database ${name} to postgres;`}`);
		this.script(name, sessionPerFile(name, BOOTSTRAP));
		this.migrate(name, wanted);
		return { copied: 0, replayed: wanted.length };
	}

	drop(name) {
		this.admin(`drop database if exists ${checkDatabase(name)} with (force);`);
	}

	/** Copies files (name to content) into a new directory in the container and returns their paths there. */
	copyIn(files) {
		const local = mkdtempSync(join(tmpdir(), "qorpera-hosted-db-"));
		const directory = `${IN_CONTAINER}/files-${randomBytes(4).toString("hex")}`;
		try {
			for (const [name, content] of Object.entries(files)) {
				if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Unsafe file name ${name}`);
				writeFileSync(join(local, name), content);
			}
			run("docker", ["cp", local, `${this.container}:${directory}`]);
		} finally {
			rmSync(local, { recursive: true, force: true });
		}
		return Object.fromEntries(Object.keys(files).map((name) => [name, `${directory}/${name}`]));
	}

	/** Removes the container if this process started it; a suite's container is left to the suite. */
	stop() {
		if (this.#owned) spawnSync("docker", ["rm", "--force", "--volumes", this.container], { encoding: "utf8" });
	}

	/** Starts `psql` on `database` as a child process (for scripts that race sessions). */
	spawnPsql(database, options = ["-qAt"]) {
		return spawn("docker", this.psqlArgs(database, options), { stdio: ["pipe", "pipe", "pipe"] });
	}
}

/** For a PostgreSQL script: its own database `name` with the migrations it asks for, in the suite's cluster
 * when it runs under the suite, otherwise in a container of its own, built by `startBuilt`, so from the machine's warm
 * copy when it keeps one. Two kinds of script always get their own container: one that restarts the server
 * (`restartable`: data on disk), and one that alters the cluster-wide `postgres` role (`alterablePostgres`: another
 * bootstrap superuser). `close()` drops the database or removes the container. */
export async function hostedDatabase(name, { restartable = false, alterablePostgres = false, ...options } = {}) {
	const shared = restartable || alterablePostgres ? null : HostedDbCluster.attach();
	const admin = alterablePostgres ? "fixture_admin" : "postgres";
	// Snapshots where the database starts from a point of the chain or leaves a migration out; an empty one needs no build.
	const snapshotBefore = [...(options.before ? [options.before] : []), ...(options.skip ?? [])];
	const cluster =
		shared ??
		(options.empty
			? await HostedDbCluster.start({ restartable, admin })
			: // Only a cluster of its own kind keeps its build: the suite's are the copies with every snapshot it needs.
				(await HostedDbCluster.startBuilt({ snapshotBefore, progress: false, keep: alterablePostgres, restartable, admin })).cluster);
	try {
		const made = cluster.create(name, options);
		process.stdout.write(
			`Hosted database ${name}: ${made.copied} migrations copied${shared ? " from the suite's replay" : ""}, ${made.replayed} applied\n`,
		);
	} catch (error) {
		cluster.stop();
		throw error;
	}
	return {
		cluster,
		container: cluster.container,
		database: name,
		close: () => (shared ? cluster.drop(name) : cluster.stop()),
	};
}
