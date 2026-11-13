-- The company data store's template database (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §2). Run once, as the
-- server's superuser, inside the database `qorpera_company_template`. Every company's database is a copy of it.
--
-- It holds the schema `qorpera_data`: what the gateway keeps beside a company's rows (its database folders, the steps
-- it applied, the texts it holds by hash), the trigger that says a table changed, and the triggers that record what a
-- step destroys. A company's own roles get nothing in this schema but what a trigger needs.

revoke all on schema public from public;
revoke all on database qorpera_company_template from public;

create schema qorpera_data;
grant usage on schema qorpera_data to public;

-- A database folder `data/<name>/` and the number its three roles carry.
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

-- A file's text, kept by the hash the folder gave for it.
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

-- The gateway's logins read these as themselves. A step can go back to the owner login (`reset role`), so that login
-- changes nothing here but through record_step, and the gateway checks every kept text against its hash again.
grant select on qorpera_data.databases, qorpera_data.steps, qorpera_data.texts
	to qorpera_data_owner, qorpera_data_read, qorpera_data_write;
grant insert on qorpera_data.texts to qorpera_data_owner, qorpera_data_read, qorpera_data_write;
grant select, insert, update, delete on qorpera_data.databases, qorpera_data.steps to qorpera_data_admin;

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

-- Records a dropped table, column or schema, and a dropped trigger of Qorpera's.
create function qorpera_data.dropped() returns event_trigger language plpgsql security definer set search_path = '' as $$
declare v_gone record;
begin
	for v_gone in select * from pg_event_trigger_dropped_objects() where not is_temporary
		and schema_name is distinct from 'qorpera_data' and schema_name is distinct from 'pg_toast'
	loop
		if v_gone.object_type = 'table' or (v_gone.original and v_gone.object_type in ('table column', 'schema')) then
			insert into qorpera_data.step_effects (kind, object) values ('dropped ' || v_gone.object_type, v_gone.object_identity);
		elsif v_gone.original and v_gone.object_type = 'trigger' and v_gone.object_identity like 'qorpera\_%' then
			insert into qorpera_data.step_effects (kind, object) values ('removed a trigger of Qorpera''s', v_gone.object_identity);
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

create event trigger qorpera_dropped on sql_drop execute function qorpera_data.dropped();
create event trigger qorpera_watch_new_tables on ddl_command_end
	when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function qorpera_data.watch_new_tables();

-- What the current transaction destroyed, for the gateway after it ran a step.
create function qorpera_data.effects() returns table (kind text, object text, rows bigint)
language sql stable security definer set search_path = '' as $$
	select e.kind, e.object, e.rows from qorpera_data.step_effects e where e.txid = txid_current() order by 1, 2
$$;

-- An ordinary table of a schema that lacks one of Qorpera's triggers, or has one switched off: a step may not leave any.
create function qorpera_data.unwatched(p_schema text) returns table (table_name text, problem text)
language sql stable security definer set search_path = '' as $$
	select c.relname::text, case when t.oid is null then 'is missing ' || wanted.name else 'has ' || wanted.name || ' switched off' end
	from pg_catalog.pg_class c
	join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = p_schema
	cross join (values ('qorpera_changed'), ('qorpera_emptied'), ('qorpera_rows_gone')) wanted(name)
	left join pg_catalog.pg_trigger t on t.tgrelid = c.oid and t.tgname = wanted.name and not t.tgisinternal
	where c.relkind = 'r' and not c.relispartition and (t.oid is null or t.tgenabled <> 'O')
	order by 1, 2
$$;

-- Runs a step's text. Inside a function a step cannot end or begin a transaction, so what it does stays in the
-- gateway's one transaction until the gateway has read what it destroyed.
create function qorpera_data.run_step(p_text text) returns void language plpgsql as $$
begin
	execute p_text;
end $$;

-- Records a step as applied, in the transaction that ran it.
create function qorpera_data.record_step(p_database text, p_name text, p_sha256 text) returns void
language sql security definer set search_path = '' as $$
	insert into qorpera_data.steps (database, name, sha256) values (p_database, p_name, p_sha256)
$$;

revoke all on function qorpera_data.effects(), qorpera_data.unwatched(text), qorpera_data.record_step(text, text, text) from public;
grant execute on function qorpera_data.effects(), qorpera_data.unwatched(text), qorpera_data.record_step(text, text, text)
	to qorpera_data_owner;

-- A login with CREATEDB may copy a database marked as a template; nobody connects to it afterwards.
alter database qorpera_company_template is_template true;
