// Proof 3: limits per company, the walls between companies, and catching a step that destroys data.
import { check, connection, finish, note, now, outcome, pg, sleep, withAdmin } from "./lib.mjs";

const client = async (database, user, password = "proof") => {
	const made = new pg.Client(connection(database, user, password));
	await made.connect();
	return made;
};

await withAdmin("postgres", async (db) => {
	// The gateway's three logins: each is a member only of the company roles its door needs.
	await db.query("create role cdl_gw_read login noinherit password 'proof'");
	await db.query("create role cdl_gw_write login noinherit password 'proof'");
	await db.query("create role cdl_gw_owner login noinherit password 'proof'");
	await db.query("create role cdl_watch login password 'proof' in role pg_signal_backend, pg_read_all_stats");
	for (const company of ["cdl_a", "cdl_b"]) {
		await db.query(`create role ${company}_owner nologin; create role ${company}_write nologin; create role ${company}_read nologin`);
		// A company's product gets a login of its own (the later "server's connection"), limited by the server itself.
		await db.query(`create role ${company}_app login noinherit password 'proof' connection limit 3`);
		await db.query(`alter role ${company}_app set statement_timeout = '2s'`);
		await db.query(`alter role ${company}_app set temp_file_limit = '8MB'`);
		await db.query(`alter role ${company}_app set role = '${company}_write'`);
		await db.query(`grant ${company}_write to ${company}_app`);
		await db.query(`grant ${company}_read to cdl_gw_read; grant ${company}_write to cdl_gw_write; grant ${company}_owner to cdl_gw_owner`);
		await db.query(`create database ${company} connection limit 6`);
		await db.query(`revoke connect on database ${company} from public`);
		await db.query(`grant connect on database ${company} to cdl_gw_read, cdl_gw_write, cdl_gw_owner, cdl_watch, ${company}_app`);
	}
});
for (const company of ["cdl_a", "cdl_b"]) {
	await withAdmin(company, async (db) => {
		await db.query(`
			revoke create on schema public from public;
			create schema shop authorization ${company}_owner;
			set role ${company}_owner;
			create table shop.orders (id bigserial primary key, amount numeric(12,2) not null, note text);
			insert into shop.orders (amount, note) select n, repeat('x', 200) from generate_series(1, 20000) n;
			create function shop.raw(text) returns bigint language plpgsql as $$ declare n bigint; begin execute $1 into n; return n; end $$;
			grant usage on schema shop to ${company}_read, ${company}_write;
			grant select on all tables in schema shop to ${company}_read, ${company}_write;
			grant insert, update, delete on all tables in schema shop to ${company}_write;
			grant usage on all sequences in schema shop to ${company}_write;
			reset role;
		`);
	});
}

// ---- 1. walls between companies
{
	const wrongDoor = await outcome(() => client("cdl_b", "cdl_a_app"));
	check("a company's own login cannot open another company's database", !wrongDoor.ok && wrongDoor.code === "42501",
		`${wrongDoor.code} ${wrongDoor.message}`);
	const app = await client("cdl_a", "cdl_a_app");
	const asOther = await outcome(() => app.query("set role cdl_b_write"));
	check("it cannot take another company's role", !asOther.ok, `${asOther.code}`);
	const others = await app.query("select count(*) filter (where query is not null and query <> '<insufficient privilege>')::int as seen, count(*)::int as n from pg_stat_activity where usename is distinct from current_user and datname is distinct from current_database()");
	check("it sees no other company's statements", others.rows[0].seen === 0, `${others.rows[0].seen} of ${others.rows[0].n} visible`);
	for (const [label, sql] of [
		["read a server file", "select pg_read_file('/etc/passwd')"],
		["list a server folder", "select pg_ls_dir('/')"],
		["run a program", "copy shop.orders to program 'id'"],
		["write a server file", "copy shop.orders to '/tmp/cdl-proof.csv'"],
		["add dblink", "create extension dblink"],
		["add a C function", "create function shop.c() returns int language c as 'x', 'y'"],
		["change server settings", "alter system set work_mem = '1GB'"],
		["make a database", "create database cdl_mine"],
		["make a role", "create role cdl_mine"],
		["lift its temp file limit", "set temp_file_limit = -1"],
	]) {
		const tried = await outcome(() => app.query(sql));
		check(`a company login cannot ${label}`, !tried.ok, `${tried.code}`);
	}
	const names = await app.query("select count(*)::int as n from pg_database where datname like 'cdl_%'");
	note(`it can list database names (${names.rows[0].n} seen): names must not say whose they are`);
	await app.end();
}

