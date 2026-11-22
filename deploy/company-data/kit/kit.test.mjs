// The kit as a machine gets it: `git archive` of deploy/company-data/kit leaves out the drill and its platform
// stand-in (.gitattributes export-ignore) and keeps everything a machine runs. The test machine's copy of the
// repository is no git repository, so the kit is committed into a throwaway one here.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { claimFile } from "./drill/own-file.mjs";

const kit = dirname(fileURLToPath(import.meta.url));
const KIT = "deploy/company-data/kit";

test("an archive of the kit holds what a machine runs and never the drill", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-company-data-kit-test-"));
	try {
		await cp(kit, join(temporary, KIT), { recursive: true, filter: (source) => !source.endsWith("/.env") });
		const git = (...args) =>
			execFileSync("git", ["-c", "user.name=kit-test", "-c", "user.email=kit-test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
				cwd: temporary,
				encoding: "utf8",
			});
		git("init", "-q");
		git("add", KIT);
		git("commit", "-q", "-m", "kit");
		const tracked = git("ls-files", KIT).trim().split("\n");
		assert.ok(tracked.includes(`${KIT}/drill.mjs`) && tracked.includes(`${KIT}/drill/platform-standin.mjs`), "the drill is in the repository");
		const archived = execFileSync("tar", ["-t"], { input: execFileSync("git", ["archive", "HEAD", KIT], { cwd: temporary }), encoding: "utf8" })
			.trim()
			.split("\n")
			.filter((path) => !path.endsWith("/"));
		for (const path of archived) assert.doesNotMatch(path, /\/drill(\.mjs|\/)|kit\.test\.mjs$/, path);
		for (const file of ["env.sh", "docker-compose.yml", "replication.yml", "run-door.yml", "gateway-main.mjs", "lib.sh", "tls.sh", "compose.sh", "run-door.sh", "init.sh", "update-store.sh", "base-backup.sh", "restore.sh", "standby.sh", "README.md",
			"postgres/postgresql.conf", "postgres/pg_hba.conf", "postgres/pg_ident.conf", "postgres/archive-wal.sh", "postgres/restore-wal.sh"])
			assert.ok(archived.includes(`${KIT}/${file}`), `${file} is in the archive`);
		const machine = tracked.filter((path) => !/\/drill(\.mjs|\/)|kit\.test\.mjs$/.test(path));
		assert.deepEqual(archived.sort(), machine.sort());
		assert.equal(tracked.length - machine.length, 5, "drill.mjs, the three files of drill/ and this test stay out");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

// ---- the kit's .env, read as docker compose reads it (env.sh)

/** The README's .env examples: every `cat > .env <<'EOF'` block, as written there. */
const readmeSamples = (text) => [...text.matchAll(/cat > \.env <<'EOF'\n([\s\S]*?)\nEOF\n/g)].map((match) => `${match[1]}\n`);
/** What env.sh's load_env exports from `file`, with nothing in the environment. */
const loaded = (file) => {
	const done = spawnSync("bash", ["-c", '. "$1"; load_env "$2" || exit 3; env -0', "bash", join(kit, "env.sh"), file], {
		env: { PATH: process.env.PATH },
		encoding: "utf8",
	});
	assert.equal(done.status, 0, done.stderr);
	return Object.fromEntries(
		done.stdout
			.split("\0")
			.filter(Boolean)
			.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	);
};
const EXTRA = [
	"PLAIN=value",
	"COMMENTED=/srv/a-folder    # a comment after a space",
	"HASH=with#hash",
	'DOUBLE="/srv/a folder # inside quotes"   # a comment after them',
	"SINGLE='a \\n stays # as written'",
	'ESCAPED="say \\"hi\\" and a \\\\ back"',
	"SPACED=   trimmed both ends   ",
	"export EXPORTED=yes",
	"EMPTY=",
	"# a whole-line comment",
	"",
].join("\n");

test("the kit's .env is read as docker compose reads it: the README's examples and the documented forms", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-company-data-env-test-"));
	try {
		const samples = readmeSamples(await readFile(join(kit, "README.md"), "utf8"));
		assert.ok(samples.length >= 1, "the README shows a .env");
		writeFileSync(join(temporary, "readme.env"), samples[0]);
		const readme = loaded(join(temporary, "readme.env"));
		assert.equal(readme.DATA_BACKUP, "/mnt/nas/company-data");
		assert.equal(readme.DATA_GATEWAY_PACKAGE, "/opt/company-data/gateway-package");
		assert.equal(readme.COMPOSE_FILE, "docker-compose.yml:replication.yml");
		assert.equal(readme.DATA_GATEWAY_LISTEN, "127.0.0.1:8480");
		assert.equal(readme.DATA_RUN_LISTEN, "<this machine's private address>:8481");
		// Every compose command the README gives goes through compose.sh, which adds run-door.yml (lib.sh).
		const text = await readFile(join(kit, "README.md"), "utf8");
		assert.doesNotMatch(text, /`docker compose (up|stop|restart|start|down)/);
		assert.match(text, /`\.\/compose\.sh up -d data-gateway`/);
		writeFileSync(join(temporary, "extra.env"), EXTRA);
		const extra = loaded(join(temporary, "extra.env"));
		assert.deepEqual(
			Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "PWD" && key !== "SHLVL" && key !== "_" && key !== "PATH")),
			{
				PLAIN: "value",
				COMMENTED: "/srv/a-folder",
				HASH: "with#hash",
				DOUBLE: "/srv/a folder # inside quotes",
				SINGLE: "a \\n stays # as written",
				ESCAPED: 'say "hi" and a \\ back',
				SPACED: "trimmed both ends",
				EXPORTED: "yes",
				EMPTY: "",
			},
		);
		// A quote never closed is refused, not read as a value.
		writeFileSync(join(temporary, "open.env"), 'OPEN="no end\n');
		assert.equal(spawnSync("bash", ["-c", '. "$1"; load_env "$2"', "bash", join(kit, "env.sh"), join(temporary, "open.env")]).status, 1);
		// The environment wins over the file.
		const kept = spawnSync("bash", ["-c", '. "$1"; load_env "$2"; printf %s "$DATA_BACKUP"', "bash", join(kit, "env.sh"), join(temporary, "readme.env")], {
			env: { PATH: process.env.PATH, DATA_BACKUP: "/from/the/environment" },
			encoding: "utf8",
		});
		assert.equal(kept.stdout, "/from/the/environment");

		// docker compose reads the same files to the same values, where the machine has it.
		if (spawnSync("docker", ["compose", "version"]).status === 0) {
			for (const [name, values] of [["readme.env", readme], ["extra.env", extra]]) {
				const keys = Object.keys(values).filter((key) => /^[A-Z][A-Z_]*$/.test(key) && !["PWD", "SHLVL", "PATH"].includes(key) && !key.startsWith("COMPOSE_"));
				const file = join(temporary, `${name}.yml`);
				writeFileSync(file, `services:\n  s:\n    image: scratch\n    environment:\n${keys.map((key) => `      ${key}: "\${${key}}"`).join("\n")}\n`);
				const config = spawnSync("docker", ["compose", "-p", "envtest", "-f", file, "--env-file", join(temporary, name), "config", "--format", "json"], {
					env: { PATH: process.env.PATH, HOME: process.env.HOME ?? temporary },
					encoding: "utf8",
				});
				assert.equal(config.status, 0, config.stderr);
				const composed = JSON.parse(config.stdout).services.s.environment;
				for (const key of keys) assert.equal(composed[key] ?? "", values[key], `${name} ${key}`);
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

// ---- the drill's own .env: made only where none is, removed only while it is the drill's

test("the drill claims a file only where none is, and removes only its own", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-company-data-own-file-test-"));
	try {
		const path = join(temporary, ".env");
		// Refused: someone's file is there. It stays as it was, and nothing is given to remove it.
		writeFileSync(path, "SOMEONE=else\n");
		assert.throws(() => claimFile(path, "DRILL=1\n"), { code: "EEXIST" });
		assert.equal(readFileSync(path, "utf8"), "SOMEONE=else\n");
		await rm(path);
		// An early failure: the run's own file goes, once.
		let release = null;
		try {
			release = claimFile(path, "DRILL=1\n");
			throw new Error("an image is missing");
		} catch {
			assert.equal(release?.(), true);
		}
		assert.equal(existsSync(path), false);
		assert.equal(release(), false);
		// Another run's file, written after this run's was removed and in its place, is not this run's to remove.
		const mine = claimFile(path, "DRILL=1\n");
		await rm(path);
		writeFileSync(path, "DRILL=2\n");
		assert.equal(mine(), false);
		assert.equal(readFileSync(path, "utf8"), "DRILL=2\n");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("systemd backup service points to base-backup.sh and nginx gives /apply a 120s read timeout", () => {
	const backupUnit = readFileSync(join(kit, "systemd/qorpera-company-data-backup.service"), "utf8");
	const execMatch = /^ExecStart=\/bin\/bash \/opt\/qorpera-company-data\/kit\/(.+)$/m.exec(backupUnit);
	assert.ok(execMatch, "backup service defines ExecStart in kit/");
	assert.equal(execMatch[1], "base-backup.sh");
	assert.equal(existsSync(join(kit, execMatch[1])), true, `${execMatch[1]} exists in kit/`);

	const nginx = readFileSync(join(kit, "nginx-company-data.conf"), "utf8");
	const applyBlock = /location ~ \^\/v1\/company-data\/\[\^\/\]\+\/apply\$ \{[\s\S]*?\}/.exec(nginx)?.[0];
	assert.ok(applyBlock, "nginx config defines a dedicated /apply location");
	assert.match(applyBlock, /proxy_read_timeout 120s;/);
	assert.match(applyBlock, /proxy_buffering off;/);
	const testSchemasBlock = /location ~ \^\/v1\/company-data\/\[\^\/\]\+\/test-schemas\$ \{[\s\S]*?\}/.exec(nginx)?.[0];
	assert.ok(testSchemasBlock, "nginx config defines a dedicated /test-schemas location");
	assert.match(testSchemasBlock, /proxy_read_timeout 120s;/);
	assert.match(testSchemasBlock, /proxy_buffering off;/);
	const defaultBlock = /location \/v1\/company-data\/ \{[\s\S]*?\}/.exec(nginx)?.[0];
	assert.ok(defaultBlock, "nginx config keeps default /v1/company-data/ location");
	assert.match(defaultBlock, /proxy_read_timeout 35s;/);
});

test("gateway-main wires all four external doors from env and secret files without leaking secrets", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-gateway-main-doors-"));
	let child = null;
	try {
		const loginsDir = join(temporary, "logins");
		const pubDir = join(temporary, "public");
		const envId = randomUUID();
		mkdirSync(loginsDir, { recursive: true });
		mkdirSync(join(pubDir, envId, "data", "shop", "queries"), { recursive: true });
		for (const name of ["admin", "keeper", "watch"]) writeFileSync(join(loginsDir, name), "pass-secret\n");
		writeFileSync(join(loginsDir, "folder-key"), `${"ab".repeat(32)}\n`);
		writeFileSync(
			join(pubDir, envId, "data", "shop", "database.toml"),
			'format = "qorpera.database/v1"\n[public]\nquestions = ["catalog"]\n',
		);
		writeFileSync(join(pubDir, envId, "data", "shop", "queries", "catalog.sql"), "select 1;\n");

		const adminTok = randomBytes(32).toString("base64url");
		const directTok = randomBytes(32).toString("base64url");
		const hookTok = randomBytes(32).toString("base64url");
		const trigTok = randomBytes(32).toString("base64url");
		const wakeTok = randomBytes(24).toString("base64url");
		writeFileSync(join(temporary, "admin.tok"), `${adminTok}\n`);
		writeFileSync(join(temporary, "direct.tok"), `${directTok}\n`);
		writeFileSync(join(temporary, "hook.tok"), `${hookTok}\n`);
		writeFileSync(join(temporary, "trigger.tok"), `${trigTok}\n`);
		writeFileSync(join(temporary, "wake.tok"), `${wakeTok}\n`);

		const freePort = await new Promise((resolve, reject) => {
			const s = net.createServer();
			s.on("error", reject);
			s.listen(0, "127.0.0.1", () => {
				const p = s.address().port;
				s.close(() => resolve(p));
			});
		});

		const baseEnv = {
			PATH: process.env.PATH,
			DATA_STORE_HOST: "127.0.0.1",
			DATA_STORE_PORT: "1",
			DATA_LOGINS: loginsDir,
			DATA_PLATFORM_URL: "http://127.0.0.1:1",
			DATA_PLATFORM_KEY: "test-key",
			DATA_LISTEN: `127.0.0.1:${freePort}`,
		};
		const conflict = spawnSync(process.execPath, [join(kit, "gateway-main.mjs")], {
			env: { ...baseEnv, DATA_HOOK_TOKEN: hookTok, DATA_HOOK_TOKEN_FILE: join(temporary, "hook.tok") },
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(conflict.status, 2);
		assert.match(conflict.stderr, /set only one of DATA_HOOK_TOKEN or DATA_HOOK_TOKEN_FILE/);
		assert.equal(conflict.stderr.includes(hookTok), false);

		const duplicate = spawnSync(process.execPath, [join(kit, "gateway-main.mjs")], {
			env: { ...baseEnv, DATA_ADMIN_TOKEN: adminTok, DATA_DIRECT_LOGIN_TOKEN: adminTok },
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(duplicate.status, 2);
		assert.match(duplicate.stderr, /distinct/);
		assert.equal(duplicate.stderr.includes(adminTok), false);

		child = spawn(process.execPath, [join(kit, "gateway-main.mjs")], {
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...baseEnv,
				DATA_ADMIN_TOKEN_FILE: join(temporary, "admin.tok"),
				DATA_DIRECT_LOGIN_TOKEN_FILE: join(temporary, "direct.tok"),
				DATA_HOOK_TOKEN_FILE: join(temporary, "hook.tok"),
				DATA_PUBLIC_DIR: pubDir,
				DATA_TRIGGER_TOKEN_FILE: join(temporary, "trigger.tok"),
				DATA_TRIGGER_WAKE_URL: "http://127.0.0.1:1/wake",
				DATA_TRIGGER_WAKE_TOKEN_FILE: join(temporary, "wake.tok"),
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		for (let i = 0; i < 100 && !stdout.includes("listening"); i++) await new Promise((r) => setTimeout(r, 50));
		assert.match(stdout, /external doors enabled: direct-login, public-reader, hook-data, triggers/);
		for (const secret of [adminTok, directTok, hookTok, trigTok, wakeTok]) {
			assert.equal(stdout.includes(secret), false);
			assert.equal(stderr.includes(secret), false);
		}

		const directUnauth = await fetch(`http://127.0.0.1:${freePort}/v1/admin/company-data/${envId}/direct-login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ database: "shop" }),
		});
		assert.equal(directUnauth.status, 401);

		const hookUnauth = await fetch(`http://127.0.0.1:${freePort}/v1/hook-data/${envId}/change`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ database: "shop", change: "x" }),
		});
		assert.equal(hookUnauth.status, 401);

		const triggersOk = await fetch(`http://127.0.0.1:${freePort}/v1/admin/company-data/${envId}/triggers`, {
			headers: { authorization: `Bearer ${trigTok}` },
		});
		assert.equal(triggersOk.status, 200);
		assert.deepEqual(await triggersOk.json(), { triggers: [] });

		const pubRes = await fetch(`http://127.0.0.1:${freePort}/v1/company-data-public/${envId}/query`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ database: "shop", question: "not-allowed" }),
		});
		assert.equal(pubRes.status, 404);
		assert.equal((await pubRes.json()).error, "No public question shop/not-allowed");
	} finally {
		child?.kill("SIGTERM");
		await rm(temporary, { recursive: true, force: true });
	}
});
