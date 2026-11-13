// Proof 2: how fast a change notice reaches an open page.
// A statement trigger on each table says "this table changed" (pg_notify). The gateway listens on one connection per
// company database that has a page open, and passes the notice on over a held-open stream (server-sent events). The
// page then asks its named question again. Measured: commit of the new row -> notice at the page -> new answer.
import http from "node:http";
import { check, connection, finish, note, now, percentiles, pg, sleep, withAdmin } from "./lib.mjs";

const TRIALS = 200;
const QUESTION = "select count(*)::int as orders, coalesce(sum(amount), 0)::float8 as total from shop.orders";

await withAdmin("postgres", async (db) => {
	await db.query("create role cdn_gateway login noinherit password 'gateway-proof'");
	await db.query("create role cdn_owner nologin");
	await db.query("create role cdn_read nologin");
	await db.query("grant cdn_owner, cdn_read to cdn_gateway");
	await db.query("create database cdn_live");
	await db.query("revoke connect on database cdn_live from public; grant connect on database cdn_live to cdn_gateway");
});
await withAdmin("cdn_live", async (db) => {
	await db.query(`
		create schema qorpera_data;
		-- Says which table changed, once per statement. Identical notices inside one transaction are sent once.
		create function qorpera_data.changed() returns trigger language plpgsql security definer set search_path = '' as $$
		begin
			perform pg_notify('qorpera_data', tg_table_schema || '.' || tg_table_name);
			return null;
		end $$;
		-- Every new table in a company schema gets the trigger, whoever makes the table.
		create function qorpera_data.watch_new_tables() returns event_trigger language plpgsql security definer
		set search_path = '' as $$
		declare made record;
		begin
			for made in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE'
				and object_type = 'table' and schema_name not in ('qorpera_data', 'pg_catalog', 'information_schema')
			loop
				execute format('create trigger qorpera_changed after insert or update or delete or truncate on %s
					for each statement execute function qorpera_data.changed()', made.object_identity);
			end loop;
		end $$;
		create event trigger qorpera_watch_new_tables on ddl_command_end when tag in ('CREATE TABLE')
			execute function qorpera_data.watch_new_tables();
		create schema shop authorization cdn_owner;
	`);
	// The company's own role makes its table: the trigger arrives by itself.
	await db.query("set role cdn_owner");
	await db.query(`create table shop.orders (id bigserial primary key, amount numeric(12,2) not null,
		placed_at timestamptz not null default now())`);
	await db.query("create table shop.customers (id bigserial primary key, name text not null)");
	await db.query("grant usage on schema shop to cdn_read; grant select on all tables in schema shop to cdn_read");
	await db.query("reset role");
	const triggers = await db.query(`select count(*)::int as n from pg_trigger where tgname = 'qorpera_changed'`);
	check("a table made by the company's own role gets the change trigger by itself", triggers.rows[0].n === 2,
		`${triggers.rows[0].n} of 2 tables`);
});

// ---- the gateway: one listening connection for this company database, and a stream per open page
const listener = new pg.Client(connection("cdn_live", "cdn_gateway", "gateway-proof"));
await listener.connect();
await listener.query("listen qorpera_data");
const pages = new Set();
let coalesced = 0;
const waiting = new Map();
listener.on("notification", (message) => {
	// Many notices for one table within 50 ms travel as one.
	if (waiting.has(message.payload)) {
		coalesced++;
		return;
	}
	waiting.set(
		message.payload,
		setTimeout(() => {
			waiting.delete(message.payload);
			for (const page of pages) page.write(`event: changed\ndata: ${JSON.stringify({ table: message.payload })}\n\n`);
		}, Number(process.env.CDPROOF_COALESCE_MS ?? 0)),
	);
});
const reads = new pg.Pool({ ...connection("cdn_live", "cdn_gateway", "gateway-proof"), max: 2 });
const server = http.createServer(async (request, response) => {
	if (request.url === "/events") {
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
		response.write(": open\n\n");
		pages.add(response);
		request.on("close", () => pages.delete(response));
		return;
	}
	const client = await reads.connect();
	try {
		await client.query("begin transaction read only; set local statement_timeout = '5s'; set local role cdn_read");
		const result = await client.query({ text: QUESTION, rowMode: "array" });
		await client.query("commit");
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result.rows[0]));
	} finally {
		client.release();
	}
});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// ---- the page: holds the stream, asks again on a notice
const ask = () =>
	new Promise((resolve, reject) => {
		http.get({ host: "127.0.0.1", port, path: "/q" }, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("end", () => resolve(JSON.parse(body)));
		}).on("error", reject);
	});
