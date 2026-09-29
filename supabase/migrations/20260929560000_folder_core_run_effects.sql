-- Company folder core, C1c-2b part 2: a folder-v2 run's public effects on the folder fence
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.7).
--
-- Changes only folder-v2 behaviour; no real folder-v2 run exists yet (C1C §7). Every path below runs C1c-2a's run
-- check (the run mutex, the job and fence KEY SHARE, this company's row and the ranks, the plain lease checks), never
-- the broker job FOR UPDATE or the gc fence.
-- * The native send (qorpera_send_native_agent_message) and the interaction request dispatch to folder bodies: the run
--   check, the recheck at rank 10, the run's session FOR UPDATE, then the send row and a folder transcript append. The
--   run mutex orders the replay, "already final", the public-send budget and the acknowledgement rule, as the job
--   FOR UPDATE did.
-- * The context-send trigger requires the marker only the folder send sets (bound to the run id); on folder-v2 it
--   returned early before, which let any other insert through.
-- * The action-review card (public output) takes the recheck and the session before its folder transcript append.
-- * assert_company_path_reads, record_native_context_view and add_agent_review_rule get folder bodies: the recheck
--   under the run check; context outputs cite folder releases; an agent's "Ask first" rule serializes on the
--   requester's member row (rank 1, FOR NO KEY UPDATE, merged with the run's KEY SHARE) instead of the company row.
-- * The runner broker's send, direct receipts and transcript append keep refusing folder-v2 (C3).

-- 1. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ------------------------

create function pg_temp.c1c2b2_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1c-2b guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1c-2b guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1c-2b guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;
create function pg_temp.c1c2b2_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-2b patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The folder transcript append ----------------------------------------------------------------------------------

