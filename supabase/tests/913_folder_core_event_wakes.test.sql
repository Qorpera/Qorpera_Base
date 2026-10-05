-- @fixture 708_folder_state_routines.test.sql until "-- 2. A member's routine: its row, its version and its position"
-- Company folder core, E2a (migration 20260930061000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §4): event wakes
-- on folder-v2. A routine file with `when: event` compiles to W2's listener and gets its cursor; its rules refuse a hook
-- that is not a live hook of its company and a ChatGPT plan as payer; a unit that writes it takes the hook FOR SHARE at
-- rank 5; the drain makes one wake per routine trigger while verified deliveries wait (`only` filters them, a paused
-- company's wait, a removed hook's stop), with W2's key, payload and retries; the gate takes the wake while its hook
-- lives; the run's read carries the batch. On 708's company (Nora and Otto); rolled back at the end. Races are 923's.

create function pg_temp.saved(p_result jsonb) returns jsonb language plpgsql as $$
begin
	if p_result is null or exists (select 1 from jsonb_array_elements(p_result -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Fixture commit: %', p_result; end if;
	return p_result;
end $$;
create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.drain() returns jsonb language sql as $$
	select public.qorpera_folder_event_wakes_company('70700000-0000-4000-8000-000000000020')
$$;
create function pg_temp.due() returns boolean language sql as $$
	select public.qorpera_folder_event_wakes_due() -> 'items' @> '[{"environment_id":"70700000-0000-4000-8000-000000000020"}]'
$$;
create function pg_temp.ev(p_hook text, p_only jsonb default null) returns jsonb language sql as $$
	select jsonb_build_object('when','event','hook',p_hook,'only',p_only)
$$;
-- A verified delivery to a hook, received now.
create function pg_temp.deliver(p_hook uuid, p_type text, p_body text default '{"ok":true}') returns uuid language sql as $$
	insert into public.qorpera_event_deliveries(hook_id, profile_id, status, delivery_key, event_type, content_type, body, body_bytes,
		body_sha256, verified_at)
	values (p_hook, '70700000-0000-4000-8000-000000000010', 'verified', extensions.gen_random_uuid()::text, p_type, 'application/json',
		convert_to(p_body, 'UTF8'), octet_length(p_body), encode(extensions.digest(p_body, 'sha256'), 'hex'), clock_timestamp())
	returning id
$$;
-- The event wakes of a routine, oldest first.
create function pg_temp.ew(p_routine uuid) returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where routine_id = p_routine and source_kind = 'event' order by created_at, occurrence_key
$$;
create function pg_temp.ew_count(p_routine uuid) returns integer language sql as $$
	select count(*)::integer from public.qorpera_wake_occurrences where routine_id = p_routine and source_kind = 'event'
$$;
-- Wakes made earlier (by a wake's id, or a routine's): their identity is immutable, so with triggers off.
create function pg_temp.age(p_id text, p_by text) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_wake_occurrences set created_at = created_at - %L::interval
		where id = %L::uuid or routine_id = %L::uuid', p_by, p_id, p_id))
$$;
-- A wake ends without a run reading its batch (cancelled while queued), so the next attempt may come.
create function pg_temp.finish(p_wake uuid) returns void language sql as $$
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp() where id = p_wake
$$;

-- The company's hooks: Stripe's, a mailbox, a hook to remove and one of the company's that goes now.
insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute,
	created_by_user_id)
select h.id, '70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000020', h.name, h.purpose, h.proof,
	translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'), 65536, 60,
	'70700000-0000-4000-8000-000000000001'
from (values ('91300000-0000-4000-8000-0000000000b1'::uuid, 'stripe', 'Payments.', 'address'),
	('91300000-0000-4000-8000-0000000000b2'::uuid, 'mail-support', 'Support mail.', 'mail'),
	('91300000-0000-4000-8000-0000000000b3'::uuid, 'forms', 'Form posts.', 'address'),
	('91300000-0000-4000-8000-0000000000b4'::uuid, 'gone', 'Removed.', 'address')) h(id, name, purpose, proof);
update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp() where id = '91300000-0000-4000-8000-0000000000b4';

-- 1. The file: `when: event`, its shape, W2's trigger and the cursor --------------------------------------------------------

do $$
declare r jsonb; v_cursor public.qorpera_event_listener_cursors;
begin
	-- The shape: a lowercase hook id, only null or 1 to 20 distinct printable types, and exactly hook, only and when.
	perform pg_temp.is(public.qorpera_company_state_parse_problems('routine', pg_temp.rparse('91300000-0000-4000-8000-0000000000e1',
		'Payments', pg_temp.ev('91300000-0000-4000-8000-0000000000b1', '["payment_intent.succeeded","charge.refunded"]')))::text,
		'[]', 'an event routine''s parse');
	if exists (select 1 from (values (pg_temp.ev('91300000-0000-4000-8000-0000000000B1')),
			(pg_temp.ev('91300000-0000-4000-8000-0000000000b1', '[]')),
			(pg_temp.ev('91300000-0000-4000-8000-0000000000b1', '["a.b","a.b"]')),
			(pg_temp.ev('91300000-0000-4000-8000-0000000000b1', '["two words"]')),
			(pg_temp.ev('91300000-0000-4000-8000-0000000000b1', '"a.b"')),
			(pg_temp.ev('91300000-0000-4000-8000-0000000000b1') - 'only'),
			(pg_temp.ev('91300000-0000-4000-8000-0000000000b1') || '{"watch":"docs"}')) t(trigger)
		where not exists (select 1 from jsonb_array_elements(public.qorpera_company_state_parse_problems('routine',
			pg_temp.rparse('91300000-0000-4000-8000-0000000000e1', 'Payments', t.trigger))) p
			where p.value ->> 'message' = 'the platform read this file differently from its rules (trigger)')) then
		raise exception 'A malformed event trigger is a trigger problem'; end if;
	-- Nora listens to Stripe's payments, Otto to the mailbox.
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'event-0001', jsonb_build_array(
		pg_temp.routine('agents/nora/routines/payments.md', pg_temp.rparse('91300000-0000-4000-8000-0000000000e1', 'Payments',
			pg_temp.ev('91300000-0000-4000-8000-0000000000b1', '["payment_intent.succeeded","charge.refunded"]'))),
		pg_temp.routine('agents/otto/routines/support.md', pg_temp.rparse('91300000-0000-4000-8000-0000000000e2', 'Support',
			pg_temp.ev('91300000-0000-4000-8000-0000000000b2'))))));
	perform pg_temp.is((pg_temp.rv('91300000-0000-4000-8000-0000000000e1')).triggers::text,
		'[{"id": "file", "kind": "listener", "only": ["payment_intent.succeeded", "charge.refunded"], "hookId": '
			|| '"91300000-0000-4000-8000-0000000000b1", "source": "event", "timeZone": "Europe/Copenhagen", "replyPolicy": "optional"}]',
		'W2''s trigger');
	perform pg_temp.is(((pg_temp.rv('91300000-0000-4000-8000-0000000000e2')).triggers -> 0 ? 'only')::text, 'false',
		'no only, no filter');
	select * into v_cursor from public.qorpera_event_listener_cursors where routine_id = '91300000-0000-4000-8000-0000000000e1';
	if v_cursor.hook_id is distinct from '91300000-0000-4000-8000-0000000000b1' or not v_cursor.active
		or v_cursor.routine_version <> (pg_temp.rt('91300000-0000-4000-8000-0000000000e1')).current_version then
		raise exception 'The listener''s cursor: %', to_jsonb(v_cursor); end if;
	-- Nothing delivered yet: not due, and a step is done with nothing to do.
	if pg_temp.due() then raise exception 'Due with nothing delivered'; end if;
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '0', 'nothing waits');
end $$;

