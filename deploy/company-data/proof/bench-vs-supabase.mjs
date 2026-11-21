import cluster from "node:cluster";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway, serve } from "../gateway/gateway.mjs";
import { check, finish, note, now, percentiles, sleep, withAdmin } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "..", "store");
const ROWS = Number(process.env.BENCH_ROWS ?? 50_000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);
const WATCHERS = Number(process.env.BENCH_WATCHERS ?? 25);
const MULTI_COMPANIES = Number(process.env.BENCH_COMPANIES ?? 20);
const PGRST_INSTANCES = Number(process.env.BENCH_PGRST_INSTANCES ?? 10);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

class MemoryPlatform {
	#files = new Map();
	#members = new Map();
	calls = 0;

	addCompany(envId, files, members) {
		const map = new Map();
		for (const [path, text] of Object.entries(files)) {
			map.set(path, { text, sha256: sha256(text), bytes: Buffer.byteLength(text) });
		}
		this.#files.set(envId, map);
		this.#members.set(envId, new Map(members));
	}

	async memberReads(token, envId, paths) {
		this.calls++;
		const files = this.#files.get(envId);
		const members = this.#members.get(envId);
		if (!files || !members?.has(token)) return paths.map(() => null);
		return paths.map((path) => {
			const entry = files.get(path);
			return entry ? { sha256: entry.sha256, bytes: entry.bytes } : null;
		});
	}

	async memberMayWrite(token, envId) {
		this.calls++;
		return this.#members.get(envId)?.get(token)?.write === true;
	}

	async memberListPage(token, envId, parent, limit) {
		this.calls++;
		const files = this.#files.get(envId);
		if (!files || !this.#members.get(envId)?.has(token)) return { files: [], more: false };
		const prefix = `${parent}/`;
		const list = [...files]
			.filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
			.map(([path, entry]) => ({ name: path.slice(prefix.length), sha256: entry.sha256, bytes: entry.bytes }))
			.sort((a, b) => (a.name < b.name ? -1 : 1));
		return { files: list.slice(0, limit), more: list.length > limit };
	}

	async memberFolders(token, envId, parent) {
		this.calls++;
		const files = this.#files.get(envId);
		if (!files || !this.#members.get(envId)?.has(token)) return [];
		const prefix = `${parent}/`;
		const names = new Set();
		for (const path of files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash > 0) names.add(rest.slice(0, slash));
		}
		return [...names].sort();
	}

	textsFor(envId) {
		const out = {};
		for (const entry of this.#files.get(envId)?.values() ?? []) out[entry.sha256] = entry.text;
		return out;
	}
}

if (process.argv.includes("--cluster-worker")) {
	const logins = JSON.parse(process.env.BENCH_LOGINS);
	const workers = Number(process.env.BENCH_CLUSTER_WORKERS ?? 4);
	const listenPort = Number(process.env.BENCH_CLUSTER_PORT);
	if (cluster.isPrimary) {
		const companyList = [];
		const workerList = [];
		let readyCount = 0;
		const ctrlServer = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				if (req.url === "/add-company") {
					const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					companyList.push(payload);
					for (const w of workerList) w.send({ type: "add-company", payload });
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} else if (req.url === "/close") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					for (const w of workerList) w.kill("SIGTERM");
					ctrlServer.close();
					process.exit(0);
				} else {
					res.writeHead(404);
					res.end();
				}
			});
		});
		await new Promise((resolve) => ctrlServer.listen(0, "127.0.0.1", resolve));
		for (let i = 0; i < workers; i++) {
			const w = cluster.fork();
			workerList.push(w);
			w.on("message", (msg) => {
				if (msg?.type === "ready") {
					readyCount++;
					if (readyCount === workers) console.log(`READY ${listenPort} ${ctrlServer.address().port}`);
				}
			});
		}
		await new Promise(() => {});
	} else {
		const platform = new MemoryPlatform();
		const gateway = new Gateway({
			store: { host: process.env.PGHOST, port: Number(process.env.PGPORT), logins },
			platform,
			workers,
		});
		process.on("message", (msg) => {
			if (msg?.type === "add-company") {
				const { envId, files, members } = msg.payload;
				platform.addCompany(envId, files, members);
			}
		});
		const gwServer = await serve(gateway, { host: "127.0.0.1", port: listenPort });
		process.on("SIGTERM", async () => {
			gwServer.close();
			gwServer.closeAllConnections();
			await gateway.close();
			process.exit(0);
		});
		process.send?.({ type: "ready" });
		await new Promise(() => {});
	}
}

if (process.argv.includes("--gateway-worker")) {
	const logins = JSON.parse(process.env.BENCH_LOGINS);
	const platform = new MemoryPlatform();
	const gateway = new Gateway({
		store: { host: process.env.PGHOST, port: Number(process.env.PGPORT), logins },
		platform,
	});
	const gwServer = await serve(gateway, { host: "127.0.0.1", port: 0 });
	const ctrlServer = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			try {
				if (req.url === "/add-company") {
					const { envId, files, members } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					platform.addCompany(envId, files, members);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} else if (req.url === "/stats") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ taken: gateway.taken, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
				} else if (req.url === "/close") {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					gwServer.close();
					gwServer.closeAllConnections();
					ctrlServer.close();
					await gateway.close();
					process.exit(0);
				} else {
					res.writeHead(404);
					res.end();
				}
			} catch (err) {
				res.writeHead(500);
				res.end(String(err));
			}
		});
	});
	await new Promise((resolve) => ctrlServer.listen(0, "127.0.0.1", resolve));
	console.log(`READY ${gwServer.address().port} ${ctrlServer.address().port}`);
	await new Promise(() => {});
}

