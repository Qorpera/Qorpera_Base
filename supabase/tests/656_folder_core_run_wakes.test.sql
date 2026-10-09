-- @fixture 647_folder_core_run_fence.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Company folder core, C1c-2c part 1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6): wake admission and
-- coworker messages on the folder fence. A folder-v2 wake needs the folder admission mark and its pin trigger locks
-- nothing; the routine lifecycle keeps its rules; a run's coworker message and its recipient's wake read have folder
-- bodies; the legacy multi-company loops skip folder-v2. Runs are 647's hand-built runs with their native rows. Races
-- are in 657.

create function pg_temp.cw(p_binding jsonb, p_to uuid, p_key text, p_text text, p_priority boolean default true) returns jsonb
language sql as $$
	select public.qorpera_send_coworker_message(p_binding, p_to, p_key, p_text, p_priority)
$$;
-- A human run of an agent in its company thread, with the native rows the runtime's binding needs. It has sent its
-- acknowledgement (the folder native send), so its tool calls may work.
create function pg_temp.human(p_staff uuid default '63400000-0000-4000-8000-0000000000a1') returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run(p_staff, 'human', '63400000-0000-4000-8000-000000000002'); b jsonb := pg_temp.native(p);
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid, (b ->> 'jobId')::uuid,
		(b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid, (b ->> 'computeIdentityId')::uuid,
		'openai', 'codex-cli', 'ack', 'On it.', 'progress');
	return jsonb_build_object('actor', p, 'binding', b);
