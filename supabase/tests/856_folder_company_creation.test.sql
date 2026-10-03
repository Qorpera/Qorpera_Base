-- Company creation on the folder core, P14a (deploy/first-node/RUNTIME-COMPANY-FOLDER-CREATION.md): Open makes the
-- company on folder-v2 with nothing seeded; Start records one creation; the worker's claim, release, fail and the one
-- creation transaction (completed, retry, failed, stale, replay) with the Co-Founder and its silent first run (the
-- kickoff's exact shape, the first-run row, the turn request with and without a usable login, no wake); ready, the
-- founders' setup state and the hub; the guards (departure, the old chain, enabling, delete); requeue; snapshot-v1 keeps
-- every patched text. The operator path is in 858, races in 857.
begin;

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
	('85600000-0000-4000-8000-000000000001','anna@example.test',statement_timestamp(),'{"display_name":"Anna"}'),
	('85600000-0000-4000-8000-000000000002','bo@example.test',statement_timestamp(),'{"display_name":"Bo"}'),
	('85600000-0000-4000-8000-000000000003','cy@example.test',statement_timestamp(),'{"display_name":"Cy"}');
insert into public.qorpera_friendships(user_low,user_high,requested_by,status,responded_at) values
	('85600000-0000-4000-8000-000000000001','85600000-0000-4000-8000-000000000002','85600000-0000-4000-8000-000000000001',
		'accepted',statement_timestamp());

create function pg_temp.as_user(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id = p_user))::text,true)::text::void
$$;
create function pg_temp.as_service()
returns void language sql as $$
	select set_config('request.jwt.claims','{"role":"service_role"}',true)::text::void
$$;
create function pg_temp.refused(p_sql text,p_state text)
returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'expected SQLSTATE % from: %', p_state, p_sql;
exception when others then
	if sqlstate is distinct from p_state then raise exception 'expected SQLSTATE %, got % (%) from: %', p_state, sqlstate, sqlerrm, p_sql; end if;
end $$;

-- 0. Who may call what -------------------------------------------------------------------------------------------------

do $$
declare v_function text;
begin
	-- The lobby's stubs, the creation's internals and the operator's path: no API role.
	foreach v_function in array array['public.qorpera_folder_company_open(uuid,uuid,text)',
		'public.qorpera_folder_company_seed(uuid,jsonb)','public.qorpera_folder_company_ready(uuid)',
		'public.qorpera_folder_company_setup(uuid)','public.qorpera_folder_company_create_request()',
		'public.qorpera_folder_enable_internal(uuid)','public.qorpera_folder_company_first_run(uuid,uuid,uuid,uuid)',
		'public.qorpera_folder_company_creation_requeue(uuid,text)',
		'public.qorpera_folder_company_operator_open(uuid,uuid,text)',
		'public.qorpera_folder_company_operator_start(uuid,text,text)'] loop
		if has_function_privilege('anon',v_function,'EXECUTE') or has_function_privilege('authenticated',v_function,'EXECUTE')
			or has_function_privilege('service_role',v_function,'EXECUTE') then
			raise exception 'An API role can call %', v_function; end if;
	end loop;
	-- The worker's calls: the service role only.
	foreach v_function in array array['public.qorpera_folder_company_creation_claim(uuid,integer)',
		'public.qorpera_folder_company_creation_release(uuid,uuid,bigint,text)',
		'public.qorpera_folder_company_creation_fail(uuid,uuid,bigint,text)',
		'public.qorpera_folder_company_create(uuid,uuid,bigint,jsonb)'] loop
		if has_function_privilege('anon',v_function,'EXECUTE') or has_function_privilege('authenticated',v_function,'EXECUTE')
			or not has_function_privilege('service_role',v_function,'EXECUTE') then
			raise exception '% is not the worker''s call', v_function; end if;
	end loop;
	if has_table_privilege('authenticated','public.qorpera_folder_company_creations','SELECT')
		or has_table_privilege('service_role','public.qorpera_folder_company_creations','SELECT')
		or has_table_privilege('anon','public.qorpera_folder_company_creations','SELECT') then
		raise exception 'The creation rows are readable directly'; end if;
	if public.qorpera_company_founding_available() then raise exception 'Creation is on before C5'; end if;
end $$;
-- The worker's calls refuse anyone but the service role, even with the grant.
select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
select pg_temp.refused($$select public.qorpera_folder_company_creation_claim('85600000-0000-4000-8000-0000000000f1',60)$$,'42501');
select pg_temp.refused($$select public.qorpera_folder_company_create('85600000-0000-4000-8000-0000000000f1',
	'85600000-0000-4000-8000-0000000000f1',1,'[{}]')$$,'42501');

-- The switch, for this test only (C5 turns it on).
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select true
$$;
select pg_temp.as_service();
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
	'supported','enabled',32,null,'folder-company-creation-fixture') \g /dev/null

-- A founder connects their own ChatGPT login to the company (the Settings route), as 705 does.
create function pg_temp.connect_login(p_profile uuid,p_user uuid,p_n integer)
returns void language plpgsql as $$
declare v_identity jsonb; v_login jsonb; v_connection jsonb; v_hex text := lpad(to_hex(p_n),2,'0');
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity(p_profile,('85600000-0000-4000-8000-0000000007' || v_hex)::uuid,
		'My model account','qorpera-member-linux','v1','["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login(p_profile,('85600000-0000-4000-8000-0000000008' || v_hex)::uuid,
		('85600000-0000-4000-8000-0000000009' || v_hex)::uuid,(v_identity ->> 'compute_identity_id')::uuid,
		'openai','codex-cli',repeat(v_hex,32),900);
	reset role;
	perform pg_temp.as_service();
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat(v_hex,32),
		('85600000-0000-4000-8000-000000000a' || v_hex)::uuid,
		'object://native-capsules/85600000-0000-4000-8000-000000000a' || v_hex,repeat('d',64),'openai-' || v_hex,
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
	perform public.qorpera_create_member_execution_sponsor(p_profile,('85600000-0000-4000-8000-000000000b' || v_hex)::uuid,
		(v_connection ->> 'connection_id')::uuid,2,true);
	reset role;
end $$;

-- The seed tree's units, as the worker (P14b) sends them from a claim: the platform stages each file first.
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
-- A reference to bytes nobody stored: the commit refuses it as bytes_unverified, as for an object being deleted.
create function pg_temp.unstored(p_text text) returns jsonb language sql as $$
	select jsonb_build_object('manifestSha256', encode(extensions.digest(convert_to(pg_temp.manifest_v2(p_text), 'utf8'), 'sha256'), 'hex'),
		'fileSha256', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
		'bytes', octet_length(convert_to(p_text, 'utf8')), 'mediaType', 'text/markdown', 'executable', false)
