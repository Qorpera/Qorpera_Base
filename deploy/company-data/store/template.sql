-- The company data store's template database (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §2). Run once, as the
-- server's superuser, inside the database `qorpera_company_template`. Every company's database is a copy of it.
--
-- It holds the schema `qorpera_data`: what the gateway keeps beside a company's rows (its database folders, the steps
-- it applied, the texts it holds by hash), the trigger that says a table changed, the triggers that record what a step
-- destroys, and the event triggers that guard them. A database folder's own logins get nothing in this schema but what
-- a trigger needs and the few functions a step calls.

revoke all on schema public from public;
revoke all on database qorpera_company_template from public;

create schema qorpera_data;
grant usage on schema qorpera_data to public;

create schema qorpera_ext;
revoke all on schema qorpera_ext from public;
grant usage on schema qorpera_ext to public;

create extension pgcrypto schema qorpera_ext;
create extension pg_trgm schema qorpera_ext;
create extension citext schema qorpera_ext;
create extension btree_gin schema qorpera_ext;
create extension btree_gist schema qorpera_ext;
create extension unaccent schema qorpera_ext;
create extension fuzzystrmatch schema qorpera_ext;
create extension ltree schema qorpera_ext;
create extension "uuid-ossp" schema qorpera_ext;
create extension tablefunc schema qorpera_ext;

do $$
begin
	if exists (select 1 from pg_catalog.pg_available_extensions where name = 'vector') then
		create extension if not exists vector schema qorpera_ext;
	end if;
end $$;

-- A database folder `data/<name>/` and the number its three logins carry.
create table qorpera_data.databases (
	name text primary key check (name ~ '^[a-z][a-z0-9_]{0,39}$'),
	n integer generated always as identity unique,
	made_at timestamptz not null default now()
);

-- A step that was applied, with the hash of the text that ran.
create table qorpera_data.steps (
	database text not null references qorpera_data.databases(name) on delete cascade,
	name text not null check (name ~ '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$'),
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	applied_at timestamptz not null default now(),
	primary key (database, name)
);

-- A file's text, kept by the hash the folder gave for it. No folder's login reads it: it holds every folder's texts.
create table qorpera_data.texts (
	sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
	text text not null check (octet_length(text) <= 262144),
	kept_at timestamptz not null default now()
);

-- What the current transaction destroyed. The gateway reads it before it commits a step.
create table qorpera_data.step_effects (
	txid bigint not null default txid_current(),
	kind text not null,
	object text not null,
	rows bigint
);
create index on qorpera_data.step_effects (txid);

-- Transactions whose effects the gateway has read: from then on nothing in them may destroy data, also at commit. No
-- company role writes it, and nothing takes a transaction out of it.
create table qorpera_data.sealed (
	txid bigint primary key default txid_current(),
	sealed_at timestamptz not null default now()
);

-- The gateway's keeper reads its records as itself and keeps texts; the admin makes folders. The gateway checks
-- every kept text against its hash again.
grant select on qorpera_data.databases, qorpera_data.steps to qorpera_data_keeper;
grant select, insert, update, delete on qorpera_data.databases, qorpera_data.steps to qorpera_data_admin;
grant select, insert on qorpera_data.texts to qorpera_data_keeper;

-- Says which table changed, once per statement. PostgreSQL sends identical notices of one transaction once.
create function qorpera_data.changed() returns trigger language plpgsql security definer set search_path = '' as $$
begin
	perform pg_notify('qorpera_data', tg_table_schema || '.' || tg_table_name);
	return null;
end $$;

-- Records an emptied table, and the rows a step deleted (with their count). Deleted rows are recorded only in a step's
-- session, which is logged in as its database folder's owner (session_user stays the login inside a function, also one
-- made as another's): a step that deletes rows is held and rolled back, so its record goes with it. A change deletes
-- rows as its own defined act and is committed (§8), as the write login: a record of its deletes would be kept for
-- good, one for every change, and nothing reads it. (store/update.sql carries this to a store made before it.)
create function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_rows bigint;
begin
	if tg_op = 'TRUNCATE' then
		if exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
			raise exception 'A step may not destroy data after it was checked: % was emptied', tg_table_schema || '.' || tg_table_name;
		end if;
		insert into qorpera_data.step_effects (kind, object) values ('emptied table', tg_table_schema || '.' || tg_table_name);
	elsif session_user::text ~ '^c_[0-9a-f]{32}_o[0-9]+$' then
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
end $$;