// ---- 2. connections per company
{
	const held = [];
	let refused = null;
	for (let index = 0; index < 8 && !refused; index++) {
		const tried = await outcome(async () => held.push(await client("cdl_a", "cdl_gw_read")));
		if (!tried.ok) refused = tried;
	}
	check("a company database takes 6 connections and refuses the 7th", held.length === 6 && refused?.code === "53300",
		`${held.length} opened, then ${refused?.code}`);
	const other = await outcome(async () => (await client("cdl_b", "cdl_gw_read")).end());
	check("another company still connects while that one is full", other.ok);
	await Promise.all(held.map((entry) => entry.end()));
	const apps = [];
	let appRefused = null;
	for (let index = 0; index < 5 && !appRefused; index++) {
		const tried = await outcome(async () => apps.push(await client("cdl_a", "cdl_a_app")));
		if (!tried.ok) appRefused = tried;
	}
	check("a company's own login takes 3 connections and refuses the 4th", apps.length === 3 && appRefused?.code === "53300",
		`${apps.length} opened, then ${appRefused?.code}`);
	await Promise.all(apps.map((entry) => entry.end()));
}

// ---- 3. time per statement, through the gateway and on a company's own login
{
	const gateway = await client("cdl_a", "cdl_gw_read");
	const run = async (text) => {
		await gateway.query("begin transaction read only; set local statement_timeout = '300ms'; set local role cdl_a_read");
		const started = now();
		const result = await outcome(() => gateway.query({ text, queryMode: "extended" }));
		await gateway.query("rollback");
		return { ...result, ms: Math.round(now() - started) };
	};
	const slow = await run("select pg_sleep(3)");
	check("the gateway's 300 ms limit stops a slow read", slow.code === "57014" && slow.ms < 1000, `${slow.code} after ${slow.ms} ms`);
	const lifted = await run("select set_config('statement_timeout', '0', true), pg_sleep(3)");
	check("a read that lifts its own limit is still stopped", lifted.code === "57014" && lifted.ms < 1000,
		`${lifted.code} after ${lifted.ms} ms`);
	const two = await run("select 1; select 2");
	check("two statements in one call are refused", two.code === "42601", `${two.code}`);
	const write = await run("insert into shop.orders (amount) values (1)");
	check("a write inside a read is refused", !write.ok && (write.code === "25006" || write.code === "42501"), `${write.code}`);
	const readWrite = await run("select set_config('transaction_read_only', 'off', true)");
	check("a read cannot make its transaction writable", !readWrite.ok, `${readWrite.code} ${readWrite.message}`);
	const up = await run("select set_config('role', 'cdl_a_owner', true)");
	check("a read cannot take the owner's role", !up.ok, `${up.code}`);
	const through = await run("select shop.raw('select count(*) from shop.orders')");
	check("a company's own function runs inside a read", through.ok);
	const throughWrite = await run("select shop.raw('with gone as (delete from shop.orders returning 1) select count(*) from gone')");
	check("a company's own function cannot write inside a read", !throughWrite.ok, `${throughWrite.code}`);
	const rows = await run("select count(*) from shop.orders");
	check("nothing was written by the refused tries", rows.ok);
	await gateway.end();

	const app = await client("cdl_a", "cdl_a_app");
	const started = now();
	const own = await outcome(() => app.query("select pg_sleep(5)"));
	check("a company login's own 2 s limit stops its statement", own.code === "57014", `${own.code} after ${Math.round(now() - started)} ms`);
	await app.query("set statement_timeout = 0");
	// The limit on a login is a default the login can lift: so a watcher ends what runs too long.
	const watcher = await client("postgres", "cdl_watch");
	const long = app.query("select pg_sleep(30)").then(
		() => ({ code: null }),
		(error) => ({ code: error.code }),
	);
	const begun = now();
	let cancelled = 0;
	while (now() - begun < 8000 && cancelled === 0) {
		await sleep(250);
		const found = await watcher.query(
			`select pg_cancel_backend(pid) from pg_stat_activity where usename like 'cdl_%_app' and state = 'active'
				and now() - query_start > interval '3 seconds'`,
		);
		cancelled += found.rowCount;
	}
	const ended = await long;
	check("a statement that lifted its own limit is ended by the watcher", ended.code === "57014",
		`${ended.code} after ${Math.round(now() - begun)} ms`);
	const sorted = await outcome(() => app.query("select count(*) from (select * from shop.orders a, generate_series(1, 20) g order by a.note, g) s"));
	check("a company login's sort past 8 MB of temp files is refused", sorted.code === "53400", `${sorted.code}`);
	await watcher.end();
	await app.end();
}