end $$;
create function pg_temp.thread(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = p_staff
$$;
create function pg_temp.admitted() returns bigint language sql as $$
	select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010'
$$;
-- A hand-built routine of agent A (a one-time run, as an agent's dynamic routine is), with its version.
create function pg_temp.routine(p_origin text default 'member', p_max integer default null) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, current_version, status,
		created_by_user_id, origin, owner_staff_agent_id, routine_key, max_occurrences)
	values (v_id, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), 1,
		'active', '63400000-0000-4000-8000-000000000002', p_origin,
		case when p_origin = 'agent' then '63400000-0000-4000-8000-0000000000a1'::uuid end,
		case when p_origin = 'agent' then 'r-' || left(v_id::text, 8) end, p_max);
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
	values (v_id, 1, extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-0000000000a1', 'Check in', 'Check the numbers.',
		'[{"id":"t1","kind":"once","at":"2026-10-01T09:00:00Z","timeZone":"UTC"}]', 'medium',
		'63400000-0000-4000-8000-0000000000b1', 1, repeat('e', 64), '63400000-0000-4000-8000-000000000002');
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.routine_wake(p_routine uuid, p_key text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, routine_id, routine_version,
		trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (v_id, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'routine', 'schedule', p_routine, 1,
		't1', p_key, clock_timestamp(), clock_timestamp(), '{}');
	return v_id;
end $$;

-- The checks start here: a test that runs after this file's fixture part stops at this line.

-- 2. Admission: the admission row counts, and marks the transaction for its company. A wake without the mark refuses,
-- whatever else is wrong with it; since legacy sweep F1b (20260930245000) that includes a snapshot-v1 wake.
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010'; c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	h jsonb := pg_temp.human(); v_before bigint := pg_temp.admitted(); v_sql text; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	v_sql := format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, staff_agent_id,
		parent_run_id, sponsor_binding_id, sponsor_version, session_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values ('65600000-0000-4000-8000-0000000000e1', %L, %L, 'agent', 'coworker', %L, %L, '63400000-0000-4000-8000-0000000000b1', 1,
			%L, 'coworker', 'admission-test', clock_timestamp(), clock_timestamp(), '{}')$f$,
		c_profile, c_env, c_b, h -> 'actor' ->> 'runId', pg_temp.thread(c_b));
	perform pg_temp.raises_like(v_sql, '55000', 'Folder wake admission is required');
	-- Another company's mark is not this company's.
	perform set_config('qorpera.folder_wake_admission', '64700000-0000-4000-8000-000000000011', true);
	perform pg_temp.raises_like(v_sql, '55000', 'Folder wake admission is required');
	perform public.qorpera_folder_admit_wakes(c_profile);
	if pg_temp.admitted() <> v_before + 1 or current_setting('qorpera.folder_wake_admission', true) <> c_profile::text then
		raise exception 'Admission counts and marks its company'; end if;
	execute v_sql;
	select * into v_wake from public.qorpera_wake_occurrences where id = '65600000-0000-4000-8000-0000000000e1';
	if v_wake.status <> 'queued' or v_wake.staff_version <> 1 or v_wake.causal_hop_count <> 1
		or v_wake.requested_by_user_id <> '63400000-0000-4000-8000-000000000002'
		or v_wake.causal_agent_ids <> array['63400000-0000-4000-8000-0000000000a1'::uuid, c_b] then
		raise exception 'An admitted folder-v2 coworker wake: %', to_jsonb(v_wake); end if;
	-- The stop rule is today's: an autonomous wake admitted while paused is kept, cancelled with its reason.
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		c_profile, '63400000-0000-4000-8000-000000000001', 'test'));
	execute replace(replace(v_sql, '65600000-0000-4000-8000-0000000000e1', '65600000-0000-4000-8000-0000000000e2'),
		'admission-test', 'admission-paused');
	select * into v_wake from public.qorpera_wake_occurrences where id = '65600000-0000-4000-8000-0000000000e2';
	if v_wake.status <> 'cancelled' or v_wake.blocked_reason <> 'Company execution is paused' then
		raise exception 'A paused company''s autonomous wake is cancelled: %', to_jsonb(v_wake); end if;
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
	-- Folder-v2 only since legacy sweep F1b (20260930245000): a snapshot-v1 wake needs the folder's admission too, so it
	-- is refused by the folder mark before the schema check.
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform pg_temp.raises_like(format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind,
		wake_schema, trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values (extensions.gen_random_uuid(), '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', 'agent',
			'coworker', 'qorpera.unknown/v1', 'coworker', 'snapshot-control', clock_timestamp(), clock_timestamp(), '{}')$f$),
		'55000', 'Folder wake admission is required');
	perform pg_temp.raises_like(format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind,
		wake_schema, trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values (extensions.gen_random_uuid(), %L, %L, 'agent', 'coworker', 'qorpera.unknown/v1', 'coworker', 'folder-control',
			clock_timestamp(), clock_timestamp(), '{}')$f$, c_profile, c_env), '55000', 'Folder wake admission is required');
	-- An office activation (C1c-3l part 2, 20260930030100) and a machine event (C1c-3i-b, 20260930058000) serve folder-v2:
	-- an admitted one meets its own ancestry check, so these hand-built ones, with no waiter or event behind them, are
	-- refused there, not as an unsupported source.
	perform public.qorpera_folder_admit_wakes(c_profile);
	perform pg_temp.raises_like(replace(replace(replace(v_sql, '''agent'', ''coworker''', '''agent'', ''office-activation'''),
		'65600000-0000-4000-8000-0000000000e1', '65600000-0000-4000-8000-0000000000e3'), 'admission-test', 'admission-office'),
		'55000', 'Wake causal ancestry is fenced');
	perform pg_temp.raises_like(replace(replace(replace(v_sql, '''agent'', ''coworker''', '''agent'', ''machine-event'''),
		'65600000-0000-4000-8000-0000000000e1', '65600000-0000-4000-8000-0000000000e4'), 'admission-test', 'admission-machine'),
		'55000', 'Wake causal ancestry is fenced');
	perform set_config('qorpera.folder_wake_admission', '', true);
	-- A company that is not folder-v2 has no admission row.
	perform pg_temp.raises_like('select public.qorpera_folder_admit_wakes(''64700000-0000-4000-8000-000000000011'')', '42501',
		'Company folder is unavailable');
end $$;

