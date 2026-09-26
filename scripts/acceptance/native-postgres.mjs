import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expandTestFixture, sortMigrationNames } from "../test-hosted-db.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const maximumBytes = 8 * 1024 * 1024;
const database = "qorpera_test";
const username = "postgres";
const port = 5432; // The private socket directory isolates this from every other cluster.

class NativePostgresCleanupError extends AggregateError {}

export function nativePostgresOptions(value) {
	assert(value && typeof value === "object" && !Array.isArray(value), "PostgreSQL options required");
	assert(Object.keys(value).every((key) => ["binDirectory", "tempParent", "onProgress", "bootstrap"].includes(key)), "Unknown PostgreSQL option");
	const { binDirectory, tempParent = "/tmp", onProgress, bootstrap } = value;
	for (const path of [binDirectory, tempParent]) {
		assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path && path !== "/" && !/[\x00-\x20\x7f'\\]/.test(path), "Canonical absolute PostgreSQL paths required");
	}
	assert(Buffer.byteLength(join(tempParent, "qorpera-native-pg-XXXXXX", "socket", `.s.PGSQL.${port}`)) < 100, "PostgreSQL socket path too long");
	assert(onProgress === undefined || typeof onProgress === "function", "Invalid PostgreSQL progress callback");
	assert(bootstrap === undefined || typeof bootstrap === "function", "Invalid PostgreSQL bootstrap callback");
	return { binDirectory, tempParent, onProgress, bootstrap };
}

export function assertNativePostgresVersion(output) {
	assert(typeof output === "string" && /^(?:postgres|initdb|psql) \(PostgreSQL\) 17\.\d+(?:[ .(+-].*)?\s*$/.test(output), "Native PostgreSQL 17 tools required");
}

export function nativePostgresEnvironment(root, binDirectory) {
	// Deliberately exclude PG*, LD_*, inherited service files and shell startup configuration.
	return { PATH: `${binDirectory}:/usr/bin:/bin`, HOME: root, LANG: "C", LC_ALL: "C", TZ: "UTC" };
}

export function nativePostgresArguments(dataDirectory, socketDirectory) {
	return ["-D", dataDirectory, "-k", socketDirectory, "-p", String(port),
		"-c", "listen_addresses=", "-c", "unix_socket_permissions=0700",
		"-c", "max_connections=30", "-c", "shared_buffers=32MB", "-c", "wal_level=logical",
		"-c", "log_statement=none", "-c", "log_min_error_statement=panic"];
}

async function command(executable, args, environment, input, timeoutMs = 30000, signal, maxOutputBytes = maximumBytes) {
	assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000, "Command timeout outside acceptance bounds");
	assert(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 1 && maxOutputBytes <= maximumBytes, "Command output limit outside acceptance bounds");
	assert(signal === undefined || signal instanceof AbortSignal, "Invalid command signal");
	signal?.throwIfAborted();
	return new Promise((resolveCommand, reject) => {
		const child = spawn(executable, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
		const stdout = [];
		let bytes = 0;
		let failure;
		const abort = () => { failure = new Error("Native PostgreSQL command aborted"); child.kill("SIGKILL"); };
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			failure = new Error("Native PostgreSQL command timed out");
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("error", (error) => { failure = error; });
		for (const [stream, retain] of [[child.stdout, true], [child.stderr, false]]) {
			stream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > maxOutputBytes) {
					failure = new Error("Native PostgreSQL command output exceeded limit");
					child.kill("SIGKILL");
				} else if (retain) stdout.push(chunk);
			});
		}
		child.stdin.on("error", () => {}); // Early initdb/psql refusal can close stdin.
		child.once("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (failure || code !== 0) reject(failure ?? new Error(`Native PostgreSQL ${executable.split("/").at(-1)} failed (${code}); SQL output withheld`));
			else resolveCommand(Buffer.concat(stdout).toString("utf8").trim());
		});
		child.stdin.end(input);
	});
}

async function sqlFile(path) {
	const file = await lstat(path);
	assert(file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= maximumBytes, "Invalid acceptance SQL file");
	const bytes = await readFile(path);
	assert(bytes.length === file.size, "Acceptance SQL bytes differ from file metadata");
	return bytes.toString("utf8");
}