create table qorpera_data.row_changes (
	txid bigint not null default txid_current(),
	seq bigint generated always as identity primary key,
	schema text not null,
	relation text not null,
	op text not null check (op in ('add', 'change', 'remove')),
	key jsonb,
	before jsonb,
	after jsonb,
	rows bigint not null check (rows > 0),
	bytes bigint not null check (bytes >= 0)
);
create index row_changes_txid_seq_idx on qorpera_data.row_changes (txid, seq);
create index row_changes_schema_seq_idx on qorpera_data.row_changes (schema, seq);

create table qorpera_data.change_log (
	txid bigint primary key,
	at timestamptz not null default now(),
	by_kind text not null check (by_kind in ('member', 'agent', 'machine', 'step', 'public', 'hook')),
	by_id text,
	via text
);
create index change_log_at_idx on qorpera_data.change_log (at);

create table qorpera_data.record_limit (
	only_row boolean primary key default true check (only_row),
	bytes bigint not null check (bytes > 0)
);
insert into qorpera_data.record_limit (bytes) values (104857600);

create table qorpera_data.record_bytes (
	pid integer primary key,
	bytes bigint not null
);

revoke all on qorpera_data.row_changes, qorpera_data.change_log, qorpera_data.record_limit, qorpera_data.record_bytes from public;
grant select on qorpera_data.row_changes to qorpera_data_keeper;
grant select, insert, delete on qorpera_data.change_log to qorpera_data_keeper;
grant select, insert, update, delete on qorpera_data.row_changes, qorpera_data.record_bytes to qorpera_data_recorder;
grant select on qorpera_data.record_limit to qorpera_data_recorder;
grant select on qorpera_data.change_log to qorpera_data_recorder;

create function qorpera_data.keep_record(p_bytes bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
	v_own bigint; v_cap bigint; v_step bigint; v_total bigint; v_holders int; v_newest bigint; v_line record;
	v_doomed bigint[] := '{}'; v_freed bigint := 0; v_moved bigint;
begin
	insert into qorpera_data.record_bytes as b (pid, bytes) values (pg_catalog.pg_backend_pid(), p_bytes)
		on conflict (pid) do update set bytes = b.bytes + excluded.bytes
		returning b.bytes, (select l.bytes from qorpera_data.record_limit l) into v_own, v_cap;
	v_step := v_cap / 1024 + 1;
	if p_bytes < v_step and (v_own - p_bytes) / v_step = v_own / v_step then
		return;
	end if;
	select coalesce(sum(b.bytes), 0), count(*) into v_total, v_holders from qorpera_data.record_bytes b;
	if v_total > v_cap and pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('qorpera_data.record_trim')) then
		select max(c.seq) into v_newest from qorpera_data.row_changes c;
		for v_line in
			select c.seq, c.bytes from qorpera_data.row_changes c where c.seq < v_newest order by c.seq for update skip locked
		loop
			exit when v_total - v_freed <= v_cap;
			v_doomed := v_doomed || v_line.seq;
			v_freed := v_freed + v_line.bytes;
		end loop;
		delete from qorpera_data.row_changes c where c.seq = any (v_doomed);
	end if;
	if v_freed > 0 or v_holders > 64 then
		with ended as (
			delete from qorpera_data.record_bytes b where b.pid in (
				select h.pid from qorpera_data.record_bytes h
				where h.pid <> pg_catalog.pg_backend_pid() and not exists (select 1 from pg_catalog.pg_stat_activity a where a.pid = h.pid)
				for update skip locked)
			returning b.bytes)
		select coalesce(sum(e.bytes), 0) into v_moved from ended e;
		update qorpera_data.record_bytes b set bytes = b.bytes - v_freed + v_moved where b.pid = pg_catalog.pg_backend_pid();
	end if;
end $$;
revoke all on function qorpera_data.keep_record(bigint) from public;
alter function qorpera_data.keep_record(bigint) owner to qorpera_data_recorder;