-- 2. The rules: a live hook of this company, no ChatGPT plan paying; the hook at rank 5 ------------------------------------

do $$
declare r jsonb; v_trigger jsonb; v_capsule uuid;
begin
	-- A removed hook, and an id that is no hook of this company.
	foreach v_trigger in array array[pg_temp.ev('91300000-0000-4000-8000-0000000000b4'), pg_temp.ev('91300000-0000-4000-8000-0000000000ff')] loop
		r := pg_temp.commit(pg_temp.owner(), 'event-rule-' || (v_trigger ->> 'hook'), jsonb_build_array(pg_temp.routine('agents/nora/routines/gone.md',
			pg_temp.rparse('91300000-0000-4000-8000-0000000000e3', 'Gone', v_trigger))));
		if not pg_temp.refused(r, 'structured_rule')
			or pg_temp.problem(r) not like 'hook 91300000-0000-4000-8000-0000000000_% is not a hook or mailbox of this company; list_hooks shows them' then
			raise exception 'A routine on no live hook of this company: %', r; end if;
	end loop;
	-- The owner's login as a ChatGPT plan: it pays only for work its member starts.
	select credential_capsule_id into v_capsule from public.qorpera_provider_connection_versions
	where connection_id = '70800000-0000-4000-8000-0000000000c1' and version = 1;
	perform pg_temp.fx(format($q$insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id,
		broker_authority_id, provider, native_harness, current_version, access_issued_at, access_expires_at, login_kind)
		values (extensions.gen_random_uuid(), '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), %L,
			extensions.gen_random_uuid(), 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '1 hour', 'chatgpt_plan')$q$,
		v_capsule));
	r := pg_temp.commit(pg_temp.owner(), 'event-plan', jsonb_build_array(pg_temp.routine('agents/nora/routines/plan.md',
		pg_temp.rparse('91300000-0000-4000-8000-0000000000e4', 'Plan', pg_temp.ev('91300000-0000-4000-8000-0000000000b3')))));
	if not pg_temp.refused(r, 'structured_rule')
		or pg_temp.problem(r) <> 'a ChatGPT plan pays only for work its member starts; an event routine needs another AI login' then
		raise exception 'A plan pays for an event routine: %', r; end if;
	delete from public.qorpera_model_logins where credential_capsule_id = v_capsule;
	-- A unit that writes an event routine's file takes its hook FOR SHARE at rank 5 (923 races it against a removal).
	if not exists (select 1 from public.qorpera_folder_structured_targets('70700000-0000-4000-8000-000000000020', pg_temp.owner(),
			jsonb_build_array(pg_temp.routine('agents/nora/routines/forms.md', pg_temp.rparse('91300000-0000-4000-8000-0000000000e5',
				'Forms', pg_temp.ev('91300000-0000-4000-8000-0000000000b3')))))
		where rank = 5 and tbl = 'qorpera_event_hooks' and key = '91300000-0000-4000-8000-0000000000b3' and mode = 'share') then
		raise exception 'An event routine''s file does not take its hook at rank 5'; end if;
