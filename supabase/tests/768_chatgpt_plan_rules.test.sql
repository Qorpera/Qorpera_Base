-- @fixture 764_chatgpt_plan_login.test.sql until "-- A plan login is never listed for the account record the node switch-off reads; the Codex login is."
-- Sign in with ChatGPT, slice 1b (20260928359950): the rules a member's ChatGPT plan login keeps. Test 764's
-- fixture leaves the member with a completed plan login (not consented for work while they are away) and a
-- Codex vault login, next to test 160's capsule login that pays for the fixture's run.
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
		'capsule', (current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id'))::text, false);
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
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_set_chatgpt_plan_work_while_away(%L,%L,true)::text',
	'16000000-0000-4000-8000-000000000010', pg_temp.r768('plan'))), 'ok', 'the member turns on work while away');
reset role;
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_binding uuid; v_version bigint;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	select sponsor.binding_id, sponsor.version into v_binding, v_version
	from public.qorpera_ensure_unattended_sponsor(v_run) as sponsor;
	if v_binding is null or not public.qorpera_sponsor_version_is_chatgpt_plan(v_binding, v_version) then
		raise exception 'a consented plan login does not pay for its member''s routine'; end if;
	perform set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
		|| jsonb_build_object('planBinding', v_binding, 'planVersion', v_version))::text, false);
end $$;

-- 3. A plan never pays for a listener: a file change or an event (a webhook, mail) is anyone's activity.
-- Refused when the routine is saved; the same routine on a Codex login meets only the listener's own checks.
insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, created_by_user_id)
values ('76800000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020', '76800000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001');
create function pg_temp.r768_routine(p_version bigint, p_triggers jsonb, p_binding uuid, p_sponsor_version bigint)
returns text language plpgsql as $$
begin
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values ('76800000-0000-4000-8000-000000000001', p_version, extensions.gen_random_uuid(),
		'16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020', '16000000-0000-4000-8000-000000000030',
		'Watch', 'Look at what changed.', p_triggers, 'medium', p_binding, p_sponsor_version, repeat('a', 64),
		'16000000-0000-4000-8000-000000000001');
	return 'ok';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
do $$
declare v_event jsonb := '[{"id":"on-event","kind":"listener","source":"event","hookId":"76800000-0000-4000-8000-000000000003","replyPolicy":"optional"}]';
	v_file jsonb := '[{"id":"on-file","kind":"listener","source":"company-file","path":"notes/today.md","replyPolicy":"optional"}]';
	v_codex jsonb := current_setting('qorpera_test.native_sponsor')::jsonb;
begin
	perform pg_temp.plan764_expect(pg_temp.r768_routine(1, v_event, pg_temp.r768('planBinding'),
		(current_setting('qorpera_test.r768')::jsonb ->> 'planVersion')::bigint),
		'42501:A ChatGPT plan cannot pay for a listener', 'an event listener on a plan');
	perform pg_temp.plan764_expect(pg_temp.r768_routine(2, v_file, pg_temp.r768('planBinding'),
		(current_setting('qorpera_test.r768')::jsonb ->> 'planVersion')::bigint),
		'42501:A ChatGPT plan cannot pay for a listener', 'a file listener on a plan');
	perform pg_temp.plan764_expect(pg_temp.r768_routine(3, v_event, (v_codex ->> 'binding_id')::uuid,
		(v_codex ->> 'version')::bigint), '42501:Event listener hook is unavailable', 'an event listener on a Codex login');
end $$;

-- (Section 4 shows the same rule when a routine wakes.)