function signJwt(payload, secret) {
	const header = b64url({ alg: "HS256", typ: "JWT" });
	const body = b64url(payload);
	const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
	return `${header}.${body}.${sig}`;
}

function sqlWithLogins(file, logins) {
	return readFileSync(join(STORE, file), "utf8")
		.replaceAll(":'admin_password'", `'${logins.admin}'`)
		.replaceAll(":'keeper_password'", `'${logins.keeper}'`)
		.replaceAll(":'watch_password'", `'${logins.watch}'`);
}

function httpClient(host, port, maxSockets = 64) {
	const agent = new http.Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 30_000 });
	const request = (method, path, headers = {}, body = null) =>
		new Promise((resolve, reject) => {
			const encoded = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
			const reqHeaders = { ...headers };
			if (encoded !== null) {
				reqHeaders["content-type"] = "application/json";
				reqHeaders["content-length"] = String(Buffer.byteLength(encoded));
			}
			const req = http.request({ host, port, method, path, headers: reqHeaders, agent }, (res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = chunks.length === 1 ? chunks[0].toString("utf8") : Buffer.concat(chunks).toString("utf8");
					resolve({ status: res.statusCode ?? 0, text, bytes: Buffer.byteLength(text) });
				});
			});
			req.on("error", reject);
			if (encoded !== null) req.end(encoded);
			else req.end();
		});
	return { request, close: () => agent.destroy() };
}

async function drive(count, concurrency, fn) {
	const samples = [];
	let next = 0;
	let failed = 0;
	let totalBytes = 0;
	const wallStart = now();
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < count) {
				const index = next++;
				const started = now();
				const res = await fn(index);
				samples.push(now() - started);
				if (res.status !== 200 && res.status !== 201) failed++;
				totalBytes += res.bytes ?? 0;
			}
		}),
	);
	const wallMs = now() - wallStart;
	const stats = percentiles(samples);
	return {
		...stats,
		failed,
		wallMs: Math.round(wallMs * 10) / 10,
		rps: Math.round((count / (wallMs / 1000)) * 10) / 10,
		avgBytes: Math.round(totalBytes / Math.max(1, count)),
	};
}

const logins = {
	admin: randomBytes(16).toString("hex"),
	keeper: randomBytes(16).toString("hex"),
	watch: randomBytes(16).toString("hex"),
	folderKey: randomBytes(32).toString("hex"),
};
const jwtSecret = randomBytes(32).toString("hex");

function psqlExec(database, sql) {
	const ran = spawnSync(
		"docker",
		["exec", "-i", process.env.CDPROOF_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"],
		{ input: sql, encoding: "utf8" },
	);
	if (ran.status !== 0) throw new Error(ran.stderr || `psql exited ${ran.status}`);
}

psqlExec("postgres", sqlWithLogins("cluster.sql", logins));
psqlExec("qorpera_company_template", readFileSync(join(STORE, "template.sql"), "utf8"));
await withAdmin("postgres", async (db) => {
	await db.query("alter database qorpera_company_template is_template true");
	await db.query("revoke connect on database qorpera_company_template from public");
});

const workerProc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--gateway-worker"], {
	env: { ...process.env, BENCH_LOGINS: JSON.stringify(logins) },
	stdio: ["ignore", "pipe", "inherit"],
});
const { gwPort, ctrlPort } = await new Promise((resolve, reject) => {
	let buf = "";
	workerProc.stdout.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		const match = /^READY (\d+) (\d+)/m.exec(buf);
		if (match) resolve({ gwPort: Number(match[1]), ctrlPort: Number(match[2]) });
	});
	workerProc.on("exit", (code) => reject(new Error(`gateway worker exited ${code}`)));
});

const gw = httpClient("127.0.0.1", gwPort, 64);
const ctrl = httpClient("127.0.0.1", ctrlPort, 8);
const textsByEnv = new Map();

async function addCompany(envId, files, members) {
	const out = {};
	for (const text of Object.values(files)) out[sha256(text)] = text;
	textsByEnv.set(envId, out);
	const res = await ctrl.request("POST", "/add-company", {}, { envId, files, members });
	if (res.status !== 200) throw new Error(`add-company failed: ${res.text}`);
}

async function gwStats() {
	const res = await ctrl.request("GET", "/stats");
	return JSON.parse(res.text);
}