create function qorpera_data.forget_record(p_before timestamptz) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_through bigint; v_lines bigint; v_freed bigint;
begin
	select max(r.seq) into v_through
	from qorpera_data.change_log c join qorpera_data.row_changes r on r.txid = c.txid
	where c.at < p_before;
	if v_through is null then
		return 0;
	end if;
	with gone as (
		delete from qorpera_data.row_changes r
		where r.seq in (select x.seq from qorpera_data.row_changes x where x.seq <= v_through order by x.seq limit 50000 for update skip locked)
		returning r.bytes)
	select count(*), coalesce(sum(gone.bytes), 0) into v_lines, v_freed from gone;
	if v_freed > 0 then
		insert into qorpera_data.record_bytes as b (pid, bytes) values (pg_catalog.pg_backend_pid(), -v_freed)
			on conflict (pid) do update set bytes = b.bytes + excluded.bytes;
	end if;
	return v_lines;
end $$;
revoke all on function qorpera_data.forget_record(timestamptz) from public;
alter function qorpera_data.forget_record(timestamptz) owner to qorpera_data_recorder;
grant execute on function qorpera_data.forget_record(timestamptz) to qorpera_data_keeper;

create function qorpera_data.recorded() returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_key text[]; v_others text[]; v_rows bigint; v_bytes bigint; v_old jsonb[]; v_new jsonb[];
	v_names bigint := octet_length(tg_table_schema) + octet_length(tg_table_name);
begin
	if tg_op = 'INSERT' then
		select count(*) into v_rows from added;
	elsif tg_op = 'UPDATE' then
		select count(*) into v_rows from after_rows;
	else
		select count(*) into v_rows from removed;
	end if;
	if v_rows = 0 then
		return null;
	end if;
	if v_rows > 1000 then
		insert into qorpera_data.row_changes (schema, relation, op, rows, bytes)
		values (tg_table_schema, tg_table_name, case tg_op when 'INSERT' then 'add' when 'UPDATE' then 'change' else 'remove' end, v_rows, v_names);
		perform qorpera_data.keep_record(v_names);
		return null;
	end if;
	select array_agg(a.attname::text order by k.n) filter (where k.n is not null),
		coalesce(array_agg(a.attname::text) filter (where k.n is null), '{}')
	into v_key, v_others
	from pg_catalog.pg_attribute a
	left join pg_catalog.pg_index i on i.indrelid = a.attrelid and i.indisprimary
	left join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n) on k.attnum = a.attnum
	where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped;
	if tg_op = 'INSERT' then
		with lines as (
			insert into qorpera_data.row_changes (schema, relation, op, key, after, rows, bytes)
			select tg_table_schema, tg_table_name, 'add', l.key, l.doc, 1, v_names + coalesce(octet_length(l.key::text), 0) + octet_length(l.doc::text)
			from (select r.doc, case when v_key is null then null else r.doc - v_others end as key
				from (select pg_catalog.to_jsonb(t.*) as doc from added t) r) l
			returning bytes)
		select coalesce(sum(lines.bytes), 0) into v_bytes from lines;
	elsif tg_op = 'UPDATE' then
		select array_agg(pg_catalog.to_jsonb(t.*)) into v_old from before_rows t;
		select array_agg(pg_catalog.to_jsonb(t.*)) into v_new from after_rows t;
		with lines as (
			insert into qorpera_data.row_changes (schema, relation, op, key, before, after, rows, bytes)
			select tg_table_schema, tg_table_name, 'change', l.key, l.before, l.after, 1,
				v_names + coalesce(octet_length(l.key::text), 0) + octet_length(l.before::text) + octet_length(l.after::text)
			from (
				select case when v_key is null then null else z.new - v_others end as key,
					case when v_key is null then z.old else x.before end as before,
					case when v_key is null then z.new else x.after end as after
				from unnest(v_old, v_new) z(old, new)
				cross join lateral (
					select pg_catalog.jsonb_object_agg(e.key, e.value) as before, pg_catalog.jsonb_object_agg(e.key, z.new -> e.key) as after
					from pg_catalog.jsonb_each(z.old) e
					where e.value is distinct from z.new -> e.key) x
				where z.old is distinct from z.new) l
			returning bytes)
		select coalesce(sum(lines.bytes), 0) into v_bytes from lines;
	else
		with lines as (
			insert into qorpera_data.row_changes (schema, relation, op, key, before, rows, bytes)
			select tg_table_schema, tg_table_name, 'remove', l.key, l.doc, 1, v_names + coalesce(octet_length(l.key::text), 0) + octet_length(l.doc::text)
			from (select r.doc, case when v_key is null then null else r.doc - v_others end as key
				from (select pg_catalog.to_jsonb(t.*) as doc from removed t) r) l
			returning bytes)
		select coalesce(sum(lines.bytes), 0) into v_bytes from lines;
	end if;
	if v_bytes > 0 then
		perform qorpera_data.keep_record(v_bytes);
	end if;
	return null;
