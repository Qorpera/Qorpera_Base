-- 20260930066000: check-ins for the Company Computer's shells under one idle rule for every machine (the 2026-10-03
-- amendment, item 5). Folder-v2 only by the founder's decision of 3 October. A shell that stays busy since its agent
-- last worked with it (started or typed into any command on that screen) has its agent asked whether it still needs
-- it, after 1, 3 and 7 hours, then every 24, each time only while busy, in the conversation of the run that worked
-- with it last (a worker's: the conversation that dispatched it). A question is a notice, never a stop.
-- 1. Asking: qorpera_machine_checkins holds one row per question (agents' machines and coding sessions use it too);
--    qorpera_office_shell_checkins_unasked lists the questions due and not asked yet.
-- 2. Delivery on the shared folder drains (LISTENER §9), with C1c-3i-b's helpers (20260930058000): the source kind
--    'machine-checkin' continues the parent run as a machine event does (admitted, authorized by its own chain,
--    materialized with the parent's capability, told in the parent's conversation, read with a continuation of its
--    own). qorpera_folder_machine_checkins_due / _company are the drain's pair: a company's step takes the folder
--    fence KEY SHARE, rank 0 and the ready parents' ranks 1 to 3 KEY SHARE, asks, then takes the questions FOR UPDATE
--    SKIP LOCKED (run-owned rows), the parents' conversations KEY SHARE in id order, and admission; then one wake per
--    parent with up to 8 questions that still stand. One continuation per parent at a time; a question no longer
--    standing, or a stopped parent's, is suppressed, a gone parent's undeliverable; a running parent's wait.
-- Every patched or new body names this migration (20260930066000).

-- 1. Asking ------------------------------------------------------------------------------------------------------------

create table public.qorpera_machine_checkins (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	-- The run whose conversation is asked: the one that worked with it last (for a worker, the run that dispatched it).
	parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	-- computer: a Company Computer's shell; machine: an agent's machine; coding: a coding session.
	machine_kind text not null check (machine_kind in ('computer', 'machine', 'coding')),
	-- The screen, machine or coding session asked about.
	subject_id uuid not null,
	-- When the count started, and the hour mark this question is for.
	since timestamptz not null,
	mark_hours integer not null check (mark_hours > 0),
	-- What the agent reads: a bounded description of what is busy.
	body jsonb not null check (octet_length(body::text) <= 4096),
	created_at timestamptz not null default clock_timestamp(),
	delivery text not null default 'waiting' check (delivery in ('waiting', 'delivered', 'suppressed', 'undeliverable')),
	occurrence_id uuid,
	scanned_at timestamptz not null default '-infinity',
	unique (machine_kind, subject_id, since, mark_hours)
);
create index qorpera_machine_checkins_waiting on public.qorpera_machine_checkins (environment_id, parent_run_id, created_at, id)
	where delivery = 'waiting';
create index qorpera_machine_checkins_occurrence on public.qorpera_machine_checkins (occurrence_id) where occurrence_id is not null;
alter table public.qorpera_machine_checkins enable row level security;
revoke all on public.qorpera_machine_checkins from public, anon, authenticated, service_role, qorpera_secret_broker;
-- When an agent last worked with its shell on a screen.
create index qorpera_runtime_office_shell_commands_worked on public.qorpera_runtime_office_shell_commands (screen_id, staff_agent_id, worked_at);

-- The latest mark reached after p_hours busy hours: 1, 3, 7, then every 24 (31, 55, ...); null before the first.
create function public.qorpera_machine_checkin_mark(p_hours double precision)
returns integer language sql immutable set search_path = '' as $$
	select case when p_hours is null or p_hours < 1 then null when p_hours < 3 then 1 when p_hours < 7 then 3
		else 7 + 24 * floor((p_hours - 7) / 24)::integer end
$$;
revoke all on function public.qorpera_machine_checkin_mark(double precision) from public, anon, authenticated, service_role;

-- The questions due and not asked yet, in one folder-v2 environment (or all, for the due list): each screen whose shell
-- is busy, whose agent still runs a command there and has not worked with that shell for at least an hour, at the mark
-- reached, for the run that worked with it last. An archived agent is not asked.
create function public.qorpera_office_shell_checkins_unasked(p_environment_id uuid)
returns table (office_id uuid, screen_id uuid, profile_id uuid, environment_id uuid, staff_agent_id uuid, conversation_run_id uuid,
	worked_at timestamptz, mark integer)
language sql stable security definer set search_path = '' as $$
	-- 20260930066000.
	select asking.* from (
		select activity.office_id, activity.screen_id, office.profile_id, office.environment_id, screen.staff_agent_id,
			latest.conversation_run_id, latest.worked_at,
			public.qorpera_machine_checkin_mark(extract(epoch from clock_timestamp() - latest.worked_at) / 3600) as mark
		from public.qorpera_runtime_office_shell_activity activity
		join public.qorpera_runtime_offices office on office.id = activity.office_id and office.generation = activity.computer_generation
		join public.qorpera_runtime_office_screens screen on screen.id = activity.screen_id
		cross join lateral (select command.conversation_run_id, command.worked_at
			from public.qorpera_runtime_office_shell_commands command
			where command.screen_id = activity.screen_id and command.staff_agent_id = screen.staff_agent_id
			order by command.worked_at desc, command.id desc limit 1) latest
		where (p_environment_id is null or office.environment_id = p_environment_id) and activity.busy_until > clock_timestamp()
			and latest.worked_at <= clock_timestamp() - interval '1 hour'
			and public.qorpera_environment_is_folder_v2(office.environment_id)
			and exists (select 1 from public.qorpera_runtime_office_shell_commands open_command
				where open_command.office_id = activity.office_id and open_command.screen_id = activity.screen_id
					and open_command.staff_agent_id = screen.staff_agent_id and open_command.ended_at is null)
			and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = office.profile_id
				and staff.staff_agent_id = screen.staff_agent_id and staff.employment_status = 'active')) asking
	where not exists (select 1 from public.qorpera_machine_checkins asked where asked.machine_kind = 'computer'
		and asked.subject_id = asking.screen_id and asked.since = asking.worked_at and asked.mark_hours = asking.mark)
$$;
revoke all on function public.qorpera_office_shell_checkins_unasked(uuid) from public, anon, authenticated, service_role;

-- One folder-v2 company's busy shells, as questions (at most p_limit, oldest work first). One shell's trouble never stops
-- the others. Returns how many it asked. Its caller holds the folder fence KEY SHARE; a question's parent run is locked
-- only KEY SHARE, by its foreign key.
create function public.qorpera_ask_busy_office_shells(p_environment_id uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_shell record; v_body jsonb; v_asked integer := 0; v_count integer;
begin
	-- 20260930066000.
	if p_environment_id is null or p_limit is null or p_limit not between 1 and 256 then
		raise exception 'Office shell check-in bound is invalid' using errcode = '22023'; end if;
	for v_shell in select * from public.qorpera_office_shell_checkins_unasked(p_environment_id) unasked
		order by unasked.worked_at, unasked.screen_id limit p_limit loop
		begin
			-- What still runs, as many as fit: 8 at most and 3000 bytes of commands, the rest counted.
			with listed as (
				select command.id, command.started_at,
					jsonb_build_object('command', left(command.command, 200), 'startedAt', command.started_at) as item
				from public.qorpera_runtime_office_shell_commands command
				where command.office_id = v_shell.office_id and command.screen_id = v_shell.screen_id
					and command.staff_agent_id = v_shell.staff_agent_id and command.ended_at is null),
			ordered as (
				select listed.item, row_number() over (order by listed.started_at, listed.id) as n,
					sum(octet_length(listed.item::text)) over (order by listed.started_at, listed.id) as bytes
				from listed)
			select jsonb_build_object('machine', 'your computer', 'busyHours', v_shell.mark,
				'running', coalesce(jsonb_agg(ordered.item order by ordered.n) filter (where ordered.n <= 8 and ordered.bytes <= 3000), '[]'::jsonb),
				'more', count(*) filter (where ordered.n > 8 or ordered.bytes > 3000))
			into v_body from ordered;
			insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id, machine_kind,
				subject_id, since, mark_hours, body)
			values (v_shell.profile_id, v_shell.environment_id, v_shell.staff_agent_id, v_shell.conversation_run_id, 'computer',
				v_shell.screen_id, v_shell.worked_at, v_shell.mark, v_body)
			on conflict (machine_kind, subject_id, since, mark_hours) do nothing;
			get diagnostics v_count = row_count;
			v_asked := v_asked + v_count;
		exception when check_violation or not_null_violation or foreign_key_violation or program_limit_exceeded then
			-- This question cannot be carried; the others still are.
			null;
		end;
	end loop;
	return v_asked;
end $$;
revoke all on function public.qorpera_ask_busy_office_shells(uuid, integer) from public, anon, authenticated, service_role;

-- Whether a question still stands when it would be delivered: no later mark was asked for the same count, and (on a
-- Company Computer) the shell is busy now, its seat is the same agent's and nobody worked with it since.
create function public.qorpera_machine_checkin_current(p_checkin public.qorpera_machine_checkins)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930066000.
	select not exists (select 1 from public.qorpera_machine_checkins later where later.machine_kind = p_checkin.machine_kind
			and later.subject_id = p_checkin.subject_id and later.since = p_checkin.since and later.mark_hours > p_checkin.mark_hours)
		and case p_checkin.machine_kind
			when 'computer' then exists (select 1 from public.qorpera_runtime_office_shell_activity activity
				join public.qorpera_runtime_offices office on office.id = activity.office_id and office.generation = activity.computer_generation
				join public.qorpera_runtime_office_screens screen on screen.id = activity.screen_id
				where activity.screen_id = p_checkin.subject_id and activity.busy_until > clock_timestamp()
					and screen.staff_agent_id = p_checkin.staff_agent_id
					and (select max(command.worked_at) from public.qorpera_runtime_office_shell_commands command
						where command.screen_id = screen.id and command.staff_agent_id = screen.staff_agent_id) = p_checkin.since)
			-- Other machines judge their questions when they ask them.
			else true end
$$;
revoke all on function public.qorpera_machine_checkin_current(public.qorpera_machine_checkins) from public, anon, authenticated, service_role;

-- 2. The source kind 'machine-checkin' ---------------------------------------------------------------------------------

-- A new wake source kind, keeping whatever kinds the constraint already has (as 20260928269290 added 'event').
do $$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check' and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	if not ('machine-event' = any (v_kinds)) or 'machine-checkin' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format('alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
		check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality) from unnest(v_kinds || array['machine-checkin'])
			with ordinality as listed(kind, ordinality)));