-- 4. A plan is never swapped at its usage limit. The member's capsule login comes back with room left and
-- may pay for work while away; the plan reaches its limit.
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.r768('capsule');
select set_config('qorpera_test.r768_capsule_version', (select max(version)::text
	from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule')), false);
select set_config('qorpera_test.r768_plan_version', (select max(version)::text
	from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('plan')), false);
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_consent_provider_connection_autonomous(%L,%L,true)::text',
	'16000000-0000-4000-8000-000000000010', pg_temp.r768('capsule'))), 'ok', 'the capsule login may work while away');
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_create_member_execution_sponsor(%L,%L,%L,%s,true)::text',
	'16000000-0000-4000-8000-000000000010', '76800000-0000-4000-8000-000000000011', pg_temp.r768('capsule'),
	current_setting('qorpera_test.r768_capsule_version')::bigint + 1)),
	'ok', 'an autonomous payer on the capsule login');
select set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
	|| jsonb_build_object('capsuleBinding', current_setting('qorpera_test.plan764_last')::jsonb ->> 'binding_id'))::text, false);
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_create_member_execution_sponsor(%L,%L,%L,%s,false)::text',
	'16000000-0000-4000-8000-000000000010', '76800000-0000-4000-8000-000000000012', pg_temp.r768('plan'),
	current_setting('qorpera_test.r768_plan_version')::bigint)),
	'ok', 'a conversation payer on the plan');
select set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
	|| jsonb_build_object('planChatBinding', current_setting('qorpera_test.plan764_last')::jsonb ->> 'binding_id'))::text, false);
reset role;
-- An event routine on the capsule login is fine. Its wake passes there; the same wake moved onto the plan
-- (a routine's login can move later) is refused.
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, created_by_user_id)
values ('76800000-0000-4000-8000-000000000031', '16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020',
	'orders', 'New orders', 'address', repeat('h', 43), '16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, created_by_user_id)
values ('76800000-0000-4000-8000-000000000032', '16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020', '76800000-0000-4000-8000-000000000033', '16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
	staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
values ('76800000-0000-4000-8000-000000000032', 1, extensions.gen_random_uuid(), '16000000-0000-4000-8000-000000000010',
	'16000000-0000-4000-8000-000000000020', '16000000-0000-4000-8000-000000000030', 'Orders', 'Handle the new order.',
	'[{"id":"on-order","kind":"listener","source":"event","hookId":"76800000-0000-4000-8000-000000000031","timeZone":"Europe/Copenhagen","replyPolicy":"optional"}]',
	'medium', pg_temp.r768('capsuleBinding'), 1, repeat('b', 64), '16000000-0000-4000-8000-000000000001');
update public.qorpera_cloud_routines set current_version = 1 where id = '76800000-0000-4000-8000-000000000032';
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences
	where run_id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	v_wake := jsonb_populate_record(v_wake, jsonb_build_object('wake_kind', 'routine', 'source_kind', 'event',
		'source_id', '76800000-0000-4000-8000-000000000031', 'routine_id', '76800000-0000-4000-8000-000000000032',
		'routine_version', 1, 'trigger_id', 'on-order', 'session_id', null, 'run_id', null, 'parent_run_id', null,
		'sponsor_binding_id', pg_temp.r768('capsuleBinding'), 'sponsor_version', 1));
	if not public.qorpera_wake_authorized(v_wake) then
		raise exception 'the event routine''s wake on the capsule login is refused'; end if;
	-- The routine's binding moves on to the member's plan (as a handoff or a login move makes a newer version).
	insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id)
	select pg_temp.r768('capsuleBinding'), 2, 'member_connection', pg_temp.r768('plan'), max(version), true,
		'16000000-0000-4000-8000-000000000001'
	from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('plan');
	if public.qorpera_wake_authorized(jsonb_populate_record(v_wake, '{"sponsor_version":2}')) then
		raise exception 'a plan paid for an event wake'; end if;
	-- (The newer version goes again for the checks below.)
	delete from public.qorpera_execution_sponsor_versions where binding_id = pg_temp.r768('capsuleBinding') and version = 2;
end $$;
-- Nor does a plan pay for any work that follows from a listener run (a coworker message, a worker). The
-- fixture's run stands in for the listener run: a coworker's wake it causes, paid by the plan, passes while its
-- own wake was a member's input, and is refused once that wake was an event's or a file change's.
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_id uuid := extensions.gen_random_uuid();
	v_run uuid := (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
	v_ancestry jsonb;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run;
	v_wake := jsonb_populate_record(v_wake, jsonb_build_object('id', v_id, 'run_id', null, 'parent_run_id', v_run,
		'wake_kind', 'agent', 'source_kind', 'coworker', 'source_id', extensions.gen_random_uuid(), 'session_id', null,
		'staff_agent_id', '16000000-0000-4000-8000-000000000031', 'causal_hop_count', 1, 'trigger_id', 'coworker',
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
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768('planBinding'));
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'follow-up work moved off the plan at its limit: %', v_choice; end if;
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768('planChatBinding'));
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'follow-up work of a conversation on the plan moved off it: %', v_choice; end if;
	-- New work not tied to the plan starts on the login with room.
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', null);
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'new work did not start on the login with room: %', v_choice; end if;
	-- At its limit the plan is not taken for new work (a first run, a founding), as before.
	if exists (select 1 from public.qorpera_eligible_member_accounts('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001') as account where account.connection_id = pg_temp.r768('plan')) then
		raise exception 'the plan at its limit is offered for new work'; end if;
	if (public.qorpera_member_first_run_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001') ->> 'sponsorBindingId')::uuid
		in (select binding_id from public.qorpera_execution_sponsor_versions where provider_connection_id = pg_temp.r768('plan')) then
		raise exception 'a new conversation started on the plan at its limit'; end if;
end $$;
-- The kept plan stays the payer also when another login reports room (here the capsule login, half used).
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('capsule'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 50)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule');
do $$
declare v_choice uuid; v_binding text;
begin
	foreach v_binding in array array['planBinding', 'planChatBinding'] loop
		select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
			'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768(v_binding));
		if v_choice is distinct from pg_temp.r768('planBinding') then
			raise exception 'follow-up work of a run on % moved to a login with room: %', v_binding, v_choice; end if;
	end loop;
end $$;
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('capsule');
-- A conversation's account: a new conversation starts on the login with room; one the plan pays for keeps it.
delete from public.qorpera_member_session_accounts
where session_id = '16000000-0000-4000-8000-000000000040' and user_id = '16000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_select_member_session_account(''16000000-0000-4000-8000-000000000010'',''16000000-0000-4000-8000-000000000040'')::text'),
	'ok', 'the conversation''s account');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('capsule')::text,
	'a new conversation starts on the login with room');