-- 3. A routine wake on folder-v2: its public session is chosen as today's is, without locks; the lifecycle keeps its
-- rules (here the occurrence limit).
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010'; c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	v_routine uuid := pg_temp.routine('member', 1); v_id uuid; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	if public.qorpera_folder_wake_public_session(c_profile, c_env, c_a, '63400000-0000-4000-8000-000000000002')
		is distinct from public.qorpera_wake_public_session(c_profile, c_env, c_a, '63400000-0000-4000-8000-000000000002')
		or public.qorpera_folder_wake_public_session(c_profile, c_env, c_a, null) is distinct from pg_temp.thread(c_a) then
		raise exception 'The folder public session is today''s choice'; end if;
	perform pg_temp.raises_like(format('select pg_temp.routine_wake(%L, %L)', v_routine, 'once:1:1'), '55000',
		'Folder wake admission is required');
	perform public.qorpera_folder_admit_wakes(c_profile);
	v_id := pg_temp.routine_wake(v_routine, 'once:1:1');
	select * into v_wake from public.qorpera_wake_occurrences where id = v_id;
	if v_wake.status <> 'queued' or v_wake.session_id is distinct from pg_temp.thread(c_a) or v_wake.staff_agent_id <> c_a
		or v_wake.sponsor_binding_id <> '63400000-0000-4000-8000-0000000000b1' then
		raise exception 'A folder-v2 routine wake: %', to_jsonb(v_wake); end if;
	-- One occurrence allowed: the routine expired after it, and a second is refused by the lifecycle.
	if (select status from public.qorpera_cloud_routines where id = v_routine) <> 'expired' then
		raise exception 'The recorded trigger expires a routine at its limit'; end if;
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, expired_while_active = false where id = %L',
		'active', v_routine));
	perform pg_temp.raises_like(format('select pg_temp.routine_wake(%L, %L)', v_routine, 'once:1:2'), '55000',
		'Routine occurrence limit reached');
end $$;

-- 3b. Routine firing on folder-v2: the scheduler queues a slot with admission and no gc fence, into the agent's thread;
-- a replay returns it; a changed version refuses (QRC01); a pause defers the slot and leaves the position where it was.
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010'; c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
	v_routine uuid := pg_temp.routine('member'); v_before bigint; v jsonb; v2 jsonb; v_slot timestamptz := date_trunc('second', clock_timestamp());
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.fx(format($f$update public.qorpera_cloud_routine_versions set triggers = '[{"id":"s1","kind":"schedule","intervalMinutes":60}]'
		where routine_id = %L$f$, v_routine));
	perform pg_temp.fx(format('insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, next_due_at)
		values (%L, 1, %L, %L)', v_routine, 's1', v_slot));
	perform pg_temp.path_claims('service_role');
	v_before := pg_temp.admitted();
	v := public.qorpera_enqueue_routine_wake(v_routine, 1, '65600000-0000-4000-8000-0000000000f1', 'slot-1', 's1', v_slot, null,
		v_slot + interval '1 hour');
	select * into v_wake from public.qorpera_wake_occurrences where id = '65600000-0000-4000-8000-0000000000f1';
	if v ->> 'status' is distinct from 'queued' or v_wake.session_id is distinct from pg_temp.thread(c_a) or v_wake.staff_agent_id <> c_a
		or pg_temp.admitted() <> v_before + 1
		or (select last_scheduled_for from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_routine) is distinct from v_slot then
		raise exception 'A folder-v2 routine slot: % %', v, to_jsonb(v_wake); end if;
	v2 := public.qorpera_enqueue_routine_wake(v_routine, 1, '65600000-0000-4000-8000-0000000000f1', 'slot-1', 's1', v_slot, null,
		v_slot + interval '1 hour');
	if v2 ->> 'occurrence_id' is distinct from v ->> 'occurrence_id' or pg_temp.admitted() <> v_before + 1 then
		raise exception 'A replayed slot: %', v2; end if;
	perform pg_temp.raises_like(format('select public.qorpera_enqueue_routine_wake(%L, 2, %L, %L, %L, %L, %L, %L)', v_routine,
		extensions.gen_random_uuid(), 'slot-2', 's1', v_slot + interval '1 hour', v_slot, v_slot + interval '2 hours'), 'PGRST',
		'%wake routine version is unavailable%');
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		c_profile, '63400000-0000-4000-8000-000000000001', 'test'));
	v := public.qorpera_enqueue_routine_wake(v_routine, 1, extensions.gen_random_uuid(), 'slot-2', 's1', v_slot + interval '1 hour',
		v_slot, v_slot + interval '2 hours');
	if v ->> 'status' is distinct from 'deferred' or v ->> 'reason' is distinct from 'Company execution is paused'
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_routine and occurrence_key = 'slot-2')
		or (select last_scheduled_for from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_routine) is distinct from v_slot then
		raise exception 'A paused company defers the slot: %', v; end if;
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
	-- The scheduler's other step moves the position forward, without the gc fence.
	v := public.qorpera_advance_routine_next_due(v_routine, 1, 's1', v_slot, v_slot + interval '3 hours');
	if v ->> 'status' is distinct from 'advanced'
		or (select next_due_at from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_routine)
			is distinct from v_slot + interval '3 hours' then
		raise exception 'The schedule advance on folder-v2: %', v; end if;