end
$$;

-- A check-in continues the run whose conversation is asked, in that conversation, as a machine event does.
create function public.qorpera_machine_checkin_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_checkin public.qorpera_machine_checkins%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	-- 20260930066000.
	select * into v_checkin from public.qorpera_machine_checkins where id = p_wake.source_id;
	select * into v_parent from public.qorpera_execution_runs where id = p_wake.parent_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	if v_checkin.id is null or v_parent.id is null or v_wake.id is null or p_wake.wake_kind <> 'agent'
		or p_wake.source_kind <> 'machine-checkin' or p_wake.trigger_id is distinct from 'machine-checkin'
		or v_checkin.parent_run_id is distinct from v_parent.id
		or v_checkin.profile_id is distinct from p_wake.profile_id or v_checkin.environment_id is distinct from p_wake.environment_id
		or v_checkin.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.profile_id is distinct from p_wake.profile_id or v_parent.environment_id is distinct from p_wake.environment_id
		or v_parent.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.requested_by_user_id is distinct from p_wake.requested_by_user_id
		or p_wake.file_event_id is not null or p_wake.session_id is distinct from v_parent.session_id
		or v_wake.causal_root_id is null or cardinality(v_wake.causal_agent_ids) < 1
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_parent.staff_agent_id then
		return null; end if;
	return jsonb_build_object('rootId', v_wake.causal_root_id, 'agentIds', to_jsonb(v_wake.causal_agent_ids));