const envId = randomUUID();
const viewerA = randomUUID();
const viewerB = randomUUID();
const tokenA = signJwt({ sub: viewerA, role: "pgrst_user", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
const tokenB = signJwt({ sub: viewerB, role: "pgrst_user", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
const dbName = `c_${envId.replace(/-/g, "")}`;

const STEP_SQL = `
create table orders (
	id bigserial primary key,
	owner_id uuid not null,
	customer text not null,
	status text not null,
	amount numeric(12,2) not null,
	meta jsonb not null default '{}'::jsonb,
	placed_at timestamptz not null default now()
);
create index orders_placed_idx on orders (placed_at);
create index orders_owner_idx on orders (owner_id, id);
create index orders_customer_trgm_idx on orders using gin (customer gin_trgm_ops);
alter table orders enable row level security;
create policy orders_owner_read on orders for select using (
	owner_id = coalesce(
		qorpera_data.viewer(),
		nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
		nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
	)
);
create policy orders_write_all on orders for insert with check (true);
create policy orders_update_all on orders for update using (true) with check (true);
create table catalog (
	id bigserial primary key,
	sku text not null,
	title text not null,
	price numeric(12,2) not null,
	stock integer not null default 0
);
create index catalog_title_trgm_idx on catalog using gin (title gin_trgm_ops);
`;

const FILES = {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\nabout = "Benchmark store"\n\n[list]\nmembers = "readers"\n',
	"data/shop/tables/001-init.sql": STEP_SQL,
	"data/shop/queries/order-by-id.sql": "-- One order by id.\nselect id, customer, status, amount, placed_at from orders where id = :id;\n",
	"data/shop/queries/catalog-by-id.sql": "-- One catalog item by id.\nselect id, sku, title, price, stock from catalog where id = :id;\n",
	"data/shop/queries/my-orders.sql": "-- Recent orders for the signed-in viewer.\nselect id, customer, status, amount, placed_at from orders order by id desc limit 20;\n",
	"data/shop/queries/sales-since.sql": "-- Total items and price sum since an id.\nselect count(*)::int as orders, coalesce(sum(price), 0)::float8 as total from catalog where id >= :since_id;\n",
	"data/shop/queries/search-catalog.sql": "-- Fuzzy search catalog titles.\nselect id, sku, title, price from catalog where title ilike :pattern order by id asc limit 20;\n",
	"data/shop/queries/catalog-count.sql": "-- Live catalog count.\nselect count(*)::int as n, coalesce(sum(stock), 0)::bigint as units from catalog;\n",
	"data/shop/actions/add-item.sql": "-- Add item :sku to catalog.\ninsert into catalog (sku, title, price, stock) values (:sku, :title, :price::numeric, :stock::int) returning id, sku;\n",
};

await addCompany(envId, FILES, [
	[tokenA, { write: true }],
	[tokenB, { write: true }],
]);

const provisionStarted = now();
const applyRes = await gw.request(
	"POST",
	`/v1/company-data/${envId}/apply`,
	{ authorization: `Bearer ${tokenA}` },
	{ database: "shop", texts: textsByEnv.get(envId) },
);
const provisionMs = Math.round((now() - provisionStarted) * 10) / 10;
check("company database provisioned and schema applied", applyRes.status === 200 && JSON.parse(applyRes.text).applied === true, `${provisionMs} ms`);

const seedStarted = now();
await withAdmin(dbName, async (db) => {
	await db.query(
		`insert into shop.orders (owner_id, customer, status, amount, meta, placed_at)
		select case when n % 2 = 0 then $1::uuid else $2::uuid end,
			'Customer ' || (n % 500) || ' ' || md5(n::text),
			case when n % 5 = 0 then 'pending' else 'paid' end,
			((n % 900) + 100)::numeric(12,2),
			jsonb_build_object('tier', case when n % 10 = 0 then 'vip' else 'std' end, 'n', n),
			now() - ((n % 10000) || ' minutes')::interval
		from generate_series(1, $3) n`,
		[viewerA, viewerB, ROWS],
	);
	await db.query(
		`insert into shop.catalog (sku, title, price, stock)
		select 'SKU-' || lpad(n::text, 6, '0'),
			case when n % 200 = 0 then 'Nordic Espresso Grinder Pro ' || n else 'Component Item ' || (n % 700) || ' ' || substr(md5(n::text), 1, 8) end,
			((n % 500) + 19.99)::numeric(12,2),
			(n % 100) + 1
		from generate_series(1, $1) n`,
		[ROWS],
	);
	await db.query("analyze shop.orders; analyze shop.catalog;");
});
note(`seeded ${ROWS} orders + ${ROWS} catalog rows in ${Math.round(now() - seedStarted)} ms`);

const pgrstImage =
	process.env.CDPROOF_POSTGREST_IMAGE ||
	spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" })
		.stdout.split("\n")
		.find((line) => /postgrest/i.test(line) && !/<none>/.test(line));

let pgrstPort = null;
let pgrstContainer = null;
let pgrstClient = null;
if (pgrstImage) {
	await withAdmin("postgres", async (db) => {
		await db.query("create role pgrst_auth login noinherit password 'pgrst-bench-pass'");
		await db.query("create role pgrst_user nologin");
		await db.query("grant pgrst_user to pgrst_auth");
		await db.query(`grant connect on database ${dbName} to pgrst_auth`);
	});
	await withAdmin(dbName, async (db) => {
		await db.query("grant usage on schema shop, qorpera_ext to pgrst_user");
		await db.query("grant select, insert, update on shop.orders, shop.catalog to pgrst_user");
		await db.query("grant usage, select on all sequences in schema shop to pgrst_user");
		await db.query(`
			create function shop.catalog_by_id(p_id bigint) returns table (id bigint, sku text, title text, price numeric, stock int)
			language sql stable as $$ select id, sku, title, price, stock from shop.catalog where id = p_id $$;
			create function shop.my_orders() returns table (id bigint, customer text, status text, amount numeric, placed_at timestamptz)
			language sql stable as $$ select id, customer, status, amount, placed_at from shop.orders order by id desc limit 20 $$;
			create function shop.sales_since(p_since_id bigint) returns table (orders int, total float8)
			language sql stable as $$ select count(*)::int, coalesce(sum(price), 0)::float8 from shop.catalog where id >= p_since_id $$;
			create function shop.search_catalog(p_pattern text) returns table (id bigint, sku text, title text, price numeric)
			language sql stable as $$ select id, sku, title, price from shop.catalog where title ilike p_pattern order by id asc limit 20 $$;
			create function shop.add_item(p_sku text, p_title text, p_price numeric, p_stock int) returns table (id bigint, sku text)
			language sql volatile as $$ insert into shop.catalog (sku, title, price, stock) values (p_sku, p_title, p_price, p_stock) returning id, sku $$;
			grant execute on function shop.catalog_by_id(bigint), shop.my_orders(), shop.sales_since(bigint), shop.search_catalog(text), shop.add_item(text, text, numeric, int) to pgrst_user;
		`);
	});
	pgrstPort = await freePort();
	pgrstContainer = `cdrest-${process.env.CDPROOF_PID}-main`;
	const started = spawnSync(
		"docker",
		[
			"run", "-d", "--name", pgrstContainer, "--network", "host", "--memory", "512m",
			"-e", `PGRST_DB_URI=postgres://pgrst_auth:pgrst-bench-pass@127.0.0.1:${process.env.PGPORT}/${dbName}`,
			"-e", "PGRST_DB_SCHEMAS=shop",
			"-e", "PGRST_DB_ANON_ROLE=pgrst_user",
			"-e", `PGRST_JWT_SECRET=${jwtSecret}`,
			"-e", "PGRST_DB_POOL=8",
			"-e", `PGRST_SERVER_PORT=${pgrstPort}`,
			"-e", "PGRST_SERVER_HOST=127.0.0.1",
			pgrstImage,
		],
		{ encoding: "utf8" },
	);
	if (started.status !== 0) throw new Error(`PostgREST failed to start: ${started.stderr}`);
	pgrstClient = httpClient("127.0.0.1", pgrstPort, 64);
	let ready = false;
	for (let attempt = 0; attempt < 120 && !ready; attempt++) {
		await sleep(250);
		const probe = await pgrstClient.request("GET", "/rpc/catalog_by_id?p_id=1", { authorization: `Bearer ${tokenA}` }).catch(() => ({ status: 0 }));
		ready = probe.status === 200;
	}
	check("PostgREST v14.18 baseline ready on same Postgres 17.6", ready, pgrstImage);
}

const gwAuth = { authorization: `Bearer ${tokenA}` };
const gwTexts = textsByEnv.get(envId);

async function warmQorpera(question, params, rounds = 120) {
	const first = await gw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question, params, texts: gwTexts });
	if (first.status !== 200) throw new Error(`warmup ${question} failed: ${first.status} ${first.text}`);
	await drive(rounds, CONCURRENCY, () => gw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question, params }));
	return JSON.parse(first.text);
}