$$;
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
-- p_change: 'none'; 'vision_name' (a parse the hook refuses); 'agent_id' (another Co-Founder id); 'unstored' (the
-- vision's bytes not stored).
create function pg_temp.seed_units(p_claim jsonb, p_change text default 'none') returns jsonb language plpgsql as $$
declare v_env uuid := (p_claim ->> 'environmentId')::uuid; v_input jsonb := p_claim -> 'input';
	v_name text := v_input ->> 'companyName'; v_kickoff text := p_claim ->> 'kickoffRequestedBy';
	v_agent_id text := case when p_change = 'agent_id' then '85600000-0000-4000-8000-0000000000ee' else p_claim ->> 'cofounderId' end;
	v_vision text; v_agent text; v_todo text; v_skill constant text := E'# Writing a human task\n';
	v_sections constant text := E'# Sections\n';
begin
	v_vision := E'# ' || v_name || E'\n\n' || btrim(v_input ->> 'vision') || E'\n\n## What we build\n\n## For whom\n\n## Why\n\n## How we work\n'
		|| (select string_agg('- ' || (f ->> 'displayName') || case when f ->> 'role' is distinct from '' then ': ' || (f ->> 'role') else '' end, E'\n')
			from jsonb_array_elements(v_input -> 'founders') f) || E'\n';
	v_agent := format(E'---\nid: %s\nname: Co-Founder\nrole: Co-Founder\nkind: co-founder\nstatus: active\ncolour: blue\nfigure: crown\n---\nFound the company.\n',
		v_agent_id);
	v_todo := format(E'---\nid: %s\ntitle: Start with the founders\nstatus: open\nrequested-by: %s\n---\nMeet the founders.\n',
		p_claim ->> 'firstTodoId', v_kickoff);
	return jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'),
		jsonb_build_object('op','write','path','vision/vision.md',
			'file', case when p_change = 'unstored' then pg_temp.unstored(v_vision) else pg_temp.stage(v_env, v_vision) end,
			'structured', jsonb_build_array(pg_temp.entry('vision/vision.md', 'vision', v_vision,
				jsonb_build_object('kind','vision','name', case when p_change = 'vision_name' then '' else v_name end)))),
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
					'name','Co-Founder','role','Co-Founder','agentKind','co-founder','status','active','colour','blue','figure','crown',
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

create function pg_temp.creation(p_profile uuid) returns public.qorpera_folder_company_creations language sql as $$
	select * from public.qorpera_folder_company_creations where profile_id = p_profile
$$;
-- Nothing of a creation commit is left: no staff, files, commit, operation key, index row, Co-Founder, first run,
-- kickoff or turn request.
create function pg_temp.nothing_left(p_profile uuid, p_env uuid) returns boolean language sql as $$
	select not (exists (select 1 from public.qorpera_profile_staff where profile_id = p_profile)
		or exists (select 1 from public.qorpera_folder_entries where environment_id = p_env)
		or exists (select 1 from public.qorpera_folder_commits where environment_id = p_env)
		or exists (select 1 from public.qorpera_folder_operation_keys where environment_id = p_env)
		or exists (select 1 from public.qorpera_folder_company_index where environment_id = p_env)
		or exists (select 1 from public.qorpera_company_cofounders where profile_id = p_profile)
		or exists (select 1 from public.qorpera_agent_first_runs where profile_id = p_profile)
		or exists (select 1 from public.qorpera_session_inputs input join public.qorpera_company_rooms room on room.session_id = input.session_id
			where room.profile_id = p_profile)
		or exists (select 1 from public.qorpera_session_turn_requests where profile_id = p_profile))
$$;
create function pg_temp.claim(p_worker uuid) returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	return public.qorpera_folder_company_creation_claim(p_worker, 60);
end $$;
create function pg_temp.create(p_worker uuid, p_claim jsonb, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	return public.qorpera_folder_company_create(p_worker, (p_claim ->> 'creationId')::uuid, (p_claim ->> 'generation')::bigint,
		p_units);
end $$;
create function pg_temp.listed(p_user uuid, p_profile uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v := exists (select 1 from jsonb_array_elements(public.qorpera_list_hosted_profiles()) company
		where company ->> 'profile_id' = p_profile::text);
	reset role;
	return v;
end $$;
create function pg_temp.table_json(p_user uuid, p_profile uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v := public.qorpera_read_company_founding(p_profile);
	reset role;
	return v;
end $$;

-- 1. Open: the company on folder-v2, nothing seeded ---------------------------------------------------------------------

select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.table',(public.qorpera_open_company_founding(
	'85600000-0000-4000-8000-000000000100','  Nordlys Kaffe ') ->> 'profileId'),true);
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_table jsonb;
begin
	-- A repeat gives the same table (open reads the creation request first, so the owner row is not inserted again).
	v_table := public.qorpera_open_company_founding('85600000-0000-4000-8000-000000000100','Nordlys Kaffe');
	if (v_table ->> 'profileId')::uuid is distinct from v_profile then raise exception 'Open is not repeat-safe: %', v_table; end if;
end $$;
-- The same creation id with another name is refused.
select pg_temp.refused($$select public.qorpera_open_company_founding('85600000-0000-4000-8000-000000000100','Other')$$,'23505');
reset role;
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_file public.qorpera_company_files%rowtype;
	v_environment public.qorpera_company_environments%rowtype; v_member public.qorpera_profile_members%rowtype;
begin
	select * into strict v_environment from public.qorpera_company_environments where profile_id = v_profile;
	select * into strict v_file from public.qorpera_company_files where profile_id = v_profile;
	select * into strict v_member from public.qorpera_profile_members where profile_id = v_profile;
	if v_environment.name is distinct from 'Nordlys Kaffe' or v_environment.contract_version is distinct from 2 or v_file.core is distinct from 'folder-v2'
		or v_file.state is distinct from 'ready' or v_file.head_snapshot_id is not null or v_file.environment_id is distinct from v_environment.id then
		raise exception 'Open did not make a folder-v2 company: % %', to_jsonb(v_environment), to_jsonb(v_file); end if;
	if v_member.user_id is distinct from '85600000-0000-4000-8000-000000000001' or v_member.role is distinct from 'owner'
		or v_member.email is distinct from 'anna@example.test' or v_member.display_name is distinct from 'Anna' then
		raise exception 'Open did not make the owner from the account: %', to_jsonb(v_member); end if;
	if not exists (select 1 from public.qorpera_folder_fences where profile_id = v_profile)
		or not exists (select 1 from public.qorpera_folder_admissions where profile_id = v_profile)
		or not exists (select 1 from public.qorpera_folder_clocks where environment_id = v_environment.id and last_seq = 0)
		or (select count(*) from public.qorpera_company_path_resources where environment_id = v_environment.id
			and path in ('','rules')) is distinct from 2 then
		raise exception 'Open did not switch the folder core on'; end if;
	if exists (select 1 from public.qorpera_profile_staff where profile_id = v_profile)
		or exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_profile)
		or exists (select 1 from public.qorpera_company_cofounders where profile_id = v_profile)
		or exists (select 1 from public.qorpera_folder_entries where environment_id = v_environment.id)
		or exists (select 1 from public.qorpera_folder_company_creations where profile_id = v_profile) then
		raise exception 'Open seeded something'; end if;
