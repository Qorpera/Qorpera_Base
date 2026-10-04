-- @fixture 708_folder_state_routines.test.sql until "-- 1. The company and two agents"
-- Company folder core C2, P15 (migration 20260930022000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md "Plan (P15)"):
-- the follow-up queue. A commit only marks what changed; a step (pg_cron, every 2 seconds) converges one marked subject
-- to the current state in its own transaction: a hire's default grant, connectors and first run; an archive's routines,
-- vault grants, execution authority and sessions; the company's name. Races are in 878, guards and the schedule in 879.

-- A commit that leaves its marks for the step (the fixture's pg_temp.commit runs the queue at once).
create function pg_temp.save(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('70700000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70700000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
-- The step as its job runs it: the database owner, with no JWT. Answers what it converged (null: nothing).
create function pg_temp.step() returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform set_config('request.jwt.claims', '', true);
	v := public.qorpera_folder_follow_up_step();
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if v ->> 'schema' is distinct from 'qorpera.folder-follow-up-step/v1' then raise exception 'The step answered %', v; end if;
	return nullif(v -> 'converged', 'null'::jsonb);
end $$;
-- Steps until one converges nothing: what each converged, in order.
create function pg_temp.drain() returns jsonb language plpgsql as $$
declare v jsonb; v_all jsonb := '[]'; i integer;
begin
	for i in 1..30 loop
		v := pg_temp.step();
		exit when v is null;
		v_all := v_all || jsonb_build_array(v);
	end loop;
	return v_all;
end $$;
create function pg_temp.work(p_id uuid, p_kind text default 'agent') returns public.qorpera_folder_follow_ups language sql as $$
	select * from public.qorpera_folder_follow_ups where environment_id = '70700000-0000-4000-8000-000000000020'
		and subject_kind = p_kind and subject_id = p_id
$$;
create function pg_temp.marked(p_id uuid, p_kind text default 'agent') returns bigint language sql as $$
	select count(*) from public.qorpera_folder_follow_up_marks where environment_id = '70700000-0000-4000-8000-000000000020'
		and subject_kind = p_kind and subject_id = p_id
$$;
-- An agent.md saved with a status, over the version read (the agent's name is its handle).
create function pg_temp.agent(p_handle text, p_id uuid, p_status text) returns jsonb language sql as $$
	select pg_temp.write('agents/' || p_handle || '/agent.md', 'agent', pg_temp.agent_text(p_id, p_handle, 'agent', p_status),
		pg_temp.agent_parse(p_id, p_handle, 'agent', p_status), pg_temp.version('agents/' || p_handle || '/agent.md'))
$$;
-- A hire saved with a status (pg_temp.hire's folder, its agent.md as given).
create function pg_temp.hire_as(p_handle text, p_id uuid, p_status text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_handle, 'agent', p_status))),
			jsonb_build_object('path','routines','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_handle, 'agent', p_status), pg_temp.agent_parse(p_id, p_handle, 'agent', p_status))))
$$;
-- The agent's grants on the company's shared root, and the roots it should have one on.
create function pg_temp.root_grants(p_id uuid) returns setof public.qorpera_company_path_grants language sql as $$
	select g.* from public.qorpera_company_path_grants g join public.qorpera_company_path_resources r on r.id = g.resource_id
	where r.environment_id = '70700000-0000-4000-8000-000000000020' and r.path = '' and r.path_match = 'subtree'
		and r.scope = 'company_shared' and g.principal_kind = 'staff_agent' and g.principal_id = p_id
$$;
create function pg_temp.roots() returns bigint language sql as $$
	select count(*) from public.qorpera_company_path_resources r where r.environment_id = '70700000-0000-4000-8000-000000000020'
		and r.path = '' and r.path_match = 'subtree' and r.scope = 'company_shared' and r.revoked_at is null
$$;
create function pg_temp.authority_rows() returns bigint language sql as $$
	select count(*) from public.qorpera_folder_journal where environment_id = '70700000-0000-4000-8000-000000000020' and kind = 'authority'
$$;
create function pg_temp.first_run(p_id uuid) returns public.qorpera_agent_first_runs language sql as $$
	select * from public.qorpera_agent_first_runs where profile_id = '70700000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;
create function pg_temp.kickoff(p_id uuid) returns public.qorpera_session_inputs language sql as $$
	select i.* from public.qorpera_session_inputs i join public.qorpera_agent_first_runs f on f.input_id = i.id
	where f.profile_id = '70700000-0000-4000-8000-000000000010' and f.staff_agent_id = p_id
$$;
create function pg_temp.turn(p_id uuid) returns public.qorpera_session_turn_requests language sql as $$
	select r.* from public.qorpera_session_turn_requests r join public.qorpera_agent_first_runs f on f.input_id = r.input_id
	where f.profile_id = '70700000-0000-4000-8000-000000000010' and f.staff_agent_id = p_id
$$;
create function pg_temp.connectors(p_id uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_cloud_secret_operation_grants where staff_agent_id = p_id and status = 'active'
$$;
create function pg_temp.thread(p_id uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '70700000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = p_id
$$;
create function pg_temp.as_user(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id = p_user))::text, true)::text::void
$$;
create function pg_temp.as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)::text::void
$$;
-- A member connects their own ChatGPT login to the company, as 856 does: the login a first run's turn is paid with.
create function pg_temp.connect_login(p_user uuid, p_n integer) returns void language plpgsql as $$
declare v_profile uuid := '70700000-0000-4000-8000-000000000010'; v_identity jsonb; v_login jsonb; v_connection jsonb;
	v_hex text := lpad(to_hex(p_n), 2, '0');
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity(v_profile, ('87700000-0000-4000-8000-0000000007' || v_hex)::uuid,
		'My model account', 'qorpera-member-linux', 'v1', '["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login(v_profile, ('87700000-0000-4000-8000-0000000008' || v_hex)::uuid,
		('87700000-0000-4000-8000-0000000009' || v_hex)::uuid, (v_identity ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli', repeat(v_hex, 32), 900);
	reset role;
	perform pg_temp.as_service();
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat(v_hex, 32),
		('87700000-0000-4000-8000-000000000a' || v_hex)::uuid,
		'object://native-capsules/87700000-0000-4000-8000-000000000a' || v_hex, repeat('d', 64), 'openai-' || v_hex,
		'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions v
	where connection_id = (v_connection ->> 'connection_id')::uuid and version = 1;
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	perform public.qorpera_create_member_execution_sponsor(v_profile, ('87700000-0000-4000-8000-000000000b' || v_hex)::uuid,
		(v_connection ->> 'connection_id')::uuid, 2, true);
	reset role;
	perform pg_temp.as_service();
end $$;

-- 1. The company: the Co-Founder, the owner's own login, and a connection shared with every agent -------------------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Routines'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70700000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	if pg_temp.roots() < 1 then raise exception 'Fixture: the company has no shared root'; end if;
	-- The fixture ran the queue: the Co-Founder converged, with its default grant on each shared root.
	if (select count(*) from pg_temp.root_grants('70700000-0000-4000-8000-0000000000c0')) <> pg_temp.roots()
		or (pg_temp.work('70700000-0000-4000-8000-0000000000c0')).dirty is distinct from false then
		raise exception 'Fixture: the Co-Founder did not converge: %', to_jsonb(pg_temp.work('70700000-0000-4000-8000-0000000000c0')); end if;
end $$;
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
	'supported','enabled',32,null,'folder-follow-up-fixture') \g /dev/null
select pg_temp.connect_login('70700000-0000-4000-8000-000000000001', 1);
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('87700000-0000-4000-8000-0000000000d1','70700000-0000-4000-8000-000000000010','https://broker.example.test','key-877',repeat('7',64));
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
	status,current_version,created_by_user_id,account_label,available_to_all_agents) values
	('87700000-0000-4000-8000-0000000000e1','70700000-0000-4000-8000-000000000010','70700000-0000-4000-8000-000000000020',
		'87700000-0000-4000-8000-0000000000d1','company','gmail','primary','Gmail account','active',1,
		'70700000-0000-4000-8000-000000000001','hello@nordlys.test',true);

-- 2. A hire: the commit marks it; the step gives it its default grant, its connectors and its first run --------------------

do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1'; r jsonb; v jsonb; w public.qorpera_folder_follow_ups;
	g public.qorpera_company_path_grants; f public.qorpera_agent_first_runs; k public.qorpera_session_inputs;
	t public.qorpera_session_turn_requests; m public.qorpera_folder_follow_up_marks; j public.qorpera_folder_journal;
	v_rows bigint := pg_temp.authority_rows();
begin
	r := pg_temp.save(pg_temp.owner(), 'hire-agent-a1', jsonb_build_array(pg_temp.hire_as('ada', a1, 'active')));
	perform pg_temp.expect(r, 1, 'saved');
	-- The commit only marks it: one mark, by the owner, with the commit, active.
	select * into m from public.qorpera_folder_follow_up_marks where subject_kind = 'agent' and subject_id = a1;
	if pg_temp.marked(a1) <> 1 or m.by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or m.commit_id is distinct from (r ->> 'commitId')::uuid or m.active is distinct from true then
		raise exception 'A hire is one mark: %', to_jsonb(m); end if;
	if (pg_temp.staff(a1)).employment_status is distinct from 'active' or pg_temp.thread(a1) is null
		or exists (select 1 from pg_temp.root_grants(a1)) or pg_temp.connectors(a1) <> 0
		or (pg_temp.first_run(a1)).input_id is not null or pg_temp.work(a1) is not null then
		raise exception 'The commit gives the hire its thread only'; end if;
	-- The step converges it.
	v := pg_temp.step();
	if v ->> 'subjectId' is distinct from a1::text or v ->> 'result' is distinct from 'done' then
		raise exception 'The step converges the hire: %', v; end if;
	w := pg_temp.work(a1);
	if w.dirty or w.attempts <> 0 or w.converged_at is null or w.failing_since is not null or w.not_before is not null
		or w.hired_by_user_id is distinct from '70700000-0000-4000-8000-000000000001' or pg_temp.marked(a1) <> 0 then
		raise exception 'A converged hire''s work row: %', to_jsonb(w); end if;
	-- Its default grant on each shared root: read and write, revision 1, attributed to the owner.
	if (select count(*) from pg_temp.root_grants(a1)) <> pg_temp.roots() then raise exception 'The hire has no default grant'; end if;
	for g in select * from pg_temp.root_grants(a1) loop
		if g.permissions is distinct from array['read','write'] or g.origin is distinct from 'default_agent_read'
			or g.revision <> 1 or g.revoked_at is not null or g.expires_at is not null
			or g.created_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
			or g.resource_version is distinct from (select version from public.qorpera_company_path_resources where id = g.resource_id) then
			raise exception 'The default grant: %', to_jsonb(g); end if;
	end loop;
	-- One widening authority journal row, at the clock's newest seq, listing the grants inserted.
	select * into j from public.qorpera_folder_journal where environment_id = '70700000-0000-4000-8000-000000000020'
		and kind = 'authority' order by seq desc limit 1;
	if pg_temp.authority_rows() <> v_rows + 1 or j.seq is distinct from pg_temp.seq()
		or j.authority -> 'narrowing' is distinct from 'false'::jsonb or j.authority -> 'actor' is distinct from '{"kind":"platform"}'::jsonb
		or (select array_agg(c ->> 'grantId' order by c ->> 'grantId') from jsonb_array_elements(j.authority -> 'changes') c)
			is distinct from (select array_agg(rg.id::text order by rg.id::text) from pg_temp.root_grants(a1) rg)
		or exists (select 1 from jsonb_array_elements(j.authority -> 'changes') c where c -> 'revision' <> '1'::jsonb or c ->> 'prefix' <> '')
		or (select count(*) from public.qorpera_folder_authority_changes x where x.environment_id = j.environment_id and x.seq = j.seq
			and not x.narrowing and x.grant_id is not null and x.resource_id is null) <> pg_temp.roots() then
		raise exception 'The default grant''s journal row: %', to_jsonb(j); end if;
	-- Its connectors: the shared connection's operations, issued by the owner.
	if pg_temp.connectors(a1) = 0 or exists (select 1 from public.qorpera_cloud_secret_operation_grants where staff_agent_id = a1
		and (secret_id <> '87700000-0000-4000-8000-0000000000e1' or issued_by_user_id <> '70700000-0000-4000-8000-000000000001')) then
		raise exception 'The hire''s connectors'; end if;
	-- Its first run: the kickoff in its thread, by the owner, and its turn on the owner's own login.
	f := pg_temp.first_run(a1); k := pg_temp.kickoff(a1); t := pg_temp.turn(a1);
	if f.session_id is distinct from pg_temp.thread(a1) or f.environment_id is distinct from '70700000-0000-4000-8000-000000000020'
		or f.source_path_version is distinct from (pg_temp.staff(a1)).folder_path_version
		or k.kind is distinct from 'kickoff' or k.author_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or k.client_input_id is distinct from md5('qorpera.folder-agent-first-run:' || a1::text)::uuid
		or k.body -> 'assignment' ->> 'kind' is distinct from 'staff_startup' or k.body -> 'assignment' ->> 'staffAgentId' is distinct from a1::text
		or k.body is distinct from f.startup_assignment then
		raise exception 'The hire''s first run: % / %', to_jsonb(f), to_jsonb(k); end if;
	if t.id is null or t.sponsored_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or t.sponsor_mode is distinct from 'member_connection' or t.status is distinct from 'queued' or t.session_id is distinct from f.session_id
		or t.sponsor_binding_id is distinct from (select b.id from public.qorpera_execution_sponsor_bindings b
			where b.client_binding_id = '87700000-0000-4000-8000-000000000b01') then
		raise exception 'The hire''s turn: %', to_jsonb(t); end if;
	-- Converged: a step finds nothing, and a kick writes nothing more.
	v := pg_temp.step();
	if v is not null then raise exception 'A converged hire is converged again: % / %', v,
		(select jsonb_agg(to_jsonb(x)) from public.qorpera_folder_follow_ups x); end if;
	v := public.qorpera_folder_follow_up_now('70700000-0000-4000-8000-000000000020', 'agent', a1);
	if v ->> 'result' is distinct from 'clean' or pg_temp.authority_rows() <> v_rows + 1
		or (select count(*) from public.qorpera_session_inputs where client_input_id = md5('qorpera.folder-agent-first-run:' || a1::text)::uuid) <> 1
		or (select count(*) from public.qorpera_session_turn_requests where input_id = k.id) <> 1 then
		raise exception 'A repeat changes nothing: %', v; end if;
end $$;

-- 3. The default grant never widens an explicit grant, never revives one, and is the step's only journal row ---------------

do $$
declare a2 constant uuid := '87700000-0000-4000-8000-0000000000a2'; a3 constant uuid := '87700000-0000-4000-8000-0000000000a3';
	v_rows bigint; v_root uuid := (select id from public.qorpera_company_path_resources where environment_id = '70700000-0000-4000-8000-000000000020'
		and path = '' and path_match = 'subtree' and scope = 'company_shared' and revoked_at is null order by id limit 1);
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'hire-agent-a2-a3', jsonb_build_array(pg_temp.hire_as('bo', a2, 'active'),
		pg_temp.hire_as('cy', a3, 'active'))), 1, 'saved');
	-- Before the step: an explicit read-only grant for bo, a revoked default for cy.
	insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id, permissions,
		created_by_user_id, origin)
	select r.id, r.version, 'staff_agent', a2, array['read'], '70700000-0000-4000-8000-000000000001', 'explicit'
	from public.qorpera_company_path_resources r where r.id = v_root;
	insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id, permissions,
		created_by_user_id, origin, revoked_at)
	select r.id, r.version, 'staff_agent', a3, array['read','write'], '70700000-0000-4000-8000-000000000001', 'default_agent_read',
		clock_timestamp()
	from public.qorpera_company_path_resources r where r.id = v_root;
	v_rows := pg_temp.authority_rows();
	if jsonb_array_length(pg_temp.drain()) <> 2 then raise exception 'Two hires, two steps'; end if;
	if (select array_agg(permissions) from pg_temp.root_grants(a2) where resource_id = v_root) is distinct from array[array['read']]
		or (select count(*) from pg_temp.root_grants(a3) where resource_id = v_root and revoked_at is null) <> 0
		or (select count(*) from pg_temp.root_grants(a3) where resource_id = v_root) <> 1 then
		raise exception 'The default grant widened or revived a grant'; end if;
	-- One journal row for each hire that got a grant on another root, none for a hire that got none.
	if pg_temp.authority_rows() <> v_rows + 2 * (case when pg_temp.roots() > 1 then 1 else 0 end) then
		raise exception 'Journal rows without a grant: %', pg_temp.authority_rows() - v_rows; end if;
	if (pg_temp.work(a2)).dirty or (pg_temp.work(a3)).dirty or pg_temp.turn(a2) is null or pg_temp.turn(a3) is null then
		raise exception 'The hires still converged'; end if;