end $$;

-- 3. The drain: one wake per routine trigger while deliveries wait, W2's key and payload ----------------------------------

do $$
declare r jsonb; v_first uuid; w public.qorpera_wake_occurrences;
begin
	-- A type Nora's routine does not take: not due, and a step makes no wake; it is behind her listener after the step.
	perform pg_temp.deliver('91300000-0000-4000-8000-0000000000b1', 'customer.created');
	if pg_temp.due() then raise exception 'Due for a type its routine does not take'; end if;
	r := pg_temp.drain();
	perform pg_temp.is(r ->> 'state', 'done', 'a step');
	perform pg_temp.is(pg_temp.ew_count('91300000-0000-4000-8000-0000000000e1')::text, '0', 'only filters');
	-- Two payments: one wake, its key and payload W2's, its source the hook.
	v_first := pg_temp.deliver('91300000-0000-4000-8000-0000000000b1', 'payment_intent.succeeded');
	perform pg_temp.deliver('91300000-0000-4000-8000-0000000000b1', 'charge.refunded');
	if not pg_temp.due() then raise exception 'Not due with payments waiting'; end if;
	r := pg_temp.drain();
	perform pg_temp.is(r ->> 'wakes', '1', 'one wake for the batch');
	select * into strict w from pg_temp.ew('91300000-0000-4000-8000-0000000000e1');
	perform pg_temp.is(w.occurrence_key, 'event:' || (pg_temp.rt('91300000-0000-4000-8000-0000000000e1')).current_version
		|| ':file:' || v_first || ':1', 'W2''s occurrence key');
	perform pg_temp.is(w.source_id::text, '91300000-0000-4000-8000-0000000000b1', 'the wake''s source is the hook');
	perform pg_temp.is(w.payload::text, jsonb_build_object('hookId', '91300000-0000-4000-8000-0000000000b1',
		'firstDeliveryId', v_first)::text, 'W2''s payload');
	if w.wake_kind <> 'routine' or w.status <> 'queued' or w.staff_agent_id <> '70700000-0000-4000-8000-0000000000a1'
		or w.requested_by_user_id <> '70700000-0000-4000-8000-000000000001' then
		raise exception 'The wake as the pin trigger made it: %', to_jsonb(w); end if;
	-- The gate takes it while its hook lives.
	if not public.qorpera_folder_wake_authorized(w) then raise exception 'The gate refuses a folder-v2 event wake'; end if;
	-- One open wake per routine trigger: not due, and the step adds none.
	if pg_temp.due() then raise exception 'Due with a wake open'; end if;
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '0', 'one open wake at a time');
	-- Otto's mailbox: any type.
	perform pg_temp.deliver('91300000-0000-4000-8000-0000000000b2', 'mail.received');
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '1', 'the mailbox''s wake');
	perform pg_temp.is(pg_temp.ew_count('91300000-0000-4000-8000-0000000000e2')::text, '1', 'Otto''s wake');