/** Creates, starts and migrates a new private cluster. No existing cluster can
 * be attached. Keep the returned handle alive during LXD acceptance and close
 * it in finally. The CLI --serve form retains it until SIGTERM/SIGINT.
 * Run as an unprivileged Linux user; a root orchestrator can use runuser.
 * No credentials or unbounded SQL diagnostics are written to stdout.
 */
export async function startNativePostgres(options) {
	const { binDirectory, tempParent, onProgress, bootstrap } = nativePostgresOptions(options);
	assert(process.platform === "linux" && process.getuid?.() > 0 && process.geteuid?.() === process.getuid(), "Unprivileged Linux user required");
	assert(await realpath(binDirectory) === binDirectory && await realpath(tempParent) === tempParent, "Symlink PostgreSQL roots refused");
	const parent = await lstat(tempParent);
	assert(parent.isDirectory() && ((parent.uid === process.getuid() && (parent.mode & 0o022) === 0) || (parent.uid === 0 && (parent.mode & 0o1000) !== 0)), "Unsafe PostgreSQL temporary parent");
	for (const name of ["postgres", "initdb", "psql"]) {
		const executable = await lstat(join(binDirectory, name));
		assert(executable.isFile() && !executable.isSymbolicLink() && (executable.mode & 0o022) === 0 && (executable.uid === 0 || executable.uid === process.getuid()), "Unsafe PostgreSQL executable");
	}
	const root = await mkdtemp(join(tempParent, "qorpera-native-pg-"));
	const identity = await lstat(root);
	assert((identity.mode & 0o777) === 0o700, "Private PostgreSQL directory required");
	const environment = nativePostgresEnvironment(root, binDirectory);
	const dataDirectory = join(root, "data");
	const socketDirectory = join(root, "socket");
	let server;
	let serverClosed;
	let exited = false;
	let closed = false;
	let migrationCount = 0;
	let postgresVersion;
	let closePromise;
	const query = async (sql, { timeoutMs = 30000, databaseName = database, signal, maxOutputBytes = maximumBytes } = {}) => {
		assert(!closed && server && !exited, "Native PostgreSQL cluster is not running");
		assert(typeof sql === "string" && Buffer.byteLength(sql) > 0 && Buffer.byteLength(sql) <= maximumBytes, "SQL input outside acceptance bounds");
		assert(databaseName === database || databaseName === "postgres", "Unknown acceptance database");
		assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000, "Command timeout outside acceptance bounds");
		return command(join(binDirectory, "psql"), ["--no-psqlrc", "--no-password", "--host", socketDirectory,
			"--port", String(port), "--username", username, "--dbname", databaseName,
			"--set", "ON_ERROR_STOP=1", "--quiet", "--tuples-only", "--no-align"],
			{ ...environment, PGOPTIONS: `-c statement_timeout=${timeoutMs} -c lock_timeout=${timeoutMs}` }, sql, timeoutMs, signal, maxOutputBytes);
	};
	const close = ({ keepFiles = false } = {}) => {
		if (closePromise) return closePromise;
		closed = true;
		closePromise = (async () => {
			if (server && !exited) {
				server.kill("SIGINT"); // Fast shutdown of this owned child only; never a pidfile/pg_ctl target.
				let timer;
				await Promise.race([serverClosed, new Promise((done) => { timer = setTimeout(done, 10000); })]);
				clearTimeout(timer);
				// Do not SIGKILL the postmaster then delete a directory its backends
				// may still hold. A failed bounded fast shutdown preserves the cluster.
				assert(exited, "Owned PostgreSQL process did not exit; cluster retained");
			}
			if (!keepFiles) {
				const current = await lstat(root);
				assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino && current.uid === identity.uid, "PostgreSQL root changed; cleanup refused");
				await rm(root, { recursive: true });
			}
		})();
		return closePromise;
	};
	try {
		for (const name of ["postgres", "initdb", "psql"]) {
			const version = await command(join(binDirectory, name), ["--version"], environment);
			assertNativePostgresVersion(version);
			if (name === "postgres") postgresVersion = version;
		}
		await command(join(binDirectory, "initdb"), ["--pgdata", dataDirectory, "--username", username, "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject", "--no-instructions"], environment, undefined, 60000);
		await mkdir(socketDirectory, { mode: 0o700 });
		const log = await open(join(root, "postgres.log"), "wx", 0o600);
		try {
			// SQL concurrency fixtures use dblink with a database-only DSN. Give
			// server-side libpq this cluster's private socket, never the host default.
			server = spawn(join(binDirectory, "postgres"), nativePostgresArguments(dataDirectory, socketDirectory), {
				env: { ...environment, PGHOST: socketDirectory, PGPORT: String(port), PGUSER: username },
				stdio: ["ignore", log.fd, log.fd],
			});
			serverClosed = new Promise((done) => {
				server.once("error", () => {});
				server.once("close", () => { exited = true; done(); });
			});
		} finally { await log.close(); }
		const readyBy = Date.now() + 30000;
		let ready = false;
		while (!exited && Date.now() < readyBy) {
			try {
				const settings = await query("select current_setting('data_directory') || '|' || current_setting('listen_addresses') || '|' || current_database();", { databaseName: "postgres", timeoutMs: 2000 });
				assert.equal(settings, `${dataDirectory}||postgres`, "Unexpected PostgreSQL cluster or TCP listener");
				ready = true;
				break;
			} catch { await delay(100); }
		}
		assert(ready, "Native PostgreSQL did not become ready; inspect private postgres.log before cleanup");
		await query(`create database ${database};`, { databaseName: "postgres" });
		onProgress?.("bootstrap.sql");
		const platformSql = await sqlFile(join(repository, "supabase/tests/bootstrap.sql"));
		if (bootstrap) await bootstrap({ query, root, socketDirectory, database, username, port, platformSql });
		else await query(platformSql);
		const migrationsDirectory = join(repository, "supabase/migrations");
		const migrations = sortMigrationNames(await readdir(migrationsDirectory));
		assert(migrations.length > 0, "No acceptance migrations found");
		for (const migration of migrations) {
			onProgress?.(migration);
			await query(await sqlFile(join(migrationsDirectory, migration)), { timeoutMs: 60000 });
			migrationCount++;
		}
		return {
			root, socketDirectory, dataDirectory, database, username, port, postgresVersion, migrationCount, query, close,
			async runTest(name) {
				assert(typeof name === "string" && /^\d+_[a-z0-9_]+\.test\.sql$/.test(name), "Invalid acceptance test name");
				const files = new Map();
				for (const entry of await readdir(join(repository, "supabase/tests"))) {
					if (/^[0-9a-z_.-]+\.test\.sql$/.test(entry)) files.set(entry, await sqlFile(join(repository, "supabase/tests", entry)));
				}
				const sql = expandTestFixture(name, (entry) => { assert(files.has(entry), "Acceptance fixture missing"); return files.get(entry); });
				return query(sql, { timeoutMs: 120000 });
			},
		};
	} catch (error) {
		try { await close(); } catch (cleanupError) { throw new NativePostgresCleanupError([error, cleanupError], "Native PostgreSQL startup and cleanup failed; private cluster retained"); }
		throw error;
	}
}