end $$;

-- 4. A member with no login, and a hirer gone ---------------------------------------------------------------------------

do $$
declare a4 constant uuid := '87700000-0000-4000-8000-0000000000a4'; a5 constant uuid := '87700000-0000-4000-8000-0000000000a5';
	v jsonb; w public.qorpera_folder_follow_ups;
begin
	-- The member (…02) hires with no usable login: the kickoff waits for them to start it, and no turn is queued.
	perform pg_temp.expect(pg_temp.save(pg_temp.mem(), 'hire-agent-a4', jsonb_build_array(pg_temp.hire_as('di', a4, 'active'))), 1, 'saved');
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or (pg_temp.kickoff(a4)).author_user_id is distinct from '70700000-0000-4000-8000-000000000002'
		or pg_temp.turn(a4) is not null or (pg_temp.work(a4)).last_problem is not null then
		raise exception 'A hire with no paying login: %', v; end if;
	-- The member hires again, then leaves before the step: the owner authors the kickoff, nobody's login is queued.
	perform pg_temp.expect(pg_temp.save(pg_temp.mem(), 'hire-agent-a5', jsonb_build_array(pg_temp.hire_as('ed', a5, 'active'))), 1, 'saved');
	perform pg_temp.fx($q$delete from public.qorpera_profile_members where profile_id = '70700000-0000-4000-8000-000000000010'
		and user_id = '70700000-0000-4000-8000-000000000002'$q$);
	v := pg_temp.step(); w := pg_temp.work(a5);
	if v ->> 'result' is distinct from 'done' or w.last_problem is distinct from 'hirer_left'
		or w.hired_by_user_id is distinct from '70700000-0000-4000-8000-000000000002'
		or (pg_temp.kickoff(a5)).author_user_id is distinct from '70700000-0000-4000-8000-000000000001' or pg_temp.turn(a5) is not null
		or (select count(*) from pg_temp.root_grants(a5)) <> pg_temp.roots() then
		raise exception 'A hirer gone: % / %', v, to_jsonb(w); end if;
	perform pg_temp.fx($q$insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
		('70700000-0000-4000-8000-000000000010','70700000-0000-4000-8000-000000000002','todos-member@example.test','Member','contributor')$q$);
	-- That first run stays its owner's to start: archived and reactivated later, the queue still queues no turn, though the
	-- owner has a login.
	if not (pg_temp.work(a5)).first_run_manual then raise exception 'The owner''s stand-in first run is not kept manual'; end if;
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'archive-a5-0001', jsonb_build_array(pg_temp.agent('ed', a5, 'archived'))), 1, 'saved');
	perform pg_temp.step();
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'reactivate-a5-0001', jsonb_build_array(pg_temp.agent('ed', a5, 'active'))), 1, 'saved');
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or pg_temp.turn(a5) is not null or not (pg_temp.work(a5)).first_run_manual then
		raise exception 'A later converge charged someone for a manual first run: % / %', v, to_jsonb(pg_temp.turn(a5)); end if;