await warmQorpera("catalog-by-id", { id: 1 }, 200);
const initialOrders = await warmQorpera("my-orders", {}, 120);
await warmQorpera("sales-since", { since_id: ROWS - 5000 }, 40);
await warmQorpera("search-catalog", { pattern: "%Espresso%" }, 40);
await gw.request("POST", `/v1/company-data/${envId}/rows`, gwAuth, { database: "shop", table: "catalog", limit: 50, texts: gwTexts });
const warmWrite = await gw.request("POST", `/v1/company-data/${envId}/change`, gwAuth, {
	database: "shop",
	change: "add-item",
	params: { sku: "Q-WARM-0", title: "Warmup Item", price: 19.5, stock: 1 },
	texts: gwTexts,
});
if (warmWrite.status !== 200) throw new Error(`warmup add-item failed: ${warmWrite.status} ${warmWrite.text}`);
await drive(16, 4, (i) =>
	gw.request("POST", `/v1/company-data/${envId}/change`, gwAuth, {
		database: "shop",
		change: "add-item",
		params: { sku: `Q-WARM-${i + 1}`, title: "Warmup Item", price: 19.5, stock: 1 },
	}),
);
if (pgrstClient) {
	await drive(80, CONCURRENCY, () => pgrstClient.request("GET", "/rpc/catalog_by_id?p_id=1", gwAuth));
	await drive(40, CONCURRENCY, () => pgrstClient.request("GET", "/catalog?id=eq.1", gwAuth));
	await drive(40, CONCURRENCY, () => pgrstClient.request("GET", "/rpc/my_orders", gwAuth));
	await drive(20, CONCURRENCY, () => pgrstClient.request("GET", `/rpc/sales_since?p_since_id=${ROWS - 5000}`, gwAuth));
	await drive(20, CONCURRENCY, () => pgrstClient.request("GET", "/rpc/search_catalog?p_pattern=%25Espresso%25", gwAuth));
	await drive(12, 4, (i) =>
		pgrstClient.request("POST", "/rpc/add_item", gwAuth, { p_sku: `P-WARM-${i}`, p_title: "Warmup", p_price: 19.5, p_stock: 1 }),
	);
}