reset role;
update public.qorpera_member_session_accounts set connection_id = pg_temp.r768('plan'), sponsor_binding_id = pg_temp.r768('planBinding')
where session_id = '16000000-0000-4000-8000-000000000040' and user_id = '16000000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_select_member_session_account(''16000000-0000-4000-8000-000000000010'',''16000000-0000-4000-8000-000000000040'')::text'),
	'ok', 'the conversation''s account');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('plan')::text,
	'a conversation on the plan keeps it at its limit');
reset role;
-- Also once its login needs a new sign-in: it cannot pay until the member signs in again, and the conversation
-- never moves to another account on its own (20260930048000).
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '76400000-0000-4000-8000-000000000150';
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_select_member_session_account(''16000000-0000-4000-8000-000000000010'',''16000000-0000-4000-8000-000000000040'')::text'),
	'ok', 'the conversation''s account');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('plan')::text,
	'a conversation keeps its plan while its login needs a new sign-in');
reset role;
update public.qorpera_model_logins set status = 'active' where id = '76400000-0000-4000-8000-000000000150';
-- The other way round: the plan has room and the Codex login reaches its limit. Work never moves onto the
-- plan because of that: its conversation keeps the Codex login, and its follow-up work stays on it.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('plan');
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('capsule'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule');
update public.qorpera_member_session_accounts set connection_id = pg_temp.r768('capsule'),
	sponsor_binding_id = pg_temp.r768('capsuleBinding')
where session_id = '16000000-0000-4000-8000-000000000040' and user_id = '16000000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_select_member_session_account(''16000000-0000-4000-8000-000000000010'',''16000000-0000-4000-8000-000000000040'')::text'),
	'ok', 'the conversation''s account');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'), pg_temp.r768('capsule')::text,
	'a conversation whose Codex login reached its limit does not move to the plan');
