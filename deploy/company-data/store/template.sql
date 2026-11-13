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

-- Records deleted rows (with their count) and an emptied table.
create function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_rows bigint;
begin
	if tg_op = 'TRUNCATE' then
		insert into qorpera_data.step_effects (kind, object) values ('emptied table', tg_table_schema || '.' || tg_table_name);
	else
		select count(*) into v_rows from gone;
		if v_rows > 0 then
			insert into qorpera_data.step_effects (kind, object, rows)
			values ('deleted rows', tg_table_schema || '.' || tg_table_name, v_rows);
		end if;
	end if;
	return null;
end $$;

-- What is wrong with Qorpera's triggers on a table, one line each. A trigger named qorpera_* or calling one of
-- Qorpera's trigger functions must be one of the three, exactly as watch_new_tables makes it, and switched on (for
-- origin or always). That a trigger is missing is unwatched()'s to say: the three are made one after another.
create function qorpera_data.trigger_problems(p_table oid) returns setof text
language sql stable security definer set search_path = '' as $$
	select problem from (
		select t.tgname::text || case
			when w.name is null then ' is not one of Qorpera''s triggers'
			when t.tgenabled not in ('O', 'A') then ' is switched off'
			when t.tgfoid <> w.fn or t.tgtype <> w.events or t.tgoldtable is distinct from w.old_table or t.tgnewtable is not null
				or t.tgqual is not null or t.tgnargs <> 0 or cardinality(t.tgattr::int2[]) <> 0 then ' was replaced'
		end as problem
		from pg_catalog.pg_trigger t
		left join (values
			('qorpera_changed'::name, 'qorpera_data.changed()'::pg_catalog.regprocedure::oid, 60::int2, null::name),
			('qorpera_emptied', 'qorpera_data.rows_gone()'::pg_catalog.regprocedure::oid, 34, null),
			('qorpera_rows_gone', 'qorpera_data.rows_gone()'::pg_catalog.regprocedure::oid, 8, 'gone')
		) w(name, fn, events, old_table) on w.name = t.tgname
		where t.tgrelid = p_table and not t.tgisinternal
			and (t.tgname like 'qorpera\_%' or t.tgfoid in ('qorpera_data.changed()'::pg_catalog.regprocedure, 'qorpera_data.rows_gone()'::pg_catalog.regprocedure))
	) found
	where problem is not null
	order by 1
$$;

-- Records a dropped table, column or schema. Refuses at once to drop one of Qorpera's triggers.
create function qorpera_data.dropped() returns event_trigger language plpgsql security definer set search_path = '' as $$
declare v_gone record;
begin
	for v_gone in select * from pg_event_trigger_dropped_objects() where not is_temporary
		and schema_name is distinct from 'qorpera_data' and schema_name is distinct from 'pg_toast'
	loop
		if v_gone.original and v_gone.object_type = 'trigger' and v_gone.object_identity like 'qorpera\_%' then
			raise exception 'A step may not remove Qorpera''s triggers: %', v_gone.object_identity;
		elsif v_gone.object_type = 'table' or (v_gone.original and v_gone.object_type in ('table column', 'schema')) then
			insert into qorpera_data.step_effects (kind, object) values ('dropped ' || v_gone.object_type, v_gone.object_identity);
		end if;
	end loop;
end $$;