// ---- 4. size: what watching it costs, and closing writes when a company is over
{
	const watcher = await client("postgres", "cdl_watch");
	const started = now();
	const sizes = await watcher.query("select datname, pg_database_size(oid) as bytes from pg_database where datname like 'cdl_%'");
	note(`size of ${sizes.rowCount} company databases read in ${Math.round(now() - started)} ms: ${sizes.rows.map((row) => `${row.datname} ${Math.round(row.bytes / 1048576)} MiB`).join(", ")}`);
	await watcher.end();
	const app = await client("cdl_a", "cdl_a_app");
	await app.query("insert into shop.orders (amount) values (1)");
	// Over its size: the write role is taken from the login, the read role given. No reconnect.
	await withAdmin("postgres", async (db) => {
		await db.query("revoke cdl_a_write from cdl_a_app; grant cdl_a_read to cdl_a_app; alter role cdl_a_app set role = 'cdl_a_read'");
	});
	// A session that is already open keeps the role it took when it began, so the watcher also ends the login's sessions.
	const stillOpen = await outcome(() => app.query("insert into shop.orders (amount) values (1)"));
	note(`an open session keeps writing until it is ended: ${stillOpen.ok ? "it wrote" : stillOpen.code}`);
	app.on("error", () => undefined);
	const ender = await client("postgres", "cdl_watch");
	const ended = await ender.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = 'cdl_a_app'");
	await ender.end();
	await sleep(200);
	const afterEnd = await outcome(() => app.query("insert into shop.orders (amount) values (1)"));
	check("over its size, the watcher ends a company login's open sessions", ended.rowCount === 1 && !afterEnd.ok,
		`${ended.rowCount} ended`);
	const fresh = await client("cdl_a", "cdl_a_app");
	const freshWrite = await outcome(() => fresh.query("insert into shop.orders (amount) values (1)"));
	const freshRead = await outcome(() => fresh.query("select count(*) from shop.orders"));
	const backToWrite = await outcome(() => fresh.query("set role cdl_a_write"));
	check("over its size, a new session reads and cannot write", freshRead.ok && !freshWrite.ok && !backToWrite.ok,
		`${freshWrite.code}, taking the write role: ${backToWrite.code}`);
	await app.end().catch(() => undefined);
	await fresh.end();
}

