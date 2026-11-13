// Proof 3: limits per company, the walls between companies and between a company's database folders, and catching a
// step that destroys data, also when the step tries to switch Qorpera's triggers off.
// Each database folder has three roles that log in themselves: an owner, a write and a read role. Each is a member of
// no other role. The gateway connects as the folder's own role, never as a shared login that could switch roles.
import { createHmac, randomBytes } from "node:crypto";
import { check, connection, finish, note, now, outcome, pg, sleep, withAdmin } from "./lib.mjs";

// The gateway derives each role's password from one key it holds and stores nowhere.
const KEY = randomBytes(32);
const password = (role) => createHmac("sha256", KEY).update(role).digest("base64url");
const client = async (database, user) => {
	const made = new pg.Client(connection(database, user, password(user)));
	await made.connect();
	return made;
};
// A closed session's server process ends a moment after the client: wait until a database has no company session left.
async function quiet(database) {
	for (let tries = 0; tries < 100; tries++) {
		const open = await withAdmin("postgres", (db) =>
			db.query("select count(*)::int as n from pg_stat_activity where datname = $1 and usename like 'cdl_%'", [database]));
		if (open.rows[0].n === 0) return;
		await sleep(50);
	}
}
const COMPANIES = ["cdl_a", "cdl_b"];
const FOLDERS = { shop: { owner: 1, write: 2, read: 3 }, payroll: { owner: 1, write: 2, read: 3 } };
const role = (company, folder, kind) => `${company}_${folder}_${kind}`;

