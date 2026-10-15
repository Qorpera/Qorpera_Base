begin;

insert into auth.users (id, email)
values ('10000000-0000-4000-8000-000000000001', 'owner@example.test');

select set_config(
	'request.jwt.claims',
	'{"sub":"10000000-0000-4000-8000-000000000001","email":"owner@example.test","role":"authenticated","user_metadata":{"full_name":"Fixture Owner"}}',
	true
);

select public.qorpera_folder_company_open('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000c1', 'Fixture profile');

do $$
begin
	if (select count(*) from public.qorpera_profiles) <> 1 then
		raise exception 'hosted profile fixture was not created';
	end if;
	if (select count(*) from public.qorpera_profile_members where role = 'owner') <> 1 then
		raise exception 'hosted profile owner fixture was not created';
	end if;
	if not exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_object_reachability_graphs'
			and column_name = 'closure_verified'
	) then
		raise exception 'review blocker hardening migration was not applied';
	end if;
	if not exists (
		select 1
		from pg_catalog.pg_trigger
		where tgname = 'qorpera_clear_abandoned_runner_artifacts'
			and not tgisinternal
	) then
		raise exception 'runner attempt artifact guard was not installed';
	end if;
end
$$;

-- Production applies the migrations as Supabase's postgres role, which is not a superuser; this suite applies them
-- as one. PostgreSQL 15+ stores a function's, role's or database's own value for a custom parameter (a dotted name)
-- only for a superuser or a role granted SET on that parameter, and refuses anyone else with 42501, as v158's
-- production dry run did for 20260928339380 (2026-10-01). So a role that is not a superuser stores every setting
-- the migrations left on a function, a role or this database again; each must be one it may store.
-- scripts/check-migration-custom-settings.mjs refuses such a statement in a migration before anything runs.
create role qorpera_test_migration_shape nosuperuser nologin;
create schema qorpera_test_migration_shape authorization qorpera_test_migration_shape;
create temporary table migration_shape_settings on commit drop as
select distinct split_part(setting, '=', 1) as name, substr(setting, strpos(setting, '=') + 1) as value, source
from (
	select unnest(p.proconfig) as setting, 'function ' || p.oid::regprocedure::text as source
	from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
	where p.proconfig is not null and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
		and not exists (select 1 from pg_catalog.pg_depend d
			where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
	union all
	select unnest(s.setconfig), 'role ' || coalesce(r.rolname, 'any') || ' in database ' || coalesce(db.datname, 'any')
	from pg_catalog.pg_db_role_setting s
	left join pg_catalog.pg_roles r on r.oid = s.setrole
	left join pg_catalog.pg_database db on db.oid = s.setdatabase
	where s.setdatabase in (0, (select oid from pg_catalog.pg_database where datname = current_database()))
) stored;
grant select on migration_shape_settings to qorpera_test_migration_shape;
do $$
declare v_setting record; v_refused text[] := '{}';
begin
	if not exists (select 1 from pg_temp.migration_shape_settings where name = 'lock_timeout') then
		raise exception 'No stored lock_timeout found: the setting probe reads nothing'; end if;
	set local role qorpera_test_migration_shape;
	for v_setting in select name, value, min(source) as source from pg_temp.migration_shape_settings group by name, value loop
		begin
			execute format('create function qorpera_test_migration_shape.probe() returns void language sql set %I = %L as %L',
				v_setting.name, v_setting.value, 'select');
			drop function qorpera_test_migration_shape.probe();
		exception when insufficient_privilege then
			v_refused := v_refused || format('%s = %s (%s): %s', v_setting.name, v_setting.value, v_setting.source, sqlerrm);
		end;
	end loop;
	reset role;
	if cardinality(v_refused) > 0 then
		raise exception 'Production''s migration role (not a superuser) may not store these settings: %', v_refused; end if;
end
$$;

rollback;