end $$;

-- 4. A coworker message from a folder-v2 run: the message, the peer chips, the wake with admission; a replay, a held
-- message, the argument and recipient refusals, the stop.
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010'; c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; r jsonb; r2 jsonb; v_before bigint := pg_temp.admitted();
	v_wake public.qorpera_wake_occurrences%rowtype; v_pair uuid; v_events bigint; v_sponsor uuid;
begin
	r := pg_temp.cw(b, c_b, 'numbers-1', 'Can you check the numbers?');
	select * into v_wake from public.qorpera_wake_occurrences where id = (r ->> 'occurrenceId')::uuid;
	select payer.binding_id into v_sponsor from public.qorpera_starter_sponsor(c_profile, '63400000-0000-4000-8000-000000000002', c_b,
		'63400000-0000-4000-8000-0000000000b1') payer;
	if r ->> 'status' <> 'queued' or r ->> 'recipientStaffId' <> c_b::text or v_wake.id is null
		or v_wake.wake_kind <> 'agent' or v_wake.source_kind <> 'coworker' or v_wake.staff_agent_id <> c_b
		or v_wake.parent_run_id::text <> h -> 'actor' ->> 'runId' or v_wake.session_id <> pg_temp.thread(c_b)
		or v_wake.status <> 'queued' or v_wake.causal_hop_count <> 1 or v_wake.sponsor_binding_id is distinct from v_sponsor
		or v_wake.payload ->> 'text' <> 'Can you check the numbers?' or v_wake.payload ->> 'receiptId' <> r ->> 'receiptId' then
		raise exception 'A folder-v2 coworker message and its wake: % %', r, to_jsonb(v_wake); end if;
	v_pair := (v_wake.payload ->> 'pairSessionId')::uuid;
	if not exists (select 1 from public.qorpera_shared_sessions where id = v_pair
			and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key(c_a, c_b))
		or (select count(*) from public.qorpera_session_events where session_id = v_pair
			and body #>> '{entry,delivery,receiptId}' = r ->> 'receiptId') <> 1
		or (select count(*) from public.qorpera_session_events where session_id in (pg_temp.thread(c_a), pg_temp.thread(c_b))
			and body ->> 'schema' = 'qorpera.peer-link/v1' and body ->> 'receiptId' = r ->> 'receiptId') <> 2 then
		raise exception 'The pair transcript and both peer chips'; end if;
	if (select status from public.qorpera_run_operation_receipts where id = (r ->> 'receiptId')::uuid) <> 'completed'
		or (select result from public.qorpera_run_operation_receipts where id = (r ->> 'receiptId')::uuid) <> r then
		raise exception 'The message''s receipt is completed with its result'; end if;
	if pg_temp.admitted() <> v_before + 1 then raise exception 'A priority message admits its wake'; end if;
	-- The same message again returns the first result and writes nothing; the same key for another message refuses.
	select count(*) into v_events from public.qorpera_session_events where session_id in (v_pair, pg_temp.thread(c_a), pg_temp.thread(c_b));
	r2 := pg_temp.cw(b, c_b, 'numbers-1', 'Can you check the numbers?');
	if r2 <> r or (select count(*) from public.qorpera_session_events where session_id in (v_pair, pg_temp.thread(c_a), pg_temp.thread(c_b)))
			<> v_events or pg_temp.admitted() <> v_before + 1 then
		raise exception 'A replayed message: %', r2; end if;
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'numbers-1', 'Something else'), '23505',
		'logical operation key is already bound to other work');
	-- A held message waits for the recipient's next run: no wake, no admission.
	r := pg_temp.cw(b, c_b, 'fyi-1', 'For your next run: the numbers moved.', false);
	if r ->> 'status' <> 'held' or r ->> 'occurrenceId' is not null or pg_temp.admitted() <> v_before + 1
		or not exists (select 1 from public.qorpera_pending_peer_messages where recipient_staff_id = c_b and sender_staff_id = c_a
			and text = 'For your next run: the numbers moved.' and pair_session_id = v_pair and delivered_run_id is null) then
		raise exception 'A held message: %', r; end if;
	-- Arguments, the sender itself, an archived recipient.
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'bad key', 'Hi'), '22023', 'Coworker message is invalid');
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'blank-1', '   '), '22023', 'Coworker message is invalid');
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, null, 'none-1', 'Hi'), '22023', 'Coworker message is invalid');
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_a, 'self-1', 'Hi'), '42501', 'Coworker recipient is unavailable');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = %L where staff_agent_id = %L', 'archived', c_b));
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'gone-1', 'Hi'), '42501', 'Coworker recipient is unavailable');
	perform pg_temp.fx(format('update public.qorpera_profile_staff set employment_status = %L where staff_agent_id = %L', 'active', c_b));
	-- The stop, before anything is locked or written.
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		c_profile, '63400000-0000-4000-8000-000000000001', 'test'));
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'paused-1', 'Hi'), '55000', 'Company execution is paused');
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
	-- A closed recipient thread is reopened: its room was taken FOR UPDATE, as the thread helper needs.
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set status = %L where id = %L', 'closed', pg_temp.thread(c_b)));
	r := pg_temp.cw(b, c_b, 'reopen-1', 'Are you there?');
	if r ->> 'status' <> 'queued' or (select status from public.qorpera_shared_sessions where id = pg_temp.thread(c_b)) <> 'open'
		or (select session_id from public.qorpera_wake_occurrences where id = (r ->> 'occurrenceId')::uuid) <> pg_temp.thread(c_b) then
		raise exception 'A message to a closed thread reopens it: %', r; end if;
	-- The snapshot-v1 message is not refused as folder-v2.
	perform pg_temp.not_refused(format('select pg_temp.cw(%L, %L, %L, %L)', current_setting('qorpera_test.snapshot_binding'), c_b,
		'control-1', 'Hi'));