// ---- the template every company database is made from: Qorpera's schema, its triggers and its event triggers
await withAdmin("postgres", (db) => db.query("create database cdl_template"));
await withAdmin("cdl_template", (db) =>
	db.query(`
		revoke create on schema public from public;
		create schema qorpera_data;
		grant usage on schema qorpera_data to public;

		-- What a step destroyed, by transaction. Only Qorpera's own functions write it; no company role can.
		create table qorpera_data.step_effects (txid bigint not null default txid_current(), kind text not null,
			object text not null, rows bigint);

		-- Says that a table changed, once per statement.
		create function qorpera_data.changed() returns trigger language plpgsql security definer set search_path = '' as $$
		begin
			perform pg_notify('qorpera_data', tg_table_schema || '.' || tg_table_name);
			return null;
		end $$;

		-- Records deleted rows with their count, and an emptied table.
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

		-- Qorpera's three triggers as they must stand on every table: a model table carries them, and every table's
		-- triggers named qorpera_ must be the same as the model's.
		create table qorpera_data.model ();
		create trigger qorpera_changed after insert or update or delete or truncate on qorpera_data.model
			for each statement execute function qorpera_data.changed();
		create trigger qorpera_rows_gone after delete on qorpera_data.model referencing old table as gone
			for each statement execute function qorpera_data.rows_gone();
		create trigger qorpera_emptied before truncate on qorpera_data.model
			for each statement execute function qorpera_data.rows_gone();

		-- A dropped table, column or schema is recorded. Dropping one of Qorpera's triggers is refused.
		create function qorpera_data.dropped() returns event_trigger language plpgsql security definer set search_path = '' as $$
		declare gone record;
		begin
			for gone in select * from pg_event_trigger_dropped_objects() where not is_temporary loop
				if gone.object_type = 'trigger' and gone.original and gone.object_identity like 'qorpera\\_% on %' then
					raise exception 'Qorpera''s trigger % cannot be dropped', gone.object_identity;
				end if;
				if gone.object_type in ('table', 'table column', 'schema') and gone.schema_name is distinct from 'qorpera_data'
					and (gone.original or gone.object_type = 'table') then
					insert into qorpera_data.step_effects (kind, object) values ('dropped ' || gone.object_type, gone.object_identity);
				end if;
			end loop;
		end $$;
		create event trigger qorpera_dropped on sql_drop execute function qorpera_data.dropped();

		-- After a statement that changes a table or a trigger: every table it touched must still carry Qorpera's three
		-- triggers as the model has them, enabled as origin or always, and must be kept logged.
		create function qorpera_data.guard() returns event_trigger language plpgsql security definer set search_path = '' as $$
		declare touched record; wrong record; kept int;
		begin
			for touched in
				select distinct c.oid::regclass as tab, c.relpersistence, d.command_tag
				from pg_event_trigger_ddl_commands() d
				join pg_catalog.pg_class c on c.oid = case when d.classid = 'pg_catalog.pg_trigger'::regclass
					then (select t.tgrelid from pg_catalog.pg_trigger t where t.oid = d.objid) else d.objid end
				where d.classid in ('pg_catalog.pg_class'::regclass, 'pg_catalog.pg_trigger'::regclass)
					and c.relkind in ('r', 'p') and c.relpersistence <> 't' and c.relnamespace <> 'qorpera_data'::regnamespace
			loop
				if touched.relpersistence <> 'p' then
					raise exception 'Qorpera keeps every table logged: % is not', touched.tab;
				end if;
				for wrong in
					select t.tgname from pg_catalog.pg_trigger t
					left join pg_catalog.pg_trigger m on m.tgrelid = 'qorpera_data.model'::regclass and m.tgname = t.tgname
					where t.tgrelid = touched.tab and not t.tgisinternal and t.tgname like 'qorpera\\_%'
						and (m.oid is null or t.tgenabled not in ('O', 'A')
							or (t.tgfoid, t.tgtype, t.tgoldtable, t.tgnewtable, t.tgqual is null, t.tgattr::text, t.tgargs, t.tgconstraint)
								is distinct from (m.tgfoid, m.tgtype, m.tgoldtable, m.tgnewtable, true, m.tgattr::text, m.tgargs, m.tgconstraint))
				loop
					raise exception 'Qorpera''s trigger % on % must stay as Qorpera made it', wrong.tgname, touched.tab;
				end loop;
				-- While a new table gets its triggers one by one, the first ones stand alone: so not for CREATE TRIGGER.
				if touched.command_tag <> 'CREATE TRIGGER' then
					select count(*) into kept from pg_catalog.pg_trigger t
						join pg_catalog.pg_trigger m on m.tgrelid = 'qorpera_data.model'::regclass and m.tgname = t.tgname
						where t.tgrelid = touched.tab;
					if kept < 3 then
						raise exception 'Qorpera''s triggers on % are missing', touched.tab;
					end if;
				end if;
			end loop;
		end $$;
		create event trigger qorpera_guard on ddl_command_end when tag in ('ALTER TABLE', 'CREATE TRIGGER', 'ALTER TRIGGER')
			execute function qorpera_data.guard();

		-- Every new table gets the three triggers, whoever makes it. A table that is not kept logged is refused.
		create function qorpera_data.new_table() returns event_trigger language plpgsql security definer set search_path = '' as $$
		declare made record;
		begin
			for made in
				select distinct c.oid::regclass as tab, c.relpersistence from pg_event_trigger_ddl_commands() d
				join pg_catalog.pg_class c on c.oid = d.objid
				where d.classid = 'pg_catalog.pg_class'::regclass and c.relkind in ('r', 'p') and c.relpersistence <> 't'
					and c.relnamespace <> 'qorpera_data'::regnamespace
			loop
				if made.relpersistence <> 'p' then
					raise exception 'Qorpera keeps every table logged: % is not', made.tab;
				end if;
				execute format('create trigger qorpera_changed after insert or update or delete or truncate on %s
					for each statement execute function qorpera_data.changed()', made.tab);
				execute format('create trigger qorpera_rows_gone after delete on %s referencing old table as gone
					for each statement execute function qorpera_data.rows_gone()', made.tab);
				execute format('create trigger qorpera_emptied before truncate on %s
					for each statement execute function qorpera_data.rows_gone()', made.tab);
			end loop;
		end $$;
		create event trigger qorpera_new_table on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
			execute function qorpera_data.new_table();

		-- A step runs inside a function, so it cannot end the transaction and go on outside it.
		create function qorpera_data.apply_step(step text) returns void language plpgsql as $$
		begin
			execute step;
		end $$;
		-- What this transaction's step destroyed.
		create function qorpera_data.effects() returns table (kind text, object text, rows bigint) language sql
			security definer set search_path = '' as $$
			select e.kind, e.object, e.rows from qorpera_data.step_effects e where e.txid = txid_current() order by 1, 2
		$$;
	`),
);

