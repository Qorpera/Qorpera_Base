import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import pg from "pg";
import { checkLocale, LOCALE_QUERY, POSTGRES_IMAGE, POSTGRES_LOCALE } from "../../../scripts/test-hosted-db.mjs";
import { Gateway, LIMITS, Platform, serve, serveRuns } from "./gateway.mjs";

export const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const storeFile = (name) => readFileSync(new URL(`../store/${name}`, import.meta.url));

export const LIMITS_HERE = {
	...LIMITS,
	questionMs: 300,
	questionRows: 50,
	questionBytes: 4096,
	stepMs: 5_000,
	stepLockMs: 1_000,
	watchMs: 4_000,
	watchAgainMs: 50,
	listenIdleMs: 0,
	readPoolIdleMs: 5_000,
	proofMs: 0,
	bodyBytes: 8192,
	agentMs: 4_000,
	agentRows: 20,
	agentBytes: 2048,
	changeBytes: 64 * 1024,
};

export const ENV_A = "64000000-0000-4000-8000-0000000000a0";
export const ENV_B = "64000000-0000-4000-8000-0000000000b0";
export const ENV_C = "64000000-0000-4000-8000-0000000000c0";
export const ENV_D = "64000000-0000-4000-8000-0000000000d0";
export const ENV_E = "64000000-0000-4000-8000-0000000000e0";