end $$;

-- A creation id the old path used names a company with a bootstrap job: never a table.
select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_create_cloud_company('85600000-0000-4000-8000-000000000101','Gammel',2) \g /dev/null
select pg_temp.refused($$select public.qorpera_open_company_founding('85600000-0000-4000-8000-000000000101','Gammel')$$,'23505');
reset role;
select set_config('qorpera_test.old',(select profile_id::text from public.qorpera_company_creation_requests
	where client_creation_id = '85600000-0000-4000-8000-000000000101'),true);

-- 2. Start: one creation -----------------------------------------------------------------------------------------------

select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_update_company_founding(current_setting('qorpera_test.table')::uuid,1,'Nordlys Kaffe',
	'Specialty coffee, and wholesale to cafés in Aarhus.') \g /dev/null
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table')::uuid,'85600000-0000-4000-8000-000000000002')
	\g /dev/null
reset role;
select pg_temp.as_user('85600000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table')::uuid,true) \g /dev/null
select public.qorpera_set_founder_role(current_setting('qorpera_test.table')::uuid,3,'Wholesale.') \g /dev/null
reset role;
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,'85600000-0000-4000-8000-000000000001',1);
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,'85600000-0000-4000-8000-000000000002',2);
select pg_temp.as_user('85600000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,4,true) \g /dev/null
reset role;
select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,4,true) \g /dev/null
do $$
declare v_table jsonb := public.qorpera_start_company_founding(current_setting('qorpera_test.table')::uuid,4,
	'85600000-0000-4000-8000-000000000200');
begin
	if v_table -> 'start' ->> 'companySetup' is distinct from 'pending' or (v_table -> 'start' ->> 'companyReady')::boolean is not false then
		raise exception 'A started table shows its company being set up: %', v_table -> 'start'; end if;
	-- A second press changes nothing.
	v_table := public.qorpera_start_company_founding(current_setting('qorpera_test.table')::uuid,4,
		'85600000-0000-4000-8000-000000000200');
	-- Started, but not listed among the companies until it is ready.
	if exists (select 1 from jsonb_array_elements(public.qorpera_list_hosted_profiles()) company
		where company ->> 'profile_id' = current_setting('qorpera_test.table')) then
		raise exception 'A company being set up is listed'; end if;
	if jsonb_array_length(public.qorpera_list_company_foundings()) is distinct from 1 then
		raise exception 'The starting table is not listed for its founder'; end if;
end $$;
reset role;
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid;
	v_creation public.qorpera_folder_company_creations := pg_temp.creation(current_setting('qorpera_test.table')::uuid);
begin
	if (select count(*) from public.qorpera_folder_company_creations where profile_id = v_profile) is distinct from 1
		or v_creation.state is distinct from 'queued' or v_creation.kickoff_user_id is distinct from '85600000-0000-4000-8000-000000000001'
		or v_creation.environment_id is distinct from (select environment_id from public.qorpera_company_files where profile_id = v_profile)
		or v_creation.input ->> 'schema' is distinct from 'qorpera.company-seed-input/v1' or v_creation.input ->> 'companyName' is distinct from 'Nordlys Kaffe'
		or v_creation.input ->> 'vision' is distinct from 'Specialty coffee, and wholesale to cafés in Aarhus.'
		or v_creation.input -> 'founders' is distinct from '[{"userId":"85600000-0000-4000-8000-000000000001","displayName":"Anna","role":""},
			{"userId":"85600000-0000-4000-8000-000000000002","displayName":"Bo","role":"Wholesale."}]'::jsonb
		or v_creation.generation is distinct from 0 or v_creation.attempts is distinct from 0 then
		raise exception 'Start did not record one creation: %', to_jsonb(v_creation); end if;
	-- Version-4 ids, made once (every client checks the version and variant digits).
	if v_creation.cofounder_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or v_creation.first_todo_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or v_creation.cofounder_id = v_creation.first_todo_id then
		raise exception 'The seed ids are not version-4 UUIDs: %', to_jsonb(v_creation); end if;
	-- Seed again: the same row (the safety net).
	if public.qorpera_folder_company_seed(v_profile, v_creation.input) is distinct from v_creation.id then
		raise exception 'A second seed made another creation'; end if;
	if public.qorpera_folder_company_ready(v_profile) then raise exception 'A queued creation is ready'; end if;
end $$;

-- Seed's checks, on a second company opened directly (the owner role, as the operator's path calls it).
select set_config('qorpera_test.second',(public.qorpera_folder_company_open('85600000-0000-4000-8000-000000000003',
	'85600000-0000-4000-8000-000000000102','Cykelværkstedet') ->> 'profile_id'),true);
create function pg_temp.seed_input(p_change jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.company-seed-input/v1','companyName','Cykelværkstedet','vision','Repairs.',
		'kickoffRequestedBy','85600000-0000-4000-8000-000000000003',
		'founders','[{"userId":"85600000-0000-4000-8000-000000000003","displayName":"Cy","role":""}]'::jsonb) || p_change