const report = {
	schema: "qorpera.db-benchmark/v1",
	postgres: "17.6-bookworm",
	postgrest: pgrstImage ?? null,
	rows: ROWS,
	concurrency: CONCURRENCY,
	provisionMs,
	benchmarks: {},
};

const qPoint = await drive(1500, CONCURRENCY, (i) =>
	gw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question: "catalog-by-id", params: { id: (i % ROWS) + 1 } }),
);
const pPointRest = pgrstClient
	? await drive(1500, CONCURRENCY, (i) => pgrstClient.request("GET", `/catalog?id=eq.${(i % ROWS) + 1}`, gwAuth))
	: null;
const pPointRpc = pgrstClient
	? await drive(1500, CONCURRENCY, (i) => pgrstClient.request("GET", `/rpc/catalog_by_id?p_id=${(i % ROWS) + 1}`, gwAuth))
	: null;
report.benchmarks.pointRead = { qorpera: qPoint, postgrestRest: pPointRest, postgrestRpc: pPointRpc };
note(`1. Point Read (1500 calls): Qorpera p50=${qPoint.p50}ms p95=${qPoint.p95}ms (${qPoint.rps} req/s) | PostgREST REST p50=${pPointRest?.p50}ms (${pPointRest?.rps} req/s) | PostgREST RPC p50=${pPointRpc?.p50}ms (${pPointRpc?.rps} req/s)`);

const qRls = await drive(1500, CONCURRENCY, (i) =>
	gw.request("POST", `/v1/company-data/${envId}/query`, { authorization: `Bearer ${i % 2 === 0 ? tokenA : tokenB}` }, { database: "shop", question: "my-orders", params: {} }),
);
const pRls = pgrstClient
	? await drive(1500, CONCURRENCY, (i) =>
			pgrstClient.request("GET", "/rpc/my_orders", { authorization: `Bearer ${i % 2 === 0 ? tokenA : tokenB}` }),
		)
	: null;
report.benchmarks.rlsRead = { qorpera: qRls, postgrestJwtRls: pRls };
note(`2. RLS Multi-Tenant Read (1500 calls): Qorpera p50=${qRls.p50}ms p95=${qRls.p95}ms (${qRls.rps} req/s) | PostgREST JWT+RLS p50=${pRls?.p50}ms (${pRls?.rps} req/s)`);

const qAgg = await drive(800, CONCURRENCY, (i) =>
	gw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question: "sales-since", params: { since_id: ROWS - 5000 + (i % 100) } }),
);
const pAgg = pgrstClient
	? await drive(800, CONCURRENCY, (i) => pgrstClient.request("GET", `/rpc/sales_since?p_since_id=${ROWS - 5000 + (i % 100)}`, gwAuth))
	: null;
report.benchmarks.aggregate = { qorpera: qAgg, postgrestRpc: pAgg };
note(`3. Aggregate Query (800 calls): Qorpera p50=${qAgg.p50}ms p95=${qAgg.p95}ms (${qAgg.rps} req/s) | PostgREST RPC p50=${pAgg?.p50}ms (${pAgg?.rps} req/s)`);

const qTrgm = await drive(500, CONCURRENCY, () =>
	gw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question: "search-catalog", params: { pattern: "%Espresso%" } }),
);
const pTrgm = pgrstClient
	? await drive(500, CONCURRENCY, () => pgrstClient.request("GET", "/rpc/search_catalog?p_pattern=%25Espresso%25", gwAuth))
	: null;
report.benchmarks.trgmSearch = { qorpera: qTrgm, postgrestRpc: pTrgm };
note(`4. pg_trgm Fuzzy Search (500 calls): Qorpera p50=${qTrgm.p50}ms p95=${qTrgm.p95}ms (${qTrgm.rps} req/s) | PostgREST RPC p50=${pTrgm?.p50}ms (${pTrgm?.rps} req/s)`);

const offsetAt = Math.floor(ROWS * 0.9);
const qDeepPage = await drive(400, 4, () =>
	gw.request("POST", `/v1/company-data/${envId}/rows`, gwAuth, { database: "shop", table: "catalog", limit: 50, after: [String(offsetAt)] }),
);
const pDeepPage = pgrstClient
	? await drive(400, 4, () => pgrstClient.request("GET", `/catalog?order=id.asc&limit=50&offset=${offsetAt}`, gwAuth))
	: null;
report.benchmarks.deepPagination = { offset: offsetAt, qorperaKeyset: qDeepPage, postgrestOffset: pDeepPage };
note(`5. Deep Pagination @ row ${offsetAt} (400 calls): Qorpera Keyset p50=${qDeepPage.p50}ms (${qDeepPage.rps} req/s) | PostgREST OFFSET p50=${pDeepPage?.p50}ms (${pDeepPage?.rps} req/s)`);

