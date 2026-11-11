-- The races of a repository's site (20260930729000; the review of #1686: F1 and F4 of round 1, a company that makes one
-- site at a time, and round 2's names in opposite orders), on three connections. Locks show only across connections, so what the races need is committed here and
-- removed at the end: 924's fixture, which 1216 runs on, is one transaction no other connection sees. Each call that
-- must wait is seen waiting with pg_blocking_pids, never by time (a call that must not wait is seen done instead), and
-- every connection gives up after 20 s.
-- F3, the agent's unpublish, needs an agent's run, which only that fixture has: 1216's section 9 shows that its delete
-- never takes a code site (the refusal now comes after the delete, so a delete that took one would answer removed).
--   Race company: Ann owns it; repositories company/r22-slug, r22-off, r22-new and r22-beta (whose site wants the name
--   r22-alpha); its executor exec-1222.
--   Other company: its site r22-slug, whose first upload never finished, two days ago (abandoned); its repository
--   company/r22-alpha (whose site wants the name r22-beta), and the same executor.
--   Third company: its sites r22-alpha and r22-beta, made now.

insert into auth.users(id, email) values ('12220000-0000-4000-8000-00000000000a', 'race-1222@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('12220000-0000-4000-8000-000000000101', 'Race company', '12220000-0000-4000-8000-00000000000a'),
	('12220000-0000-4000-8000-000000000102', 'Other company', '12220000-0000-4000-8000-00000000000a'),
	('12220000-0000-4000-8000-000000000103', 'Third company', '12220000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12220000-0000-4000-8000-000000000101', '12220000-0000-4000-8000-00000000000a', 'race-1222@example.test', 'Ann', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'Environment', 1,
		'12220000-0000-4000-8000-00000000000a'),
	('12220000-0000-4000-8000-000000000202', '12220000-0000-4000-8000-000000000102', 'Environment', 1,
		'12220000-0000-4000-8000-00000000000a'),
	('12220000-0000-4000-8000-000000000203', '12220000-0000-4000-8000-000000000103', 'Environment', 1,
		'12220000-0000-4000-8000-00000000000a');
insert into public.qorpera_coding_executors(environment_id, owner, enabled, nas_machine_id_sha256)
select environment_id, 'exec-1222', true, repeat('6', 64)
from unnest(array['12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000202']::uuid[]) environment_id;
create temporary table race_repositories(environment_id uuid, profile_id uuid, name text, wanted text);
insert into race_repositories values
	('12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'r22-slug', null),
	('12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'r22-off', null),
	('12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'r22-new', null),
	('12220000-0000-4000-8000-000000000201', '12220000-0000-4000-8000-000000000101', 'r22-beta', 'r22-alpha'),
	('12220000-0000-4000-8000-000000000202', '12220000-0000-4000-8000-000000000102', 'r22-alpha', 'r22-beta');
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_change, last_main)
select environment_id, profile_id, 'company', name, 1, repeat('b', 40) from race_repositories;
-- One change each, whose checks passed and that made a site (one file of one byte), of the name it wants.
insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, how, main_before, main_after,
	head_sha, worker_id, sequence, title, checks_state, checks, site_state, site)
select environment_id, 'company', name, 1, profile_id, 'landing', 'landed',
	'fast-forward', repeat('a', 40), repeat('b', 40), repeat('b', 40), extensions.gen_random_uuid(), 1, 'A change', 'passed',
	'{"schema":"qorpera.code-checks/v1"}', 'made', jsonb_build_object('schema', 'qorpera.code-site/v1',
		'tree', encode(extensions.digest(name, 'sha1'), 'hex'), 'files', 1, 'bytes', 1, 'folder', 'dist', 'name', wanted, 'title', null)
from race_repositories;
-- The other company's abandoned site of r22-slug's name; r22-off's own site (not live).
insert into public.qorpera_company_sites(profile_id, environment_id, slug, source_path, created_by_staff_agent_id, updated_at)
values ('12220000-0000-4000-8000-000000000102', '12220000-0000-4000-8000-000000000202', 'r22-slug', 'site',
	'12220000-0000-4000-8000-000000000301', clock_timestamp() - interval '2 days');
insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, source_path, code_owner, code_name)
values ('12220000-0000-4000-8000-000000000401', '12220000-0000-4000-8000-000000000101', '12220000-0000-4000-8000-000000000201',
	'r22-off', 'code/company/r22-off', 'company', 'r22-off');
insert into public.qorpera_company_site_secrets(site_id, password) values ('12220000-0000-4000-8000-000000000401', 'abcd-efgh-jkmn');
-- Third company's two sites, of the names the two repositories want.
insert into public.qorpera_company_sites(profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
select '12220000-0000-4000-8000-000000000103', '12220000-0000-4000-8000-000000000203', slug, 'site',
	'12220000-0000-4000-8000-000000000302'
from unnest(array['r22-alpha', 'r22-beta']) slug;
update public.qorpera_code_repositories set site_id = '12220000-0000-4000-8000-000000000401'
where environment_id = '12220000-0000-4000-8000-000000000201' and name = 'r22-off';

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_hold', 'race_act', 'race_other']) name;
select set_config('qorpera_test.race_' || name || '_pid', (select pid::text from dblink('race_' || name,
	'select pg_backend_pid()') as b(pid integer)), false) from unnest(array['hold', 'act', 'other']) name \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null

-- Whether p_conn's call waits on p_by (race_hold unless named); false when the call ended first.
create function pg_temp.race_waits(p_conn text default 'race_act', p_by text default 'race_hold') returns boolean
language plpgsql as $$
declare v_by integer := current_setting('qorpera_test.' || p_by || '_pid')::integer;
	v_conn integer := current_setting('qorpera_test.' || p_conn || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_by = any(pg_blocking_pids(v_conn)) then return true; end if;
		exit when dblink_is_busy(p_conn) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The answer of p_conn's call (race_act unless named), or its error as {"error":<sqlstate>,"message":…}.
create function pg_temp.race_answer(p_conn text default 'race_act') returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result(p_conn) as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result(p_conn) as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result(p_conn) as call(answer text);
	return v::jsonb;
end $$;
-- p_conn (race_act unless named) as the service role, or as Ann.
create function pg_temp.race_as(p_role text, p_conn text default 'race_act') returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'reset role');
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L', jsonb_strip_nulls(jsonb_build_object('role', p_role,
		'sub', case when p_role = 'authenticated' then '12220000-0000-4000-8000-00000000000a' end))));
	perform dblink_exec(p_conn, format('set role %I', p_role));
