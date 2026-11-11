-- The races of a repository's site (20260930729000; the review of #1686: F1, F4, and a company that makes one site at
-- a time), on three connections. Locks show only across connections, so what the races need is committed here and
-- removed at the end: 924's fixture, which 1216 runs on, is one transaction no other connection sees. Each call that
-- must wait is seen waiting with pg_blocking_pids, never by time, and every connection gives up after 20 s.
-- F3, the agent's unpublish, needs an agent's run, which only that fixture has: 1216's section 9 shows that its delete
-- never takes a code site (the refusal now comes after the delete, so a delete that took one would answer removed).
--   Race company: Ann owns it; repositories company/r22-slug, r22-off and r22-new; its executor exec-1222.
--   Other company: its site r22-slug, whose first upload never finished, two days ago (abandoned).

insert into auth.users(id, email) values ('12220000-0000-4000-8000-00000000000a', 'race-1222@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('12220000-0000-4000-8000-000000000101', 'Race company', '12220000-0000-4000-8000-00000000000a'),
	('12220000-0000-4000-8000-000000000102', 'Other company', '12220000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12220000-0000-4000-8000-000000000101', '12220000-0000-4000-8000-00000000000a', 'race-1222@example.test', 'Ann', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'Environment', 1,
		'12220000-0000-4000-8000-00000000000a'),
	('12220000-0000-4000-8000-000000000202', '12220000-0000-4000-8000-000000000102', 'Environment', 1,
		'12220000-0000-4000-8000-00000000000a');
insert into public.qorpera_coding_executors(environment_id, owner, enabled, nas_machine_id_sha256)
values ('12220000-0000-4000-8000-000000000201', 'exec-1222', true, repeat('6', 64));
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_change, last_main)
select '12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'company', name, 1, repeat('b', 40)
from unnest(array['r22-slug', 'r22-off', 'r22-new']) name;
-- One change each, whose checks passed and that made a site (one file of one byte).
insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, how, main_before, main_after,
	head_sha, worker_id, sequence, title, checks_state, checks, site_state, site)
select '12220000-0000-4000-8000-000000000201', 'company', name, 1, '12220000-0000-4000-8000-000000000101', 'landing', 'landed',
	'fast-forward', repeat('a', 40), repeat('b', 40), repeat('b', 40), extensions.gen_random_uuid(), 1, 'A change', 'passed',
	'{"schema":"qorpera.code-checks/v1"}', 'made', jsonb_build_object('schema', 'qorpera.code-site/v1',
		'tree', encode(extensions.digest(name, 'sha1'), 'hex'), 'files', 1, 'bytes', 1, 'folder', 'dist', 'name', null, 'title', null)
from unnest(array['r22-slug', 'r22-off', 'r22-new']) name;
-- The other company's abandoned site of r22-slug's name; r22-off's own site (not live).
insert into public.qorpera_company_sites(profile_id, environment_id, slug, source_path, created_by_staff_agent_id, updated_at)
values ('12220000-0000-4000-8000-000000000102', '12220000-0000-4000-8000-000000000202', 'r22-slug', 'site',
	'12220000-0000-4000-8000-000000000301', clock_timestamp() - interval '2 days');
insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, source_path, code_owner, code_name)
values ('12220000-0000-4000-8000-000000000401', '12220000-0000-4000-8000-000000000101', '12220000-0000-4000-8000-000000000201',
	'r22-off', 'code/company/r22-off', 'company', 'r22-off');
insert into public.qorpera_company_site_secrets(site_id, password) values ('12220000-0000-4000-8000-000000000401', 'abcd-efgh-jkmn');
update public.qorpera_code_repositories set site_id = '12220000-0000-4000-8000-000000000401'
where environment_id = '12220000-0000-4000-8000-000000000201' and name = 'r22-off';

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_hold', 'race_act', 'race_other']) name;
select set_config('qorpera_test.race_' || name || '_pid', (select pid::text from dblink('race_' || name,
	'select pg_backend_pid()') as b(pid integer)), false) from unnest(array['hold', 'act']) name \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null

