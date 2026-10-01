-- @fixture 764_chatgpt_plan_login.test.sql until "-- A plan login is never listed for the account record the node switch-off reads; the Codex login is."
-- Sign in with ChatGPT, slice 1b (20260929880000): the rules a member's ChatGPT plan login keeps. Test 764's
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
	'select public.qorpera_consent_provider_connection_autonomous(%L,%L,true)::text',
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
	-- Follow-up work of a run the plan pays for stays on the plan; the limit stops it there.
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', pg_temp.r768('planBinding'));
	if v_choice is distinct from pg_temp.r768('planBinding') then
		raise exception 'follow-up work moved off the plan at its limit: %', v_choice; end if;
	-- New work not tied to the plan starts on the login with room.
	select binding_id into v_choice from public.qorpera_starter_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000030', null);
	if v_choice is distinct from pg_temp.r768('capsuleBinding') then
		raise exception 'new work did not start on the login with room: %', v_choice; end if;
	-- The plan stays eligible for the conversations it pays for; a new one starts on the login with room.
	if not exists (select 1 from public.qorpera_eligible_member_accounts('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001') as account
		where account.connection_id = pg_temp.r768('plan') and account.remaining = 0) then
		raise exception 'the plan at its limit left its conversations'; end if;
	if (public.qorpera_member_first_run_sponsor('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001') ->> 'sponsorBindingId')::uuid
		in (select binding_id from public.qorpera_execution_sponsor_versions where provider_connection_id = pg_temp.r768('plan')) then
		raise exception 'a new conversation started on the plan at its limit'; end if;
end $$;
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
-- A Codex login at its limit still leaves the list (unchanged).
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select pg_temp.r768('capsule'), max(version), jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 100)))
from public.qorpera_provider_connection_versions where connection_id = pg_temp.r768('capsule');
do $$
begin
	if exists (select 1 from public.qorpera_eligible_member_accounts('16000000-0000-4000-8000-000000000010',
		'16000000-0000-4000-8000-000000000001') as account where account.connection_id = pg_temp.r768('capsule')) then
		raise exception 'a Codex login at its limit stayed eligible'; end if;
end $$;

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
-- login now; their change's review failed; an admin who is not its author may not retry it on that plan.
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

-- 7. Plan use stops for a company being deleted.
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
