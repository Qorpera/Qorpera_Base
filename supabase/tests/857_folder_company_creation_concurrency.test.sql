-- Company creation on the folder core, P14a, under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-CREATION.md
-- §2, §3, §4): two founders pressing Start at once make one creation; a create call retried while the first is in
-- flight waits at the creation row and replays it (one kickoff, one first-run row); a join and a creation meet at the
-- folder fence in either order and the joiner ends in the Co-Founder's thread; a leave meets a creation at the fence;
-- a company delete waits for a creation in flight and ends with the creation made and the company hidden (before P08,
-- the deletion path is the gc fence and the pause, not the folder fence); a delete skips a creation row a worker holds,
-- and the finisher's next pass blocks it. The fixture is committed and removed at the end.

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
	('85700000-0000-4000-8000-000000000001','race-anna@example.test',clock_timestamp(),'{"display_name":"Anna"}'),
	('85700000-0000-4000-8000-000000000002','race-bo@example.test',clock_timestamp(),'{"display_name":"Bo"}'),
	('85700000-0000-4000-8000-000000000003','race-cy@example.test',clock_timestamp(),'{"display_name":"Cy"}'),
	('85700000-0000-4000-8000-000000000004','race-dee@example.test',clock_timestamp(),'{"display_name":"Dee"}'),
	('85700000-0000-4000-8000-000000000005','race-eve@example.test',clock_timestamp(),'{"display_name":"Eve"}');
insert into public.qorpera_friendships(user_low,user_high,requested_by,status,responded_at) values
	('85700000-0000-4000-8000-000000000001','85700000-0000-4000-8000-000000000002','85700000-0000-4000-8000-000000000001',
		'accepted',clock_timestamp());

create function pg_temp.as_user(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id = p_user))::text,false)::text::void
$$;
-- Session-wide (nothing here runs inside one transaction).
create function pg_temp.as_service()
returns void language sql as $$
	select set_config('request.jwt.claims','{"role":"service_role"}',false)::text::void
$$;
create function pg_temp.claims(p_user uuid) returns text language sql as $$
	select format('set request.jwt.claims = %L', jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id = p_user))::text)
