-- Summary trees M1b, part 4a (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §5.3, §6, §13): the primary view.
--
-- 1. qorpera_memory_tree_companies: the companies whose runs compose the view (M1's deploy list). A company not listed
--    keeps today's history. The coordinator lists a company once its trees are written (M1b-4b).
-- 2. qorpera_memory_view, a native host call (scope binding): the run check, then, for a run in a conversation of a
--    listed company, what the runtime folds the primary view from (qorpera_memory_view_of): the conversation, T (the
--    included events before the inputs that woke the run), the sequence of T's last event, and the live tree
--    (qorpera_memory_tree_read).
-- 3. qorpera_memory_views and qorpera_memory_view_record, a native host call (scope binding): one row per composed
--    request (§13, memory_view), with the folder clock it was recorded at. The runtime records after it has read the
--    trees, so that clock is the view reference's asOfSeq (W4a-1).
-- The runtime releases the blocks a view shows with qorpera_memory_release (M1b-3b), so no call here keeps a receipt.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; the release comes first.
do $$ begin
	if to_regprocedure('public.qorpera_memory_view(jsonb)') is not null then
		raise exception 'M1b-4a (20260930204000) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_release(jsonb,jsonb)') is null then
		raise exception 'M1b-4a (20260930204000) needs M1b-3b (20260930203000)'; end if;
end $$;

-- 1. The companies ----------------------------------------------------------------------------------------------------