// ---- the roles and the company databases
await withAdmin("postgres", async (db) => {
	await db.query(`create role cdl_watch login password '${password("cdl_watch")}' in role pg_signal_backend, pg_read_all_stats`);
	for (const company of COMPANIES) {
		for (const [folder, limits] of Object.entries(FOLDERS)) {
			for (const [kind, limit] of Object.entries(limits)) {
				const name = role(company, folder, kind);
				await db.query(`create role ${name} login noinherit connection limit ${limit} password '${password(name)}'`);
			}
		}
		// A company's product gets a login of its own (the later "server's connection"), limited by the server itself.
		const app = `${company}_app`;
		await db.query(`create role ${app} login noinherit password '${password(app)}' connection limit 3`);
		await db.query(`alter role ${app} set statement_timeout = '2s'`);
		await db.query(`alter role ${app} set temp_file_limit = '8MB'`);
		await db.query(`grant ${role(company, "shop", "write")} to ${app}`);
		await db.query(`alter role ${app} set role = '${role(company, "shop", "write")}'`);
		await db.query(`create database ${company} template cdl_template connection limit 12`);
		await db.query(`revoke connect on database ${company} from public`);
		const logins = Object.entries(FOLDERS).flatMap(([folder, limits]) => Object.keys(limits).map((kind) => role(company, folder, kind)));
		await db.query(`grant connect on database ${company} to ${logins.join(", ")}, cdl_watch, ${app}`);
	}
});
for (const company of COMPANIES) {
	await withAdmin(company, async (db) => {
		for (const folder of Object.keys(FOLDERS)) await db.query(`create schema ${folder} authorization ${role(company, folder, "owner")}`);
	});
	const shop = await client(company, role(company, "shop", "owner"));
	await shop.query(`
		create table shop.orders (id bigserial primary key, amount numeric(12,2) not null, note text);
		insert into shop.orders (amount, note) select n, repeat('x', 200) from generate_series(1, 20000) n;
		create table shop.customers (id bigserial primary key, name text, phone text);
		insert into shop.customers (name, phone) select 'Customer ' || n, '555-' || n from generate_series(1, 50) n;
		create table shop.carts (id bigint primary key);
		create table shop.cart_lines (id bigserial primary key, cart_id bigint not null references shop.carts on delete cascade);
		insert into shop.carts select generate_series(1, 100);
		insert into shop.cart_lines (cart_id) select c from generate_series(1, 100) c, generate_series(1, 3);
		create function shop.raw(text) returns bigint language plpgsql as $$ declare n bigint; begin execute $1 into n; return n; end $$;
		create function shop.mine() returns trigger language plpgsql as $$ begin return null; end $$;
		grant usage on schema shop to ${role(company, "shop", "read")}, ${role(company, "shop", "write")};
		grant select on all tables in schema shop to ${role(company, "shop", "read")}, ${role(company, "shop", "write")};
		grant insert, update, delete on all tables in schema shop to ${role(company, "shop", "write")};
		grant usage on all sequences in schema shop to ${role(company, "shop", "write")};
	`);
	await shop.end();
	const payroll = await client(company, role(company, "payroll", "owner"));
	await payroll.query(`
		create table payroll.salaries (id bigserial primary key, person text not null, amount numeric(12,2) not null);
		insert into payroll.salaries (person, amount) select 'Person ' || n, 30000 + n from generate_series(1, 40) n;
		grant usage on schema payroll to ${role(company, "payroll", "read")}, ${role(company, "payroll", "write")};
		grant select on all tables in schema payroll to ${role(company, "payroll", "read")}, ${role(company, "payroll", "write")};
		grant insert, update, delete on all tables in schema payroll to ${role(company, "payroll", "write")};
	`);
	await payroll.end();
}