end $$;
-- The executor's begin of change 1 of company/p_name in p_environment (Race company's unless named), as a connection
-- sends it.
create function pg_temp.race_begin(p_name text, p_environment uuid default '12220000-0000-4000-8000-000000000201')
returns text language sql immutable as $$
	select format('select public.qorpera_code_site_begin(%L, %L, %L, %L, %L, 1, %L)::text', 'exec-1222', repeat('6', 64),
		p_environment, 'company', p_name, jsonb_build_object('manifestSha256', repeat('a', 64), 'files', 1, 'bytes', 1))
$$;

-- Names in opposite orders (round 2). Two first uploads of two companies at once: Race company's r22-beta wants the
-- name r22-alpha, Other company's r22-alpha wants r22-beta, and Third company's sites have both names. An upload never
-- waits on the lock of a site whose name it passes over, so neither waits, on race_hold or on the other: each takes
-- its own next name, r22-beta-2 and r22-alpha-2. race_hold holds both sites' rows meanwhile (r22-beta in a savepoint)
-- and lets go of them in the order in which uploads that lock each name they pass would deadlock (40P01): r22-beta
-- first (Other company's upload, which waited for it, then waits for r22-alpha behind Race company's), then r22-alpha
-- (Race company's upload, holding r22-alpha, then waits for r22-beta, which Other company's holds).
do $$
declare v_race jsonb; v_other jsonb; v_waited text[] := '{}';
begin
	perform pg_temp.race_as('service_role');
	perform pg_temp.race_as('service_role', 'race_other');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_company_sites where slug = 'r22-alpha' for update$q$)
		as held(id text);
	perform dblink_exec('race_hold', 'savepoint r22_beta');
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_company_sites where slug = 'r22-beta' for update$q$)
		as held(id text);
	perform dblink_send_query('race_act', pg_temp.race_begin('r22-beta'));
	if pg_temp.race_waits() then v_waited := v_waited || 'Race company''s on race_hold'::text; end if;
	perform dblink_send_query('race_other', pg_temp.race_begin('r22-alpha', '12220000-0000-4000-8000-000000000202'));
	if pg_temp.race_waits('race_other') then v_waited := v_waited || 'Other company''s on race_hold'::text; end if;
	perform dblink_exec('race_hold', 'rollback to savepoint r22_beta');
	if pg_temp.race_waits('race_other', 'race_act') then
		v_waited := v_waited || 'Other company''s on Race company''s'::text; end if;
	perform dblink_exec('race_hold', 'commit');
	v_race := pg_temp.race_answer();
	v_other := pg_temp.race_answer('race_other');
	perform dblink_exec('race_other', 'reset role');
	if v_race ->> 'state' is distinct from 'uploading' or v_race ->> 'slug' is distinct from 'r22-beta-2'
		or v_other ->> 'state' is distinct from 'uploading' or v_other ->> 'slug' is distinct from 'r22-alpha-2'
		or cardinality(v_waited) > 0
		or (select count(*) from public.qorpera_company_sites where slug in ('r22-alpha', 'r22-beta')
			and profile_id = '12220000-0000-4000-8000-000000000103') <> 2 then
		raise exception 'names in opposite orders: Race company % and Other company % (waited: %)', v_race, v_other, v_waited;
	end if;