end
$$;
revoke all on function public.qorpera_machine_checkin_ancestry(public.qorpera_wake_occurrences)
	from public, anon, authenticated, service_role;

-- What a check-in wake carries: the questions, oldest first, and how many more wait for the parent.
create function public.qorpera_machine_checkin_payload(p_parent_run_id uuid, p_checkin_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930066000.
	select jsonb_build_object('schema', 'qorpera.machine-checkin/v1', 'parentRunId', p_parent_run_id,
		'checkins', (select jsonb_agg(jsonb_build_object('checkinId', checkin.id, 'machineKind', checkin.machine_kind,
				'since', checkin.since, 'askedAt', checkin.created_at) || checkin.body order by checkin.created_at, checkin.id)
			from public.qorpera_machine_checkins checkin where checkin.id = any(p_checkin_ids)),
		'stillWaiting', (select count(*) from public.qorpera_machine_checkins checkin
			where checkin.parent_run_id = p_parent_run_id and checkin.delivery = 'waiting' and not (checkin.id = any(p_checkin_ids))))
$$;
revoke all on function public.qorpera_machine_checkin_payload(uuid, uuid[]) from public, anon, authenticated, service_role;

-- What the continuation shows: the questions it carries and what the parent run already did, as a machine event's.
create function public.qorpera_machine_checkin_continuation(p_run public.qorpera_execution_runs, p_depth integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_parent_wake public.qorpera_wake_occurrences%rowtype; v_inputs jsonb; v_receipts jsonb; v_sends jsonb; v_result jsonb;
	v_receipt_count bigint; v_send_count bigint;
begin
	-- 20260930066000.
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run.id and source_kind = 'machine-checkin';
	if not found then return null; end if;
	if p_depth > 2 then return jsonb_build_object('schema', 'qorpera.machine-checkin-continuation/v1', 'omitted', 'earlier history'); end if;
	select * into strict v_parent from public.qorpera_execution_runs where id = v_wake.parent_run_id
		and profile_id = p_run.profile_id and environment_id = p_run.environment_id and staff_agent_id = p_run.staff_agent_id;
	select * into strict v_parent_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	select coalesce(jsonb_agg(public.qorpera_company_context_source(v_parent, 'input', input_id) order by ordinal), '[]') into v_inputs
	from unnest(v_parent.input_ids) with ordinality ids(input_id, ordinal);
	select coalesce(jsonb_agg(kept.item order by kept.completed_at, kept.id), '[]') into v_receipts
	from (select receipt.id, receipt.completed_at, listed.item,
			sum(octet_length(listed.item::text)) over (order by receipt.completed_at desc, receipt.id desc) as tail
		from public.qorpera_run_operation_receipts receipt
		cross join lateral (select jsonb_build_object('receiptId', receipt.id, 'logicalOperationKey', receipt.logical_operation_key,
			'completedAt', receipt.completed_at, 'result', receipt.result, 'outputSnapshotId', receipt.output_snapshot_id,
			'companyPathProposalId', receipt.company_path_proposal_id) as item) listed
		where receipt.run_id = v_parent.id and receipt.status = 'completed') kept
	where kept.tail <= 6291456;
	select count(*) into v_receipt_count from public.qorpera_run_operation_receipts receipt
	where receipt.run_id = v_parent.id and receipt.status = 'completed';
	select coalesce(jsonb_agg(kept.item order by kept.sequence, kept.event_id), '[]') into v_sends
	from (select event.sequence, event.event_id, listed.item,
			sum(octet_length(listed.item::text)) over (order by event.sequence desc, event.event_id desc) as tail
		from public.qorpera_agent_sends send join public.qorpera_session_events event on event.event_id = send.event_id
		cross join lateral (select jsonb_build_object('eventId', event.event_id, 'sequence', event.sequence, 'body', event.body) as item) listed
		where send.run_id = v_parent.id) kept
	where kept.tail <= 2097152;
	select count(*) into v_send_count from public.qorpera_agent_sends send
		join public.qorpera_session_events event on event.event_id = send.event_id where send.run_id = v_parent.id;
	v_result := jsonb_build_object('schema', 'qorpera.machine-checkin-continuation/v1', 'runId', p_run.id, 'parentRunId', v_parent.id,
		'parentOutcome', (select status from public.qorpera_runner_jobs where id = v_parent.job_id),
		'checkins', public.qorpera_machine_checkin_payload(v_parent.id,
			array(select checkin.id from public.qorpera_machine_checkins checkin where checkin.occurrence_id = v_wake.id)) -> 'checkins',
		'parentInputs', v_inputs,
		'parentWake', jsonb_build_object('kind', v_parent_wake.wake_kind, 'sourceKind', v_parent_wake.source_kind,
			'routineIntent', (select prompt from public.qorpera_cloud_routine_versions
				where routine_id = v_parent_wake.routine_id and version = v_parent_wake.routine_version),
			'roomPost', (select jsonb_build_object('kind', 'historical_room_input', 'id', id, 'authorUserId', author_user_id, 'body', body)
				from public.qorpera_session_inputs where v_parent_wake.source_kind = 'room' and id = v_parent_wake.source_id
					and session_id = v_parent.session_id and kind = 'user_message')),
		'receipts', v_receipts, 'priorSends', v_sends,
		'earlier', coalesce(public.qorpera_machine_checkin_continuation(v_parent, p_depth + 1),
			public.qorpera_machine_run_continuation(v_parent, p_depth + 1), public.qorpera_worker_run_continuation(v_parent, p_depth + 1)))
		|| jsonb_strip_nulls(jsonb_build_object(
			'receiptsOmitted', nullif(v_receipt_count - jsonb_array_length(v_receipts), 0),
			'priorSendsOmitted', nullif(v_send_count - jsonb_array_length(v_sends), 0)));
	if octet_length(v_result::text) > 33554432 then raise exception 'Check-in continuation exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;
revoke all on function public.qorpera_machine_checkin_continuation(public.qorpera_execution_runs, integer)
	from public, anon, authenticated, service_role;

create function pg_temp.checkin_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Check-in anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;
-- The pin trigger admits it as an agent wake, in the parent's conversation, with its own chain.
select pg_temp.checkin_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$'worker-completion','machine-event') then raise exception 'Agent source is invalid'$old$,
	$new$'worker-completion','machine-event','machine-checkin') then raise exception 'Agent source is invalid'$new$);
