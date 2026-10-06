-- @fixture 764_chatgpt_plan_login.test.sql until "-- The plan login's own checks start here"
-- The rules a member's ChatGPT plan login keeps on folder-v2 (ported from snapshot-v1 in the legacy sweep; Sign in with
-- ChatGPT, slice 1b, 20260928359950, with 20260930095000 and P29's file-change rule, 20260928479120): the kind and consent
-- reads are the kernel's own; an agent's routine never consents a plan for its member and is prepared only on the login
-- its run pays with; a member's file-change routine is never paid by their plan; a plan pays for nothing that follows a
-- listener run; it is never swapped at its usage limit and pays for follow-up work only of runs it pays for; one usable
-- plan per member; a coding worker takes the member's other login before a plan; plan use stops for a company being
-- deleted. Test 764's fixture leaves the owner with a completed plan login (not consented for work while they are away)
-- and a Codex vault login, next to 924's native login (the "capsule" login here), which pays for Alice's leased run
-- through the base sponsor.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
do $$
declare v_plan uuid; v_codex uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	select version.connection_id into strict v_codex from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000250' and version.version = 1;
	perform set_config('qorpera_test.r768', jsonb_build_object('plan', v_plan, 'codex', v_codex,
		'capsule', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id',
		'capsuleBinding', current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::text, false);
end $$;
create function pg_temp.r768(p_key text) returns uuid language sql as $$
	select (current_setting('qorpera_test.r768')::jsonb ->> p_key)::uuid
$$;

-- 1. The kind of a connection, and whether a plan login awaits its member's consent. Nobody but the
-- kernel's own functions call these.
do $$
begin
	if not public.qorpera_connection_is_chatgpt_plan(pg_temp.r768('plan'))
		or public.qorpera_connection_is_chatgpt_plan(pg_temp.r768('codex'))
		or public.qorpera_connection_is_chatgpt_plan(pg_temp.r768('capsule')) then
		raise exception 'the login kind of a connection is wrong'; end if;
	if not public.qorpera_connection_plan_awaits_consent(pg_temp.r768('plan'))
		or public.qorpera_connection_plan_awaits_consent(pg_temp.r768('codex')) then
		raise exception 'a plan login''s consent is read wrong'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
		cross join unnest(array['public.qorpera_connection_is_chatgpt_plan(uuid)',
			'public.qorpera_sponsor_version_is_chatgpt_plan(uuid,bigint)',
			'public.qorpera_connection_plan_awaits_consent(uuid)']) as fn(signature)
		where has_function_privilege(role.name, fn.signature, 'execute')) then
		raise exception 'a plan rule helper is callable from the API'; end if;
end $$;

-- 2. Work while away: an agent's routine never consents a plan login for its member. With the member's
-- other logins gone, the run's routine finds no payer, and the plan login stays without consent.
update public.qorpera_provider_connections set status = 'revoked'
where id in (pg_temp.r768('codex'), pg_temp.r768('capsule'));
do $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	if exists (select 1 from public.qorpera_ensure_unattended_sponsor(v_run)) then
		raise exception 'a plan login paid for a routine without its member''s consent'; end if;
	if exists (select 1 from public.qorpera_provider_connection_versions
		where connection_id = pg_temp.r768('plan') and (allow_autonomous or version > 1)) then
		raise exception 'a plan login was consented for its member'; end if;
end $$;
-- The member turns it on themselves: the routine's payer is then their plan.
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_set_chatgpt_plan_work_while_away(%L,%L,true)::text',
	'92400000-0000-4000-8000-000000000010', pg_temp.r768('plan'))), 'ok', 'the member turns on work while away');
-- A run on the plan, as the member's conversation on it pays for (20260930095000: an agent's routine is prepared only
-- on the login its run pays with; Alice's run, paid by the native login that is gone, prepares nothing).
select set_config('qorpera_test.r768_plan_chat', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '76800000-0000-4000-8000-000000000009', pg_temp.r768('plan'),
	(current_setting('qorpera_test.plan764_last')::jsonb ->> 'version')::bigint, false)::text, false);