// ---- 5. a step that destroys data is seen before it lands
{
	await withAdmin("cdl_b", async (db) => {
		await db.query(`
			create schema qorpera_data;
			create table qorpera_data.step_effects (txid bigint not null default txid_current(), kind text not null,
				object text not null, rows bigint);
			grant insert, select on qorpera_data.step_effects to public;
			grant usage on schema qorpera_data to public;
			create function qorpera_data.dropped() returns event_trigger language plpgsql security definer set search_path = '' as $$
			declare gone record;
			begin
				for gone in select * from pg_event_trigger_dropped_objects()
					where object_type in ('table', 'table column', 'schema') and not is_temporary
						and schema_name is distinct from 'qorpera_data' and (original or object_type = 'table')
				loop
					insert into qorpera_data.step_effects (kind, object) values ('dropped ' || gone.object_type, gone.object_identity);
				end loop;
			end $$;
			create event trigger qorpera_dropped on sql_drop execute function qorpera_data.dropped();
			create function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $$
			declare n bigint;
			begin
				if tg_op = 'TRUNCATE' then
					insert into qorpera_data.step_effects (kind, object) values ('emptied table', tg_table_schema || '.' || tg_table_name);
				else
					select count(*) into n from gone;
					if n > 0 then
						insert into qorpera_data.step_effects (kind, object, rows) values ('deleted rows', tg_table_schema || '.' || tg_table_name, n);
					end if;
				end if;
				return null;
			end $$;
			create trigger qorpera_rows_gone after delete on shop.orders referencing old table as gone
				for each statement execute function qorpera_data.rows_gone();
			create trigger qorpera_emptied before truncate on shop.orders for each statement execute function qorpera_data.rows_gone();
			set role cdl_b_owner;
			create table shop.customers (id bigserial primary key, name text, phone text);
			reset role;
		`);
	});
	const owner = await client("cdl_b", "cdl_gw_owner");
	const apply = async (label, sql, allowed) => {
		await owner.query("begin; set local lock_timeout = '2s'; set local statement_timeout = '30s'; set local role cdl_b_owner");
		const ran = await outcome(() => owner.query(sql));
		const effects = ran.ok
			? (await owner.query("select kind, object, rows from qorpera_data.step_effects where txid = txid_current() order by 1, 2")).rows
			: [];
		const destroys = effects.length > 0;
		await owner.query(destroys && !allowed ? "rollback" : "commit");
		note(`${label}: ${ran.ok ? (destroys ? effects.map((effect) => `${effect.kind} ${effect.object}${effect.rows ? ` (${effect.rows})` : ""}`).join("; ") : "destroys nothing") : `failed ${ran.code}`}${destroys && !allowed ? " -> held for a member" : ran.ok ? " -> applied" : ""}`);
		return { ran, effects, destroys };
	};
	const add = await apply("add a column", "alter table shop.orders add column shipped_at timestamptz", false);
	check("a step that only adds is applied", add.ran.ok && !add.destroys);
	const backfill = await apply("fill a column", "update shop.orders set note = 'kept'", false);
	check("a step that updates rows is applied", backfill.ran.ok && !backfill.destroys);
	const dropColumn = await apply("drop a column", "alter table shop.customers drop column phone", false);
	check("a step that drops a column is held", dropColumn.destroys && dropColumn.effects.some((effect) => effect.kind === "dropped table column"));
	const dropTable = await apply("drop a table", "drop table shop.customers", false);
	check("a step that drops a table is held", dropTable.destroys && dropTable.effects.some((effect) => effect.kind === "dropped table"));
	const del = await apply("delete rows", "delete from shop.orders where id <= 100", false);
	check("a step that deletes rows is held, with the count", del.effects.some((effect) => effect.kind === "deleted rows" && Number(effect.rows) === 100));
	const truncate = await apply("empty a table", "truncate shop.orders", false);
	check("a step that empties a table is held", truncate.effects.some((effect) => effect.kind === "emptied table"));
	const hidden = await apply("delete inside a function", "select shop.raw('with gone as (delete from shop.orders where id <= 5 returning 1) select count(*) from gone')", false);
	check("a delete hidden inside a function is held too", hidden.effects.some((effect) => effect.kind === "deleted rows" && Number(effect.rows) === 5));
	await owner.query("set role cdl_b_owner");
	const state = await owner.query("select (select count(*) from shop.orders)::int as orders, (select count(*) from information_schema.columns where table_schema = 'shop' and table_name = 'customers')::int as customer_columns");
	check("every held step left the data as it was", state.rows[0].orders === 20000 && state.rows[0].customer_columns === 3,
		`${state.rows[0].orders} orders, ${state.rows[0].customer_columns} customer columns`);
	const yes = await apply("delete rows, after a member's yes", "delete from shop.orders where id <= 100", true);
	await owner.query("set role cdl_b_owner");
	const after = await owner.query("select count(*)::int as n from shop.orders");
	check("the same step lands after a member's yes", yes.destroys && after.rows[0].n === 19900, `${after.rows[0].n} orders`);
	await owner.end();
}
finish();