end $$;

-- 5. Saved archived by one member and activated by another before the step: the activating member authors and pays -------

do $$
declare a6 constant uuid := '87700000-0000-4000-8000-0000000000a6'; v jsonb;
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.mem(), 'hire-agent-a6', jsonb_build_array(pg_temp.hire_as('fa', a6, 'archived'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'activate-a6', jsonb_build_array(pg_temp.agent('fa', a6, 'active'))), 1, 'saved');
	if pg_temp.marked(a6) <> 2 then raise exception 'Two saves, two marks'; end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or pg_temp.marked(a6) <> 0 or pg_temp.step() is not null
		or (pg_temp.work(a6)).hired_by_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or (pg_temp.kickoff(a6)).author_user_id is distinct from '70700000-0000-4000-8000-000000000001'
		or (pg_temp.turn(a6)).sponsored_by_user_id is distinct from '70700000-0000-4000-8000-000000000001' then
		raise exception 'The activating member authors the first run: %', v; end if;
end $$;

-- The member whose commit first made the agent active authors its first run, though others archived and reactivated it
-- before the step.
do $$
declare a10 constant uuid := '87700000-0000-4000-8000-0000000000b0'; v jsonb;
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.mem(), 'hire-agent-b0', jsonb_build_array(pg_temp.hire_as('jo', a10, 'active'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'archive-b0-0001', jsonb_build_array(pg_temp.agent('jo', a10, 'archived'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'activate-b0-0001', jsonb_build_array(pg_temp.agent('jo', a10, 'active'))), 1, 'saved');
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or pg_temp.marked(a10) <> 0
		or (pg_temp.work(a10)).hired_by_user_id is distinct from '70700000-0000-4000-8000-000000000002'
		or (pg_temp.kickoff(a10)).author_user_id is distinct from '70700000-0000-4000-8000-000000000002' then
		raise exception 'The first activating member authors: % / %', v, to_jsonb(pg_temp.kickoff(a10)); end if;
end $$;

-- A rename before the step: one converge, the hire's first run as usual.
do $$
declare a11 constant uuid := '87700000-0000-4000-8000-0000000000b1'; v jsonb;
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'hire-agent-b1', jsonb_build_array(pg_temp.hire_as('kai', a11, 'active'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'rename-b1-0001', jsonb_build_array(pg_temp.write('agents/kai/agent.md', 'agent',
		pg_temp.agent_text(a11, 'Kai Berg', 'agent', 'active'), pg_temp.agent_parse(a11, 'Kai Berg', 'agent', 'active'),
		pg_temp.version('agents/kai/agent.md')))), 1, 'saved');
	if pg_temp.marked(a11) <> 1 then raise exception 'A rename marks nothing'; end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or pg_temp.step() is not null or (pg_temp.kickoff(a11)).id is null
		or pg_temp.turn(a11) is null or (pg_temp.staff(a11)).display_name is distinct from 'Kai Berg' then
		raise exception 'A rename before the converge: %', v; end if;
end $$;

-- 6. An archive: the agent's routines paused, its execution access, sessions and secret grants gone -----------------------

-- Ada's routines (an active one, one its file pauses, an expired one that was active), her execution authority, her
-- pair conversation with Bo, and a binding on her thread.
do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routines-a1', jsonb_build_array(
		pg_temp.routine('agents/ada/routines/inbox.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f1', 'Inbox', pg_temp.every())),
		pg_temp.routine('agents/ada/routines/digest.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f2', 'Digest', pg_temp.every(),
			'{"status":"paused"}')),
		pg_temp.routine('agents/ada/routines/report.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f3', 'Report', pg_temp.every())))),
		1, 'saved');
	perform pg_temp.fx($q$update public.qorpera_cloud_routines set status = 'expired', expired_while_active = true
		where id = '87700000-0000-4000-8000-0000000000f3'$q$);
	insert into public.qorpera_staff_execution_authorities(profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
		configured_by_user_id)
	values ('70700000-0000-4000-8000-000000000010', a1, '70800000-0000-4000-8000-0000000000b1', 1, '70700000-0000-4000-8000-000000000001');
	insert into public.qorpera_session_execution_bindings(session_id, profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
		configured_by_user_id)
	values (pg_temp.thread(a1), '70700000-0000-4000-8000-000000000010', a1, '70800000-0000-4000-8000-0000000000b1', 1,
		'70700000-0000-4000-8000-000000000001');
	perform set_config('qorpera_test.pair', public.qorpera_agent_pair_session_internal('70700000-0000-4000-8000-000000000010',
		'70700000-0000-4000-8000-000000000020', a1, '87700000-0000-4000-8000-0000000000a2', '70700000-0000-4000-8000-000000000001')::text,
		true);
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f2')).status is distinct from 'paused'
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f2')).pause_reason is null then
		raise exception 'Fixture: the file''s own pause'; end if;
	perform set_config('qorpera_test.own_pause', (pg_temp.rt('87700000-0000-4000-8000-0000000000f2')).pause_reason, true);