$$;
-- The global policy row, kept to be put back at the end (this test commits).
select set_config('qorpera_test.policy', coalesce((select to_jsonb(policy) from public.qorpera_provider_execution_policies as policy
	where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli')::text, ''), false);
select pg_temp.as_service();
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
	'supported','enabled',32,null,'folder-company-creation-race-fixture') \g /dev/null

-- A founder connects their own ChatGPT login (as 705 does).
create function pg_temp.connect_login(p_profile uuid,p_user uuid,p_n integer)
returns void language plpgsql as $$
declare v_identity jsonb; v_login jsonb; v_connection jsonb; v_hex text := lpad(to_hex(p_n),2,'0');
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity(p_profile,('85700000-0000-4000-8000-0000000007' || v_hex)::uuid,
		'My model account','qorpera-member-linux','v1','["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login(p_profile,('85700000-0000-4000-8000-0000000008' || v_hex)::uuid,
		('85700000-0000-4000-8000-0000000009' || v_hex)::uuid,(v_identity ->> 'compute_identity_id')::uuid,
		'openai','codex-cli',repeat(v_hex,32),900);
	reset role;
	perform pg_temp.as_service();
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat(v_hex,32),
		('85700000-0000-4000-8000-000000000a' || v_hex)::uuid,
		'object://native-capsules/85700000-0000-4000-8000-000000000a' || v_hex,repeat('d',64),'openai-' || v_hex,
		'personal-subscription','qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions v
	where connection_id = (v_connection ->> 'connection_id')::uuid and version = 1;
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	perform public.qorpera_create_member_execution_sponsor(p_profile,('85700000-0000-4000-8000-000000000b' || v_hex)::uuid,
		(v_connection ->> 'connection_id')::uuid,2,true);
	reset role;
end $$;

-- The seed tree's units for a claim, staged as the platform here (committed), as 856 builds them.
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
create function pg_temp.stage(p_env uuid, p_text text) returns jsonb language plpgsql as $$
declare v_manifest text := pg_temp.manifest_v2(p_text); v_open jsonb; v_object jsonb; v_seal jsonb;
	v_actor constant jsonb := '{"kind":"platform"}';
begin
	perform pg_temp.as_service();
	v_open := public.qorpera_folder_open_upload(p_env, v_actor, v_manifest);
	for v_object in select c from jsonb_array_elements(v_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(v_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(v_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(p_env, v_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload(p_env, v_actor, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	return v_seal -> 'file';
end $$;
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.seed_units(p_claim jsonb) returns jsonb language plpgsql as $$
declare v_env uuid := (p_claim ->> 'environmentId')::uuid; v_input jsonb := p_claim -> 'input';
	v_name text := v_input ->> 'companyName'; v_kickoff text := p_claim ->> 'kickoffRequestedBy';
	v_agent_id text := p_claim ->> 'cofounderId'; v_vision text; v_agent text; v_todo text;
	v_skill constant text := E'# Writing a human task\n'; v_sections constant text := E'# Sections\n';
begin
	v_vision := E'# ' || v_name || E'\n\n' || btrim(v_input ->> 'vision') || E'\n\n## How we work\n';
	v_agent := format(E'---\nid: %s\nname: Co-Founder\nrole: Co-Founder\nkind: co-founder\nstatus: active\n---\nFound the company.\n', v_agent_id);
	v_todo := format(E'---\nid: %s\ntitle: Start with the founders\nstatus: open\nrequested-by: %s\n---\nMeet the founders.\n',
		p_claim ->> 'firstTodoId', v_kickoff);
	return jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'),
		jsonb_build_object('op','write','path','vision/vision.md','file',pg_temp.stage(v_env, v_vision),
			'structured', jsonb_build_array(pg_temp.entry('vision/vision.md','vision',v_vision,jsonb_build_object('kind','vision','name',v_name)))),
		jsonb_build_object('op','mkdir','path','agents'),
		jsonb_build_object('op','write','path','agents/sections.md','file',pg_temp.stage(v_env, v_sections),
			'structured', jsonb_build_array(pg_temp.entry('agents/sections.md','sections',v_sections,'{"kind":"sections","sections":[]}'))),
		jsonb_build_object('op','new_folder','path','agents/co-founder',
			'contents', jsonb_build_array(
				jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(v_env, v_agent)),
				jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','skills','kind','folder'),
				jsonb_build_object('path','routines','kind','folder'), jsonb_build_object('path','todos','kind','folder'),
				jsonb_build_object('path','todos/start-with-the-founders.md','kind','file','file',pg_temp.stage(v_env, v_todo))),
			'structured', jsonb_build_array(
				pg_temp.entry('agents/co-founder/agent.md','agent',v_agent,jsonb_build_object('kind','agent','id',v_agent_id,
					'name','Co-Founder','role','Co-Founder','agentKind','co-founder','status','active','colour',null,'figure',null,
					'model',null,'effort',null,'instructions','Found the company.')),
				pg_temp.entry('agents/co-founder/todos/start-with-the-founders.md','todo',v_todo,jsonb_build_object('kind','todo',
					'id',p_claim ->> 'firstTodoId','title','Start with the founders','status','open','requestedBy',v_kickoff,
					'detail','Meet the founders.')))),
		jsonb_build_object('op','mkdir','path','agents/groups'),
		jsonb_build_object('op','mkdir','path','connections'),
		jsonb_build_object('op','mkdir','path','human-tasks'),
		jsonb_build_object('op','mkdir','path','contacts'),
		jsonb_build_object('op','mkdir','path','skills'),
		jsonb_build_object('op','mkdir','path','skills/human-task'),
		jsonb_build_object('op','write','path','skills/human-task/SKILL.md','file',pg_temp.stage(v_env, v_skill)),
		jsonb_build_object('op','mkdir','path','rules'));
end $$;

-- Companies opened and seeded directly (Cy owns them), each claimed by its own worker; the create call is kept as text
-- for another connection: qorpera_test.create_<name>.
create function pg_temp.prepare(p_name text, p_n integer) returns uuid language plpgsql as $$
declare v_profile uuid; v_claim jsonb;
begin
	v_profile := (public.qorpera_folder_company_open('85700000-0000-4000-8000-000000000003',
		('85700000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0'))::uuid, p_name) ->> 'profile_id')::uuid;
	perform public.qorpera_folder_company_seed(v_profile, jsonb_build_object('schema','qorpera.company-seed-input/v1',
		'companyName',p_name,'vision','A race.','kickoffRequestedBy','85700000-0000-4000-8000-000000000003',
		'founders','[{"userId":"85700000-0000-4000-8000-000000000003","displayName":"Cy","role":""}]'::jsonb));
	perform set_config('qorpera_test.profile_' || p_name, v_profile::text, false);
	return v_profile;
end $$;
create function pg_temp.claim_for(p_name text, p_n integer) returns void language plpgsql as $$
declare v_claim jsonb;
begin
	perform pg_temp.as_service();
	v_claim := public.qorpera_folder_company_creation_claim(('85700000-0000-4000-8000-0000000000f' || p_n)::uuid, 900);
	if v_claim ->> 'profileId' is distinct from current_setting('qorpera_test.profile_' || p_name) then
		raise exception 'Fixture claim for %: %', p_name, v_claim; end if;
	perform set_config('qorpera_test.create_' || p_name, format('select public.qorpera_folder_company_create(%L, %L, %s, %L)',
		'85700000-0000-4000-8000-0000000000f' || p_n, v_claim ->> 'creationId', v_claim ->> 'generation',
		pg_temp.seed_units(v_claim)::text), false);
end $$;
create function pg_temp.in_thread(p_profile uuid, p_user uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_company_room_members m join public.qorpera_company_rooms r on r.id = m.room_id
		join public.qorpera_company_cofounders c on c.profile_id = r.profile_id and c.staff_agent_id = r.bound_staff_agent_id
		where r.profile_id = p_profile and m.principal_kind = 'member' and m.principal_id = p_user and m.status = 'active')
$$;

-- Prepare each company in turn (each claim takes the oldest queued creation).
select pg_temp.prepare('retry', 1); select pg_temp.claim_for('retry', 1);
select pg_temp.prepare('joinafter', 2); select pg_temp.claim_for('joinafter', 2);
select pg_temp.prepare('joinbefore', 3); select pg_temp.claim_for('joinbefore', 3);
select pg_temp.prepare('leave', 4); select pg_temp.claim_for('leave', 4);
select pg_temp.prepare('deleted', 5); select pg_temp.claim_for('deleted', 5);
select pg_temp.prepare('skipped', 6); select pg_temp.claim_for('skipped', 6);
-- Invitations for the joiners, and Bo as a member of 'leave'.
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, created_at, expires_at) values
	('85700000-0000-4000-8000-0000000000e1', current_setting('qorpera_test.profile_joinafter')::uuid, 'race-dee@example.test',
		'contributor', '85700000-0000-4000-8000-000000000003', clock_timestamp(), clock_timestamp() + interval '1 day'),
	('85700000-0000-4000-8000-0000000000e2', current_setting('qorpera_test.profile_joinbefore')::uuid, 'race-eve@example.test',
		'contributor', '85700000-0000-4000-8000-000000000003', clock_timestamp(), clock_timestamp() + interval '1 day');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values (current_setting('qorpera_test.profile_leave')::uuid,'85700000-0000-4000-8000-000000000002','race-bo@example.test','Bo',
	'contributor');

-- The lobby's table for two racing Starts: Anna and Bo, both Ready with their own logins. The switch is on for this
-- section only.
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select true
$$;
select pg_temp.as_user('85700000-0000-4000-8000-000000000001');
select set_config('qorpera_test.table',(public.qorpera_open_company_founding('85700000-0000-4000-8000-000000000150',
	'Race Table') ->> 'profileId'),false);
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table')::uuid,'85700000-0000-4000-8000-000000000002')
	\g /dev/null
select pg_temp.as_user('85700000-0000-4000-8000-000000000002');
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table')::uuid,true) \g /dev/null
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,'85700000-0000-4000-8000-000000000001',1);
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,'85700000-0000-4000-8000-000000000002',2);
select pg_temp.as_user('85700000-0000-4000-8000-000000000001');
select public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,2,true) \g /dev/null
select pg_temp.as_user('85700000-0000-4000-8000-000000000002');
select public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,2,true) \g /dev/null
select set_config('request.jwt.claims','',false) \g /dev/null

