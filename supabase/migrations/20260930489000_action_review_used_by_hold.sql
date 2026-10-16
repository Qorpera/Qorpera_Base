-- A woken agent's repeat is told its approval was used whenever a held call used it, not only within 30 s of the wake
-- (fix A, for the runtime's hold retry of v181, #1227).
--
-- qorpera_begin_action_review (20260926130000) answers 'used' when a member's answer woke the agent but a call of
-- another run had already used the approval: the repeat the wake asks for has nothing left to do. Which call used it
-- was read from the time: within 30 s of the wake meant the call that was still holding the card (its heartbeat had
-- lapsed, so the answer woke the agent), later meant any other call. Two faults:
-- 1. A holding call whose polls fail for longer uses the approval more than 30 s after the wake. The woken repeat is
--    then reviewed again, and under an allow rule (Always allow saves one) the action runs twice. So the runtime (#1227)
--    asks a failed poll again only until 5 s after the answer could first have woken the agent, not until its hold ends.
-- 2. A woken repeat that used the approval itself within 30 s of the wake made the same exact call of the agent's other
--    runs for that member 'used' for an hour: refused as already run, with nothing written and no card.
--
-- Now qorpera_await_action_review, the held call's poll, marks the approval it uses (consumed_by_hold), and begin
-- answers 'used' when a held call of another run used it, however long after the wake; the hour after the wake stays.
-- A call that begins (begin's 'approved') leaves the mark unset, so once the woken repeat used the approval itself, a
-- later call of another run is reviewed afresh. Approvals used before this migration keep their answer: the mark is set
-- where the old rule read a holder (used within 30 s of the wake).
--
-- Both functions keep their signatures, grants and settings (the host call allows one function per name,
-- 20260928409985). DB only: no caller changes; the runtime may then ask a failed poll again until its hold ends.
set local lock_timeout = '3s';

create temporary table fix_a_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in ('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)'::regprocedure);

-- Replaces p_old, found exactly once in the function's definition, by p_new, and runs the result.
create function pg_temp.fix_a_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930489000: the patch anchor is not found once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_action_reviews add column consumed_by_hold boolean not null default false;
comment on column public.qorpera_action_reviews.consumed_by_hold is
	'The approval was used by a held call (qorpera_await_action_review), not by a call that began after the answer '
	'(qorpera_begin_action_review): the agent the answer woke is told it was used. 20260930489000.';
-- Approvals used before this migration: the old rule's reading, so begin answers each of them as before.
update public.qorpera_action_reviews set consumed_by_hold = true
where woken_at is not null and consumed_at < woken_at + interval '30 seconds';
alter table public.qorpera_action_reviews add constraint qorpera_action_reviews_consumed_by_hold
	check (not consumed_by_hold or consumed_at is not null);

select pg_temp.fix_a_patch('public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)',
	E'\t\tupdate public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = v_run.id\n'
	|| E'\t\twhere id = v_review.id;\n\t\tv_state := ''approved'';\n',
	E'\t\t-- A held call used it: the agent its answer woke is told so (20260930489000).\n'
	|| E'\t\tupdate public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = v_run.id,\n'
	|| E'\t\t\tconsumed_by_hold = true\n'
	|| E'\t\twhere id = v_review.id;\n\t\tv_state := ''approved'';\n');

select pg_temp.fix_a_patch('public.qorpera_begin_action_review(jsonb,jsonb)',
	E'\t\tand v_review.consumed_at < v_review.woken_at + interval ''30 seconds''\n'
	|| E'\t\tand clock_timestamp() < v_review.woken_at + interval ''1 hour'' then\n'
	|| E'\t\t-- The answer woke the agent, but the call that was still holding ran it: the\n'
	|| E'\t\t-- repeat the wake asks for has nothing left to do.\n',
	E'\t\tand v_review.consumed_by_hold\n'
	|| E'\t\tand clock_timestamp() < v_review.woken_at + interval ''1 hour'' then\n'
	|| E'\t\t-- The answer woke the agent, but a call that was still holding ran it, however long\n'
	|| E'\t\t-- after the wake (20260930489000): the repeat the wake asks for has nothing left to do.\n');

do $$
declare v_begin text := (select prosrc from pg_proc where oid = 'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure);
	v_await text := (select prosrc from pg_proc
		where oid = 'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)'::regprocedure);
begin
	if position('20260930489000' in v_begin) = 0 or position('and v_review.consumed_by_hold' in v_begin) = 0
		or position('30 seconds' in v_begin) > 0 or position('woken_at + interval ''1 hour''' in v_begin) = 0
		or position('20260930489000' in v_await) = 0 or position('consumed_by_hold = true' in v_await) = 0
		or exists (
			select 1 from pg_temp.fix_a_before as prior join pg_proc as patched on patched.oid = prior.oid
			where patched.prosecdef is distinct from prior.prosecdef or patched.proconfig is distinct from prior.proconfig
				or patched.provolatile is distinct from prior.provolatile
				or patched.proacl::text is distinct from prior.proacl::text)
		or (select count(*) from pg_proc where proname in ('qorpera_begin_action_review', 'qorpera_await_action_review')) <> 2
		or exists (select 1 from public.qorpera_action_reviews
			where woken_at is not null and consumed_at < woken_at + interval '30 seconds' and not consumed_by_hold) then
		raise exception '20260930489000: the action review functions did not change as expected'; end if;
end $$;