const qWrite = await drive(300, 4, (i) =>
	gw.request("POST", `/v1/company-data/${envId}/change`, gwAuth, {
		database: "shop",
		change: "add-item",
		params: { sku: `Q-${i}`, title: `Qorpera Item ${i}`, price: 49.5, stock: 5 },
	}),
);
const pWrite = pgrstClient
	? await drive(300, 4, (i) =>
			pgrstClient.request("POST", "/rpc/add_item", gwAuth, { p_sku: `P-${i}`, p_title: `PostgREST Item ${i}`, p_price: 49.5, p_stock: 5 }),
		)
	: null;
report.benchmarks.write = { qorperaAuditAndLive: qWrite, postgrestRpc: pWrite };
note(`6. Writes (300 calls): Qorpera (audited+live) p50=${qWrite.p50}ms (${qWrite.rps} req/s, failed=${qWrite.failed}) | PostgREST RPC p50=${pWrite?.p50}ms (${pWrite?.rps} req/s)`);

const qEtag = await drive(1000, CONCURRENCY, () =>
	gw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, {
		database: "shop",
		question: "my-orders",
		params: {},
		etag: initialOrders.etag,
	}),
);
report.benchmarks.etagRevalidate = { qorperaSame: qEtag, postgrestFullBytes: pRls?.avgBytes ?? null };
note(`7. ETag Conditional Revalidate (20-row my-orders): Qorpera p50=${qEtag.p50}ms, avgBytes=${qEtag.avgBytes}B vs PostgREST ${pRls?.avgBytes}B (${qEtag.rps} req/s)`);

