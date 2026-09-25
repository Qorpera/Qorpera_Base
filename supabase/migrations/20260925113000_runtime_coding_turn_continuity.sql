-- A coding session's turns are one conversation (runtime review of 2a5c8f67e,
-- findings #4 and #8, 2026-09-25).
--
-- Until now a session kept only its latest state: the current follow-up text
-- in the worker's dispatch, and one submission column on the session. The
-- next turn's prompt had the original brief and the latest text, but not the
-- question the session had asked, its choices or anything earlier (#4). And a
-- submission was bound to the session, not to its turn: when the executor was
-- lost after the harness submitted, the lease expiry failed the session but
-- kept that submission, the owner's answer started the next sequence without
-- clearing it, and the native runtime refused the new turn as "already
-- submitted" (#8). The agent's follow-up cleared it; the owner's did not.
--
-- Now every turn is a row of its own, recorded once and never rewritten: what
-- started it (the dispatch, the agent's follow-up or the owner's answer), the
-- harness's submission, which a check binds to the turn's own sequence, and
-- how the turn ended, settled when the worker leaves 'active' whichever path
-- ends it. The session keeps no submission of its own, so a new sequence can
-- never inherit an earlier one; a submission its lost executor never acted on
-- stays in its turn, and the failed result names the unanswered question or
-- the unpublished commit. The next turn reads the session's own earlier turns
-- through its run authority (qorpera_read_coding_turn_context) and the native
-- coding runtime composes them into the prompt: a short answer ("B") arrives
-- with the exact question and choices it answers.
--
-- Composition, not provider-session resume: a resumed provider thread would
-- need the provider's own thread state kept across turns and hosts, in the
-- member's provider custody, plus fences for authority carried inside it. The
-- composed context is deterministic, bounded, and pinned by the admission's
-- context digest like every other turn input.

-- ---------------------------------------------------------------------------
-- 1. The turns
-- ---------------------------------------------------------------------------
create table public.qorpera_coding_session_turns (
	worker_id uuid not null references public.qorpera_coding_sessions(worker_id) on delete restrict,
	sequence integer not null check (sequence >= 1),
	-- What started the turn: the dispatch (turn 1), the agent's follow-up, or the owner's answer or follow-up.
	input_from text not null check (input_from in ('dispatch','agent','member')),
	input_text text check (input_text is null or octet_length(input_text) between 1 and 4000),
	input_user_id uuid,
	input_run_id uuid,
	-- The harness's durable word at the end of the turn (qorpera_submit_coding_turn).
	submission jsonb check (submission is null or (jsonb_typeof(submission) = 'object' and pg_column_size(submission) <= 8192)),
	submission_receipt_id uuid references public.qorpera_run_operation_receipts(id) on delete restrict,
	submitted_at timestamptz,
	-- How the turn ended: the worker's result when it left 'active'.
	outcome jsonb check (outcome is null or (jsonb_typeof(outcome) = 'object' and pg_column_size(outcome) <= 16384
		and outcome ->> 'state' in ('succeeded','blocked','failed','cancelled'))),
	settled_at timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	primary key (worker_id, sequence),
	check ((input_from = 'dispatch') = (sequence = 1) and (input_from = 'dispatch') = (input_text is null)),
	check ((submission is null) = (submission_receipt_id is null) and (submission is null) = (submitted_at is null)),
	-- A submission belongs to the turn that made it, never to a later one.
	check (submission is null or (submission ->> 'sequence' = sequence::text and submission ->> 'workerId' = worker_id::text)),
	check ((outcome is null) = (settled_at is null))
);
alter table public.qorpera_coding_session_turns enable row level security;
revoke all on public.qorpera_coding_session_turns from public, anon, authenticated, service_role, qorpera_secret_broker;

-- A turn is history: its input never changes, its submission and its outcome are
-- written once, nothing is submitted after it settled, and no row is removed.
create function public.qorpera_coding_session_turn_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
	if tg_op = 'DELETE' then raise exception 'A coding turn is history and cannot be removed' using errcode = '55000'; end if;
	if (new.worker_id, new.sequence, new.input_from, new.input_text, new.input_user_id, new.input_run_id, new.created_at)
			is distinct from (old.worker_id, old.sequence, old.input_from, old.input_text, old.input_user_id, old.input_run_id, old.created_at)
		or (old.submission is not null and (new.submission, new.submission_receipt_id, new.submitted_at)
			is distinct from (old.submission, old.submission_receipt_id, old.submitted_at))
		or (old.outcome is not null and ((new.outcome, new.settled_at) is distinct from (old.outcome, old.settled_at)
			or new.submission is distinct from old.submission)) then
		raise exception 'A coding turn is recorded once' using errcode = '55000'; end if;
	return new;
end
$$;

-- The outcome as the next turn reads it, from a worker result of any path.
create function public.qorpera_coding_turn_outcome(p_state text, p_result jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('state', p_state, 'summary', p_result ->> 'summary', 'reason', p_result ->> 'reason',
		'needs', p_result ->> 'needs', 'options', coalesce(p_result -> 'options', '[]'::jsonb),
		'pullRequest', case when jsonb_typeof(p_result -> 'pullRequest') = 'object' then p_result -> 'pullRequest' end)
$$;

-- ---------------------------------------------------------------------------
-- 2. The sessions that exist: one row per turn so far
-- ---------------------------------------------------------------------------
-- Inputs come from the worker events every follow-up path wrote; outcomes from
-- the reports, cancellations and lease expiries recorded per sequence; the
-- session's one submission goes to the turn whose sequence it names (for a
-- session in the state of #8 that is the earlier, lost turn).
insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text, input_user_id, input_run_id, created_at)
select worker.id, turn.sequence,
	case when turn.sequence = 1 then 'dispatch' when followup.body ? 'byUserId' then 'member' else 'agent' end,
	case when turn.sequence > 1 then coalesce(nullif(btrim(followup.body ->> 'text'), ''), 'Not recorded.') end,
	case when turn.sequence > 1 then (followup.body ->> 'byUserId')::uuid end,
	followup.run_id,
	coalesce(followup.created_at, worker.created_at)
from public.qorpera_coding_sessions session
join public.qorpera_runtime_workers worker on worker.id = session.worker_id
cross join lateral generate_series(1, worker.sequence) turn(sequence)
left join lateral (select event.body, event.run_id, event.created_at from public.qorpera_runtime_worker_events event
	where event.worker_id = worker.id and event.sequence = turn.sequence
		and event.kind = case when turn.sequence = 1 then 'dispatched' else 'followup' end
	order by event.id desc limit 1) followup on true;

update public.qorpera_coding_session_turns turn set submission = session.submission, submission_receipt_id = session.submission_receipt_id,
	submitted_at = session.updated_at
from public.qorpera_coding_sessions session
where session.submission is not null and turn.worker_id = session.worker_id and turn.sequence::text = session.submission ->> 'sequence';

update public.qorpera_coding_session_turns turn set outcome = settled.outcome, settled_at = settled.at
from (
	select turn.worker_id, turn.sequence,
		coalesce(
			(select public.qorpera_coding_turn_outcome(event.body ->> 'outcome', event.body) from public.qorpera_runtime_worker_events event
				where event.worker_id = turn.worker_id and event.sequence = turn.sequence and event.kind = 'reported' order by event.id desc limit 1),
			(select public.qorpera_coding_turn_outcome('cancelled', jsonb_build_object('summary','Cancelled before it reported.','reason',event.body ->> 'reason'))
				from public.qorpera_runtime_worker_events event
				where event.worker_id = turn.worker_id and event.sequence = turn.sequence and event.kind = 'cancelled' order by event.id desc limit 1),
			case when turn.sequence = worker.sequence and worker.state <> 'active' then public.qorpera_coding_turn_outcome(worker.state, worker.result) end,
			(select public.qorpera_coding_turn_outcome('failed', jsonb_build_object('summary','The coding executor stopped responding; the workspace is kept.',
					'reason',event.body ->> 'reason'))
				from public.qorpera_coding_session_events event
				where event.worker_id = turn.worker_id and event.sequence = turn.sequence and event.kind = 'failed' and event.actor = 'kernel'
				order by event.id desc limit 1),
			case when turn.sequence < worker.sequence then public.qorpera_coding_turn_outcome('failed',
				jsonb_build_object('summary','The turn ended without a recorded result.','reason','unrecorded')) end) as outcome,
		coalesce(worker.reported_at, clock_timestamp()) as at
	from public.qorpera_coding_session_turns turn
	join public.qorpera_runtime_workers worker on worker.id = turn.worker_id
) settled
where turn.worker_id = settled.worker_id and turn.sequence = settled.sequence and settled.outcome is not null;

create trigger qorpera_coding_session_turns_guard before update or delete on public.qorpera_coding_session_turns
	for each row execute function public.qorpera_coding_session_turn_guard();

-- ---------------------------------------------------------------------------
-- 3. Settling a turn, and opening the next
-- ---------------------------------------------------------------------------
-- Whatever ends a coding turn (the executor's completion, a lost executor's
-- lease expiry, a cancellation) moves its worker out of 'active' with its
-- result; that settles the turn.
create function public.qorpera_settle_coding_turn()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_coding_session_turns set outcome = public.qorpera_coding_turn_outcome(new.state, new.result), settled_at = clock_timestamp()
	where worker_id = new.id and sequence = old.sequence and outcome is null;
	return null;
end
$$;
create trigger qorpera_runtime_workers_settle_coding_turn after update of state on public.qorpera_runtime_workers
	for each row when (old.state = 'active' and new.state <> 'active' and new.species = 'coding')
	execute function public.qorpera_settle_coding_turn();

-- Internal: the dispatch, a follow-up or an answer has just moved the worker to
-- its new sequence. The turn before it has settled: only a worker that is no
-- longer active takes a follow-up.
create function public.qorpera_open_coding_turn(p_worker public.qorpera_runtime_workers, p_from text, p_text text, p_user_id uuid, p_run_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_coding_session_turns turn where turn.worker_id = p_worker.id
		and turn.sequence < p_worker.sequence and turn.outcome is null) then
		raise exception 'The previous coding turn has not settled' using errcode = '55000'; end if;
	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text, input_user_id, input_run_id)
	values (p_worker.id, p_worker.sequence, p_from, case when p_from <> 'dispatch' then p_text end, p_user_id, p_run_id);