end $$;
revoke all on function qorpera_data.recorded() from public;
alter function qorpera_data.recorded() owner to qorpera_data_recorder;

create function qorpera_data.no_json_cast() returns event_trigger language plpgsql security definer set search_path = '' as $$
begin
	if exists (
		select 1 from pg_catalog.pg_cast c
		where c.casttarget in ('pg_catalog.json'::pg_catalog.regtype, 'pg_catalog.jsonb'::pg_catalog.regtype) and c.oid >= 16384
	) then
		raise exception 'Qorpera refuses a cast to json or jsonb: the record of row changes turns rows into JSON';
	end if;
end $$;
create event trigger qorpera_no_json_cast on ddl_command_end when tag in ('CREATE CAST')
	execute function qorpera_data.no_json_cast();

create table qorpera_data.model ();
create trigger qorpera_changed after insert or update or delete or truncate on qorpera_data.model
	for each statement execute function qorpera_data.changed();
create trigger qorpera_rows_gone after delete on qorpera_data.model referencing old table as gone
	for each statement execute function qorpera_data.rows_gone();
create trigger qorpera_emptied before truncate on qorpera_data.model
	for each statement execute function qorpera_data.rows_gone();
create trigger qorpera_record_add after insert on qorpera_data.model referencing new table as added
	for each statement execute function qorpera_data.recorded();
create trigger qorpera_record_change after update on qorpera_data.model referencing old table as before_rows new table as after_rows
	for each statement execute function qorpera_data.recorded();
create trigger qorpera_record_remove after delete on qorpera_data.model referencing old table as removed
	for each statement execute function qorpera_data.recorded();

-- A dropped table, column or schema is recorded. A table or a column is recorded whether the statement named it or it
-- went with something else (a column whose type or domain was dropped with cascade, a table of a dropped schema, a
-- partition). A schema only when it was named: its tables are each recorded. What holds no rows of the company's own is
-- left: a view, a materialized view (its rows are computed from tables), a sequence (a counter), an index, a type.
-- Dropping one of Qorpera's triggers is refused.
create function qorpera_data.dropped() returns event_trigger language plpgsql security definer set search_path = '' as $$
declare gone record;
begin
	for gone in select * from pg_event_trigger_dropped_objects() where not is_temporary loop
		if gone.object_type = 'trigger' and gone.original and gone.object_identity like 'qorpera\_% on %' then
			raise exception 'Qorpera''s trigger % cannot be dropped', gone.object_identity;
		end if;
		if gone.object_type in ('table', 'table column', 'schema') and gone.schema_name is distinct from 'qorpera_data'
			and (gone.original or gone.object_type in ('table', 'table column')) then
			if exists (select 1 from qorpera_data.sealed s where s.txid = txid_current()) then
				raise exception 'A step may not destroy data after it was checked: % was dropped', gone.object_identity;
			end if;
			insert into qorpera_data.step_effects (kind, object) values ('dropped ' || gone.object_type, gone.object_identity);
		end if;
	end loop;
end $$;
create event trigger qorpera_dropped on sql_drop execute function qorpera_data.dropped();

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
			where t.tgrelid = touched.tab and not t.tgisinternal and t.tgname like 'qorpera\_%'
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
			if kept < (select count(*) from pg_catalog.pg_trigger m where m.tgrelid = 'qorpera_data.model'::regclass) then
				raise exception 'Qorpera''s triggers on % are missing', touched.tab;
			end if;
		end if;
	end loop;
end $$;
create event trigger qorpera_guard on ddl_command_end when tag in ('ALTER TABLE', 'CREATE TRIGGER', 'ALTER TRIGGER')
	execute function qorpera_data.guard();