-- The connections.
select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['make_one','make_two']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['make_one','make_two']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);
create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- A sent statement's single text result, or its error.
create function pg_temp.result(p_conn text) returns text language plpgsql as $$
declare v text;
begin
	begin
		select r into v from dblink_get_result(p_conn) as t(r text);
	exception when others then v := 'error ' || sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v;
end $$;

-- A. Two founders press Start at once: the second waits at the fence and sees the started table; one creation.
do $$
declare v_start text := format('select public.qorpera_start_company_founding(%L, 2, %L)::text',
	current_setting('qorpera_test.table'), '85700000-0000-4000-8000-000000000250'); v_second text;
begin
	perform dblink_exec('make_one', pg_temp.claims('85700000-0000-4000-8000-000000000001'));
	perform dblink_exec('make_two', pg_temp.claims('85700000-0000-4000-8000-000000000002'));
	perform dblink_exec('make_one', 'begin');
	perform * from dblink('make_one', v_start) as t(r text);
	perform dblink_send_query('make_two', v_start);
	if not pg_temp.waits_for('make_two', 'make_one') then raise exception 'A second Start must wait for the first'; end if;
	perform dblink_exec('make_one', 'commit');
	v_second := pg_temp.result('make_two');
	if v_second like 'error%' or v_second::jsonb ->> 'phase' is distinct from 'started' then raise exception 'The second Start: %', v_second; end if;
	if (select count(*) from public.qorpera_folder_company_creations where profile_id = current_setting('qorpera_test.table')::uuid) is distinct from 1 then
		raise exception 'Two Starts made more than one creation'; end if;
	perform dblink_exec(name, 'reset request.jwt.claims') from unnest(array['make_one','make_two']) name;