$$;
do $$
declare v_bad jsonb;
begin
	foreach v_bad in array array[
		'{"schema":"qorpera.company-seed-input/v2"}', '{"companyName":"Other"}', '{"companyName":null}',
		jsonb_build_object('vision', repeat('x', 16385)), '{"vision":null}', '{"kickoffRequestedBy":"nobody"}',
		'{"kickoffRequestedBy":"85600000-0000-4000-8000-000000000001"}', '{"founders":[]}',
		'{"founders":[{"userId":"85600000-0000-4000-8000-000000000001","displayName":"Anna","role":""}]}',
		'{"founders":[{"userId":"85600000-0000-4000-8000-000000000003","displayName":"Cy"}]}',
		jsonb_build_object('founders', jsonb_build_array(jsonb_build_object('userId','85600000-0000-4000-8000-000000000003',
			'displayName','Cy','role',repeat('r',301)))),
		'{"founders":[{"userId":"85600000-0000-4000-8000-000000000003","displayName":"Cy","role":""},{"userId":"85600000-0000-4000-8000-000000000003","displayName":"Cy","role":""}]}',
		'{"extra":1}']::jsonb[] loop
		begin
			perform public.qorpera_folder_company_seed(current_setting('qorpera_test.second')::uuid, pg_temp.seed_input(v_bad));
			raise exception 'Seed took a bad input: %', v_bad using errcode = 'QTF01';
		exception when sqlstate '22023' then null;
		end;
	end loop;
	-- A snapshot-v1 company (the old chain) is never seeded.
	begin
		perform public.qorpera_folder_company_seed(current_setting('qorpera_test.old')::uuid, pg_temp.seed_input());
		raise exception 'Seed took a snapshot-v1 company' using errcode = 'QTF01';
	exception when sqlstate '42501' then null;
	end;
	if exists (select 1 from public.qorpera_folder_company_creations
		where profile_id in (current_setting('qorpera_test.second')::uuid, current_setting('qorpera_test.old')::uuid)) then
		raise exception 'A refused seed wrote a creation'; end if;
end $$;
-- Cy's company: seeded without a usable login (the kickoff then stays pending, §3).
select public.qorpera_folder_company_seed(current_setting('qorpera_test.second')::uuid, pg_temp.seed_input()) \g /dev/null

-- 3. Claim, a stale lease, and the creation ---------------------------------------------------------------------------

do $$
declare v_claim jsonb; v_other jsonb; v_creation public.qorpera_folder_company_creations;
	v_profile uuid := current_setting('qorpera_test.table')::uuid; v_result jsonb;
begin
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f1');
	v_creation := pg_temp.creation(v_profile);
	if v_claim ->> 'creationId' is distinct from v_creation.id::text or v_claim ->> 'operationKey' is distinct from 'company-create:' || v_creation.id
		or (v_claim ->> 'generation')::bigint is distinct from 1 or (v_claim ->> 'attempt')::integer is distinct from 1
		or v_claim ->> 'cofounderId' is distinct from v_creation.cofounder_id::text or v_claim ->> 'firstTodoId' is distinct from v_creation.first_todo_id::text
		or v_claim ->> 'kickoffRequestedBy' is distinct from '85600000-0000-4000-8000-000000000001' or v_claim -> 'input' is distinct from v_creation.input
		or v_creation.state is distinct from 'leased' or v_creation.lease_owner is distinct from '85600000-0000-4000-8000-0000000000f1' then
		raise exception 'The claim does not carry the creation: % %', v_claim, to_jsonb(v_creation); end if;
	-- The next claim takes the other company (oldest first); then nothing is due.
	v_other := pg_temp.claim('85600000-0000-4000-8000-0000000000f2');
	if v_other ->> 'profileId' is distinct from current_setting('qorpera_test.second') then raise exception 'Claim order: %', v_other; end if;
	if pg_temp.claim('85600000-0000-4000-8000-0000000000f2') is not null then raise exception 'A leased creation was claimed'; end if;
	perform set_config('qorpera_test.claim', v_claim::text, true);
	perform set_config('qorpera_test.claim2', v_other::text, true);
	-- Another worker, or an old generation, is stale: nothing changes.
	v_result := public.qorpera_folder_company_create('85600000-0000-4000-8000-0000000000f2', v_creation.id, 1, '[{}]');
	if v_result ->> 'state' is distinct from 'stale' then raise exception 'Another worker''s create: %', v_result; end if;
	v_result := public.qorpera_folder_company_create('85600000-0000-4000-8000-0000000000f1', v_creation.id, 7, '[{}]');
	if v_result ->> 'state' is distinct from 'stale' then raise exception 'An old generation''s create: %', v_result; end if;
	if (public.qorpera_folder_company_creation_release('85600000-0000-4000-8000-0000000000f2', v_creation.id, 1, 'x')
		->> 'released')::boolean is not false then raise exception 'Another worker released the lease'; end if;
end $$;

-- A unit whose bytes are not stored: retry, and nothing of the commit stays.
do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_result jsonb;
	v_creation public.qorpera_folder_company_creations;
begin
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f1', v_claim, pg_temp.seed_units(v_claim, 'unstored'));
	v_creation := pg_temp.creation((v_claim ->> 'profileId')::uuid);
	if v_result ->> 'state' is distinct from 'retry' or v_result ->> 'problem' is distinct from 'bytes_unverified' or v_creation.state is distinct from 'leased'
		or v_creation.last_problem is distinct from 'bytes_unverified' then
		raise exception 'Unstored bytes do not answer retry: % %', v_result, to_jsonb(v_creation); end if;
	if not pg_temp.nothing_left(v_creation.profile_id, v_creation.environment_id) then
		raise exception 'A retried creation left something behind'; end if;
	if coalesce(current_setting('qorpera.folder_company_create', true), '') is distinct from '' then
		raise exception 'The creation setting outlived its answer'; end if;
end $$;

-- The creation itself.
do $$
declare v_claim jsonb := current_setting('qorpera_test.claim')::jsonb; v_result jsonb; v_replay jsonb;
	v_creation public.qorpera_folder_company_creations; v_staff public.qorpera_profile_staff;
	v_first public.qorpera_agent_first_runs; v_input public.qorpera_session_inputs; v_request public.qorpera_session_turn_requests;
	v_profile uuid := (v_claim ->> 'profileId')::uuid; v_env uuid := (v_claim ->> 'environmentId')::uuid;
	v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid; v_thread uuid;