// ---- 1. every folder role logs in itself and is a member of no other role
{
	const roles = await withAdmin("postgres", (db) =>
		db.query(`select r.rolname, r.rolcanlogin, r.rolinherit, r.rolconnlimit,
				(select count(*) from pg_auth_members m where m.member = r.oid)::int as memberships
			from pg_roles r where r.rolname ~ '^cdl_[ab]_(shop|payroll)_(owner|write|read)$' order by 1`),
	);
	const wrong = roles.rows.filter((row) => !row.rolcanlogin || row.rolinherit || row.memberships > 0);
	check("each folder's owner, write and read role logs in itself, noinherit, a member of no role",
		roles.rowCount === 12 && wrong.length === 0, `${roles.rowCount} roles, ${wrong.map((row) => row.rolname).join(", ") || "none wrong"}`);
}

// ---- 2. walls between companies
{
	const wrongDoor = await outcome(() => client("cdl_b", "cdl_a_app"));
	check("a company's own login cannot open another company's database", !wrongDoor.ok && wrongDoor.code === "42501",
		`${wrongDoor.code} ${wrongDoor.message}`);
	const wrongFolderDoor = await outcome(() => client("cdl_b", "cdl_a_shop_owner"));
	check("a folder's owner login cannot open another company's database", !wrongFolderDoor.ok && wrongFolderDoor.code === "42501",
		`${wrongFolderDoor.code}`);
	for (const [who, login] of [["a company's own login", "cdl_a_app"], ["a folder's owner login", "cdl_a_shop_owner"]]) {
		const app = await client("cdl_a", login);
		const asOther = await outcome(() => app.query("set role cdl_b_shop_write"));
		check(`${who} cannot take another company's role`, !asOther.ok, `${asOther.code}`);
		const others = await app.query("select count(*) filter (where query is not null and query <> '<insufficient privilege>')::int as seen, count(*)::int as n from pg_stat_activity where usename is distinct from current_user and datname is distinct from current_database()");
		check(`${who} sees no other company's statements`, others.rows[0].seen === 0, `${others.rows[0].seen} of ${others.rows[0].n} visible`);
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
			check(`${who} cannot ${label}`, !tried.ok, `${tried.code}`);
		}
		if (login === "cdl_a_app") {
			const names = await app.query("select count(*)::int as n from pg_database where datname like 'cdl_%'");
			note(`it can list database names (${names.rows[0].n} seen): names must not say whose they are`);
		}
		await app.end();
	}
}