end $$;
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select false
$$;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['make_one','make_two']) name;
-- The one creation the two Starts made: one first run and one kickoff, paid by Anna (who pressed Start first).
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_claim jsonb; v_result jsonb;
begin
	perform pg_temp.as_service();
	v_claim := public.qorpera_folder_company_creation_claim('85700000-0000-4000-8000-0000000000f9', 900);
	if v_claim ->> 'profileId' is distinct from v_profile::text then raise exception 'The table''s claim: %', v_claim; end if;
	v_result := public.qorpera_folder_company_create('85700000-0000-4000-8000-0000000000f9', (v_claim ->> 'creationId')::uuid,
		(v_claim ->> 'generation')::bigint, pg_temp.seed_units(v_claim));
	if v_result ->> 'state' is distinct from 'completed'
		or (select count(*) from public.qorpera_agent_first_runs where profile_id = v_profile) is distinct from 1
		or (select count(*) from public.qorpera_session_inputs input join public.qorpera_company_rooms room on room.session_id = input.session_id
			where room.profile_id = v_profile and input.kind = 'kickoff') is distinct from 1
		or (select count(*) from public.qorpera_session_turn_requests where profile_id = v_profile) is distinct from 1 then
		raise exception 'Two Starts did not make exactly one first run: %', v_result; end if;
end $$;

-- B. A create call retried while the first is in flight: it waits at the creation row, then replays the result.
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_retry')::uuid; v_first text; v_second text;
begin
	perform dblink_exec('make_one', 'begin');
	select r into v_first from dblink('make_one', current_setting('qorpera_test.create_retry') || '::text') as t(r text);
	perform dblink_send_query('make_two', current_setting('qorpera_test.create_retry') || '::text');
	if not pg_temp.waits_for('make_two', 'make_one') then raise exception 'A retried create must wait at the creation row'; end if;
	perform dblink_exec('make_one', 'commit');
	v_second := pg_temp.result('make_two');
	if v_first::jsonb ->> 'state' is distinct from 'completed' or v_second like 'error%' or v_second::jsonb ->> 'state' is distinct from 'completed'
		or (v_second::jsonb ->> 'replay')::boolean is not true
		or (select count(*) from public.qorpera_agent_first_runs where profile_id = v_profile) is distinct from 1
		or (select count(*) from public.qorpera_session_inputs input join public.qorpera_company_rooms room on room.session_id = input.session_id
			where room.profile_id = v_profile and input.kind = 'kickoff') is distinct from 1 then
		raise exception 'A retried create made a second first run: % %', v_first, v_second; end if;
end $$;