begin
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f1', v_claim, pg_temp.seed_units(v_claim));
	v_creation := pg_temp.creation(v_profile);
	if v_result ->> 'state' is distinct from 'completed' or v_creation.state is distinct from 'completed' or v_creation.input is not null
		or v_creation.commit_id::text is distinct from v_result ->> 'commitId' or v_creation.lease_owner is not null
		or v_creation.result is distinct from v_result or (v_result ->> 'replay')::boolean is not false
		or not exists (select 1 from public.qorpera_folder_commits where id = v_creation.commit_id and actor_kind = 'platform'
			and operation_key = 'company-create:' || v_creation.id and seq is not null) then
		raise exception 'The creation did not complete: % %', v_result, to_jsonb(v_creation); end if;
	if coalesce(current_setting('qorpera.folder_company_create', true), '') is distinct from '' then
		raise exception 'The creation setting outlived its answer'; end if;
	-- The files: the vision indexed and seeded, the Co-Founder, its first todo.
	if (select name from public.qorpera_folder_company_index where environment_id = v_env) is distinct from 'Nordlys Kaffe'
		or not (select vision_seeded from public.qorpera_folder_company_index where environment_id = v_env) then
		raise exception 'The vision is not indexed as seeded'; end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = v_cofounder;
	if v_staff.template_id is distinct from 'co-founder' or v_staff.folder_path is distinct from 'agents/co-founder/agent.md'
		or (select count(*) from public.qorpera_profile_staff where profile_id = v_profile) is distinct from 1
		or not exists (select 1 from public.qorpera_company_cofounders where profile_id = v_profile and staff_agent_id = v_cofounder
			and formation_id is null) then
		raise exception 'The creation did not record its Co-Founder: %', to_jsonb(v_staff); end if;
	if not exists (select 1 from public.qorpera_runtime_agent_todos where profile_id = v_profile
		and id = (v_claim ->> 'firstTodoId')::uuid) then
		raise exception 'The first todo is not indexed'; end if;
	-- The thread, with both founders in it.
	select room.session_id into v_thread from public.qorpera_company_rooms as room
	where room.profile_id = v_profile and room.bound_staff_agent_id = v_cofounder and room.status = 'active';
	if v_thread is null or (select count(*) from public.qorpera_company_room_members m join public.qorpera_company_rooms r on r.id = m.room_id
		where r.session_id = v_thread and m.principal_kind = 'member' and m.status = 'active') is distinct from 2 then
		raise exception 'The Co-Founder''s thread is missing or lacks a founder'; end if;
	-- The kickoff: the seam C4 (P28) builds on.
	select * into strict v_first from public.qorpera_agent_first_runs where profile_id = v_profile and staff_agent_id = v_cofounder;
	select * into strict v_input from public.qorpera_session_inputs where id = v_first.input_id;
	if v_input.session_id is distinct from v_thread or v_input.kind is distinct from 'kickoff' or v_input.actor_kind is distinct from 'control_plane'
		or v_input.author_user_id is distinct from '85600000-0000-4000-8000-000000000001'
		or v_input.client_input_id is distinct from md5('qorpera.folder-company-create/kickoff:' || v_creation.id)::uuid
		or v_input.body is distinct from jsonb_build_object('schema','qorpera.company-first-run/v1','assignment',jsonb_build_object(
			'kind','company_founding','companyId',v_profile,'creationId',v_creation.id,'cofounderStaffAgentId',v_cofounder,
			'firstTodo','agents/co-founder/todos/start-with-the-founders.md'))
		or v_input.completed_at is not null or v_input.execution_run_id is not null then
		raise exception 'The kickoff is not the agreed shape: %', to_jsonb(v_input); end if;
	if v_first.session_id is distinct from v_thread or v_first.environment_id is distinct from v_env or v_first.startup_assignment is distinct from v_input.body
		or v_first.source_path_version is distinct from (select version from public.qorpera_folder_entries where environment_id = v_env
			and key_text = 'agents/co-founder/agent.md') then
		raise exception 'The first-run row does not match: %', to_jsonb(v_first); end if;
	if (select count(*) from public.qorpera_session_inputs where session_id = v_thread) is distinct from 1 then
		raise exception 'More than the kickoff in the thread'; end if;
	-- Anna's login pays: the turn request is queued on it.
	select * into strict v_request from public.qorpera_session_turn_requests where input_id = v_input.id;
	if v_request.status is distinct from 'queued' or v_request.requested_by_user_id is distinct from '85600000-0000-4000-8000-000000000001'
		or v_request.sponsored_by_user_id is distinct from '85600000-0000-4000-8000-000000000001'
		or v_request.sponsor_mode is distinct from 'member_connection'
		or v_request.initial_execution_selection ->> 'reason' is distinct from 'agent_first_run' then
		raise exception 'The first run''s turn request is not Anna''s: %', to_jsonb(v_request); end if;
	-- No wake at creation: C4 (P28) materializes it.
	if exists (select 1 from public.qorpera_wake_occurrences where profile_id = v_profile) then
		raise exception 'The creation wrote a wake'; end if;
	-- A replay answers the stored result and writes nothing.
	v_replay := pg_temp.create('85600000-0000-4000-8000-0000000000f1', v_claim, pg_temp.seed_units(v_claim));
	if v_replay is distinct from v_result || '{"replay":true}' or (select count(*) from public.qorpera_session_inputs where session_id = v_thread) is distinct from 1 then
		raise exception 'A replay is not the stored result: %', v_replay; end if;
end $$;

-- Ready: the founders' table, the hub, the setup state.
do $$
declare v_profile uuid := current_setting('qorpera_test.table')::uuid; v_table jsonb;
begin
	if not public.qorpera_folder_company_ready(v_profile) then raise exception 'A completed creation is not ready'; end if;
	v_table := pg_temp.table_json('85600000-0000-4000-8000-000000000002', v_profile);
	if v_table -> 'start' ->> 'companySetup' is distinct from 'ready' or (v_table -> 'start' ->> 'companyReady')::boolean is not true then
		raise exception 'The table does not show the company ready: %', v_table -> 'start'; end if;
	if not pg_temp.listed('85600000-0000-4000-8000-000000000001', v_profile)
		or not pg_temp.listed('85600000-0000-4000-8000-000000000002', v_profile) then
		raise exception 'A ready company is not listed for its founders'; end if;
end $$;

-- 4. No usable login: the kickoff stays pending -----------------------------------------------------------------------

do $$
declare v_claim jsonb := current_setting('qorpera_test.claim2')::jsonb; v_result jsonb; v_first public.qorpera_agent_first_runs;
begin
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f2', v_claim, pg_temp.seed_units(v_claim));
	select * into strict v_first from public.qorpera_agent_first_runs where profile_id = (v_claim ->> 'profileId')::uuid;
	if v_result ->> 'state' is distinct from 'completed'
		or exists (select 1 from public.qorpera_session_turn_requests where input_id = v_first.input_id)
		or (select author_user_id from public.qorpera_session_inputs where id = v_first.input_id) is distinct from '85600000-0000-4000-8000-000000000003' then
		raise exception 'Without a usable login the kickoff stays pending: %', v_result; end if;
	-- A company opened outside the lobby is listed for its owner once ready.
	if not pg_temp.listed('85600000-0000-4000-8000-000000000003', (v_claim ->> 'profileId')::uuid) then
		raise exception 'A ready company opened directly is not listed'; end if;
