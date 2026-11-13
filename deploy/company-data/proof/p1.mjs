// Proof 1: one small gateway of our own against one PostgREST per company.
// 50 company databases in one PostgreSQL. A named question is one read with named parameters.
// Measures: time per call, memory, and connections held, for each shape.
import { spawnSync } from "node:child_process";
import http from "node:http";
import { check, connection, finish, note, now, percentiles, pg, sleep, withAdmin } from "./lib.mjs";

const COMPANIES = 50;
const ROWS = 10_000;
const CALLS = 3000;
const CONCURRENCY = 8;
const QUESTION =
	"select count(*)::int as orders, coalesce(sum(amount), 0)::float8 as total from shop.orders where placed_at >= $1";
const name = (index) => `c_${String(index).padStart(3, "0")}`;

async function build() {
	const started = now();
	await withAdmin("postgres", async (db) => {
		await db.query("create role cd_gateway login noinherit password 'gateway-proof'");
		await db.query("create database c_template");
	});
	await withAdmin("c_template", async (db) => {
		await db.query(`
			create schema shop;
			create table shop.orders (id bigserial primary key, amount numeric(12,2) not null, status text not null,
				placed_at timestamptz not null);
			insert into shop.orders (amount, status, placed_at)
				select (random() * 900 + 100)::numeric(12,2), 'paid', now() - (n || ' minutes')::interval
				from generate_series(1, ${ROWS}) n;
			create index on shop.orders (placed_at);
			analyze shop.orders;
		`);
	});
	await withAdmin("postgres", async (db) => {
		for (let index = 1; index <= COMPANIES; index++) {
			const company = name(index);
			await db.query(`create role ${company}_read nologin`);
			await db.query(`grant ${company}_read to cd_gateway`);
			await db.query(`create database ${company} template c_template`);
			await db.query(`revoke connect on database ${company} from public`);
			await db.query(`grant connect on database ${company} to cd_gateway`);
		}
	});
	for (let index = 1; index <= COMPANIES; index++) {
		const company = name(index);
		await withAdmin(company, async (db) => {
			await db.query(`grant usage on schema shop to ${company}_read; grant select on shop.orders to ${company}_read`);
			// What a PostgREST for this company would call.
			await db.query(`create function shop.sales_since(since timestamptz) returns table (orders int, total float8)
				language sql stable as $$ select count(*)::int, coalesce(sum(amount), 0)::float8 from shop.orders
				where placed_at >= since $$`);
			await db.query(`grant execute on function shop.sales_since(timestamptz) to ${company}_read`);
		});
	}
	note(`${COMPANIES} company databases of ${ROWS} rows each made in ${Math.round(now() - started)} ms`);
}

/** The small gateway: one process, a pool per company opened on first use, one read-only transaction per call. */
function gateway() {
	const pools = new Map();
	const pool = (company) => {
		let found = pools.get(company);
		if (!found) {
			found = new pg.Pool({ ...connection(company, "cd_gateway", "gateway-proof"), max: 2, idleTimeoutMillis: 5000 });
			pools.set(company, found);
		}
		return found;
	};
	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url, "http://gateway");
		const [, , company] = url.pathname.split("/");
		if (!/^c_\d{3}$/.test(company ?? "")) {
			response.writeHead(404).end();
			return;
		}
		const client = await pool(company).connect();
		try {
			await client.query(
				`begin transaction read only; set local statement_timeout = '5s'; set local role ${company}_read`,
			);
			const result = await client.query({ text: QUESTION, values: [url.searchParams.get("since")], rowMode: "array" });
			await client.query("commit");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ columns: result.fields.map((field) => field.name), rows: result.rows }));
		} catch (error) {
			await client.query("rollback").catch(() => undefined);
			response.writeHead(500).end(String(error.message));
		} finally {
			client.release();
		}
	});
	return {
		listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
		close: async () => {
			server.close();
			await Promise.all([...pools.values()].map((entry) => entry.end()));
		},
		pools,
	};
}

const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
function get(port, path, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = http.get({ host: "127.0.0.1", port, path, agent, headers }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode, body }));
		});
		request.on("error", reject);
	});
}

async function drive(count, call) {
	const samples = [];
	let next = 0;
	let failed = 0;
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (next < count) {
				const index = next++;
				const started = now();
				const answer = await call(index);
				if (answer.status !== 200) failed++;
				samples.push(now() - started);
			}
		}),
	);
	return { ...percentiles(samples), failed };
}

const backends = (db, user) =>
	db.query("select count(*)::int as n from pg_stat_activity where usename = $1", [user]).then((result) => result.rows[0].n);

await build();
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

