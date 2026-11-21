import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { POSTGRES_IMAGE, POSTGRES_LOCALE } from "../../../scripts/test-hosted-db.mjs";
import { companyDatabase, DataChangeNotifier, Gateway, parsePublicConfig, serve } from "./gateway.mjs";

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

			await asSuperuser(
				"postgres",
				"select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway listen'",
				[companyDatabase(envId)],
			);
			for (let i = 0; i < 40; i++) {
				const active = await asSuperuser(
					"postgres",
					"select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = 'qorpera-data-gateway listen'",
					[companyDatabase(envId)],
				);
				if (active[0].n > 0) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			await post(
				`/v1/hook-data/${envId}/change`,
				{ database: "shop", change: "ingest-stripe", hookId: "hook-reconnect-1", params: { email: "r2@example.com", source: "stripe" } },
				{ authorization: `Bearer ${hookToken}` },
			);
			for (let i = 0; i < 40 && wakesNew.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
			assert.ok(wakesNew.length >= 2, `expected trigger wake after LISTEN reconnect, got ${wakesNew.length}`);
		} finally {
			stopNew();
		}
	});
});
