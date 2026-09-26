-- Coding turn continuity, review fixes (code review of #305 = v113,
-- 20260925113000; 2026-09-25).
--
-- 1. A turn's outcome names only the pull request that turn published. The
--    worker result repeats the session's standing PR on every later report,
--    so a failed or blocked turn after PR 204 read as if it had published 204.
--    The settle trigger now compares the result's PR with the session's PR
--    from before the turn (completion updates it only afterwards): a new head
--    on the same PR is that turn's publication, the standing PR re-reported
--    unchanged is not.
-- 2. Rows written before this migration are corrected once, from the thread's
--    own events: the standing PR is removed from turns that published nothing,
--    and backfilled "Not recorded." inputs take the session's input event and
--    its time (and a predecessor settled at that time follows it). The guard
--    that keeps a turn "recorded once" is set aside for exactly these derived
--    corrections and restored in the same transaction.
-- 3. A coding worker cannot commit a sequence without its turn row (deferred
--    constraint triggers). The turn context refuses a gap, so a future path
--    that moved the sequence without opening the turn would otherwise break
--    every later turn of that session.
-- 4. The newest earlier turn is always in the history window, even when it
--    alone is over the 48 KiB budget (escaped control characters).

create function pg_temp.review_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding turn review fix differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The pull request a turn published
-- ---------------------------------------------------------------------------
create function public.qorpera_coding_turn_outcome(p_state text, p_result jsonb, p_published jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('state', p_state, 'summary', p_result ->> 'summary', 'reason', p_result ->> 'reason',
		'needs', p_result ->> 'needs', 'options', coalesce(p_result -> 'options', '[]'::jsonb),
		'pullRequest', case when jsonb_typeof(p_published) = 'object' then p_published end)
$$;

select pg_temp.review_patch('public.qorpera_settle_coding_turn()',
	$old$begin
	-- The session before its turn, the order submit and complete take them in.
	perform 1 from public.qorpera_coding_sessions where worker_id = new.id for update;
	update public.qorpera_coding_session_turns set outcome = public.qorpera_coding_turn_outcome(new.state, new.result), settled_at = clock_timestamp()$old$,
	$new$declare v_standing jsonb;
begin
	-- The session before its turn, the order submit and complete take them in. Its pull
	-- request is still the one from before this turn: completion updates it afterwards.
	select pull_request into v_standing from public.qorpera_coding_sessions where worker_id = new.id for update;
	update public.qorpera_coding_session_turns set outcome = public.qorpera_coding_turn_outcome(new.state, new.result,
			case when new.result -> 'pullRequest' is distinct from v_standing then new.result -> 'pullRequest' end),
		settled_at = clock_timestamp()$new$);
-- The two-argument form stays: a completion in flight across this migration may
-- still run the old trigger body. Nothing new calls it; a later migration may drop it.

-- ---------------------------------------------------------------------------
-- 2. Rows written before this migration, corrected once from the thread's events
-- ---------------------------------------------------------------------------
alter table public.qorpera_coding_session_turns disable trigger qorpera_coding_session_turns_guard;
-- The rule the settle trigger now applies: a turn published the pull request its
-- completion recorded as the thread's 'published' event, unless that is exactly
-- the standing PR from an earlier turn (a follow-up that re-reported it unchanged).
with published as (
	select turn.worker_id, turn.sequence,
		(select event.body from public.qorpera_coding_session_events event where event.worker_id = turn.worker_id
			and event.sequence = turn.sequence and event.kind = 'published' and event.actor = 'executor' and jsonb_typeof(event.body) = 'object'
		order by event.id desc limit 1) as mine,
		(select event.body from public.qorpera_coding_session_events event where event.worker_id = turn.worker_id
			and event.sequence < turn.sequence and event.kind = 'published' and event.actor = 'executor' and jsonb_typeof(event.body) = 'object'
		order by event.sequence desc, event.id desc limit 1) as standing
	from public.qorpera_coding_session_turns turn where turn.outcome is not null
), corrected as (
	select published.worker_id, published.sequence,
		coalesce(case when published.mine is distinct from published.standing then published.mine end, 'null'::jsonb) as pull_request
	from published
)
update public.qorpera_coding_session_turns turn set outcome = jsonb_set(turn.outcome, '{pullRequest}', corrected.pull_request)
from corrected
where corrected.worker_id = turn.worker_id and corrected.sequence = turn.sequence
	and turn.outcome -> 'pullRequest' is distinct from corrected.pull_request;
-- A backfilled input without its worker event takes the session's own input event.
update public.qorpera_coding_session_turns turn set input_from = case when input.actor = 'member' then 'member' else 'agent' end,
	input_text = btrim(input.body ->> 'text'),
	input_user_id = case when input.actor = 'member' then (input.body ->> 'userId')::uuid end,
	input_run_id = case when input.actor = 'agent' then (input.body ->> 'runId')::uuid end,
	-- It was dated by its worker's creation for want of the event; the input event has the time.
	created_at = input.created_at
from (select distinct on (event.worker_id, event.sequence) event.worker_id, event.sequence, event.actor, event.body, event.created_at
	from public.qorpera_coding_session_events event where event.kind = 'input' and event.actor in ('member','agent')
	order by event.worker_id, event.sequence, event.id desc) input
where turn.input_text = 'Not recorded.' and turn.input_user_id is null and turn.input_run_id is null
	and input.worker_id = turn.worker_id and input.sequence = turn.sequence
	and octet_length(btrim(coalesce(input.body ->> 'text', ''))) between 1 and 4000;
-- A turn with no evidence of its end was settled when the next one started: follow a re-dated next turn.
update public.qorpera_coding_session_turns turn set settled_at = next.created_at
from public.qorpera_coding_session_turns next
where next.worker_id = turn.worker_id and next.sequence = turn.sequence + 1
	and turn.outcome ->> 'reason' = 'unrecorded' and turn.settled_at is distinct from next.created_at;
alter table public.qorpera_coding_session_turns enable trigger qorpera_coding_session_turns_guard;

-- ---------------------------------------------------------------------------
-- 3. Every committed sequence has its turn
-- ---------------------------------------------------------------------------
create function public.qorpera_assert_coding_turn_recorded()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if not exists (select 1 from public.qorpera_coding_session_turns turn where turn.worker_id = new.id and turn.sequence = new.sequence) then
		raise exception 'Coding worker % reached sequence % without recording its turn', new.id, new.sequence using errcode = '55000'; end if;
	return null;
end
$$;
create constraint trigger qorpera_runtime_workers_coding_turn_recorded after insert on public.qorpera_runtime_workers
	deferrable initially deferred for each row when (new.species = 'coding')
	execute function public.qorpera_assert_coding_turn_recorded();
create constraint trigger qorpera_runtime_workers_coding_turn_sequence after update of sequence on public.qorpera_runtime_workers
	deferrable initially deferred for each row when (new.species = 'coding' and new.sequence is distinct from old.sequence)
	execute function public.qorpera_assert_coding_turn_recorded();

-- ---------------------------------------------------------------------------
-- 4. The newest earlier turn is always in the window
-- ---------------------------------------------------------------------------
select pg_temp.review_patch('public.qorpera_read_coding_turn_context(jsonb)',
	$old$	select coalesce(jsonb_agg(sized.entry order by sized.sequence) filter (where sized.running <= 49152), '[]'::jsonb),
		(count(*) filter (where sized.running > 49152))::integer
	into v_earlier, v_omitted from sized;$old$,
	$new$	-- The newest earlier turn is always kept, even alone over the budget.
	select coalesce(jsonb_agg(sized.entry order by sized.sequence) filter (where sized.running <= 49152 or sized.sequence = v_sequence - 1), '[]'::jsonb),
		(count(*) filter (where not (sized.running <= 49152 or sized.sequence = v_sequence - 1)))::integer
	into v_earlier, v_omitted from sized;$new$);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_coding_turn_outcome(text, jsonb, jsonb), public.qorpera_coding_turn_outcome(text, jsonb),
	public.qorpera_assert_coding_turn_recorded()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