reset role;
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_binding uuid; v_version bigint;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	if exists (select 1 from public.qorpera_ensure_unattended_sponsor(v_run)) then
		raise exception 'a run another login paid for moved its routine to the plan'; end if;
	v_run.sponsor_binding_id := (current_setting('qorpera_test.r768_plan_chat')::jsonb ->> 'binding_id')::uuid;
	v_run.sponsor_version := (current_setting('qorpera_test.r768_plan_chat')::jsonb ->> 'version')::bigint;
	select sponsor.binding_id, sponsor.version into v_binding, v_version
	from public.qorpera_ensure_unattended_sponsor(v_run) as sponsor;
	if v_binding is null or not public.qorpera_sponsor_version_is_chatgpt_plan(v_binding, v_version) then
		raise exception 'a consented plan login does not pay for its member''s routine'; end if;
	perform set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
		|| jsonb_build_object('planBinding', v_binding, 'planVersion', v_version,
			'planChatBinding', current_setting('qorpera_test.r768_plan_chat')::jsonb ->> 'binding_id'))::text, false);
end $$;

-- 3. A plan never pays for a listener: the member's file-change routine is refused when it is saved while their plan is
-- their only payer (P29), and no routine row is made. (Snapshot-v1's event listeners have no folder-v2 routine.)
create function pg_temp.r768_commit(p_key text, p_units jsonb) returns jsonb language plpgsql as $$
declare v_manifest text;
begin
	for v_manifest in select distinct intent.manifest_text from jsonb_array_elements(p_units) as unit
		join public.qorpera_folder_upload_intents as intent on intent.environment_id = '92400000-0000-4000-8000-000000000020'
			and intent.manifest_sha256 = unit -> 'file' ->> 'manifestSha256' loop
		perform pg_temp.base_seal(pg_temp.base_owner(), v_manifest);
	end loop;
	return public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', pg_temp.base_owner(), p_key, p_units);
end $$;
select pg_temp.base_claims('service_role');
do $$
declare v_parse jsonb := jsonb_build_object('kind', 'routine', 'id', '76800000-0000-4000-8000-000000000001', 'title', 'Watch',
		'status', 'active', 'trigger', jsonb_build_object('when', 'file-change', 'watch', 'docs', 'match', 'subtree'),
		'timezone', 'Europe/Copenhagen', 'ends', null, 'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'optional',
		'conclusion', null, 'instructions', 'Look at what changed.');
	v_result jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'r768-docs', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'docs')));
	v_result := pg_temp.r768_commit('r768-watch', jsonb_build_array(pg_temp.base_write('agents/alice/routines/watch.md', 'routine',
		E'---\n' || v_parse::text || E'\n---\n', v_parse)));
	if v_result -> 'units' -> 0 ->> 'outcome' is distinct from 'refused'
		or v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' is distinct from
			'a ChatGPT plan pays only for work its member starts; a file-change routine needs another AI login' then
		raise exception 'a plan paid for a file-change routine: %', v_result; end if;
	if exists (select 1 from public.qorpera_cloud_routines where id = '76800000-0000-4000-8000-000000000001') then
		raise exception 'the refused file-change routine has a row'; end if;
end $$;
select pg_temp.base_claims('service_role');