end $$;

do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1'; v jsonb; v_rows bigint := pg_temp.authority_rows();
	v_pair uuid := current_setting('qorpera_test.pair')::uuid; v_thread uuid := pg_temp.thread(a1);
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'archive-a1', jsonb_build_array(pg_temp.agent('ada', a1, 'archived'))), 1, 'saved');
	-- The commit archives the staff row, closes its thread (the thread trigger, at rank 11) and marks it; everything else
	-- waits for the step.
	if (pg_temp.staff(a1)).employment_status is distinct from 'archived' or pg_temp.marked(a1) <> 1
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).status is distinct from 'active'
		or not exists (select 1 from public.qorpera_staff_execution_authorities where staff_agent_id = a1)
		or not exists (select 1 from public.qorpera_session_execution_bindings where session_id = v_thread)
		or not (pg_temp.rt('87700000-0000-4000-8000-0000000000f3')).expired_while_active
		or (select status from public.qorpera_shared_sessions where id = v_thread) is distinct from 'closed'
		or (select status from public.qorpera_shared_sessions where id = v_pair) is distinct from 'open' or pg_temp.connectors(a1) = 0 then
		raise exception 'The archive''s commit only archives, closes the thread and marks'; end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or (pg_temp.work(a1)).dirty then raise exception 'The archive converges: %', v; end if;
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).status is distinct from 'paused'
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).pause_reason is distinct from 'agent_archived'
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f2')).pause_reason is distinct from current_setting('qorpera_test.own_pause')
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f3')).status is distinct from 'expired'
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f3')).expired_while_active then
		raise exception 'The archive pauses its routines, and only the platform''s record'; end if;
	if exists (select 1 from public.qorpera_staff_execution_authorities where staff_agent_id = a1)
		or exists (select 1 from public.qorpera_session_execution_bindings where session_id in (v_thread, v_pair))
		or (select status from public.qorpera_shared_sessions where id = v_thread) is distinct from 'closed'
		or (select status from public.qorpera_shared_sessions where id = v_pair) is distinct from 'closed'
		or pg_temp.connectors(a1) <> 0
		or exists (select 1 from public.qorpera_cloud_secret_operation_grants where staff_agent_id = a1 and status = 'revoked'
			and (revoked_at is null or revoked_by_user_id is distinct from '70700000-0000-4000-8000-000000000001')) then
		raise exception 'The archive ends its execution access, sessions and secret grants'; end if;
	-- Its path grants stay (the archive narrows nothing), and no journal row is written.
	if (select count(*) from pg_temp.root_grants(a1) where revoked_at is null) <> pg_temp.roots() or pg_temp.authority_rows() <> v_rows then
		raise exception 'An archive keeps its path grants'; end if;
	-- The member RPC's record of the archive: the routine's file still says active.
	if pg_temp.marked(a1) <> 0 then raise exception 'The archive''s mark was consumed'; end if;
