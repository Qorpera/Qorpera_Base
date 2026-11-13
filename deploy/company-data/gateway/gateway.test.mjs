/* The data gateway (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3) against a real PostgreSQL 17: the store is set
 * up from store/cluster.sql and store/template.sql, as the proof does, in a throwaway container on a random loopback
 * port (2 CPUs, 4 GiB, removed at the end). The platform is a stand-in: an in-memory company folder per company with
 * read rights per member, answering the two folder reads the gateway makes in the shapes the platform gives. The
 * gateway is driven over its own HTTP side. Limits are small, so the file runs in well under a minute.
 * Run on a test machine: node --test deploy/company-data/gateway/gateway.test.mjs */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { checkLocale, LOCALE_QUERY, POSTGRES_IMAGE, POSTGRES_LOCALE } from "../../../scripts/test-hosted-db.mjs";
import { companyDatabase, folderPassword, Gateway, LIMITS, Platform, serve } from "./gateway.mjs";

const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storeFile = (name) => readFileSync(new URL(`../store/${name}`, import.meta.url));

const LIMITS_HERE = {
	...LIMITS,
	questionMs: 300,
	questionRows: 50,
	questionBytes: 4096,
	stepMs: 5_000,
	stepLockMs: 1_000,
	watchMs: 4_000,
	watchAgainMs: 50,
	proofMs: 0,
	bodyBytes: 8192,
};