-- Whether race_act's call waits on race_hold; false when the call ended first.
create function pg_temp.race_waits() returns boolean language plpgsql as $$
declare v_hold integer := current_setting('qorpera_test.race_hold_pid')::integer;
	v_act integer := current_setting('qorpera_test.race_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_hold = any(pg_blocking_pids(v_act)) then return true; end if;
		exit when dblink_is_busy('race_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The answer of race_act's call, or its error as {"error":<sqlstate>,"message":…}.
create function pg_temp.race_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('race_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('race_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('race_act') as call(answer text);
	return v::jsonb;
end $$;
-- race_act as the service role, or as Ann.
create function pg_temp.race_as(p_role text) returns void language plpgsql as $$
begin
	perform dblink_exec('race_act', 'reset role');
	perform dblink_exec('race_act', format('set request.jwt.claims = %L', jsonb_strip_nulls(jsonb_build_object('role', p_role,
		'sub', case when p_role = 'authenticated' then '12220000-0000-4000-8000-00000000000a' end))));
	perform dblink_exec('race_act', format('set role %I', p_role));
end $$;
-- The executor's begin of change 1 of company/p_name, as race_act sends it.
create function pg_temp.race_begin(p_name text) returns text language sql immutable as $$
	select format('select public.qorpera_code_site_begin(%L, %L, %L, %L, %L, 1, %L)::text', 'exec-1222', repeat('6', 64),
		'12220000-0000-4000-8000-000000000201', 'company', p_name,
		jsonb_build_object('manifestSha256', repeat('a', 64), 'files', 1, 'bytes', 1))
$$;

-- F1. A new site takes the name of another company's abandoned site only while that site is still abandoned under its
-- lock. That company's agent publishes to it meanwhile (its row locked and brought back to life): the new site takes
-- r22-slug-2, and the other company's site stays.
do $$
declare v jsonb;
begin
	perform pg_temp.race_as('service_role');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_company_sites where slug = 'r22-slug' for update$q$)
		as held(id text);
	perform dblink_exec('race_hold', $q$update public.qorpera_company_sites set updated_at = clock_timestamp() where slug = 'r22-slug'$q$);
	perform dblink_send_query('race_act', pg_temp.race_begin('r22-slug'));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'F1: the begin did not wait for the site that had the name: %', pg_temp.race_answer(); end if;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v ->> 'state' is distinct from 'uploading' or v ->> 'slug' is distinct from 'r22-slug-2'
		or (select profile_id from public.qorpera_company_sites where slug = 'r22-slug')
			is distinct from '12220000-0000-4000-8000-000000000102' then
		raise exception 'F1: the other company''s site went, or the name was not passed over: %', v; end if;
end $$;

-- F4. A member who takes a code site offline takes its registry row before the site, as an upload's begin and finish
-- and a release do: while the registry row is held elsewhere, the member's call waits and holds no lock on the site.
do $$
declare v jsonb; v_state text;
begin
	perform pg_temp.race_as('authenticated');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select name from public.qorpera_code_repositories
		where environment_id = '12220000-0000-4000-8000-000000000201' and name = 'r22-off' for update$q$) as held(name text);
	perform dblink_send_query('race_act', $q$select public.qorpera_unpublish_company_site('12220000-0000-4000-8000-000000000401')::text$q$);
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'F4: the member''s call did not wait for the registry row: %', pg_temp.race_answer(); end if;
	begin
		perform * from dblink('race_other', $q$select id::text from public.qorpera_company_sites
			where id = '12220000-0000-4000-8000-000000000401' for update nowait$q$) as probe(id text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate;
		perform dblink_exec('race_hold', 'rollback');
		perform pg_temp.race_answer();
		raise exception 'F4: the member''s call held the site while it waited for the registry row (%)', v_state;
	end;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v ->> 'removed' is distinct from 'true' or exists (select 1 from public.qorpera_company_sites
			where id = '12220000-0000-4000-8000-000000000401')
		or (select site_id from public.qorpera_code_repositories where environment_id = '12220000-0000-4000-8000-000000000201'
			and name = 'r22-off') is not null then
		raise exception 'F4: not taken offline: %', v; end if;
end $$;

-- A company makes one site at a time: while another call of the company makes one (its lock held), a first upload
-- waits before it counts the company's ten.
do $$
declare v jsonb;
begin
	perform pg_temp.race_as('service_role');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select pg_advisory_xact_lock(hashtextextended('qorpera.company-sites:'
		|| '12220000-0000-4000-8000-000000000101', 0))::text$q$) as held(answer text);
	perform dblink_send_query('race_act', pg_temp.race_begin('r22-new'));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'a first upload did not wait for the company''s other site: %', pg_temp.race_answer(); end if;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v ->> 'state' is distinct from 'uploading' or v ->> 'slug' is distinct from 'r22-new' then
		raise exception 'the first upload after the wait: %', v; end if;
end $$;

-- At the end: remove what the test committed.
select dblink_disconnect(name) from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null
delete from public.qorpera_company_sites where environment_id in ('12220000-0000-4000-8000-000000000201',
	'12220000-0000-4000-8000-000000000202');
delete from public.qorpera_code_repositories where environment_id = '12220000-0000-4000-8000-000000000201';
delete from public.qorpera_coding_executors where environment_id = '12220000-0000-4000-8000-000000000201';
delete from public.qorpera_profiles where id in ('12220000-0000-4000-8000-000000000101', '12220000-0000-4000-8000-000000000102');
delete from auth.users where id = '12220000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_company_environments where id in ('12220000-0000-4000-8000-000000000201',
			'12220000-0000-4000-8000-000000000202'))
		or exists (select 1 from public.qorpera_code_changes where environment_id = '12220000-0000-4000-8000-000000000201') then
		raise exception 'the races left rows behind'; end if;
end $$;