-- Appends a run's public event to its session. The caller has run the run check, the recheck at rank 10 and holds the
-- run's session FOR UPDATE (C1C §5.6): this is the first session write, which takes the operation clock through the
-- event's triggers. No broker job lock, no runner token: the run check stands for both. The session's company snapshot
-- pin is not compared: a folder-v2 session pins none, and companySeq has no column yet (C4). A replay of the same
-- event returns it; another body under the same id refuses.
create function public.qorpera_folder_append_transcript_event(p_run public.qorpera_execution_runs, p_assignment_id uuid,
	p_event_id uuid, p_event_type text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0; v_previous_hash text; v_event_hash text; v_created_at timestamptz := statement_timestamp();
begin
	if p_run.id is null or p_run.session_id is null or p_event_id is null or p_assignment_id is null
		or p_event_type is null or p_event_type not in ('message', 'authorization_request', 'interaction_request')
		or p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144
		or coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or coalesce(jsonb_typeof(p_body -> 'entry'), '') <> 'object'
		or coalesce(p_body #>> '{entry,id}', '') <> p_event_id::text
		or not public.qorpera_runner_transcript_entry_valid(p_event_type, p_body)
		or coalesce(p_body #>> '{entry,execution,kind}', '') <> 'run'
		or coalesce(p_body #>> '{entry,execution,id}', '') <> p_run.id::text
		or coalesce(p_body #>> '{entry,execution,claimantId}', '') <> p_run.id::text
		or coalesce(p_body #>> '{entry,execution,runnerAssignmentId}', '') <> p_assignment_id::text then
		raise exception 'runner transcript authority is invalid' using errcode = '42501'; end if;
	select * into v_existing from public.qorpera_session_events where event_id = p_event_id;
	if found then
		if v_existing.session_id <> p_run.session_id or v_existing.event_type <> p_event_type or v_existing.body <> p_body
			or v_existing.execution_kind <> 'run' or v_existing.execution_id <> p_run.id or v_existing.execution_claimant_id <> p_run.id then
			raise exception 'runner event id is already bound to different content' using errcode = '23505'; end if;
		return jsonb_build_object('session_id', v_existing.session_id, 'sequence', v_existing.sequence,
			'event_id', v_existing.event_id, 'event_type', v_existing.event_type, 'actor_user_id', v_existing.actor_user_id,
			'body', v_existing.body, 'previous_hash', v_existing.previous_hash, 'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind, 'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id, 'runner_assignment_id', v_existing.runner_assignment_id,
			'created_at', v_existing.created_at);
	end if;
	-- Held already by the caller (the sessions rank); taken again in the same mode, no upgrade.
	select * into v_session from public.qorpera_shared_sessions where id = p_run.session_id for update;
	if not found or v_session.status <> 'open'
		or v_session.profile_id <> p_run.profile_id or v_session.environment_id <> p_run.environment_id
		or (v_session.staff_agent_id is not null and v_session.staff_version <> p_run.staff_version
			and not (p_run.source_kind in ('wake', 'room_delivery') and p_run.staff_version > v_session.staff_version)) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'runner transcript session pins changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if jsonb_typeof(p_body #> '{entry,parentId}') = 'string'
		and not exists (select 1 from public.qorpera_session_events as parent
			where parent.session_id = v_session.id and parent.body #>> '{entry,id}' = p_body #>> '{entry,parentId}')
		and not exists (select 1 from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
				and parent.body ->> 'entryId' = p_body #>> '{entry,parentId}'
				and jsonb_typeof(parent.body -> 'partIndex') = 'number'
				and jsonb_typeof(parent.body -> 'partCount') = 'number'
			group by parent.body ->> 'entryId', parent.body ->> 'partCount',
				parent.execution_kind, parent.execution_id, parent.execution_claimant_id
			having count(distinct (parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer
				and min((parent.body ->> 'partIndex')::integer) = 0
				and max((parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer - 1) then
		raise exception 'runner transcript parent is unavailable' using errcode = '42501';
	end if;
	-- The budget row is the run mutex, already held.
	update public.qorpera_execution_run_budgets
	set transcript_event_count = transcript_event_count + 1,
		transcript_bytes = transcript_bytes + octet_length(convert_to(p_body::text, 'utf8'))
	where run_id = p_run.id and transcript_bytes + octet_length(convert_to(p_body::text, 'utf8')) <= 67108864;
	if not found then raise exception 'runner transcript budget is exhausted' using errcode = '55000'; end if;
	select event.sequence, event.event_hash into v_sequence, v_previous_hash
	from public.qorpera_session_events as event where event.session_id = v_session.id order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0) + 1;
	v_event_hash := encode(extensions.digest(convert_to(
		coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
			'session_id', v_session.id, 'sequence', v_sequence, 'event_id', p_event_id, 'event_type', p_event_type,
			'actor_user_id', p_run.created_by_user_id, 'body', p_body, 'execution_kind', 'run', 'execution_id', p_run.id,
			'execution_claimant_id', p_run.id, 'runner_assignment_id', p_assignment_id, 'created_at', v_created_at
		)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, previous_hash,
		event_hash, execution_kind, execution_id, execution_claimant_id, runner_assignment_id, created_at)
	values (v_session.id, v_sequence, p_event_id, p_event_type, p_run.created_by_user_id, p_body, v_previous_hash, v_event_hash,
		'run', p_run.id, p_run.id, p_assignment_id, v_created_at);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = v_session.id;
	return jsonb_build_object('session_id', v_session.id, 'sequence', v_sequence, 'event_id', p_event_id,
		'event_type', p_event_type, 'actor_user_id', p_run.created_by_user_id, 'body', p_body,
		'previous_hash', v_previous_hash, 'event_hash', v_event_hash, 'execution_kind', 'run', 'execution_id', p_run.id,
		'execution_claimant_id', p_run.id, 'runner_assignment_id', p_assignment_id, 'created_at', v_created_at);
end $$;

-- 3. The folder native send ----------------------------------------------------------------------------------------

-- The legacy send's rules (arguments, replay, "already final", the wake policy's phases, budget and acknowledgement),
-- in C1C §5.6's order: the run check; the plain checks under the run mutex; the recheck at rank 10; the run's session
-- FOR UPDATE; the marker, the send row (the context-send trigger checks the marker), the folder transcript append.
create function public.qorpera_folder_send_agent_message(p_binding jsonb, p_idempotency_key text, p_text text, p_phase text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_delivery public.qorpera_agent_sends%rowtype;
	v_event public.qorpera_session_events%rowtype; v_event_id uuid := extensions.gen_random_uuid(); v_text_sha256 text;
	v_parent_id text; v_body jsonb; v_result jsonb; v_policy jsonb; v_sent integer; v_progress integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'native agent send authority is required' using errcode = '42501'; end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	if p_phase = 'final' and public.qorpera_routine_decision_pending(v_run.id) then
		raise exception 'Decide this routine''s next run or conclude it before the final message' using errcode = '55000'; end if;
	if v_run.session_id is null then
		raise exception 'agent send audience or assignment is unavailable' using errcode = '42501'; end if;
	if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or p_text is null or p_text !~ '[^[:space:]]' or octet_length(convert_to(p_text, 'utf8')) > 65536
		or p_phase is null or p_phase not in ('progress', 'final') then
		raise exception 'agent send arguments are invalid' using errcode = '22023'; end if;
	v_text_sha256 := encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex');
	select * into v_delivery from public.qorpera_agent_sends where run_id = v_run.id and idempotency_key = p_idempotency_key;
	if found then
		if v_delivery.text_sha256 <> v_text_sha256 or v_delivery.phase <> p_phase then
			raise exception 'agent send key is bound to different content' using errcode = '23505'; end if;
		select * into strict v_event from public.qorpera_session_events where event_id = v_delivery.event_id;
		return jsonb_build_object('schema', 'qorpera.agent-send/v1', 'runId', v_run.id, 'sessionId', v_delivery.session_id,
			'messageId', v_delivery.event_id, 'phase', v_delivery.phase, 'sequence', v_event.sequence);
	end if;
	if exists (select 1 from public.qorpera_agent_sends where run_id = v_run.id and phase = 'final') then
		raise exception 'agent public output is already final' using errcode = '55000'; end if;
	v_policy := public.qorpera_runtime_wake_policy(v_run.id);
	select count(*), count(*) filter (where phase = 'progress') into v_sent, v_progress
	from public.qorpera_agent_sends where run_id = v_run.id;
	if (p_phase = 'progress' and v_policy ->> 'initial' = 'forbidden') or (p_phase = 'final' and v_policy ->> 'final' = 'forbidden') then
		raise exception 'wake policy forbids public output' using errcode = '55000'; end if;
	if v_sent >= (v_policy ->> 'maxPublicSends')::integer then
		raise exception 'wake public send budget is exhausted' using errcode = '55000'; end if;
	if p_phase = 'final' and v_policy ->> 'initial' = 'required' and v_progress = 0 then
		raise exception 'wake requires an acknowledgement before its final report' using errcode = '55000'; end if;
	-- Rank 10: the run's released reads still hold before anything public (C1B-2 §3).
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	-- The run's session, FOR UPDATE, before the first session write (C1C §5.6).
	perform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;
	select coalesce(event.body #>> '{entry,id}', event.body ->> 'entryId') into v_parent_id
	from public.qorpera_session_events as event
	where event.session_id = v_run.session_id and ((event.body #>> '{entry,id}') is not null
		or (event.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
			and (event.body ->> 'partIndex')::integer = (event.body ->> 'partCount')::integer - 1))
	order by event.sequence desc limit 1;
	v_body := jsonb_build_object('schema', 'qorpera.runner-transcript-entry/v1',
		'entry', jsonb_build_object('type', 'message', 'id', v_event_id, 'parentId', v_parent_id,
			'timestamp', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text))),
			'delivery', jsonb_build_object('schema', 'qorpera.agent-send/v1', 'phase', p_phase),
			'execution', jsonb_build_object('kind', 'run', 'id', v_run.id, 'claimantId', v_run.id,
				'runnerAssignmentId', (p_binding ->> 'assignmentId')::uuid)));
	-- The marker the context-send trigger requires for folder-v2, bound to this run and cleared after the insert.
	perform set_config('qorpera.folder_send', v_run.id::text, true);
	insert into public.qorpera_agent_sends(event_id, run_id, session_id, assignment_id, idempotency_key, phase, text_sha256, body_sha256)
	values (v_event_id, v_run.id, v_run.session_id, (p_binding ->> 'assignmentId')::uuid, p_idempotency_key, p_phase, v_text_sha256,
		encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'));
	perform set_config('qorpera.folder_send', '', true);
	v_result := public.qorpera_folder_append_transcript_event(v_run, (p_binding ->> 'assignmentId')::uuid, v_event_id, 'message', v_body);
	return jsonb_build_object('schema', 'qorpera.agent-send/v1', 'runId', v_run.id, 'sessionId', v_run.session_id,
		'messageId', v_event_id, 'phase', p_phase, 'sequence', (v_result ->> 'sequence')::bigint);
end $$;

-- 4. The folder interaction request (a card in the run's conversation) ----------------------------------------------

-- The legacy request's rules (a conversation, never a group chat; a replay keeps its first parent and time), with the
-- run check, the recheck and the session before the folder transcript append. The legacy request ran no context
-- recheck on either core (C1c-2 inventory F4); on folder-v2 it does.
create function public.qorpera_folder_append_interaction_request(p_binding jsonb, p_event_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_parent text; v_body jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'native interaction authority is required' using errcode = '42501'; end if;
	if p_event_id is null or not public.qorpera_interaction_request_valid(p_data) then
		raise exception 'interaction request is invalid' using errcode = '22023'; end if;
	if not public.qorpera_interaction_secret_connector_allowed(p_data) then
		raise exception 'a secret card cannot name a company connection; the company connects it in Settings' using errcode = '22023'; end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	if v_run.session_id is null then raise exception 'interaction requests need a conversation' using errcode = '55000'; end if;
	if exists (select 1 from public.qorpera_company_rooms as room
		where room.session_id = v_run.session_id and room.bound_staff_agent_id is distinct from v_run.staff_agent_id) then
		raise exception 'cards are not raised in a group chat' using errcode = '22023'; end if;
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	perform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;
	select event.body #>> '{entry,parentId}' into v_parent from public.qorpera_session_events as event
	where event.event_id = p_event_id and event.session_id = v_run.session_id;
	if not found then
		select event.body #>> '{entry,id}' into v_parent from public.qorpera_session_events as event
		where event.session_id = v_run.session_id order by event.sequence desc limit 1;
	end if;
	v_body := jsonb_build_object('schema', 'qorpera.runner-transcript-entry/v1',
		'entry', jsonb_build_object('type', 'custom', 'customType', 'interaction_request', 'id', p_event_id, 'parentId', v_parent,
			'timestamp', coalesce((select to_char(event.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
				from public.qorpera_session_events as event where event.event_id = p_event_id),
				to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
			'data', p_data,
			'execution', jsonb_build_object('kind', 'run', 'id', v_run.id, 'claimantId', v_run.id,
				'runnerAssignmentId', (p_binding ->> 'assignmentId')::uuid)));
	return public.qorpera_folder_append_transcript_event(v_run, (p_binding ->> 'assignmentId')::uuid, p_event_id,
		'interaction_request', v_body);
end $$;

-- 5. The runtime's read check before a model request ---------------------------------------------------------------

-- The run check, then the recheck at rank 10. The path list is not used: the run's releases carry its reads, and this
-- never writes company_run_read_paths (C1C §5.6).
create function public.qorpera_folder_assert_run_reads(p_environment_id uuid, p_binding jsonb, p_paths text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb;
begin
	if p_binding is null then raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	if v_tool -> 'run' ->> 'environment_id' is distinct from p_environment_id::text then
		raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	if p_paths is null then raise exception 'Company File context read set is invalid' using errcode = '22023'; end if;
	perform public.qorpera_folder_run_reads_current(p_environment_id, (v_tool -> 'run' ->> 'profile_id')::uuid, v_tool -> 'resolved');
end $$;

-- 6. The run's context view ----------------------------------------------------------------------------------------

-- The legacy view's rules. An output's readId is a release of this run (qorpera_folder_run_releases) and its readSha256
-- that release's output hash, from its read records. A release that released no reads has no read records and cannot be
-- cited: the runtime sends readId null for such an output (C3). The run mutex orders the ordinal and the replay. Office captures
-- do not serve folder-v2 until C1c-3.
create function public.qorpera_folder_record_context_view(p_environment_id uuid, p_binding jsonb, p_view jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run uuid; v_view public.qorpera_native_context_views%rowtype; v_parent uuid; v_ordinal integer;
	v_output jsonb; v_output_sha text;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Context view requires cloud authority' using errcode = '42501'; end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	if v_tool -> 'run' ->> 'environment_id' is distinct from p_environment_id::text then
		raise exception 'Company File authority is unavailable' using errcode = '42501'; end if;
	v_run := (v_tool -> 'run' ->> 'id')::uuid;
	perform public.qorpera_folder_run_reads_current(p_environment_id, (v_tool -> 'run' ->> 'profile_id')::uuid, v_tool -> 'resolved');
	if not exists (select 1 from public.qorpera_native_execution_launches where run_id = v_run) then
		raise exception 'Native launch provenance is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_view) is distinct from 'object' or pg_column_size(p_view) > 16777216
		or p_view - array['schema','requestId','threadId','turnId','purpose','outputs'] <> '{}'::jsonb
		or p_view ->> 'schema' is distinct from 'qorpera.native-context-view/v1'
		or coalesce(p_view ->> 'requestId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
		or coalesce(p_view ->> 'threadId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
		or (p_view -> 'turnId' is distinct from 'null'::jsonb and coalesce(p_view ->> 'turnId','') !~ '^[A-Za-z0-9_:.-]{1,160}$')
		or coalesce(p_view ->> 'purpose','') not in ('prewarm','turn','compaction')
		or jsonb_typeof(p_view -> 'outputs') is distinct from 'array' then
		raise exception 'Context view is invalid' using errcode = '22023'; end if;
	if (p_view ->> 'purpose' = 'prewarm' and p_view -> 'outputs' <> '[]'::jsonb) then
		raise exception 'Context view budget is invalid' using errcode = '22023'; end if;
	for v_output in select value from jsonb_array_elements(p_view -> 'outputs') loop
		if jsonb_typeof(v_output) is distinct from 'object'
			or v_output - array['callId','kind','sha256','bytes','readId','readSha256','includedBytes','includedSha256','capture'] <> '{}'::jsonb
			or coalesce(v_output ->> 'callId','') !~ '^[A-Za-z0-9_:.-]{1,160}$'
			or coalesce(v_output ->> 'kind','') not in ('function_call_output','custom_tool_call_output')
			or coalesce(v_output ->> 'sha256','') !~ '^[0-9a-f]{64}$'
			or coalesce(v_output ->> 'bytes','') !~ '^[1-9][0-9]{0,3}$'
			or (v_output ->> 'bytes')::integer > 8192 then
			raise exception 'Context output is invalid' using errcode = '22023'; end if;
		if v_output ? 'capture' then
			raise exception 'This Company File path does not serve folder-v2 companies' using errcode = '0A000'; end if;
		if v_output -> 'readId' is distinct from 'null'::jsonb then
			select r.output_sha256 into v_output_sha from public.qorpera_folder_run_releases rel
			join public.qorpera_folder_run_read_records r on r.run_id = rel.run_id and r.release_id = rel.release_id
			where rel.run_id = v_run and rel.environment_id = p_environment_id
				and rel.release_id = case when coalesce(v_output ->> 'readId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
					then (v_output ->> 'readId')::uuid end
			limit 1;
			if v_output_sha is null or v_output_sha is distinct from v_output ->> 'readSha256'
				or coalesce(v_output ->> 'includedBytes','') !~ '^(0|[1-9][0-9]{0,3})$'
				or (v_output ->> 'includedBytes')::integer > 8192
				or coalesce(v_output ->> 'includedSha256','') !~ '^[0-9a-f]{64}$' then
				raise exception 'Context read provenance differs' using errcode = '42501'; end if;
		elsif v_output -> 'readSha256' is distinct from 'null'::jsonb
			or v_output -> 'includedBytes' is distinct from 'null'::jsonb
			or v_output -> 'includedSha256' is distinct from 'null'::jsonb then
			raise exception 'Unexpected context read provenance' using errcode = '22023'; end if;
	end loop;
	if (select count(distinct output ->> 'callId') from jsonb_array_elements(p_view -> 'outputs') output)
		<> jsonb_array_length(p_view -> 'outputs') then
		raise exception 'Duplicate context output' using errcode = '22023'; end if;
	select * into v_view from public.qorpera_native_context_views where run_id = v_run and request_id = p_view ->> 'requestId';
	if found then
		if v_view.view <> p_view then raise exception 'Context request replay differs' using errcode = '23505'; end if;
	else
		select id, ordinal into v_parent, v_ordinal from public.qorpera_native_context_views
		where run_id = v_run order by ordinal desc limit 1;
		insert into public.qorpera_native_context_views(run_id, ordinal, parent_id, request_id, view)
		values (v_run, coalesce(v_ordinal, 0) + 1, v_parent, p_view ->> 'requestId', p_view)
		returning * into v_view;
	end if;
	return jsonb_build_object('schema','qorpera.native-context-view-receipt/v1',
		'viewId', v_view.id, 'requestId', v_view.request_id, 'sha256', v_view.sha256, 'ordinal', v_view.ordinal);
end $$;

-- 7. An agent's "Ask first" rule -----------------------------------------------------------------------------------

-- The legacy rule's checks and outcome. Instead of the company row FOR UPDATE, it serializes on the requester's member
-- row: rank 1, FOR NO KEY UPDATE, merged into the run check with the run's own KEY SHARE on that row, so no lock is
-- upgraded. That orders two adds for one member (the duplicate check and the member's rule budget).
create function public.qorpera_folder_add_agent_review_rule(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_member text; v_text text; v_id uuid;
	v_rule public.qorpera_review_rules%rowtype; v_added boolean := false;
begin
	select profile_id::text || ':' || requested_by_user_id::text into v_member from public.qorpera_execution_runs
	where id = case when coalesce(p_binding ->> 'runId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then (p_binding ->> 'runId')::uuid end;
	v_tool := public.qorpera_folder_tool_run(p_binding, case when v_member is null then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_member,
			'mode', 'nokeyupdate', 'required', true)) end);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Only a company agent can add a rule' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or p_request - array['operationKey','when'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'when') is distinct from 'string'
		or coalesce(p_request ->> 'operationKey', '') !~ '^[A-Za-z0-9_:.-]{1,128}$' then
		raise exception 'Rule request is invalid' using errcode = '22023'; end if;
	v_text := public.qorpera_review_rule_text(p_request ->> 'when');
	v_id := md5('qorpera.agent-review-rule:' || v_run.id::text || ':' || (p_request ->> 'operationKey'))::uuid;
	select * into v_rule from public.qorpera_review_rules where id = v_id;
	if found then
		if v_rule.when_text <> v_text then
			raise exception 'This operation key already added another rule' using errcode = '23505'; end if;
	else
		select * into v_rule from public.qorpera_review_rules as rule
		where rule.profile_id = v_run.profile_id and rule.scope = 'member' and rule.member_user_id = v_run.requested_by_user_id
			and rule.archived_at is null and rule.outcome = 'ask_first' and lower(rule.when_text) = lower(v_text)
		order by rule.created_at limit 1;
		if not found then
			begin
				insert into public.qorpera_review_rules(id, profile_id, scope, member_user_id, when_text, outcome,
					created_via, created_by_user_id, created_by_staff_agent_id)
				values (v_id, v_run.profile_id, 'member', v_run.requested_by_user_id, v_text, 'ask_first', 'agent', null, v_run.staff_agent_id)
				returning * into v_rule;
				perform public.qorpera_review_rules_assert_room(v_run.profile_id, 'member', v_run.requested_by_user_id);
				v_added := true;
			exception when sqlstate '54000' then
				return jsonb_build_object('schema', 'qorpera.agent-review-rule/v1', 'runId', v_run.id, 'added', false, 'rule', null,
					'refused', 'The member has too many rules to add another; they can remove some at the bottom of Settings → General.');
			end;
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.agent-review-rule/v1', 'runId', v_run.id, 'added', v_added,
		'rule', public.qorpera_review_rule_view(v_rule));
end $$;

revoke all on function public.qorpera_folder_append_transcript_event(public.qorpera_execution_runs,uuid,uuid,text,jsonb),
	public.qorpera_folder_send_agent_message(jsonb,text,text,text),
	public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb),
	public.qorpera_folder_assert_run_reads(uuid,jsonb,text[]),
	public.qorpera_folder_record_context_view(uuid,jsonb,jsonb),
	public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)
	from public, anon, authenticated, service_role;

-- 8. Dispatch --------------------------------------------------------------------------------------------------------

do $$
declare
	c_job_refused constant text := 'if public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;';
	-- The native entry points name the binding by parts; the run's own model completes it (its model check is then
	-- trivially true: the send never chose a model).
	c_binding constant text := 'jsonb_build_object(''leaseId'', p_lease_id, ''runId'', p_run_id, ''jobId'', p_job_id, ''runnerId'', p_runner_id, '
		|| '''assignmentId'', p_assignment_id, ''credentialCapsuleId'', p_credential_capsule_id, ''computeIdentityId'', p_compute_identity_id, '
		|| '''provider'', p_provider, ''nativeHarness'', p_native_harness, ''model'', (select run.model_id from public.qorpera_execution_runs run '
		|| 'where run.id = p_run_id))';
begin
	perform pg_temp.c1c2b2_replace('public.qorpera_send_native_agent_message(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)',
		c_job_refused, 'if public.qorpera_job_is_folder_v2(p_job_id) then return public.qorpera_folder_send_agent_message('
		|| c_binding || ', p_idempotency_key, p_text, p_phase); end if;', 1);
	perform pg_temp.c1c2b2_replace('public.qorpera_append_native_interaction_request(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,jsonb)',
		c_job_refused, 'if public.qorpera_job_is_folder_v2(p_job_id) then return public.qorpera_folder_append_interaction_request('
		|| c_binding || ', p_event_id, p_data); end if;', 1);
	-- The context-send trigger: on folder-v2, only the folder send may insert a send, and only for its own run.
	perform pg_temp.c1c2b2_guard('public.qorpera_enforce_company_context_send()',
		'if public.qorpera_environment_is_folder_v2((select run.environment_id from public.qorpera_execution_runs run where run.id = new.run_id)) then '
		|| 'if current_setting(''qorpera.folder_send'', true) is distinct from new.run_id::text then '
		|| 'raise exception ''Folder send authority is required'' using errcode = ''42501''; end if; return new; end if;');
	perform pg_temp.c1c2b2_guard('public.qorpera_assert_company_path_reads(uuid,jsonb,text[])',
		'if public.qorpera_environment_is_folder_v2(p_environment_id) then '
		|| 'perform public.qorpera_folder_assert_run_reads(p_environment_id, p_binding, p_paths); return; end if;');
	perform pg_temp.c1c2b2_guard('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)',
		'if public.qorpera_environment_is_folder_v2(p_environment_id) then '
		|| 'return public.qorpera_folder_record_context_view(p_environment_id, p_binding, p_view); end if;');
	perform pg_temp.c1c2b2_guard('public.qorpera_add_agent_review_rule(jsonb,jsonb)',
		'if public.qorpera_binding_is_folder_v2(p_binding) then return public.qorpera_folder_add_agent_review_rule(p_binding, p_request); end if;');
	-- The action-review card (C1C §5.6): the recheck and the conversation FOR UPDATE come before the review row, whose
	-- foreign keys to the conversation (session_id, card_session_id) would otherwise take it KEY SHARE first: a lock
	-- upgrade, and 40P01 between two cards of two runs in one conversation (review r1 B1). The folder transcript append
	-- then writes the card.
	perform pg_temp.c1c2b2_replace('public.qorpera_record_action_review(jsonb,jsonb)',
		E'\tv_id := pg_catalog.gen_random_uuid();\n',
		E'\tif v_card and public.qorpera_environment_is_folder_v2(v_run.environment_id) then\n'
		|| E'\t\tperform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id,\n'
		|| E'\t\t\tpublic.qorpera_folder_run_reader(v_run.profile_id, v_run.id));\n'
		|| E'\t\tperform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;\n'
		|| E'\tend if;\n'
		|| E'\tv_id := pg_catalog.gen_random_uuid();\n', 1);
	perform pg_temp.c1c2b2_replace('public.qorpera_record_action_review(jsonb,jsonb)',
		E'\t\tselect runner.session_token_sha256 into strict v_session_token from public.qorpera_runners as runner\n'
		|| E'\t\twhere runner.id = (p_binding ->> ''runnerId'')::uuid;\n'
		|| E'\t\tselect job.lease_token_sha256 into strict v_lease_token from public.qorpera_runner_jobs as job\n'
		|| E'\t\twhere job.id = (p_binding ->> ''jobId'')::uuid;\n'
		|| E'\t\tperform public.qorpera_append_runner_transcript_event((p_binding ->> ''runnerId'')::uuid, v_session_token,\n'
		|| E'\t\t\t(p_binding ->> ''jobId'')::uuid, v_lease_token, (p_binding ->> ''assignmentId'')::uuid, v_review.id,\n'
		|| E'\t\t\t''authorization_request'', v_body);\n',
		E'\t\tif public.qorpera_environment_is_folder_v2(v_run.environment_id) then\n'
		|| E'\t\t\tperform public.qorpera_folder_append_transcript_event(v_run, (p_binding ->> ''assignmentId'')::uuid, v_review.id,\n'
		|| E'\t\t\t\t''authorization_request'', v_body);\n'
		|| E'\t\telse\n'
		|| E'\t\tselect runner.session_token_sha256 into strict v_session_token from public.qorpera_runners as runner\n'
		|| E'\t\twhere runner.id = (p_binding ->> ''runnerId'')::uuid;\n'
		|| E'\t\tselect job.lease_token_sha256 into strict v_lease_token from public.qorpera_runner_jobs as job\n'
		|| E'\t\twhere job.id = (p_binding ->> ''jobId'')::uuid;\n'
		|| E'\t\tperform public.qorpera_append_runner_transcript_event((p_binding ->> ''runnerId'')::uuid, v_session_token,\n'
		|| E'\t\t\t(p_binding ->> ''jobId'')::uuid, v_lease_token, (p_binding ->> ''assignmentId'')::uuid, v_review.id,\n'
		|| E'\t\t\t''authorization_request'', v_body);\n'
		|| E'\t\tend if;\n', 1);
end $$;