-- C. A join and a creation meet at the fence. (i) The creation first: the join waits, then joins the thread.
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_joinafter')::uuid; v_join text;
begin
	perform dblink_exec('make_one', 'begin');
	perform * from dblink('make_one', current_setting('qorpera_test.create_joinafter') || '::text') as t(r text);
	perform dblink_exec('make_two', pg_temp.claims('85700000-0000-4000-8000-000000000004'));
	perform dblink_send_query('make_two', $q$select public.qorpera_accept_profile_invitation('85700000-0000-4000-8000-0000000000e1')::text$q$);
	if not pg_temp.waits_for('make_two', 'make_one') then raise exception 'A join must wait for a creation at the fence'; end if;
	perform dblink_exec('make_one', 'commit');
	v_join := pg_temp.result('make_two');
	if v_join like 'error%' then raise exception 'The join after a creation: %', v_join; end if;
	if (select state from public.qorpera_folder_company_creations where profile_id = v_profile) is distinct from 'completed'
		or not pg_temp.in_thread(v_profile, '85700000-0000-4000-8000-000000000004') then
		raise exception 'The joiner is not in the Co-Founder''s thread after the creation'; end if;
	perform dblink_exec('make_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
end $$;
-- (ii) The join first: the creation waits at the fence, then its thread has the joiner.
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_joinbefore')::uuid; v_create text;
begin
	perform dblink_exec('make_two', pg_temp.claims('85700000-0000-4000-8000-000000000005'));
	perform dblink_exec('make_two', 'begin');
	perform * from dblink('make_two', $q$select public.qorpera_accept_profile_invitation('85700000-0000-4000-8000-0000000000e2')::text$q$)
		as t(r text);
	perform dblink_send_query('make_one', current_setting('qorpera_test.create_joinbefore') || '::text');
	if not pg_temp.waits_for('make_one', 'make_two') then raise exception 'A creation must wait for a join at the fence'; end if;
	perform dblink_exec('make_two', 'commit');
	v_create := pg_temp.result('make_one');
	if v_create like 'error%' or v_create::jsonb ->> 'state' is distinct from 'completed'
		or not pg_temp.in_thread(v_profile, '85700000-0000-4000-8000-000000000005')
		or not pg_temp.in_thread(v_profile, '85700000-0000-4000-8000-000000000003') then
		raise exception 'A creation after a join misses a member in the thread: %', v_create; end if;
	perform dblink_exec('make_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
end $$;

-- D. A leave meets a creation at the fence; the leaver is out of the thread after both.
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_leave')::uuid; v_leave text;
begin
	perform dblink_exec('make_one', 'begin');
	perform * from dblink('make_one', current_setting('qorpera_test.create_leave') || '::text') as t(r text);
	perform dblink_exec('make_two', pg_temp.claims('85700000-0000-4000-8000-000000000002'));
	perform dblink_send_query('make_two', format('select public.qorpera_leave_hosted_profile(%L)::text', v_profile));
	if not pg_temp.waits_for('make_two', 'make_one') then raise exception 'A leave must wait for a creation at the fence'; end if;
	perform dblink_exec('make_one', 'commit');
	v_leave := pg_temp.result('make_two');
	if v_leave like 'error%' then raise exception 'The leave after a creation: %', v_leave; end if;
	if (select state from public.qorpera_folder_company_creations where profile_id = v_profile) is distinct from 'completed'
		or pg_temp.in_thread(v_profile, '85700000-0000-4000-8000-000000000002')
		or exists (select 1 from public.qorpera_profile_members where profile_id = v_profile
			and user_id = '85700000-0000-4000-8000-000000000002') then
		raise exception 'The leaver is still in the company or its thread'; end if;
	perform dblink_exec('make_two', $q$set request.jwt.claims = '{"role":"service_role"}'$q$);
end $$;

-- E. A company delete beside a creation in flight (since P08, 20260930015000: the delete takes the folder fence FOR NO KEY
-- UPDATE and the pause, and skips the held creation row). Whatever waits, nothing deadlocks; the creation is made and the company stays hidden.
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_deleted')::uuid; v_delete text;
begin
	perform dblink_exec('make_one', 'begin');
	perform * from dblink('make_one', current_setting('qorpera_test.create_deleted') || '::text') as t(r text);
	perform dblink_send_query('make_two', format($q$select public.qorpera_request_company_deletion(%L, '85700000-0000-4000-8000-000000000003')::text$q$,
		v_profile));
	-- The delete's folder fence (FOR NO KEY UPDATE) waits behind the creation's own NO KEY UPDATE.
	if not pg_temp.waits_for('make_two', 'make_one') then raise exception 'A delete must wait for a creation in flight'; end if;
	perform dblink_exec('make_one', 'commit');
	v_delete := pg_temp.result('make_two');
	if v_delete like 'error%' then raise exception 'The delete beside a creation: %', v_delete; end if;
	if (select state from public.qorpera_folder_company_creations where profile_id = v_profile) is distinct from 'completed'
		or not exists (select 1 from public.qorpera_company_deletions where profile_id = v_profile) then
		raise exception 'The creation and the delete did not both land'; end if;
	perform pg_temp.as_user('85700000-0000-4000-8000-000000000003');
	if exists (select 1 from jsonb_array_elements(public.qorpera_list_hosted_profiles()) company
		where company ->> 'profile_id' = v_profile::text) then
		raise exception 'A company being deleted is listed'; end if;
	perform set_config('request.jwt.claims', '', true);
end $$;

-- F. A delete beside a creation row a worker holds before its fence (the create waits elsewhere): the delete does not
-- wait for that row (SKIP LOCKED) and leaves it leased; the finisher's next pass blocks it, and the create is stale.
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_skipped')::uuid; v_until timestamptz;
	v_delete text; v_creation public.qorpera_folder_company_creations;
begin
	perform dblink_exec('make_one', 'begin');
	perform * from dblink('make_one', format('select id::text from public.qorpera_folder_company_creations where profile_id = %L for update',
		v_profile)) as t(r text);
	perform dblink_send_query('make_two', format($q$select public.qorpera_request_company_deletion(%L, '85700000-0000-4000-8000-000000000003')::text$q$,
		v_profile));
	v_until := clock_timestamp() + interval '60 seconds';
	while dblink_is_busy('make_two') = 1 loop
		if current_setting('qorpera_test.pid_make_one')::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_make_two')::integer)) then
			raise exception 'A delete waited for a creation row a worker holds'; end if;
		if clock_timestamp() > v_until then raise exception 'The delete did not finish'; end if;
		perform pg_sleep(0.02);
	end loop;
	v_delete := pg_temp.result('make_two');
	if v_delete like 'error%' then raise exception 'The delete beside a held creation row: %', v_delete; end if;
	select * into v_creation from public.qorpera_folder_company_creations where profile_id = v_profile;
	if v_creation.state is distinct from 'leased' then raise exception 'The delete took a held creation row: %', to_jsonb(v_creation); end if;
	perform dblink_exec('make_one', 'rollback');
end $$;
-- The finisher's next pass, committed on its own (this session never holds a row while it waits on another).
select public.qorpera_stop_company_work(current_setting('qorpera_test.profile_skipped')::uuid) \g /dev/null
do $$
declare v_profile uuid := current_setting('qorpera_test.profile_skipped')::uuid; v_creation public.qorpera_folder_company_creations;
	v_result jsonb;
begin
	select * into v_creation from public.qorpera_folder_company_creations where profile_id = v_profile;
	if v_creation.state is distinct from 'blocked' or v_creation.input is not null then
		raise exception 'The finisher''s next pass did not block it: %', to_jsonb(v_creation); end if;
	perform pg_temp.as_service();
	execute current_setting('qorpera_test.create_skipped') into v_result;
	if v_result ->> 'state' is distinct from 'stale' then raise exception 'A create of a blocked creation: %', v_result; end if;
end $$;

select dblink_disconnect(name) from unnest(array['make_one','make_two']) name;

-- Remove the fixture (as 818 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[]; v_envs uuid[]; v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_identities uuid[];
	v_table record;
begin
	select array_agg(id) into v_profiles from public.qorpera_profiles where created_by_user_id::text like '85700000-%';
	select array_agg(id) into v_envs from public.qorpera_company_environments where profile_id = any (v_profiles);
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	select array_agg(id) into v_identities from public.qorpera_member_compute_identities where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	delete from public.qorpera_provider_connection_versions where connection_id in
		(select id from public.qorpera_provider_connections where profile_id = any (v_profiles));
	delete from public.qorpera_execution_sponsor_versions where binding_id in
		(select id from public.qorpera_execution_sponsor_bindings where profile_id = any (v_profiles));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id',
			'compute_identity_id') and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions
			when 'compute_identity_id' then v_identities else v_rooms end;
	end loop;
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_profiles where id = any (v_profiles);
	delete from public.qorpera_company_creation_requests where created_by_user_id::text like '85700000-%';
	delete from public.qorpera_friendships where requested_by::text like '85700000-%';
end $$;
-- The policy row as it was.
delete from public.qorpera_provider_execution_policies
where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli';
insert into public.qorpera_provider_execution_policies
select (jsonb_populate_record(null::public.qorpera_provider_execution_policies, current_setting('qorpera_test.policy')::jsonb)).*
where current_setting('qorpera_test.policy') is distinct from '';
set session_replication_role = origin;
select set_config('request.jwt.claims', '', false);
delete from auth.users where id::text like '85700000-%';
do $$
begin
	if exists (select 1 from public.qorpera_profiles where created_by_user_id::text like '85700000-%')
		or exists (select 1 from public.qorpera_folder_company_creations c where not exists (select 1 from public.qorpera_profiles p where p.id = c.profile_id))
		or exists (select 1 from auth.users where id::text like '85700000-%')
		or public.qorpera_company_founding_available() then
		raise exception 'The race fixture must be removed'; end if;
end $$;
