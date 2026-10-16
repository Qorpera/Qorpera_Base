-- W5b-2 (RUNTIME-AGENT-MEMORY-TREE.md §12–13): a resumed attempt's source and run_resume observation.
-- These calls are dormant until runtime composition uses them. They do not enable run-log writing or resume.
set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_memory_run_resumes') is not null then
		raise exception 'W5b-2 (20260930340000) is already applied'; end if;
	if to_regclass('public.qorpera_memory_run_steps') is null
		or to_regprocedure('public.qorpera_run_resumes_from_log(uuid)') is null then
		raise exception 'W5b-2 needs W1b and W5a'; end if;
end $$;

create table public.qorpera_memory_run_resumes (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	assignment_id uuid not null,
	profile_id uuid not null,
	environment_id uuid not null,
	why text not null check (why in ('restart', 'limit_reset')),
	steps_read integer not null check (steps_read >= 0),
	-- The exact request replays even after this attempt has appended new steps.
	request jsonb not null,
	-- Receipt-only entries include their authoritative operation key. No guessed receipt-to-call association.
	unknown_calls jsonb not null,
	recorded_at timestamptz not null default clock_timestamp(),
	primary key (run_id, assignment_id)
);
alter table public.qorpera_memory_run_resumes enable row level security;
revoke all on public.qorpera_memory_run_resumes from public, anon, authenticated, service_role;
grant select on public.qorpera_memory_run_resumes to service_role;
comment on table public.qorpera_memory_run_resumes is
	'W5b-2 run_resume: one observation of the earlier steps and unknown operations shown to each resumed attempt.';

