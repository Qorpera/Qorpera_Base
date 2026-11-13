-- 20260930751000: a run that already sent its final message shows no failure under its answer (the lead's call inside
-- the answer-first build, lanes/agent-box-20261113/B2-ANSWER-FIRST.md; it rides 20260930748000).
--
-- Why: until now `qorpera_list_staff_execution_activity` called every failed run of an agent `needs_attention`, whatever
-- the run had already delivered. A run that answered its member and then failed therefore put a card under that answer
-- ("{agent} did not finish this run"), and while the run had saved nothing durable the card also offered Try again,
-- which runs the member's message again and can answer it twice. The window for that was the 0.13 s between a final
-- send and the run's end; the answer first (20260930748000) widens it to the run's bookkeeping tail, 2 to 8 s measured,
-- so the hole is closed here, with the change that widens it. A duplicate answer to a member is worse than those seconds.
--
-- * The candidates' WHERE gains one condition, in the branch that lists a failed or cancelled run (a member's Stop is
--   already no failure there): such a run is listed only while it has sent no final message of its own
--   (`qorpera_agent_sends`, phase 'final', an index lookup on `qorpera_agent_sends_one_final`, 20260827004000, as
--   20260930547000 reads it), OR its work left an open proposal, which is a decision the member must still make and is
--   shown as one ("stopped with changes to review"). Nothing else in the function changes: the activity classes, the
--   priorities, the superseded rule (20260930542000), the acknowledged-failure-with-an-open-proposal branch, the
--   earlier-failure list, the writing phase (20260920011000) and every key of an entry stay as they are.
-- * What this does NOT hide: a run that failed with no answer (the member must know it got none); a delivered run whose
--   change waits for a decision; a member's own Stop (already apart); the run's record itself, its job's error, the
--   wake's status and every operator view, which keep the failure for whoever looks after the platform.
-- * No runtime change and no web change: with no row for the run, the thread shows the answer alone, the agent reads
--   idle, and Try again is not offered because there is nothing to offer it on.
-- One create or replace of the function as 20260930542000 wrote it (with the writing phase of 20260920011000 and the
-- acknowledgement rules of 20260922010000 inside it), patched at one exact anchor. Its name, arguments, result,
-- language, volatility, security definer, search path, owner and grants are untouched. SQL test 1245.
-- Deploy order: with or after 20260930748000, before or with the runtime bundle; it is read-only and changes no data, so
-- either order is safe and a rollback needs nothing undone.
-- Every inserted text names this migration (20260930751000), for the deploy guard.

do $$ begin
	if to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)') is null then
		raise exception '20260930751000 needs the staff execution activity read'; end if;
	if position('20260930751000' in pg_get_functiondef(
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0 then
		raise exception '20260930751000 is already applied'; end if;
	if position('20260930542000' in pg_get_functiondef(
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) = 0 then
		raise exception '20260930751000 needs the superseded-failure rule (20260930542000)'; end if;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table da_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

-- A delivered answer is no failure for a member ---------------------------------------------------------------------

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_old constant text :=
		E'\t\t\t\tor (job.status in (''failed'', ''cancelled'') and job.cancelled_by_user_id is null and ( -- a member''s Stop is no failure\n';
	v_new constant text :=
		E'\t\t\t\tor (job.status in (''failed'', ''cancelled'') and job.cancelled_by_user_id is null -- a member''s Stop is no failure\n'
		|| E'\t\t\t\t\t-- 20260930751000: a run that sent its final message answered the member, so its own failure after that\n'
		|| E'\t\t\t\t\t-- (its bookkeeping: the answer first) is no decision for them, unless its work left a proposal to decide.\n'
		|| E'\t\t\t\t\tand (not exists (\n'
		|| E'\t\t\t\t\t\tselect 1 from public.qorpera_agent_sends as delivered\n'
		|| E'\t\t\t\t\t\twhere delivered.run_id = run.id and delivered.phase = ''final''\n'
		|| E'\t\t\t\t\t) or exists (\n'
		|| E'\t\t\t\t\t\tselect 1 from public.qorpera_company_proposals as proposal\n'
		|| E'\t\t\t\t\t\twhere proposal.execution_kind = ''run'' and proposal.execution_id = run.id\n'
		|| E'\t\t\t\t\t\t\tand proposal.status = ''open''\n'
		|| E'\t\t\t\t\t)) and (\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930751000: the failed-run branch is not once in the activity read'; end if;
	execute replace(v_definition, v_old, v_new);
end $$;

-- The deploy guard ----------------------------------------------------------------------------------------------------

do $guard$
declare v_source text := (select prosrc from pg_proc
	where oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
begin
	if strpos(v_source, '20260930751000') = 0 then
		raise exception '20260930751000 marker is missing in the activity read'; end if;
	-- The rules this one joins stay where they were.
	if strpos(v_source, '20260930542000') = 0 then
		raise exception '20260930751000 lost the superseded-failure rule (20260930542000)'; end if;
	if strpos(v_source, 'a member''s Stop is no failure') = 0 then
		raise exception '20260930751000 lost the member''s-Stop rule'; end if;
	if strpos(v_source, 'public.qorpera_agent_sends') = 0 then
		raise exception '20260930751000 did not add the delivered-answer read'; end if;
end $guard$;

-- The catalog check ------------------------------------------------------------------------------------------------

-- Exactly this function changed, only in its body; every other public function is as it was, and none came or went.
do $$ begin
	if (select count(*) from pg_temp.da_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> 1
		or exists (select 1 from pg_temp.da_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source
					and prior.oid <> 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.da_before as prior)) then
		raise exception '20260930751000: the catalog did not change as expected'; end if;
end $$;

drop table pg_temp.da_before;