end $$;

-- 4. The run reads its batch ---------------------------------------------------------------------------------------------

-- A leased run of a wake, as the materializer leaves it (P28), and the native rows its binding needs (as 887's).
create function pg_temp.event_run(p_wake uuid) returns jsonb language plpgsql as $$
declare w public.qorpera_wake_occurrences; v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
begin
	select * into strict w from public.qorpera_wake_occurrences where id = p_wake;
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, w.profile_id, w.environment_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn',
		'{}', w.requested_by_user_id, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, company_seq)
	values (v_run, w.profile_id, w.environment_id, 'wake', w.id, v_job, null, null,
		w.staff_agent_id, w.staff_version, w.sponsor_binding_id, w.sponsor_version, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
		w.requested_by_user_id, w.requested_by_user_id, 'openai', 'gpt-test', 'provider_default', 'company', extensions.gen_random_uuid(),
		repeat('b', 64), w.session_id, '{}', (select last_seq from public.qorpera_folder_clocks where environment_id = w.environment_id));
	update public.qorpera_wake_occurrences set run_id = v_run, status = 'materialized' where id = w.id;
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;
create function pg_temp.native(p_actor jsonb) returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_identity uuid := '91300000-0000-4000-8000-0000000000d1';
	v_lease uuid := extensions.gen_random_uuid(); v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_capsule uuid;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	select credential_capsule_id into strict v_capsule from public.qorpera_provider_connection_versions
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	set local session_replication_role = replica;
	insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, client_identity_id, display_name)
	values (v_identity, v_run.profile_id, 'company', v_identity, 'Event fixture') on conflict (id) do nothing;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (v_capsule, v_run.profile_id, v_identity, 'company', 'openai', 'codex-cli', 'fixture://not-a-credential', repeat('e', 64),
		v_run.created_by_user_id) on conflict (id) do nothing;
	insert into public.qorpera_runners(id, profile_id, client_runner_id, display_name, capabilities, status, activation_token_sha256,
		activation_expires_at, activated_at, session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id)
	values ((p_actor ->> 'runnerId')::uuid, v_run.profile_id, (p_actor ->> 'runnerId')::uuid, 'Event runner', '["agent_turn"]',
		'active', repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(), repeat('f', 64), clock_timestamp() + interval '1 hour',
		v_run.created_by_user_id, v_identity);
	insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
	values ((p_actor ->> 'assignmentId')::uuid, extensions.gen_random_uuid(), v_run.job_id, v_run.id, (p_actor ->> 'runnerId')::uuid,
		repeat('e', 64), 'accepted', clock_timestamp() + interval '1 hour', clock_timestamp());
	insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
	values (v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version, v_capsule,
		v_identity, (p_actor ->> 'runnerId')::uuid, (p_actor ->> 'assignmentId')::uuid, repeat('d', 64), clock_timestamp() + interval '1 hour');
	insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
		provider_connection_version, period_start, reserved_microusd)
	values (v_run.id, v_run.job_id, v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version, v_sponsor.provider_connection_id,
		v_sponsor.provider_connection_version, date_trunc('month', clock_timestamp()), 1);
	insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
		max_output_tokens, authorized_by_user_id)
	values (v_run.job_id, v_run.profile_id, v_run.environment_id, '["gpt-test"]', 32, 1000, 1000, v_run.created_by_user_id);
	insert into public.qorpera_execution_run_budgets(run_id) values (v_run.id);
	update public.qorpera_execution_runs set compute_identity_id = v_identity where id = v_run.id;
	set local session_replication_role = origin;
	return jsonb_build_object('leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', p_actor ->> 'runnerId',
		'assignmentId', p_actor ->> 'assignmentId', 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_identity,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test');
end $$;

do $$
declare w public.qorpera_wake_occurrences; a jsonb; e jsonb; again jsonb;
begin
	select * into strict w from pg_temp.ew('91300000-0000-4000-8000-0000000000e1');
	a := pg_temp.native(pg_temp.event_run(w.id));
	e := public.qorpera_read_native_wake(a);
	if e -> 'source' ->> 'kind' <> 'event' or e -> 'source' ->> 'id' <> '91300000-0000-4000-8000-0000000000b1'
		or e ->> 'actorUserId' is not null or e ->> 'parentRunId' is not null
		or e -> 'payload' -> 'hook' <> jsonb_build_object('id', '91300000-0000-4000-8000-0000000000b1', 'name', 'stripe', 'purpose', 'Payments.')
		or (select array_agg(x ->> 'type' order by x ->> 'receivedAt') from jsonb_array_elements(e -> 'payload' -> 'events') x)
			<> array['payment_intent.succeeded', 'charge.refunded']
		or e -> 'payload' -> 'events' -> 0 ->> 'text' <> '{"ok":true}' or (e -> 'payload' ->> 'more')::integer <> 0 then
		raise exception 'The run''s event wake: %', e; end if;
	-- The batch is the wake's: a read again gives the same events, and a payment after it waits for the next wake.
	perform pg_temp.deliver('91300000-0000-4000-8000-0000000000b1', 'payment_intent.succeeded', '{"late":true}');
	again := public.qorpera_read_native_wake(a);
	if again -> 'payload' -> 'events' <> e -> 'payload' -> 'events' or (again -> 'payload' ->> 'more')::integer <> 1 then
		raise exception 'A second read of the wake: %', again; end if;
	-- A run reading its batch is not pending any more: the late payment makes the next wake.
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '1', 'the next batch''s wake');
	perform pg_temp.is(pg_temp.ew_count('91300000-0000-4000-8000-0000000000e1')::text, '2', 'two wakes');