select pg_temp.checkin_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$new.session_id := case when new.source_kind in ('worker-completion','machine-event') then v_run.session_id$old$,
	$new$new.session_id := case when new.source_kind in ('worker-completion','machine-event','machine-checkin') then v_run.session_id$new$);
select pg_temp.checkin_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$ elsif new.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(new);$old$,
	$new$ elsif new.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(new);
 elsif new.source_kind = 'machine-checkin' then v_ancestry := public.qorpera_machine_checkin_ancestry(new); -- 20260930066000$new$);
-- The folder-v2 wake check: in a parent's room conversation as a machine event, and by its own chain.
select pg_temp.checkin_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$(p_wake.source_kind in ('worker-completion', 'machine-event')$old$,
	$new$(p_wake.source_kind in ('worker-completion', 'machine-event', 'machine-checkin')$new$);
select pg_temp.checkin_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$v_ancestry := public.qorpera_machine_wake_ancestry(p_wake); -- 20260930058000$old$,
	$new$v_ancestry := public.qorpera_machine_wake_ancestry(p_wake); -- 20260930058000
		elsif p_wake.source_kind = 'machine-checkin' then v_ancestry := public.qorpera_machine_checkin_ancestry(p_wake); -- 20260930066000$new$);
-- P28's materializer: continuing work keeps the parent's capability and publication policy.
select pg_temp.checkin_patch('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	$old$('office-activation', 'worker-dispatch', 'worker-completion', 'machine-event') then$old$,
	$new$('office-activation', 'worker-dispatch', 'worker-completion', 'machine-event', 'machine-checkin') then -- 20260930066000$new$);