-- 4. A plan pays for no work that follows from a listener run (a coworker message, a worker), and is never swapped at
-- its usage limit. Alice's run stands in for the listener run: a coworker's wake it causes, paid by the plan, passes
-- while its own wake was a member's input, and is refused once that wake was an event's or a file change's.
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_id uuid := extensions.gen_random_uuid();
	v_run uuid := (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	v_ancestry jsonb;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run;
	v_wake := jsonb_populate_record(v_wake, jsonb_build_object('id', v_id, 'run_id', null, 'parent_run_id', v_run,
		'wake_kind', 'agent', 'source_kind', 'coworker', 'source_id', extensions.gen_random_uuid(), 'session_id', null,
		'staff_agent_id', '92400000-0000-4000-8000-000000000031', 'causal_hop_count', 1, 'trigger_id', 'coworker',
		'occurrence_key', 'coworker:' || v_id, 'payload', '{}'::jsonb, 'sponsor_binding_id', pg_temp.r768('planBinding'),
		'sponsor_version', (current_setting('qorpera_test.r768')::jsonb ->> 'planVersion')::bigint));
	v_ancestry := public.qorpera_coworker_wake_ancestry(v_wake);
	v_wake := jsonb_populate_record(v_wake, jsonb_build_object('causal_root_id', v_ancestry ->> 'rootId',
		'causal_agent_ids', v_ancestry -> 'agentIds'));
	if not public.qorpera_wake_authorized(v_wake) then
		raise exception 'a coworker''s wake following a member''s own input is refused on their plan'; end if;
	perform set_config('qorpera_test.r768_followup', to_jsonb(v_wake)::text, false);
end $$;
create function pg_temp.r768_parent_source(p_source text) returns void language plpgsql as $$
begin
	-- One row's source changes for this check alone (triggers skipped; the transaction rolls back).
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set source_kind = p_source
	where run_id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	set local session_replication_role = origin;
end $$;
-- Which runs follow from a listener: a run woken by an event or a file change, and any run after it (the
-- wake above, refused below). (A session run's wake marked as a listener's no longer passes its own checks,
-- so the walk itself is checked here.)
do $$
declare v_source text; v_run uuid := (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
begin
	if public.qorpera_run_follows_listener(v_run) then raise exception 'a member''s input counts as a listener'; end if;
	foreach v_source in array array['event', 'company-file'] loop
		perform pg_temp.r768_parent_source(v_source);
		if not public.qorpera_run_follows_listener(v_run) then
			raise exception 'a run woken by a % does not follow a listener', v_source; end if;
	end loop;
	perform pg_temp.r768_parent_source('input');
end $$;
-- The walk goes up the whole chain: a chain longer than it walks (here, a run whose wake names itself as its
-- parent) counts as following a listener.
do $$
declare v_run uuid := (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set parent_run_id = v_run where run_id = v_run;
	set local session_replication_role = origin;
	if public.qorpera_wake_authorized(jsonb_populate_record(null::public.qorpera_wake_occurrences,
		current_setting('qorpera_test.r768_followup')::jsonb)) then
		raise exception 'a plan paid for work at the end of a chain too long to walk'; end if;
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set parent_run_id = null where run_id = v_run;
	set local session_replication_role = origin;
end $$;

-- The plan is never swapped at its usage limit. The owner's native login comes back with room left (924 consented it
-- for work while away; the base sponsor pays with it); the plan reaches its limit.
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.r768('capsule');
select set_config('qorpera_test.r768_capsule_version', (select max(version)::text
	from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule')), false);
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('plan'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('plan');
do $$
declare v_choice uuid;
begin
	if public.qorpera_native_account_remaining(pg_temp.r768('plan'),
		(select max(version) from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('plan'))) <> 0 then
		raise exception 'the plan is not at its limit'; end if;
	-- Follow-up work of a run the plan pays for stays on the plan; the limit stops it there. That holds also
	-- when the run's binding is one without work-while-away consent (a conversation's), since the plan is the
	-- same connection.
	select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', pg_temp.r768('planBinding'));
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'follow-up work moved off the plan at its limit: %', v_choice; end if;
	select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', pg_temp.r768('planChatBinding'));
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'follow-up work of a conversation on the plan moved off it: %', v_choice; end if;
	-- New work not tied to the plan starts on the login with room.
	select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', null);
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'new work did not start on the login with room: %', v_choice; end if;
	-- At its limit the plan is not taken for new work (a first run, a founding), as before.
	if exists (select 1 from public.qorpera_eligible_member_accounts('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001') as account where account.connection_id = pg_temp.r768('plan')) then
		raise exception 'the plan at its limit is offered for new work'; end if;
	if (public.qorpera_member_first_run_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001') ->> 'sponsorBindingId')::uuid
		in (select binding_id from public.qorpera_execution_sponsor_versions where provider_connection_id = pg_temp.r768('plan')) then
		raise exception 'a new conversation started on the plan at its limit'; end if;
end $$;
-- The kept plan stays the payer also when another login reports room (here the native login, half used).
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('capsule'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 50)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule');
do $$
declare v_choice uuid; v_binding text;
begin
	foreach v_binding in array array['planBinding', 'planChatBinding'] loop
		select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', pg_temp.r768(v_binding));
		if v_choice is distinct from pg_temp.r768('planBinding') then
			raise exception 'follow-up work of a run on % moved to a login with room: %', v_binding, v_choice; end if;
	end loop;
end $$;
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('capsule');
-- A conversation's account, in Alice's thread: a new conversation starts on the login with room; one the plan pays for
-- keeps it.
select set_config('qorpera_test.r768_session', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000030')), false);
create function pg_temp.r768_session_account() returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}', false);
	set local role authenticated;
	return pg_temp.plan764_try(format('select public.qorpera_select_member_session_account(%L,%L)::text',
		'92400000-0000-4000-8000-000000000010', current_setting('qorpera_test.r768_session')));
end $$;
delete from public.qorpera_member_session_accounts
where session_id = current_setting('qorpera_test.r768_session')::uuid and user_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.plan764_expect(pg_temp.r768_session_account(), 'ok', 'the conversation''s account');
reset role;
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('capsule')::text,
	'a new conversation starts on the login with room');
update public.qorpera_member_session_accounts set connection_id = pg_temp.r768('plan'), sponsor_binding_id = pg_temp.r768('planBinding')
where session_id = current_setting('qorpera_test.r768_session')::uuid and user_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.plan764_expect(pg_temp.r768_session_account(), 'ok', 'the conversation''s account');
reset role;
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('plan')::text,
	'a conversation on the plan keeps it at its limit');
-- Also once its login needs a new sign-in: it cannot pay until the member signs in again, and the conversation
-- never moves to another account on its own (20260930059000).
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '76400000-0000-4000-8000-000000000150';
select pg_temp.plan764_expect(pg_temp.r768_session_account(), 'ok', 'the conversation''s account');
reset role;
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('plan')::text,
	'a conversation keeps its plan while its login needs a new sign-in');
update public.qorpera_model_logins set status = 'active' where id = '76400000-0000-4000-8000-000000000150';
-- The other way round: the plan has room and the native login reaches its limit. Work never moves onto the
-- plan because of that: its conversation keeps the native login, and its follow-up work stays on it.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('plan');
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('capsule'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule');
update public.qorpera_member_session_accounts set connection_id = pg_temp.r768('capsule'),
	sponsor_binding_id = pg_temp.r768('capsuleBinding')
where session_id = current_setting('qorpera_test.r768_session')::uuid and user_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.plan764_expect(pg_temp.r768_session_account(), 'ok', 'the conversation''s account');
reset role;
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('capsule')::text,
	'a conversation whose native login reached its limit does not move to the plan');
do $$
declare v_choice uuid;
begin
	if exists (select 1 from public.qorpera_eligible_member_accounts('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001') as account where account.connection_id = pg_temp.r768('capsule')) then
		raise exception 'a native login at its limit stayed eligible'; end if;
	select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', pg_temp.r768('capsuleBinding'));
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'follow-up work of a native run at its limit moved to: %', v_choice; end if;
	-- New work, tied to no login, may start on the plan with room.
	select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', null);
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'new work did not start on the plan with room: %', v_choice; end if;
end $$;
-- Both at their limit, the plan's payer the newer one: follow-up work of a conversation on the native login
-- stays on that login and never moves to the plan.
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('plan'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('plan');
set local session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set created_at = clock_timestamp() + interval '1 minute'
where binding_id = pg_temp.r768('planBinding');
set local session_replication_role = origin;
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_create_member_execution_sponsor(%L,%L,%L,%s,false)::text',
	'92400000-0000-4000-8000-000000000010', '76800000-0000-4000-8000-000000000013', pg_temp.r768('capsule'),
	current_setting('qorpera_test.r768_capsule_version')::bigint)),
	'ok', 'a conversation payer on the native login');