end $$;

-- 5. Retries, a paused company, a removed hook ------------------------------------------------------------------------------

do $$
declare w public.qorpera_wake_occurrences; v_first uuid;
begin
	-- Otto's wake ends without a run reading its batch: tried again after a minute, with the attempt in the key.
	select * into strict w from pg_temp.ew('91300000-0000-4000-8000-0000000000e2');
	perform pg_temp.finish(w.id);
	if pg_temp.due() then raise exception 'Due while the retry waits'; end if;
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '0', 'a retry waits a minute');
	perform pg_temp.age(w.id::text, '2 minutes');
	if not pg_temp.due() then raise exception 'Not due when the retry is'; end if;
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '1', 'then tries again');
	select * into strict w from pg_temp.ew('91300000-0000-4000-8000-0000000000e2') offset 1;
	if w.occurrence_key !~ ':2$' then raise exception 'The retry''s key: %', w.occurrence_key; end if;
	perform pg_temp.finish(w.id);
	-- A paused company's events wait: not due, the step writes nothing, and after the resume they wake.
	perform pg_temp.age('91300000-0000-4000-8000-0000000000e2', '1 hour');
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('70700000-0000-4000-8000-000000000010', '70700000-0000-4000-8000-000000000001', 'test');
	if pg_temp.due() then raise exception 'A paused company is due'; end if;
	perform pg_temp.is(pg_temp.drain() ->> 'state', 'paused', 'a paused company');
	perform pg_temp.is(pg_temp.ew_count('91300000-0000-4000-8000-0000000000e2')::text, '2', 'writes no wake');
	delete from public.qorpera_company_execution_pauses where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.drain() ->> 'wakes', '1', 'the events still wait after the resume');
	-- The mailbox removed: its open wake is refused at the gate, and nothing more wakes.
	select * into strict w from pg_temp.ew('91300000-0000-4000-8000-0000000000e2') offset 2;
	perform pg_temp.fx($q$update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp()
		where id = '91300000-0000-4000-8000-0000000000b2'$q$);
	if public.qorpera_folder_wake_authorized(w) then raise exception 'The gate takes a removed hook''s wake'; end if;
	perform pg_temp.finish(w.id);
	v_first := pg_temp.deliver('91300000-0000-4000-8000-0000000000b2', 'mail.received');
	perform pg_temp.age('91300000-0000-4000-8000-0000000000e2', '1 hour');
	perform pg_temp.is(coalesce(pg_temp.drain() ->> 'wakes', '0'), '0', 'a removed hook wakes nothing');
	-- A save that keeps the removed hook is refused by its rules. (A version made by a move or a handover asks no rules and
	-- is kept; its listener never wakes.)
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'event-0009', jsonb_build_array(pg_temp.routine('agents/otto/routines/support.md',
			pg_temp.rparse('91300000-0000-4000-8000-0000000000e2', 'Support again', pg_temp.ev('91300000-0000-4000-8000-0000000000b2'))))),
		'structured_rule') then
		raise exception 'A save keeps a removed hook'; end if;
