import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { POSTGRES_IMAGE, POSTGRES_LOCALE } from "../../../scripts/test-hosted-db.mjs";
import {
	companyDatabase,
	createDirectoryPublicReader,
	createHttpPublicReader,
	createTriggerWakeDispatcher,
	DataChangeNotifier,
	Gateway,
	parsePublicConfig,
	serve,
	serveRuns,
	TEST_SCHEMA_NAME,
} from "./gateway.mjs";

const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const storeFile = (name) => readFileSync(new URL(`../store/${name}`, import.meta.url), "utf8");

describe("parsePublicConfig and DataChangeNotifier", () => {
	it("parses [public] allowlist and rate_limit and fails closed on invalid syntax", () => {
		assert.deepEqual(
			parsePublicConfig(
				'format = "qorpera.database/v1"\nname = "Shop"\n\n[public]\nquestions = ["list-items", "get-item"]\nchanges = ["place-order"]\nrate_limit = 30\n',
			),
			{ questions: ["list-items", "get-item"], changes: ["place-order"], rateLimit: 30 },
		);
		assert.deepEqual(parsePublicConfig('[public]\nquestions = ["Bad_Name"]\n'), { questions: [], changes: [], rateLimit: 60 });
		assert.deepEqual(parsePublicConfig("[public]\nrate_limit = 0\n"), { questions: [], changes: [], rateLimit: 60 });
		assert.deepEqual(parsePublicConfig('[public]\nunknown = "x"\n'), { questions: [], changes: [], rateLimit: 60 });
	});

	it("coalesces burst notifications and rate-limits wakes per routine", async () => {
		const notifier = new DataChangeNotifier();
		const wakes = [];
		notifier.register({
			id: "r1",
			environmentId: "env-1",
			database: "shop",
			tables: ["orders"],
			minIntervalMs: 80,
			onWake: (ev) => {
				wakes.push(ev);
			},
		});
		notifier.notify("env-1", { schema: "shop", table: "catalog" });
		assert.equal(wakes.length, 0);
		notifier.notify("env-1", { schema: "shop", table: "orders" });
		assert.equal(wakes.length, 1);
		notifier.notify("env-1", { schema: "shop", table: "orders" });
		notifier.notify("env-1", { schema: "shop", table: "orders" });
		assert.equal(wakes.length, 1);
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(wakes.length, 2);
		assert.deepEqual(wakes[1].tables, ["orders"]);
		notifier.close();
	});

	it("routes notifications per environment without cross-talk and enforces body read timeout and unread-body connection close", async () => {
		const notifier = new DataChangeNotifier();
		const env1Wakes = [];
		const env2Wakes = [];
		notifier.register({ id: "a", environmentId: "env-1", database: "shop", minIntervalMs: 10, onWake: (ev) => env1Wakes.push(ev) });
		notifier.register({ id: "b", environmentId: "env-2", database: "shop", minIntervalMs: 10, onWake: (ev) => env2Wakes.push(ev) });
		notifier.notify("env-1", { schema: "shop", table: "orders" });
		assert.equal(env1Wakes.length, 1);
		assert.equal(env2Wakes.length, 0);
		notifier.unregister("a");
		notifier.notify("env-1", { schema: "shop", table: "orders" });
		assert.equal(env1Wakes.length, 1);

		const selfUnregWakes = [];
		const siblingWakes = [];
		notifier.register({
			id: "first",
			environmentId: "env-3",
			database: "shop",
			minIntervalMs: 50,
			onWake: (ev) => {
				selfUnregWakes.push(ev);
				notifier.unregister("second");
			},
		});
		notifier.register({
			id: "second",
			environmentId: "env-3",
			database: "shop",
			minIntervalMs: 50,
			onWake: (ev) => siblingWakes.push(ev),
		});
		notifier.notify("env-3", { schema: "shop", table: "orders" });
		assert.equal(selfUnregWakes.length, 1);
		assert.equal(siblingWakes.length, 0);
		notifier.notify("env-3", { schema: "shop", table: "orders" });
		assert.equal(selfUnregWakes.length, 1);
		await new Promise((r) => setTimeout(r, 70));
		assert.equal(selfUnregWakes.length, 2);
		notifier.close();

		const rateEnv = randomUUID();
		const rateGateway = new Gateway({
			store: { host: "127.0.0.1", port: 1, logins: { admin: "a", keeper: "k", watch: "w", folderKey: "0".repeat(64) } },
			platform: {},
			publicReader: async () => new Map([["data/shop/database.toml", '[public]\nquestions = ["q"]\nrate_limit = 2\n']]),
		});
		const askHot = (clientKey) =>
			rateGateway
				.publicQuery(rateEnv, { database: "shop", question: "q" }, clientKey)
				.then(() => 200, (error) => error.status);
		try {
			assert.equal(await askHot("hot"), 404);
			assert.equal(await askHot("hot"), 404);
			assert.equal(await askHot("hot"), 429);
			for (let i = 0; i < 3_500; i++) assert.equal(await askHot(`other-${i}`), 404);
			assert.equal(await askHot("hot"), 429);
			for (let i = 3_500; i < 7_000; i++) assert.equal(await askHot(`other-${i}`), 404);
			assert.equal(await askHot("hot"), 429);
		} finally {
			await rateGateway.close();
		}

		const fakeGateway = {
			async handle(_method, _path, _headers, read) {
				await read(1024);
				return { ok: true };
			},
		};
		const srv = await serve(fakeGateway, { host: "127.0.0.1", port: 0, bodyTimeoutMs: 120 });
		const srvPort = srv.address().port;
		try {
			const slowReply = await new Promise((resolve, reject) => {
				const socket = net.connect(srvPort, "127.0.0.1", () => {
					socket.write(
						"POST /v1/company-data-public/11111111-1111-4111-8111-111111111111/query HTTP/1.1\r\n" +
							"Host: 127.0.0.1\r\n" +
							"Content-Length: 100\r\n\r\n" +
							"{",
					);
				});
				let raw = "";
				socket.setEncoding("utf8");
				socket.on("data", (chunk) => {
					raw += chunk;
				});
				socket.on("close", () => resolve(raw));
				socket.on("error", reject);
			});
			assert.match(slowReply, /^HTTP\/1\.1 408 /);
			assert.match(slowReply.toLowerCase(), /\r\nconnection: close\r\n/);

			const oversizedReply = await new Promise((resolve, reject) => {
				const socket = net.connect(srvPort, "127.0.0.1", () => {
					socket.write(
						"POST /v1/company-data-public/11111111-1111-4111-8111-111111111111/query HTTP/1.1\r\n" +
							"Host: 127.0.0.1\r\n" +
							"Content-Length: 5000\r\n\r\n" +
							"x".repeat(50),
					);
				});
				let raw = "";
				socket.setEncoding("utf8");
				socket.on("data", (chunk) => {
					raw += chunk;
				});
				socket.on("close", () => resolve(raw));
				socket.on("error", reject);
			});
			assert.match(oversizedReply, /^HTTP\/1\.1 413 /);
			assert.match(oversizedReply.toLowerCase(), /\r\nconnection: close\r\n/);
		} finally {
			srv.close();
			srv.closeAllConnections?.();
		}
	});

	it("validates public readers, trigger wake dispatcher, distinct tokens, and HTTP door auth scoping without Postgres", async () => {
		const env = randomUUID();
		const readerCalls = [];
		const readerServer = http.createServer((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				readerCalls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
				if (req.headers.authorization !== "Bearer reader-secret") {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "unauthorized" }));
					return;
				}
				const parsed = JSON.parse(body);
				if (parsed.environmentId !== env) {
					res.writeHead(404, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "not found" }));
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						files: {
							"data/shop/database.toml": 'format = "qorpera.database/v1"\n[public]\nquestions = ["catalog"]\n',
							"data/shop/queries/catalog.sql": "select 1;\n",
							"data/shop/queries/extra.sql": "ignored",
						},
					}),
				);
			});
		});
		await new Promise((resolve) => readerServer.listen(0, "127.0.0.1", resolve));
		const readerPort = readerServer.address().port;

		const wakeEvents = [];
		const wakeServer = http.createServer((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				wakeEvents.push({ auth: req.headers.authorization, body: JSON.parse(body) });
				res.writeHead(204);
				res.end();
			});
		});
		await new Promise((resolve) => wakeServer.listen(0, "127.0.0.1", resolve));
		const wakePort = wakeServer.address().port;

		const dirRoot = mkdtempSync(join(tmpdir(), "qorpera-pub-dir-test-"));
		try {
			assert.throws(() => createHttpPublicReader({ url: "ftp://127.0.0.1/files" }), /http\(s\) URL/);
			assert.throws(() => createHttpPublicReader({ url: "http://user:pass@127.0.0.1/files" }), /without credentials/);
			assert.throws(() => createTriggerWakeDispatcher({ url: "file:///etc/passwd" }), /http\(s\) URL/);

			const httpReader = createHttpPublicReader({
				url: `http://127.0.0.1:${readerPort}/files`,
				token: "reader-secret",
				cacheMs: 5_000,
			});
			const first = await httpReader(env, ["data/shop/database.toml", "data/shop/queries/catalog.sql"]);
			assert.equal(first.get("data/shop/queries/catalog.sql"), "select 1;\n");
			assert.equal(first.has("data/shop/queries/extra.sql"), false);
			const cached = await httpReader(env, ["data/shop/database.toml"]);
			assert.ok(cached.get("data/shop/database.toml")?.includes("[public]"));
			assert.equal(readerCalls.length, 1);

			const missingEnv = await httpReader(randomUUID(), ["data/shop/database.toml"]);
			assert.equal(missingEnv.get("data/shop/database.toml"), null);

			const badAuthReader = createHttpPublicReader({
				url: `http://127.0.0.1:${readerPort}/files`,
				token: "wrong-token",
			});
			await assert.rejects(
				() => badAuthReader(env, ["data/shop/database.toml"]),
				(error) => error.status === 503,
			);

			mkdirSync(join(dirRoot, env, "data", "shop", "queries"), { recursive: true });
			writeFileSync(join(dirRoot, env, "data", "shop", "database.toml"), 'format = "qorpera.database/v1"\n');
			writeFileSync(join(dirRoot, env, "data", "shop", "queries", "ok.sql"), "select 1;\n");
			writeFileSync(join(dirRoot, "secret.txt"), "outside-secret\n");
			symlinkSync(join(dirRoot, "secret.txt"), join(dirRoot, env, "data", "shop", "queries", "link.sql"));

			const dirReader = createDirectoryPublicReader({ rootDir: dirRoot });
			const fromDir = await dirReader(env, [
				"data/shop/database.toml",
				"data/shop/queries/ok.sql",
				"data/shop/queries/link.sql",
				"../secret.txt",
				"data/shop/queries/missing.sql",
			]);
			assert.equal(fromDir.get("data/shop/database.toml"), 'format = "qorpera.database/v1"\n');
			assert.equal(fromDir.get("data/shop/queries/ok.sql"), "select 1;\n");
			assert.equal(fromDir.get("data/shop/queries/link.sql"), null);
			assert.equal(fromDir.get("../secret.txt"), null);
			assert.equal(fromDir.get("data/shop/queries/missing.sql"), null);

			const dispatch = createTriggerWakeDispatcher({
				url: `http://127.0.0.1:${wakePort}/wake`,
				token: "wake-secret",
			});
			await dispatch({ id: "t1", environmentId: env, database: "shop", tables: ["orders"] });
			assert.equal(wakeEvents.length, 1);
			assert.equal(wakeEvents[0].auth, "Bearer wake-secret");
			assert.equal(wakeEvents[0].body.id, "t1");

			const same = randomBytes(32).toString("base64url");
			const baseStore = { host: "127.0.0.1", port: 1, logins: { admin: "a", keeper: "k", watch: "w", folderKey: "0".repeat(64) } };
			assert.throws(
				() => new Gateway({ store: baseStore, platform: {}, admin: { token: same }, directLogin: { token: same } }),
				/distinct/,
			);
			assert.throws(
				() => new Gateway({ store: baseStore, platform: {}, admin: { token: same }, triggers: { token: same } }),
				/distinct/,
			);

			const adminTok = randomBytes(32).toString("base64url");
			const directTok = randomBytes(32).toString("base64url");
			const trigTok = randomBytes(32).toString("base64url");
			const scopedGw = new Gateway({
				store: baseStore,
				platform: {},
				admin: { token: adminTok },
				directLogin: { token: directTok },
				triggers: { token: trigTok, onWake: () => undefined },
			});
			const scopedSrv = await serve(scopedGw, { host: "127.0.0.1", port: 0 });
			const scopedPort = scopedSrv.address().port;
			const reqScoped = (method, path, body, auth = null) =>
				new Promise((resolve, reject) => {
					const encoded = body === null ? null : JSON.stringify(body);
					const headers = {
						...(auth ? { authorization: `Bearer ${auth}` } : {}),
						...(encoded !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } : {}),
					};
					const req = http.request({ host: "127.0.0.1", port: scopedPort, method, path, headers }, (res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
					});
					req.on("error", reject);
					if (encoded !== null) req.end(encoded);
					else req.end();
				});
			try {
				assert.equal((await reqScoped("POST", `/v1/admin/company-data/${env}/direct-login`, { database: "shop" })).status, 401);
				assert.equal((await reqScoped("POST", `/v1/admin/company-data/${env}/direct-login`, { database: "shop" }, trigTok)).status, 401);
				assert.equal((await reqScoped("POST", `/v1/admin/company-data/${env}/drop-database`, { database: "shop" }, directTok)).status, 401);
				assert.equal((await reqScoped("GET", `/v1/admin/company-data/${env}/triggers`, null, directTok)).status, 401);
				assert.equal((await reqScoped("POST", `/v1/admin/company-data/${env}/direct-login`, { database: "shop", bad: 1 }, directTok)).status, 400);
				assert.equal((await reqScoped("GET", `/v1/admin/company-data/${env}/direct-login`, null, directTok)).status, 405);
				assert.equal((await reqScoped("GET", `/v1/admin/company-data/${env}/triggers`, null, trigTok)).status, 200);
				assert.equal((await reqScoped("GET", `/v1/admin/company-data/${env}/triggers`, null, adminTok)).status, 200);
				assert.equal((await reqScoped("POST", `/v1/admin/company-data/${env}/triggers`, { id: "t1", database: "shop", bad: 1 }, trigTok)).status, 400);

				const memberJwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: randomUUID() })).toString("base64url")}.sig`;
				assert.equal(TEST_SCHEMA_NAME.test("qorpera_test_0123456789abcdef"), true);
				assert.equal(TEST_SCHEMA_NAME.test("shop"), false);
				assert.equal(TEST_SCHEMA_NAME.test("qorpera_test_0123456789abcdeg"), false);
				assert.equal(
					(await reqScoped("POST", `/v1/company-data/${env}/query?schema=shop`, { database: "shop", question: "q" }, memberJwt)).status,
					400,
				);
				assert.equal(
					(await reqScoped("POST", `/v1/company-data/${env}/query?schema=public`, { database: "shop", question: "q" }, memberJwt)).status,
					400,
				);
				assert.equal(
					(await reqScoped("POST", `/v1/company-data/${env}/query?schema=`, { database: "shop", question: "q" }, memberJwt)).status,
					400,
				);
				assert.equal(
					(
						await reqScoped(
							"POST",
							`/v1/company-data/${env}/query?schema=qorpera_test_0123456789abcdef`,
							{ database: "shop", question: "q", schema: "qorpera_test_fedcba9876543210" },
							memberJwt,
						)
					).status,
					400,
				);
				assert.equal(
					(
						await reqScoped(
							"POST",
							`/v1/company-data/${env}/watch?schema=qorpera_test_0123456789abcdef`,
							{ watches: [{ database: "shop", question: "q" }] },
							memberJwt,
						)
					).status,
					400,
				);
			} finally {
				scopedSrv.close();
				scopedSrv.closeAllConnections?.();
				await scopedGw.close();
			}
		} finally {
			readerServer.close();
			readerServer.closeAllConnections?.();
			wakeServer.close();
			wakeServer.closeAllConnections?.();
			rmSync(dirRoot, { recursive: true, force: true });
		}
	});
});

describe("external doors, direct logins, hooks, and live triggers against PostgreSQL 17", { skip: !dockerUsable }, () => {
	let container = "";
	let port = 0;
	let gwServer = null;
	let gwPort = 0;
	let gateway = null;
	const logins = {
		admin: randomBytes(16).toString("hex"),
		keeper: randomBytes(16).toString("hex"),
		watch: randomBytes(16).toString("hex"),
		folderKey: randomBytes(32).toString("hex"),
	};
	const hookToken = randomBytes(32).toString("base64url");
	const envId = randomUUID();
	const userId = randomUUID();
	const token = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64url")}.sig`;
	const files = new Map();

	const platform = {
		async memberReads(_tok, _env, paths) {
			return paths.map((p) => (files.has(p) ? { sha256: sha256(files.get(p)), bytes: Buffer.byteLength(files.get(p)) } : null));
		},
		async memberListPage(_tok, _env, parent, limit) {
			const prefix = `${parent}/`;
			const list = [...files.entries()]
				.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
				.map(([p, text]) => ({ name: p.slice(prefix.length), sha256: sha256(text), bytes: Buffer.byteLength(text) }))
				.sort((a, b) => (a.name < b.name ? -1 : 1));
			return { files: list.slice(0, limit), more: list.length > limit };
		},
		async memberList(tok, env, parent, limit) {
			return (await this.memberListPage(tok, env, parent, limit)).files;
		},
		async memberMayWrite() {
			return true;
		},
		async memberFolders() {
			return ["shop"];
		},
	};

	const publicReader = async (_env, paths) => new Map(paths.map((p) => [p, files.get(p) ?? null]));
	const textsOf = () => Object.fromEntries([...files.values()].map((t) => [sha256(t), t]));

	const post = (path, body, headers = {}) =>
		new Promise((resolve, reject) => {
			const encoded = JSON.stringify(body);
			const req = http.request(
				{
					host: "127.0.0.1",
					port: gwPort,
					method: "POST",
					path,
					headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), ...headers },
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
				},
			);
			req.on("error", reject);
			req.end(encoded);
		});

	const asSuperuser = async (database, sql, values = []) => {
		const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "test-password", database });
		await client.connect();
		try {
			return (await client.query(sql, values)).rows;
		} finally {
			await client.end();
		}
	};

	before(async () => {
		container = `qext-${process.pid}-${randomBytes(3).toString("hex")}`;
		const started = spawnSync(
			"docker",
			["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=test-password", ...POSTGRES_LOCALE, "-p", "127.0.0.1::5432", POSTGRES_IMAGE],
			{ encoding: "utf8" },
		);
		if (started.status !== 0) throw new Error(started.stderr);
		port = Number(spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split(":").at(-1));
		for (let i = 0; i < 100; i++) {
			if (spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const clusterSql = storeFile("cluster.sql")
			.replaceAll(":'admin_password'", `'${logins.admin}'`)
			.replaceAll(":'keeper_password'", `'${logins.keeper}'`)
			.replaceAll(":'watch_password'", `'${logins.watch}'`);
		assert.equal(
			spawnSync("docker", ["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
				input: clusterSql,
				encoding: "utf8",
			}).status,
			0,
		);
		assert.equal(
			spawnSync(
				"docker",
				["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "qorpera_company_template", "-v", "ON_ERROR_STOP=1"],
				{ input: storeFile("template.sql"), encoding: "utf8" },
			).status,
			0,
		);

		gateway = new Gateway({
			store: { host: "127.0.0.1", port, logins },
			platform,
			hooks: { token: hookToken },
			publicReader,
		});
		gwServer = await serve(gateway, { host: "127.0.0.1", port: 0 });
		gwPort = gwServer.address().port;

		files.set(
			"data/shop/database.toml",
			'format = "qorpera.database/v1"\nname = "Shop"\n\n[public]\nquestions = ["catalog", "viewer-leak"]\nchanges = ["signup"]\nrate_limit = 3\n',
		);
		files.set(
			"data/shop/tables/001-init.sql",
			"create table items (id bigserial primary key, title text not null); insert into items (title) values ('Coffee'), ('Tea');\n" +
				"create table leads (id bigserial primary key, email text not null, source text not null);",
		);
		files.set("data/shop/queries/catalog.sql", "-- Public catalog.\nselect id, title from items order by id;\n");
		files.set("data/shop/queries/private-leads.sql", "-- Internal leads.\nselect id, email from leads order by id;\n");
		files.set("data/shop/queries/viewer-leak.sql", "-- Bad public query.\nselect :viewer as who;\n");
		files.set("data/shop/actions/signup.sql", "-- Public signup.\ninsert into leads (email, source) values (:email, 'web') returning id, email;\n");
		files.set("data/shop/actions/ingest-stripe.sql", "-- Webhook ingest.\ninsert into leads (email, source) values (:email, :source) returning id;\n");

		const applied = await post(`/v1/company-data/${envId}/apply`, { database: "shop", texts: textsOf() }, { authorization: `Bearer ${token}` });
		assert.equal(applied.status, 200, JSON.stringify(applied.value));
	});

	after(async () => {
		gwServer?.close();
		gwServer?.closeAllConnections?.();
		await gateway?.close();
		if (container) spawnSync("docker", ["rm", "-f", container]);
	});

	it("serves [public] allowlisted questions and actions, rejects non-public and :viewer queries, enforces rate limits, and records public actor", async () => {
		const q = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "203.0.113.10" });
		assert.equal(q.status, 200, JSON.stringify(q.value));
		assert.deepEqual(q.value.rows, [[1, "Coffee"], [2, "Tea"]]);

		const deniedPrivate = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "private-leads" }, { "x-forwarded-for": "203.0.113.11" });
		assert.equal(deniedPrivate.status, 404);

		const deniedViewer = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "viewer-leak" }, { "x-forwarded-for": "203.0.113.12" });
		assert.equal(deniedViewer.status, 400);

		const act = await post(
			`/v1/company-data-public/${envId}/change`,
			{ database: "shop", change: "signup", params: { email: "ada@example.com" } },
			{ "x-forwarded-for": "203.0.113.10" },
		);
		assert.equal(act.status, 200, JSON.stringify(act.value));
		assert.equal(act.value.changed, 1);

		const third = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "203.0.113.10" });
		assert.equal(third.status, 200);
		const limited = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "203.0.113.10" });
		assert.equal(limited.status, 429);

		const logRows = await asSuperuser(companyDatabase(envId), "select by_kind, by_id, via from qorpera_data.change_log where by_kind = 'public'");
		assert.deepEqual(logRows, [{ by_kind: "public", by_id: null, via: "signup" }]);
	});

	it("runs webhook-to-action changes with hook actor and fires live data-change routine triggers", async () => {
		const wakes = [];
		const stopTrigger = await gateway.registerDataTrigger({
			id: "routine-leads",
			environmentId: envId,
			database: "shop",
			tables: ["leads"],
			minIntervalMs: 50,
			onWake: (ev) => wakes.push(ev),
		});
		try {
			const unauth = await post(`/v1/hook-data/${envId}/change`, { database: "shop", change: "ingest-stripe", params: { email: "x", source: "stripe" } });
			assert.equal(unauth.status, 401);

			const ok = await post(
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-stripe-1", params: { email: "grace@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			assert.equal(ok.status, 200, JSON.stringify(ok.value));
			assert.equal(ok.value.changed, 1);

			for (let i = 0; i < 30 && wakes.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
			assert.equal(wakes.length, 1);
			assert.deepEqual(wakes[0].tables, ["leads"]);

			const hookLogs = await asSuperuser(companyDatabase(envId), "select by_kind, by_id, via from qorpera_data.change_log where by_kind = 'hook'");
			assert.deepEqual(hookLogs, [{ by_kind: "hook", by_id: "hook-stripe-1", via: "ingest-stripe" }]);
		} finally {
			stopTrigger();
		}
	});

	it("provisions and revokes scoped direct Postgres logins for share_app servers", async () => {
		const creds = await gateway.provisionDirectLogin(envId, "shop", { access: "read-write", connectionLimit: 2 });
		assert.match(creds.user, /^c_[0-9a-f]{32}_s[0-9]+$/);
		const direct = new pg.Client({ connectionString: creds.connectionString });
		await direct.connect();
		try {
			const inserted = await direct.query("insert into items (title) values ('Matcha') returning title");
			assert.equal(inserted.rows[0].title, "Matcha");
			await assert.rejects(() => direct.query("select * from qorpera_data.texts"), /permission denied/);
		} finally {
			await direct.end();
		}

		const roCreds = await gateway.provisionDirectLogin(envId, "shop", { access: "read-only", connectionLimit: 2 });
		const roClient = new pg.Client({ connectionString: roCreds.connectionString });
		await roClient.connect();
		try {
			const count = await roClient.query("select count(*)::int as n from items");
			assert.equal(count.rows[0].n, 3);
			await assert.rejects(() => roClient.query("insert into items (title) values ('Blocked')"), /permission denied/);
		} finally {
			await roClient.end();
		}

		const revoked = await gateway.revokeDirectLogin(envId, "shop");
		assert.equal(revoked.revoked, true);
		const afterRevoke = new pg.Client({ connectionString: roCreds.connectionString });
		await assert.rejects(() => afterRevoke.connect());
	});

	it("handles trigger re-registration, auto-reconnects LISTEN after PG backend disconnect, serializes concurrent direct login provisioning, resists X-Forwarded-For spoofing, and fails closed on malformed public TOML", async () => {
		assert.deepEqual(parsePublicConfig('[public]\nquestions = ["a" "b"]\n'), { questions: [], changes: [], rateLimit: 60 });

		const r1 = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "1.1.1.1, 198.51.100.7" });
		const r2 = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "2.2.2.2, 198.51.100.7" });
		const r3 = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "3.3.3.3, 198.51.100.7" });
		const r4 = await post(`/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" }, { "x-forwarded-for": "4.4.4.4, 198.51.100.7" });
		assert.deepEqual([r1.status, r2.status, r3.status, r4.status], [200, 200, 200, 429]);

		const concurrentCreds = await Promise.all([
			gateway.provisionDirectLogin(envId, "shop", { access: "read-write", connectionLimit: 2 }),
			gateway.provisionDirectLogin(envId, "shop", { access: "read-write", connectionLimit: 2 }),
			gateway.provisionDirectLogin(envId, "shop", { access: "read-write", connectionLimit: 2 }),
		]);
		assert.equal(concurrentCreds.length, 3);
		assert.equal((await gateway.revokeDirectLogin(envId, "shop")).revoked, true);

		const wakesOld = [];
		const wakesNew = [];
		await gateway.registerDataTrigger({
			id: "routine-rereg",
			environmentId: envId,
			database: "shop",
			tables: ["leads"],
			minIntervalMs: 30,
			onWake: (ev) => wakesOld.push(ev),
		});
		const stopNew = await gateway.registerDataTrigger({
			id: "routine-rereg",
			environmentId: envId,
			database: "shop",
			tables: ["leads"],
			minIntervalMs: 30,
			onWake: (ev) => wakesNew.push(ev),
		});
		try {
			await post(
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-rereg-1", params: { email: "r1@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			for (let i = 0; i < 40 && wakesNew.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
			assert.equal(wakesOld.length, 0);
			assert.equal(wakesNew.length, 1);

			const terminated = await asSuperuser(
				"postgres",
				"select pid, pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway listen'",
				[companyDatabase(envId)],
			);
			const oldPids = terminated.map((row) => row.pid);
			assert.ok(oldPids.length >= 1, "expected an active LISTEN backend to terminate");
			let reconnected = false;
			for (let i = 0; i < 100; i++) {
				const active = await asSuperuser(
					"postgres",
					"select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway listen' and not (pid = any($2::int[])) and state = 'idle' and query = 'listen qorpera_data'",
					[companyDatabase(envId), oldPids],
				);
				if (active[0].n > 0) {
					reconnected = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.equal(reconnected, true, "expected LISTEN backend to reconnect with a new pid");
			await post(
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-reconnect-1", params: { email: "r2@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			for (let i = 0; i < 80 && wakesNew.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
			assert.ok(wakesNew.length >= 2, `expected trigger wake after LISTEN reconnect, got ${wakesNew.length}`);

			const wakesBeforeEvict = wakesNew.length;
			await gateway.evictDatabase(companyDatabase(envId), "shop");
			await post(
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-after-evict", params: { email: "r3@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			await new Promise((r) => setTimeout(r, 80));
			assert.equal(wakesNew.length, wakesBeforeEvict);
		} finally {
			stopNew();
		}

		const companyWakes = [];
		const stopCompanyTrigger = await gateway.registerDataTrigger({
			id: "routine-company-evict",
			environmentId: envId,
			database: "shop",
			tables: ["leads"],
			minIntervalMs: 30,
			onWake: (ev) => companyWakes.push(ev),
		});
		try {
			const baseline = await post(
				`/v1/company-data/${envId}/query`,
				{ database: "shop", question: "catalog", texts: textsOf() },
				{ authorization: `Bearer ${token}` },
			);
			assert.equal(baseline.status, 200, JSON.stringify(baseline.value));
			const startedAt = performance.now();
			const watchPromise = post(
				`/v1/company-data/${envId}/watch`,
				{ watches: [{ database: "shop", question: "catalog", etag: baseline.value.etag }], texts: textsOf() },
				{ authorization: `Bearer ${token}` },
			);
			await new Promise((r) => setTimeout(r, 100));
			await gateway.evictCompany(companyDatabase(envId));
			const watchRes = await watchPromise;
			assert.equal(watchRes.status, 200, JSON.stringify(watchRes.value));
			assert.ok(performance.now() - startedAt < 2_000, "watch should wake well before 20 s on evictCompany");

			await post(
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-after-company-evict", params: { email: "r4@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			await new Promise((r) => setTimeout(r, 80));
			assert.equal(companyWakes.length, 0);
		} finally {
			stopCompanyTrigger();
		}
	});

	it("exposes direct-login and data-trigger HTTP admin doors with scoped auth and real HTTP wake delivery", async () => {
		const adminToken = randomBytes(32).toString("base64url");
		const directToken = randomBytes(32).toString("base64url");
		const triggerToken = randomBytes(32).toString("base64url");
		const wakeToken = randomBytes(24).toString("base64url");
		const receivedWakes = [];
		const wakeSrv = http.createServer((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				receivedWakes.push({ auth: req.headers.authorization, body: JSON.parse(body) });
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
			});
		});
		await new Promise((resolve) => wakeSrv.listen(0, "127.0.0.1", resolve));
		const wakeUrl = `http://127.0.0.1:${wakeSrv.address().port}/wake`;

		const dirRoot = mkdtempSync(join(tmpdir(), "qorpera-ext-dir-"));
		mkdirSync(join(dirRoot, envId, "data", "shop", "queries"), { recursive: true });
		mkdirSync(join(dirRoot, envId, "data", "shop", "actions"), { recursive: true });
		writeFileSync(join(dirRoot, envId, "data", "shop", "database.toml"), files.get("data/shop/database.toml"));
		writeFileSync(join(dirRoot, envId, "data", "shop", "queries", "catalog.sql"), files.get("data/shop/queries/catalog.sql"));
		writeFileSync(join(dirRoot, envId, "data", "shop", "actions", "ingest-stripe.sql"), files.get("data/shop/actions/ingest-stripe.sql"));

		const dirReader = createDirectoryPublicReader({ rootDir: dirRoot });
		const extGw = new Gateway({
			store: { host: "127.0.0.1", port, logins },
			platform,
			admin: { token: adminToken },
			directLogin: { token: directToken, host: "127.0.0.1", port },
			hooks: { token: hookToken, reader: dirReader },
			triggers: { token: triggerToken, wakeUrl, wakeToken },
		});
		const extSrv = await serve(extGw, { host: "127.0.0.1", port: 0 });
		const extPort = extSrv.address().port;
		const request = (method, path, body = null, headers = {}) =>
			new Promise((resolve, reject) => {
				const encoded = body === null ? null : JSON.stringify(body);
				const req = http.request(
					{
						host: "127.0.0.1",
						port: extPort,
						method,
						path,
						headers: {
							...(encoded !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } : {}),
							...headers,
						},
					},
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
					},
				);
				req.on("error", reject);
				if (encoded !== null) req.end(encoded);
				else req.end();
			});
		try {
			assert.equal(
				(await request("POST", `/v1/company-data-public/${envId}/query`, { database: "shop", question: "catalog" })).status,
				404,
			);
			assert.equal(
				(
					await request(
						"POST",
						`/v1/hook-data/${envId}/change`,
						{ database: "shop", change: "ingest-stripe", hookId: "hook-dir-only", params: { email: "dir@example.com", source: "dir" } },
						{ authorization: `Bearer ${hookToken}` },
					)
				).status,
				200,
			);

			assert.equal((await request("POST", `/v1/admin/company-data/${envId}/direct-login`, { database: "shop" })).status, 401);
			assert.equal(
				(
					await request(
						"POST",
						`/v1/admin/company-data/${envId}/direct-login`,
						{ database: "shop" },
						{ authorization: `Bearer ${triggerToken}` },
					)
				).status,
				401,
			);
			const minted = await request(
				"POST",
				`/v1/admin/company-data/${envId}/direct-login`,
				{ database: "shop", access: "read-write", connectionLimit: 2 },
				{ authorization: `Bearer ${directToken}` },
			);
			assert.equal(minted.status, 200, JSON.stringify(minted.value));
			assert.match(minted.value.user, /^c_[0-9a-f]{32}_s[0-9]+$/);
			const directClient = new pg.Client({ connectionString: minted.value.connectionString });
			await directClient.connect();
			try {
				const ins = await directClient.query("insert into items (title) values ('Oolong') returning title");
				assert.equal(ins.rows[0].title, "Oolong");
				await assert.rejects(() => directClient.query("select * from qorpera_data.texts"), /permission denied/);
			} finally {
				await directClient.end();
			}

			const downgraded = await request(
				"POST",
				`/v1/admin/company-data/${envId}/direct-login`,
				{ database: "shop", access: "read-only", connectionLimit: 2 },
				{ authorization: `Bearer ${adminToken}` },
			);
			assert.equal(downgraded.status, 200, JSON.stringify(downgraded.value));
			const roClient = new pg.Client({ connectionString: downgraded.value.connectionString });
			await roClient.connect();
			try {
				const sel = await roClient.query("select count(*)::int as n from items");
				assert.ok(sel.rows[0].n >= 3);
				await assert.rejects(() => roClient.query("insert into items (title) values ('No')"), /permission denied/);
			} finally {
				await roClient.end();
			}

			const revoked = await request("DELETE", `/v1/admin/company-data/${envId}/direct-login/shop`, null, {
				authorization: `Bearer ${directToken}`,
			});
			assert.equal(revoked.status, 200, JSON.stringify(revoked.value));
			assert.equal(revoked.value.revoked, true);
			const postRevokeClient = new pg.Client({ connectionString: downgraded.value.connectionString });
			await assert.rejects(() => postRevokeClient.connect());
			const revokedAgain = await request("DELETE", `/v1/admin/company-data/${envId}/direct-login?database=shop`, null, {
				authorization: `Bearer ${directToken}`,
			});
			assert.equal(revokedAgain.status, 200);
			assert.equal(revokedAgain.value.revoked, false);

			assert.equal((await request("GET", `/v1/admin/company-data/${envId}/triggers`)).status, 401);
			assert.equal(
				(await request("GET", `/v1/admin/company-data/${envId}/triggers`, null, { authorization: `Bearer ${directToken}` })).status,
				401,
			);
			const reg = await request(
				"POST",
				`/v1/admin/company-data/${envId}/triggers`,
				{ id: "http-trig-1", database: "shop", tables: ["leads"], minIntervalMs: 30, metadata: { routineId: "rt-leads" } },
				{ authorization: `Bearer ${triggerToken}` },
			);
			assert.equal(reg.status, 200, JSON.stringify(reg.value));
			assert.equal(reg.value.id, "http-trig-1");

			const listed = await request("GET", `/v1/admin/company-data/${envId}/triggers?database=shop`, null, {
				authorization: `Bearer ${adminToken}`,
			});
			assert.equal(listed.status, 200);
			assert.equal(listed.value.triggers.length, 1);
			assert.equal(listed.value.triggers[0].id, "http-trig-1");

			const otherEnv = randomUUID();
			const crossConflict = await request(
				"POST",
				`/v1/admin/company-data/${otherEnv}/triggers`,
				{ id: "http-trig-1", database: "shop" },
				{ authorization: `Bearer ${adminToken}` },
			);
			assert.equal(crossConflict.status, 409);

			const crossDel = await request("DELETE", `/v1/admin/company-data/${otherEnv}/triggers/http-trig-1`, null, {
				authorization: `Bearer ${adminToken}`,
			});
			assert.equal(crossDel.status, 200);
			assert.equal(crossDel.value.unregistered, false);

			const hookRes = await request(
				"POST",
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-http-wake", params: { email: "wake@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			assert.equal(hookRes.status, 200, JSON.stringify(hookRes.value));
			for (let i = 0; i < 40 && receivedWakes.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
			assert.equal(receivedWakes.length, 1);
			assert.equal(receivedWakes[0].auth, `Bearer ${wakeToken}`);
			assert.equal(receivedWakes[0].body.id, "http-trig-1");
			assert.equal(receivedWakes[0].body.environmentId, envId);
			assert.equal(receivedWakes[0].body.database, "shop");
			assert.deepEqual(receivedWakes[0].body.tables, ["leads"]);
			assert.deepEqual(receivedWakes[0].body.metadata, { routineId: "rt-leads" });

			const unreg = await request("DELETE", `/v1/admin/company-data/${envId}/triggers/http-trig-1`, null, {
				authorization: `Bearer ${triggerToken}`,
			});
			assert.equal(unreg.status, 200);
			assert.equal(unreg.value.unregistered, true);
			const afterList = await request("GET", `/v1/admin/company-data/${envId}/triggers`, null, {
				authorization: `Bearer ${triggerToken}`,
			});
			assert.deepEqual(afterList.value.triggers, []);
			await request(
				"POST",
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-after-unreg", params: { email: "quiet@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			await new Promise((r) => setTimeout(r, 80));
			assert.equal(receivedWakes.length, 1);
		} finally {
			extSrv.close();
			extSrv.closeAllConnections?.();
			await extGw.close();
			wakeSrv.close();
			wakeSrv.closeAllConnections?.();
			rmSync(dirRoot, { recursive: true, force: true });
		}
	});

	it("returns rich DDL inspection metadata in describe and runDescribe with 64 KiB cap enforcement", async () => {
		const ddlEnv = randomUUID();
		const runToken = randomBytes(32).toString("base64url");
		const ddlFiles = new Map([
			["data/commerce/database.toml", 'format = "qorpera.database/v1"\nname = "Commerce"\n'],
			[
				"data/commerce/tables/001-schema.sql",
				`create type order_status as enum ('draft', 'paid', 'cancelled');
				create table customers (
					id bigserial primary key,
					email text not null unique,
					phone text,
					credit_limit numeric(10,2) not null default 100.00 check (credit_limit >= 0)
				);
				create table orders (
					id bigserial primary key,
					customer_id bigint not null references customers(id) on delete cascade,
					code text not null,
					status order_status not null default 'draft',
					total numeric(10,2) not null check (total >= 0),
					tags text[] not null default '{}',
					note text
				);
				create index orders_paid_customer_idx on orders (customer_id) where status = 'paid';
				create index orders_tags_gin_idx on orders using gin (tags);
				create unique index orders_code_lower_idx on orders (lower(code));
				create view paid_orders as select o.id, o.code, c.email, o.total from orders o join customers c on c.id = o.customer_id where o.status = 'paid';
				insert into customers (email, phone) values ('ada@example.com', null);
				insert into orders (customer_id, code, status, total, tags) values (1, 'ORD-1', 'paid', 49.50, array['vip', 'eu']);`,
			],
		]);
		const ddlTexts = Object.fromEntries([...ddlFiles.values()].map((t) => [sha256(t), t]));
		const passMap = new Map();
		const ddlPlatform = {
			async memberReads(_tok, _env, paths) {
				return paths.map((p) => (ddlFiles.has(p) ? { sha256: sha256(ddlFiles.get(p)), bytes: Buffer.byteLength(ddlFiles.get(p)) } : null));
			},
			async memberListPage(_tok, _env, parent, limit) {
				const prefix = `${parent}/`;
				const list = [...ddlFiles.entries()]
					.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
					.map(([p, text]) => ({ name: p.slice(prefix.length), sha256: sha256(text), bytes: Buffer.byteLength(text) }))
					.sort((a, b) => (a.name < b.name ? -1 : 1));
				return { files: list.slice(0, limit), more: list.length > limit };
			},
			async memberList(tok, env, parent, limit) {
				return (await this.memberListPage(tok, env, parent, limit)).files;
			},
			async memberMayWrite() {
				return true;
			},
			async memberFolders() {
				return ["commerce"];
			},
			async redeemPass(pass) {
				const kept = passMap.get(pass) ?? null;
				passMap.delete(pass);
				return kept;
			},
		};
		const ddlGw = new Gateway({ store: { host: "127.0.0.1", port, logins }, platform: ddlPlatform, runs: { token: runToken } });
		const ddlSrv = await serve(ddlGw, { host: "127.0.0.1", port: 0 });
		const ddlRunSrv = await serveRuns(ddlGw, { host: "127.0.0.1", port: 0 });
		const callPort = (targetPort, path, body, headers = {}) =>
			new Promise((resolve, reject) => {
				const encoded = JSON.stringify(body);
				const req = http.request(
					{
						host: "127.0.0.1",
						port: targetPort,
						method: "POST",
						path,
						headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), ...headers },
					},
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
					},
				);
				req.on("error", reject);
				req.end(encoded);
			});
		try {
			const applied = await callPort(
				ddlSrv.address().port,
				`/v1/company-data/${ddlEnv}/apply`,
				{ database: "commerce", texts: ddlTexts },
				{ authorization: `Bearer ${token}` },
			);
			assert.equal(applied.status, 200, JSON.stringify(applied.value));
			assert.equal(applied.value.applied, true);

			const described = await callPort(
				ddlSrv.address().port,
				`/v1/company-data/${ddlEnv}/describe`,
				{ database: "commerce", texts: ddlTexts },
				{ authorization: `Bearer ${token}` },
			);
			assert.equal(described.status, 200, JSON.stringify(described.value));
			const [db] = described.value.databases;
			assert.deepEqual(db.enums, [{ name: "order_status", labels: ["draft", "paid", "cancelled"] }]);
			assert.ok(db.extensions.some((ext) => ext.name === "pgcrypto"));
			assert.ok(db.extensions.some((ext) => ext.name === "pg_trgm"));

			const customers = db.tables.find((t) => t.name === "customers");
			assert.equal(customers.kind, "table");
			assert.deepEqual(customers.key, ["id"]);
			assert.equal(customers.rows, 1);
			const phoneCol = customers.columns.find((c) => c.name === "phone");
			assert.equal(phoneCol.nullable, true);
			assert.equal(phoneCol.default, null);
			const creditCol = customers.columns.find((c) => c.name === "credit_limit");
			assert.equal(creditCol.nullable, false);
			assert.match(creditCol.default, /100\.00/);
			assert.ok(customers.constraints.some((c) => c.type === "primary_key" && c.columns.join(",") === "id"));
			assert.ok(customers.constraints.some((c) => c.type === "unique" && c.columns.join(",") === "email"));
			assert.ok(customers.constraints.some((c) => c.type === "check" && c.definition.includes("credit_limit")));

			const orders = db.tables.find((t) => t.name === "orders");
			const fk = orders.constraints.find((c) => c.type === "foreign_key");
			assert.ok(fk);
			assert.deepEqual(fk.columns, ["customer_id"]);
			assert.deepEqual(fk.references, { table: "customers", columns: ["id"] });
			assert.equal(fk.onDelete, "cascade");
			const statusCol = orders.columns.find((c) => c.name === "status");
			assert.equal(statusCol.nullable, false);
			assert.match(statusCol.default, /draft/);
			const partialIdx = orders.indexes.find((i) => i.name === "orders_paid_customer_idx");
			assert.ok(partialIdx);
			assert.equal(partialIdx.method, "btree");
			assert.equal(partialIdx.unique, false);
			assert.deepEqual(partialIdx.columns, ["customer_id"]);
			assert.match(partialIdx.predicate, /paid/);
			const ginIdx = orders.indexes.find((i) => i.name === "orders_tags_gin_idx");
			assert.ok(ginIdx);
			assert.equal(ginIdx.method, "gin");
			assert.deepEqual(ginIdx.columns, ["tags"]);
			const exprIdx = orders.indexes.find((i) => i.name === "orders_code_lower_idx");
			assert.ok(exprIdx);
			assert.equal(exprIdx.unique, true);
			assert.match(exprIdx.columns[0], /lower\(code\)/);

			const paidView = db.tables.find((t) => t.name === "paid_orders");
			assert.equal(paidView.kind, "view");
			assert.equal(paidView.rows, 1);
			assert.match(paidView.viewDefinition, /SELECT/i);
			assert.equal(paidView.constraints, undefined);

			const pass = randomBytes(32).toString("base64url");
			passMap.set(pass, {
				environmentId: ddlEnv,
				machineId: null,
				requesterUserId: userId,
				agentId: randomUUID(),
				database: "commerce",
				files: new Map([...ddlFiles.entries()].map(([p, text]) => [p, { sha256: sha256(text), bytes: Buffer.byteLength(text) }])),
				allow: null,
			});
			const runDescribed = await callPort(
				ddlRunSrv.address().port,
				"/v1/run-data/describe",
				{ database: "commerce", pass, texts: ddlTexts },
				{ authorization: `Bearer ${runToken}` },
			);
			assert.equal(runDescribed.status, 200, JSON.stringify(runDescribed.value));
			assert.deepEqual(runDescribed.value.databases[0].enums, db.enums);
			assert.equal(runDescribed.value.databases[0].tables.find((t) => t.name === "paid_orders").viewDefinition, paidView.viewDefinition);

			const locker = new pg.Client({
				host: "127.0.0.1",
				port,
				database: companyDatabase(ddlEnv),
				user: "qorpera_data_admin",
				password: logins.admin,
			});
			await locker.connect();
			try {
				await locker.query("begin");
				await locker.query("lock table commerce.orders in access exclusive mode");
				const lockedDesc = await callPort(
					ddlSrv.address().port,
					`/v1/company-data/${ddlEnv}/describe`,
					{ database: "commerce", texts: ddlTexts },
					{ authorization: `Bearer ${token}` },
				);
				assert.equal(lockedDesc.status, 200, JSON.stringify(lockedDesc.value));
				const lockedCustomers = lockedDesc.value.databases[0].tables.find((t) => t.name === "customers");
				assert.ok(lockedCustomers.constraints.some((c) => c.type === "unique"));
			} finally {
				await locker.query("rollback").catch(() => undefined);
				await locker.end().catch(() => undefined);
			}

			const bigViewsSqlA = Array.from(
				{ length: 12 },
				(_, i) => `create view v_pad_${i} as select '${"x".repeat(3_500)}'::text as pad, id from customers;`,
			).join("\n");
			const bigViewsSqlB = Array.from(
				{ length: 12 },
				(_, i) => `create view v_pad_${i + 12} as select '${"x".repeat(3_500)}'::text as pad, id from customers;`,
			).join("\n");
			ddlFiles.set("data/commerce/tables/002-big-views-a.sql", bigViewsSqlA);
			ddlFiles.set("data/commerce/tables/003-big-views-b.sql", bigViewsSqlB);
			const nextTexts = Object.fromEntries([...ddlFiles.values()].map((t) => [sha256(t), t]));
			const appliedBig = await callPort(
				ddlSrv.address().port,
				`/v1/company-data/${ddlEnv}/apply`,
				{ database: "commerce", texts: nextTexts },
				{ authorization: `Bearer ${token}` },
			);
			assert.equal(appliedBig.status, 200, JSON.stringify(appliedBig.value));
			assert.equal(appliedBig.value.applied, true, JSON.stringify(appliedBig.value));
			const boundedDesc = await callPort(
				ddlSrv.address().port,
				`/v1/company-data/${ddlEnv}/describe`,
				{ database: "commerce", texts: nextTexts },
				{ authorization: `Bearer ${token}` },
			);
			assert.equal(boundedDesc.status, 200);
			assert.equal(boundedDesc.value.databases[0].ddlTruncated, true);
			assert.ok(Buffer.byteLength(JSON.stringify(boundedDesc.value), "utf8") < 100 * 1024);
		} finally {
			ddlSrv.close();
			ddlSrv.closeAllConnections?.();
			ddlRunSrv.close();
			ddlRunSrv.closeAllConnections?.();
			await ddlGw.close();
		}
	});

	it("isolates ephemeral test schemas from live data, supports parallel checks, enforces caps, and cleans up on delete, TTL reap, and shutdown", async () => {
		const testEnv = randomUUID();
		const runToken = randomBytes(32).toString("base64url");
		const passMap = new Map();
		const testFiles = new Map([
			["data/shop/database.toml", 'format = "qorpera.database/v1"\nname = "Shop"\n'],
			[
				"data/shop/tables/001-init.sql",
				"create table items (id bigserial primary key, title text not null); insert into items (title) values ('Espresso'), ('Latte');\n" +
					"create table leads (id bigserial primary key, email text not null);",
			],
			["data/shop/queries/all-items.sql", "-- All items.\nselect id, title from items order by id;\n"],
			["data/shop/queries/all-leads.sql", "-- All leads.\nselect id, email from leads order by id;\n"],
			["data/shop/actions/add-lead.sql", "-- Add lead.\ninsert into leads (email) values (:email) returning id, email;\n"],
			["data/shop/actions/tamper-live.sql", "-- Attempt cross-schema write.\ninsert into shop.items (title) values ('Hacked') returning id;\n"],
		]);
		const allTexts = () => Object.fromEntries([...testFiles.values()].map((t) => [sha256(t), t]));
		const testPlatform = {
			async memberReads(_tok, _env, paths) {
				return paths.map((p) => (testFiles.has(p) ? { sha256: sha256(testFiles.get(p)), bytes: Buffer.byteLength(testFiles.get(p)) } : null));
			},
			async memberListPage(_tok, _env, parent, limit) {
				const prefix = `${parent}/`;
				const list = [...testFiles.entries()]
					.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
					.map(([p, text]) => ({ name: p.slice(prefix.length), sha256: sha256(text), bytes: Buffer.byteLength(text) }))
					.sort((a, b) => (a.name < b.name ? -1 : 1));
				return { files: list.slice(0, limit), more: list.length > limit };
			},
			async memberList(tok, env, parent, limit) {
				return (await this.memberListPage(tok, env, parent, limit)).files;
			},
			async memberMayWrite() {
				return true;
			},
			async memberFolders() {
				return ["shop"];
			},
			async redeemPass(pass) {
				const kept = passMap.get(pass) ?? null;
				passMap.delete(pass);
				return kept;
			},
		};
		const mintPass = () => {
			const pass = randomBytes(32).toString("base64url");
			passMap.set(pass, {
				environmentId: testEnv,
				machineId: null,
				requesterUserId: userId,
				agentId: randomUUID(),
				database: "shop",
				files: new Map([...testFiles.entries()].map(([p, text]) => [p, { sha256: sha256(text), bytes: Buffer.byteLength(text) }])),
				allow: null,
			});
			return pass;
		};
		const testGw = new Gateway({
			store: { host: "127.0.0.1", port, logins },
			platform: testPlatform,
			runs: { token: runToken },
			limits: { testSchemasPerCompany: 2 },
		});
		const testSrv = await serve(testGw, { host: "127.0.0.1", port: 0 });
		const testRunSrv = await serveRuns(testGw, { host: "127.0.0.1", port: 0 });
		const sendTo = (targetPort, method, path, body = null, headers = {}) =>
			new Promise((resolve, reject) => {
				const encoded = body === null ? null : JSON.stringify(body);
				const req = http.request(
					{
						host: "127.0.0.1",
						port: targetPort,
						method,
						path,
						headers: {
							...(encoded !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } : {}),
							...headers,
						},
					},
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
					},
				);
				req.on("error", reject);
				if (encoded !== null) req.end(encoded);
				else req.end();
			});
		const authHdr = { authorization: `Bearer ${token}` };
		const runHdr = { authorization: `Bearer ${runToken}` };
		const liveWakes = [];
		try {
			const applied = await sendTo(testSrv.address().port, "POST", `/v1/company-data/${testEnv}/apply`, { database: "shop", texts: allTexts() }, authHdr);
			assert.equal(applied.status, 200, JSON.stringify(applied.value));
			const liveWrite = await sendTo(
				testSrv.address().port,
				"POST",
				`/v1/company-data/${testEnv}/change`,
				{ database: "shop", change: "add-lead", params: { email: "live-only@example.com" }, texts: allTexts() },
				authHdr,
			);
			assert.equal(liveWrite.status, 200, JSON.stringify(liveWrite.value));
			const stopLiveTrig = await testGw.registerDataTrigger({
				id: "live-isolation-trig",
				environmentId: testEnv,
				database: "shop",
				tables: ["leads"],
				minIntervalMs: 20,
				onWake: (ev) => liveWakes.push(ev),
			});
			try {
				const createdA = await sendTo(testSrv.address().port, "POST", `/v1/company-data/${testEnv}/test-schemas`, { database: "shop" }, authHdr);
				assert.equal(createdA.status, 200, JSON.stringify(createdA.value));
				assert.match(createdA.value.schema, TEST_SCHEMA_NAME);
				assert.deepEqual(createdA.value.stepsApplied, ["001-init"]);
				const schemaA = createdA.value.schema;

				const createdB = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/test-schemas`,
					{ database: "shop", readLive: true },
					authHdr,
				);
				assert.equal(createdB.status, 200, JSON.stringify(createdB.value));
				const schemaB = createdB.value.schema;
				assert.notEqual(schemaA, schemaB);

				const capped = await sendTo(testSrv.address().port, "POST", `/v1/company-data/${testEnv}/test-schemas`, { database: "shop" }, authHdr);
				assert.equal(capped.status, 429);

				const listed = await sendTo(testSrv.address().port, "GET", `/v1/company-data/${testEnv}/test-schemas?database=shop`, null, authHdr);
				assert.equal(listed.status, 200);
				assert.deepEqual(listed.value.schemas.map((s) => s.schema).sort(), [schemaA, schemaB].sort());

				const seedItems = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/query?schema=${schemaA}`,
					{ database: "shop", question: "all-items", texts: allTexts() },
					authHdr,
				);
				assert.equal(seedItems.status, 200, JSON.stringify(seedItems.value));
				assert.deepEqual(seedItems.value.rows, [[1, "Espresso"], [2, "Latte"]]);

				const seedLeads = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/query?schema=${schemaA}`,
					{ database: "shop", question: "all-leads", texts: allTexts() },
					authHdr,
				);
				assert.deepEqual(seedLeads.value.rows, []);

				const testWrite = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/change?schema=${schemaA}`,
					{ database: "shop", change: "add-lead", params: { email: "test-a@example.com" }, texts: allTexts() },
					authHdr,
				);
				assert.equal(testWrite.status, 200, JSON.stringify(testWrite.value));
				assert.equal(testWrite.value.changed, 1);

				const leadsA = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/query?schema=${schemaA}`,
					{ database: "shop", question: "all-leads", texts: allTexts() },
					authHdr,
				);
				assert.deepEqual(leadsA.value.rows, [[1, "test-a@example.com"]]);

				const leadsB = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/query?schema=${schemaB}`,
					{ database: "shop", question: "all-leads", texts: allTexts() },
					authHdr,
				);
				assert.deepEqual(leadsB.value.rows, []);

				const liveLeads = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/query`,
					{ database: "shop", question: "all-leads", texts: allTexts() },
					authHdr,
				);
				assert.deepEqual(liveLeads.value.rows, [[1, "live-only@example.com"]]);

				await new Promise((r) => setTimeout(r, 60));
				assert.equal(liveWakes.length, 0);

				const testRecordRows = await asSuperuser(
					companyDatabase(testEnv),
					"select count(*)::int as n from qorpera_data.row_changes where schema like 'qorpera_test_%'",
				);
				assert.equal(testRecordRows[0].n, 0, "test-schema writes must not pollute qorpera_data.row_changes");
				const liveRecordRows = await asSuperuser(
					companyDatabase(testEnv),
					"select count(*)::int as n from qorpera_data.row_changes where schema = 'shop'",
				);
				assert.ok(liveRecordRows[0].n > 0, "live writes must still record in qorpera_data.row_changes");

				const commentA = (
					await asSuperuser(
						companyDatabase(testEnv),
						"select pg_catalog.obj_description(oid, 'pg_namespace') as comment from pg_catalog.pg_namespace where nspname = $1",
						[schemaA],
					)
				)[0]?.comment;
				assert.ok(typeof commentA === "string" && commentA.startsWith("qorpera_test_v1:"));
				const fakeSchema = `qorpera_test_${"f".repeat(16)}`;
				await asSuperuser(companyDatabase(testEnv), `create schema ${fakeSchema}; comment on schema ${fakeSchema} is '${commentA}'`);
				try {
					const spoofed = await sendTo(
						testSrv.address().port,
						"POST",
						`/v1/company-data/${testEnv}/query?schema=${fakeSchema}`,
						{ database: "shop", question: "all-items", texts: allTexts() },
						authHdr,
					);
					assert.equal(spoofed.status, 404, "copying another test schema's signed comment must be rejected");
				} finally {
					await asSuperuser(companyDatabase(testEnv), `drop schema if exists ${fakeSchema} cascade`);
				}

				const tamperA = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/change?schema=${schemaA}`,
					{ database: "shop", change: "tamper-live", texts: allTexts() },
					authHdr,
				);
				assert.equal(tamperA.status, 400);
				assert.match(tamperA.value.error, /permission denied/i);

				const tamperB = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/change?schema=${schemaB}`,
					{ database: "shop", change: "tamper-live", texts: allTexts() },
					authHdr,
				);
				assert.equal(tamperB.status, 400);
				assert.match(tamperB.value.error, /permission denied/i);

				const readLiveDenied = await sendTo(
					testRunSrv.address().port,
					"POST",
					`/v1/run-data/query?schema=${schemaA}`,
					{ database: "shop", sql: "select title from shop.items order by id", pass: mintPass() },
					runHdr,
				);
				assert.equal(readLiveDenied.status, 400);
				assert.match(readLiveDenied.value.error, /permission denied/i);

				const readLiveAllowed = await sendTo(
					testRunSrv.address().port,
					"POST",
					`/v1/run-data/query?schema=${schemaB}`,
					{ database: "shop", sql: "select email from shop.leads order by id", pass: mintPass() },
					runHdr,
				);
				assert.equal(readLiveAllowed.status, 200, JSON.stringify(readLiveAllowed.value));
				assert.deepEqual(readLiveAllowed.value.rows, [["live-only@example.com"]]);

				testFiles.set("data/shop/tables/002-add-sku.sql", "alter table items add column sku text not null default 'SKU-0';\n");
				const applyTest = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/apply?schema=${schemaA}`,
					{ database: "shop", texts: allTexts() },
					authHdr,
				);
				assert.equal(applyTest.status, 200, JSON.stringify(applyTest.value));
				assert.equal(applyTest.value.applied, true);
				assert.deepEqual(applyTest.value.results, [
					{ name: "001-init", state: "already" },
					{ name: "002-add-sku", state: "applied" },
				]);

				const descTest = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/describe?schema=${schemaA}`,
					{ database: "shop", texts: allTexts() },
					authHdr,
				);
				assert.equal(descTest.status, 200, JSON.stringify(descTest.value));
				assert.ok(descTest.value.databases[0].tables.find((t) => t.name === "items").columns.some((c) => c.name === "sku"));

				const descLive = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/describe`,
					{ database: "shop", texts: allTexts() },
					authHdr,
				);
				assert.equal(descLive.value.databases[0].tables.find((t) => t.name === "items").columns.some((c) => c.name === "sku"), false);
				const liveSteps = await asSuperuser(companyDatabase(testEnv), "select name from qorpera_data.steps where database = 'shop' order by name");
				assert.deepEqual(liveSteps, [{ name: "001-init" }]);

				const delA = await sendTo(testSrv.address().port, "DELETE", `/v1/company-data/${testEnv}/test-schemas/${schemaA}`, null, authHdr);
				assert.equal(delA.status, 200, JSON.stringify(delA.value));
				assert.equal(delA.value.dropped, true);
				const hexA = schemaA.slice("qorpera_test_".length);
				const leftSchemasA = await asSuperuser(companyDatabase(testEnv), "select nspname from pg_namespace where nspname = $1", [schemaA]);
				assert.deepEqual(leftSchemasA, []);
				const leftRolesA = await asSuperuser("postgres", "select rolname from pg_roles where rolname like $1", [`%_${hexA}`]);
				assert.deepEqual(leftRolesA, []);

				const afterDelQuery = await sendTo(
					testSrv.address().port,
					"POST",
					`/v1/company-data/${testEnv}/query?schema=${schemaA}`,
					{ database: "shop", question: "all-items", texts: allTexts() },
					authHdr,
				);
				assert.equal(afterDelQuery.status, 404);

				const runCreated = await sendTo(
					testRunSrv.address().port,
					"POST",
					"/v1/run-data/test-schemas",
					{ database: "shop", pass: mintPass() },
					runHdr,
				);
				assert.equal(runCreated.status, 200, JSON.stringify(runCreated.value));
				const runSchema = runCreated.value.schema;
				const runDel = await sendTo(
					testRunSrv.address().port,
					"DELETE",
					`/v1/run-data/test-schemas/${runSchema}`,
					{ pass: mintPass() },
					runHdr,
				);
				assert.equal(runDel.status, 200, JSON.stringify(runDel.value));
				assert.equal(runDel.value.dropped, true);

				await sendTo(testSrv.address().port, "DELETE", `/v1/company-data/${testEnv}/test-schemas/${schemaB}`, null, authHdr);
			} finally {
				stopLiveTrig();
			}

			const ttlGw = new Gateway({
				store: { host: "127.0.0.1", port, logins },
				platform: testPlatform,
				limits: { testSchemaTtlMs: 120 },
			});
			try {
				const shortSchema = await ttlGw.createTestSchema({ token, userId, key: "k" }, testEnv, { database: "shop" });
				const shortHex = shortSchema.schema.slice("qorpera_test_".length);
				let gone = false;
				for (let i = 0; i < 40; i++) {
					const found = await asSuperuser(companyDatabase(testEnv), "select nspname from pg_namespace where nspname = $1", [shortSchema.schema]);
					if (found.length === 0) {
						gone = true;
						break;
					}
					await new Promise((r) => setTimeout(r, 40));
				}
				assert.equal(gone, true, "idle TTL reaper should automatically drop expired test schema");
				const shortRoles = await asSuperuser("postgres", "select rolname from pg_roles where rolname like $1", [`%_${shortHex}`]);
				assert.deepEqual(shortRoles, []);
			} finally {
				await ttlGw.close();
			}

			const shutdownGw = new Gateway({ store: { host: "127.0.0.1", port, logins }, platform: testPlatform });
			const shutdownCreated = await shutdownGw.createTestSchema({ token, userId, key: "k" }, testEnv, { database: "shop" });
			const shutdownHex = shutdownCreated.schema.slice("qorpera_test_".length);
			await shutdownGw.close();
			const shutdownLeft = await asSuperuser(companyDatabase(testEnv), "select nspname from pg_namespace where nspname = $1", [shutdownCreated.schema]);
			assert.deepEqual(shutdownLeft, []);
			const shutdownRoles = await asSuperuser("postgres", "select rolname from pg_roles where rolname like $1", [`%_${shutdownHex}`]);
			assert.deepEqual(shutdownRoles, []);

			const slowEnv = randomUUID();
			const slowFiles = new Map([
				["data/slowdb/database.toml", 'format = "qorpera.database/v1"\nname = "Slow"\n'],
				["data/slowdb/tables/001-slow.sql", "create table t (id int primary key); select pg_sleep(0.35);\n"],
			]);
			const slowTexts = Object.fromEntries([...slowFiles.values()].map((t) => [sha256(t), t]));
			const slowPlatform = {
				async memberReads(_tok, _env, paths) {
					return paths.map((p) => (slowFiles.has(p) ? { sha256: sha256(slowFiles.get(p)), bytes: Buffer.byteLength(slowFiles.get(p)) } : null));
				},
				async memberListPage(_tok, _env, parent, limit) {
					const prefix = `${parent}/`;
					const files = [...slowFiles.entries()]
						.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
						.map(([p, text]) => ({ name: p.slice(prefix.length), sha256: sha256(text), bytes: Buffer.byteLength(text) }));
					return { files: files.slice(0, limit), more: files.length > limit };
				},
				async memberMayWrite() {
					return true;
				},
				async memberFolders() {
					return ["slowdb"];
				},
			};
			const slowSetupGw = new Gateway({ store: { host: "127.0.0.1", port, logins }, platform: slowPlatform });
			try {
				const appliedSlow = await slowSetupGw.apply({ token, userId, key: "k" }, slowEnv, { database: "slowdb", texts: slowTexts });
				assert.equal(appliedSlow.applied, true);
			} finally {
				await slowSetupGw.close();
			}
			const slowBoundGw = new Gateway({
				store: { host: "127.0.0.1", port, logins },
				platform: slowPlatform,
				limits: { applyMs: 120, stepMs: 2_000, testSchemasPerCompany: 1 },
			});
			try {
				await assert.rejects(
					() => slowBoundGw.createTestSchema({ token, userId, key: "k" }, slowEnv, { database: "slowdb", texts: slowTexts }),
					(err) => err?.status === 408 && /time limit/i.test(err?.message ?? ""),
				);
				const leakedSchemas = await asSuperuser(
					companyDatabase(slowEnv),
					"select nspname from pg_namespace where nspname ~ '^qorpera_test_[0-9a-f]{16}$'",
				);
				assert.deepEqual(leakedSchemas, [], "timed-out test schema clone must drop its partial schema");
				const leakedRoles = await asSuperuser(
					"postgres",
					"select rolname from pg_roles where rolname ~ $1",
					[`^${companyDatabase(slowEnv)}_t[owr]_[0-9a-f]{16}$`],
				);
				assert.deepEqual(leakedRoles, [], "timed-out test schema clone must drop its roles");
				const idleWatchGw = new Gateway({
					store: { host: "127.0.0.1", port, logins },
					platform: slowPlatform,
					limits: { sweepMs: 60_000 },
				});
				try {
					const orphan1 = `qorpera_test_${"a".repeat(16)}`;
					await asSuperuser(companyDatabase(slowEnv), `create schema ${orphan1} authorization qorpera_data_admin`);
					await idleWatchGw.watchOnce();
					const afterFirst = await asSuperuser(
						companyDatabase(slowEnv),
						"select nspname from pg_namespace where nspname = $1",
						[orphan1],
					);
					assert.deepEqual(afterFirst, [], "first watchOnce sweeps pre-existing orphan");
					const orphan2 = `qorpera_test_${"b".repeat(16)}`;
					await asSuperuser(companyDatabase(slowEnv), `create schema ${orphan2} authorization qorpera_data_admin`);
					try {
						await idleWatchGw.watchOnce();
						const afterSecond = await asSuperuser(
							companyDatabase(slowEnv),
							"select nspname from pg_namespace where nspname = $1",
							[orphan2],
						);
						assert.equal(afterSecond.length, 1, "subsequent watchOnce skips idle company DBs until sweepMs");
					} finally {
						await asSuperuser(companyDatabase(slowEnv), `drop schema if exists ${orphan2} cascade`);
					}
				} finally {
					await idleWatchGw.close();
				}
			} finally {
				await slowBoundGw.close();
			}
		} finally {
			testSrv.close();
			testSrv.closeAllConnections?.();
			testRunSrv.close();
			testRunSrv.closeAllConnections?.();
			await testGw.close();
		}
	});

	it("coordinates triggers, shared test-schema idle TTL, caps, and drop broadcasts across DATA_WORKERS=2", async () => {
		const clusterEnv = randomUUID();
		const adminTok = randomBytes(32).toString("base64url");
		const wakeTok = randomBytes(24).toString("base64url");
		const clusterFiles = new Map([
			["data/clusterdb/database.toml", 'format = "qorpera.database/v1"\nname = "ClusterDb"\n'],
			[
				"data/clusterdb/tables/001-init.sql",
				"create table items (id serial primary key, title text not null);\ninsert into items (title) values ('live-row');\n",
			],
			["data/clusterdb/queries/all-items.sql", "select id, title from items order by id;\n"],
			["data/clusterdb/actions/add-item.sql", "insert into items (title) values (:title) returning id, title;\n"],
		]);
		const allTexts = () => Object.fromEntries([...clusterFiles.values()].map((t) => [sha256(t), t]));
		const wakes = [];
		const wakeSrv = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				if (req.headers.authorization === `Bearer ${wakeTok}`) {
					wakes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
			});
		});
		const platformSrv = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				res.writeHead(200, { "content-type": "application/json" });
				if (req.url === "/rest/v1/rpc/qorpera_member_folder_may_write") {
					res.end(JSON.stringify({ write: true }));
					return;
				}
				if (req.url === "/rest/v1/rpc/qorpera_member_folder_read_many") {
					const paths = Array.isArray(args.p_paths) ? args.p_paths : [];
					res.end(
						JSON.stringify({
							reads: paths.map((p) =>
								clusterFiles.has(p)
									? { found: true, entry: { kind: "file", fileSha256: sha256(clusterFiles.get(p)), bytes: Buffer.byteLength(clusterFiles.get(p)) } }
									: { found: false },
							),
						}),
					);
					return;
				}
				if (req.url === "/rest/v1/rpc/qorpera_member_folder_list") {
					if (args.p_parent === "data") {
						res.end(JSON.stringify({ entries: [{ kind: "folder", path: "data/clusterdb" }] }));
						return;
					}
					const prefix = `${args.p_parent}/`;
					const entries = [...clusterFiles.entries()]
						.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
						.map(([p, text]) => ({ kind: "file", path: p, fileSha256: sha256(text), bytes: Buffer.byteLength(text) }));
					res.end(JSON.stringify({ entries }));
					return;
				}
				res.end("{}");
			});
		});
		const freePort = () =>
			new Promise((resolve, reject) => {
				const s = net.createServer();
				s.listen(0, "127.0.0.1", () => {
					const p = s.address().port;
					s.close(() => resolve(p));
				});
				s.on("error", reject);
			});
		const sendCluster = (targetPort, method, path, body, headers = {}) =>
			new Promise((resolve, reject) => {
				const encoded = body === null ? "" : JSON.stringify(body);
				const req = http.request(
					{
						host: "127.0.0.1",
						port: targetPort,
						method,
						path,
						headers: {
							...(body === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }),
							connection: "close",
							...headers,
						},
					},
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => {
							const text = Buffer.concat(chunks).toString("utf8");
							resolve({ status: res.statusCode, value: text ? JSON.parse(text) : null });
						});
					},
				);
				req.on("error", reject);
				req.end(encoded);
			});
		await Promise.all([
			new Promise((resolve) => wakeSrv.listen(0, "127.0.0.1", resolve)),
			new Promise((resolve) => platformSrv.listen(0, "127.0.0.1", resolve)),
		]);
		const tmpDir = mkdtempSync(join(tmpdir(), "qorpera-cluster-doors-"));
		const loginsDir = join(tmpDir, "logins");
		mkdirSync(loginsDir, { recursive: true });
		writeFileSync(join(loginsDir, "admin"), `${logins.admin}\n`);
		writeFileSync(join(loginsDir, "keeper"), `${logins.keeper}\n`);
		writeFileSync(join(loginsDir, "watch"), `${logins.watch}\n`);
		writeFileSync(join(loginsDir, "folder-key"), `${logins.folderKey}\n`);
		const listenPort = await freePort();
		const mainPath = fileURLToPath(new URL("../kit/gateway-main.mjs", import.meta.url));
		let child = null;
		let logs = "";
		try {
			child = spawn(process.execPath, [mainPath], {
				env: {
					...process.env,
					DATA_STORE_HOST: "127.0.0.1",
					DATA_STORE_PORT: String(port),
					DATA_LOGINS: loginsDir,
					DATA_PLATFORM_URL: `http://127.0.0.1:${platformSrv.address().port}`,
					DATA_PLATFORM_KEY: "pk-test",
					DATA_LISTEN: `127.0.0.1:${listenPort}`,
					DATA_WORKERS: "2",
					DATA_ADMIN_TOKEN: adminTok,
					DATA_TRIGGER_WAKE_URL: `http://127.0.0.1:${wakeSrv.address().port}/wake`,
					DATA_TRIGGER_WAKE_TOKEN: wakeTok,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout.on("data", (chunk) => {
				logs += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk) => {
				logs += chunk.toString("utf8");
			});
			const authHdr = { authorization: `Bearer ${token}` };
			const adminHdr = { authorization: `Bearer ${adminTok}` };
			let ready = false;
			for (let i = 0; i < 100; i++) {
				try {
					const h = await sendCluster(listenPort, "GET", `/v1/admin/company-data/${clusterEnv}/triggers`, null, adminHdr);
					if (h.status === 200) {
						ready = true;
						break;
					}
				} catch {}
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(ready, true, `DATA_WORKERS=2 gateway did not become ready:\n${logs}`);
			const applied = await sendCluster(
				listenPort,
				"POST",
				`/v1/company-data/${clusterEnv}/apply`,
				{ database: "clusterdb", texts: allTexts() },
				authHdr,
			);
			assert.equal(applied.status, 200, JSON.stringify(applied.value));
			assert.equal(applied.value.applied, true);

			const trigReg = await sendCluster(
				listenPort,
				"POST",
				`/v1/admin/company-data/${clusterEnv}/triggers`,
				{ id: "cluster-trig", database: "clusterdb", tables: ["items"], minIntervalMs: 25 },
				adminHdr,
			);
			assert.equal(trigReg.status, 200, JSON.stringify(trigReg.value));
			for (let i = 0; i < 4; i++) {
				const listed = await sendCluster(listenPort, "GET", `/v1/admin/company-data/${clusterEnv}/triggers`, null, adminHdr);
				assert.equal(listed.status, 200);
				assert.equal(listed.value.triggers.length, 1);
				assert.equal(listed.value.triggers[0].id, "cluster-trig");
			}
			const liveWrite = await sendCluster(
				listenPort,
				"POST",
				`/v1/company-data/${clusterEnv}/change`,
				{ database: "clusterdb", change: "add-item", params: { title: "from-cluster" }, texts: allTexts() },
				authHdr,
			);
			assert.equal(liveWrite.status, 200, JSON.stringify(liveWrite.value));
			for (let i = 0; i < 40 && wakes.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
			assert.equal(wakes.length, 1, "primary-owned trigger must fire HTTP wake across workers");
			assert.equal(wakes[0].id, "cluster-trig");
			assert.deepEqual(wakes[0].tables, ["items"]);
			const trigDel = await sendCluster(
				listenPort,
				"DELETE",
				`/v1/admin/company-data/${clusterEnv}/triggers/cluster-trig`,
				null,
				adminHdr,
			);
			assert.equal(trigDel.status, 200);
			assert.equal(trigDel.value.unregistered, true);

			const capSchemas = [];
			for (let i = 0; i < 8; i++) {
				const c = await sendCluster(
					listenPort,
					"POST",
					`/v1/company-data/${clusterEnv}/test-schemas`,
					{ database: "clusterdb", ttlSeconds: 30, texts: allTexts() },
					authHdr,
				);
				assert.equal(c.status, 200, JSON.stringify(c.value));
				capSchemas.push(c.value.schema);
			}
			const overCap = await sendCluster(
				listenPort,
				"POST",
				`/v1/company-data/${clusterEnv}/test-schemas`,
				{ database: "clusterdb", ttlSeconds: 30, texts: allTexts() },
				authHdr,
			);
			assert.equal(overCap.status, 429, "per-company cap must be enforced centrally across workers");
			for (const s of capSchemas) {
				const d = await sendCluster(listenPort, "DELETE", `/v1/company-data/${clusterEnv}/test-schemas/${s}`, null, authHdr);
				assert.equal(d.status, 200);
			}

			const applyCreated = await sendCluster(
				listenPort,
				"POST",
				`/v1/company-data/${clusterEnv}/test-schemas`,
				{ database: "clusterdb", ttlSeconds: 4, texts: allTexts() },
				authHdr,
			);
			assert.equal(applyCreated.status, 200, JSON.stringify(applyCreated.value));
			const applySchema = applyCreated.value.schema;
			await Promise.all(
				Array.from({ length: 8 }, () =>
					sendCluster(
						listenPort,
						"POST",
						`/v1/company-data/${clusterEnv}/query?schema=${applySchema}`,
						{ database: "clusterdb", question: "all-items", texts: allTexts() },
						authHdr,
					),
				),
			);
			clusterFiles.set("data/clusterdb/tables/002-add-sku.sql", "alter table items add column sku text not null default 'SKU-0';\n");
			const applied2 = await sendCluster(
				listenPort,
				"POST",
				`/v1/company-data/${clusterEnv}/apply?schema=${applySchema}`,
				{ database: "clusterdb", texts: allTexts() },
				authHdr,
			);
			assert.equal(applied2.status, 200, JSON.stringify(applied2.value));
			assert.equal(applied2.value.applied, true);
			assert.deepEqual(applied2.value.results, [
				{ name: "001-init", state: "already" },
				{ name: "002-add-sku", state: "applied" },
			]);
			await new Promise((r) => setTimeout(r, 1_100));
			const touchQueries = await Promise.all(
				Array.from({ length: 8 }, () =>
					sendCluster(
						listenPort,
						"POST",
						`/v1/company-data/${clusterEnv}/query?schema=${applySchema}`,
						{ database: "clusterdb", question: "all-items", texts: allTexts() },
						authHdr,
					),
				),
			);
			for (const r of touchQueries) assert.equal(r.status, 200, JSON.stringify(r.value));
			for (let i = 0; i < 4; i++) {
				const described = await sendCluster(
					listenPort,
					"POST",
					`/v1/company-data/${clusterEnv}/describe?schema=${applySchema}`,
					{ database: "clusterdb", texts: allTexts() },
					authHdr,
				);
				assert.equal(described.status, 200, JSON.stringify(described.value));
				assert.deepEqual(
					described.value.databases[0].applied.map((s) => s.name),
					["001-init", "002-add-sku"],
				);
				const reapply = await sendCluster(
					listenPort,
					"POST",
					`/v1/company-data/${clusterEnv}/apply?schema=${applySchema}`,
					{ database: "clusterdb", texts: allTexts() },
					authHdr,
				);
				assert.equal(reapply.status, 200, JSON.stringify(reapply.value));
				assert.equal(reapply.value.applied, true);
				assert.deepEqual(reapply.value.results, [
					{ name: "001-init", state: "already" },
					{ name: "002-add-sku", state: "already" },
				]);
			}
			clusterFiles.set("data/clusterdb/tables/003-add-note.sql", "alter table items add column note text;\n");
			const concurrentApplies = await Promise.all(
				Array.from({ length: 4 }, () =>
					sendCluster(
						listenPort,
						"POST",
						`/v1/company-data/${clusterEnv}/apply?schema=${applySchema}`,
						{ database: "clusterdb", texts: allTexts() },
						authHdr,
					),
				),
			);
			for (const r of concurrentApplies) {
				assert.equal(r.status, 200, `concurrent cross-worker apply must succeed: ${JSON.stringify(r.value)}`);
				assert.equal(r.value.applied, true, JSON.stringify(r.value));
			}
			assert.equal(
				concurrentApplies.filter((r) => r.value.results.some((s) => s.name === "003-add-note" && s.state === "applied")).length,
				1,
				"exactly one concurrent worker should execute step 003-add-note while peers see already",
			);
			await sendCluster(listenPort, "DELETE", `/v1/company-data/${clusterEnv}/test-schemas/${applySchema}`, null, authHdr);
			clusterFiles.delete("data/clusterdb/tables/002-add-sku.sql");
			clusterFiles.delete("data/clusterdb/tables/003-add-note.sql");

			const created = await sendCluster(
				listenPort,
				"POST",
				`/v1/company-data/${clusterEnv}/test-schemas`,
				{ database: "clusterdb", ttlSeconds: 1, texts: allTexts() },
				authHdr,
			);
			assert.equal(created.status, 200, JSON.stringify(created.value));
			const schemaName = created.value.schema;
			const initialExpiry = Date.parse(created.value.expiresAt);
			const keepUntil = Date.now() + 1_650;
			while (Date.now() < keepUntil) {
				const results = await Promise.all(
					Array.from({ length: 4 }, () =>
						sendCluster(
							listenPort,
							"POST",
							`/v1/company-data/${clusterEnv}/query?schema=${schemaName}`,
							{ database: "clusterdb", question: "all-items", texts: allTexts() },
							authHdr,
						),
					),
				);
				for (const r of results) {
					assert.equal(r.status, 200, `steady queries across workers must keep schema alive: ${JSON.stringify(r.value)}`);
					assert.deepEqual(r.value.rows, [[1, "live-row"]]);
				}
				await new Promise((r) => setTimeout(r, 200));
			}
			for (let i = 0; i < 4; i++) {
				const listed = await sendCluster(listenPort, "GET", `/v1/company-data/${clusterEnv}/test-schemas`, null, authHdr);
				assert.equal(listed.status, 200);
				const found = listed.value.schemas.find((s) => s.schema === schemaName);
				assert.ok(found, "GET test-schemas must report the schema consistently across workers");
				assert.ok(Date.parse(found.expiresAt) > initialExpiry, "idle TTL must have advanced past initial expiry");
			}

			let reaped = false;
			for (let i = 0; i < 40; i++) {
				const left = await asSuperuser(
					companyDatabase(clusterEnv),
					"select nspname from pg_namespace where nspname = $1",
					[schemaName],
				);
				if (left.length === 0) {
					reaped = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(reaped, true, "primary reaper must drop idle test schema once TTL elapses");
			await new Promise((r) => setTimeout(r, 100));
			const afterReap = await Promise.all(
				Array.from({ length: 8 }, () =>
					sendCluster(
						listenPort,
						"POST",
						`/v1/company-data/${clusterEnv}/query?schema=${schemaName}`,
						{ database: "clusterdb", question: "all-items", texts: allTexts() },
						authHdr,
					),
				),
			);
			for (const r of afterReap) {
				assert.equal(r.status, 404, `workers must return 404 after primary drop broadcast, got ${r.status}: ${JSON.stringify(r.value)}`);
			}

			const ipcPlatform = {
				async memberReads(_tok, _env, paths) {
					return paths.map((p) =>
						clusterFiles.has(p) ? { sha256: sha256(clusterFiles.get(p)), bytes: Buffer.byteLength(clusterFiles.get(p)) } : null,
					);
				},
				async memberListPage(_tok, _env, parent, limit) {
					const prefix = `${parent}/`;
					const files = [...clusterFiles.entries()]
						.filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
						.map(([p, text]) => ({ name: p.slice(prefix.length), sha256: sha256(text), bytes: Buffer.byteLength(text) }));
					return { files: files.slice(0, limit), more: files.length > limit };
				},
				async memberMayWrite() {
					return true;
				},
				async memberFolders() {
					return ["clusterdb"];
				},
			};
			const primaryReapGw = new Gateway({
				store: { host: "127.0.0.1", port, logins },
				platform: ipcPlatform,
				limits: { testSchemaTtlMs: 220 },
				testSchemas: { reaper: false },
			});
			const failingRpcWorkerGw = new Gateway({
				store: { host: "127.0.0.1", port, logins },
				platform: ipcPlatform,
				limits: { testSchemaTtlMs: 220 },
				testSchemas: {
					reaper: false,
					rpc: {
						reserve: (p) => primaryReapGw.reserveTestSchema(p),
						release: ({ database: d, schema: s }) => primaryReapGw.releaseTestSchema(d, s),
						touch: async () => {
							throw new Error("simulated touch IPC loss");
						},
						check: async () => {
							throw Object.assign(new Error("simulated check IPC timeout"), { status: 503 });
						},
						expiries: () => ({}),
					},
				},
			});
			const callerObj = { token, userId, key: "k" };
			let ipcSchema = null;
			try {
				const res = await primaryReapGw.createTestSchema(callerObj, clusterEnv, { database: "clusterdb", texts: allTexts() });
				ipcSchema = res.schema;
				await new Promise((r) => setTimeout(r, 140));
				const extended = await failingRpcWorkerGw.query(
					callerObj,
					clusterEnv,
					{ database: "clusterdb", question: "all-items", texts: allTexts() },
					{ testSchema: res.schema },
				);
				assert.deepEqual(extended.rows, [[1, "live-row"]]);
				await new Promise((r) => setTimeout(r, 110));
				const reapedEarly = await primaryReapGw.reapExpiredTestSchemas();
				assert.equal(
					reapedEarly.some((one) => one.schema === res.schema),
					false,
					"primary must re-read PG comment before dropping a schema whose touch IPC was lost",
				);
				const stillInPg = await asSuperuser(
					companyDatabase(clusterEnv),
					"select nspname from pg_namespace where nspname = $1",
					[res.schema],
				);
				assert.equal(stillInPg.length, 1);

				await new Promise((r) => setTimeout(r, 260));
				await assert.rejects(
					() =>
						failingRpcWorkerGw.query(
							callerObj,
							clusterEnv,
							{ database: "clusterdb", question: "all-items", texts: allTexts() },
							{ testSchema: res.schema },
						),
					(err) => err?.status === 503,
					"worker check IPC failure must refuse 503 instead of dropping the schema",
				);
				const stillPresentAfterCheckFail = await asSuperuser(
					companyDatabase(clusterEnv),
					"select nspname from pg_namespace where nspname = $1",
					[res.schema],
				);
				assert.equal(stillPresentAfterCheckFail.length, 1, "check IPC failure must never drop the schema");
			} finally {
				if (ipcSchema) await primaryReapGw.dropTestSchema(callerObj, clusterEnv, ipcSchema).catch(() => undefined);
				await failingRpcWorkerGw.close();
				await primaryReapGw.close();
			}
		} finally {
			if (child && child.exitCode === null) {
				const exited = new Promise((resolve) => child.once("exit", resolve));
				child.kill("SIGTERM");
				await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
				if (child.exitCode === null) child.kill("SIGKILL");
			}
			wakeSrv.close();
			wakeSrv.closeAllConnections?.();
			platformSrv.close();
			platformSrv.closeAllConnections?.();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