reset role;
do $$
declare v_choice uuid;
begin
	if exists (select 1 from public.qorpera_eligible_member_accounts('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001') as account where account.connection_id = pg_temp.r768('capsule')) then
		raise exception 'a Codex login at its limit stayed eligible'; end if;
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768('capsuleBinding'));
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'follow-up work of a Codex run at its limit moved to: %', v_choice; end if;
	-- New work, tied to no login, may start on the plan with room.
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', null);
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'new work did not start on the plan with room: %', v_choice; end if;
end $$;
-- Both at their limit, the plan's payer the newer one: follow-up work of a conversation on the Codex login
-- stays on that login and never moves to the plan.
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('plan'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('plan');
set local session_replication_role = replica;
update public.qorpera_execution_sponsor_versions set created_at = clock_timestamp() + interval '1 minute'
where binding_id = pg_temp.r768('planBinding');
set local session_replication_role = origin;
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_create_member_execution_sponsor(%L,%L,%L,%s,false)::text',
	'16000000-0000-4000-8000-000000000010', '76800000-0000-4000-8000-000000000013', pg_temp.r768('capsule'),
	current_setting('qorpera_test.r768_capsule_version')::bigint + 1)),
	'ok', 'a conversation payer on the capsule login');
select set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
	|| jsonb_build_object('capsuleChatBinding', current_setting('qorpera_test.plan764_last')::jsonb ->> 'binding_id'))::text, false);
reset role;
do $$
declare v_choice uuid;
begin
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768('capsuleChatBinding'));
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'follow-up work of a Codex conversation at its limit moved to: %', v_choice; end if;
end $$;
-- Back to the plan at its limit and the capsule login with room, for the retries below.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('capsule');

-- 5. Only the member whose plan pays tries a failed run again: the fixture's run, failed on the plan.
update public.qorpera_execution_runs set sponsor_binding_id = pg_temp.r768('planBinding'),
	sponsor_version = (current_setting('qorpera_test.r768')::jsonb ->> 'planVersion')::bigint
where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid;
update public.qorpera_runner_jobs set status = 'failed', last_error = 'Native provider bridge request failed (422)'
where id = (current_setting('qorpera_test.plan764_binding')::jsonb ->> 'jobId')::uuid;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_resolve_failed_execution_run(%L,''retry'')::text',
	current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')),
	'55000:execution recovery action is unavailable', 'another member retries a run the plan pays for');
-- Acknowledging it stays open to them: nothing runs.
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_resolve_failed_execution_run(%L,''acknowledge'')::text',
	current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')), 'ok', 'another member acknowledges it');
