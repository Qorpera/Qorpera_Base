-- Brings a store made from an earlier store/template.sql to today's. Run as the server's superuser inside the template
-- database and inside every company's database (kit/update-store.sh does both, on the primary; a standby follows it).
-- Safe to run again: each part replaces what it changes. Each part says what it carries and since when; the same text
-- stands in template.sql, and deploy/company-data/gateway/gateway.test.mjs holds the two to each other.

-- 14 November 2026 (named changes, slice 7): deleted rows are recorded only in a step's session. A change deletes rows
-- as the write login and is committed, so the record of its deletes was kept for good, one row for every change.
create or replace function qorpera_data.rows_gone() returns trigger language plpgsql security definer set search_path = '' as $$
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

-- What an earlier store kept of changes' deleted rows: records of transactions that are over, which nothing reads (a
-- step's record is read only inside the step's own transaction).
delete from qorpera_data.step_effects where txid < txid_snapshot_xmin(txid_current_snapshot());

do $$
begin
	if exists (
		select 1 from pg_catalog.pg_cast c
		where c.casttarget in ('pg_catalog.json'::pg_catalog.regtype, 'pg_catalog.jsonb'::pg_catalog.regtype) and c.oid >= 16384
	) then
		raise exception 'A cast to json or jsonb stands in %: drop it before the record of row changes is added', current_database();
	end if;
	if not exists (select 1 from pg_catalog.pg_roles where rolname = 'qorpera_data_recorder') then
		create role qorpera_data_recorder nologin;
	end if;
end $$;

create table if not exists qorpera_data.row_changes (
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
drop index if exists qorpera_data.row_changes_txid_idx;
create index if not exists row_changes_txid_seq_idx on qorpera_data.row_changes (txid, seq);
create index if not exists row_changes_schema_seq_idx on qorpera_data.row_changes (schema, seq);

create table if not exists qorpera_data.change_log (
	txid bigint primary key,
	at timestamptz not null default now(),
	by_kind text not null check (by_kind in ('member', 'agent', 'machine', 'step')),
	by_id text,
	via text
);
create index if not exists change_log_at_idx on qorpera_data.change_log (at);

create table if not exists qorpera_data.record_limit (
	only_row boolean primary key default true check (only_row),
	bytes bigint not null check (bytes > 0)
);
insert into qorpera_data.record_limit (bytes) select 104857600 where not exists (select 1 from qorpera_data.record_limit);

create table if not exists qorpera_data.record_bytes (
	pid integer primary key,
	bytes bigint not null
);

revoke all on qorpera_data.row_changes, qorpera_data.change_log, qorpera_data.record_limit, qorpera_data.record_bytes from public;
grant select on qorpera_data.row_changes to qorpera_data_keeper;
grant select, insert, delete on qorpera_data.change_log to qorpera_data_keeper;
grant select, insert, update, delete on qorpera_data.row_changes, qorpera_data.record_bytes to qorpera_data_recorder;
grant select on qorpera_data.record_limit to qorpera_data_recorder;
grant select on qorpera_data.change_log to qorpera_data_recorder;

create or replace function qorpera_data.keep_record(p_bytes bigint) returns void
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

create or replace function qorpera_data.forget_record(p_before timestamptz) returns bigint
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

create or replace function qorpera_data.recorded() returns trigger language plpgsql security definer set search_path = '' as $$
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

create or replace function qorpera_data.no_json_cast() returns event_trigger language plpgsql security definer set search_path = '' as $$
begin
	if exists (
		select 1 from pg_catalog.pg_cast c
		where c.casttarget in ('pg_catalog.json'::pg_catalog.regtype, 'pg_catalog.jsonb'::pg_catalog.regtype) and c.oid >= 16384
	) then
		raise exception 'Qorpera refuses a cast to json or jsonb: the record of row changes turns rows into JSON';
	end if;
end $$;
do $$
begin
	if not exists (select 1 from pg_catalog.pg_event_trigger where evtname = 'qorpera_no_json_cast') then
		create event trigger qorpera_no_json_cast on ddl_command_end when tag in ('CREATE CAST')
			execute function qorpera_data.no_json_cast();
	end if;
end $$;

create or replace trigger qorpera_record_add after insert on qorpera_data.model referencing new table as added
	for each statement execute function qorpera_data.recorded();
create or replace trigger qorpera_record_change after update on qorpera_data.model referencing old table as before_rows new table as after_rows
	for each statement execute function qorpera_data.recorded();
create or replace trigger qorpera_record_remove after delete on qorpera_data.model referencing old table as removed
	for each statement execute function qorpera_data.recorded();

create or replace function qorpera_data.guard() returns event_trigger language plpgsql security definer set search_path = '' as $$
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

create or replace function qorpera_data.give_triggers(p_table regclass) returns void
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

create or replace function qorpera_data.new_table() returns event_trigger language plpgsql security definer set search_path = '' as $$
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

select qorpera_data.give_triggers(c.oid::regclass)
from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace
where c.relkind in ('r', 'p') and c.relpersistence = 'p'
	and s.nspname not in ('qorpera_data', 'pg_catalog', 'information_schema', 'pg_toast') and s.nspname !~ '^pg_';