end $$;

-- 7. Routines saved, set active or moved under an archived agent are recorded paused; firing defers and marks once ----------

do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1'; f1 constant uuid := '87700000-0000-4000-8000-0000000000f1';
	v jsonb; x public.qorpera_cloud_routines;
begin
	-- A new routine, and the agent's own pause set back to active in its file.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routines-a1-2', jsonb_build_array(
		pg_temp.routine('agents/ada/routines/weekly.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f4', 'Weekly', pg_temp.every())),
		pg_temp.routine('agents/ada/routines/digest.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f2', 'Digest', pg_temp.every())))),
		1, 'saved');
	for x in select * from public.qorpera_cloud_routines where id in ('87700000-0000-4000-8000-0000000000f4', '87700000-0000-4000-8000-0000000000f2') loop
		if x.status is distinct from 'paused' or x.pause_reason is distinct from 'agent_archived' then
			raise exception 'A routine landing under an archived agent is recorded paused: %', to_jsonb(x); end if;
	end loop;
	-- Bo's routine moved under Ada: paused, and its schedule position not active.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'routine-bo', jsonb_build_array(
		pg_temp.routine('agents/bo/routines/calls.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f5', 'Calls', pg_temp.every())))),
		1, 'saved');
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f5')).status is distinct from 'active' then raise exception 'Fixture: Bo''s routine'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-to-ada', jsonb_build_array(
		pg_temp.move('agents/bo/routines/calls.md', 'agents/ada/routines/calls.md'))), 1, 'saved');
	x := pg_temp.rt('87700000-0000-4000-8000-0000000000f5');
	if x.owner_staff_agent_id is distinct from a1 or x.status is distinct from 'paused' or x.pause_reason is distinct from 'agent_archived' then
		raise exception 'A routine moved under an archived agent: %', to_jsonb(x); end if;
	-- The gap a concurrent archive leaves: a routine still active under the archived agent. The scheduler defers it and
	-- marks the agent once, however often it offers the slot; the step pauses it.
	perform pg_temp.fx(format($q$update public.qorpera_cloud_routines set status = 'active', pause_reason = null where id = %L$q$, f1));
	for i in 1..3 loop
		v := public.qorpera_enqueue_routine_wake(f1, (pg_temp.rt(f1)).current_version, extensions.gen_random_uuid(), 'slot-' || i, 'file',
			date_trunc('milliseconds', clock_timestamp()) + interval '1 minute', null, clock_timestamp() + interval '1 hour');
		if v ->> 'status' is distinct from 'deferred' or v ->> 'occurrence_id' is not null then
			raise exception 'An archived agent''s routine defers: %', v; end if;
	end loop;
	if pg_temp.marked(a1) <> 1 or exists (select 1 from public.qorpera_folder_follow_up_marks where subject_id = a1 and commit_id is not null)
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = f1) then
		raise exception 'Firing marks once and makes nothing: %', pg_temp.marked(a1); end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or (pg_temp.rt(f1)).status is distinct from 'paused'
		or (pg_temp.rt(f1)).pause_reason is distinct from 'agent_archived' then
		raise exception 'The step pauses the routine firing marked: %', v; end if;