reset role;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format(
	'select public.qorpera_resolve_failed_execution_run(%L,''retry'')::text',
	current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')), 'ok', 'the member retries their own run');
reset role;

-- 6. Only the member who started a change retries its review on their plan. The member's plan is their only
-- login while the change is submitted; its review fails; an admin who is not its author may not retry it on
-- that plan. The capsule login is back with room when the author retries: the review stays on the plan.
update public.qorpera_provider_connections set status = 'revoked' where id = pg_temp.r768('capsule');
update public.qorpera_profile_members set role = 'admin'
where profile_id = '16000000-0000-4000-8000-000000000010' and user_id = '16000000-0000-4000-8000-000000000002';
insert into public.qorpera_company_proposals(id, profile_id, environment_id, client_proposal_id, proposal_snapshot_id,
	execution_kind, execution_id, execution_claimant_id, trail_end_sequence, reason, title, reviewer_staff_ids, created_by_user_id)
values ('76800000-0000-4000-8000-000000000021', '16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020',
	'76800000-0000-4000-8000-000000000022', '16000000-0000-4000-8000-000000000023', 'run',
	(current_setting('qorpera_test.plan764_binding')::jsonb ->> 'runId')::uuid, '76800000-0000-4000-8000-000000000023', 0,
	'policy', 'A change', array['16000000-0000-4000-8000-000000000030']::uuid[], '16000000-0000-4000-8000-000000000001');
-- The submission's revision 1 seeds its review, paid by the author's plan.
update public.qorpera_company_proposal_review_assignments set status = 'failed', failure_reason = 'The review did not finish',
	completed_at = statement_timestamp()
where proposal_id = '76800000-0000-4000-8000-000000000021';
do $$
begin
	if not exists (select 1 from public.qorpera_company_proposal_review_assignments as review
		where review.proposal_id = '76800000-0000-4000-8000-000000000021' and review.status = 'failed'
			and public.qorpera_sponsor_version_is_chatgpt_plan(review.reviewer_sponsor_binding_id, review.reviewer_sponsor_version)) then
		raise exception 'the review did not run on the author''s plan'; end if;
	perform set_config('qorpera_test.r768_review', (select id::text from public.qorpera_company_proposal_review_assignments
		where proposal_id = '76800000-0000-4000-8000-000000000021'), false);
end $$;
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.r768('capsule');
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_retry_company_proposal_review(%L)::text',
	current_setting('qorpera_test.r768_review'))),
	'42501:only the member whose ChatGPT plan pays may retry this review', 'an admin retries another member''s review on their plan');
reset role;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_retry_company_proposal_review(%L)::text',
	current_setting('qorpera_test.r768_review'))), 'ok', 'the author retries the review on their own plan');
reset role;
do $$
begin
	if not exists (select 1 from public.qorpera_company_proposal_review_assignments as review
		where review.id = current_setting('qorpera_test.r768_review')::uuid and review.status = 'queued'
			and review.reviewer_sponsor_binding_id = pg_temp.r768('planBinding')) then
		raise exception 'the retried review moved off the author''s plan: %', (select to_jsonb(review)
			from public.qorpera_company_proposal_review_assignments as review
			where review.id = current_setting('qorpera_test.r768_review')::uuid); end if;
end $$;

-- 7. One usable plan per member: no second ChatGPT account is connected beside the member's plan login,
-- neither when its sign-in begins nor when it completes (the first login lapsed in between, then came back).
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76800000-0000-4000-8000-000000000031','76800000-0000-4000-8000-000000000032',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-768'::bytea),'hex'))),
	'55000:Disconnect your other ChatGPT plan first','a second plan beside a usable one');
reset role;
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '76400000-0000-4000-8000-000000000150';
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76800000-0000-4000-8000-000000000031','76800000-0000-4000-8000-000000000032',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-768'::bytea),'hex'))),
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
	'qorpera-chatgpt-plan:16000000-0000-4000-8000-000000000010:16000000-0000-4000-8000-000000000001', 0))$q$)
	as attempt(taken boolean)), 'false', 'a completion holds the member''s lock to its end');
select dblink_disconnect('r768_lock');
-- A plan on a revoked connection is not the member's plan any more: a new sign-in begins.
update public.qorpera_provider_connections set status = 'revoked' where id = pg_temp.r768('plan');
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_begin_chatgpt_plan_sign_in(%L,%L,%L,%L,%L)::text',
	'16000000-0000-4000-8000-000000000010','76800000-0000-4000-8000-000000000041','76800000-0000-4000-8000-000000000042',
	current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id',encode(sha256('plan-768-b'::bytea),'hex'))),
	'ok','a new plan once the old plan''s connection is revoked');
reset role;
update public.qorpera_provider_connections set status = 'active' where id = pg_temp.r768('plan');