// ---- 3. walls between two database folders of one company: shop's roles never reach payroll
{
	const payrollState = () =>
		withAdmin("cdl_a", (db) => db.query("select count(*)::text || '/' || sum(hashtextextended(s::text, 0))::text as f from payroll.salaries s"))
			.then((result) => result.rows[0].f);
	const before = await payrollState();
	const tries = [
		["take payroll's owner role", "set role cdl_a_payroll_owner"],
		["take payroll's write role", "set role cdl_a_payroll_write"],
		["take payroll's read role", "set role cdl_a_payroll_read"],
		["become payroll's owner by session authorization", "set session authorization cdl_a_payroll_owner"],
		["read payroll after a reset role", "reset role; select count(*) from payroll.salaries"],
		["read payroll", "select count(*) from payroll.salaries"],
		["add a payroll row", "insert into payroll.salaries (person, amount) values ('x', 1)"],
		["change payroll rows", "update payroll.salaries set amount = 0"],
		["delete payroll rows", "delete from payroll.salaries"],
		["take payroll's role inside a statement", "select set_config('role', 'cdl_a_payroll_owner', true)"],
		["take payroll's role before a shop function that reads payroll",
			"select set_config('role', 'cdl_a_payroll_owner', true), shop.raw('select count(*) from payroll.salaries')"],
		["take payroll's role before a shop function that empties payroll",
			"select set_config('role', 'cdl_a_payroll_owner', true), shop.raw('with gone as (delete from payroll.salaries returning 1) select count(*) from gone')"],
		["reach payroll through a shop function", "select shop.raw('select count(*) from payroll.salaries')"],
	];
	await quiet("cdl_a");
	for (const kind of ["read", "write", "owner"]) {
		const session = await client("cdl_a", role("cdl_a", "shop", kind));
		for (const [label, sql] of tries) {
			await session.query("begin");
			const tried = await outcome(() => session.query(sql));
			await session.query("rollback");
			check(`shop's ${kind} login cannot ${label}`, !tried.ok, `${tried.code} ${tried.message}`);
		}
		await session.end();
	}
	await quiet("cdl_a");
	const owner = await client("cdl_a", "cdl_a_shop_owner");
	await owner.query("begin; set local search_path = shop");
	const step = await outcome(() => owner.query("select qorpera_data.apply_step($1)", ["set role cdl_a_payroll_owner; delete from payroll.salaries"]));
	await owner.query("rollback");
	check("a step of shop cannot switch to payroll's owner", !step.ok, `${step.code} ${step.message}`);
	await owner.end();
	check("payroll's rows are as they were", (await payrollState()) === before, before);

	const read = await client("cdl_a", "cdl_a_shop_read");
	for (const [label, sql] of [
		["add a row", "insert into shop.orders (amount) values (1)"],
		["change a row", "update shop.orders set amount = 0 where id = 1"],
		["delete a row", "delete from shop.orders where id = 1"],
		["take shop's write role", "set role cdl_a_shop_write"],
		["take shop's owner role", "set role cdl_a_shop_owner"],
		["take shop's owner role inside a statement", "select set_config('role', 'cdl_a_shop_owner', true)"],
	]) {
		const tried = await outcome(() => read.query(sql));
		check(`shop's read login cannot ${label}`, !tried.ok, `${tried.code}`);
	}
	await read.end();
	const write = await client("cdl_a", "cdl_a_shop_write");
	for (const [label, sql] of [
		["make a table", "create table shop.mine (id int)"],
		["add a column", "alter table shop.orders add column mine int"],
		["drop a table", "drop table shop.customers"],
		["empty a table", "truncate shop.orders"],
		["take shop's owner role", "set role cdl_a_shop_owner"],
	]) {
		const tried = await outcome(() => write.query(sql));
		check(`shop's write login cannot ${label}`, !tried.ok, `${tried.code}`);
	}
	const writes = await outcome(() => write.query("insert into shop.orders (amount) values (1)"));
	check("shop's write login writes shop's rows", writes.ok, writes.message);
	await write.end();
}

// ---- 4. connections per company and per folder role
{
	await quiet("cdl_a");
	const open = async (database, login, upTo) => {
		const held = [];
		let refused = null;
		for (let index = 0; index < upTo && !refused; index++) {
			const tried = await outcome(async () => held.push(await client(database, login)));
			if (!tried.ok) refused = tried;
		}
		return { held, refused };
	};
	const all = [];
	for (const folder of Object.keys(FOLDERS)) {
		for (const [kind, limit] of Object.entries(FOLDERS[folder])) {
			const { held, refused } = await open("cdl_a", role("cdl_a", folder, kind), limit + 2);
			all.push(...held);
			if (folder === "shop") {
				check(`a folder's ${kind} role takes ${limit} connection${limit > 1 ? "s" : ""} and refuses one more`,
					held.length === limit && refused?.code === "53300", `${held.length} opened, then ${refused?.code} ${refused?.message}`);
			}
		}
	}
	const thirteenth = await outcome(async () => (await client("cdl_a", "cdl_a_app")).end());
	check("a company database takes 12 connections and refuses the 13th", all.length === 12 && thirteenth.code === "53300"
		&& /database/.test(thirteenth.message), `${all.length} opened, then ${thirteenth.code} ${thirteenth.message}`);
	const other = await outcome(async () => (await client("cdl_b", "cdl_b_shop_read")).end());
	check("another company still connects while that one is full", other.ok);
	await Promise.all(all.map((entry) => entry.end()));
	await quiet("cdl_a");
	const { held: apps, refused: appRefused } = await open("cdl_a", "cdl_a_app", 5);
	check("a company's own login takes 3 connections and refuses the 4th", apps.length === 3 && appRefused?.code === "53300",
		`${apps.length} opened, then ${appRefused?.code}`);
	await Promise.all(apps.map((entry) => entry.end()));
}