end $$;

-- 6. A cursor that is no listener never takes a live listener's place (review r1 F1) ------------------------------------------

do $$
declare r jsonb; i integer;
begin
	-- Otto's cursor stays active on the removed mailbox, oldest of all; Nora's new routine on the forms hook has a post waiting.
	perform pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'event-0010', jsonb_build_array(pg_temp.routine('agents/nora/routines/forms.md',
		pg_temp.rparse('91300000-0000-4000-8000-0000000000e6', 'Forms', pg_temp.ev('91300000-0000-4000-8000-0000000000b3'))))));
	perform pg_temp.deliver('91300000-0000-4000-8000-0000000000b3', 'form.posted');
	update public.qorpera_event_listener_cursors set last_scanned_at = '-infinity' where routine_id = '91300000-0000-4000-8000-0000000000e2';
	update public.qorpera_event_listener_cursors set last_scanned_at = clock_timestamp()
	where routine_id not in ('91300000-0000-4000-8000-0000000000e2', '91300000-0000-4000-8000-0000000000e6');
	if not (select active from public.qorpera_event_listener_cursors where routine_id = '91300000-0000-4000-8000-0000000000e2') then
		raise exception 'The fixture: Otto''s cursor is active'; end if;
	if not pg_temp.due() then raise exception 'Not due with a form post waiting'; end if;
	-- One listener a step: the live one is taken, and repeated steps make progress (never idle while it waits).
	for i in 1..2 loop
		r := public.qorpera_folder_event_wakes_company('70700000-0000-4000-8000-000000000020', 1);
		perform pg_temp.is(r ->> 'state', 'done', 'step ' || i || ' with one listener a step');
		exit when pg_temp.ew_count('91300000-0000-4000-8000-0000000000e6') > 0;
	end loop;
	perform pg_temp.is(pg_temp.ew_count('91300000-0000-4000-8000-0000000000e6')::text, '1', 'the live listener wakes');
end $$;

-- 7. Grants -------------------------------------------------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated'] loop
		if has_function_privilege(v_role, 'public.qorpera_folder_event_wakes_due(uuid,integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_folder_event_wakes_company(uuid,integer)', 'EXECUTE') then
			raise exception 'The event drain is the platform''s alone (%)', v_role; end if;
	end loop;
	if not has_function_privilege('service_role', 'public.qorpera_folder_event_wakes_company(uuid,integer)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_folder_event_wake_pending(uuid,text)', 'EXECUTE')
		or has_function_privilege('service_role',
			'public.qorpera_folder_event_wake_tries(public.qorpera_event_listener_cursors,uuid)', 'EXECUTE')
		or has_function_privilege('service_role',
			'public.qorpera_folder_event_wake_retry_waits(public.qorpera_event_listener_cursors,uuid)', 'EXECUTE') then
		raise exception 'The event drain''s grants'; end if;
end $$;