const person = (n) => `64000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
export const OWNER = person(1);
export const CONTRIBUTOR = person(2);
export const VIEWER = person(3);
export const STRANGER = person(9);
export const B_MEMBER = person(11);

export const ORDERS = `create table orders (
	id bigint generated always as identity primary key,
	customer text not null,
	amount numeric(12,2) not null check (amount >= 0),
	status text not null default 'paid' check (status in ('paid', 'shipped', 'refunded')),
	placed_by uuid,
	placed_at timestamptz not null default now()
);
insert into orders (customer, amount, status, placed_at)
select 'Customer ' || n, 100 + (n % 7) * 25, case when n % 5 = 0 then 'shipped' else 'paid' end, now() - (n || ' hours')::interval
from generate_series(1, 240) n;
`;

export const COUNT = "-- How many orders there are.\nselect count(*) as orders from orders;\n";
export const MARKER = `mark${randomBytes(6).toString("hex")}`;
export const NAMES = [
	"qorpera_asked",
	"qorpera_inner",
	"qorpera_sized",
	"qorpera_made",
	"qorpera_answer",
	"qorpera_at",
	"qorpera_bytes_so_far",
	"qorpera_rows_made",
	"qorpera_bytes",
	"qorpera_rows",
];

const SERVER_LOG_ARGS = [
	"-c",
	"log_statement=all",
	"-c",
	"log_min_duration_statement=0",
	"-c",
	"log_min_messages=info",
	"-c",
	"log_error_verbosity=verbose",
	"-c",
	"log_lock_waits=on",
	"-c",
	"deadlock_timeout=100ms",
	"-c",
	"log_temp_files=0",
	"-c",
	"log_transaction_sample_rate=1",
];

export function createGatewayHarness({ logAllStatements = false } = {}) {
	const RUN_TOKEN = randomBytes(32).toString("base64url");
	const MEMBERS = {
		[ENV_A]: new Set([OWNER, CONTRIBUTOR, VIEWER]),
		[ENV_B]: new Set([B_MEMBER]),
		[ENV_C]: new Set([OWNER]),
		[ENV_D]: new Set([OWNER, VIEWER]),
		[ENV_E]: new Set([OWNER, CONTRIBUTOR, VIEWER]),
	};
	const WRITERS = new Set([OWNER, CONTRIBUTOR]);
	const PRIVATE = { [ENV_A]: { "data/hr": CONTRIBUTOR }, [ENV_B]: {}, [ENV_C]: {}, [ENV_D]: { "data/diary": VIEWER }, [ENV_E]: {} };
	const FOLDERS = { [ENV_A]: new Map(), [ENV_B]: new Map(), [ENV_C]: new Map(), [ENV_D]: new Map(), [ENV_E]: new Map() };
	const TEXTS = new Map();
	const KNOWN = new Map();
	const PASSES = new Map();

	let writeCheckMissing = false;
	let platformCalls = 0;

	const put = (env, files) => {
		for (const [path, text] of Object.entries(files)) {
			FOLDERS[env].set(path, text);
			TEXTS.set(sha256(text), text);
		}
	};
	const remove = (env, path) => FOLDERS[env].delete(path);
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const tokenOf = (userId) => {
		const token = `${part({ alg: "none", typ: "JWT" })}.${part({ role: "authenticated", sub: userId })}.unsigned`;
		KNOWN.set(token, userId);
		return token;
	};
	const mayRead = (env, userId, path) =>
		MEMBERS[env]?.has(userId) === true &&
		Object.entries(PRIVATE[env] ?? {}).every(([folder, only]) => only === userId || !(path === folder || path.startsWith(`${folder}/`)));

	const passFor = (env, userId, database = null, { ms = 60_000, allow = undefined, machine = false } = {}) => {
		const files = [...FOLDERS[env]]
			.filter(([path]) => {
				const at = /^data\/([a-z][a-z0-9_]{0,39})\/(database\.toml|(tables|queries|actions)\/[^/]+)$/.exec(path);
				return (
					at &&
					(database === null || at[1] === database) &&
					FOLDERS[env].has(`data/${at[1]}/database.toml`) &&
					mayRead(env, userId, `data/${at[1]}/database.toml`) &&
					mayRead(env, userId, path)
				);
			})
			.map(([path, text]) => ({ path, sha256: sha256(text), bytes: Buffer.byteLength(text) }));
		const pass = randomBytes(32).toString("base64url");
		PASSES.set(pass, {
			kept: {
				schema: "qorpera.data-pass-redeemed/v1",
				...(machine ? { kind: "machine", viewId: randomUUID(), machineId: randomUUID() } : { kind: "run", runId: randomUUID() }),
				environmentId: env,
				staffAgentId: randomUUID(),
				requesterUserId: userId,
				database,
				files,
				...(allow === undefined ? {} : { allow }),
			},
			redeemed: false,
			until: Date.now() + ms,
		});
		return pass;
	};

	async function platformFetch(url, init) {
		platformCalls++;
		const reply = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
		if (new URL(url).pathname === "/rest/v1/rpc/qorpera_data_pass_redeem") {
			if (init.method !== "POST" || init.headers.apikey !== "publishable" || init.headers.authorization !== undefined)
				return reply(400, { message: "bad request" });
			const held = PASSES.get(JSON.parse(init.body).p_pass);
			if (!held || held.redeemed || Date.now() >= held.until) return reply(200, null);
			held.redeemed = true;
			return reply(200, held.kept);
		}
		const token = /^Bearer (.+)$/.exec(init.headers.authorization ?? "")?.[1];
		if (init.method !== "POST" || init.headers.apikey !== "publishable") return reply(400, { message: "bad request" });
		if (!KNOWN.has(token)) return reply(401, { message: "JWT invalid" });
		const userId = KNOWN.get(token);
		const args = JSON.parse(init.body);
		const env = args.p_environment_id;
		const files = FOLDERS[env] ?? new Map();
		const entry = (path) => ({ path, kind: "file", fileSha256: sha256(files.get(path)), bytes: Buffer.byteLength(files.get(path)) });
		switch (new URL(url).pathname) {
			case "/rest/v1/rpc/qorpera_member_folder_read_many":
				return reply(200, {
					reads: args.p_paths.map((path) => (files.has(path) && mayRead(env, userId, path) ? { found: true, entry: entry(path) } : { found: false })),
				});
			case "/rest/v1/rpc/qorpera_member_folder_list": {
				if (!Number.isInteger(args.p_limit) || args.p_limit < 1 || args.p_limit > 1000)
					return reply(400, { code: "22023", message: "Listing is invalid" });
				const prefix = `${args.p_parent}/`;
				const folders = new Set(
					[...files.keys()]
						.filter((path) => path.startsWith(prefix) && path.slice(prefix.length).includes("/"))
						.map((path) => `${prefix}${path.slice(prefix.length).split("/")[0]}`)
						.filter((path) => mayRead(env, userId, path)),
				);
				const all = [
					...[...files.keys()]
						.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && mayRead(env, userId, path))
						.map(entry),
					...[...folders].map((path) => ({ path, kind: "folder" })),
				]
					.sort((a, b) => (a.path < b.path ? -1 : 1))
					.filter((one) => args.p_after === null || one.path > args.p_after);
				const entries = all.slice(0, args.p_limit);
				return reply(200, { entries, next: entries.length === args.p_limit ? entries.at(-1).path : null });
			}
			case "/rest/v1/rpc/qorpera_member_folder_may_write":
				if (writeCheckMissing) return reply(404, { code: "PGRST202", message: "Could not find the function" });
				return reply(200, {
					schema: "qorpera.member-folder-may-write/v1",
					path: args.p_path,
					write: MEMBERS[env]?.has(userId) === true && WRITERS.has(userId) && mayRead(env, userId, args.p_path),
				});
			default:
				return reply(404, { message: "no such function" });
		}
	}

	const container = `cdgateway-${process.pid}-${randomBytes(4).toString("hex")}`;
	const superPassword = randomBytes(16).toString("hex");
	const logins = {
		...Object.fromEntries(["admin", "keeper", "watch"].map((login) => [login, randomBytes(16).toString("hex")])),
		folderKey: randomBytes(32).toString("hex"),
	};
	let storePort = 0;
	let gateway = null;
	let server = null;
	let port = 0;
	let runServer = null;

	const owner = tokenOf(OWNER);
	const contributor = tokenOf(CONTRIBUTOR);
	const viewer = tokenOf(VIEWER);
	const stranger = tokenOf(STRANGER);
	const bMember = tokenOf(B_MEMBER);
	const forged = `${owner.slice(0, owner.lastIndexOf("."))}.forged`;

	const connect = (database, user = "postgres", password = superPassword) =>
		new pg.Client({ host: "127.0.0.1", port: storePort, user, password, database });
	const asAdmin = async (database, text, values) => {
		const client = connect(database);
		await client.connect();
		try {
			return (await client.query(text, values)).rows;
		} finally {
			await client.end();
		}
	};
	const psql = (database, file, variables = {}, input = storeFile(file)) => {
		const made = spawnSync(
			"docker",
			[
				"exec",
				"-i",
				container,
				"psql",
				"-X",
				"-q",
				"-h",
				"127.0.0.1",
				"-U",
				"postgres",
				"-d",
				database,
				"-v",
				"ON_ERROR_STOP=1",
				...Object.entries(variables).flatMap(([name, value]) => ["-v", `${name}=${value}`]),
			],
			{ input, encoding: "utf8" },
		);
		if (made.status !== 0) throw new Error(`${file}: ${made.stderr}`);
	};
	const listening = async () =>
		(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where application_name = 'qorpera-data-gateway listen'"))[0].n;
	const until = async (what, wanted, ms = 2_000) => {
		const end = Date.now() + ms;
		let value = await what();
		while (value !== wanted && Date.now() < end) {
			await sleep(25);
			value = await what();
		}
		return value;
	};

	const send = ({ method = "POST", path, bearer, text = "", to = port }) =>
		new Promise((resolve, reject) => {
			const request = http.request(
				{
					host: "127.0.0.1",
					port: to,
					path,
					method,
					headers: {
						...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
						"content-type": "application/json",
						"content-length": Buffer.byteLength(text),
					},
				},
				(response) => {
					let answer = "";
					response.setEncoding("utf8");
					response.on("data", (piece) => {
						answer += piece;
					});
					response.on("end", () => resolve({ status: response.statusCode, value: answer ? JSON.parse(answer) : null }));
				},
			);
			request.on("error", reject);
			request.end(text);
		});
	const call = (bearer, verb, body, env = ENV_A) => send({ path: `/v1/company-data/${env}/${verb}`, bearer, text: JSON.stringify(body) });
	const ask = async (bearer, verb, body, env = ENV_A) => {
		let answer = await call(bearer, verb, body, env);
		for (let round = 0; round < 8 && answer.status === 200 && answer.value.need; round++) {
			const texts = {};
			let bytes = 0;
			for (const wanted of answer.value.need) {
				const text = TEXTS.get(wanted.sha256);
				if (Object.keys(texts).length > 0 && bytes + Buffer.byteLength(text) > LIMITS_HERE.bodyBytes / 2) break;
				texts[wanted.sha256] = text;
				bytes += Buffer.byteLength(text);
			}
			answer = await call(bearer, verb, { ...body, texts }, env);
		}
		return answer;
	};
	const describeOne = async (bearer, database, env = ENV_A) => {
		const answer = await ask(bearer, "describe", { database }, env);
		return { status: answer.status, value: answer.status === 200 ? answer.value.databases[0] : answer.value, whole: answer.value };
	};
	const states = (answer) => answer.value.results?.map((result) => `${result.name} ${result.state}`);

	const withGateway = async (options, work) => {
		const other = new Gateway({
			store: { host: "127.0.0.1", port: storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: LIMITS_HERE,
			...options,
		});
		const otherServer = await serve(other);
		const mainPort = port;
		port = otherServer.address().port;
		let failed = false;
		try {
			return await work(other);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			port = mainPort;
			otherServer.close();
			otherServer.closeAllConnections();
			let timer;
			const closed = await Promise.race([
				other.close().then(() => true),
				new Promise((resolve) => {
					timer = setTimeout(resolve, 10_000, false);
				}),
			]);
			clearTimeout(timer);
			if (!closed && !failed) assert.fail("the gateway did not close within 10 s: it never gave a connection back");
		}
	};

	const start = async () => {
		try {
			const started = spawnSync(
				"docker",
				[
					"run",
					"-d",
					"--name",
					container,
					"--cpus",
					"2",
					"--memory",
					"4g",
					"--shm-size",
					"256m",
					"--tmpfs",
					"/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
					"-e",
					`POSTGRES_PASSWORD=${superPassword}`,
					...POSTGRES_LOCALE,
					"-p",
					"127.0.0.1::5432",
					POSTGRES_IMAGE,
					"-c",
					"max_connections=100",
					"-c",
					"fsync=off",
					"-c",
					"synchronous_commit=off",
					"-c",
					"full_page_writes=off",
					"-c",
					"jit=off",
					...(logAllStatements ? SERVER_LOG_ARGS : []),
				],
				{ encoding: "utf8" },
			);
			if (started.status !== 0) throw new Error(`PostgreSQL did not start: ${started.stderr}`);
			const published = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout;
			storePort = Number(/^127\.0\.0\.1:(\d+)$/m.exec(published)?.[1]);
			assert.ok(storePort > 0, `no loopback port: ${published}`);
			let ready = false;
			for (let attempt = 0; attempt < 600 && !ready; attempt++) {
				ready =
					spawnSync("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", "select 1"], { stdio: "ignore" })
						.status === 0;
				if (!ready) await sleep(100);
			}
			assert.ok(ready, "PostgreSQL did not become ready");
			checkLocale(
				spawnSync("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", LOCALE_QUERY], { encoding: "utf8" }).stdout,
			);
			psql("postgres", "cluster.sql", { admin_password: logins.admin, keeper_password: logins.keeper, watch_password: logins.watch });
			psql("qorpera_company_template", "template.sql");
			gateway = new Gateway({
				store: { host: "127.0.0.1", port: storePort, logins },
				platform: new Platform({ url: "http://platform/", publishableKey: "publishable", fetch: platformFetch }),
				limits: LIMITS_HERE,
				runs: { token: RUN_TOKEN },
			});
			server = await serve(gateway);
			port = server.address().port;
			runServer = await serveRuns(gateway);
		} catch (error) {
			spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
			throw error;
		}
	};

	const stop = async () => {
		for (const open of [server, runServer]) {
			if (!open) continue;
			open.close();
			open.closeAllConnections();
		}
		if (gateway) await gateway.close();
		spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
	};

	return {
		container,
		superPassword,
		logins,
		RUN_TOKEN,
		MEMBERS,
		WRITERS,
		PRIVATE,
		FOLDERS,
		TEXTS,
		PASSES,
		owner,
		contributor,
		viewer,
		stranger,
		bMember,
		forged,
		put,
		remove,
		tokenOf,
		mayRead,
		passFor,
		platformFetch,
		connect,
		asAdmin,
		psql,
		listening,
		until,
		send,
		call,
		ask,
		describeOne,
		states,
		withGateway,
		start,
		stop,
		get storePort() {
			return storePort;
		},
		get gateway() {
			return gateway;
		},
		get server() {
			return server;
		},
		get runServer() {
			return runServer;
		},
		get port() {
			return port;
		},
		set port(value) {
			port = value;
		},
		get platformCalls() {
			return platformCalls;
		},
		set platformCalls(value) {
			platformCalls = value;
		},
		get writeCheckMissing() {
			return writeCheckMissing;
		},
		set writeCheckMissing(value) {
			writeCheckMissing = value;
		},
	};
}