create table public.qorpera_memory_tree_companies (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	added_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_memory_tree_companies enable row level security;
revoke all on public.qorpera_memory_tree_companies from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_tree_companies to service_role;
comment on table public.qorpera_memory_tree_companies is
	'Summary trees M1 (RUNTIME-AGENT-MEMORY-TREE.md §5.3): the companies whose agents'' own-thread runs see the primary '
	'view instead of the history. The coordinator lists a company once its trees are written.';

-- 2. The view ---------------------------------------------------------------------------------------------------------

-- What a run folds its primary view from (§5.3), once its run check has passed (qorpera_memory_view). Null when the run
-- has no conversation, its company is not listed, or its conversation is not of the run's environment (which the run
-- check refuses first). Otherwise {schema, conversation, messages, lastSequence, tree}:
-- - conversation: the run's own, as zoom names `.` (qorpera_memory_conversation): {sessionId, kind, name};
-- - messages: T, the included events (§3) before the first event of the inputs that woke the run, those of the run and
--   those its wake names (a room post's), so the view ends where they begin. With no such event, every included event up
--   to the run's transcript start;
-- - lastSequence: the sequence of T's last event, null when T is 0. The history after it is shown in full;
-- - tree: the conversation's live tree (qorpera_memory_tree_read). It may hold lines past T, which the view leaves out.
create function public.qorpera_memory_view_of(p_run_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
	v_run public.qorpera_execution_runs%rowtype; v_conversation jsonb; v_inputs uuid[]; v_first bigint;
	v_messages bigint; v_last bigint;
begin
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if v_run.session_id is null
		or not exists (select 1 from public.qorpera_memory_tree_companies c where c.profile_id = v_run.profile_id) then
		return null; end if;
	v_conversation := public.qorpera_memory_conversation(v_run.environment_id, '.', v_run.session_id);
	if v_conversation is null then return null; end if;
	v_inputs := v_run.input_ids || coalesce((select array_agg(x.id::uuid)
		from public.qorpera_wake_occurrences w,
			jsonb_array_elements_text(case when jsonb_typeof(w.payload -> 'inputIds') = 'array' then w.payload -> 'inputIds'
				else '[]'::jsonb end) as x(id)
		where w.run_id = v_run.id and x.id ~ c_uuid), '{}'::uuid[]);
	v_first := (select min(e.sequence) from public.qorpera_session_events e
		where e.session_id = v_run.session_id and e.event_id = any(v_inputs));
	select count(*), max(e.sequence) into v_messages, v_last from public.qorpera_session_events e
	where e.session_id = v_run.session_id
		and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')
		and case when v_first is null then e.sequence <= v_run.transcript_start_sequence else e.sequence < v_first end;
	return jsonb_build_object('schema', 'qorpera.memory-view/v1', 'conversation', v_conversation, 'messages', v_messages,
		'lastSequence', v_last, 'tree', public.qorpera_memory_tree_read(v_run.environment_id, v_run.session_id));
end $$;
revoke all on function public.qorpera_memory_view_of(uuid) from public, anon, authenticated, service_role;

-- The view of the binding's run (qorpera_memory_view_of), after the run check.
create function public.qorpera_memory_view(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	return public.qorpera_memory_view_of((public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) #>> '{run,id}')::uuid);
end $$;
revoke all on function public.qorpera_memory_view(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_view(jsonb) to service_role;

-- 3. The record -------------------------------------------------------------------------------------------------------

create table public.qorpera_memory_views (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	-- The model request of the run, from 0.
	step integer not null check (step >= 0),
	profile_id uuid not null,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	session_id uuid,
	-- T, the messages the primary view covers.
	messages bigint not null check (messages >= 0),
	-- The bytes of the head, the primary view, the branches and the run's own view, as they are sent.
	head_bytes integer not null check (head_bytes >= 0),
	view_bytes integer not null check (view_bytes >= 0),
	branches_bytes integer not null check (branches_bytes >= 0),
	run_view_bytes integer not null check (run_view_bytes >= 0),
	-- The run's steps sent whole, the placeholders shown, and the wait for lines (§5.4): how long, and how many were built.
	raw_steps integer not null check (raw_steps >= 0),
	placeholders integer not null check (placeholders >= 0),
	wait_ms integer not null check (wait_ms >= 0),
	waited_lines integer not null check (waited_lines >= 0),
	-- Whether the run's own steps were folded (§5.7).
	folded boolean not null,
	-- The SHA-256 of the request's stable prefix (§6.1), to see the cache hold.
	stable_prefix_sha256 text not null check (stable_prefix_sha256 ~ '^[0-9a-f]{64}$'),
	-- The company's folder clock when it was recorded: the view reference's asOfSeq.
	as_of_seq bigint not null check (as_of_seq >= 0),
	recorded_at timestamptz not null default clock_timestamp(),
	primary key (run_id, step)
);
alter table public.qorpera_memory_views enable row level security;
revoke all on public.qorpera_memory_views from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_views to service_role;
comment on table public.qorpera_memory_views is
	'Summary trees (RUNTIME-AGENT-MEMORY-TREE.md §13): memory_view, one row per composed model request of a run. Written '
	'by qorpera_memory_view_record.';

-- A composed request's memory_view (§13) for the binding's run. The request is {step, messages, headBytes, viewBytes,
-- branchesBytes, runViewBytes, rawSteps, placeholders, waitMs, waitedLines, folded, stablePrefixSha256}: counts as JSON
-- integers from 0 to 999,999,999, folded a boolean, the hash lowercase hex. Answers {schema, step, asOfSeq}, with the
-- company's folder clock (0 before its first commit). A step is recorded once: the same request replays its answer,
-- another refuses (23505). The run check comes first. A malformed request refuses (22023). One check per IF: an OR may
-- evaluate jsonb_object_keys on the wrong type first.
create function public.qorpera_memory_view_record(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_schema constant text := 'qorpera.memory-view-record/v1';
	c_count constant text := '^(0|[1-9][0-9]{0,8})$';
	v_run public.qorpera_execution_runs%rowtype; v_key text; v_row public.qorpera_memory_views%rowtype;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if jsonb_typeof(p_request) is distinct from 'object' then
		raise exception 'memory view record is malformed' using errcode = '22023'; end if;
	if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k) is distinct from array['branchesBytes',
		'folded','headBytes','messages','placeholders','rawSteps','runViewBytes','stablePrefixSha256','step','viewBytes','waitMs',
		'waitedLines'] then
		raise exception 'memory view record is malformed' using errcode = '22023'; end if;
	foreach v_key in array array['step','messages','headBytes','viewBytes','branchesBytes','runViewBytes','rawSteps',
		'placeholders','waitMs','waitedLines'] loop
		if jsonb_typeof(p_request -> v_key) <> 'number' or (p_request ->> v_key) !~ c_count then
			raise exception 'memory view record is malformed' using errcode = '22023'; end if;
	end loop;
	if jsonb_typeof(p_request -> 'folded') <> 'boolean' then
		raise exception 'memory view record is malformed' using errcode = '22023'; end if;
	if jsonb_typeof(p_request -> 'stablePrefixSha256') <> 'string' or (p_request ->> 'stablePrefixSha256') !~ '^[0-9a-f]{64}$' then
		raise exception 'memory view record is malformed' using errcode = '22023'; end if;

	insert into public.qorpera_memory_views(run_id, step, profile_id, environment_id, staff_agent_id, session_id, messages,
		head_bytes, view_bytes, branches_bytes, run_view_bytes, raw_steps, placeholders, wait_ms, waited_lines, folded,
		stable_prefix_sha256, as_of_seq)
	values (v_run.id, (p_request ->> 'step')::integer, v_run.profile_id, v_run.environment_id, v_run.staff_agent_id,
		v_run.session_id, (p_request ->> 'messages')::bigint, (p_request ->> 'headBytes')::integer,
		(p_request ->> 'viewBytes')::integer, (p_request ->> 'branchesBytes')::integer, (p_request ->> 'runViewBytes')::integer,
		(p_request ->> 'rawSteps')::integer, (p_request ->> 'placeholders')::integer, (p_request ->> 'waitMs')::integer,
		(p_request ->> 'waitedLines')::integer, (p_request -> 'folded')::boolean, p_request ->> 'stablePrefixSha256',
		coalesce((select c.last_seq from public.qorpera_folder_clocks c where c.environment_id = v_run.environment_id), 0))
	on conflict (run_id, step) do nothing;
	select * into strict v_row from public.qorpera_memory_views v
	where v.run_id = v_run.id and v.step = (p_request ->> 'step')::integer;
	if jsonb_build_object('step', v_row.step, 'messages', v_row.messages, 'headBytes', v_row.head_bytes,
		'viewBytes', v_row.view_bytes, 'branchesBytes', v_row.branches_bytes, 'runViewBytes', v_row.run_view_bytes,
		'rawSteps', v_row.raw_steps, 'placeholders', v_row.placeholders, 'waitMs', v_row.wait_ms,
		'waitedLines', v_row.waited_lines, 'folded', v_row.folded, 'stablePrefixSha256', v_row.stable_prefix_sha256)
		<> p_request then
		raise exception 'memory view step was recorded otherwise' using errcode = '23505'; end if;
	return jsonb_build_object('schema', c_schema, 'step', v_row.step, 'asOfSeq', v_row.as_of_seq);
end $$;
revoke all on function public.qorpera_memory_view_record(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_view_record(jsonb, jsonb) to service_role;

-- Both are the native host's calls, in one statement as each migration adds its calls.
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_view', 'binding'),
	('qorpera_memory_view_record', 'binding');