end $$;

-- A failing archive converge keeps its back-off while the routine is due: firing writes no mark over a dirty row, and a
-- mark with no commit does not clear the back-off.
alter table public.qorpera_cloud_routines add constraint p15_test_no_archive_pause
	check (pause_reason is distinct from 'agent_archived' or id <> '87700000-0000-4000-8000-0000000000f1') not valid;
do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1'; f1 constant uuid := '87700000-0000-4000-8000-0000000000f1';
	v jsonb; w public.qorpera_folder_follow_ups;
begin
	perform pg_temp.fx(format($q$update public.qorpera_cloud_routines set status = 'active', pause_reason = null where id = %L$q$, f1));
	v := public.qorpera_enqueue_routine_wake(f1, (pg_temp.rt(f1)).current_version, extensions.gen_random_uuid(), 'slot-4', 'file',
		date_trunc('milliseconds', clock_timestamp()) + interval '1 minute', null, clock_timestamp() + interval '1 hour');
	v := pg_temp.step(); w := pg_temp.work(a1);
	if v ->> 'result' is distinct from 'failed' or not w.dirty or w.attempts <> 1 or w.not_before <= clock_timestamp()
		or w.failing_since is null or w.last_problem not like '23514 %' or (pg_temp.rt(f1)).status is distinct from 'active' then
		raise exception 'A failing converge backs off: % / %', v, to_jsonb(w); end if;
	v := public.qorpera_enqueue_routine_wake(f1, (pg_temp.rt(f1)).current_version, extensions.gen_random_uuid(), 'slot-5', 'file',
		date_trunc('milliseconds', clock_timestamp()) + interval '1 minute', null, clock_timestamp() + interval '1 hour');
	if v ->> 'status' is distinct from 'deferred' or pg_temp.marked(a1) <> 0 then
		raise exception 'Firing marks no agent whose row is dirty: %', v; end if;
	-- A mark with no commit (as firing's, written before the row turned dirty) is taken but keeps the back-off.
	insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id)
	values ('70700000-0000-4000-8000-000000000020', 'agent', a1);
	if pg_temp.step() is not null or pg_temp.marked(a1) <> 0 or (pg_temp.work(a1)).not_before is distinct from w.not_before
		or (pg_temp.work(a1)).attempts <> 1 then
		raise exception 'A mark with no commit cleared the back-off: %', to_jsonb(pg_temp.work(a1)); end if;
	-- Once due, the next attempt converges.
	update public.qorpera_folder_follow_ups set not_before = clock_timestamp() - interval '1 second'
	where environment_id = '70700000-0000-4000-8000-000000000020' and subject_kind = 'agent' and subject_id = a1;
end $$;
alter table public.qorpera_cloud_routines drop constraint p15_test_no_archive_pause;
do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1'; v jsonb := pg_temp.step(); w public.qorpera_folder_follow_ups := pg_temp.work(a1);
begin
	if v ->> 'result' is distinct from 'done' or w.dirty or w.attempts <> 0 or w.failing_since is not null
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).pause_reason is distinct from 'agent_archived' then
		raise exception 'The retry converges: % / %', v, to_jsonb(w); end if;
end $$;

-- Another 55000 than a pause (as a session input's own trigger may raise) is a failure with its problem, not a pause.
create function public.p15_test_refuse_kickoff() returns trigger language plpgsql as $$
begin
	raise exception 'The transcript import is still uploading' using errcode = '55000';
end $$;
create trigger p15_test_refuse_kickoff before insert on public.qorpera_session_inputs for each row
	when (new.client_input_id = md5('qorpera.folder-agent-first-run:87700000-0000-4000-8000-0000000000b2')::uuid)
	execute function public.p15_test_refuse_kickoff();
do $$
declare a12 constant uuid := '87700000-0000-4000-8000-0000000000b2'; v jsonb; w public.qorpera_folder_follow_ups;
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'hire-agent-b2', jsonb_build_array(pg_temp.hire_as('lu', a12, 'active'))), 1, 'saved');
	v := pg_temp.step(); w := pg_temp.work(a12);
	if v ->> 'result' is distinct from 'failed' or w.attempts <> 1 or w.failing_since is null
		or w.last_problem not like '55000 The transcript import%' or exists (select 1 from pg_temp.root_grants(a12)) then
		raise exception 'A 55000 that is no pause: % / %', v, to_jsonb(w); end if;
