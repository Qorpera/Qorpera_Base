import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContainerName, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

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

export function migrationNames() {
	return sortMigrationNames(readdirSync(MIGRATIONS));
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
	 * bootstrap superuser and `postgres` an ordinary superuser, which a test may alter (the managed shape). */
	static async start({ restartable = false, admin = "postgres" } = {}) {
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
			...(admin === "postgres" ? [] : ["--env", `POSTGRES_USER=${checkDatabase(admin)}`]),
			...(restartable ? [] : ["--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g"]),
			POSTGRES_IMAGE,
		]);
		const cluster = new HostedDbCluster(container, [], true, admin);
		try {
			await cluster.waitForPostgres();
			if (admin !== "postgres") cluster.admin("create role postgres login superuser;");
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

	/** Applies these migrations to an existing database, each in a fresh session, in one psql process. */
	migrate(database, names) {
		if (names.length === 0) return;
		this.script(database, sessionPerFile(database, names.map((name) => `${IN_CONTAINER}/migrations/${name}`)));
	}

	/** Builds `qorpera_migrated`: the test bootstrap, then every migration. Before each migration named in
	 * `snapshotBefore` (and before the first, and after the last) it leaves a copy for later databases. */
	build({ snapshotBefore = [], progress = true } = {}) {
		if (this.#admin !== "postgres") throw new Error("The shared replay runs where postgres is the bootstrap superuser");
		const names = migrationNames();
		if (names.length === 0) throw new Error("No hosted database migrations were found");
		const points = new Set([0, names.length]);
		for (const name of snapshotBefore) {
			const index = names.indexOf(name);
			if (index < 0) throw new Error(`Unknown migration ${name}`);
			points.add(index);
		}
		const snapshots = [...points].sort((a, b) => a - b).map((applied) => ({
			applied,
			database: applied === names.length ? MIGRATED : `qorpera_snapshot_${String(applied).padStart(4, "0")}`,
		}));
		const snapshotAt = (applied) => {
			const snapshot = snapshots.find((candidate) => candidate.applied === applied);
			// CREATE DATABASE … TEMPLATE needs the template without sessions: this one moves to postgres first.
			return snapshot && snapshot.database !== MIGRATED
				? `\\connect postgres\ncreate database ${snapshot.database} template ${MIGRATED};\n`
				: "";
		};
		let text = `\\connect postgres\ncreate database ${MIGRATED};\n`;
		text += sessionPerFile(MIGRATED, BOOTSTRAP);
		names.forEach((name, index) => {
			text += snapshotAt(index);
			text += sessionPerFile(MIGRATED, [`${IN_CONTAINER}/migrations/${name}`], { echo: progress });
		});
		text += "\\connect postgres\n";
		this.script("postgres", text, { progress });
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
			this.admin(`create database ${name} template ${snapshot.database};`);
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
 * when it runs under the suite, otherwise in a container of its own. Two kinds of script always get their
 * own container, filled by the same one-process replay: one that restarts the server (`restartable`: data
 * on disk), and one that alters the cluster-wide `postgres` role (`alterablePostgres`: another bootstrap
 * superuser). `close()` drops the database or removes the container. */
export async function hostedDatabase(name, { restartable = false, alterablePostgres = false, ...options } = {}) {
	const shared = restartable || alterablePostgres ? null : HostedDbCluster.attach();
	const cluster =
		shared ?? (await HostedDbCluster.start({ restartable, admin: alterablePostgres ? "fixture_admin" : "postgres" }));
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