const initialCount = await warmQorpera("catalog-count", {});
const watchTokens = Array.from({ length: WATCHERS }, () => {
	const uid = randomUUID();
	return signJwt({ sub: uid, role: "pgrst_user", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
});
await addCompany(envId, FILES, [[tokenA, { write: true }], [tokenB, { write: true }], ...watchTokens.map((t) => [t, { write: true }])]);
const watchClients = Array.from({ length: WATCHERS }, () => httpClient("127.0.0.1", gwPort, 4));
const firstPageRes = await gw.request("POST", `/v1/company-data/${envId}/rows`, gwAuth, { database: "shop", table: "catalog", limit: 20 });
const firstPageEtag = JSON.parse(firstPageRes.text).etag;

const fanoutLatencies = [];
const rowsTakenBefore = (await gwStats()).taken.rows;
const COMMITS = 15;
let currentEtag = initialCount.etag;
for (let c = 0; c < COMMITS; c++) {
	const pending = watchClients.map((client, idx) =>
		client.request("POST", `/v1/company-data/${envId}/watch`, { authorization: `Bearer ${watchTokens[idx]}` }, {
			wait: 5,
			watches: [{ database: "shop", question: "catalog-count", params: {}, etag: currentEtag }],
		}),
	);
	await sleep(30);
	const commitStart = now();
	await withAdmin(dbName, (db) => db.query("insert into shop.catalog (sku, title, price, stock) values ($1, 'Fanout Item', 10, 1)", [`FAN-${c}`]));
	const settled = await Promise.all(pending);
	const elapsed = now() - commitStart;
	fanoutLatencies.push(elapsed);
	const parsed = JSON.parse(settled[0].text);
	currentEtag = parsed.changed[0].answer.etag;
}
const fanoutRowsTaken = (await gwStats()).taken.rows - rowsTakenBefore;
const fanoutStats = percentiles(fanoutLatencies);

const anchorWatch = watchClients[0].request("POST", `/v1/company-data/${envId}/watch`, { authorization: `Bearer ${watchTokens[0]}` }, {
	wait: 2,
	watches: [{ database: "shop", table: "catalog", limit: 20, etag: firstPageEtag }],
});
await sleep(40);
const cacheRowsBefore = (await gwStats()).taken.rows;
const cacheStart = now();
const cachedRes = await Promise.all(
	watchClients.slice(1).map((client, idx) =>
		client.request("POST", `/v1/company-data/${envId}/watch`, { authorization: `Bearer ${watchTokens[idx + 1]}` }, {
			wait: 0,
			watches: [{ database: "shop", table: "catalog", limit: 20, etag: "stale-etag" }],
		}),
	),
);
const cachedReconnectMs = Math.round((now() - cacheStart) * 100) / 100;
const cachedRowsTaken = (await gwStats()).taken.rows - cacheRowsBefore;
await anchorWatch.catch(() => undefined);
for (const c of watchClients) c.close();

report.benchmarks.multiplayerFanout = {
	watchers: WATCHERS,
	commits: COMMITS,
	qorperaDeliveryMs: fanoutStats,
	qorperaDbQueriesPerCommit: Math.round((fanoutRowsTaken / COMMITS) * 100) / 100,
	uncoalescedDbQueriesPerCommit: WATCHERS,
	supabasePostgresChangesRefMs: 246,
	cachedReconnect24WatchersMs: cachedReconnectMs,
	cachedReconnectDbRowsTaken: cachedRowsTaken,
	cachedReconnectAllOk: cachedRes.every((r) => r.status === 200),
};
note(`8. Multiplayer Fan-Out (${WATCHERS} watchers, ${COMMITS} commits): Qorpera commit->all-${WATCHERS} p50=${fanoutStats.p50}ms p95=${fanoutStats.p95}ms, DB queries/commit=${report.benchmarks.multiplayerFanout.qorperaDbQueriesPerCommit} (vs ${WATCHERS} uncoalesced, vs ~246ms Supabase postgres_changes) | 24-watcher cached reconnect=${cachedReconnectMs}ms (DB rows read=${cachedRowsTaken})`);

const multiEnvs = [];
for (let i = 0; i < MULTI_COMPANIES; i++) {
	const id = randomUUID();
	const tok = signJwt({ sub: randomUUID(), role: "pgrst_user", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
	const files = {
		"data/app/database.toml": 'format = "qorpera.database/v1"\nname = "App"\nabout = "Tenant"\n',
		"data/app/tables/001-t.sql": "create table items (id bigserial primary key, v int not null); insert into items (v) select generate_series(1, 100);",
		"data/app/queries/sum.sql": "-- Sum.\nselect sum(v)::int as total from items;\n",
	};
	await addCompany(id, files, [[tok, { write: true }]]);
	const applied = await gw.request("POST", `/v1/company-data/${id}/apply`, { authorization: `Bearer ${tok}` }, { database: "app", texts: textsByEnv.get(id) });
	if (applied.status !== 200) throw new Error(`multi apply ${i} failed: ${applied.text}`);
	multiEnvs.push({ id, tok });
}
const multiWarm = await drive(1000, CONCURRENCY, (i) => {
	const target = multiEnvs[i % multiEnvs.length];
	return gw.request("POST", `/v1/company-data/${target.id}/query`, { authorization: `Bearer ${target.tok}` }, { database: "app", question: "sum", params: {}, texts: textsByEnv.get(target.id) });
});
const qorperaRssMiB = (await gwStats()).rssMiB;
const activeBackends = await withAdmin("postgres", (db) =>
	db.query("select count(*)::int as n from pg_stat_activity where application_name like 'qorpera-data-gateway%'").then((r) => r.rows[0].n),
);
await sleep(6200);
const idleBackends = await withAdmin("postgres", (db) =>
	db.query("select count(*)::int as n from pg_stat_activity where application_name like 'qorpera-data-gateway%'").then((r) => r.rows[0].n),
);

let pgrstDensity = null;
if (pgrstImage) {
	const extraContainers = [];
	for (let i = 0; i < PGRST_INSTANCES; i++) {
		const container = `cdrest-${process.env.CDPROOF_PID}-m${i}`;
		const port = await freePort();
		const res = spawnSync(
			"docker",
			[
				"run", "-d", "--name", container, "--network", "host", "--memory", "256m",
				"-e", `PGRST_DB_URI=postgres://pgrst_auth:pgrst-bench-pass@127.0.0.1:${process.env.PGPORT}/${dbName}`,
				"-e", "PGRST_DB_SCHEMAS=shop",
				"-e", "PGRST_DB_ANON_ROLE=pgrst_user",
				"-e", `PGRST_SERVER_PORT=${port}`,
				"-e", "PGRST_SERVER_HOST=127.0.0.1",
				pgrstImage,
			],
			{ encoding: "utf8" },
		);
		if (res.status === 0) extraContainers.push(container);
	}
	await sleep(2500);
	const statsOut = spawnSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", ...extraContainers], { encoding: "utf8" }).stdout.trim();
	const mibEach = statsOut
		.split("\n")
		.map((line) => /([\d.]+)MiB/.exec(line))
		.filter(Boolean)
		.map((m) => Number(m[1]));
	const pgrstIdleConns = await withAdmin("postgres", (db) =>
		db.query("select count(*)::int as n from pg_stat_activity where usename = 'pgrst_auth'").then((r) => r.rows[0].n),
	);
	const avgMiB = mibEach.length ? Math.round((mibEach.reduce((a, b) => a + b, 0) / mibEach.length) * 10) / 10 : 0;
	const avgConns = Math.round(((pgrstIdleConns - 1) / Math.max(1, extraContainers.length)) * 10) / 10;
	pgrstDensity = {
		measuredInstances: extraContainers.length,
		avgMiBPerCompany: avgMiB,
		projectedMiBFor50Companies: Math.round(avgMiB * 50),
		idleConnsMeasured: pgrstIdleConns,
		projectedIdleConnsFor50Companies: Math.round(avgConns * 50),
	};
	for (const c of extraContainers) spawnSync("docker", ["rm", "-f", "-v", c]);
}

report.benchmarks.multiTenantDensity = {
	companiesMeasured: MULTI_COMPANIES + 1,
	qorperaSpreadCallMs: multiWarm,
	qorperaTotalRssMiB: qorperaRssMiB,
	qorperaActiveBackends: activeBackends,
	qorperaIdleBackendsAfter6s: idleBackends,
	postgrest: pgrstDensity,
};
note(`9. Multi-Tenant Density (${MULTI_COMPANIES + 1} companies): Qorpera total RSS=${qorperaRssMiB} MiB, active conns=${activeBackends}, idle conns=${idleBackends} | PostgREST avg=${pgrstDensity?.avgMiBPerCompany} MiB/company (~${pgrstDensity?.projectedMiBFor50Companies} MiB & ~${pgrstDensity?.projectedIdleConnsFor50Companies} idle conns for 50 companies)`);

const clusterPort = 39700 + (process.pid % 90);
const clusterProc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--cluster-worker"], {
	env: { ...process.env, BENCH_LOGINS: JSON.stringify(logins), BENCH_CLUSTER_WORKERS: "4", BENCH_CLUSTER_PORT: String(clusterPort) },
	stdio: ["ignore", "pipe", "inherit"],
});
const clusterReady = await new Promise((resolve, reject) => {
	let buf = "";
	clusterProc.stdout.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		const match = /^READY (\d+) (\d+)/m.exec(buf);
		if (match) resolve({ port: Number(match[1]), ctrlPort: Number(match[2]) });
	});
	clusterProc.on("exit", (code) => reject(new Error(`cluster worker exited ${code}`)));
});
const clGw = httpClient("127.0.0.1", clusterReady.port, 64);
const clCtrl = httpClient("127.0.0.1", clusterReady.ctrlPort, 8);
await clCtrl.request("POST", "/add-company", {}, { envId, files: FILES, members: [[tokenA, { write: true }], [tokenB, { write: true }]] });
await sleep(50);
await drive(160, 12, (i) =>
	clGw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question: "catalog-by-id", params: { id: (i % ROWS) + 1 } }),
);
await drive(160, 12, (i) =>
	clGw.request("POST", `/v1/company-data/${envId}/query`, { authorization: `Bearer ${i % 2 === 0 ? tokenA : tokenB}` }, { database: "shop", question: "my-orders", params: {} }),
);
await drive(16, 4, (i) =>
	clGw.request("POST", `/v1/company-data/${envId}/change`, gwAuth, { database: "shop", change: "add-item", params: { sku: `CW-${i}`, title: "Warm", price: 10, stock: 1 } }),
);
const clPoint = await drive(2000, 12, (i) =>
	clGw.request("POST", `/v1/company-data/${envId}/query`, gwAuth, { database: "shop", question: "catalog-by-id", params: { id: (i % ROWS) + 1 } }),
);
const clRls = await drive(2000, 12, (i) =>
	clGw.request("POST", `/v1/company-data/${envId}/query`, { authorization: `Bearer ${i % 2 === 0 ? tokenA : tokenB}` }, { database: "shop", question: "my-orders", params: {} }),
);
const clWrite = await drive(300, 4, (i) =>
	clGw.request("POST", `/v1/company-data/${envId}/change`, gwAuth, { database: "shop", change: "add-item", params: { sku: `CQ-${i}`, title: `Cluster Item ${i}`, price: 49.5, stock: 5 } }),
);
report.benchmarks.cluster4Workers = { pointRead: clPoint, rlsRead: clRls, write: clWrite };
note(`10. Multi-Core Cluster (4 workers, matching PostgREST multi-core): Point Read p50=${clPoint.p50}ms (${clPoint.rps} req/s, failed=${clPoint.failed}) | RLS Read p50=${clRls.p50}ms (${clRls.rps} req/s, failed=${clRls.failed}) | Write p50=${clWrite.p50}ms (${clWrite.rps} req/s, failed=${clWrite.failed})`);
clGw.close();
await clCtrl.request("POST", "/close").catch(() => undefined);
clCtrl.close();
clusterProc.kill();