end
$$;

create function pg_temp.turn_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding turn integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- The dispatch and the agent's follow-up open their turn; the session no longer clears a submission of its own.
select pg_temp.turn_patch('public.qorpera_coding_session_queue(public.qorpera_runtime_workers,text,uuid,text)',
	$old$lease_until = null, submission = null, submission_receipt_id = null, claim_after = null,$old$,
	$new$lease_until = null, claim_after = null,$new$);
select pg_temp.turn_patch('public.qorpera_coding_session_queue(public.qorpera_runtime_workers,text,uuid,text)',
	$old$		case p_action when 'dispatch' then jsonb_build_object('phase','queued') else jsonb_build_object('text', p_text, 'runId', p_run_id) end);$old$,
	$new$		case p_action when 'dispatch' then jsonb_build_object('phase','queued') else jsonb_build_object('text', p_text, 'runId', p_run_id) end);
	perform public.qorpera_open_coding_turn(p_worker, case p_action when 'dispatch' then 'dispatch' else 'agent' end, p_text, null, p_run_id);$new$);

-- The owner's answer or follow-up opens its turn the same way (it never cleared the submission: #8).
select pg_temp.turn_patch('public.qorpera_answer_coding_session(uuid,text,uuid)',
	$old$		jsonb_build_object('text', v_text, 'userId', auth.uid(), 'clientRequestId', p_client_request_id));$old$,
	$new$		jsonb_build_object('text', v_text, 'userId', auth.uid(), 'clientRequestId', p_client_request_id));
	perform public.qorpera_open_coding_turn(v_worker, 'member', v_text, auth.uid(), null);$new$);