// ---- Shape A: our own gateway
const own = gateway();
const port = await own.listen();
const path = (index) => `/q/${name(1 + (index % COMPANIES))}/shop/sales-this-month?since=${encodeURIComponent(since)}`;
const before = process.memoryUsage().rss;
const cold = await drive(COMPANIES, (index) => get(port, path(index)));
const warm = await drive(CALLS, (index) => get(port, path(index)));
const one = await drive(CALLS, () => get(port, path(0)));
const rss = process.memoryUsage().rss;
const held = await withAdmin("postgres", (db) => backends(db, "cd_gateway"));
const sample = JSON.parse((await get(port, path(0))).body);
note(`own gateway, first call per company (opens a connection): ${JSON.stringify(cold)} ms`);
note(`own gateway, ${CALLS} calls spread over ${COMPANIES} companies, ${CONCURRENCY} at a time: ${JSON.stringify(warm)} ms`);
note(`own gateway, ${CALLS} calls to one company: ${JSON.stringify(one)} ms`);
note(`own gateway process: ${Math.round(rss / 1048576)} MiB resident (${Math.round(before / 1048576)} MiB before any call), holding ${held} connections for ${own.pools.size} companies`);
note(`answer: ${JSON.stringify(sample)}`);
check("own gateway answers every call", cold.failed === 0 && warm.failed === 0 && one.failed === 0);
check("own gateway warm p95 under 20 ms", warm.p95 < 20, `p95 ${warm.p95} ms`);
await sleep(6500);
const idle = await withAdmin("postgres", (db) => backends(db, "cd_gateway"));
check("own gateway gives idle connections back", idle === 0, `${idle} held after 6.5 s idle`);
await own.close();

// ---- Shape B: a PostgREST per company
const images = spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).stdout
	.split("\n")
	.filter((line) => /postgrest/i.test(line) && !/<none>/.test(line));
const image = process.env.CDPROOF_POSTGREST_IMAGE || images[0];
if (!image) {
	note("PostgREST: no image on this machine and none named in CDPROOF_POSTGREST_IMAGE: not measured");
} else {
	const INSTANCES = 10;
	note(`PostgREST image: ${image}; ${INSTANCES} instances, one per company database`);
	await withAdmin("postgres", async (db) => {
		await db.query("create role cd_rest login noinherit password 'rest-proof'");
		for (let index = 1; index <= INSTANCES; index++) {
			await db.query(`grant ${name(index)}_read to cd_rest; grant connect on database ${name(index)} to cd_rest`);
		}
	});
	const containers = [];
	const ports = [];
	for (let index = 1; index <= INSTANCES; index++) {
		const container = `cdrest-${process.env.CDPROOF_PID}-${index}`;
		const started = spawnSync(
			"docker",
			[
				"run", "-d", "--name", container, "--network", "host", "--memory", "256m",
				"-e", `PGRST_DB_URI=postgres://cd_rest:rest-proof@127.0.0.1:${process.env.PGPORT}/${name(index)}`,
				"-e", "PGRST_DB_SCHEMAS=shop",
				"-e", `PGRST_DB_ANON_ROLE=${name(index)}_read`,
				"-e", `PGRST_SERVER_PORT=${39000 + index}`,
				"-e", "PGRST_SERVER_HOST=127.0.0.1",
				"-e", `PGRST_ADMIN_SERVER_PORT=${39100 + index}`,
				image,
			],
			{ encoding: "utf8" },
		);
		if (started.status !== 0) {
			note(`PostgREST ${index} did not start: ${started.stderr.trim().slice(0, 300)}`);
			break;
		}
		containers.push(container);
		ports.push(39000 + index);
	}
	if (containers.length === INSTANCES) {
		let ready = false;
		for (let attempt = 0; attempt < 60 && !ready; attempt++) {
			await sleep(500);
			const answers = await Promise.all(
				ports.map((p) => get(p, `/rpc/sales_since?since=${encodeURIComponent(since)}`).catch(() => ({ status: 0 }))),
			);
			ready = answers.every((answer) => answer.status === 200);
		}
		check("every PostgREST answers", ready);
		if (ready) {
			const restWarm = await drive(CALLS, (index) =>
				get(ports[index % INSTANCES], `/rpc/sales_since?since=${encodeURIComponent(since)}`),
			);
			const restHeld = await withAdmin("postgres", (db) => backends(db, "cd_rest"));
			await sleep(6500);
			const restIdle = await withAdmin("postgres", (db) => backends(db, "cd_rest"));
			const stats = spawnSync("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}", ...containers], {
				encoding: "utf8",
			}).stdout.trim();
			const mib = stats
				.split("\n")
				.map((line) => /([\d.]+)MiB/.exec(line))
				.filter(Boolean)
				.map((match) => Number(match[1]));
			note(`PostgREST, ${CALLS} calls spread over ${INSTANCES} companies: ${JSON.stringify(restWarm)} ms`);
			note(`PostgREST memory per instance: ${mib.map((value) => Math.round(value)).join(", ")} MiB (sum ${Math.round(mib.reduce((a, b) => a + b, 0))} MiB for ${INSTANCES})`);
			note(`PostgREST connections held: ${restHeld} right after the calls, ${restIdle} after 6.5 s idle, for ${INSTANCES} companies`);
			note(`PostgREST sample: ${(await get(ports[0], `/rpc/sales_since?since=${encodeURIComponent(since)}`)).body.slice(0, 120)}`);
		} else {
			note(spawnSync("docker", ["logs", "--tail", "15", containers[0]], { encoding: "utf8" }).stderr.slice(0, 1200));
		}
	}
	for (const container of containers) spawnSync("docker", ["rm", "-f", "-v", container]);
}
finish();