end $$;
drop trigger p15_test_refuse_kickoff on public.qorpera_session_inputs;
drop function public.p15_test_refuse_kickoff();
update public.qorpera_folder_follow_ups set not_before = null
where environment_id = '70700000-0000-4000-8000-000000000020' and subject_id = '87700000-0000-4000-8000-0000000000b2';
do $$
declare v jsonb := pg_temp.step();
begin
	if v ->> 'result' is distinct from 'done' or (pg_temp.work('87700000-0000-4000-8000-0000000000b2')).failing_since is not null then
		raise exception 'The retry converges: %', v; end if;
end $$;

-- 8. Reactivation: the routines stay paused until a paid save resumes them; a handover to an active agent too -------------

do $$
declare a1 constant uuid := '87700000-0000-4000-8000-0000000000a1'; v jsonb; v_inputs bigint;
begin
	v_inputs := (select count(*) from public.qorpera_session_inputs where client_input_id = md5('qorpera.folder-agent-first-run:' || a1::text)::uuid);
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'reactivate-a1', jsonb_build_array(pg_temp.agent('ada', a1, 'active'))), 1, 'saved');
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).status is distinct from 'paused'
		or pg_temp.connectors(a1) = 0
		or (select count(*) from public.qorpera_session_inputs where client_input_id = md5('qorpera.folder-agent-first-run:' || a1::text)::uuid)
			<> v_inputs then
		raise exception 'A reactivation keeps the routines paused and makes no second first run: %', v; end if;
	-- The owner's paid save of the unchanged file resumes it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-f1', jsonb_build_array(
		pg_temp.routine('agents/ada/routines/inbox.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f1', 'Inbox', pg_temp.every())))),
		1, 'saved');
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).status is distinct from 'active'
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).pause_reason is not null then
		raise exception 'A paid unchanged save resumes the archive''s pause: %', to_jsonb(pg_temp.rt('87700000-0000-4000-8000-0000000000f1')); end if;
	-- Archived again, and its paused routine handed over to Bo (active): still paused until a paid save.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'archive-a1-2', jsonb_build_array(pg_temp.agent('ada', a1, 'archived'))), 1, 'saved');
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).pause_reason is distinct from 'agent_archived' then
		raise exception 'Archived again: paused'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'handover-f1', jsonb_build_array(
		pg_temp.move('agents/ada/routines/inbox.md', 'agents/bo/routines/inbox.md'))), 1, 'saved');
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).owner_staff_agent_id is distinct from '87700000-0000-4000-8000-0000000000a2'
		or (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).status is distinct from 'paused' then
		raise exception 'A handover keeps the pause'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'resume-f1-bo', jsonb_build_array(
		pg_temp.routine('agents/bo/routines/inbox.md', pg_temp.rparse('87700000-0000-4000-8000-0000000000f1', 'Inbox', pg_temp.every())))),
		1, 'saved');
	if (pg_temp.rt('87700000-0000-4000-8000-0000000000f1')).status is distinct from 'active' then
		raise exception 'A paid save resumes it under its active agent'; end if;
end $$;

-- 9. A retire and a restore: the archive's effects, then one first run ever ----------------------------------------------

do $$
declare a4 constant uuid := '87700000-0000-4000-8000-0000000000a4'; v jsonb; v_input uuid := (pg_temp.first_run(a4)).input_id;
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'retire-a4', jsonb_build_array(pg_temp.del('agents/di'))), 1, 'saved');
	if pg_temp.marked(a4) <> 1 or (pg_temp.staff(a4)).folder_retired_at is null then raise exception 'A retire marks the agent'; end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or pg_temp.connectors(a4) <> 0
		or (select status from public.qorpera_shared_sessions where id = pg_temp.thread(a4)) is distinct from 'closed' then
		raise exception 'A retire converges as an archive: %', v; end if;
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'restore-a4', jsonb_build_array(pg_temp.hire_as('di-back', a4, 'active'))), 1, 'saved');
	if pg_temp.marked(a4) <> 1 then raise exception 'A restore marks the agent'; end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or pg_temp.connectors(a4) = 0 or (pg_temp.first_run(a4)).input_id is distinct from v_input then
		raise exception 'A restore converges with the first run it had: %', v; end if;
end $$;

-- 10. The company's name -----------------------------------------------------------------------------------------------

do $$
declare v jsonb; r jsonb;
begin
	r := pg_temp.save(pg_temp.owner(), 'rename-0001', jsonb_build_array(pg_temp.vision('Nordlys Kaffe')));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.marked('70700000-0000-4000-8000-000000000010', 'company') <> 1
		or (select name from public.qorpera_profiles where id = '70700000-0000-4000-8000-000000000010') is distinct from 'Nordlys Routines' then
		raise exception 'A rename only marks the company'; end if;
	v := pg_temp.step();
	if v ->> 'subjectKind' is distinct from 'company' or v ->> 'result' is distinct from 'done'
		or (select name from public.qorpera_profiles where id = '70700000-0000-4000-8000-000000000010') is distinct from 'Nordlys Kaffe'
		or (pg_temp.work('70700000-0000-4000-8000-000000000010', 'company')).dirty then
		raise exception 'The step copies the name: %', v; end if;
	-- Every vision write marks the company (a comparison with the copied name could miss a rename back while a copy is in
	-- flight, 878 K); one that keeps the name converges to nothing.
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'rename-0002', jsonb_build_array(pg_temp.write('vision/vision.md', 'vision',
		E'# Nordlys Kaffe\n\nCoffee.\n', '{"kind":"vision","name":"Nordlys Kaffe"}', pg_temp.version('vision/vision.md')))), 1, 'saved');
	if pg_temp.marked('70700000-0000-4000-8000-000000000010', 'company') <> 1 then raise exception 'A vision write marks the company'; end if;
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done'
		or (select name from public.qorpera_profiles where id = '70700000-0000-4000-8000-000000000010') is distinct from 'Nordlys Kaffe' then
		raise exception 'An unchanged name converges to nothing: %', v; end if;