end $$;

-- 5. The audience: the recipient reads everything the run has read (C1B-2 §4), and the run's own reads still hold (the
-- recheck at rank 10). Then the recipient's wake read inherits the parent's reads, once, and drains held messages.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; v jsonb; vb jsonb; e jsonb; e2 jsonb;
	v_res uuid; v_ga uuid; v_gb uuid; v_records bigint; v_reads bigint; v_desk uuid; v_gd uuid;
begin
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'ledger', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_ga := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_a, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'ledger-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','ledger'),
		jsonb_build_object('op','write','path','ledger/q3.txt','file',pg_temp.stage('q3')),
		jsonb_build_object('op','write','path','ledger/q4.txt','file',pg_temp.stage('q4')))), 3, 'saved');
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('ledger/q3.txt', p) -> 'entry'));
	-- B may not read the ledger: the message refuses, and leaves nothing behind.
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'ledger-1', 'See the ledger'), '42501',
		'Coworker audience cannot receive this context');
	if exists (select 1 from public.qorpera_run_operation_receipts where run_id = (p ->> 'runId')::uuid
		and logical_operation_key = 'coworker:ledger-1') then raise exception 'A refused message keeps no receipt'; end if;
	v_gb := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', c_b, array['read']) ->> 'grantId';
	perform pg_temp.cw(b, c_b, 'ledger-1', 'See the ledger');
	-- A held message for B, drained by B's next run.
	perform pg_temp.cw(b, c_b, 'ledger-fyi', 'The ledger has Q4 now.', false);
	-- B's coworker run from A's run inherits A's read of q3, re-resolved under B's authority, filed under the wake.
	v := pg_temp.run(c_b, 'agent', c_member, 'coworker', p);
	vb := pg_temp.native(v);
	e := public.qorpera_read_native_wake(vb);
	if e ->> 'kind' <> 'agent' or e -> 'source' ->> 'kind' <> 'coworker' or e ->> 'actorStaffId' <> c_a::text
		or e ->> 'actorUserId' <> c_member::text or e ->> 'parentRunId' <> p ->> 'runId' or e ->> 'staffAgentId' <> c_b::text
		or not exists (select 1 from jsonb_array_elements(e -> 'payload' -> 'heldMessages') m where m ->> 'text' = 'The ledger has Q4 now.') then
		raise exception 'The folder wake envelope: %', e; end if;
	if not exists (select 1 from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid
			and release_id = (e ->> 'id')::uuid and resource_id = v_res and reads @> '[{"path":"ledger/q3.txt"}]')
		or not exists (select 1 from public.qorpera_folder_run_reads where run_id = (v ->> 'runId')::uuid and resource_id = v_res
			and grant_id = v_gb) then
		raise exception 'The parent''s read is inherited under the recipient''s own grant'; end if;
	if (select delivered_run_id from public.qorpera_pending_peer_messages where text = 'The ledger has Q4 now.')::text <> v ->> 'runId' then
		raise exception 'The held message is delivered to the recipient''s run'; end if;
	-- As of the first call: A's later read of q4 is not added by the next call.
	select count(*) into v_records from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid;
	select count(*) into v_reads from public.qorpera_folder_run_reads where run_id = (v ->> 'runId')::uuid;
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('ledger/q4.txt', p) -> 'entry'));
	e2 := public.qorpera_read_native_wake(vb);
	if (select count(*) from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid) <> v_records
		or (select count(*) from public.qorpera_folder_run_reads where run_id = (v ->> 'runId')::uuid) <> v_reads
		or exists (select 1 from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid
			and reads @> '[{"path":"ledger/q4.txt"}]') or e2 ->> 'id' <> e ->> 'id' then
		raise exception 'A second wake read inherits nothing more'; end if;
	-- B's run now carries the ledger: its own message to A needs A to read it too (A does).
	perform pg_temp.cw(vb, c_a, 'back-1', 'Checked.');
	-- B's own read of its desk, which only B reads: revoked, B's wake read refuses at the recheck, though the wake itself
	-- (the parent's reads) is still authorized.
	v_desk := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'desk', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_gd := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_desk, 'staff_agent', c_b, array['read']) ->> 'grantId';
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'desk-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','desk'),
		jsonb_build_object('op','write','path','desk/b.txt','file',pg_temp.stage('b')))), 2, 'saved');
	perform pg_temp.release(v, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('desk/b.txt', v) -> 'entry'));
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_desk, v_gd);
	if not public.qorpera_wake_authorized(pg_temp.wake(v)) then raise exception 'The wake is still authorized'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_read_native_wake(%L)', vb), '42501', 'A read is no longer readable');
	v_gd := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_desk, 'staff_agent', c_b, array['read']) ->> 'grantId';
	perform public.qorpera_read_native_wake(vb);
	-- A's read is revoked: A's next message refuses at the recheck, before the audience.
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_ga);
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L)', b, c_b, 'ledger-2', 'Again'), '42501', 'A read is no longer readable');
	-- B's grant revoked: B's wake is no longer authorized (the parent's reads), so its wake read refuses.
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_gb);
	perform pg_temp.raises_like(format('select public.qorpera_read_native_wake(%L)', vb), '42501', 'Admitted wake authority is unavailable');