-- The wake as the run reads it: an internal continuation, with no sender.
select pg_temp.checkin_patch('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event') then$old$,
	$new$if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin') then -- 20260930066000$new$);
-- The wake's reply policy: an agent wake, and in a conversation it reports as a machine event does.
select pg_temp.checkin_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$'worker-dispatch','worker-completion','machine-event')))))$old$,
	$new$'worker-dispatch','worker-completion','machine-event','machine-checkin'))))) -- 20260930066000$new$);
select pg_temp.checkin_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$if v_wake.source_kind in ('worker-completion','machine-event') and v_wake.session_id is not null$old$,
	$new$if v_wake.source_kind in ('worker-completion','machine-event','machine-checkin') and v_wake.session_id is not null$new$);
-- The run's continuation.
select pg_temp.checkin_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
	$old$public.qorpera_machine_run_continuation(p_run)); end if;$old$,
	$new$public.qorpera_machine_run_continuation(p_run), public.qorpera_machine_checkin_continuation(p_run)); end if; -- 20260930066000$new$);

-- 3. The drain ---------------------------------------------------------------------------------------------------------

-- The shared drains' page (LISTENER §9): folder-v2 environments, in id order after the cursor, with a question to ask
-- or a waiting question whose parent is ready, stopped or gone, leaving out paused companies (the step does nothing
-- while paused: a pause ends every shell command). A company being deleted counts as paused
-- (qorpera_company_execution_paused). A parent still running, or with its check-in pending, asks nothing.
create function public.qorpera_folder_machine_checkins_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_count integer; v_last uuid;
begin
	-- 20260930066000.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder drain requires service authority' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder drain page bound is invalid' using errcode = '22023'; end if;
	with due as (
		select unasked.environment_id, unasked.profile_id from public.qorpera_office_shell_checkins_unasked(null) unasked
		union
		select checkin.environment_id, checkin.profile_id from public.qorpera_machine_checkins checkin
		where checkin.delivery = 'waiting'
			and public.qorpera_folder_parent_continuation(checkin.parent_run_id, 'machine-checkin') in ('ready', 'stopped', 'gone')),
	page as (
		select distinct due.environment_id from due
		where (p_after_environment is null or due.environment_id > p_after_environment)
			and public.qorpera_environment_is_folder_v2(due.environment_id)
			and not public.qorpera_company_execution_paused(due.profile_id)
		order by due.environment_id limit p_limit)
	select coalesce(jsonb_agg(jsonb_build_object('environment_id', page.environment_id) order by page.environment_id), '[]'::jsonb),
		count(*), max(page.environment_id::text)::uuid
	into v_items, v_count, v_last from page;
	return jsonb_build_object('items', v_items, 'has_more', v_count = p_limit,
		'next_after_environment_id', case when v_count = p_limit then v_last end);