-- Puts the triggers on every new table of a company, whoever makes it.
create function qorpera_data.watch_new_tables() returns event_trigger language plpgsql security definer set search_path = '' as $$
declare v_made record;
begin
	for v_made in select * from pg_event_trigger_ddl_commands() where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
		and object_type = 'table' and schema_name not in ('qorpera_data', 'pg_catalog', 'information_schema')
		and schema_name not like 'pg\_temp%'
	loop
		execute format('create trigger qorpera_changed after insert or update or delete or truncate on %s
			for each statement execute function qorpera_data.changed()', v_made.object_identity);
		execute format('create trigger qorpera_emptied before truncate on %s
			for each statement execute function qorpera_data.rows_gone()', v_made.object_identity);
		begin
			execute format('create trigger qorpera_rows_gone after delete on %s referencing old table as gone
				for each statement execute function qorpera_data.rows_gone()', v_made.object_identity);
		exception when feature_not_supported or wrong_object_type then
			-- A partitioned table takes no trigger with a transition table: its deletes are counted on its parts.
			null;
		end;
	end loop;
end $$;

-- Refuses, the moment it happens, a command that switches off, replaces or renames one of Qorpera's triggers, makes a
-- trigger of its own named like them, or makes a table that is not kept logged: an unlogged table's rows are in no
-- backup. Temporary tables are left alone.
create function qorpera_data.guard() returns event_trigger language plpgsql security definer set search_path = '' as $$
declare v_table oid; v_problem text;
begin
	for v_table in
		select distinct case when c.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
			then (select t.tgrelid from pg_catalog.pg_trigger t where t.oid = c.objid) else c.objid end
		from pg_event_trigger_ddl_commands() c
		where c.classid in ('pg_catalog.pg_class'::pg_catalog.regclass, 'pg_catalog.pg_trigger'::pg_catalog.regclass)
			and c.schema_name is distinct from 'qorpera_data'
	loop
		continue when v_table is null;
		if exists (select 1 from pg_catalog.pg_class r where r.oid = v_table and r.relkind in ('r', 'p') and r.relpersistence = 'u') then
			raise exception 'A table of a company''s database is kept logged: an unlogged table''s rows are in no backup';
		end if;
		select p into v_problem from qorpera_data.trigger_problems(v_table) p limit 1;
		if v_problem is not null then
			raise exception 'A step may not switch off or replace Qorpera''s triggers: %', v_problem;
		end if;
	end loop;
end $$;

create event trigger qorpera_dropped on sql_drop execute function qorpera_data.dropped();
create event trigger qorpera_watch_new_tables on ddl_command_end
	when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function qorpera_data.watch_new_tables();
create event trigger qorpera_guard on ddl_command_end
	when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE', 'CREATE TRIGGER', 'ALTER TRIGGER')
	execute function qorpera_data.guard();

-- What the current transaction destroyed, for the gateway after it ran a step.
create function qorpera_data.effects() returns table (kind text, object text, rows bigint)
language sql stable security definer set search_path = '' as $$
	select e.kind, e.object, e.rows from qorpera_data.step_effects e where e.txid = txid_current() order by 1, 2
$$;

-- An ordinary table of a schema that lacks one of Qorpera's triggers, or whose triggers are not as Qorpera made them:
-- a step may not leave any.
create function qorpera_data.unwatched(p_schema text) returns table (table_name text, problem text)
language sql stable security definer set search_path = '' as $$
	select c.relname::text, 'is missing ' || wanted.name
	from pg_catalog.pg_class c
	join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = p_schema
	cross join (values ('qorpera_changed'), ('qorpera_emptied'), ('qorpera_rows_gone')) wanted(name)
	left join pg_catalog.pg_trigger t on t.tgrelid = c.oid and t.tgname = wanted.name and not t.tgisinternal
	where c.relkind = 'r' and not c.relispartition and t.oid is null
	union all
	select c.relname::text, problem
	from pg_catalog.pg_class c
	join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = p_schema
	cross join lateral qorpera_data.trigger_problems(c.oid) problem
	where c.relkind in ('r', 'p')
	order by 1, 2
$$;

-- Runs a step's text. Inside a function a step cannot end or begin a transaction, so what it does stays in the
-- gateway's one transaction until the gateway has read what it destroyed.
create function qorpera_data.run_step(p_text text) returns void language plpgsql as $$
begin
	execute p_text;
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

-- None of these shows or does anything a folder's own login may not.
grant execute on function qorpera_data.effects(), qorpera_data.unwatched(text), qorpera_data.run_step(text),
	qorpera_data.record_step(text, text, text) to public;

-- A login with CREATEDB may copy a database marked as a template; nobody connects to it afterwards.
alter database qorpera_company_template is_template true;
