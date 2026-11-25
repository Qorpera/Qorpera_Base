import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { companyDatabase, folderPassword, Gateway, listMembers, Platform, POOL_SIZE, serve } from "./gateway.mjs";
import {
	COUNT,
	createGatewayHarness,
	dockerUsable,
	ENV_A,
	ENV_B,
	ENV_C,
	LIMITS_HERE,
	MARKER,
	NAMES,
	ORDERS,
	OWNER,
	CONTRIBUTOR,
	VIEWER,
	sha256,
	sleep,
	storeFile,
} from "./gateway-test-harness.mjs";

it("reads who gets the list from database.toml's [list], and counts any spelling it cannot read as writers", () => {
	const viewer = "select 1 from t where owner = :viewer::uuid;\n";
	for (const [toml, questions, cut, members] of [
		['format = "x"\n', [], false, "readers"],
		['format = "x"\n', ["select 1;\n", viewer], false, "writers"],
		['format = "x"\n', ["select 1; select :viewer;\n"], false, "writers"],
		['format = "x"\n', [null], false, "writers"],
		['format = "x"\n', [], true, "writers"],
		[null, [], false, "writers"],
		['[list]\nmembers = "readers"\n', [viewer], true, "readers"],
		['[list]\nmembers = "writers" # w\n', [], false, "writers"],
		["[list]\nmembers = 'readers'\n", [], false, "readers"],
		['[list]\nmembers = "everyone"\n', [], false, "writers"],
		['[list]\n"members" = "readers"\n', [], false, "readers"],
		['["list"]\nmembers = "readers"\n', [], false, "readers"],
		['[ list ]\nmembers = "readers"\n', [], false, "readers"],
		['[list]\nmembers = """readers"""\n', [], false, "writers"],
		['list.members = "readers"\n', [viewer], false, "readers"],
		["'list'.\"members\" = \"writers\"\n", [], false, "writers"],
		['list = { members = "readers" }\n', [viewer], false, "readers"],
		['list = { "members" = "writers" }\n', [], false, "writers"],
		['list = { members = "readers", x = 1 }\n', [], false, "writers"],
		['[[list]]\nmembers = "readers"\n', [], false, "writers"],
		['[list.more]\nmembers = "readers"\n', [], false, "writers"],
		['[other]\nmembers = "readers"\n', [viewer], false, "writers"],
		['about = "A list of members"\n', [], false, "readers"],
		['tags = [\n  ["a"],\n]\nlist.members = "writers"\n', [], false, "writers"],
		['[other]\nx = [\n  [1],\n]\n[list]\nmembers = "writers"\n', [], false, "writers"],
		['["li\\u0073t"]\nmembers = "readers"\n', [], false, "writers"],
		['[list]\n"mem\\u0062ers" = "readers"\n', [], false, "writers"],
		['[list]\r\nmembers = "readers"\r\n', [viewer], false, "readers"],
		['[list]\nmembers = "readers"                  # "readers" (every member who may read the folder) or "writers"\n', [viewer], false, "readers"],
		['[list]\nmembers = "readers" # don\'t show, won\'t change\n', [viewer], false, "readers"],
		['about = "x" # "y"\n[list]\nmembers = "readers"\n', [viewer], false, "readers"],
		['x = [ #] "ab"\n', [], false, "writers"],
		['list = "readers"\n', [viewer], false, "writers"],
		['[list]\n"" = "readers"\n', [viewer], false, "writers"],
		['[""]\nlist.members = "readers"\n', [viewer], false, "writers"],
		['"list.members" = "readers"\n', [viewer], false, "writers"],
		['[list]\nmembers = "readers"\nmembers = "writers"\n', [], false, "writers"],
		['x = [\n  [1]\n]\nlist.members = "writers"\n', [], false, "writers"],
		['[list]\nlevels = [\n  [1]\n]\nmembers = "writers"\n', [], false, "writers"],
		['about = """\n[list]\nmembers = "readers"\n"""\nlist.members = "writers"\n', [], false, "writers"],
		["about = '''\n[x]\n'''\n[list]\nmembers = 'readers'\n", [viewer], false, "writers"],
		['# levels = [\n[list]\nmembers = "writers"\n', [], false, "writers"],
		["about = 'Use \"\"\" for notes'\n[list]\nmembers = \"writers\"\n", [], false, "writers"],
		['name = "Shop" # no \'\'\' here\n[list]\nmembers = "writers"\n', [], false, "writers"],
		['about = """\nnever ends\n[list]\nmembers = "writers"\n', [], false, "writers"],
		['name = "Shop" # [list] in a comment\nabout = "x"\n', [], false, "readers"],
		['format = "qorpera.database/v1"\nname = "Shop"\nabout = "What the shop holds" # one line\n\n[list]\nmembers = "readers" # all\n', [viewer], false, "readers"],
		['[list]\nmembers = [\n"readers"]\n', [], false, "writers"],
		['tags = ["a]", "b"]\nlist.members = "readers"\n', [viewer], false, "readers"],
	])
		assert.equal(listMembers(toml, questions, cut), members, `${JSON.stringify(toml)} ${JSON.stringify(questions)} ${cut}`);
});