end $$;

-- 5. Final refusals, the worker's failure, and the requeue --------------------------------------------------------------

-- Three more companies, opened and seeded directly (Cy owns them).
create function pg_temp.open_seeded(p_n integer, p_name text) returns uuid language plpgsql as $$
declare v_profile uuid;
begin
	v_profile := (public.qorpera_folder_company_open('85600000-0000-4000-8000-000000000003',
		('85600000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0'))::uuid, p_name) ->> 'profile_id')::uuid;
	perform public.qorpera_folder_company_seed(v_profile, pg_temp.seed_input(jsonb_build_object('companyName', p_name)));
	return v_profile;
end $$;
do $$
declare v_profile uuid; v_claim jsonb; v_result jsonb; v_creation public.qorpera_folder_company_creations; v_table jsonb;
begin
	-- A parse the hook refuses: failed, with the outcomes kept and nothing of the commit.
	v_profile := pg_temp.open_seeded(10, 'Refused');
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f3');
	if (v_claim ->> 'profileId')::uuid is distinct from v_profile then raise exception 'Claim order: %', v_claim; end if;
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f3', v_claim, pg_temp.seed_units(v_claim, 'vision_name'));
	v_creation := pg_temp.creation(v_profile);
	if v_result ->> 'state' is distinct from 'failed' or v_result ->> 'problem' is distinct from 'refused' or v_creation.state is distinct from 'failed'
		or v_creation.failure ->> 'code' is distinct from 'refused'
		or jsonb_array_length(v_creation.failure -> 'units') is distinct from 1
		or v_creation.failure -> 'units' -> 0 ->> 'unit' is distinct from '2'
		or v_creation.failure -> 'units' -> 0 ->> 'reason' is distinct from 'structured_invalid'
		or v_creation.input is null or v_creation.lease_owner is not null
		or not pg_temp.nothing_left(v_profile, v_creation.environment_id) then
		raise exception 'A refused unit does not fail the creation: % %', v_result, to_jsonb(v_creation); end if;
	if coalesce(current_setting('qorpera.folder_company_create', true), '') is distinct from '' then
		raise exception 'The creation setting outlived a failed answer'; end if;
	if public.qorpera_folder_company_setup(v_profile) is distinct from 'failed' or public.qorpera_folder_company_ready(v_profile)
		or pg_temp.listed('85600000-0000-4000-8000-000000000003', v_profile) then
		raise exception 'A failed creation is not shown failed and hidden'; end if;
	-- Requeued by the operator after the cause is fixed: due again at once, the reason kept.
	perform public.qorpera_folder_company_creation_requeue(v_creation.id, 'Parser fixed');
	v_creation := pg_temp.creation(v_profile);
	if v_creation.state is distinct from 'queued' or v_creation.failure is not null or v_creation.operator_reason is distinct from 'Parser fixed'
		or v_creation.attempts is distinct from 0 then
		raise exception 'The requeue did not queue it: %', to_jsonb(v_creation); end if;
	begin
		perform public.qorpera_folder_company_creation_requeue(v_creation.id, 'Again');
		raise exception 'A queued creation was requeued' using errcode = 'QTF01';
	exception when sqlstate '55000' then null;
	end;
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f3');
	if (v_claim ->> 'generation')::bigint is distinct from 2 then raise exception 'The requeued creation is not claimed again: %', v_claim; end if;
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f3', v_claim, pg_temp.seed_units(v_claim));
	if v_result ->> 'state' is distinct from 'completed' then raise exception 'A requeued creation did not complete: %', v_result; end if;

	-- An agent.md that is not the row's Co-Founder: every unit saves, but no first run, so failed and rolled back.
	v_profile := pg_temp.open_seeded(11, 'Mismatch');
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f4');
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f4', v_claim, pg_temp.seed_units(v_claim, 'agent_id'));
	v_creation := pg_temp.creation(v_profile);
	if v_result ->> 'state' is distinct from 'failed' or v_creation.failure ->> 'code' is distinct from 'cofounder_mismatch'
		or not pg_temp.nothing_left(v_profile, v_creation.environment_id) then
		raise exception 'Another Co-Founder id does not fail the creation: % %', v_result, to_jsonb(v_creation); end if;

	-- The worker's own final failure, and its back-off release.
	v_profile := pg_temp.open_seeded(12, 'Worker');
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f5');
	v_result := public.qorpera_folder_company_creation_release('85600000-0000-4000-8000-0000000000f5',
		(v_claim ->> 'creationId')::uuid, 1, 'stage_incomplete');
	v_creation := pg_temp.creation(v_profile);
	if (v_result ->> 'released')::boolean is not true or v_creation.state is distinct from 'queued' or v_creation.last_problem is distinct from 'stage_incomplete'
		or v_creation.not_before <= clock_timestamp() or v_creation.not_before > clock_timestamp() + interval '3 seconds' then
		raise exception 'The release does not back off: %', to_jsonb(v_creation); end if;
	if pg_temp.claim('85600000-0000-4000-8000-0000000000f5') is not null then raise exception 'A creation in back-off was claimed'; end if;
	update public.qorpera_folder_company_creations set not_before = null where profile_id = v_profile;
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f5');
	v_result := public.qorpera_folder_company_creation_fail('85600000-0000-4000-8000-0000000000f5',
		(v_claim ->> 'creationId')::uuid, 2, 'stage_invalid');
	v_creation := pg_temp.creation(v_profile);
	if (v_result ->> 'failed')::boolean is not true or v_creation.state is distinct from 'failed'
		or v_creation.failure is distinct from '{"code":"stage_invalid","by":"worker"}' or v_creation.attempts is distinct from 2 then
		raise exception 'The worker''s failure is not kept: %', to_jsonb(v_creation); end if;
end $$;

-- A paused company: the create raises 55000 (the worker backs off) and the row stays leased; resumed, it completes.
do $$
declare v_profile uuid := pg_temp.open_seeded(15, 'Paused'); v_claim jsonb; v_creation public.qorpera_folder_company_creations;
	v_units jsonb; v_result jsonb;