select set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
	|| jsonb_build_object('capsuleChatBinding', current_setting('qorpera_test.plan764_last')::jsonb ->> 'binding_id'))::text, false);
reset role;
do $$
declare v_choice uuid;
begin
	select binding_id into v_choice from public.qorpera_starter_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', pg_temp.r768('capsuleChatBinding'));
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'follow-up work of a native conversation at its limit moved to: %', v_choice; end if;
end $$;
-- Back to the plan at its limit and the native login with room, for the checks below.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('capsule');

-- (5. Retrying a failed run on the plan: qorpera_resolve_failed_execution_run retries only snapshot-v1 session turns, so
-- a folder-v2 run is retried by nobody, its plan's member included. 6. A snapshot-v1 proposal review's retry is gone.)

-- 7. One usable plan per member: no second ChatGPT account is connected beside the member's plan login,
-- neither when its sign-in begins nor when it completes (the first login lapsed in between, then came back).
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76800000-0000-4000-8000-000000000031','76800000-0000-4000-8000-000000000032',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-768'::bytea),'hex'))),
	'55000:Disconnect your other ChatGPT plan first','a second plan beside a usable one');
reset role;
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '76400000-0000-4000-8000-000000000150';
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76800000-0000-4000-8000-000000000031','76800000-0000-4000-8000-000000000032',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-768'::bytea),'hex'))),
	'ok','a second plan once the first lapsed');