describe("the data gateway against a real PostgreSQL", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	const h = createGatewayHarness({ logAllStatements: true });
	const {
		container,
		logins,
		FOLDERS,
		TEXTS,
		owner,
		contributor,
		viewer,
		stranger,
		bMember,
		forged,
		put,
		remove,
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
	} = h;

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
// A database whose rows members and agents change through named changes (§8).
put(ENV_A, {
	"data/desk/database.toml": 'format = "qorpera.database/v1"\nname = "Desk"\n',
	"data/desk/tables/001-tickets.sql": `create table tickets (
	id bigint generated always as identity primary key,
	title text not null check (title <> ''),
	state text not null default 'open' check (state in ('open', 'done')),
	opened_by uuid,
	note text
);
insert into tickets (title) select 'Ticket ' || n from generate_series(1, 30) n;
create table log (id bigint generated always as identity primary key, line text not null);
insert into log (line) values ('started');
create table scratch (id int primary key);
create function close_all() returns bigint language sql as $f$
	with done as (update tickets set state = 'done' where state = 'open' returning 1) select count(*) from done
$f$;
-- What the write login can do only through a function a step made, as that step's owner.
create function drop_scratch() returns void language plpgsql security definer as $f$ begin drop table scratch; end $f$;
create function empty_log() returns void language plpgsql security definer as $f$ begin truncate log; end $f$;
create function forget_note() returns void language plpgsql security definer as $f$ begin alter table tickets drop column note; end $f$;
-- A function that writes a row, for a delete that carries an insert.
create function logged(what text) returns boolean language sql as $f$ insert into log (line) values (what) returning true $f$;
`,
	"data/desk/queries/open.sql": "-- How many tickets are open.\nselect count(*) as open from tickets where state = 'open';\n",
	"data/desk/actions/open-ticket.sql": "-- Open a ticket called :title.\ninsert into tickets (title, opened_by) values (:title, :viewer::uuid) returning id, title;\n",
	"data/desk/actions/close-ticket.sql": "-- Mark ticket :id as done.\nupdate tickets set state = 'done' where id = :id::bigint;\n",
	"data/desk/actions/remove-ticket.sql": "-- Remove ticket :id for good.\ndelete from tickets where id = :id::bigint;\n",
	"data/desk/actions/claim.sql": "-- Give ticket :id to :viewer.\nupdate tickets set opened_by = :viewer::uuid where id = :id::bigint;\n",
	"data/desk/actions/move.sql":
		"with moved as (delete from tickets where id = :id::bigint returning title) insert into log (line) select 'removed ' || title from moved returning line;\n",
	"data/desk/actions/close-all.sql": "select close_all() as closed;\n",
	"data/desk/actions/open-many.sql": "insert into tickets (title) select 'Bulk ' || n from generate_series(1, :n::int) n returning id;\n",
	"data/desk/actions/note-all.sql": "update tickets set note = repeat('x', :size::int) returning note;\n",
	"data/desk/actions/two.sql": "insert into log (line) values ('a'); insert into log (line) values ('b');\n",
	"data/desk/actions/setting.sql": "set statement_timeout = 0;\n",
	"data/desk/actions/block.sql": "do $d$ begin insert into log (line) values ('from a block'); end $d$;\n",
	"data/desk/actions/truncate.sql": "truncate log;\n",
	"data/desk/actions/drop.sql": "drop table scratch;\n",
	"data/desk/actions/make.sql": "create table more (id int);\n",
	"data/desk/actions/drop-through.sql": "select drop_scratch();\n",
	"data/desk/actions/empty-through.sql": "select empty_log();\n",
	"data/desk/actions/column-through.sql": "select forget_note();\n",
	"data/desk/actions/slow.sql": "select pg_sleep(3) as waited;\n",
	// Deletes that also write: a `with` part, a function a step made, a large object. And a merge that only deletes.
	"data/desk/actions/sneak.sql": "with added as (insert into log (line) values ('sneaked') returning 1) delete from tickets where id = -1;\n",
	"data/desk/actions/remove-logged.sql": "delete from tickets where id = :id::bigint returning logged('removed ' || id) as logged;\n",
	"data/desk/actions/blob.sql": "delete from tickets where id = :id::bigint and lo_from_bytea(0, 'x'::bytea) > 0;\n",
	"data/desk/actions/merge-remove.sql": "merge into tickets t using (select :id::bigint as id) s on t.id = s.id when matched then delete;\n",
	// What a change could leave on its session for the next one: a setting and a session's advisory lock.
	"data/desk/actions/stick.sql":
		"select set_config('default_transaction_read_only', 'on', false) as read_only, set_config('search_path', 'pg_catalog', false) as path, pg_advisory_lock(42) is not null as locked;\n",
	"data/desk/actions/reach.sql": "insert into shop.orders (customer, amount) values ('x', 1);\n",
	"data/desk/actions/records.sql": "delete from qorpera_data.steps;\n",
	"data/hr/actions/raise.sql": "-- Raise :name by :by a month.\nupdate salaries set monthly = monthly + :by::numeric where name = :name returning monthly;\n",
	"data/unmade/database.toml": 'format = "qorpera.database/v1"\n',
	"data/unmade/actions/add.sql": "insert into things (id) values (1);\n",
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

	before(() => h.start());
	after(() => h.stop());

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
		const described = await describeOne(contributor, "shop");
		assert.equal(described.status, 200);
		assert.deepEqual(described.value.tables.map((table) => table.name), ["order_totals", "orders"]);
		assert.deepEqual(described.value.applied.map((step) => step.name), ["001-orders", "002-order-notes"]);
		assert.ok(described.whole.companyBytes > 0);
		const orders = described.value.tables.find((table) => table.name === "orders");
		assert.deepEqual(orders.columns.map((column) => column.name), ["id", "customer", "amount", "status", "placed_by", "placed_at", "note"]);
		const [{ held }] = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as held from shop.orders");
		assert.ok(held > 0);
		assert.deepEqual([orders.rows, orders.rowsAbout], [held, undefined], "the rows the table holds, counted");
		const triggers = await asAdmin(companyDatabase(ENV_A), "select tgname from pg_trigger where tgrelid = 'shop.orders'::regclass and not tgisinternal order by 1");
		assert.deepEqual(triggers.map((row) => row.tgname), [
			"qorpera_changed",
			"qorpera_emptied",
			"qorpera_record_add",
			"qorpera_record_change",
			"qorpera_record_remove",
			"qorpera_rows_gone",
		]);
	});

	it("counts a table's rows when it describes it, and never gives PostgreSQL's estimate as a count", async () => {
		put(ENV_A, {
			"data/tally/database.toml": 'format = "qorpera.database/v1"\nname = "Tally"\nabout = "Things counted"\n',
			"data/tally/tables/001-things.sql":
				"create table things (id int primary key, name text not null);\n" +
				"insert into things select n, 'thing ' || n from generate_series(1, 7) n;\n" +
				// A table named as a catalog relation is: PostgreSQL finds the catalog's first under a name alone (the
				// insert must say the schema), so a count that named it without its schema would count the catalog's.
				"create table pg_tables (id int primary key);\n" +
				"insert into tally.pg_tables values (1), (2);\n" +
				"create view some_things as select * from things where id <= 3;\n" +
				// 7 rows at 0.2 s each: its count runs past a question's time here (300 ms).
				"create view slow_things as select * from things where pg_sleep(0.2) is not null;\n",
			"data/tally/queries/count.sql": "-- How many things there are.\nselect count(*) as things from things;\n",
		});
		const applied = await ask(contributor, "apply", { database: "tally" });
		assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
		const rowsOf = (answer) => Object.fromEntries(answer.value.tables.map((table) => [table.name, [table.rows, table.rowsAbout]]));
		const nothing = [undefined, undefined];
		// Autovacuum never analyses a table of 7 rows, so PostgreSQL has no estimate for it: the count is the truth.
		const estimates = await asAdmin(
			companyDatabase(ENV_A),
			"select relname, reltuples::int as estimate from pg_class where oid in ('tally.things'::regclass, 'tally.pg_tables'::regclass) order by 1",
		);
		assert.deepEqual(estimates, [{ relname: "pg_tables", estimate: -1 }, { relname: "things", estimate: -1 }]);
		const [{ catalog }] = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as catalog from pg_catalog.pg_tables");
		assert.notEqual(catalog, 2);
		const counted = await describeOne(viewer, "tally");
		assert.equal(counted.status, 200, JSON.stringify(counted.value));
		// The slow view's count was ended at a question's time and left it without rows; the view after it was counted.
		assert.deepEqual(rowsOf(counted), { pg_tables: [2, undefined], slow_things: nothing, some_things: [3, undefined], things: [7, undefined] });
		assert.deepEqual(Object.keys(counted.value.tables.find((table) => table.name === "things")), ["name", "kind", "key", "rows", "columns", "constraints", "indexes"]);
		await withGateway({ limits: { ...LIMITS_HERE, countMs: 0 } }, async () => {
			// No time to count: nothing is said of a table PostgreSQL has no estimate for.
			const none = await describeOne(viewer, "tally");
			assert.deepEqual(rowsOf(none), { pg_tables: nothing, slow_things: nothing, some_things: nothing, things: nothing });
			await asAdmin(companyDatabase(ENV_A), "analyze tally.things");
			// With an estimate it is given under its own name, never as `rows`; a view never has one.
			const about = await describeOne(viewer, "tally");
			assert.deepEqual(rowsOf(about), { pg_tables: nothing, slow_things: nothing, some_things: nothing, things: [undefined, 7] });
			assert.deepEqual(Object.keys(about.value.tables.find((table) => table.name === "things")), ["name", "kind", "key", "rowsAbout", "columns", "constraints", "indexes"]);
		});
		// A question still answers after a count was ended.
		assert.deepEqual((await ask(viewer, "query", { database: "tally", question: "count" })).value.rows, [[7]]);
	});

	it("does not make a describe wait for a connection its counts cannot get in their time", async () => {
		// A database only this test's gateway reads, so that all three connections of its read role are this gateway's
		// to hold (the role may hold three in all, whichever gateway opens them).
		put(ENV_A, {
			"data/queue/database.toml": 'format = "qorpera.database/v1"\nname = "Queue"\nabout = "Things that wait"\n',
			"data/queue/tables/001-things.sql":
				"create table things (id int primary key);\n" +
				"insert into things select n from generate_series(1, 7) n;\n" +
				"create view slow_things as select * from things where pg_sleep(0.2) is not null;\n",
			"data/queue/queries/slow.sql": "-- Every thing, slowly.\nselect count(*) as things from slow_things;\n",
		});
		// The slow question takes 1.4 s (7 rows at 0.2 s). Three of them hold the read role's three connections; the
		// counts of a describe have 400 ms in all.
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 2_000, countMs: 400 } }, async () => {
			const applied = await ask(contributor, "apply", { database: "queue" });
			assert.equal(applied.value.applied, true, JSON.stringify(applied.value));
			const things = (answer) => answer.value.tables.find((table) => table.name === "things");
			const sevens = Array.from({ length: POOL_SIZE.r }, () => [[7]]);
			assert.deepEqual((await ask(viewer, "query", { database: "queue", question: "slow" })).value.rows, [[7]], "the question's text is kept");
			const slow = Array.from({ length: POOL_SIZE.r }, () => call(viewer, "query", { database: "queue", question: "slow" }));
			await sleep(150);
			const began = Date.now();
			const busy = await describeOne(viewer, "queue");
			const took = Date.now() - began;
			assert.equal(busy.status, 200, JSON.stringify(busy.value));
			assert.deepEqual([things(busy).rows, things(busy).rowsAbout], [undefined, undefined]);
			assert.ok(took < 3_000, `the describe took ${took} ms: it did not wait as long as the pool lets a call wait (5 s)`);
			assert.deepEqual((await Promise.all(slow)).map((answer) => answer.value.rows), sevens);
			assert.equal(things(await describeOne(viewer, "queue")).rows, 7);
			const again = Date.now();
			const second = await Promise.all(Array.from({ length: POOL_SIZE.r }, () => call(viewer, "query", { database: "queue", question: "slow" })));
			assert.deepEqual(second.map((answer) => answer.value.rows), sevens);
			assert.ok(Date.now() - again < 2_500, `${POOL_SIZE.r} slow questions took ${Date.now() - again} ms`);
		});
	});

	// ---- questions
	let since = null;
	let sales = null;

	it("answers a question with columns, rows as arrays, numbers as numbers, an etag and when", async () => {
		// After the step ran: of its rows placed 1 to 240 hours before it, 23 are within a day now.
		since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
		put(ENV_A, { "data/shop/queries/sales-since.sql": `${FOLDERS[ENV_A].get("data/shop/queries/sales-since.sql")}\n` });
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
		assert.equal((await describeOne(viewer, "hr")).status, 404);
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
		const before = h.gateway.taken.bytes;
		for (const question of ["huge", "huge-first"]) {
			const huge = await ask(viewer, "query", { database: "shop", question });
			assert.equal(huge.status, 200, JSON.stringify(huge.value).slice(0, 200));
			assert.deepEqual(huge.value.rows, [], question);
			assert.equal(huge.value.more, true, question);
			assert.deepEqual(huge.value.columns, ["text"], question);
		}
		// 9 MiB of rows were made in the store; none of it came over.
		assert.equal(h.gateway.taken.bytes - before, 0);
		const none = await ask(viewer, "query", { database: "shop", question: "none" });
		assert.deepEqual([none.value.rows, none.value.more, none.value.columns], [[], false, ["n"]]);
	});

	it("counts a question's size by its whole row, whatever its columns are named", async () => {
		// A column named like the gateway's own words cannot stand for the whole row: 1 MiB still never comes over.
		const before = h.gateway.taken.bytes;
		const shadow = await ask(viewer, "query", { database: "shop", question: "shadow" });
		assert.equal(shadow.status, 200, JSON.stringify(shadow.value).slice(0, 200));
		assert.deepEqual([shadow.value.rows, shadow.value.more, shadow.value.columns], [[], true, ["qorpera_asked", "payload"]]);
		assert.equal(h.gateway.taken.bytes - before, 0);
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
		const described = await describeOne(viewer, "broken");
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
		const model = ["qorpera_changed", "qorpera_emptied", "qorpera_record_add", "qorpera_record_change", "qorpera_record_remove", "qorpera_rows_gone"];
		assert.deepEqual(triggers.map((row) => row.t), ["guard.t", "guard.child"].flatMap((table) => model.map((name) => `${table} ${name} O`)).sort());
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
			for (const setting of [
				"log_min_messages = 'debug1'",
				"log_error_verbosity = 'verbose'",
				"log_min_error_statement = 'error'",
				"log_statement = 'all'",
				"log_min_duration_statement = 0",
				"log_min_duration_sample = 0",
				"log_transaction_sample_rate = 1",
				"log_lock_waits = on",
				"log_temp_files = 0",
			])
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
			port: h.port,
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
	it("answers only POST on its calls, and refuses a body over its limit", async () => {
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
			assert.deepEqual((await h.gateway.watchOnce()).ended, []);
			await sleep(LIMITS_HERE.questionMs + 2_000);
			const looked = await h.gateway.watchOnce();
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
		assert.deepEqual((await h.gateway.watchOnce()).full, []);
		const small = new Gateway({
			store: { host: "127.0.0.1", port: h.storePort, logins },
			platform: new Platform({ url: "http://platform", publishableKey: "publishable", fetch: platformFetch }),
			limits: { ...LIMITS_HERE, companyBytes: 1024 ** 2 },
		});
		const smallServer = await serve(small);
		const mainPort = h.port;
		h.port = smallServer.address().port;
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
			h.port = mainPort;
			smallServer.close();
			smallServer.closeAllConnections();
			await small.close();
		}
		assert.equal((await ask(owner, "apply", { database: "shop" })).status, 200, "the other gateway's limit is its own");
		assert.ok(h.platformCalls > 0);
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


	it("ends the backend of a statement that catches the watcher's cancel, and the next question works", async () => {
		put(ENV_A, {
			"data/shop/tables/005-stubborn.sql":
				`create function stubborn() returns int language plpgsql as $f$\nbegin\n\tloop\n\t\tbegin\n\t\t\tperform pg_sleep(10), '${MARKER}-stubborn';\n\t\texception when query_canceled then\n\t\t\tnull;\n\t\tend;\n\tend loop;\nend $f$;\n`,
		});
		assert.equal(states(await ask(owner, "apply", { database: "shop" })).at(-1), "005-stubborn applied");
		const database = companyDatabase(ENV_A);
		const began = Date.now();
		const asking = ask(viewer, "query", { database: "shop", question: "stubborn" });
		// Its own time limit is caught, so it runs on until the watcher's margin has passed.
		await sleep(LIMITS_HERE.questionMs + 2_300);
		const first = await h.gateway.watchOnce();
		assert.deepEqual(first.ended.map((one) => one.how), ["cancelled"]);
		await sleep(200);
		const second = await h.gateway.watchOnce();
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
				"temp_file_limit=256MB,work_mem=16MB,max_parallel_workers_per_gather=0,log_min_messages=panic,log_error_verbosity=terse," +
					"log_min_error_statement=panic,log_statement=none,log_min_duration_statement=-1,log_min_duration_sample=-1," +
					"log_transaction_sample_rate=0,log_lock_waits=off,log_temp_files=-1",
				made,
			);
		}
		// The first gateway, which never made it, asks it as any other.
		const count = await ask(owner, "query", { database: "shop", question: "count" }, ENV_C);
		assert.deepEqual(count.value.rows, [[240]]);
	});

	const naps = (n) => Array.from({ length: n }, (_, index) => ({ database: "shop", question: "nap", params: { k: index + 1 }, etag: "old" }));

	it("asks a watch's 24 questions a few at a time, inside its deadline", async () => {
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 1_000 } }, async () => {
			const began = Date.now();
			const answer = await call(viewer, "watch", { watches: naps(24), wait: 3, texts: { [sha256(FOLDERS[ENV_A].get("data/shop/queries/nap.sql"))]: FOLDERS[ENV_A].get("data/shop/queries/nap.sql") } });
			const took = Date.now() - began;
			assert.equal(answer.status, 200, JSON.stringify(answer.value).slice(0, 300));
			assert.deepEqual(answer.value.changed.map((one) => one.answer.rows[0][1]), Array.from({ length: 24 }, (_, index) => index + 1));
			// One after another they take 4.8 s; three at a time 1.6 s.
			assert.ok(took < 3_000, `${took} ms`);
		});
	});

	it("answers a watch at its deadline with what it has, and starts no question after it", async () => {
		// The shop's read login holds 3 connections, and the first gateway's are idle until they time out.
		const [{ n: shop }] = await asAdmin(companyDatabase(ENV_A), "select n from qorpera_data.databases where name = 'shop'");
		const held = async () =>
			(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where usename = $1", [`${companyDatabase(ENV_A)}_r${shop}`]))[0].n;
		assert.equal(await until(held, 0, 7_000), 0);
		await withGateway({ limits: { ...LIMITS_HERE, questionMs: 1_000, watchMs: 1_000 } }, async () => {
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
			port: h.port,
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
				port: h.port,
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
		const marker = MARKER;
		put(ENV_A, {
			"data/shop/queries/cast.sql": "select :v::int as n;\n",
			"data/shop/queries/slow-mark.sql": `select pg_sleep(1) as waited, '${marker}-slow' as m;\n`,
			"data/shop/queries/fast-mark.sql": `select '${marker}-fast' as m;\n`,
			"data/shop/tables/006-try.sql": `insert into orders (customer, amount) values ('${marker}-row', -5);\n`,
			"data/shop/actions/note.sql": "update orders set note = :v where id = :id::bigint returning note;\n",
			"data/shop/actions/bad-row.sql": `insert into orders (customer, amount) values ('${marker}-change-row', :amount::numeric);\n`,
		});
		const cast = await ask(viewer, "query", { database: "shop", question: "cast", params: { v: `${marker}-cast` } });
		assert.equal(cast.status, 400);
		assert.match(cast.value.error, new RegExp(`${marker}-cast`), "the caller hears the error");
		const step = await ask(owner, "apply", { database: "shop" });
		assert.equal(states(step).at(-1), "006-try failed", JSON.stringify(step.value));
		remove(ENV_A, "data/shop/tables/006-try.sql");
		assert.equal((await ask(viewer, "query", { database: "shop", question: "slow-mark" })).status, 408);
		assert.equal((await ask(viewer, "query", { database: "shop", question: "fast-mark" })).status, 200);
		// A lock wait between two of the company's sessions, past the server's deadlock_timeout.
		const database = companyDatabase(ENV_A);
		const [{ n }] = await asAdmin(database, "select n from qorpera_data.databases where name = 'shop'");
		const login = `${database}_w${n}`;
		const first = connect(database, login, folderPassword(logins.folderKey, login));
		const second = connect(database, login, folderPassword(logins.folderKey, login));
		await first.connect();
		await second.connect();
		try {
			await first.query(`begin; update shop.orders set note = '${marker}-lock-1' where id = 1`);
			const waiting = second.query(`update shop.orders set note = '${marker}-lock-2' where id = 1`);
			await sleep(400);
			await first.query("rollback");
			await waiting;
			await second.query("update shop.orders set note = null where id = 1");
		} finally {
			await first.end().catch(() => undefined);
			await second.end().catch(() => undefined);
		}
		// A change's values, what it gives back, and its error with the row that failed. (After the two logins above:
		// the write login holds two connections, and the gateway keeps the ones a change used for a few seconds.)
		const noted = await ask(viewer, "change", { database: "shop", change: "note", params: { v: `${marker}-change`, id: 1 } });
		assert.deepEqual([noted.status, noted.value.rows], [200, [[`${marker}-change`]]], JSON.stringify(noted.value));
		assert.equal((await ask(viewer, "change", { database: "shop", change: "note", params: { v: null, id: 1 } })).status, 200);
		const badRow = await ask(viewer, "change", { database: "shop", change: "bad-row", params: { amount: -5 } });
		assert.equal(badRow.status, 400, JSON.stringify(badRow.value));
		assert.match(badRow.value.error, /orders_amount_check/, "the caller hears the error");
		const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
		const all = `${logs.stdout}${logs.stderr}`;
		// The server does log: the test's own statements in another database are there. And the stubborn function's
		// marker, which the watcher's termination would have quoted as context, is not.
		assert.match(all, /statement: /);
		assert.equal(all.includes(marker), false, all.split("\n").filter((line) => line.includes(marker)).slice(0, 5).join("\n"));
	});

	// ---- named changes (§8): a member's change, run as the database folder's write login
	const desk = async (text) => (await asAdmin(companyDatabase(ENV_A), text))[0];
	const change = (bearer, name, params = {}, more = {}) => ask(bearer, "change", { database: "desk", change: name, params, ...more });
	/** A folder's write login holds two connections, and a gateway keeps the ones its changes used for a few seconds.
	 * Before a second gateway runs changes here, the first has given them back. (One gateway runs on a store.) */
	const writersGone = async () => {
		const writers = async () =>
			(await asAdmin("postgres", "select count(*)::int as n from pg_stat_activity where datname = $1 and usename ~ '_w[0-9]+$'", [companyDatabase(ENV_A)]))[0].n;
		assert.equal(await until(writers, 0, 10_000), 0, "the first gateway still holds the write login's connections");
	};

	it("runs a named change as the member who asks, and gives back what its statement returns", async () => {
		assert.equal((await ask(contributor, "apply", { database: "desk" })).value.applied, true);
		// The gateway asks for the change's text by its hash, as for a question.
		const first = await call(viewer, "change", { database: "desk", change: "open-ticket", params: { title: "Printer jam" } });
		assert.deepEqual(first.value.need?.map((wanted) => wanted.path), ["data/desk/actions/open-ticket.sql"]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, 30, "nothing ran before the text came");
		// A member who may read the change's file may run it: the viewer.
		const opened = await change(viewer, "open-ticket", { title: "Printer jam" });
		assert.equal(opened.status, 200, JSON.stringify(opened.value));
		const { asOf, ...answer } = opened.value;
		assert.deepEqual(answer, { changed: 1, columns: ["id", "title"], rows: [[31, "Printer jam"]], more: false });
		assert.ok(Math.abs(Date.parse(asOf) - Date.now()) < 5_000);
		assert.deepEqual(await desk("select title, state, opened_by from desk.tickets where id = 31"), { title: "Printer jam", state: "open", opened_by: VIEWER });
		// A statement that gives nothing back says how many rows it changed, and no rows.
		const closed = await change(viewer, "close-ticket", { id: 1 });
		assert.deepEqual([closed.status, closed.value.changed, closed.value.columns, closed.value.rows], [200, 1, undefined, undefined]);
		assert.equal((await change(viewer, "close-ticket", { id: "2" })).value.changed, 1, "a value is text, a number, true, false or null");
		assert.equal((await change(viewer, "close-ticket", { id: 9999 })).value.changed, 0);
		// Deleting rows is the change's own defined act, and runs.
		const removed = await change(owner, "remove-ticket", { id: 3 });
		assert.deepEqual([removed.status, removed.value.changed], [200, 1], JSON.stringify(removed.value));
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 3")).n, 0);
		// One statement may hold several writes as `with` parts.
		const moved = await change(owner, "move", { id: 4 });
		assert.deepEqual([moved.value.changed, moved.value.rows], [1, [["removed Ticket 4"]]], JSON.stringify(moved.value));
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 4")).n, 0);
		// A change is committed, so a record of the rows it deleted would be kept for good: there is none. (A step's
		// deletes are recorded, which is how it is held; its record is rolled back with it.)
		assert.equal((await desk("select count(*)::int as n from qorpera_data.step_effects")).n, 0);
		assert.equal((await desk("select count(*)::int as n from qorpera_data.sealed")).n, (await desk("select count(*)::int as n from qorpera_data.steps")).n, "a seal for each applied step, none for a change");
		// A select that calls a function a step made: it says what the function gave, and no count of its own.
		const open = (await desk("select count(*)::int as n from desk.tickets where state = 'open'")).n;
		const all = await change(owner, "close-all");
		assert.deepEqual([all.status, all.value.changed, all.value.rows], [200, undefined, [[open]]], JSON.stringify(all.value));
		assert.equal((await desk("select count(*)::int as n from desk.tickets where state = 'open'")).n, 0);
	});

	it("fills :viewer itself in a change, and takes exactly the values the change names", async () => {
		const pretend = await change(owner, "open-ticket", { title: "x", viewer: VIEWER });
		assert.equal(pretend.status, 400);
		assert.match(pretend.value.error, /:viewer is filled by Qorpera/);
		const lacking = await change(owner, "open-ticket");
		assert.deepEqual([lacking.status, lacking.value.error], [400, "The change takes :title"]);
		const extra = await change(owner, "open-ticket", { title: "x", other: 1 });
		assert.deepEqual([extra.status, extra.value.error], [400, "The change takes no :other"]);
		let deep = { a: 1 };
		for (let i = 0; i < 18; i++) deep = { a: deep };
		assert.equal((await change(owner, "open-ticket", { title: deep })).status, 400);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where title = 'x'")).n, 0);
	});

	it("refuses a change that is not there the same as one a member may not read", async () => {
		const missing = await change(viewer, "nope");
		assert.deepEqual([missing.status, missing.value.error], [404, "No change desk/nope that you may run"]);
		const outside = await change(stranger, "open-ticket", { title: "x" });
		assert.deepEqual([outside.status, outside.value.error], [404, "No change desk/open-ticket that you may run"]);
		assert.equal((await change(forged, "open-ticket", { title: "x" })).status, 401);
		assert.equal((await change(viewer, "Bad Name")).status, 400);
		assert.equal((await ask(viewer, "change", { database: "desk" })).status, 400);
		// A question is no change, and a change is no question: each is found in its own folder only.
		assert.equal((await change(viewer, "open")).status, 404);
		assert.equal((await ask(viewer, "query", { database: "desk", question: "open-ticket" })).status, 404);
		// A database only one member may read: only that member runs its changes.
		for (const other of [viewer, owner]) {
			const refused = await ask(other, "change", { database: "hr", change: "raise", params: { name: "Ada", by: 500 } });
			assert.deepEqual([refused.status, refused.value.error], [404, "No change hr/raise that you may run"]);
		}
		const raised = await ask(contributor, "change", { database: "hr", change: "raise", params: { name: "Ada", by: 500 } });
		assert.deepEqual([raised.status, raised.value.rows], [200, [[52500]]], JSON.stringify(raised.value));
		// A database with no applied step has nothing to change yet.
		const unmade = await ask(owner, "change", { database: "unmade", change: "add" });
		assert.deepEqual([unmade.status, unmade.value.error], [409, "The database unmade has no applied step yet"]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where title = 'x'")).n, 0);
	});

	it("shows a member a change's words with the values in place, and runs only the file they were shown", async () => {
		const before = (await desk("select count(*)::int as n from desk.tickets")).n;
		const text = FOLDERS[ENV_A].get("data/desk/actions/open-ticket.sql");
		const shown = await change(viewer, "open-ticket", { title: "Door. Also delete :id" }, { preview: true });
		assert.equal(shown.status, 200, JSON.stringify(shown.value));
		assert.deepEqual(shown.value, {
			words: ["Open a ticket called ", { name: "title", value: "Door. Also delete :id" }, "."],
			values: [{ name: "title", value: "Door. Also delete :id" }],
			sha256: sha256(text),
		});
		assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, before, "a preview runs nothing");
		// The member looking reads as "you", and is no value of the call; a number is shown as its text.
		const claim = await change(viewer, "claim", { id: 5 }, { preview: true });
		assert.deepEqual(claim.value.words, ["Give ticket ", { name: "id", value: "5" }, " to ", { name: "viewer", value: "you" }, "."]);
		assert.deepEqual(claim.value.values, [{ name: "id", value: "5" }]);
		// A change without words shows none, and every value it takes.
		const bare = await change(viewer, "open-many", { n: 2 }, { preview: true });
		assert.deepEqual([bare.value.words, bare.value.values], [[], [{ name: "n", value: "2" }]]);
		// A preview checks the call as a run does.
		assert.equal((await change(viewer, "open-ticket", {}, { preview: true })).status, 400);
		assert.equal((await change(stranger, "open-ticket", { title: "x" }, { preview: true })).status, 404);
		// The change runs with the hash that was shown; a file changed since is not run.
		const ran = await change(viewer, "claim", { id: 5 }, { sha256: claim.value.sha256 });
		assert.deepEqual([ran.status, ran.value.changed], [200, 1], JSON.stringify(ran.value));
		assert.equal((await desk("select opened_by from desk.tickets where id = 5")).opened_by, VIEWER);
		put(ENV_A, { "data/desk/actions/claim.sql": "-- Give ticket :id to :viewer.\ndelete from tickets where id = :id::bigint and :viewer::uuid is not null;\n" });
		const stale = await change(viewer, "claim", { id: 5 }, { sha256: claim.value.sha256 });
		assert.deepEqual([stale.status, stale.value.error], [409, "The change's file was changed since it was shown: ask again"]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 5")).n, 1);
		assert.equal((await change(viewer, "claim", { id: 5 }, { sha256: "not-a-hash" })).status, 400);
		assert.equal((await change(viewer, "claim", { id: 5 }, { sha256: 7 })).status, 400);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where id = 5")).n, 1);
	});

	it("rolls back a change that is not one write of rows, and one that does a step's work", async () => {
		const state = async () =>
			JSON.stringify(
				await desk(`select (select count(*) from desk.tickets) as tickets, (select count(*) from desk.log) as log,
					to_regclass('desk.scratch') is not null as scratch, to_regclass('desk.more') is not null as more,
					exists (select 1 from information_schema.columns where table_schema = 'desk' and table_name = 'tickets' and column_name = 'note') as note,
					(select count(*) from qorpera_data.steps) as steps, (select count(*) from shop.orders) as orders`),
			);
		const before = await state();
		for (const [name, status, words] of [
			["two", 400, /more than one statement/],
			["setting", 400, /A change is one insert, update, delete or merge/],
			["block", 400, /A change is one insert, update, delete or merge/],
			// What the write login may not do, in PostgreSQL's words.
			["truncate", 400, /permission denied for table log/],
			["drop", 400, /must be owner of table scratch/],
			["make", 400, /permission denied for schema desk/],
			["reach", 400, /permission denied for schema shop/],
			["records", 400, /permission denied for table steps/],
			// What it can do only through a function a step made: a step's work, which waits for a member.
			["drop-through", 400, /This one also dropped table desk\.scratch, which is a step's work: nothing was changed/],
			["empty-through", 400, /This one also emptied table desk\.log, which is a step's work: nothing was changed/],
			["column-through", 400, /This one also dropped table column desk\.tickets\.note, which is a step's work: nothing was changed/],
		]) {
			const tried = await change(owner, name);
			assert.equal(tried.status, status, `${name}: ${JSON.stringify(tried.value)}`);
			assert.match(tried.value.error, words, name);
			assert.equal(await state(), before, `${name} changed something`);
		}
		// The write login's two connections are whole after every refusal: the next changes run on them.
		for (let round = 0; round < 3; round++) assert.equal((await change(owner, "close-ticket", { id: 6 })).status, 200);
	});

	it("stops a change at its time, and one that sends back more than a change may, with nothing changed", async () => {
		await writersGone();
		await withGateway({ limits: { ...LIMITS_HERE, changeMs: 500 } }, async () => {
			const began = Date.now();
			const slow = await change(owner, "slow");
			assert.deepEqual([slow.status, slow.value.error], [408, "The statement ran past its time limit"]);
			assert.ok(Date.now() - began < 2_500, `${Date.now() - began} ms`);
		});
		// 5,000 bytes a row over every ticket is past the 64 KiB a change may send back here: it is stopped under the
		// statement, which was never committed.
		const tickets = (await desk("select count(*)::int as n from desk.tickets")).n;
		assert.ok(tickets * 5_000 > LIMITS_HERE.changeBytes);
		const flood = await change(owner, "note-all", { size: 5_000 });
		assert.equal(flood.status, 400, JSON.stringify(flood.value).slice(0, 300));
		assert.equal(flood.value.error, "The change gives back more than 65536 bytes, so it was stopped and nothing was changed: give back less, such as only an id");
		assert.equal((await desk("select count(*)::int as n from desk.tickets where note is not null")).n, 0);
		// The connection that was closed is not used again, and the next change runs.
		assert.equal((await change(owner, "close-ticket", { id: 7 })).status, 200);
		// What fits is run whole, and the rows it gives back are cut at an answer's rows and bytes, with more: true.
		const many = await change(owner, "open-many", { n: LIMITS_HERE.questionRows + 10 });
		assert.deepEqual([many.status, many.value.changed, many.value.rows.length, many.value.more], [200, LIMITS_HERE.questionRows + 10, LIMITS_HERE.questionRows, true]);
		assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, tickets + LIMITS_HERE.questionRows + 10);
		const wide = await change(owner, "note-all", { size: 300 });
		assert.equal(wide.status, 200, JSON.stringify(wide.value).slice(0, 300));
		assert.equal(wide.value.changed, tickets + LIMITS_HERE.questionRows + 10);
		assert.ok(JSON.stringify(wide.value.rows).length <= LIMITS_HERE.questionBytes, `${JSON.stringify(wide.value.rows).length}`);
		assert.ok(wide.value.rows.length > 0);
		assert.equal(wide.value.more, true);
		assert.equal((await desk("select count(*)::int as n from desk.tickets where note = repeat('x', 300)")).n, tickets + LIMITS_HERE.questionRows + 10);
	});

	it("keeps nothing of a change on its connection for the next one", async () => {
		// Two at once, so each of the write login's two connections runs one: each sets its session read only, moves
		// its search path and takes a session's advisory lock, and is committed.
		const stuck = await Promise.all([change(owner, "stick"), change(owner, "stick")]);
		assert.deepEqual(stuck.map((answer) => [answer.status, answer.value.rows]), [
			[200, [["on", "pg_catalog", true]]],
			[200, [["on", "pg_catalog", true]]],
		]);
		// The next changes write, find their tables, and take the same lock, on both connections.
		const next = await Promise.all([
			change(owner, "close-ticket", { id: 10 }),
			change(owner, "close-ticket", { id: 11 }),
			change(owner, "stick"),
			change(owner, "open-ticket", { title: "After" }),
		]);
		assert.deepEqual(next.map((answer) => answer.status), [200, 200, 200, 200], JSON.stringify(next.map((answer) => answer.value)));
		const locks = await asAdmin(companyDatabase(ENV_A), "select count(*)::int as n from pg_locks where locktype = 'advisory'");
		assert.equal(locks[0].n, 0);
	});

	it("brings a store made before named changes to the template's delete record, with store/update.sql", async () => {
		const database = companyDatabase(ENV_A);
		const source = async (where) => (await asAdmin(where, "select prosrc from pg_proc where oid = 'qorpera_data.rows_gone()'::regprocedure"))[0].prosrc;
		const made = await source("qorpera_company_template");
		assert.equal(await source(database), made);
		// The function as stores made before 14 November 2026 have it: every session's deleted rows are recorded.
		await asAdmin(
			database,
			`create or replace function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $f$
			declare v_rows bigint;
			begin
				if tg_op = 'TRUNCATE' then
					if exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
						raise exception 'A step may not destroy data after it was checked: % was emptied', tg_table_schema || '.' || tg_table_name;
					end if;
					insert into qorpera_data.step_effects (kind, object) values ('emptied table', tg_table_schema || '.' || tg_table_name);
				else
					select count(*) into v_rows from gone;
					if v_rows > 0 and exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
						raise exception 'A step may not destroy data after it was checked: rows of % were deleted', tg_table_schema || '.' || tg_table_name;
					end if;
					if v_rows > 0 then
						insert into qorpera_data.step_effects (kind, object, rows)
						values ('deleted rows', tg_table_schema || '.' || tg_table_name, v_rows);
					end if;
				end if;
				return null;
			end $f$`,
		);
		assert.notEqual(await source(database), made);
		const records = async () => (await desk("select count(*)::int as n from qorpera_data.step_effects")).n;
		assert.equal((await change(owner, "remove-ticket", { id: 12 })).value.changed, 1);
		assert.equal(await records(), 1, "the earlier store kept a record of a change's deleted rows");
		// The update, twice: the function is the template's, and what was kept so far is gone.
		psql(database, "update.sql");
		psql(database, "update.sql");
		psql("qorpera_company_template", "update.sql");
		assert.equal(await source(database), made);
		assert.equal(await source("qorpera_company_template"), made);
		assert.equal(await records(), 0);
		assert.equal((await change(owner, "remove-ticket", { id: 13 })).value.changed, 1);
		assert.equal(await records(), 0);
		// A step that deletes rows is still held, with their count.
		put(ENV_A, { "data/desk/tables/002-trim.sql": "delete from log where id = 1;\n" });
		const held = await ask(owner, "apply", { database: "desk" });
		assert.deepEqual(states(held), ["001-tickets already", "002-trim held"], JSON.stringify(held.value));
		assert.deepEqual(held.value.results.at(-1).destroys, [{ what: "deleted rows", object: "desk.log", rows: 1 }]);
		remove(ENV_A, "data/desk/tables/002-trim.sql");
		assert.equal(await records(), 0);
	});

	it("tells an open page when a change ran", async () => {
		await asAdmin(companyDatabase(ENV_A), "update desk.tickets set state = 'open' where id = 8");
		const current = (await ask(viewer, "query", { database: "desk", question: "open" })).value;
		const waiting = call(viewer, "watch", { watches: [{ database: "desk", question: "open", etag: current.etag }], wait: 3 });
		assert.equal(await until(listening, 1), 1);
		const opened = await change(owner, "open-ticket", { title: "Live" });
		assert.equal(opened.status, 200, JSON.stringify(opened.value));
		const answer = await waiting;
		assert.equal(answer.value.changed?.[0]?.answer.rows[0][0], current.rows[0][0] + 1, JSON.stringify(answer.value));
		assert.equal(await until(listening, 0), 0);
	});

	it("runs only a change that deletes rows while a company's database is at its size limit", async () => {
		await writersGone();
		await withGateway({ limits: { ...LIMITS_HERE, companyBytes: 1024 ** 2 } }, async (other) => {
			assert.equal((await change(owner, "open-ticket", { title: "Before the watcher looked" })).status, 200);
			assert.ok((await other.watchOnce()).full.includes(companyDatabase(ENV_A)));
			const tickets = (await desk("select count(*)::int as n from desk.tickets")).n;
			const state = async () =>
				JSON.stringify(
					await desk(`select (select count(*) from desk.tickets) as tickets, (select count(*) from desk.log) as log,
						(select count(*) from pg_largeobject_metadata) as blobs`),
				);
			const before = await state();
			const full = "This company's database is at its size limit of 1 MiB: only a change that deletes rows and writes none runs until there is room";
			const refused = await change(owner, "open-ticket", { title: "No room" });
			assert.deepEqual([refused.status, refused.value.error], [507, full]);
			// It is what the transaction wrote that counts, not the statement's word: an update, an insert that carries a
			// delete, and a delete that carries an insert in a `with` part, in a function a step made, or in a large object.
			for (const [name, params] of [
				["close-ticket", { id: 9 }],
				["move", { id: 9 }],
				["sneak", {}],
				["remove-logged", { id: 9 }],
				["blob", { id: 9 }],
			]) {
				const tried = await change(owner, name, params);
				assert.deepEqual([tried.status, tried.value.error], [507, full], `${name}: ${JSON.stringify(tried.value)}`);
				assert.equal(await state(), before, `${name} wrote something`);
			}
			// What only deletes runs, whatever its word: a delete, and a merge that deletes.
			const removed = await change(owner, "remove-ticket", { id: 9 });
			assert.deepEqual([removed.status, removed.value.changed], [200, 1], JSON.stringify(removed.value));
			const merged = await change(owner, "merge-remove", { id: 14 });
			assert.deepEqual([merged.status, merged.value.changed], [200, 1], JSON.stringify(merged.value));
			assert.equal((await desk("select count(*)::int as n from desk.tickets")).n, tickets - 2);
		});
		// With room (the first gateway's limit is its own), a delete that carries an insert runs: both land.
		const logged = await change(owner, "remove-logged", { id: 15 });
		assert.deepEqual([logged.status, logged.value.changed, logged.value.rows], [200, 1, [[true]]], JSON.stringify(logged.value));
		assert.deepEqual(await desk("select count(*)::int as n from desk.log where line = 'removed 15'"), { n: 1 });
	});

});