end $$;

-- F1. A new site takes the name of another company's abandoned site only while that site is still abandoned under its
-- lock, and never waits for that lock. That company's agent publishes to it meanwhile (its row locked and brought back
-- to life): the first upload passes the name over at once (round 2), the new site takes r22-slug-2, and the other
-- company's site stays.
do $$
declare v jsonb;
begin
	perform pg_temp.race_as('service_role');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_company_sites where slug = 'r22-slug' for update$q$)
		as held(id text);
	perform dblink_exec('race_hold', $q$update public.qorpera_company_sites set updated_at = clock_timestamp() where slug = 'r22-slug'$q$);
	perform dblink_send_query('race_act', pg_temp.race_begin('r22-slug'));
	if pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'F1: the begin waited for the lock of the site that had the name: %', pg_temp.race_answer(); end if;
	v := pg_temp.race_answer();
	perform dblink_exec('race_hold', 'commit');
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
	'12220000-0000-4000-8000-000000000202', '12220000-0000-4000-8000-000000000203');
delete from public.qorpera_code_repositories where environment_id in ('12220000-0000-4000-8000-000000000201',
	'12220000-0000-4000-8000-000000000202');
delete from public.qorpera_coding_executors where environment_id in ('12220000-0000-4000-8000-000000000201',
	'12220000-0000-4000-8000-000000000202');
delete from public.qorpera_profiles where id in ('12220000-0000-4000-8000-000000000101', '12220000-0000-4000-8000-000000000102',
	'12220000-0000-4000-8000-000000000103');
delete from auth.users where id = '12220000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_company_environments where id in ('12220000-0000-4000-8000-000000000201',
			'12220000-0000-4000-8000-000000000202', '12220000-0000-4000-8000-000000000203'))
		or exists (select 1 from public.qorpera_code_changes where environment_id in ('12220000-0000-4000-8000-000000000201',
			'12220000-0000-4000-8000-000000000202')) then
		raise exception 'the races left rows behind'; end if;
end $$;