-- The submission is the turn's.
select pg_temp.turn_patch('public.qorpera_submit_coding_turn(jsonb,jsonb)',
	$old$declare v_authority jsonb; v_worker_id uuid; v_sequence integer; v_session public.qorpera_coding_sessions%rowtype;$old$,
	$new$declare v_authority jsonb; v_worker_id uuid; v_sequence integer; v_session public.qorpera_coding_sessions%rowtype;
	v_turn public.qorpera_coding_session_turns%rowtype;$new$);
select pg_temp.turn_patch('public.qorpera_submit_coding_turn(jsonb,jsonb)',
	$old$	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id for update;$old$,
	$new$	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id for update;
	select * into strict v_turn from public.qorpera_coding_session_turns where worker_id = v_worker_id and sequence = v_sequence for update;$new$);
select pg_temp.turn_patch('public.qorpera_submit_coding_turn(jsonb,jsonb)',
	$old$	if v_session.submission is not null then
		if v_session.submission <> v_response then raise exception 'Coding submission replay differs' using errcode = '23505'; end if;
		return v_session.submission;
	end if;$old$,
	$new$	if v_turn.submission is not null then
		if v_turn.submission <> v_response then raise exception 'Coding submission replay differs' using errcode = '23505'; end if;
		return v_turn.submission;
	end if;$new$);