-- 8. A plan pays for follow-up work only of runs it pays for. The plan has room again; the capsule login too.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('plan');
-- A coding worker takes the member's other login before the newer plan.
do $$
begin
	if (select connection_id from public.qorpera_coding_owner_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', 'codex')) is distinct from pg_temp.r768('capsule') then
		raise exception 'coding took the plan before the member''s other login'; end if;
end $$;
-- A review the capsule login paid for, retried after that login reached its limit, stays on it (and stops there).
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('capsule'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule');
update public.qorpera_company_proposal_review_assignments set status = 'failed', failure_reason = 'The review did not finish',
	completed_at = statement_timestamp(), reviewer_sponsor_binding_id = pg_temp.r768('capsuleBinding'), reviewer_sponsor_version = 1
where id = current_setting('qorpera_test.r768_review')::uuid;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_retry_company_proposal_review(%L)::text',
	current_setting('qorpera_test.r768_review'))), 'ok', 'the author retries the capsule login''s review');
reset role;
do $$
begin
	if (select reviewer_sponsor_binding_id from public.qorpera_company_proposal_review_assignments
		where id = current_setting('qorpera_test.r768_review')::uuid) is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'a review the capsule login paid for moved to: %', (select to_jsonb(review)
			from public.qorpera_company_proposal_review_assignments as review
			where review.id = current_setting('qorpera_test.r768_review')::uuid); end if;
end $$;
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.r768('capsule');
-- The plan is the member's only login, and the company has an account for listeners. A listener run paid by
-- the company account: its follow-up work (a review of its change, a coworker's or a worker's wake) never takes
-- the plan; new work may.
update public.qorpera_provider_connections set status = 'revoked' where id = pg_temp.r768('capsule');
do $$
declare v_connection uuid := extensions.gen_random_uuid(); v_binding uuid := extensions.gen_random_uuid();
	v_source public.qorpera_provider_connection_versions%rowtype;
begin
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
	values (v_connection, '16000000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), null, 'openai',
		'16000000-0000-4000-8000-000000000001');
	select * into strict v_source from public.qorpera_provider_connection_versions
	where connection_id = pg_temp.r768('codex') order by version desc limit 1;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions, to_jsonb(v_source)
		|| jsonb_build_object('connection_id', v_connection, 'version', 1, 'allow_autonomous', true, 'authorization_state', 'active'))).*;
	insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
	values (v_binding, '16000000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), '16000000-0000-4000-8000-000000000001');
	insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id)
	values (v_binding, 1, 'company_service_account', v_connection, 1, true, '16000000-0000-4000-8000-000000000001');
	if not exists (select 1 from public.qorpera_company_account_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000030') as company where company.binding_id = v_binding) then
		raise exception 'the fixture has no company account'; end if;
	perform set_config('qorpera_test.r768', (current_setting('qorpera_test.r768')::jsonb
		|| jsonb_build_object('companyBinding', v_binding))::text, false);
end $$;
do $$
declare v_choice uuid;
begin
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768('companyBinding'));
	if v_choice is distinct from pg_temp.r768('companyBinding') then
		raise exception 'follow-up work of a company-paid run moved to: %', v_choice; end if;
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', null);
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'new work did not start on the plan: %', v_choice; end if;
	-- With no other login, coding takes the plan (dispatch then asks whether the run is the plan's; test 775).
	if (select connection_id from public.qorpera_coding_owner_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', 'codex')) is distinct from pg_temp.r768('plan') then
		raise exception 'coding did not take the member''s only login'; end if;
end $$;

-- 9. Plan use stops for a company being deleted.
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''16000000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'true','available before the deletion');
reset role;
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001');
set role authenticated;
select pg_temp.plan764_expect(pg_temp.plan764_try(
	'select public.qorpera_chatgpt_plan_available(''16000000-0000-4000-8000-000000000010'')::text'),'ok','availability');
select pg_temp.plan764_expect(current_setting('qorpera_test.plan764_last'),'false','not while the company is being deleted');
reset role;

rollback;
