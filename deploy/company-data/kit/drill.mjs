// The kit's drill, on a test machine, never on a node or production:
//   node scripts/run-on-node.mjs --no-status --sudo -- node deploy/company-data/kit/drill.mjs
// Root, because the kit's scripts are (their folders hold passwords and keys). Three compose projects stand in for the
// machines: A the primary's node, B the standby's node, R a restore. A local folder stands in for the NAS folder, one
// docker network for the office LAN (drill/drill.yml), and a small server for the platform's API (drill/platform-standin.mjs).
// Proves: (a) init, then the gateway makes a company database and answers a question; (b) the database's port is not
// published, the gateway's is, on loopback; (e) a slow or failing statement's values never reach the log; (c) a
// point-in-time restore holds exactly the rows up to the time; (d) a standby streams over TLS, takes over, and its
// gateway answers with every committed row; (f) everything is removed. Every container is capped (docker-compose.yml,
// drill.yml, DATA_DB_MEMORY), every published port is on 127.0.0.1, and nothing is pulled: the images must be there.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { companyDatabase } from "../gateway/gateway.mjs";
import { check, finish, note, sleep } from "../proof/lib.mjs";

const KIT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(KIT, "../../..");
const POSTGRES_IMAGE = "docker.io/library/postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3";
const NODE_IMAGE = "node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0";
const RUN = `cdkit-${process.pid}-${Date.now().toString(36)}`;
const WORK = mkdtempSync(join(tmpdir(), `${RUN}-`));
const NAS = join(WORK, "nas");
const FOLDER = join(WORK, "folder");
const LINK = `${RUN}-link`;
const ENV = "64000000-0000-4000-8000-000000000001";
const MEMBER = "64000000-0000-4000-8000-000000000002";
const STORE = companyDatabase(ENV);
const SECRET = `drill-value-${randomBytes(8).toString("hex")}`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const timings = [];
const timed = async (label, work) => {
	const started = Date.now();
	try {
		return await work();
	} finally {
		timings.push(`${label} ${((Date.now() - started) / 1000).toFixed(1)}s`);
	}
};

const FILES = {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\nabout = "The drill\'s orders"\n',
	"data/shop/tables/001-orders.sql":
		"create table orders (id bigint generated always as identity primary key, note text not null, at timestamptz not null default clock_timestamp());\n" +
		"insert into orders (note) select 'seed ' || n from generate_series(1, 10) n;\n",
	"data/shop/queries/count.sql": "-- How many orders there are, and the newest.\nselect count(*) as orders, coalesce(max(id), 0) as newest from orders;\n",
	"data/shop/queries/slow.sql": "-- Waits a little.\nselect pg_sleep(1.3) as waited, length(:value::text) as n;\n",
	"data/shop/queries/fails.sql": "-- Divides by zero.\nselect 1 / (length(:value::text) - length(:value::text)) as boom;\n",
};
const TEXT_BY_HASH = new Map(Object.values(FILES).map((text) => [sha256(text), text]));

const freePort = () =>
	new Promise((done, fail) => {
		const server = net.createServer();
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});