end $$;

-- One company's step, in its own transaction (read committed): it asks, then delivers to up to p_limit parents, oldest
-- question first, up to 8 questions that still stand to each in one wake.
create function public.qorpera_folder_machine_checkins_company(p_environment_id uuid, p_limit integer default 8)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-machine-checkins/v1';
	v_profile uuid; v_parents jsonb; v_targets jsonb; v_parent uuid; v_ids uuid[]; v_state text; v_ready jsonb := '[]'::jsonb;
	v_item jsonb; v_run public.qorpera_execution_runs%rowtype; v_payload jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_sessions uuid[]; v_asked integer := 0; v_delivered integer := 0; v_suppressed integer := 0; v_undeliverable integer := 0;
	v_error text; v_stale uuid[];
begin
	-- 20260930066000.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder machine check-ins run at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Folder machine check-ins limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;
	-- 1. Plain reads: the parents with waiting questions that are ready, stopped or gone, oldest question first.
	select coalesce(jsonb_agg(jsonb_build_object('parent', p.parent_run_id, 'state', p.state) order by p.first_at, p.parent_run_id),
		'[]'::jsonb) into v_parents
	from (select w.parent_run_id, w.first_at, w.state from (
			select c.parent_run_id, min(c.created_at) as first_at,
				public.qorpera_folder_parent_continuation(c.parent_run_id, 'machine-checkin') as state
			from public.qorpera_machine_checkins c
			where c.environment_id = p_environment_id and c.delivery = 'waiting' group by c.parent_run_id) w
		where w.state in ('ready', 'stopped', 'gone') order by w.first_at, w.parent_run_id limit p_limit) p;
	if jsonb_array_length(v_parents) = 0 and not exists (select 1 from public.qorpera_office_shell_checkins_unasked(p_environment_id)) then
		return jsonb_build_object('schema', c_schema, 'state', 'idle'); end if;
	-- The ready parents' requesters, agents and authorities, KEY SHARE at ranks 1 to 3 (as the listener's wakes).
	select coalesce(jsonb_agg(distinct t.t), '[]'::jsonb) into v_targets
	from jsonb_array_elements(v_parents) x join public.qorpera_execution_runs r on r.id = (x.value ->> 'parent')::uuid
	cross join lateral (values
		(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || r.requested_by_user_id::text,
			'mode', 'keyshare')),
		(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || r.staff_agent_id::text,
			'mode', 'keyshare')),
		(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_profile::text || ':' || r.staff_agent_id::text, 'mode', 'keyshare'))) t(t)
	where x.value ->> 'state' = 'ready' and r.profile_id = v_profile;
	begin
		-- 2. The fence KEY SHARE, rank 0, ranks 1 to 3.
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;
		-- 3. Ask: new questions wait for the next step (their parents' ranks were not taken here).
		v_asked := public.qorpera_ask_busy_office_shells(p_environment_id, 64);
		-- 4. Each parent's waiting questions FOR UPDATE SKIP LOCKED (run-owned rows), in parent id order, and the parent's
		-- state again under them. Questions that no longer stand are suppressed; those another step holds are its own.
		for v_parent in select (x.value ->> 'parent')::uuid from jsonb_array_elements(v_parents) x order by 1 loop
			select array_agg(waiting.id order by waiting.created_at, waiting.id) into v_ids from (
				select checkin.id, checkin.created_at from public.qorpera_machine_checkins checkin
				where checkin.environment_id = p_environment_id and checkin.parent_run_id = v_parent and checkin.delivery = 'waiting'
				order by checkin.created_at, checkin.id limit 8 for update skip locked) waiting;
			if v_ids is null then continue; end if;
			v_stale := array(select checkin.id from public.qorpera_machine_checkins checkin
				where checkin.id = any(v_ids) and not public.qorpera_machine_checkin_current(checkin));
			if cardinality(v_stale) > 0 then
				update public.qorpera_machine_checkins set delivery = 'suppressed', scanned_at = clock_timestamp() where id = any(v_stale);
				v_suppressed := v_suppressed + cardinality(v_stale);
				v_ids := array(select id from unnest(v_ids) with ordinality kept(id, n) where not (id = any(v_stale)) order by n);
				if cardinality(v_ids) = 0 then continue; end if;
			end if;
			v_state := public.qorpera_folder_parent_continuation(v_parent, 'machine-checkin');
			if v_state = 'stopped' then
				update public.qorpera_machine_checkins set delivery = 'suppressed', scanned_at = clock_timestamp() where id = any(v_ids);
				v_suppressed := v_suppressed + cardinality(v_ids);
			elsif v_state = 'gone' then
				update public.qorpera_machine_checkins set delivery = 'undeliverable', scanned_at = clock_timestamp() where id = any(v_ids);
				v_undeliverable := v_undeliverable + cardinality(v_ids);
			elsif v_state = 'ready' and exists (select 1 from jsonb_array_elements(v_parents) x
				where (x.value ->> 'parent')::uuid = v_parent and x.value ->> 'state' = 'ready') then
				v_ready := v_ready || jsonb_build_array(jsonb_build_object('parent', v_parent, 'ids', to_jsonb(v_ids)));
			end if;
		end loop;
		if jsonb_array_length(v_ready) > 0 then
			-- 5. The parents' conversations KEY SHARE in id order, then admission.
			select array_agg(distinct r.session_id) into v_sessions from jsonb_array_elements(v_ready) x
			join public.qorpera_execution_runs r on r.id = (x.value ->> 'parent')::uuid where r.session_id is not null;
			perform 1 from public.qorpera_shared_sessions where id = any(coalesce(v_sessions, '{}')) and profile_id = v_profile
			order by id for key share;
			perform public.qorpera_folder_admit_wakes(v_profile);
			-- 6. One wake per parent, its questions in at most 6 KiB. A pause at admission cancels the wake and the
			-- questions wait; a parent whose agent, requester or conversation is gone, or whose questions cannot be carried,
			-- is undeliverable.
			for v_item in select x.value from jsonb_array_elements(v_ready) x loop
				v_ids := array(select jsonb_array_elements_text(v_item -> 'ids')::uuid);
				select * into v_run from public.qorpera_execution_runs where id = (v_item ->> 'parent')::uuid;
				begin
					v_payload := public.qorpera_machine_checkin_payload(v_run.id, v_ids);
					while pg_column_size(v_payload) > 6144 and cardinality(v_ids) > 1 loop
						v_ids := v_ids[1:cardinality(v_ids) - 1];
						v_payload := public.qorpera_machine_checkin_payload(v_run.id, v_ids);
					end loop;
					v_wake := public.qorpera_folder_insert_continuation(v_run, 'machine-checkin', v_ids[1], v_payload);
					update public.qorpera_machine_checkins set scanned_at = clock_timestamp(),
						delivery = case when v_wake.status = 'queued' then 'delivered' else delivery end,
						occurrence_id = case when v_wake.status = 'queued' then v_wake.id else occurrence_id end
					where id = any(v_ids);
					if v_wake.status = 'queued' then v_delivered := v_delivered + 1; end if;
				exception when insufficient_privilege or no_data_found or object_not_in_prerequisite_state
					or check_violation or unique_violation or program_limit_exceeded then
					-- The step's answer names the last such refusal, for the operator.
					v_error := left(sqlstate || ': ' || sqlerrm, 300);
					update public.qorpera_machine_checkins set delivery = 'undeliverable', scanned_at = clock_timestamp()
					where id = any(v_ids);
					v_undeliverable := v_undeliverable + cardinality(v_ids);
				end;
			end loop;
		end if;
	exception when lock_not_available or deadlock_detected then
		return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'asked', v_asked, 'delivered', v_delivered,
		'suppressed', v_suppressed, 'undeliverable', v_undeliverable)
		|| case when v_error is null then '{}'::jsonb else jsonb_build_object('lastError', v_error) end;
end $$;

revoke all on function public.qorpera_folder_machine_checkins_due(uuid, integer),
	public.qorpera_folder_machine_checkins_company(uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_machine_checkins_due(uuid, integer),
	public.qorpera_folder_machine_checkins_company(uuid, integer) to service_role;

-- The patched functions may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_pin_wake_occurrence()'::regprocedure,
		'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
		'public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Check-in function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_machine_checkin_ancestry(public.qorpera_wake_occurrences), '
				'public.qorpera_machine_checkin_continuation(public.qorpera_execution_runs, integer) to %I', v_owner);
		end if;
	end loop;
end $$;