create function qorpera_data.give_triggers(p_table regclass) returns void
language plpgsql security definer set search_path = '' as $$
declare v_model record;
begin
	for v_model in
		select m.oid from pg_catalog.pg_trigger m
		where m.tgrelid = 'qorpera_data.model'::regclass and not m.tgisinternal
			and not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = p_table and t.tgname = m.tgname)
		order by m.tgname
	loop
		execute replace(pg_catalog.pg_get_triggerdef(v_model.oid), ' ON qorpera_data.model ', ' ON ' || p_table::text || ' ');
	end loop;
end $$;
revoke all on function qorpera_data.give_triggers(regclass) from public;

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
		perform qorpera_data.give_triggers(made.tab);
	end loop;
end $$;
create event trigger qorpera_new_table on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
	execute function qorpera_data.new_table();

-- Seals the current transaction, one way, and gives what it destroyed so far: what destroys data after this aborts
-- the transaction, also at its commit.
create function qorpera_data.seal() returns table (kind text, object text, rows bigint)
language plpgsql security definer set search_path = '' as $$
begin
	insert into qorpera_data.sealed (txid) values (txid_current()) on conflict (txid) do nothing;
	return query select e.kind, e.object, e.rows from qorpera_data.step_effects e where e.txid = txid_current() order by 1, 2;
end $$;

-- What the current transaction destroyed, for the gateway after it ran a step.
create function qorpera_data.effects() returns table (kind text, object text, rows bigint)
language sql stable security definer set search_path = '' as $$
	select e.kind, e.object, e.rows from qorpera_data.step_effects e where e.txid = txid_current() order by 1, 2
$$;

-- A table of a schema that lacks one of Qorpera's triggers, or whose trigger is not as the model's: a step may not
-- leave any. The guard refuses these the moment they happen; this is the check at the end of a step.
create function qorpera_data.unwatched(p_schema text) returns table (table_name text, problem text)
language sql stable security definer set search_path = '' as $$
	select c.relname::text, case when t.oid is null then 'is missing ' else 'has a changed ' end || m.tgname
	from pg_catalog.pg_class c
	join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = p_schema
	join pg_catalog.pg_trigger m on m.tgrelid = 'qorpera_data.model'::regclass
	left join pg_catalog.pg_trigger t on t.tgrelid = c.oid and t.tgname = m.tgname
	where c.relkind in ('r', 'p') and c.relpersistence <> 't'
		and (t.oid is null or t.tgenabled not in ('O', 'A')
			or (t.tgfoid, t.tgtype, t.tgoldtable, t.tgnewtable, t.tgqual is null, t.tgattr::text, t.tgargs, t.tgconstraint)
				is distinct from (m.tgfoid, m.tgtype, m.tgoldtable, m.tgnewtable, true, m.tgattr::text, m.tgargs, m.tgconstraint))
	order by 1, 2
$$;

-- A step runs inside a function, so it cannot end the transaction and go on outside it: what it does stays in the
-- gateway's one transaction until the gateway has read what it destroyed.
create function qorpera_data.apply_step(step text) returns void language plpgsql as $$
begin
	execute step;
end $$;

-- Records a step as applied, in the transaction that ran it. Only the database folder's own owner login records its
-- steps: a step of one folder cannot record a step of another.
create function qorpera_data.record_step(p_database text, p_name text, p_sha256 text) returns void
language plpgsql security definer set search_path = '' as $$
begin
	if session_user::text is distinct from (select current_database() || '_o' || d.n from qorpera_data.databases d where d.name = p_database) then
		raise exception 'Only the database folder''s own owner records its steps' using errcode = '42501';
	end if;
	insert into qorpera_data.steps (database, name, sha256) values (p_database, p_name, p_sha256);
end $$;

create function qorpera_data.viewer() returns uuid
language sql stable set search_path = '' as $$
	select nullif(pg_catalog.current_setting('qorpera.viewer', true), '')::uuid
$$;

-- None of these shows or does anything a folder's own login may not.
grant execute on function qorpera_data.effects(), qorpera_data.seal(), qorpera_data.unwatched(text), qorpera_data.apply_step(text),
	qorpera_data.record_step(text, text, text), qorpera_data.viewer() to public;

-- A login with CREATEDB may copy a database marked as a template; nobody connects to it afterwards.
alter database qorpera_company_template is_template true;