// ---- the three stand-in machines
const machine = (name, linkName, port, files = ["docker-compose.yml", "drill/drill.yml"]) => ({
	name,
	project: `${RUN}-${name}`,
	local: join(WORK, name),
	port,
	env: {
		...process.env,
		COMPOSE_PROJECT_NAME: `${RUN}-${name}`,
		COMPOSE_FILE: files.map((file) => join(KIT, file)).join(":"),
		DATA_LOCAL: join(WORK, name),
		DATA_BACKUP: NAS,
		DATA_GATEWAY_LISTEN: `127.0.0.1:${port}`,
		DATA_PLATFORM_URL: "http://platform-standin:8000",
		DATA_PLATFORM_KEY: "drill-publishable-key",
		DATA_NODE_MODULES: join(ROOT, "node_modules"),
		DATA_DB_CPUS: "2",
		DATA_DB_MEMORY: "4g",
		DRILL_LINK_NETWORK: LINK,
		DRILL_LINK_NAME: linkName,
		DRILL_FOLDER: FOLDER,
	},
});
const run = (command, args, options = {}) => {
	const done = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024, ...options });
	return { ok: done.status === 0, status: done.status, out: done.stdout ?? "", err: `${done.stderr ?? ""}${done.error ? ` ${done.error.message}` : ""}` };
};
const script = (m, name, args = [], input) => run("bash", [join(KIT, name), ...args], { env: m.env, input });
const compose = (m, args, input) => run("docker", ["compose", ...args], { env: m.env, input });
const sql = (m, text, database = "postgres") => {
	const done = compose(m, ["exec", "-T", "-u", "postgres", "data-db", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", text]);
	if (!done.ok) throw new Error(`psql on ${m.name}: ${done.err.trim()}`);
	return done.out.trim();
};
const tail = (text, lines = 12) => text.trim().split("\n").slice(-lines).join(" | ");
const show = (label, done) => {
	for (const line of `${done.out}`.trim().split("\n").filter(Boolean)) note(`${label}: ${line}`);
	if (!done.ok) note(`${label} failed (${done.status}): ${tail(done.err)}`);
};
const container = (m, service) => compose(m, ["ps", "-aq", service]).out.trim();
// Count and a hash of every row, in key order: the same text on two copies means the same rows.
const ROWS = "select count(*) || ' ' || md5(coalesce(string_agg(id || ':' || note || ':' || at, ',' order by id), '')) from shop.orders";

// ---- a member's call to a gateway, as the web makes it: when the gateway asks for a file's text, the caller sends it
const token = (() => {
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part({ sub: MEMBER, role: "authenticated" })}.stand-in`;
})();
const call = async (m, verb, body) => {
	const response = await fetch(`http://127.0.0.1:${m.port}/v1/company-data/${ENV}/${verb}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	return { status: response.status, value: await response.json() };
};
const ask = async (m, verb, body) => {
	let answer = await call(m, verb, body);
	for (let round = 0; answer.status === 200 && answer.value.need && round < 3; round++) {
		const texts = Object.fromEntries(answer.value.need.map((wanted) => [wanted.sha256, TEXT_BY_HASH.get(wanted.sha256)]));
		answer = await call(m, verb, { ...body, texts });
	}
	return answer;
};

const A = machine("a", "data-primary", await freePort());
const B = machine("b", "data-standby", await freePort());
const R = machine("r", "data-restore", await freePort(), ["docker-compose.yml"]);
const MACHINES = [A, B, R];
let failure = null;

try {
	note(`run ${RUN}; work folder ${WORK}; machine: ${run("nproc", []).out.trim()} vCPU`);
	for (const image of [POSTGRES_IMAGE, NODE_IMAGE]) {
		const there = run("docker", ["image", "inspect", "--format", "{{.Id}}", image]).ok;
		check(`the pinned image is on this machine, nothing is pulled: ${image.split("@")[0]}`, there);
		if (!there) throw new Error(`missing image ${image}: report it, do not pull`);
	}
	mkdirSync(NAS, { mode: 0o755 });
	mkdirSync(FOLDER, { mode: 0o755 });
	writeFileSync(join(FOLDER, "folder.json"), JSON.stringify({ member: MEMBER, files: FILES }), { mode: 0o644 });
	const link = run("docker", ["network", "create", "--internal", "--label", `cdkit.run=${RUN}`, LINK]);
	if (!link.ok) throw new Error(`the link network: ${link.err}`);
	const linkSubnet = run("docker", ["network", "inspect", "-f", "{{(index .IPAM.Config 0).Subnet}}", LINK]).out.trim();
	for (const m of [A, B]) {
		const config = compose(m, ["config", "-q"]);
		if (!config.ok) throw new Error(`compose config: ${config.err}`);
	}
	const replicationConfig = run("docker", ["compose", "-f", join(KIT, "docker-compose.yml"), "-f", join(KIT, "replication.yml"), "config", "-q"], {
		env: { ...A.env, COMPOSE_FILE: "", DATA_DB_LISTEN: "127.0.0.1:15999" },
	});
	check("replication.yml is a valid overlay (it is not started here)", replicationConfig.ok, tail(replicationConfig.err, 3));

	// ---- (a) init, then the gateway answers
	const init = await timed("init", async () => script(A, "init.sh", ["data-primary", "data-standby"]));
	show("init", init);
	check("(a) init.sh starts the store and the gateway on an empty volume", init.ok);
	if (!init.ok) throw new Error("init failed");
	const again = script(A, "init.sh", ["data-primary"]);
	check("(a) a second init.sh is refused", !again.ok && /init runs once/.test(again.err), tail(again.err, 2));
	const settings = sql(
		A,
		"select concat_ws(' ', current_setting('shared_buffers'), current_setting('effective_cache_size'), current_setting('max_connections'), " +
			"current_setting('wal_level'), current_setting('archive_mode'), current_setting('archive_timeout'), current_setting('log_min_duration_statement'), " +
			"current_setting('log_parameter_max_length'), current_setting('log_parameter_max_length_on_error'), current_setting('password_encryption'), current_setting('ssl'))",
	);
	check("(a) the store runs the kit's settings", settings === "2GB 5GB 200 replica on 1min 1s 0 0 scram-sha-256 on", settings);
	check("(a) pg_hba.conf has no error", sql(A, "select count(*) from pg_hba_file_rules where error is not null") === "0");
	const mode = (path) => (statSync(path).mode & 0o777).toString(8);
	const owner = (path) => `${statSync(path).uid}`;
	check(
		"(a) the secrets are in root-only files: the folder 0700, each gateway secret the gateway's 0400",
		mode(A.local) === "700" && mode(join(A.local, "secrets")) === "700" && mode(join(A.local, "secrets/gateway/admin")) === "400" && owner(join(A.local, "secrets/gateway/admin")) === "65534" && mode(join(A.local, "ca/ca.key")) === "400",
		`${mode(A.local)} ${mode(join(A.local, "secrets"))} ${mode(join(A.local, "secrets/gateway/admin"))}`,
	);
	const applied = await timed("apply", () => ask(A, "apply", { database: "shop" }));
	check("(a) the gateway makes the company database and applies its step through an apply call", applied.value.applied === true, JSON.stringify(applied.value).slice(0, 200));
	const first = await ask(A, "query", { database: "shop", question: "count" });
	check("(a) the gateway answers a question", first.status === 200 && first.value.rows?.[0]?.[0] === 10, JSON.stringify(first.value).slice(0, 200));

	// ---- (b) ports
	const dbPorts = run("docker", ["port", container(A, "data-db")]).out.trim();
	const gatewayPorts = run("docker", ["port", container(A, "data-gateway")]).out.trim();
	check("(b) the database's port is published on no host address", dbPorts === "", dbPorts || "none");
	check("(b) the gateway's port is published on 127.0.0.1 only", gatewayPorts === `8480/tcp -> 127.0.0.1:${A.port}`, gatewayPorts);
	const superuser = compose(A, ["run", "--rm", "--no-deps", "-T", "-e", "PGPASSWORD=x", "--entrypoint", "psql", "data-db", "host=data-db dbname=postgres user=postgres sslmode=require connect_timeout=5", "-c", "select 1"]);
	check("(b) the superuser cannot log in over the network, even from the compose network", !superuser.ok && /pg_hba\.conf rejects connection/.test(superuser.err), tail(superuser.err, 1));

	// ---- (e) no company value in the log
	const slow = await ask(A, "query", { database: "shop", question: "slow", params: { value: SECRET } });
	const fails = await ask(A, "query", { database: "shop", question: "fails", params: { value: SECRET } });
	check("(e) a slow question with a parameter ran, and one that fails failed", slow.status === 200 && fails.status === 400, `${slow.status} ${fails.status}`);
	await sleep(500);
	const logs = run("docker", ["logs", container(A, "data-db")]);
	const log = `${logs.out}${logs.err}`;
	check("(e) the slow statement and the error are in the database's log", /duration: \d+\.\d+ ms\s+execute/.test(log) && /division by zero/.test(log));
	check("(e) the parameter's value is not in the log", !log.includes(SECRET), `${log.split("\n").length} lines searched`);

	// ---- (c) base backup, then a point-in-time restore into a new project
	const insert = (m, label, n) => sql(m, `insert into shop.orders (note) select '${label} ' || g from generate_series(1, ${n}) g`, STORE);
	insert(A, "before base", 1000);
	const backup = await timed("base backup", async () => run("bash", [join(KIT, "base-backup.sh")], { env: { ...A.env, CHECKPOINT: "fast" } }));
	show("base-backup", backup);
	check("(c) base-backup.sh takes a base backup into the backup folder", backup.ok);
	insert(A, "after base", 1000);
	await sleep(1100);
	const target = sql(A, "select clock_timestamp()");
	await sleep(1100);
	const atTarget = sql(A, ROWS, STORE);
	insert(A, "after target", 1000);
	const last = sql(A, "select pg_walfile_name(pg_current_wal_lsn())");
	sql(A, "select pg_switch_wal()");
	let archived = false;
	for (let i = 0; i < 120 && !archived; i++) {
		archived = sql(A, `select coalesce(last_archived_wal, '') >= '${last}' from pg_stat_archiver`) === "t";
		if (!archived) await sleep(500);
	}
	check("(c) the WAL archive caught up with the primary", archived, last);
	note(`rows at the target ${target}: ${atTarget}; rows now: ${sql(A, ROWS, STORE)}`);
	const restored = await timed("restore", async () => script(R, "restore.sh", ["latest", target]));
	show("restore", restored);
	check("(c) restore.sh restores the base backup and the WAL to the time into a new project", restored.ok);
	const restoredRows = restored.ok ? sql(R, ROWS, STORE) : "none";
	check("(c) the restored store holds exactly the rows up to the time: count and hash", restoredRows === atTarget, restoredRows);
	check("(c) no row written after the time is there", restored.ok && sql(R, "select count(*) from shop.orders where note like 'after target%'", STORE) === "0");
	compose(R, ["down", "-v", "--timeout", "20"]);

	// ---- (d) a standby on the other machine, then the take-over
	const allow = script(A, "standby.sh", ["allow", linkSubnet]);
	show("allow", allow);
	const pack = run("bash", [join(KIT, "standby.sh"), "pack"], { env: A.env, encoding: "buffer" });
	const unpack = run("bash", [join(KIT, "standby.sh"), "unpack"], { env: B.env, input: pack.out });
	show("unpack", unpack);
	check("(d) the standby's machine gets the TLS files and secrets from the primary's (never the CA key)", allow.ok && pack.ok && unpack.ok && !existsSync(join(B.local, "ca")));
	const seed = await timed("standby seed", async () => script(B, "standby.sh", ["seed", "data-primary", "5432"]));
	show("seed", seed);
	const stream = sql(A, "select r.state || ' ' || s.ssl from pg_stat_replication r join pg_stat_ssl s using (pid)");
	check("(d) the standby is seeded and streams over TLS", seed.ok && stream === "streaming true", stream);
	const plain = compose(B, ["run", "--rm", "--no-deps", "-T", "-u", "postgres", "-e", "PGPASSFILE=/etc/company-data-local/replication.pgpass", "--entrypoint", "psql", "data-db",
		"host=data-primary port=5432 user=qorpera_data_replicator replication=true sslmode=disable connect_timeout=5", "-c", "IDENTIFY_SYSTEM"]);
	check("(d) a replication login without TLS is refused", !plain.ok && /no pg_hba\.conf entry/.test(plain.err), tail(plain.err, 1));
	insert(A, "before take-over", 500);
	const lsn = sql(A, "select pg_current_wal_lsn()");
	let caught = false;
	for (let i = 0; i < 120 && !caught; i++) {
		caught = sql(B, `select coalesce(pg_last_wal_replay_lsn() >= '${lsn}'::pg_lsn, false)`) === "t";
		if (!caught) await sleep(250);
	}
	show("status on the primary", script(A, "standby.sh", ["status"]));
	show("status on the standby", script(B, "standby.sh", ["status"]));
	check("(d) the standby replayed every committed row", caught, lsn);
	const committed = sql(A, ROWS, STORE);
	const stopped = compose(A, ["stop", "--timeout", "30"]);
	check("(d) the primary's machine is stopped (the fence)", stopped.ok);
	const promote = await timed("promote", async () => script(B, "standby.sh", ["promote"]));
	show("promote", promote);
	check("(d) standby.sh promote makes the standby the primary and starts its gateway", promote.ok);
	const afterTakeOver = await ask(B, "query", { database: "shop", question: "count" });
	const committedCount = Number(committed.split(" ")[0]);
	check("(d) the gateway on the promoted store answers with every committed row", afterTakeOver.status === 200 && afterTakeOver.value.rows?.[0]?.[0] === committedCount, `${JSON.stringify(afterTakeOver.value.rows)} want ${committedCount}`);
	check("(d) the promoted store holds the same rows: count and hash", sql(B, ROWS, STORE) === committed, committed);
	insert(B, "after take-over", 1);
	check("(d) the promoted store takes writes", sql(B, "select count(*) from shop.orders where note like 'after take-over%'", STORE) === "1");
} catch (error) {
	failure = error;
	check("the drill ran to its end", false, String(error?.message ?? error).slice(0, 600));
	for (const m of MACHINES) {
		for (const service of ["data-db", "data-gateway"]) {
			const id = container(m, service);
			if (id) note(`${m.name} ${service} log: ${tail(`${run("docker", ["logs", "--tail", "15", id]).err}`, 15)}`);
		}
	}
} finally {
	// ---- (f) everything removed, also after a failure
	for (const m of MACHINES) compose(m, ["down", "-v", "--remove-orphans", "--timeout", "20"]);
	run("docker", ["network", "rm", LINK]);
	rmSync(WORK, { recursive: true, force: true });
	const left = MACHINES.flatMap((m) => [
		...run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${m.project}`]).out.split("\n"),
		...run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${m.project}`]).out.split("\n"),
		...run("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${m.project}`]).out.split("\n"),
	]).filter(Boolean);
	left.push(...run("docker", ["network", "ls", "-q", "--filter", `name=^${LINK}$`]).out.split("\n").filter(Boolean));
	check("(f) every container, volume, network and folder of the drill is removed", left.length === 0 && !existsSync(WORK), left.join(" ") || "none left");
	note(`timings: ${timings.join(", ")}`);
}
finish();
if (failure) process.exitCode = 1;