-- Private: callers have already performed the binding's run check. The last supersession decides the reason.
-- A sponsor handoff is not a resume. Before this attempt's native start, the previous start is before the event;
-- afterwards, the newest start must be on this binding's lease. A stale reason cannot carry across another start.
create function public.qorpera_memory_run_resume_of(p_run uuid, p_assignment uuid, p_lease uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare v_event public.qorpera_execution_run_events%rowtype; v_started public.qorpera_execution_run_events%rowtype;
	v_receipts jsonb;
begin
	select * into v_event from public.qorpera_execution_run_events
	where run_id = p_run and event_type in ('run_cut_off', 'run_paused', 'sponsor_handoff') order by id desc limit 1;
	if not found or v_event.event_type = 'sponsor_handoff' then return null; end if;
	if v_event.payload ->> 'schema' is distinct from 'qorpera.run-resume/v1'
		or v_event.payload ->> 'assignmentId' is null
		or v_event.payload ->> 'assignmentId' = p_assignment::text then
		raise exception 'Run resume is unavailable' using errcode = '55000'; end if;
	select * into v_started from public.qorpera_execution_run_events
	where run_id = p_run and event_type = 'runner_started'
		and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1' order by id desc limit 1;
	-- The start stored its binding's leaseId as sent; compare the uuid, not its spelling.
	if not found or (v_started.id > v_event.id and (v_started.payload ->> 'leaseId')::uuid is distinct from p_lease) then
		raise exception 'Run resume is unavailable' using errcode = '55000'; end if;
	select coalesce(jsonb_agg(jsonb_build_object('receiptId', r.id, 'logicalOperationKey', r.logical_operation_key)
		order by r.created_at, r.id), '[]'::jsonb) into v_receipts
	from public.qorpera_run_operation_receipts r where r.run_id = p_run and r.status = 'outcome_unknown';
	return jsonb_build_object('schema', 'qorpera.memory-run-resume/v1', 'why',
		case v_event.event_type when 'run_paused' then 'limit_reset' else 'restart' end, 'unknownReceipts', v_receipts);
end $$;
revoke all on function public.qorpera_memory_run_resume_of(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Null for the first/pristine attempt, otherwise {schema, why, unknownReceipts}. The receipt list includes older
-- attempts too: a later restart does not make a previous unknown outcome safe to repeat.
create function public.qorpera_memory_run_resume(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	return public.qorpera_memory_run_resume_of((v_tool #>> '{run,id}')::uuid,
		(v_tool #>> '{actor,assignmentId}')::uuid, (p_binding ->> 'leaseId')::uuid);
end $$;
revoke all on function public.qorpera_memory_run_resume(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_run_resume(jsonb) to service_role;

-- Request: {stepsRead, unknownCalls:[{call, step, receiptId}]}. A log entry has a call and step, and null receiptId;
-- a receipt entry has only receiptId (the other two fields are null). SQL has no authoritative association between
-- the two identifiers. Every log step below stepsRead that is pending or erased (an erased step's result is gone, so
-- its outcome is unknown, §12) and every unknown receipt must be shown, once each.
-- Reply: {schema, why, stepsRead, unknownCalls}; each unknown additionally has logicalOperationKey (null for a log).
-- The binding check precedes validation; malformed input is 22023, a different replay 23505.
create function public.qorpera_memory_run_resume_record(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_count constant text := '^(0|[1-9][0-9]{0,9})$';
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_assignment uuid; v_resume jsonb;
	v_item jsonb; v_steps integer; v_unknown jsonb := '[]'; v_key text; v_j integer;
	v_log_steps integer[] := '{}'; v_receipts uuid[] := '{}'; v_row public.qorpera_memory_run_resumes%rowtype;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	v_assignment := (v_tool #>> '{actor,assignmentId}')::uuid;
	if jsonb_typeof(p_request) is distinct from 'object' then
		raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
	if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request) k)
		is distinct from array['stepsRead','unknownCalls'] then
		raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
	if jsonb_typeof(p_request -> 'stepsRead') <> 'number' or (p_request ->> 'stepsRead') !~ c_count then
		raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
	if (p_request ->> 'stepsRead')::numeric > 2147483647 or jsonb_typeof(p_request -> 'unknownCalls') <> 'array' then
		raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
	v_steps := (p_request ->> 'stepsRead')::integer;
	for v_item in select value from jsonb_array_elements(p_request -> 'unknownCalls') loop
		if jsonb_typeof(v_item) is distinct from 'object' then
			raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(v_item) k)
			is distinct from array['call','receiptId','step'] then
			raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
		if v_item -> 'receiptId' = 'null'::jsonb then
			if jsonb_typeof(v_item -> 'call') <> 'string' or char_length(v_item ->> 'call') not between 1 and 256
				or (v_item ->> 'call') ~ '[\x01-\x1f\x7f-\x9f]'
				or jsonb_typeof(v_item -> 'step') <> 'number' or (v_item ->> 'step') !~ c_count then
				raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
			if (v_item ->> 'step')::numeric >= v_steps then
				raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
			v_j := (v_item ->> 'step')::integer;
			if v_j = any(v_log_steps) then raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
			v_log_steps := array_append(v_log_steps, v_j);
		else
			if v_item -> 'call' <> 'null'::jsonb or v_item -> 'step' <> 'null'::jsonb
				or jsonb_typeof(v_item -> 'receiptId') <> 'string' or (v_item ->> 'receiptId') !~ c_uuid then
				raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
			if (v_item ->> 'receiptId')::uuid = any(v_receipts) then
				raise exception 'Run resume record is malformed' using errcode = '22023'; end if;
			v_receipts := array_append(v_receipts, (v_item ->> 'receiptId')::uuid);
		end if;
	end loop;
	select * into v_row from public.qorpera_memory_run_resumes where run_id = v_run.id and assignment_id = v_assignment;
	if found then
		if v_row.request <> p_request then raise exception 'Run resume was recorded otherwise' using errcode = '23505'; end if;
	else
		v_resume := public.qorpera_memory_run_resume_of(v_run.id, v_assignment, (p_binding ->> 'leaseId')::uuid);
		if v_resume is null then raise exception 'Run is not resumed' using errcode = '55000'; end if;
		if not public.qorpera_run_resumes_from_log(v_run.id) or not exists (
			select 1 from public.qorpera_memory_run_logs l where l.environment_id = v_run.environment_id
				and l.run_id = v_run.id and l.retired_at is null and l.step_count = v_steps) then
			raise exception 'Run resume log is unavailable or changed' using errcode = '55000'; end if;
		for v_item in select value from jsonb_array_elements(p_request -> 'unknownCalls') loop
			v_key := null;
			if v_item -> 'receiptId' = 'null'::jsonb then
				if not exists (select 1 from public.qorpera_memory_run_steps s where s.environment_id = v_run.environment_id
					and s.run_id = v_run.id and s.j = (v_item ->> 'step')::integer and s.call_id = v_item ->> 'call'
					and (s.erased or not s.finished)) then
					raise exception 'Run resume unknown calls disagree with the log' using errcode = '22023'; end if;
			else
				select r.logical_operation_key into v_key from public.qorpera_run_operation_receipts r
				where r.run_id = v_run.id and r.id = (v_item ->> 'receiptId')::uuid and r.status = 'outcome_unknown';
				if not found then raise exception 'Run resume receipt is unavailable' using errcode = '22023'; end if;
			end if;
			v_unknown := v_unknown || jsonb_build_array(v_item || jsonb_build_object('logicalOperationKey', v_key));
		end loop;
		if exists (select 1 from public.qorpera_memory_run_steps s where s.environment_id = v_run.environment_id
			and s.run_id = v_run.id and s.j < v_steps and (s.erased or not s.finished) and not (s.j = any(v_log_steps)))
			or exists (select 1 from public.qorpera_run_operation_receipts r where r.run_id = v_run.id
				and r.status = 'outcome_unknown' and not (r.id = any(v_receipts))) then
			raise exception 'Run resume omits an unknown outcome' using errcode = '22023'; end if;
		-- The run check holds the run's budget lock, serializing two records by this attempt.
		insert into public.qorpera_memory_run_resumes(run_id, assignment_id, profile_id, environment_id, why,
			steps_read, request, unknown_calls)
		values (v_run.id, v_assignment, v_run.profile_id, v_run.environment_id, v_resume ->> 'why', v_steps, p_request, v_unknown)
		returning * into v_row;
	end if;
	return jsonb_build_object('schema', 'qorpera.memory-run-resume-record/v1', 'why', v_row.why,
		'stepsRead', v_row.steps_read, 'unknownCalls', v_row.unknown_calls);
end $$;
revoke all on function public.qorpera_memory_run_resume_record(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_run_resume_record(jsonb, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_run_resume', 'binding'),
	('qorpera_memory_run_resume_record', 'binding');