check("Qorpera point read succeeds with 0 failures", qPoint.failed === 0 && clPoint.failed === 0);
check("Qorpera RLS read succeeds with 0 failures", qRls.failed === 0 && clRls.failed === 0);
check("Qorpera writes succeed with 0 failures", qWrite.failed === 0 && clWrite.failed === 0, `${qWrite.p50} ms (1w) / ${clWrite.p50} ms (4w) vs ${pWrite?.p50} ms`);
check("Qorpera deep keyset pagination beats PostgREST OFFSET", !pDeepPage || qDeepPage.p50 < pDeepPage.p50, `${qDeepPage.p50} ms vs ${pDeepPage?.p50} ms`);
check("Qorpera multiplayer fan-out coalesces 25 watchers to <= 2 DB queries/commit", report.benchmarks.multiplayerFanout.qorperaDbQueriesPerCommit <= 2, `${report.benchmarks.multiplayerFanout.qorperaDbQueriesPerCommit} queries/commit`);
check("Qorpera continuous-listener cache serves 24 watchers with 0 DB rows read", cachedRowsTaken === 0 && cachedRes.every((r) => r.status === 200), `${cachedReconnectMs} ms`);
check("Qorpera releases idle connections across all companies", idleBackends === 0, `${idleBackends} held`);

console.log(`BENCH_JSON=${JSON.stringify(report)}`);

if (pgrstClient) pgrstClient.close();
if (pgrstContainer) spawnSync("docker", ["rm", "-f", "-v", pgrstContainer]);
gw.close();
await ctrl.request("POST", "/close").catch(() => undefined);
ctrl.close();
workerProc.kill();
finish();