select set_config('qorpera_test.r768_second', pg_temp.plan764_last() ->> 'login_id', false);
reset role;
update public.qorpera_model_logins set status = 'active' where id = '76400000-0000-4000-8000-000000000150';
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_complete('qorpera_complete_chatgpt_plan_sign_in',
	current_setting('qorpera_test.r768_second'),'plan-768','76800000-0000-4000-8000-000000000033','plan-768-envelope'::bytea,
	clock_timestamp() + interval '20 minutes'),'55000:Disconnect your other ChatGPT plan first',
	'completing a second plan once the first came back');
reset session authorization;
-- Two completions of one member's plan sign-ins never run side by side: a completion holds a lock per member
-- and company to its end. The fixture's plan completion holds it here, so another connection cannot take it.
select dblink_connect('r768_lock', 'dbname=' || current_database());
select pg_temp.plan764_expect((select taken::text from dblink('r768_lock', $q$select pg_try_advisory_lock(hashtextextended(
	'qorpera-chatgpt-plan:92400000-0000-4000-8000-000000000010:92400000-0000-4000-8000-000000000001', 0))$q$)
	as attempt(taken boolean)), 'false', 'a completion holds the member''s lock to its end');
select dblink_disconnect('r768_lock');
-- A plan on a revoked connection is not the member's plan any more: a new sign-in begins.
update public.qorpera_provider_connections set status = 'revoked' where id = pg_temp.r768('plan');
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'92400000-0000-4000-8000-000000000010','76800000-0000-4000-8000-000000000041','76800000-0000-4000-8000-000000000042',
	current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-768-b'::bytea),'hex'))),
	'ok','a new plan once the old plan''s connection is revoked');
reset role;
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.r768('plan');

-- 8. A coding worker takes the member's other login before the newer plan (the plan has room again; the native login
-- too).
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('plan');
do $$
begin
	if (select connection_id from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex')) is distinct from pg_temp.r768('capsule') then
		raise exception 'coding took the plan before the member''s other login'; end if;
end $$;

-- 9. Plan use stops for a company being deleted.
select set_config('request.jwt.claims',
	'{"sub":"92400000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''92400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'true','available before the deletion');
reset role;
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''92400000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','not while the company is being deleted');
reset role;

rollback;