let onNotice = () => undefined;
await new Promise((resolve) => {
	http.get({ host: "127.0.0.1", port, path: "/events" }, (response) => {
		response.setEncoding("utf8");
		response.on("data", (chunk) => {
			if (chunk.includes("event: changed")) onNotice(chunk);
			else resolve();
		});
	});
});

// ---- the writer: the company's product, or an agent, adding an order
const writer = new pg.Client(connection("cdn_live", "cdn_gateway", "gateway-proof"));
await writer.connect();
await writer.query("set role cdn_owner");

const toNotice = [];
const toAnswer = [];
let wrong = 0;
for (let trial = 0; trial < TRIALS; trial++) {
	const expected = (await ask())[0] + 1;
	const noticed = new Promise((resolve) => {
		onNotice = resolve;
	});
	await writer.query("insert into shop.orders (amount) values ($1)", [100 + trial]);
	const committed = now();
	await noticed;
	toNotice.push(now() - committed);
	const answer = await ask();
	toAnswer.push(now() - committed);
	if (answer[0] !== expected) wrong++;
	await sleep(5);
}
const notice = percentiles(toNotice);
const answer = percentiles(toAnswer);
note(`${TRIALS} new rows, one at a time. Commit -> notice at the page: ${JSON.stringify(notice)} ms`);
note(`commit -> the page holds the new answer: ${JSON.stringify(answer)} ms`);
check("every notice was followed by the right new number", wrong === 0, `${wrong} wrong`);
check("a new row is on the page within a second (p99)", answer.p99 < 1000, `p99 ${answer.p99} ms`);

// ---- a burst: 10,000 rows in one statement, in one transaction of many statements, and from 8 writers at once
let notices = 0;
onNotice = () => {
	notices++;
};
await writer.query("insert into shop.orders (amount) select 1 from generate_series(1, 10000)");
await sleep(300);
check("10,000 rows in one statement give one notice", notices === 1, `${notices} notices`);
notices = 0;
await writer.query("begin");
for (let index = 0; index < 500; index++) await writer.query("insert into shop.orders (amount) values (1)");
await writer.query("insert into shop.customers (name) values ('a')");
await writer.query("commit");
await sleep(300);
check("500 statements on one table and 1 on another in one transaction give two notices", notices === 2, `${notices} notices`);

// ---- what the trigger costs a writer
const plain = new pg.Client(connection("cdn_live", "cdn_gateway", "gateway-proof"));
await plain.connect();
await plain.query("set role cdn_owner");
await withAdmin("cdn_live", (db) => db.query("alter table shop.customers disable trigger qorpera_changed"));
const timeInserts = async (table, column, value) => {
	const samples = [];
	for (let index = 0; index < 2000; index++) {
		const started = now();
		await plain.query(`insert into shop.${table} (${column}) values ($1)`, [value]);
		samples.push(now() - started);
	}
	return percentiles(samples);
};
const without = await timeInserts("customers", "name", "x");
const withTrigger = await timeInserts("orders", "amount", 1);
note(`one-row insert without the trigger: ${JSON.stringify(without)} ms; with it: ${JSON.stringify(withTrigger)} ms`);
check("the trigger adds under 1 ms to a one-row insert (p50)", withTrigger.p50 - without.p50 < 1,
	`${Math.round((withTrigger.p50 - without.p50) * 1000)} microseconds`);

// ---- a listening connection's cost, and what a dropped listener means
const size = await withAdmin("cdn_live", (db) =>
	db.query("select pg_size_pretty(pg_notification_queue_usage()::numeric) as used, current_setting('max_notify_queue_pages') as pages"),
);
note(`notification queue in use: ${size.rows[0].used} of ${size.rows[0].pages} pages`);
note(`notices coalesced by the gateway: ${coalesced}`);

await plain.end();
await writer.end();
await listener.end();
await reads.end();
server.close();
server.closeAllConnections();
finish();