select pg_temp.turn_patch('public.qorpera_submit_coding_turn(jsonb,jsonb)',
	$old$	update public.qorpera_coding_sessions set submission = v_response, submission_receipt_id = v_receipt, updated_at = clock_timestamp() where worker_id = v_worker_id;$old$,
	$new$	update public.qorpera_coding_session_turns set submission = v_response, submission_receipt_id = v_receipt, submitted_at = clock_timestamp()
	where worker_id = v_worker_id and sequence = v_sequence;
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() where worker_id = v_worker_id;$new$);

-- The runner's authority names the current turn's submission only, and needs the turn's open row.
select pg_temp.turn_patch('public.qorpera_authorize_coding_turn(jsonb)',
	$old$		or v_session.vm_allocation_id is null then$old$,
	$new$		or v_session.vm_allocation_id is null
		or not exists (select 1 from public.qorpera_coding_session_turns turn where turn.worker_id = v_worker.id
			and turn.sequence = v_worker.sequence and turn.outcome is null) then$new$);
select pg_temp.turn_patch('public.qorpera_authorize_coding_turn(jsonb)',
	$old$'pullRequest', v_session.pull_request, 'submission', v_session.submission));$old$,
	$new$'pullRequest', v_session.pull_request, 'submission', (select turn.submission from public.qorpera_coding_session_turns turn
			where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence)));$new$);

-- So does the executor's view of the turn.
select pg_temp.turn_patch('public.qorpera_describe_coding_turn(uuid,uuid)',
	$old$'jobError',v_job.last_error,'submission',v_session.submission,$old$,
	$new$'jobError',v_job.last_error,'submission',(select turn.submission from public.qorpera_coding_session_turns turn
			where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence),$new$);

-- The completion no longer consumes a session submission: the turn keeps it as history.
select pg_temp.turn_patch('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
	$old$lease_until = null, submission = null, submission_receipt_id = null, updated_at = clock_timestamp()$old$,
	$new$lease_until = null, updated_at = clock_timestamp()$new$);