export function parseNativePostgresCli(args) {
	const parsed = { tests: [], serve: false, allTests: false };
	for (let i = 0; i < args.length; i++) {
		const key = args[i];
		if (key === "--serve") { assert(!parsed.serve, "Duplicate --serve"); parsed.serve = true; }
		else if (key === "--keep-files") { assert(parsed.keepFiles === undefined, "Duplicate --keep-files"); parsed.keepFiles = true; }
		else if (key === "--all-tests") { assert(!parsed.allTests, "Duplicate --all-tests"); parsed.allTests = true; }
		else if (["--bin", "--out", "--test"].includes(key)) {
			const value = args[++i];
			assert(typeof value === "string" && !value.startsWith("--"), "Missing acceptance CLI value");
			if (key === "--test") {
				assert(/^\d+_[a-z0-9_]+\.test\.sql$/.test(value) && !parsed.tests.includes(value), "Invalid or duplicate acceptance test");
				parsed.tests.push(value);
			} else {
				const field = key === "--bin" ? "binDirectory" : "out";
				assert(parsed[field] === undefined, "Duplicate acceptance CLI argument");
				parsed[field] = value;
			}
		} else throw new Error("Unknown native PostgreSQL CLI argument");
	}
	assert(!parsed.keepFiles || parsed.serve, "--keep-files requires --serve");
	nativePostgresOptions({ binDirectory: parsed.binDirectory });
	assert(parsed.serve ? parsed.tests.length === 0 && !parsed.allTests && parsed.out === undefined
		: (parsed.allTests ? parsed.tests.length === 0 : parsed.tests.length > 0) && typeof parsed.out === "string",
		"Choose --serve, or --all-tests/--test <file> with --out <directory>");
	if (parsed.out !== undefined) assert(isAbsolute(parsed.out) && resolve(parsed.out) === parsed.out && parsed.out !== "/" && !/[\x00-\x20\x7f'\\]/.test(parsed.out), "Canonical acceptance output directory required");
	return parsed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const options = parseNativePostgresCli(process.argv.slice(2));
	if (options.out) {
		await mkdir(options.out, { recursive: true, mode: 0o700 });
		const output = await lstat(options.out);
		assert(output.isDirectory() && output.uid === process.getuid() && (output.mode & 0o022) === 0 && await realpath(options.out) === options.out, "Unsafe acceptance output directory");
		assert(!(await readdir(options.out)).includes("evidence.json"), "Existing acceptance evidence refused");
	}
	let release;
	let interrupted = false;
	const stopping = new Promise((done) => { release = done; });
	const shutdown = () => { interrupted = true; release(); };
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	let cluster;
	let startupCleanupFailed = false;
	const evidence = { schema: "qorpera.native-postgres-acceptance/v1", commit: process.env.GITHUB_SHA ?? null, passed: false, tcp: false, tests: [], cleanup: false };
	try {
		cluster = await startNativePostgres({ binDirectory: options.binDirectory, onProgress: (name) => {
			assert(!interrupted, "Native PostgreSQL startup interrupted");
			process.stderr.write(`Applying ${name}\n`);
		} });
		evidence.postgresVersion = cluster.postgresVersion;
		evidence.migrationCount = cluster.migrationCount;
		if (options.serve) {
			console.log(JSON.stringify({ ...evidence, root: cluster.root, socketDirectory: cluster.socketDirectory, port: cluster.port, database: cluster.database, username: cluster.username, ready: true }));
			await stopping;
		} else {
			const tests = options.allTests ? (await readdir(join(repository, "supabase/tests")))
				.filter((name) => /^\d+_[a-z0-9_]+\.test\.sql$/.test(name)).sort() : options.tests;
			assert(tests.length > 0, "No acceptance tests found");
			for (const name of tests) {
				assert(!interrupted, "Native PostgreSQL acceptance interrupted");
				process.stderr.write(`Running ${name}\n`);
				await cluster.runTest(name);
				evidence.tests.push(name);
			}
			evidence.passed = true;
		}
	} catch (error) {
		startupCleanupFailed = error instanceof NativePostgresCleanupError;
		evidence.error = String(error);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGTERM", shutdown);
		process.removeListener("SIGINT", shutdown);
		try { await cluster?.close({ keepFiles: options.keepFiles === true }); evidence.cleanup = !startupCleanupFailed && !options.keepFiles; evidence.retained = options.keepFiles === true; evidence.closed = cluster !== undefined; }
		catch { evidence.cleanup = false; evidence.passed = false; evidence.error = "Owned PostgreSQL shutdown unconfirmed; private cluster retained"; process.exitCode = 1; }
		if (options.out) {
			await writeFile(join(options.out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			console.log(JSON.stringify(evidence));
		} else if (evidence.error) process.stderr.write(`${evidence.error}\n`);
		else if (options.serve && evidence.closed) console.log(JSON.stringify({ closed: true, retained: evidence.retained }));
	}
}