begin
	v_claim := pg_temp.claim('85600000-0000-4000-8000-0000000000f7');
	v_units := pg_temp.seed_units(v_claim);
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values (v_profile, '85600000-0000-4000-8000-000000000003', 'Fixture pause');
	begin
		perform pg_temp.create('85600000-0000-4000-8000-0000000000f7', v_claim, v_units);
		raise exception 'A paused company was created' using errcode = 'QTF01';
	exception when sqlstate '55000' then null;
	end;
	v_creation := pg_temp.creation(v_profile);
	if v_creation.state is distinct from 'leased' or not pg_temp.nothing_left(v_profile, v_creation.environment_id) then
		raise exception 'A paused creation changed: %', to_jsonb(v_creation); end if;
	delete from public.qorpera_company_execution_pauses where profile_id = v_profile;
	v_result := pg_temp.create('85600000-0000-4000-8000-0000000000f7', v_claim, v_units);
	if v_result ->> 'state' is distinct from 'completed' then raise exception 'A resumed creation: %', v_result; end if;
end $$;

-- The answers before the commit: the old chain, a Co-Founder already recorded, the kickoff member gone. Each is final,
-- nothing is committed, and the setting is clear. (Rows made by hand, triggers off: none of these can arise through
-- the API since seed and the bootstrap refuse them.)
do $$
declare v_case text; v_n integer := 16; v_profile uuid; v_claim jsonb; v_result jsonb; v_creation public.qorpera_folder_company_creations;
	v_env uuid;
begin
	foreach v_case in array array['old_chain', 'cofounder_exists', 'kickoff_member_left'] loop
		v_profile := pg_temp.open_seeded(v_n, 'Before ' || v_n);
		v_claim := pg_temp.claim(('85600000-0000-4000-8000-0000000000' || v_n)::uuid);
		v_env := (v_claim ->> 'environmentId')::uuid;
		set local session_replication_role = replica;
		if v_case = 'old_chain' then
			insert into public.qorpera_company_bootstrap_jobs(profile_id, environment_id, created_by_user_id, cofounder_staff_agent_id,
				formation_id, member_session_id, formation_document, cofounder_agent_document, hidden_until_ready, first_run_required)
			values (v_profile, v_env, '85600000-0000-4000-8000-000000000003', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
				extensions.gen_random_uuid(), '{}', '{}', true, true);
		elsif v_case = 'cofounder_exists' then
			insert into public.qorpera_company_cofounders(profile_id, environment_id, staff_agent_id, formation_id, created_by_user_id)
			values (v_profile, v_env, extensions.gen_random_uuid(), null, '85600000-0000-4000-8000-000000000003');
		else
			delete from public.qorpera_profile_members where profile_id = v_profile;
		end if;
		set local session_replication_role = origin;
		v_result := pg_temp.create(('85600000-0000-4000-8000-0000000000' || v_n)::uuid, v_claim, pg_temp.seed_units(v_claim));
		v_creation := pg_temp.creation(v_profile);
		if v_result ->> 'state' is distinct from 'failed' or v_result ->> 'problem' is distinct from v_case
			or v_creation.failure ->> 'code' is distinct from v_case
			or exists (select 1 from public.qorpera_folder_commits where environment_id = v_env)
			or coalesce(current_setting('qorpera.folder_company_create', true), '') is distinct from '' then
			raise exception 'The % answer: % %', v_case, v_result, to_jsonb(v_creation); end if;
		v_n := v_n + 1;
	end loop;
end $$;

-- 6. The guards -----------------------------------------------------------------------------------------------------------

-- The member who started a creation stays until it is made; another owner may go.
do $$
declare v_profile uuid := pg_temp.open_seeded(13, 'Departure'); v_creation public.qorpera_folder_company_creations;
begin
	v_creation := pg_temp.creation(v_profile);
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
		(v_profile,'85600000-0000-4000-8000-000000000001','anna@example.test','Anna','owner'),
		(v_profile,'85600000-0000-4000-8000-000000000002','bo@example.test','Bo','owner');
	begin
		delete from public.qorpera_profile_members where profile_id = v_profile and user_id = '85600000-0000-4000-8000-000000000003';
		raise exception 'The kickoff member left during the creation' using errcode = 'QTF01';
	exception when sqlstate '42501' then null;
	end;
	begin
		update public.qorpera_profile_members set role = 'admin'
		where profile_id = v_profile and user_id = '85600000-0000-4000-8000-000000000003';
		raise exception 'The kickoff member stepped down during the creation' using errcode = 'QTF01';
	exception when sqlstate '42501' then null;
	end;
	perform pg_temp.as_user('85600000-0000-4000-8000-000000000003');
	if (public.qorpera_profile_team_info(v_profile) -> 'capabilities' ->> 'leave')::boolean is not false then
		raise exception 'The team page offers leave to the kickoff member during the creation'; end if;
	perform pg_temp.as_user('85600000-0000-4000-8000-000000000002');
	if (public.qorpera_profile_team_info(v_profile) -> 'capabilities' ->> 'leave')::boolean is not true then
		raise exception 'The team page refuses leave to another owner'; end if;
	delete from public.qorpera_profile_members where profile_id = v_profile and user_id = '85600000-0000-4000-8000-000000000002';
	-- A failed creation holds nobody.
	update public.qorpera_folder_company_creations set state = 'failed', failure = '{"code":"test"}' where id = v_creation.id;
	delete from public.qorpera_profile_members where profile_id = v_profile and user_id = '85600000-0000-4000-8000-000000000003';
	-- Nor can it be queued again once that member has gone.
	begin
		perform public.qorpera_folder_company_creation_requeue(v_creation.id, 'Retry');
		raise exception 'A creation whose member left was requeued' using errcode = 'QTF01';
	exception when sqlstate '55000' then null;
	end;
	perform pg_temp.as_service();
end $$;

-- The old chain on a folder-v2 company, and the folder core on a company the old chain started.
select pg_temp.refused(format($$select public.qorpera_enqueue_company_bootstrap(%L,true)$$,
	current_setting('qorpera_test.second')),'55000');
select pg_temp.as_service();
select pg_temp.refused(format($$select public.qorpera_folder_enable(%L)$$,
	(select id from public.qorpera_company_environments where profile_id = current_setting('qorpera_test.old')::uuid)),'55000');
select pg_temp.as_user('85600000-0000-4000-8000-000000000001');
select pg_temp.refused(format($$select public.qorpera_folder_enable(%L)$$,
	(select id from public.qorpera_company_environments where profile_id = current_setting('qorpera_test.old')::uuid)),'42501');