-- A lost executor: the turn keeps what the harness submitted, and the failed
-- result names it, so the owner and the agent can answer or follow up on it.
select pg_temp.turn_patch('public.qorpera_claim_coding_session(text,integer)',
	$old$						'summary','The coding executor stopped responding; the workspace is kept.') where id = v_worker.id;$old$,
	$new$						'summary','The coding executor stopped responding; the workspace is kept.' || coalesce((select case turn.submission ->> 'kind'
							when 'ask' then ' Before it stopped, the session asked: ' || (turn.submission ->> 'question')
							when 'finish' then ' Commit ' || left(turn.submission ->> 'headSha', 12) || ' was submitted but not published; a follow-up can publish it.' end
						from public.qorpera_coding_session_turns turn where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence), ''))
					where id = v_worker.id;$new$);

alter table public.qorpera_coding_sessions drop column submission, drop column submission_receipt_id;

-- ---------------------------------------------------------------------------
-- 4. The next turn reads the session's own earlier turns
-- ---------------------------------------------------------------------------
-- Through the turn's run authority only. The input is what started this turn,
-- with the question it may answer: the one the previous turn ended with
-- (blocked), or one its lost executor never delivered. Earlier turns are the
-- newest that fit 48 KiB, oldest first, with the number left out.
create function public.qorpera_read_coding_turn_context(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_worker_id uuid; v_sequence integer; v_turn public.qorpera_coding_session_turns%rowtype;
	v_previous public.qorpera_coding_session_turns%rowtype; v_answers jsonb; v_earlier jsonb; v_omitted integer;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_worker_id := (v_authority #>> '{coding,workerId}')::uuid;
	v_sequence := (v_authority #>> '{coding,sequence}')::integer;
	select * into strict v_turn from public.qorpera_coding_session_turns where worker_id = v_worker_id and sequence = v_sequence;
	select * into v_previous from public.qorpera_coding_session_turns where worker_id = v_worker_id and sequence = v_sequence - 1;
	v_answers := case when v_turn.input_from = 'dispatch' then null
		when v_previous.outcome ->> 'state' = 'blocked' then
			jsonb_build_object('question', v_previous.outcome ->> 'needs', 'options', v_previous.outcome -> 'options')
		when v_previous.submission ->> 'kind' = 'ask' then
			jsonb_build_object('question', v_previous.submission ->> 'question', 'options', coalesce(v_previous.submission -> 'options', '[]'::jsonb))
		end;
	with earlier as (
		select turn.sequence, jsonb_build_object('sequence', turn.sequence,
			'input', jsonb_build_object('from', turn.input_from, 'text', turn.input_text),
			'submitted', case when turn.submission is not null then jsonb_build_object('kind', turn.submission ->> 'kind',
				'summary', turn.submission ->> 'summary', 'question', turn.submission ->> 'question',
				'options', coalesce(turn.submission -> 'options', '[]'::jsonb), 'headSha', turn.submission ->> 'headSha') end,
			'outcome', turn.outcome) as entry
		from public.qorpera_coding_session_turns turn where turn.worker_id = v_worker_id and turn.sequence < v_sequence
	), sized as (
		select earlier.sequence, earlier.entry, sum(octet_length(earlier.entry::text)) over (order by earlier.sequence desc) as running from earlier
	)
	select coalesce(jsonb_agg(sized.entry order by sized.sequence) filter (where sized.running <= 49152), '[]'::jsonb),
		(count(*) filter (where sized.running > 49152))::integer
	into v_earlier, v_omitted from sized;
	return jsonb_build_object('schema','qorpera.coding-turn-context/v1','workerId',v_worker_id,'sequence',v_sequence,
		'input', jsonb_build_object('from', v_turn.input_from, 'text', v_turn.input_text, 'answers', v_answers),
		'earlierTurns', v_earlier, 'omittedEarlierTurns', v_omitted);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_coding_session_turn_guard(), public.qorpera_coding_turn_outcome(text, jsonb),
	public.qorpera_settle_coding_turn(), public.qorpera_open_coding_turn(public.qorpera_runtime_workers, text, text, uuid, uuid),
	public.qorpera_read_coding_turn_context(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_read_coding_turn_context(jsonb) to service_role;