// ---- two companies and their members
const ENV_A = "64000000-0000-4000-8000-0000000000a0";
const ENV_B = "64000000-0000-4000-8000-0000000000b0";
const ENV_C = "64000000-0000-4000-8000-0000000000c0";
const person = (n) => `64000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const OWNER = person(1);
const CONTRIBUTOR = person(2);
const VIEWER = person(3);
const STRANGER = person(9);
const B_MEMBER = person(11);
const MEMBERS = { [ENV_A]: new Set([OWNER, CONTRIBUTOR, VIEWER]), [ENV_B]: new Set([B_MEMBER]), [ENV_C]: new Set([OWNER]) };
/** Folders only one member may read, as a path resource of scope member_private makes them. */
const PRIVATE = { [ENV_A]: { "data/hr": CONTRIBUTOR }, [ENV_B]: {}, [ENV_C]: {} };

// ---- the stand-in platform: the folders, the tokens it knows, and its two reads
const FOLDERS = { [ENV_A]: new Map(), [ENV_B]: new Map(), [ENV_C]: new Map() };
const TEXTS = new Map();
const put = (env, files) => {
	for (const [path, text] of Object.entries(files)) {
		FOLDERS[env].set(path, text);
		TEXTS.set(sha256(text), text);
	}
};
const remove = (env, path) => FOLDERS[env].delete(path);
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const KNOWN = new Map();
/** A token the platform knows. Unsigned: the gateway only reads its `sub`, and the stand-in decides who is known. */
const tokenOf = (userId) => {
	const token = `${part({ alg: "none", typ: "JWT" })}.${part({ role: "authenticated", sub: userId })}.unsigned`;
	KNOWN.set(token, userId);
	return token;
};
const mayRead = (env, userId, path) =>
	MEMBERS[env]?.has(userId) === true &&
	Object.entries(PRIVATE[env] ?? {}).every(([folder, only]) => only === userId || !(path === folder || path.startsWith(`${folder}/`)));
let platformCalls = 0;
async function platformFetch(url, init) {
	platformCalls++;
	const reply = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
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
			const prefix = `${args.p_parent}/`;
			const entries = [...files.keys()]
				.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && mayRead(env, userId, path))
				.sort()
				.slice(0, args.p_limit)
				.map(entry);
			return reply(200, { entries });
		}
		default:
			return reply(404, { message: "no such function" });
	}
}

// ---- the files of company A's databases
const ORDERS = `create table orders (
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
const COUNT = "-- How many orders there are.\nselect count(*) as orders from orders;\n";
/** Every name a question's statement in the gateway has used for its own: aliases, CTEs and added columns. */
const NAMES = [
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
put(ENV_A, {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": ORDERS,
	"data/shop/tables/002-order-notes.sql":
		"alter table orders add column note text;\ncreate view order_totals as select status, count(*) as orders, sum(amount) as total from orders group by status;\n",
	"data/shop/queries/sales-since.sql":
		"-- What the shop sold since a day.\nselect count(*) as orders, coalesce(sum(amount), 0) as total from orders where placed_at >= :since::timestamptz;\n",
	"data/shop/queries/count.sql": COUNT,
	"data/shop/queries/by-status.sql": "select status, orders, total from order_totals order by status;\n",
	"data/shop/queries/mine.sql": "select count(*) as orders from orders where placed_by = :viewer::uuid;\n",
	"data/shop/queries/types.sql": `-- Every kind of value, as an answer gives it.
select 9007199254740993::bigint as big, 42::bigint as small, 7::int as whole, 1.5::float8 as double,
	12345678901234567890.123456789::numeric as precise, 12.50::numeric(10,2) as price, 0.1::numeric as tenth,
	true as yes, false as no, '{"a":[1,2]}'::jsonb as doc, '[1,"x"]'::json as list,
	'2026-11-13 10:00:00.5+01'::timestamptz as at, '2026-11-13 10:00:00'::timestamp as local,
	null::text as nothing, 'plain'::text as words;
`,
	"data/shop/queries/many.sql": "select n from generate_series(1, 100) n;\n",
	"data/shop/queries/wide.sql": "select repeat('x', 200) as text from generate_series(1, 40);\n",
	"data/shop/queries/wide-letters.sql": "select repeat('æ', 150) as text from generate_series(1, 20);\n",
	// Rows far past the answer's size: 8 rows of 1 MiB each, and one row of 1 MiB before a small one.
	"data/shop/queries/huge.sql": "select repeat('x', 1048576) as text from generate_series(1, 8);\n",
	"data/shop/queries/huge-first.sql": "select repeat('x', 1048576) as text union all select 'small';\n",
	"data/shop/queries/none.sql": "select n from generate_series(1, 0) n;\n",
	// Columns named like the names the gateway's statement uses, the old ones and the ones it has now.
	"data/shop/queries/shadow.sql": "select '' as qorpera_asked, repeat('x', 1048576) as payload;\n",
	"data/shop/queries/names.sql": `select ${NAMES.map((name, index) => `${index + 1} as ${name}`).join(", ")} from generate_series(1, 100);\n`,
	"data/shop/queries/names-wide.sql":
		"select repeat('x', 300) as qorpera_bytes_so_far, 1 as qorpera_rows_made, n - n + 1 as qorpera_at from generate_series(1, 40) n;\n",
	"data/shop/queries/slow.sql": "select pg_sleep(5) as waited;\n",
	"data/shop/queries/nap.sql": "select pg_sleep(0.2) as napped, :k::int as k;\n",
	"data/shop/queries/stubborn.sql": "select stubborn() as never;\n",
	"data/kinds/database.toml": 'format = "qorpera.database/v1"\n',
	"data/kinds/tables/001-items.sql": `create type mood as enum ('ok', 'bad');
create domain price as numeric(10,2) check (value >= 0);
create table items (id int primary key, mood mood not null, cost price not null);
insert into items select n, case when n % 2 = 0 then 'ok' else 'bad' end::mood, n from generate_series(1, 6) n;
`,
	"data/shop/queries/writes.sql": "insert into orders (customer, amount) values ('x', 1) returning id;\n",
	"data/shop/queries/two.sql": "select 1 as one; select 2 as two;\n",
	"data/shop/queries/escape.sql": "select set_config('role', 'none', true) as role, (select count(*) from qorpera_data.steps) as steps;\n",
	// Questions that try to reach the payroll folder from the shop's.
	"data/shop/queries/switch.sql": "select set_config('role', :role, true) as role;\n",
	"data/shop/queries/switch-then-peek.sql": "select set_config('role', :role, true) as role, peek() as salaries;\n",
	"data/shop/queries/peek.sql": "select peek() as salaries;\n",
	"data/shop/queries/peek-xml.sql": "select query_to_xml('select count(*) as n from payroll.salaries', false, false, '')::text as salaries;\n",
	"data/shop/queries/texts.sql": "select count(*) as texts from qorpera_data.texts;\n",
	"data/payroll/database.toml": 'format = "qorpera.database/v1"\nname = "Payroll"\n',
	"data/payroll/tables/001-salaries.sql": "create table salaries (name text primary key, monthly numeric(12,2) not null);\ninsert into salaries values ('Cy', 61000), ('Di', 58000);\n",
	"data/hr/database.toml": 'format = "qorpera.database/v1"\nname = "People"\n',
	"data/hr/tables/001-salaries.sql": "create table salaries (name text primary key, monthly numeric(12,2) not null);\ninsert into salaries values ('Ada', 52000), ('Bo', 47000);\n",
	"data/hr/queries/total.sql": "select sum(monthly) as monthly from salaries;\n",
	"data/risky/database.toml": 'format = "qorpera.database/v1"\n',
	"data/risky/tables/001-things.sql": "create table things (id int primary key, name text, weight int);\ninsert into things select n, 'thing ' || n, n from generate_series(1, 50) n;\n",
	"data/risky/tables/002-drop-weight.sql": "alter table things drop column weight;\ndelete from things where id <= 10;\n",
	"data/risky/queries/count.sql": "select count(*) as things, count(weight) as weights from things;\n",
	"data/broken/database.toml": 'format = "qorpera.database/v1"\n',
	"data/broken/tables/001-typo.sql": "create table a (id int primary key);\ncreate tabel b (id int);\n",
	"data/sneaky/database.toml": 'format = "qorpera.database/v1"\n',
	"data/sneaky/tables/001-base.sql": "create table ledger (id int primary key, amount int);\ninsert into ledger select n, n from generate_series(1, 20) n;\n",
	"data/sneaky/tables/002-commit.sql": "commit;\ndrop table ledger;\n",
	"data/guard/database.toml": 'format = "qorpera.database/v1"\n',
	"data/guard/tables/001-base.sql": `create table t (id int primary key, name text);
insert into t select n, 'row ' || n from generate_series(1, 10) n;
create table parent (id int primary key);
create table child (id int primary key, parent int not null references parent (id) on delete cascade);
insert into parent select n from generate_series(1, 3) n;
insert into child select n, 1 + n % 3 from generate_series(1, 9) n;
create function noop() returns trigger language plpgsql as $f$ begin return null; end $f$;
`,
	"data/qorpera/database.toml": 'format = "qorpera.database/v1"\n',
	"data/pg_things/database.toml": 'format = "qorpera.database/v1"\n',
	"data/qorpera_more/database.toml": 'format = "qorpera.database/v1"\n',
});
// Company B has a database of the same name, with the same tables.
// Company C is made by a gateway that fails once while it makes the company's database.
put(ENV_C, {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": ORDERS,
	"data/shop/queries/count.sql": COUNT,
});
put(ENV_B, {
	"data/shop/database.toml": 'format = "qorpera.database/v1"\nname = "Shop"\n',
	"data/shop/tables/001-orders.sql": ORDERS,
	"data/shop/queries/count.sql": COUNT,
});

describe("the data gateway against a real PostgreSQL", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
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
	const owner = tokenOf(OWNER);
	const contributor = tokenOf(CONTRIBUTOR);
	const viewer = tokenOf(VIEWER);
	const stranger = tokenOf(STRANGER);
	const bMember = tokenOf(B_MEMBER);
	// The platform has not seen this one: a token it did not sign.
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
	const psql = (database, file, variables = {}) => {
		const made = spawnSync(
			"docker",
			["exec", "-i", container, "psql", "-X", "-q", "-h", "127.0.0.1", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1",
				...Object.entries(variables).flatMap(([name, value]) => ["-v", `${name}=${value}`])],
			{ input: storeFile(file), encoding: "utf8" },
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

	/** One HTTP request to the gateway. */
	const send = ({ method = "POST", path, bearer, text = "" }) =>
		new Promise((resolve, reject) => {
			const request = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method,
					headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json", "content-length": Buffer.byteLength(text) },
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
	/** A call as the web makes it: when the gateway asks for a file's text, the caller reads the file and sends it. */
	const ask = async (bearer, verb, body, env = ENV_A) => {
		let answer = await call(bearer, verb, body, env);
		for (let round = 0; round < 3 && answer.status === 200 && answer.value.need; round++) {
			const texts = Object.fromEntries(answer.value.need.map((wanted) => [wanted.sha256, TEXTS.get(wanted.sha256)]));
			answer = await call(bearer, verb, { ...body, texts }, env);
		}
		return answer;
	};
	const states = (answer) => answer.value.results?.map((result) => `${result.name} ${result.state}`);

	before(async () => {
		try {
			const started = spawnSync(
				"docker",
				["run", "-d", "--name", container, "--cpus", "2", "--memory", "4g", "--shm-size", "256m", "-e", `POSTGRES_PASSWORD=${superPassword}`,
					...POSTGRES_LOCALE, "-p", "127.0.0.1::5432", POSTGRES_IMAGE, "-c", "max_connections=100",
					// The server logs every statement and error, so a test can show that a company's database writes none.
					"-c", "log_statement=all", "-c", "log_min_duration_statement=0"],
				{ encoding: "utf8" },
			);
			if (started.status !== 0) throw new Error(`PostgreSQL did not start: ${started.stderr}`);
			const published = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout;
			storePort = Number(/^127\.0\.0\.1:(\d+)$/m.exec(published)?.[1]);
			assert.ok(storePort > 0, `no loopback port: ${published}`);
			let ready = false;
			for (let attempt = 0; attempt < 240 && !ready; attempt++) {
				ready = spawnSync("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", "select 1"], { stdio: "ignore" }).status === 0;
				if (!ready) await sleep(250);
			}
			assert.ok(ready, "PostgreSQL did not become ready");
			checkLocale(spawnSync("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", LOCALE_QUERY], { encoding: "utf8" }).stdout);
			psql("postgres", "cluster.sql", { admin_password: logins.admin, keeper_password: logins.keeper, watch_password: logins.watch });
			psql("qorpera_company_template", "template.sql");
			gateway = new Gateway({
				store: { host: "127.0.0.1", port: storePort, logins },
				platform: new Platform({ url: "http://platform/", publishableKey: "publishable", fetch: platformFetch }),
				limits: LIMITS_HERE,
			});
			server = await serve(gateway);
			port = server.address().port;
		} catch (error) {
			spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
			throw error;
		}
	});

	after(async () => {
		if (server) {
			server.close();
			server.closeAllConnections();
		}
		if (gateway) await gateway.close();
		spawnSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
	});

	// ---- steps
	it("applies a database's steps from the folder's files, asking for each text it does not hold by its hash", async () => {
		const first = await call(contributor, "apply", { database: "shop" });
		assert.equal(first.status, 200);
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/shop/tables/001-orders.sql", "data/shop/tables/002-order-notes.sql"]);
		const wrong = await call(contributor, "apply", {
			database: "shop",
			texts: Object.fromEntries(first.value.need.map((wanted) => [wanted.sha256, "drop table everything;"])),
		});
		assert.equal(wrong.value.need?.length, 2, "a text whose hash is not the folder's is not used");
		const applied = await ask(contributor, "apply", { database: "shop" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		assert.deepEqual(states(applied), ["001-orders applied", "002-order-notes applied"]);
	});

	it("applies nothing twice", async () => {
		const again = await ask(viewer, "apply", { database: "shop" });
		assert.equal(again.value.applied, true);
		assert.deepEqual(states(again), ["001-orders already", "002-order-notes already"]);
	});

	it("describes a database as its files made it, and every new table carries Qorpera's three triggers", async () => {
		const described = await call(viewer, "describe", { database: "shop" });
		assert.equal(described.status, 200);
		assert.deepEqual(described.value.tables.map((table) => table.name), ["order_totals", "orders"]);
		assert.deepEqual(described.value.applied.map((step) => step.name), ["001-orders", "002-order-notes"]);
		assert.ok(described.value.companyBytes > 0);
		const orders = described.value.tables.find((table) => table.name === "orders");
		assert.deepEqual(orders.columns.map((column) => column.name), ["id", "customer", "amount", "status", "placed_by", "placed_at", "note"]);
		const triggers = await asAdmin(companyDatabase(ENV_A), "select tgname from pg_trigger where tgrelid = 'shop.orders'::regclass and not tgisinternal order by 1");
		assert.deepEqual(triggers.map((row) => row.tgname), ["qorpera_changed", "qorpera_emptied", "qorpera_rows_gone"]);
	});

	// ---- questions
	let since = null;
	let sales = null;

	it("answers a question with columns, rows as arrays, numbers as numbers, an etag and when", async () => {
		// After the step ran: of its rows placed 1 to 240 hours before it, 23 are within a day now.
		since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
		const needed = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(needed.value.need?.[0]?.path, "data/shop/queries/sales-since.sql");
		sales = await ask(viewer, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(sales.status, 200, JSON.stringify(sales.value));
		assert.deepEqual(sales.value.columns, ["orders", "total"]);
		assert.equal(sales.value.rows.length, 1);
		assert.equal(sales.value.rows[0][0], 23);
		assert.equal(typeof sales.value.rows[0][1], "number");
		assert.equal(sales.value.more, false);
		assert.match(sales.value.etag, /^[0-9a-f]{32}$/);
		assert.ok(Math.abs(Date.parse(sales.value.asOf) - Date.now()) < 5_000);
		// Another member needs no text: the gateway holds it by its hash.
		const kept = await call(owner, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(kept.status, 200);
		assert.deepEqual(kept.value.rows, sales.value.rows);
	});

	it("says the same when the page already holds the answer", async () => {
		const same = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since }, etag: sales.value.etag });
		assert.deepEqual(same.value, { same: true, etag: sales.value.etag });
		const other = await call(viewer, "query", { database: "shop", question: "sales-since", params: { since }, etag: "an-old-etag" });
		assert.ok(Array.isArray(other.value.rows));
	});

	it("gives each kind of value its JSON shape, and no digit is lost", async () => {
		const types = await ask(viewer, "query", { database: "shop", question: "types" });
		assert.equal(types.status, 200, JSON.stringify(types.value));
		const row = Object.fromEntries(types.value.columns.map((column, index) => [column, types.value.rows[0][index]]));
		assert.deepEqual(row, {
			big: "9007199254740993",
			small: 42,
			whole: 7,
			double: 1.5,
			precise: "12345678901234567890.123456789",
			price: 12.5,
			tenth: 0.1,
			yes: true,
			no: false,
			doc: { a: [1, 2] },
			list: [1, "x"],
			at: "2026-11-13T09:00:00.5Z",
			local: "2026-11-13T10:00:00",
			nothing: null,
			words: "plain",
		});
	});

	it("refuses someone who is not a member the same as a question that is not there, and a token the platform does not know", async () => {
		const noOne = await call(stranger, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(noOne.status, 404);
		assert.equal(noOne.value.error, "No question shop/sales-since that you may read");
		const missing = await call(viewer, "query", { database: "shop", question: "nothing-here" });
		assert.equal(missing.status, 404);
		const bad = await call(forged, "query", { database: "shop", question: "sales-since", params: { since } });
		assert.equal(bad.status, 401);
		const none = await send({ path: `/v1/company-data/${ENV_A}/query`, text: "{}" });
		assert.equal(none.status, 401);
	});

	it("lets only the members the folder lets read a private database's questions", async () => {
		const otherApply = await call(viewer, "apply", { database: "hr" });
		assert.equal(otherApply.status, 404);
		const applied = await ask(contributor, "apply", { database: "hr" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		const its = await ask(contributor, "query", { database: "hr", question: "total" });
		assert.deepEqual(its.value.rows, [[99000]]);
		for (const other of [viewer, owner]) {
			const refused = await ask(other, "query", { database: "hr", question: "total" });
			assert.equal(refused.status, 404);
			assert.equal(refused.value.error, "No question hr/total that you may read");
		}
		assert.equal((await call(viewer, "describe", { database: "hr" })).status, 404);
	});

	it("fills :viewer with the member looking, and refuses a page that sends it", async () => {
		await asAdmin(companyDatabase(ENV_A), "update shop.orders set placed_by = $1 where id <= 7", [VIEWER]);
		const mine = await ask(viewer, "query", { database: "shop", question: "mine" });
		const theirs = await ask(owner, "query", { database: "shop", question: "mine" });
		assert.deepEqual([mine.value.rows, theirs.value.rows], [[[7]], [[0]]]);
		const pretend = await ask(owner, "query", { database: "shop", question: "mine", params: { viewer: VIEWER } });
		assert.equal(pretend.status, 400);
		assert.match(pretend.value.error, /:viewer is filled by Qorpera/);
		const unknown = await ask(owner, "query", { database: "shop", question: "count", params: { other: 1 } });
		assert.equal(unknown.status, 400);
		const lacking = await ask(owner, "query", { database: "shop", question: "sales-since" });
		assert.equal(lacking.status, 400);
		assert.match(lacking.value.error, /takes :since/);
	});

	// ---- what a question may not do
	it("stops a slow question at its limit", async () => {
		const began = Date.now();
		const slow = await ask(viewer, "query", { database: "shop", question: "slow" });
		assert.equal(slow.status, 408, JSON.stringify(slow.value));
		assert.ok(Date.now() - began < 2_000, `${Date.now() - began} ms`);
	});

	it("refuses a question that writes, one of two statements, and one that reads the gateway's records", async () => {
		const writes = await ask(viewer, "query", { database: "shop", question: "writes" });
		assert.equal(writes.status, 400, JSON.stringify(writes.value));
		const two = await ask(viewer, "query", { database: "shop", question: "two" });
		assert.equal(two.status, 400);
		const escape = await ask(viewer, "query", { database: "shop", question: "escape" });
		assert.equal(escape.status, 400, JSON.stringify(escape.value));
		const count = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as n from shop.orders");
		assert.equal(count[0].n, 240);
	});

	it("gives at most the row limit, with more: true", async () => {
		const many = await ask(viewer, "query", { database: "shop", question: "many" });
		assert.equal(many.value.rows.length, LIMITS_HERE.questionRows);
		assert.equal(many.value.more, true);
	});

	it("gives at most the byte limit, counted in bytes, with more: true", async () => {
		for (const question of ["wide", "wide-letters"]) {
			const wide = await ask(viewer, "query", { database: "shop", question });
			assert.equal(wide.status, 200);
			assert.equal(wide.value.more, true, question);
			assert.ok(wide.value.rows.length > 0);
			assert.ok(Buffer.byteLength(JSON.stringify(wide.value.rows)) <= LIMITS_HERE.questionBytes, question);
		}
	});

	it("never takes rows past the answer's size from the store", async () => {
		const before = gateway.taken.bytes;
		for (const question of ["huge", "huge-first"]) {
			const huge = await ask(viewer, "query", { database: "shop", question });
			assert.equal(huge.status, 200, JSON.stringify(huge.value).slice(0, 200));
			assert.deepEqual(huge.value.rows, [], question);
			assert.equal(huge.value.more, true, question);
			assert.deepEqual(huge.value.columns, ["text"], question);
		}
		// 9 MiB of rows were made in the store; none of it came over.
		assert.equal(gateway.taken.bytes - before, 0);
		const none = await ask(viewer, "query", { database: "shop", question: "none" });
		assert.deepEqual([none.value.rows, none.value.more, none.value.columns], [[], false, ["n"]]);
	});

	it("counts a question's size by its whole row, whatever its columns are named", async () => {
		// A column named like the gateway's own words cannot stand for the whole row: 1 MiB still never comes over.
		const before = gateway.taken.bytes;
		const shadow = await ask(viewer, "query", { database: "shop", question: "shadow" });
		assert.equal(shadow.status, 200, JSON.stringify(shadow.value).slice(0, 200));
		assert.deepEqual([shadow.value.rows, shadow.value.more, shadow.value.columns], [[], true, ["qorpera_asked", "payload"]]);
		assert.equal(gateway.taken.bytes - before, 0);
		// Columns named like every name the gateway adds: the question answers its own values, and the limits hold.
		const names = await ask(viewer, "query", { database: "shop", question: "names" });
		assert.equal(names.status, 200, JSON.stringify(names.value).slice(0, 300));
		assert.deepEqual(names.value.columns, NAMES);
		assert.equal(names.value.rows.length, LIMITS_HERE.questionRows);
		assert.deepEqual(names.value.rows[0], NAMES.map((_, index) => index + 1));
		assert.equal(names.value.more, true);
		const wide = await ask(viewer, "query", { database: "shop", question: "names-wide" });
		assert.equal(wide.status, 200, JSON.stringify(wide.value).slice(0, 300));
		assert.deepEqual(wide.value.columns, ["qorpera_bytes_so_far", "qorpera_rows_made", "qorpera_at"]);
		assert.equal(wide.value.more, true);
		assert.ok(wide.value.rows.length > 0 && wide.value.rows.length < 40);
		assert.deepEqual(wide.value.rows[0].slice(1), [1, 1]);
		assert.ok(Buffer.byteLength(JSON.stringify(wide.value.rows)) <= LIMITS_HERE.questionBytes);
	});

	// ---- steps that must not land
	it("holds a step that destroys data, with what it would destroy, and changes nothing", async () => {
		const risky = await ask(contributor, "apply", { database: "risky" });
		assert.equal(risky.value.applied, false);
		const held = risky.value.results.find((result) => result.name === "002-drop-weight");
		assert.equal(held.state, "held");
		assert.ok(held.destroys.some((effect) => effect.what === "dropped table column" && effect.object === "risky.things.weight"), JSON.stringify(held));
		assert.ok(held.destroys.some((effect) => effect.what === "deleted rows" && effect.rows === 10), JSON.stringify(held));
		const count = await ask(viewer, "query", { database: "risky", question: "count" });
		assert.deepEqual(count.value.rows, [[50, 50]]);
	});

	it("fails a step with a mistake in PostgreSQL's words and keeps nothing of it", async () => {
		const broken = await ask(contributor, "apply", { database: "broken" });
		assert.equal(broken.value.results[0].state, "failed");
		assert.match(broken.value.results[0].detail, /tabel/);
		const described = await call(viewer, "describe", { database: "broken" });
		assert.deepEqual([described.value.tables, described.value.applied], [[], []]);
	});

	it("fails a step that tries to end the transaction, and what follows it does not run", async () => {
		const sneaky = await ask(contributor, "apply", { database: "sneaky" });
		const commits = sneaky.value.results.find((result) => result.name === "002-commit");
		assert.equal(commits.state, "failed");
		assert.match(commits.detail, /cannot end it/);
		const ledger = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as n from sneaky.ledger");
		assert.equal(ledger[0].n, 20);
	});

	it("refuses, the moment it happens, a step that switches off, replaces or drops Qorpera's triggers, or an unlogged table", async () => {
		const base = await ask(contributor, "apply", { database: "guard" });
		assert.deepEqual(states(base), ["001-base applied"]);
		const database = companyDatabase(ENV_A);
		const rows = async () =>
			(await asAdmin(database, "select (select count(*) from guard.t) || '/' || (select count(*) from guard.parent) || '/' || (select count(*) from guard.child) as n"))[0].n;
		const before = await rows();
		assert.equal(before, "10/3/9");
		const stay = (trigger) => new RegExp(`Qorpera's trigger ${trigger} on guard\\.t must stay as Qorpera made it`);
		const refused = [
			["alter table t disable trigger user;\ndelete from t;\nalter table t enable trigger user;\n", stay("qorpera_\\w+")],
			["alter table t disable trigger qorpera_rows_gone;\ndelete from t where id = 1;\n", stay("qorpera_rows_gone")],
			["alter table t enable replica trigger qorpera_changed;\n", stay("qorpera_changed")],
			["drop trigger qorpera_rows_gone on t;\n", /Qorpera's trigger qorpera_rows_gone on guard\.t cannot be dropped/],
			["create or replace trigger qorpera_rows_gone after delete on t for each statement execute function noop();\ndelete from t;\n", stay("qorpera_rows_gone")],
			["create or replace trigger qorpera_rows_gone after insert on t referencing new table as gone for each statement execute function qorpera_data.rows_gone();\n", stay("qorpera_rows_gone")],
			["create or replace trigger qorpera_rows_gone after delete on t referencing old table as gone for each statement when (false) execute function qorpera_data.rows_gone();\ndelete from t;\n", stay("qorpera_rows_gone")],
			["create trigger qorpera_x after insert on t for each statement execute function noop();\n", stay("qorpera_x")],
			["alter trigger qorpera_rows_gone on t rename to kept;\nalter table t disable trigger kept;\ndelete from t;\n", /Qorpera's triggers on guard\.t are missing/],
			["create unlogged table u (id int);\n", /Qorpera keeps every table logged: guard\.u is not/],
			["alter table t set unlogged;\n", /Qorpera keeps every table logged: guard\.t is not/],
			["set local session_replication_role = replica;\ndelete from t;\n", /permission denied/],
			["alter event trigger qorpera_guard disable;\nalter table t disable trigger user;\ndelete from t;\n", /must be owner|permission denied/],
			["delete from t where id = 1;\ndelete from qorpera_data.step_effects;\n", /permission denied/],
			// A deferred foreign key is checked before the step is judged: one that fails, fails the step.
			["create table d (id int primary key, p int references parent (id) deferrable initially deferred);\ninsert into d values (1, 999);\n", /violates foreign key constraint/],
			// Two stages: the first deferred trigger, run before the check, defers again and queues a second that would
			// delete at commit, after the check. The seal makes the commit fail.
			[
				"create table q (id int);\n" +
					"create function stage_two() returns trigger language plpgsql as $f$ begin delete from t where id <= 5; return null; end $f$;\n" +
					"create constraint trigger two after insert on q deferrable initially deferred for each row execute function stage_two();\n" +
					"create function stage_one() returns trigger language plpgsql as $f$ begin set constraints all deferred; insert into q values (1); return null; end $f$;\n" +
					"create constraint trigger one after insert on t deferrable initially deferred for each row execute function stage_one();\n" +
					"insert into t values (100, 'late');\n",
				/A step may not destroy data after it was checked: rows of guard\.t were deleted/,
			],
		];
		for (const [text, problem] of refused) {
			put(ENV_A, { "data/guard/tables/002-try.sql": text });
			const tried = await ask(contributor, "apply", { database: "guard" });
			assert.deepEqual(states(tried), ["001-base already", "002-try failed"], text);
			assert.match(tried.value.results[1].detail, problem, text);
		}
		const held = [
			// The child's rows go by the cascade of the parent's delete: they are counted too.
			["delete from parent where id = 1;\n", [["deleted rows", "guard.child", 3], ["deleted rows", "guard.parent", 1]]],
			["merge into t using (select 2 as id) s on t.id = s.id when matched then delete;\n", [["deleted rows", "guard.t", 1]]],
			// A deferred trigger would delete at commit, after the effects were read: it runs before they are.
			[
				"create function wipe() returns trigger language plpgsql as $f$ begin delete from t where id <= 5; return null; end $f$;\n" +
					"create constraint trigger later after insert on t deferrable initially deferred for each row execute function wipe();\n" +
					"insert into t values (100, 'late');\n",
				[["deleted rows", "guard.t", 5]],
			],
		];
		for (const [text, destroys] of held) {
			put(ENV_A, { "data/guard/tables/002-try.sql": text });
			const tried = await ask(contributor, "apply", { database: "guard" });
			assert.deepEqual(states(tried), ["001-base already", "002-try held"], text);
			assert.deepEqual(tried.value.results[1].destroys.map((effect) => [effect.what, effect.object, effect.rows]), destroys, text);
		}
		assert.equal(await rows(), before);
		const triggers = await asAdmin(database, "select tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text as t from pg_trigger where tgrelid in ('guard.t'::regclass, 'guard.child'::regclass) and not tgisinternal and tgname like 'qorpera%' order by 1");
		assert.deepEqual(triggers.map((row) => row.t), ["guard.t qorpera_changed O", "guard.t qorpera_emptied O", "guard.t qorpera_rows_gone O", "guard.child qorpera_changed O", "guard.child qorpera_emptied O", "guard.child qorpera_rows_gone O"].sort());
		const recorded = await asAdmin(database, "select name from qorpera_data.steps where database = 'guard' order by name");
		assert.deepEqual(recorded.map((row) => row.name), ["001-base"]);
		// Honest deferred work that only adds rows, also at commit, lands.
		put(ENV_A, {
			"data/guard/tables/002-try.sql":
				"create table e (id int primary key, p int references parent (id) deferrable initially deferred);\n" +
				"create table e_log (n int);\n" +
				"create function log_e() returns trigger language plpgsql as $f$ begin insert into e_log values (1); return null; end $f$;\n" +
				"create constraint trigger logged after insert on e deferrable initially deferred for each row execute function log_e();\n" +
				"insert into e values (1, 1), (2, 2);\n",
		});
		const honest = await ask(contributor, "apply", { database: "guard" });
		assert.deepEqual(states(honest), ["001-base already", "002-try applied"], JSON.stringify(honest.value));
		const logged = await asAdmin(database, "select (select count(*) from guard.e) || '/' || (select count(*) from guard.e_log) as n");
		assert.equal(logged[0].n, "2/2");
		assert.equal(await rows(), before);
	});

	it("stops applying when an applied step was changed or is gone, and refuses a new step numbered at or below an applied one", async () => {
		const original = FOLDERS[ENV_A].get("data/shop/tables/001-orders.sql");
		put(ENV_A, { "data/shop/tables/001-orders.sql": original.replace("amount >= 0", "amount >= -1") });
		const changed = await ask(owner, "apply", { database: "shop" });
		assert.equal(changed.value.applied, false);
		assert.deepEqual(states(changed), ["001-orders changed"]);
		put(ENV_A, { "data/shop/tables/001-orders.sql": original });
		const notes = FOLDERS[ENV_A].get("data/shop/tables/002-order-notes.sql");
		remove(ENV_A, "data/shop/tables/002-order-notes.sql");
		const missing = await ask(owner, "apply", { database: "shop" });
		assert.deepEqual(states(missing), ["002-order-notes missing"]);
		put(ENV_A, { "data/shop/tables/002-order-notes.sql": notes, "data/shop/tables/000-early.sql": "create table early (id int);\n" });
		const early = await ask(owner, "apply", { database: "shop" });
		assert.equal(early.status, 400);
		assert.match(early.value.error, /000-early is numbered at or below 002-order-notes/);
		remove(ENV_A, "data/shop/tables/000-early.sql");
		put(ENV_A, { "data/shop/tables/003-customers.sql": "create table customers (id bigint generated always as identity primary key, name text not null);\n" });
		const third = await ask(owner, "apply", { database: "shop" });
		assert.equal(third.value.applied, true);
		assert.deepEqual(states(third), ["001-orders already", "002-order-notes already", "003-customers applied"]);
	});

	it("asks the question the folder holds now: a changed file is live at the next call", async () => {
		put(ENV_A, { "data/shop/queries/by-status.sql": "select status, orders, total, round(total / orders, 2) as average from order_totals order by status;\n" });
		const changed = await ask(owner, "query", { database: "shop", question: "by-status" });
		assert.deepEqual(changed.value.columns, ["status", "orders", "total", "average"]);
	});

	// ---- one folder cannot reach another's
	it("keeps each database folder's SQL inside its own folder: no step or question reaches another's rows", async () => {
		const database = companyDatabase(ENV_A);
		const payroll = await ask(owner, "apply", { database: "payroll" });
		assert.deepEqual(states(payroll), ["001-salaries applied"]);
		put(ENV_A, {
			"data/shop/tables/004-peek.sql":
				"create function peek() returns bigint language plpgsql as $f$\ndeclare v_n bigint;\nbegin\n\texecute 'select count(*) from payroll.salaries' into v_n;\n\treturn v_n;\nend $f$;\n",
		});
		assert.deepEqual(states(await ask(owner, "apply", { database: "shop" })).at(-1), "004-peek applied");
		const numbers = Object.fromEntries((await asAdmin(database, "select name, n from qorpera_data.databases")).map((row) => [row.name, row.n]));
		const role = (folder, kind) => `${database}_${kind}${numbers[folder]}`;
		const salaries = async () => (await asAdmin(database, "select string_agg(name || ' ' || monthly, ', ' order by name) as s from payroll.salaries"))[0].s;
		const before = await salaries();
		assert.equal(before, "Cy 61000.00, Di 58000.00");

		// Steps of the shop, each refused, none recorded.
		const steps = [
			`set role "${role("payroll", "o")}";\ndelete from payroll.salaries;\n`,
			`set role "${role("payroll", "r")}";\n`,
			"reset role;\ndelete from payroll.salaries;\n",
			`set session authorization "${role("payroll", "o")}";\ndelete from payroll.salaries;\n`,
			"insert into payroll.salaries values ('Eve', 1);\n",
			"create table copied as select * from payroll.salaries;\n",
			"select peek();\n",
			`select qorpera_data.record_step('payroll', '009-forged', '${"0".repeat(64)}');\n`,
			"select count(*) from qorpera_data.texts;\n",
		];
		for (const text of steps) {
			put(ENV_A, { "data/shop/tables/005-try.sql": text });
			const tried = await ask(owner, "apply", { database: "shop" });
			assert.equal(states(tried).at(-1), "005-try failed", `${text}: ${JSON.stringify(tried.value)}`);
			assert.match(tried.value.results.at(-1).detail, /permission denied|Only the database folder's own owner/, text);
		}
		remove(ENV_A, "data/shop/tables/005-try.sql");
		const recorded = await asAdmin(database, "select database || '/' || name as step from qorpera_data.steps where database = 'payroll'");
		assert.deepEqual(recorded.map((row) => row.step), ["payroll/001-salaries"]);

		// Questions of the shop, each refused, none with a payroll row.
		for (const kind of ["o", "w", "r"]) {
			const switched = await ask(viewer, "query", { database: "shop", question: "switch", params: { role: role("payroll", kind) } });
			assert.equal(switched.status, 400, JSON.stringify(switched.value));
			assert.match(switched.value.error, /permission denied to set role/);
			const peeked = await ask(viewer, "query", { database: "shop", question: "switch-then-peek", params: { role: role("payroll", kind) } });
			assert.equal(peeked.status, 400, JSON.stringify(peeked.value));
		}
		for (const question of ["peek", "peek-xml", "texts"]) {
			const peeked = await ask(viewer, "query", { database: "shop", question });
			assert.equal(peeked.status, 400, `${question}: ${JSON.stringify(peeked.value)}`);
			assert.match(peeked.value.error, /permission denied/, question);
		}

		// A folder's read login cannot write, its write login cannot make tables, and neither lifts its temp file limit.
		const reader = connect(database, role("shop", "r"), folderPassword(logins.folderKey, role("shop", "r")));
		const writer = connect(database, role("shop", "w"), folderPassword(logins.folderKey, role("shop", "w")));
		await reader.connect();
		await writer.connect();
		try {
			const code = (work) => work.then(() => "done", (error) => error.code);
			assert.equal(await code(reader.query("insert into shop.orders (customer, amount) values ('x', 1)")), "42501");
			assert.equal(await code(writer.query("create table shop.made (id int)")), "42501");
			assert.equal(await code(writer.query("insert into shop.orders (customer, amount) values ('w', 1)")), "done");
			assert.equal(await code(writer.query("delete from shop.orders where customer = 'w'")), "done");
			assert.equal((await reader.query("show temp_file_limit")).rows[0].temp_file_limit, "256MB");
			assert.equal(await code(reader.query("set temp_file_limit = '1GB'")), "42501");
			for (const setting of ["log_min_messages = 'debug1'", "log_min_error_statement = 'error'", "log_min_duration_statement = 0", "log_statement = 'all'"])
				assert.equal(await code(reader.query(`set ${setting}`)), "42501", setting);
			assert.equal(await code(reader.query(`set role "${role("payroll", "r")}"`)), "42501");
		} finally {
			await reader.end().catch(() => undefined);
			await writer.end().catch(() => undefined);
		}
		// No login is a member of a folder's role but the admin that made it.
		const members = await asAdmin(
			"postgres",
			"select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where r.rolname ~ '^c_[0-9a-f]{32}_[owr][0-9]+$' and u.rolname <> 'qorpera_data_admin'",
		);
		assert.equal(members[0].n, 0);
		assert.equal(await salaries(), before);
	});

	// ---- watch
	it("answers a watch with the same after its wait when nothing changed", async () => {
		const current = (await ask(viewer, "query", { database: "shop", question: "count" })).value;
		const began = Date.now();
		const nothing = await call(viewer, "watch", { watches: [{ database: "shop", question: "count", etag: current.etag }], wait: 1 });
		assert.deepEqual(nothing.value, { same: true });
		assert.ok(Date.now() - began >= 900, `${Date.now() - began} ms`);
	});

	it("answers a watch at once when the page holds an old answer", async () => {
		const began = Date.now();
		const stale = await call(viewer, "watch", { watches: [{ database: "shop", question: "count", etag: "an-old-etag" }], wait: 3 });
		assert.equal(stale.value.changed?.[0]?.index, 0);
		assert.equal(stale.value.changed[0].answer.rows[0][0], 240);
		assert.ok(Date.now() - began < 1_000, `${Date.now() - began} ms`);
	});

	it("answers a held watch when a row changes, and listens only while a watch is open", async () => {
		const current = (await ask(viewer, "query", { database: "shop", question: "count" })).value;
		const waiting = call(viewer, "watch", { watches: [{ database: "shop", question: "count", etag: current.etag }], wait: 3 });
		assert.equal(await until(listening, 1), 1);
		await asAdmin(companyDatabase(ENV_A), "insert into shop.orders (customer, amount) values ('Live', 150)");
		const answer = await waiting;
		assert.equal(answer.value.changed?.[0]?.answer.rows[0][0], current.rows[0][0] + 1, JSON.stringify(answer.value));
		assert.equal(await until(listening, 0), 0);
	});

	it("lets the listener go when the watching client goes away", async () => {
		const current = (await ask(viewer, "query", { database: "shop", question: "count" })).value;
		const text = JSON.stringify({ watches: [{ database: "shop", question: "count", etag: current.etag }], wait: 4 });
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `/v1/company-data/${ENV_A}/watch`,
			method: "POST",
			headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
		});
		request.on("error", () => undefined);
		request.end(text);
		assert.equal(await until(listening, 1), 1);
		const gone = Date.now();
		request.destroy();
		assert.equal(await until(listening, 0, 3_000), 0);
		assert.ok(Date.now() - gone < 1_500, `${Date.now() - gone} ms`);
	});

	// ---- two companies
	it("keeps two companies with the same database apart", async () => {
		assert.notEqual(companyDatabase(ENV_A), companyDatabase(ENV_B));
		const applied = await ask(bMember, "apply", { database: "shop" }, ENV_B);
		assert.deepEqual(states(applied), ["001-orders applied"]);
		await asAdmin(companyDatabase(ENV_B), "insert into shop.orders (customer, amount) values ('Only B', 1), ('Only B', 2)");
		const a = await ask(viewer, "query", { database: "shop", question: "count" });
		const b = await ask(bMember, "query", { database: "shop", question: "count" }, ENV_B);
		assert.deepEqual([a.value.rows[0][0], b.value.rows[0][0]], [241, 242]);
		const across = await ask(viewer, "query", { database: "shop", question: "count" }, ENV_B);
		assert.equal(across.status, 404);
		const back = await ask(bMember, "query", { database: "shop", question: "count" });
		assert.equal(back.status, 404);
		assert.equal((await call(viewer, "apply", { database: "shop" }, ENV_B)).status, 404);
	});

	// ---- the HTTP side
	it("answers only POST on its four calls, and refuses a body over its limit", async () => {
		assert.equal((await send({ method: "GET", path: `/v1/company-data/${ENV_A}/query`, bearer: viewer })).status, 405);
		assert.equal((await send({ path: `/v1/company-data/${ENV_A}/drop`, bearer: viewer, text: "{}" })).status, 404);
		assert.equal((await send({ path: "/elsewhere", bearer: viewer, text: "{}" })).status, 404);
		assert.equal((await send({ path: "/v1/company-data/not-a-company/query", bearer: viewer, text: "{}" })).status, 404);
		const large = JSON.stringify({ database: "shop", question: "count", note: "x".repeat(LIMITS_HERE.bodyBytes) });
		assert.equal((await send({ path: `/v1/company-data/${ENV_A}/query`, bearer: viewer, text: large })).status, 413);
		assert.equal((await send({ path: `/v1/company-data/${ENV_A}/query`, bearer: viewer, text: "not json" })).status, 400);
	});

	it("refuses a database named qorpera or starting with pg_ or qorpera_ at apply", async () => {
		for (const database of ["qorpera", "pg_things", "qorpera_more", "Shop", "1shop"]) {
			const refused = await call(owner, "apply", { database });
			assert.equal(refused.status, 400, database);
		}
	});

	// ---- the watcher
	it("ends a statement of a folder's login that runs past its door's limit, and only then", async () => {
		const database = companyDatabase(ENV_A);
		const [{ n }] = await asAdmin(database, "select n from qorpera_data.databases where name = 'shop'");
		const login = (kind) => `${database}_${kind}${n}`;
		// The shop's read login (a question's limit) and its write login (a change's limit, longer).
		const reader = connect(database, login("r"), folderPassword(logins.folderKey, login("r")));
		const stepper = connect(database, login("w"), folderPassword(logins.folderKey, login("w")));
		await reader.connect();
		await stepper.connect();
		try {
			// Direct logins with no time limit of their own: only the watcher stops them.
			const reading = reader.query("select pg_sleep(30)").then(() => "finished", (error) => error.code);
			const changing = stepper.query("select pg_sleep(30)").then(() => "finished", (error) => error.code);
			await sleep(200);
			assert.deepEqual((await gateway.watchOnce()).ended, []);
			await sleep(LIMITS_HERE.questionMs + 2_000);
			const looked = await gateway.watchOnce();
			assert.deepEqual(looked.ended.map((one) => `${one.login} ${one.database}`), [`${login("r")} ${database}`]);
			assert.equal(await reading, "57014");
			// A change's limit is longer: it runs on, until the test ends it.
			await asAdmin("postgres", "select pg_cancel_backend(pid) from pg_stat_activity where usename = $1 and query = 'select pg_sleep(30)'", [login("w")]);
			assert.equal(await changing, "57014");
		} finally {
			await reader.end().catch(() => undefined);
			await stepper.end().catch(() => undefined);
		}
	});

	it("closes a company's steps at its size limit, and its questions still answer", async () => {
		assert.deepEqual((await gateway.watchOnce()).full, []);
		const small = new Gateway({
			store: { host: "127.0.0.1", port: storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: { ...LIMITS_HERE, companyBytes: 1024 ** 2 },
		});
		const smallServer = await serve(small);
		const mainPort = port;
		port = smallServer.address().port;
		try {
			const refusedBefore = await ask(owner, "apply", { database: "shop" });
			assert.equal(refusedBefore.status, 200, "before the watcher looked, steps apply");
			const looked = await small.watchOnce();
			assert.deepEqual(new Set(looked.full), new Set([companyDatabase(ENV_A), companyDatabase(ENV_B)]));
			const refused = await ask(owner, "apply", { database: "shop" });
			assert.equal(refused.status, 507);
			assert.equal(refused.value.error, "This company's database is at its size limit of 1 MiB: delete rows or ask for more room");
			const question = await ask(viewer, "query", { database: "shop", question: "count" });
			assert.equal(question.status, 200);
			assert.equal(question.value.rows[0][0], 241);
		} finally {
			port = mainPort;
			smallServer.close();
			smallServer.closeAllConnections();
			await small.close();
		}
		assert.equal((await ask(owner, "apply", { database: "shop" })).status, 200, "the other gateway's limit is its own");
		assert.ok(platformCalls > 0);
	});

	it("holds a step that drops a column with its type, its domain or its schema, and keeps the values", async () => {
		const database = companyDatabase(ENV_A);
		assert.deepEqual(states(await ask(contributor, "apply", { database: "kinds" })), ["001-items applied"]);
		const values = async () => (await asAdmin(database, "select string_agg(id || ' ' || mood || ' ' || cost, ', ' order by id) as v from kinds.items"))[0].v;
		const before = await values();
		for (const [text, wanted] of [
			["drop type mood cascade;\n", ["dropped table column", "kinds.items.mood"]],
			["drop domain price cascade;\n", ["dropped table column", "kinds.items.cost"]],
			["drop schema kinds cascade;\n", ["dropped table", "kinds.items"]],
		]) {
			put(ENV_A, { "data/kinds/tables/002-try.sql": text });
			const tried = await ask(contributor, "apply", { database: "kinds" });
			assert.deepEqual(states(tried), ["001-items already", "002-try held"], `${text}: ${JSON.stringify(tried.value)}`);
			const destroys = tried.value.results[1].destroys.map((effect) => [effect.what, effect.object]);
			assert.ok(destroys.some(([what, object]) => what === wanted[0] && object === wanted[1]), `${text}: ${JSON.stringify(destroys)}`);
			if (text.startsWith("drop schema")) assert.ok(destroys.some(([what, object]) => what === "dropped schema" && object === "kinds"), JSON.stringify(destroys));
		}
		assert.equal(await values(), before);
	});

	/** Runs `work` against a second gateway on the same store, with its own limits, then puts the first one back. */
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
		try {
			return await work(other);
		} finally {
			port = mainPort;
			otherServer.close();
			otherServer.closeAllConnections();
			await other.close();
		}
	};

	it("ends the backend of a statement that catches the watcher's cancel, and the next question works", async () => {
		put(ENV_A, {
			"data/shop/tables/005-stubborn.sql":
				"create function stubborn() returns int language plpgsql as $f$\nbegin\n\tloop\n\t\tbegin\n\t\t\tperform pg_sleep(10);\n\t\texception when query_canceled then\n\t\t\tnull;\n\t\tend;\n\tend loop;\nend $f$;\n",
		});
		assert.equal(states(await ask(owner, "apply", { database: "shop" })).at(-1), "005-stubborn applied");
		const database = companyDatabase(ENV_A);
		const began = Date.now();
		const asking = ask(viewer, "query", { database: "shop", question: "stubborn" });
		// Its own time limit is caught, so it runs on until the watcher's margin has passed.
		await sleep(LIMITS_HERE.questionMs + 2_300);
		const first = await gateway.watchOnce();
		assert.deepEqual(first.ended.map((one) => one.how), ["cancelled"]);
		await sleep(200);
		const second = await gateway.watchOnce();
		assert.deepEqual(second.ended.map((one) => one.how), ["terminated"]);
		const answer = await asking;
		assert.equal(answer.status, 408, JSON.stringify(answer.value));
		assert.ok(Date.now() - began < 5_000);
		const left = await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where pid = $1", [second.ended[0].pid]);
		assert.equal(left[0].n, 0, "the backend is gone");
		const next = await ask(viewer, "query", { database: "shop", question: "count" });
		assert.equal(next.status, 200, JSON.stringify(next.value));
	});

	it("makes a company's database again when an earlier attempt failed between its creation and its grants", async () => {
		const database = companyDatabase(ENV_C);
		let fail = true;
		await withGateway(
			{
				onProvision: (_, stage) => {
					if (stage === "revoked" && fail) {
						fail = false;
						throw new Error("injected");
					}
				},
			},
			async () => {
				const broken = await ask(owner, "apply", { database: "shop" }, ENV_C);
				assert.equal(broken.status, 503, JSON.stringify(broken.value));
				const grants = await asAdmin("postgres", "select datacl::text as acl from pg_database where datname = $1", [database]);
				assert.doesNotMatch(grants[0].acl ?? "", /qorpera_data_keeper/, "the failure came before the grant");
				const retried = await ask(owner, "apply", { database: "shop" }, ENV_C);
				assert.deepEqual(states(retried), ["001-orders applied"]);
			},
		);
		const [{ acl }] = await asAdmin("postgres", "select datacl::text as acl from pg_database where datname = $1", [database]);
		assert.match(acl, /qorpera_data_keeper=c\//);
		assert.match(acl, /qorpera_data_watch=c\//);
		// Set on a database made whole again, as on one made at once.
		for (const made of [database, companyDatabase(ENV_A)]) {
			const settings = await asAdmin("postgres", "select array_to_string(setconfig, ',') as s from pg_db_role_setting r join pg_database d on d.oid = r.setdatabase where d.datname = $1 and r.setrole = 0", [made]);
			assert.equal(
				settings[0].s,
				"temp_file_limit=256MB,work_mem=16MB,max_parallel_workers_per_gather=0,log_min_messages=fatal,log_min_error_statement=panic,log_min_duration_statement=-1,log_statement=none",
				made,
			);
		}
		// The first gateway, which never made it, asks it as any other.
		const count = await ask(owner, "query", { database: "shop", question: "count" }, ENV_C);
		assert.deepEqual(count.value.rows, [[240]]);
	});

	const naps = (n) => Array.from({ length: n }, (_, index) => ({ database: "shop", question: "nap", params: { k: index + 1 }, etag: "old" }));

	it("asks a watch's 24 questions a few at a time, inside its deadline", async () => {
		const began = Date.now();
		const answer = await call(viewer, "watch", { watches: naps(24), wait: 3, texts: { [sha256(FOLDERS[ENV_A].get("data/shop/queries/nap.sql"))]: FOLDERS[ENV_A].get("data/shop/queries/nap.sql") } });
		const took = Date.now() - began;
		assert.equal(answer.status, 200, JSON.stringify(answer.value).slice(0, 300));
		assert.deepEqual(answer.value.changed.map((one) => one.answer.rows[0][1]), Array.from({ length: 24 }, (_, index) => index + 1));
		// One after another they take 4.8 s; three at a time 1.6 s.
		assert.ok(took < 3_000, `${took} ms`);
	});

	it("answers a watch at its deadline with what it has, and starts no question after it", async () => {
		// The shop's read login holds 3 connections, and the first gateway's are idle until they time out.
		const [{ n: shop }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const held = async () =>
			(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1", [`${companyDatabase(ENV_A)}_r${shop}`]))[0].n;
		assert.equal(await until(held, 0, 7_000), 0);
		await withGateway({ limits: { ...LIMITS_HERE, watchMs: 1_000 } }, async () => {
			const began = Date.now();
			const answer = await call(viewer, "watch", { watches: naps(24), wait: 20 });
			const took = Date.now() - began;
			assert.equal(answer.status, 200, JSON.stringify(answer.value).slice(0, 300));
			assert.ok(took < 1_400, `${took} ms`);
			assert.ok(answer.value.changed.length > 0 && answer.value.changed.length < 24, `${answer.value.changed.length} answered`);
			assert.equal(answer.value.partial, true);
			// The page now holds every answer but the last: repeated calls never fit all 24, so each goes on from where
			// the last stopped, and the change in the last question comes back within a few calls.
			const etags = new Map(answer.value.changed.map((one) => [one.index, one.answer.etag]));
			const known = naps(24).map((watched, index) => ({ ...watched, etag: etags.get(index) ?? null }));
			for (let index = 0; index < 23; index += 3) {
				const some = await Promise.all(
					known.slice(index, Math.min(index + 3, 23)).map((watched) => call(viewer, "query", { database: "shop", question: "nap", params: watched.params })),
				);
				some.forEach((one, offset) => {
					known[index + offset].etag = one.value.etag;
				});
			}
			known[23].etag = "old";
			let calls = 0;
			let found = null;
			while (calls < 4 && !found) {
				calls++;
				const again = await call(viewer, "watch", { watches: known, wait: 20 });
				assert.equal(again.status, 200, JSON.stringify(again.value).slice(0, 300));
				const indexes = (again.value.changed ?? []).map((one) => one.index);
				if (indexes.includes(23)) found = again.value;
				// Never a plain "the same" while questions were left unasked.
				else assert.equal(again.value.partial, true, JSON.stringify(again.value).slice(0, 300));
				assert.deepEqual(indexes.filter((one) => one !== 23), [], "only the last answer changed");
			}
			assert.ok(found, `the last question's change came back within ${calls} calls`);
		});
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const active = await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [`${companyDatabase(ENV_A)}_r${n}`]);
		assert.equal(active[0].n, 0);
	});

	it("stops a watch's questions when its caller goes away", async () => {
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const reader = `${companyDatabase(ENV_A)}_r${n}`;
		const active = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [reader]))[0].n;
		const text = JSON.stringify({ watches: naps(24), wait: 3 });
		const request = http.request({
			host: "127.0.0.1",
			port,
			path: `/v1/company-data/${ENV_A}/watch`,
			method: "POST",
			headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
		});
		request.on("error", () => undefined);
		request.end(text);
		assert.equal(await until(active, 3), 3, "three questions at a time");
		const gone = Date.now();
		request.destroy();
		assert.equal(await until(active, 0, 2_000), 0);
		assert.ok(Date.now() - gone < 400, `${Date.now() - gone} ms: cancelled, not left to finish`);
		assert.equal(await until(listening, 0), 0);
	});

	it("never sends a late cancel to a connection another call has taken", async () => {
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const reader = `${companyDatabase(ENV_A)}_r${n}`;
		const connections = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1", [reader]))[0].n;
		const active = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [reader]))[0].n;
		assert.equal(await until(connections, 0, 7_000), 0);
		let letCancelGo = () => undefined;
		const held = new Promise((resolve) => {
			letCancelGo = resolve;
		});
		await withGateway({ beforeCancel: () => held }, async () => {
			// A watch whose caller goes away while its one question runs: its cancel waits.
			const text = JSON.stringify({ watches: naps(1), wait: 3 });
			const request = http.request({
				host: "127.0.0.1",
				port,
				path: `/v1/company-data/${ENV_A}/watch`,
				method: "POST",
				headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) },
			});
			request.on("error", () => undefined);
			request.end(text);
			assert.equal(await until(active, 1), 1);
			request.destroy();
			// The question ends by itself and its connection is let go; the next call takes a connection.
			assert.equal(await until(active, 0), 0);
			const next = call(viewer, "query", { database: "shop", question: "nap", params: { k: 99 } });
			assert.equal(await until(active, 1), 1);
			letCancelGo();
			const answer = await next;
			assert.equal(answer.status, 200, JSON.stringify(answer.value));
			assert.deepEqual(answer.value.rows[0], ["", 99]);
		});
	});

	it("stops a watch's other questions when one of them fails", async () => {
		const [{ n }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const reader = `${companyDatabase(ENV_A)}_r${n}`;
		const active = async () => (await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1 and state = 'active'", [reader]))[0].n;
		const watches = [{ database: "shop", question: "writes", etag: "old" }, ...naps(12)];
		const began = Date.now();
		const failed = await call(viewer, "watch", { watches, wait: 3 });
		assert.equal(failed.status, 400, JSON.stringify(failed.value).slice(0, 300));
		assert.ok(Date.now() - began < 400, `${Date.now() - began} ms`);
		const ended = Date.now();
		assert.equal(await until(active, 0, 2_000), 0);
		// Left running, the other 12 would take 0.8 s three at a time.
		assert.ok(Date.now() - ended < 300, `${Date.now() - ended} ms`);
		assert.equal(await until(listening, 0), 0);
	});

	it("writes none of a company's values into the server's log", async () => {
		const marker = `mark${randomBytes(6).toString("hex")}`;
		put(ENV_A, {
			"data/shop/queries/cast.sql": "select :v::int as n;\n",
			"data/shop/queries/slow-mark.sql": `select pg_sleep(1) as waited, '${marker}-slow' as m;\n`,
			"data/shop/queries/fast-mark.sql": `select '${marker}-fast' as m;\n`,
			"data/shop/tables/006-try.sql": `insert into orders (customer, amount) values ('${marker}-row', -5);\n`,
		});
		const cast = await ask(viewer, "query", { database: "shop", question: "cast", params: { v: `${marker}-cast` } });
		assert.equal(cast.status, 400);
		assert.match(cast.value.error, new RegExp(`${marker}-cast`), "the caller hears the error");
		const step = await ask(owner, "apply", { database: "shop" });
		assert.equal(states(step).at(-1), "006-try failed", JSON.stringify(step.value));
		remove(ENV_A, "data/shop/tables/006-try.sql");
		assert.equal((await ask(viewer, "query", { database: "shop", question: "slow-mark" })).status, 408);
		assert.equal((await ask(viewer, "query", { database: "shop", question: "fast-mark" })).status, 200);
		const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		const all = `${logs.stdout}${logs.stderr}`;
		// The server does log: the test's own statements in another database are there.
		assert.match(all, /statement: /);
		assert.equal(all.includes(marker), false, all.split("\n").filter((line) => line.includes(marker)).slice(0, 5).join("\n"));
	});
});