// ---- 5. time per statement, through the gateway and on a company's own login
{
	// The gateway asks a question on a connection logged in as the folder's read role. No set role anywhere.
	const gateway = await client("cdl_a", "cdl_a_shop_read");
	const run = async (text) => {
		await gateway.query("begin transaction read only; set local statement_timeout = '300ms'; set local search_path = shop");
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
	const up = await run("select set_config('role', 'cdl_a_shop_owner', true)");
	check("a read cannot take the owner's role", !up.ok, `${up.code}`);
	const through = await run("select shop.raw('select count(*) from orders')");
	check("a company's own function runs inside a read", through.ok, through.message);
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

// ---- 6. size: what watching it costs, and closing writes when a company is over
{
	const watcher = await client("postgres", "cdl_watch");
	const started = now();
	const sizes = await watcher.query("select datname, pg_database_size(oid) as bytes from pg_database where datname like 'cdl_%'");
	note(`size of ${sizes.rowCount} databases read in ${Math.round(now() - started)} ms: ${sizes.rows.map((row) => `${row.datname} ${Math.round(row.bytes / 1048576)} MiB`).join(", ")}`);
	await watcher.end();
	const app = await client("cdl_a", "cdl_a_app");
	await app.query("insert into shop.orders (amount) values (1)");
	// Over its size: the write role is taken from the login, the read role given. No reconnect.
	await withAdmin("postgres", async (db) => {
		await db.query("revoke cdl_a_shop_write from cdl_a_app; grant cdl_a_shop_read to cdl_a_app; alter role cdl_a_app set role = 'cdl_a_shop_read'");
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
	const backToWrite = await outcome(() => fresh.query("set role cdl_a_shop_write"));
	check("over its size, a new session reads and cannot write", freshRead.ok && !freshWrite.ok && !backToWrite.ok,
		`${freshWrite.code}, taking the write role: ${backToWrite.code}`);
	await app.end().catch(() => undefined);
	await fresh.end();
}

// ---- 7. a step that destroys data is seen before it lands, and Qorpera's triggers cannot be switched off
{
	// What a step could have changed: shop's rows and Qorpera's triggers on shop's tables.
	const state = () =>
		withAdmin("cdl_b", async (db) => {
			const found = await db.query(`select
				(select count(*)::text || '/' || sum(hashtextextended(o::text, 0))::text from shop.orders o) as orders,
				(select count(*)::int from shop.cart_lines) as cart_lines,
				(select count(*)::int from shop.carts) as carts,
				(select count(*)::int from information_schema.columns where table_schema = 'shop' and table_name = 'customers') as customer_columns,
				(select string_agg(t.tgrelid::regclass || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || t.tgfoid::regproc, ', '
					order by t.tgrelid::regclass::text, t.tgname)
					from pg_trigger t join pg_class c on c.oid = t.tgrelid
					where c.relnamespace = 'shop'::regnamespace and not t.tgisinternal) as triggers,
				(select string_agg(relname || ' ' || relpersistence::text, ', ' order by relname) from pg_class
					where relnamespace = 'shop'::regnamespace and relkind = 'r') as tables`);
			return found.rows[0];
		});
	const first = await state();
	const kept = first.triggers.split(", ").filter((entry) => / qorpera_(changed|rows_gone|emptied) O qorpera_data\./.test(entry));
	check("every table a company made carries Qorpera's three triggers by itself", kept.length === 12, first.triggers);

	// The gateway applies a step on a connection logged in as the folder's owner role, in one transaction.
	await quiet("cdl_b");
	const owner = await client("cdl_b", "cdl_b_shop_owner");
	const apply = async (label, sql, allowed) => {
		await owner.query("begin; set local lock_timeout = '2s'; set local statement_timeout = '30s'; set local search_path = shop");
		const ran = await outcome(() => owner.query("select qorpera_data.apply_step($1)", [sql]));
		const effects = ran.ok ? (await owner.query("select * from qorpera_data.effects()")).rows : [];
		const destroys = effects.length > 0;
		await owner.query(ran.ok && (!destroys || allowed) ? "commit" : "rollback");
		note(`${label}: ${ran.ok ? (destroys ? effects.map((effect) => `${effect.kind} ${effect.object}${effect.rows ? ` (${effect.rows})` : ""}`).join("; ") : "destroys nothing") : `refused ${ran.code} ${ran.message}`}${!ran.ok ? "" : destroys && !allowed ? " -> held for a member" : " -> applied"}`);
		return { ran, effects, destroys };
	};
	const rowsGone = (effects, object) =>
		effects.filter((effect) => effect.kind === "deleted rows" && effect.object === object).reduce((total, effect) => total + Number(effect.rows), 0);

	// Steps that must not land: each fails, and shop is as it was.
	const guarded = /Qorpera/;
	for (const [label, sql, refusal] of [
		["switches all triggers off, deletes every row and switches them on again (the review's case)",
			"alter table shop.orders disable trigger user; delete from shop.orders; alter table shop.orders enable trigger user", guarded],
		["switches one of Qorpera's triggers off by name",
			"alter table shop.orders disable trigger qorpera_rows_gone; delete from shop.orders where id <= 100; alter table shop.orders enable trigger qorpera_rows_gone", guarded],
		["makes one of Qorpera's triggers fire only for replicas",
			"alter table shop.orders enable replica trigger qorpera_rows_gone; delete from shop.orders where id <= 100", guarded],
		["drops one of Qorpera's triggers", "drop trigger qorpera_rows_gone on shop.orders; delete from shop.orders where id <= 100", guarded],
		["renames one of Qorpera's triggers, then switches it off",
			"alter trigger qorpera_rows_gone on shop.orders rename to kept; alter table shop.orders disable trigger kept; delete from shop.orders where id <= 100", guarded],
		["replaces one of Qorpera's triggers with a function of its own",
			"create or replace trigger qorpera_rows_gone after delete on shop.orders for each statement execute function shop.mine(); delete from shop.orders where id <= 100", guarded],
		["points one of Qorpera's triggers at inserts only",
			"create or replace trigger qorpera_rows_gone after insert on shop.orders for each statement execute function qorpera_data.rows_gone(); delete from shop.orders where id <= 100", guarded],
		["gives one of Qorpera's triggers a condition that is never true",
			"create or replace trigger qorpera_rows_gone after delete on shop.orders referencing old table as gone for each statement when (false) execute function qorpera_data.rows_gone(); delete from shop.orders where id <= 100", guarded],
		["makes a trigger of its own named qorpera_x",
			"create trigger qorpera_x after insert on shop.orders for each statement execute function shop.mine()", guarded],
		["makes a table that is not kept logged", "create unlogged table shop.scratch (id int)", guarded],
		["sets a table unlogged", "alter table shop.orders set unlogged", guarded],
		["switches triggers off for its session", "set local session_replication_role = replica; delete from shop.orders where id <= 100", /permission denied/],
		["switches Qorpera's event triggers off", "alter event trigger qorpera_guard disable; alter table shop.orders disable trigger user; delete from shop.orders", /must be owner|permission denied/],
		["erases what Qorpera recorded", "delete from shop.orders where id <= 100; delete from qorpera_data.step_effects", /permission denied/],
		["says commit, then deletes in a new transaction",
			"insert into shop.orders (amount) values (1); commit; delete from shop.orders where id <= 100", /transaction|COMMIT/i],
	]) {
		const before = await state();
		const step = await apply(label, sql, false);
		const after = await state();
		const same = JSON.stringify(before) === JSON.stringify(after);
		check(`a step that ${label} does not land`, !step.ran.ok && refusal.test(step.ran.message) && same,
			`${step.ran.code} ${step.ran.message}${same ? "" : `; shop changed: ${JSON.stringify(after)}`}`);
	}

	// Steps that destroy: each is recorded, so held, with what it destroys.
	const before = await state();
	const del = await apply("delete rows", "delete from shop.orders where id <= 100", false);
	check("a step that deletes rows is held, with the count", rowsGone(del.effects, "shop.orders") === 100, `${rowsGone(del.effects, "shop.orders")}`);
	const truncate = await apply("empty a table", "truncate shop.orders", false);
	check("a step that empties a table is held", truncate.effects.some((effect) => effect.kind === "emptied table" && effect.object === "shop.orders"));
	const dropColumn = await apply("drop a column", "alter table shop.customers drop column phone", false);
	check("a step that drops a column is held", dropColumn.effects.some((effect) => effect.kind === "dropped table column" && effect.object === "shop.customers.phone"));
	const dropTable = await apply("drop a table", "drop table shop.customers", false);
	check("a step that drops a table is held", dropTable.effects.some((effect) => effect.kind === "dropped table" && effect.object === "shop.customers"));
	const hidden = await apply("delete inside a function", "select shop.raw('with gone as (delete from shop.orders where id <= 5 returning 1) select count(*) from gone')", false);
	check("a delete hidden inside a function is held too", rowsGone(hidden.effects, "shop.orders") === 5, `${rowsGone(hidden.effects, "shop.orders")}`);
	const cascade = await apply("delete parents whose children go by on delete cascade", "delete from shop.carts where id <= 10", false);
	const lines = cascade.effects.filter((effect) => effect.object === "shop.cart_lines");
	check("rows deleted through a foreign key's on delete cascade are held, with the child's count",
		rowsGone(cascade.effects, "shop.carts") === 10 && rowsGone(cascade.effects, "shop.cart_lines") === 30,
		`carts ${rowsGone(cascade.effects, "shop.carts")}, cart lines ${rowsGone(cascade.effects, "shop.cart_lines")} in ${lines.length} record${lines.length === 1 ? "" : "s"}`);
	const merge = await apply("delete rows by merge",
		"merge into shop.orders o using (select g as id from generate_series(1, 7) g) s on o.id = s.id when matched then delete", false);
	check("rows deleted by merge are held, with the count", rowsGone(merge.effects, "shop.orders") === 7, `${rowsGone(merge.effects, "shop.orders")}`);
	const held = await state();
	check("every held step left shop as it was", JSON.stringify(before) === JSON.stringify(held),
		`${held.orders} orders, ${held.carts} carts, ${held.cart_lines} cart lines, ${held.customer_columns} customer columns`);

	// Steps that destroy nothing land.
	const add = await apply("add a column", "alter table shop.orders add column shipped_at timestamptz", false);
	check("a step that adds a column is applied", add.ran.ok && !add.destroys, add.ran.message);
	const backfill = await apply("fill a column", "update shop.orders set note = 'kept'", false);
	check("a step that updates rows is applied", backfill.ran.ok && !backfill.destroys, backfill.ran.message);
	const made = await apply("make a table", "create table shop.returns (id bigserial primary key, order_id bigint not null, reason text)", false);
	const returns = await withAdmin("cdl_b", (db) =>
		db.query(`select count(*)::int as n from pg_trigger t join pg_trigger m on m.tgrelid = 'qorpera_data.model'::regclass
			and m.tgname = t.tgname and m.tgfoid = t.tgfoid and m.tgtype = t.tgtype where t.tgrelid = 'shop.returns'::regclass and t.tgenabled = 'O'`),
	);
	check("a step that makes a table is applied, and the table gets Qorpera's three triggers by itself",
		made.ran.ok && !made.destroys && returns.rows[0].n === 3, `${returns.rows[0].n} triggers`);

	const yes = await apply("delete rows, after a member's yes", "delete from shop.orders where id <= 100", true);
	const after = await withAdmin("cdl_b", (db) => db.query("select count(*)::int as n from shop.orders"));
	check("the same step lands after a member's yes", yes.destroys && after.rows[0].n === 19900, `${after.rows[0].n} orders`);
	await owner.end();
}
finish();