-- A company deleted before its creation ran: blocked, never claimed, and a worker's create is stale.
do $$
declare v_profile uuid := pg_temp.open_seeded(14, 'Deleted'); v_creation public.qorpera_folder_company_creations;
	v_result jsonb;
begin
	perform public.qorpera_request_company_deletion(v_profile, '85600000-0000-4000-8000-000000000003');
	v_creation := pg_temp.creation(v_profile);
	if v_creation.state is distinct from 'blocked' then raise exception 'Delete did not block the creation: %', to_jsonb(v_creation); end if;
	if pg_temp.claim('85600000-0000-4000-8000-0000000000f6') ->> 'profileId' = v_profile::text then
		raise exception 'A blocked creation was claimed'; end if;
	v_result := public.qorpera_folder_company_create('85600000-0000-4000-8000-0000000000f6', v_creation.id, 1, '[{}]');
	if v_result ->> 'state' is distinct from 'stale' then raise exception 'A blocked creation was made: %', v_result; end if;
	begin
		perform public.qorpera_folder_company_creation_requeue(v_creation.id, 'Retry');
		raise exception 'A blocked creation was requeued' using errcode = 'QTF01';
	exception when sqlstate '55000' then null;
	end;
end $$;

-- 7. Snapshot-v1 keeps its text: each body with its patch reversed is the definition before this migration -----------

do $$
declare v_case record; v_definition text;
begin
	for v_case in select * from (values
		('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)',
			$n$				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
				-- 20260930010000 (P14a): inside a creation, the first run of the creation's own Co-Founder.
				perform public.qorpera_folder_company_first_run(p_environment_id, p_commit_id, (v_entry -> 'parse' ->> 'id')::uuid,
					v_version);
$n$,
			$o$				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
$o$,
			'9bbc1e5e8784ac576bdd90bbe0b1d03b'),
		('public.qorpera_list_hosted_profiles()',
			$n$		and not exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = profile.id)
		-- 20260930010000 (P14a): a folder-v2 company shows once its creation is completed.
		and (not exists (select 1 from public.qorpera_company_files as file where file.profile_id = profile.id and file.core = 'folder-v2')
			or exists (select 1 from public.qorpera_folder_company_creations as creation where creation.profile_id = profile.id
				and creation.state = 'completed'))
$n$,
			$o$		and not exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = profile.id)
$o$,
			'42227354f79c284a0e59719e4b7957f5'),
		('public.qorpera_guard_founder_departure()',
			$n$		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	-- 20260930010000 (P14a): so does a folder-v2 creation, for the member who started it.
	if exists (select 1 from public.qorpera_folder_company_creations as creation
		where creation.profile_id = old.profile_id and creation.kickoff_user_id = old.user_id
			and creation.state in ('queued', 'leased')) then
		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	return coalesce(new, old);
$n$,
			$o$		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	return coalesce(new, old);
$o$,
			'107578f7d129849f06f64e9c6f1079e7'),
		('public.qorpera_profile_team_info(uuid)',
			$n$					where job.profile_id = p_profile_id and job.created_by_user_id = auth.uid()
						and job.state in ('queued', 'leased'))
				-- 20260930010000 (P14a): nor a folder-v2 creation.
				and not exists (select 1 from public.qorpera_folder_company_creations as creation
					where creation.profile_id = p_profile_id and creation.kickoff_user_id = auth.uid()
						and creation.state in ('queued', 'leased')),
$n$,
			$o$					where job.profile_id = p_profile_id and job.created_by_user_id = auth.uid()
						and job.state in ('queued', 'leased')),
$o$,
			'847a09a707ce895c5aca913418d96ff1'),
		('public.qorpera_stop_company_work(uuid)',
			$n$	where profile_id = p_profile_id and state in ('queued', 'leased');
	-- 20260930010000 (P14a): a folder-v2 creation not yet made is blocked. One a worker holds now (its row sits before
	-- the fence) is skipped: it refuses after its fence (the pause covers a deletion) or completes, and the finisher's next
	-- pass marks it. A release never turns blocked back into queued.
	update public.qorpera_folder_company_creations
	set state = 'blocked', lease_owner = null, lease_until = null, input = null, last_problem = 'company_deleted',
		updated_at = clock_timestamp()
	where id in (select creation.id from public.qorpera_folder_company_creations as creation
		where creation.profile_id = p_profile_id and creation.state in ('queued', 'leased') for update skip locked);

	-- Coding:$n$,
			$o$	where profile_id = p_profile_id and state in ('queued', 'leased');

	-- Coding:$o$,
			'9485f077055b7b316ced0c28ef47d0fb'),
		('public.qorpera_enqueue_company_bootstrap(uuid,boolean)',
			$n$	v_job public.qorpera_company_bootstrap_jobs%rowtype; v_owner uuid;
begin
	-- 20260930010000 (P14a): a folder-v2 company never runs the old chain.
	if public.qorpera_company_is_folder_v2(p_profile_id) then
		raise exception 'The folder core sets this company up' using errcode = '55000'; end if;
$n$,
			$o$	v_job public.qorpera_company_bootstrap_jobs%rowtype; v_owner uuid;
begin
$o$,
			'2db1d98ee2066cda83f8c41743f86c65'),
		('public.qorpera_company_founding_json(uuid)',
			$n$'companyReady',public.qorpera_folder_company_ready(p_profile_id),
			-- 20260930010000 (P14a): pending, ready or failed.
			'companySetup',public.qorpera_folder_company_setup(p_profile_id)) end);$n$,
			$o$'companyReady',public.qorpera_folder_company_ready(p_profile_id)) end);$o$,
			'ea4506f6503174c2d7a28f904afacb4f')) as c(signature, inserted, original, md5) loop
		v_definition := pg_get_functiondef(v_case.signature::regprocedure);
		if position(v_case.inserted in v_definition) = 0
			or md5(replace(v_definition, v_case.inserted, v_case.original)) <> v_case.md5 then
			raise exception 'The patch of % is not the only change', v_case.signature; end if;
	end loop;
	-- qorpera_folder_enable is replaced whole: a role check around the internal body.
	if position('20260930010000' in pg_get_functiondef('public.qorpera_folder_enable(uuid)'::regprocedure)) = 0
		or position('qorpera_folder_enable_internal(p_environment_id)' in pg_get_functiondef('public.qorpera_folder_enable(uuid)'::regprocedure)) = 0 then
		raise exception 'qorpera_folder_enable is not the wrapper'; end if;
end $$;

rollback;