end $$;

-- 11. The commit kick: one subject a call, the company's first, until none remain ------------------------------------------

do $$
declare a7 constant uuid := '87700000-0000-4000-8000-0000000000a7'; a8 constant uuid := '87700000-0000-4000-8000-0000000000a8';
	r jsonb; v jsonb; v_commit uuid;
begin
	r := pg_temp.save(pg_temp.owner(), 'kick-0001', jsonb_build_array(pg_temp.vision('Nordlys Kaffe & Te'),
		pg_temp.hire_as('gu', a8, 'active'), pg_temp.hire_as('ha', a7, 'active')));
	perform pg_temp.expect(r, 1, 'saved');
	v_commit := (r ->> 'commitId')::uuid;
	v := public.qorpera_folder_follow_up_commit('70700000-0000-4000-8000-000000000020', v_commit);
	if v ->> 'subjectKind' is distinct from 'company' or v ->> 'result' is distinct from 'done' or v -> 'more' is distinct from 'true'::jsonb
		or (select name from public.qorpera_profiles where id = '70700000-0000-4000-8000-000000000010') is distinct from 'Nordlys Kaffe & Te' then
		raise exception 'The company first: %', v; end if;
	v := public.qorpera_folder_follow_up_commit('70700000-0000-4000-8000-000000000020', v_commit);
	if v ->> 'subjectId' is distinct from a7::text or v ->> 'result' is distinct from 'done' or v -> 'more' is distinct from 'true'::jsonb
		or (pg_temp.work(a7)).dirty or pg_temp.work(a8) is not null then
		raise exception 'Then one agent, in id order: %', v; end if;
	v := public.qorpera_folder_follow_up_commit('70700000-0000-4000-8000-000000000020', v_commit);
	if v ->> 'subjectId' is distinct from a8::text or v ->> 'result' is distinct from 'done' or v -> 'more' is distinct from 'false'::jsonb then
		raise exception 'Then the last: %', v; end if;
	v := public.qorpera_folder_follow_up_commit('70700000-0000-4000-8000-000000000020', v_commit);
	if v ->> 'result' is distinct from 'none' or v -> 'more' is distinct from 'false'::jsonb or pg_temp.step() is not null then
		raise exception 'None remain: %', v; end if;
end $$;

-- 12. A paused company and a company being deleted wait; the sweep drops what an environment left behind ---------------------

do $$
declare a9 constant uuid := '87700000-0000-4000-8000-0000000000a9'; v jsonb; v_gone constant uuid := '87700000-0000-4000-8000-0000000000ff';
	v_swept bigint;
begin
	perform pg_temp.expect(pg_temp.save(pg_temp.owner(), 'hire-agent-a9', jsonb_build_array(pg_temp.hire_as('io', a9, 'active'))), 1, 'saved');
	-- Paused: the step passes it by, the kick answers closed, no attempt is counted.
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000001', 'P15 test');
	if not public.qorpera_company_execution_paused('70700000-0000-4000-8000-000000000010') then
		raise exception 'Fixture: the company is not paused'; end if;
	if pg_temp.step() is not null or pg_temp.marked(a9) <> 1
		or public.qorpera_folder_follow_up_now('70700000-0000-4000-8000-000000000020', 'agent', a9) ->> 'result' is distinct from 'closed'
		or public.qorpera_folder_follow_up_commit('70700000-0000-4000-8000-000000000020', extensions.gen_random_uuid()) ->> 'result'
			is distinct from 'closed' then
		raise exception 'A paused company waits'; end if;
	delete from public.qorpera_company_execution_pauses where profile_id = '70700000-0000-4000-8000-000000000010';
	v := pg_temp.step();
	if v ->> 'result' is distinct from 'done' or (pg_temp.work(a9)).attempts <> 0 then raise exception 'Resumed, it converges: %', v; end if;
	-- Marks and a work row of an environment that is gone are swept.
	insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id) values (v_gone, 'agent', a9);
	insert into public.qorpera_folder_follow_ups(environment_id, subject_kind, subject_id, profile_id)
	values (v_gone, 'agent', a9, '70700000-0000-4000-8000-000000000010');
	v_swept := public.qorpera_folder_follow_up_sweep();
	if v_swept < 2 or exists (select 1 from public.qorpera_folder_follow_up_marks where environment_id = v_gone)
		or exists (select 1 from public.qorpera_folder_follow_ups where environment_id = v_gone) then
		raise exception 'The sweep left an environment''s rows'; end if;
	-- A kick for a subject with no marks makes a clean row and converges nothing.
	v := public.qorpera_folder_follow_up_now('70700000-0000-4000-8000-000000000020', 'agent', '87700000-0000-4000-8000-0000000000fe');
	if v ->> 'result' is distinct from 'clean' or (pg_temp.work('87700000-0000-4000-8000-0000000000fe')).dirty then
		raise exception 'A kick with no marks converged: %', v; end if;
	delete from public.qorpera_folder_follow_ups where subject_id = '87700000-0000-4000-8000-0000000000fe';
end $$;

-- The status view for operators.
do $$
declare v jsonb := public.qorpera_folder_follow_up_status('70700000-0000-4000-8000-000000000020');
begin
	if v ->> 'schema' is distinct from 'qorpera.folder-follow-up-status/v1' or (v ->> 'marks')::integer <> 0
		or jsonb_array_length(v -> 'dirty') <> 0 then
		raise exception 'The status view: %', v; end if;
end $$;

rollback;