end $$;

-- 6. The wake read of a parent with no folder reads inherits nothing, and a later call may still inherit (nothing was
-- filed). A worker's dispatch never inherits (today's rule).
do $$
declare
	c_b constant uuid := '63400000-0000-4000-8000-0000000000a2'; c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	h jsonb := pg_temp.human(); v jsonb; e jsonb;
begin
	v := pg_temp.run(c_b, 'agent', c_member, 'coworker', h -> 'actor');
	e := public.qorpera_read_native_wake(pg_temp.native(v));
	if exists (select 1 from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid)
		or e -> 'payload' ? 'heldMessages' then
		raise exception 'A parent with no reads passes nothing on: %', e; end if;
end $$;

-- 7. The legacy multi-company loops skip folder-v2 rows in their scans: nothing of a folder-v2 company is scanned,
-- stamped or locked. (Their snapshot-v1 behaviour is the legacy tests'; the text is pinned in section 1.)
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010'; c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	h jsonb := pg_temp.human(); r jsonb; v_worker uuid := extensions.gen_random_uuid(); v_event uuid := extensions.gen_random_uuid();
	v_waiter uuid := extensions.gen_random_uuid(); v_routine uuid; v_dynamic uuid; v_session uuid := pg_temp.thread(c_a);
	v_input uuid := extensions.gen_random_uuid(); v_request uuid := extensions.gen_random_uuid(); v_epoch timestamptz := '2026-01-01T00:00:00Z';
	v_pending uuid := extensions.gen_random_uuid();
begin
	r := pg_temp.cw(h -> 'binding', '63400000-0000-4000-8000-0000000000a2', 'loops-1', 'For the loops');
	update public.qorpera_wake_occurrences set admission_scan_at = v_epoch where id = (r ->> 'occurrenceId')::uuid;
	v_routine := pg_temp.routine('member');
	v_dynamic := pg_temp.routine('agent');
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id, state, scanned_at)
	values (v_worker, c_profile, c_env, c_a, extensions.gen_random_uuid(), 'w-loops', 'in-house', 'Work', 'read', 'each', '{}', c_member,
		(h -> 'actor' ->> 'runId')::uuid, 'active', v_epoch);
	insert into public.qorpera_company_machine_events(id, machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind,
		delivery, scanned_at)
	values (v_event, extensions.gen_random_uuid(), c_profile, c_env, c_a, (h -> 'actor' ->> 'runId')::uuid, 'stopped',
		'waiting', v_epoch);
	insert into public.qorpera_runtime_office_start_waiters(id, intent_id, parent_run_id, receipt_id, staff_version, grant_id, grant_version,
		state, scanned_at)
	values (v_waiter, extensions.gen_random_uuid(), (h -> 'actor' ->> 'runId')::uuid, extensions.gen_random_uuid(), 1,
		extensions.gen_random_uuid(), 1, 'waiting', v_epoch);
	insert into public.qorpera_event_listener_cursors(routine_id, routine_version, trigger_id, hook_id, profile_id, environment_id,
		last_scanned_at)
	values (v_routine, 1, 't1', extensions.gen_random_uuid(), c_profile, c_env, v_epoch);
	insert into public.qorpera_company_file_wake_cursors(routine_id, routine_version, trigger_id, environment_id, activation_head,
		processed_head, active, last_scanned_at)
	values (v_routine, 1, 't1', c_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), true, v_epoch);
	insert into public.qorpera_session_execution_bindings(session_id, profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
		configured_by_user_id, admission_scan_at)
	values (v_session, c_profile, c_a, '63400000-0000-4000-8000-0000000000b1', 1, c_member, v_epoch)
	on conflict (session_id) do update set admission_scan_at = v_epoch;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind, runtime_bundle_id,
		runtime_bundle_sha256)
	values (v_input, v_session, extensions.gen_random_uuid(), c_member, 'human', 'user_message', '63400000-0000-4000-8000-0000000000b2',
		repeat('b', 64));
	-- The turn materializer's scan requires a head snapshot, which a folder-v2 company never has.
	insert into public.qorpera_session_turn_requests(id, profile_id, session_id, client_request_id, input_id, requested_by_user_id,
		sponsor_mode, worker_class, status, sponsor_binding_id, sponsor_version, sponsored_at, admission_scan_at)
	values (v_request, c_profile, v_session, extensions.gen_random_uuid(), v_input, c_member, 'company_connection', 'managed_sandbox',
		'queued', '63400000-0000-4000-8000-0000000000b1', 1, clock_timestamp(), v_epoch);
	-- And the session materializer this input, which has no request yet.
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind, runtime_bundle_id,
		runtime_bundle_sha256)
	values (v_pending, v_session, extensions.gen_random_uuid(), c_member, 'human', 'user_message', '63400000-0000-4000-8000-0000000000b2',
		repeat('b', 64));
	set local session_replication_role = origin;
	perform pg_temp.path_claims('service_role');
	-- The dynamic routine's tick would insert its run if it scanned the routine: the admission mark lets such an insert
	-- through, so only the skip keeps it out.
	perform public.qorpera_folder_admit_wakes(c_profile);
	perform public.qorpera_materialize_wake_execution_runs(64);
	perform public.qorpera_materialize_session_execution_runs(64);
	perform public.qorpera_materialize_session_turn_requests(64);
	if (select admission_scan_at from public.qorpera_wake_occurrences where id = (r ->> 'occurrenceId')::uuid) <> v_epoch
		or (select status from public.qorpera_wake_occurrences where id = (r ->> 'occurrenceId')::uuid) <> 'queued' then
		raise exception 'The wake materializer scanned a folder-v2 wake'; end if;
	if (select scanned_at from public.qorpera_runtime_workers where id = v_worker) <> v_epoch then
		raise exception 'The worker drain scanned a folder-v2 worker'; end if;
	if (select scanned_at from public.qorpera_company_machine_events where id = v_event) <> v_epoch then
		raise exception 'The machine drain scanned a folder-v2 event'; end if;
	if (select scanned_at from public.qorpera_runtime_office_start_waiters where id = v_waiter) <> v_epoch then
		raise exception 'The office drain scanned a folder-v2 waiter'; end if;
	if (select last_scanned_at from public.qorpera_company_file_wake_cursors where routine_id = v_routine) <> v_epoch then
		raise exception 'The Company File drain scanned a folder-v2 cursor'; end if;
	if (select last_scanned_at from public.qorpera_event_listener_cursors where routine_id = v_routine) <> v_epoch then
		raise exception 'The event drain scanned a folder-v2 cursor'; end if;
	if exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_dynamic) then
		raise exception 'The dynamic-routine tick started a folder-v2 routine''s run'; end if;
	if (select admission_scan_at from public.qorpera_session_execution_bindings where session_id = v_session) <> v_epoch then
		raise exception 'The session materializer scanned a folder-v2 conversation'; end if;
	if (select admission_scan_at from public.qorpera_session_turn_requests where id = v_request) <> v_epoch
		or not exists (select 1 from pg_constraint where conrelid = 'public.qorpera_company_files'::regclass
			and conname = 'qorpera_company_files_core_head') then
		raise exception 'The turn materializer scanned a folder-v2 request'; end if;
	-- Without the skip the tick would have started it: the folder tick does (C1c-3e, 20260930009500), and the legacy
	-- path refuses it.
	perform pg_temp.raises_like(format('select public.qorpera_ensure_dynamic_routine_run(%L)', v_dynamic), '0A000',
		'A folder-v2 routine''s next run comes from the folder tick');
	if public.qorpera_folder_restore_dynamic_routine_run(v_dynamic, 1) ->> 'status' <> 'inserted' then
		raise exception 'The dynamic routine is due (the control for the tick''s skip)'; end if;
end $$;

-- 8. Privileges: the new functions are postgres-only; the runtime reaches them through the dispatching functions.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_folder_admit_wakes(uuid)', 'public.qorpera_folder_wake_public_session(uuid,uuid,uuid,uuid)',
		'public.qorpera_folder_send_coworker_message(jsonb,uuid,text,text,boolean)', 'public.qorpera_folder_read_wake(jsonb)',
		'public.qorpera_folder_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb)',
		'public.qorpera_folder_lock_agent_threads(uuid)'] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
			or has_function_privilege('anon', v_fn, 'execute') then
			raise exception '% must be postgres-only', v_fn; end if;
	end loop;
end $$;

rollback;
