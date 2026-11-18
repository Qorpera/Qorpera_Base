-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

select pg_temp.base_assert(to_regprocedure(
	'public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid)') is not null,
	'the sharing rule (20260930754000) is in this database');

insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12860000-0000-4000-8000-000000000010', 'Home every company, made after the switch',
	'92400000-0000-4000-8000-000000000001');

create function pg_temp.hc_listed() returns uuid language sql as $$ select '92400000-0000-4000-8000-000000000010'::uuid $$;
create function pg_temp.hc_new() returns uuid language sql as $$ select '12860000-0000-4000-8000-000000000010'::uuid $$;
create function pg_temp.hc_allowed(p_profile uuid) returns boolean language sql as $$
	select public.qorpera_company_home_allowed(p_profile)
$$;
create function pg_temp.hc_switch(p_platform boolean, p_every boolean, p_listed boolean) returns void language plpgsql as $$
begin
	delete from public.qorpera_home_settings;
	delete from public.qorpera_home_companies where profile_id in (pg_temp.hc_listed(), pg_temp.hc_new());
	if p_platform is not null then
		insert into public.qorpera_home_settings(singleton, enabled, every_company) values (true, p_platform, p_every);
	end if;
	if p_listed then insert into public.qorpera_home_companies(profile_id) values (pg_temp.hc_listed()); end if;
end
$$;

do $$
begin
	perform pg_temp.base_assert((select column_default = 'false' and is_nullable = 'NO' and data_type = 'boolean'
		from information_schema.columns where table_schema = 'public' and table_name = 'qorpera_home_settings'
			and column_name = 'every_company'), '1: every_company is a boolean, not null, false by default');

	perform pg_temp.hc_switch(null, null, false);
	perform pg_temp.base_assert(not pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'1: with no rows no company has the home');

	perform pg_temp.hc_switch(false, false, false);
	perform pg_temp.base_assert(not pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'1: with the platform switch off no company has the home');

	perform pg_temp.hc_switch(true, false, false);
	perform pg_temp.base_assert(not pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'1: platform on, every company off, nobody listed: no company has the home');

	perform pg_temp.hc_switch(true, false, true);
	perform pg_temp.base_assert(pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'1: platform on, every company off: only the listed company has the home');

	delete from public.qorpera_home_settings;
	insert into public.qorpera_home_settings(singleton, enabled) values (true, true);
	perform pg_temp.base_assert(not (select every_company from public.qorpera_home_settings where singleton)
		and pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'1: a platform row written without every_company is the listed companies only');
end $$;

do $$
begin
	perform pg_temp.hc_switch(true, true, false);
	perform pg_temp.base_assert(pg_temp.hc_allowed(pg_temp.hc_listed()),
		'2: platform on and every company on: the fixture''s company has the home, unlisted');
	perform pg_temp.base_assert(pg_temp.hc_allowed(pg_temp.hc_new()),
		'2: and so does a company made after the migration');

	perform pg_temp.hc_switch(true, true, true);
	perform pg_temp.base_assert(pg_temp.hc_allowed(pg_temp.hc_listed()) and pg_temp.hc_allowed(pg_temp.hc_new()),
		'2: a listed company keeps it beside every other');
end $$;

do $$
begin
	perform pg_temp.hc_switch(false, true, false);
	perform pg_temp.base_assert(not pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'3: every company on with the platform switch off: no company has the home');

	perform pg_temp.hc_switch(false, true, true);
	perform pg_temp.base_assert(not pg_temp.hc_allowed(pg_temp.hc_listed()) and not pg_temp.hc_allowed(pg_temp.hc_new()),
		'3: nor the listed company');
end $$;

do $$
begin
	perform pg_temp.hc_switch(true, true, true);
	update public.qorpera_home_settings set every_company = false where singleton;
	perform pg_temp.base_assert(not (select every_company from public.qorpera_home_settings where singleton)
		and (select enabled from public.qorpera_home_settings where singleton),
		'4: the way back turns every company off and leaves the platform switch on');
	perform pg_temp.base_assert(pg_temp.hc_allowed(pg_temp.hc_listed()),
		'4: after the way back the listed company still has the home');
	perform pg_temp.base_assert(not pg_temp.hc_allowed(pg_temp.hc_new()),
		'4: and an unlisted one does not');
end $$;

do $$
declare v_role text; v_table text; v_privilege text;
begin
	foreach v_table in array array['public.qorpera_home_settings','public.qorpera_home_companies'] loop
		foreach v_role in array array['public','anon','authenticated','service_role'] loop
			foreach v_privilege in array array['select','insert','update','delete'] loop
				perform pg_temp.base_assert(not has_table_privilege(v_role, v_table, v_privilege),
					'5: ' || v_role || ' has no ' || v_privilege || ' on ' || v_table);
			end loop;
		end loop;
	end loop;
	foreach v_role in array array['public','anon','authenticated','service_role','qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_company_home_allowed(uuid)', 'execute'),
			'5: ' || v_role || ' cannot call the company''s home gate');
	end loop;
	perform pg_temp.base_assert((select p.prosecdef and p.provolatile = 's' and p.prorettype = 'boolean'::regtype
			and p.proconfig = array['search_path=""']
		from pg_catalog.pg_proc p where p.oid = 'public.qorpera_company_home_allowed(uuid)'::regprocedure),
		'5: the gate is still a stable security definer with an empty search path, returning boolean');
	perform pg_temp.base_assert((select relrowsecurity from pg_catalog.pg_class where oid = 'public.qorpera_home_settings'::regclass)
		and (select relrowsecurity from pg_catalog.pg_class where oid = 'public.qorpera_home_companies'::regclass),
		'5: both tables keep row level security');
end $$;
