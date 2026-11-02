-- 20260930547000 (release PR #1390 review F1): a run in Agent notebooks mode that has sent its final message no longer
-- resumes from its receipts.
--
-- G1 b (20260930539000) lets a started run in Agent notebooks mode with no log go on after a cut-off, from its own
-- receipts (qorpera_run_resumes_from_receipts, its :59-68). That check did not ask whether the run had already sent its
-- final message, and neither does the cut-off (qorpera_resume_run_from_log, 20260928519120:116-126). So a run cut off
-- after its final send committed and before its job completed (its runner died in between) was queued again, and its
-- next attempt could not end:
-- - every new send is refused once the run has a final (20260928279560:160-161, 55000 'agent public output is already
--   final'); a send under the old final's key replays the old message, of the earlier attempt;
-- - the runtime ends an attempt whose wake needs a final only with a final send of that attempt (cloud-agent-mouth.ts
--   finish), and the completion counts only this attempt's sends (20260928279600:147-150): the old final counts 0, and
--   a result that names it is refused (55000 'Native completion does not match durable public delivery').
-- Now the check also needs the run to have sent no final. Such a run takes v190's path again: cut off, failed by its
-- runner or at its usage limit, its job fails and it waits for review. It is never queued again.
-- The fences stay as they are. G1 b's (its :161), F9's (20260930545000) and A3's (20260930546000) each ask this check
-- first and then hold only a resumed attempt that has not recorded its resume. A run this check now leaves out is never
-- queued again, so it has no such attempt; and a resumed attempt records its resume before it can send its final (F9's
-- send fence), so it passes the fences after its final as it did before.
-- Unchanged: the function's name, argument, result, language, volatility, security definer, search path, owner and
-- grants (nobody may call it); its callers; a run that has sent no final (it resumes as before, 466); a run that
-- keeps a log (W5a; its gate, 20260928549150, reads no final, as before) and a run in Agent tree mode; the tables,
-- the settings and the data. The new read is an index lookup (qorpera_agent_sends_one_final, 20260827004000).
-- Limit: a run queued again before this applies (only possible between 539000 and this migration; 539000 is not live)
-- is not reconciled. Its next attempt reads no receipts (null), its resume record is refused (55000), and the fences no
-- longer hold it.
-- Rollback: if the roll goes back to bundle 190, this migration stays applied, like 539000, 545000 and 546000. That is
-- safe: it only turns the receipts resume off for a run that has sent its final, and with it off such a run takes
-- v190's own path (it fails and waits for review). It adds no table, column, grant or setting and changes no data, so
-- there is nothing to undo.
-- The pre-check refuses unless the function's body is exactly 539000's, by md5. The catalog check refuses unless
-- exactly this function changed, and only in its body.
-- Deploy order: after 539000. In the v191 roll it runs right after 546000, before the runtime switch.
-- Every inserted text names this migration (20260930547000), for the deploy guard.

do $$
declare v_source text := (select prosrc from pg_proc
	where oid = to_regprocedure('public.qorpera_run_resumes_from_receipts(uuid)'));
begin
	if v_source is null then
		raise exception '20260930547000 (#1390 F1) needs G1 b (20260930539000)'; end if;
	if strpos(v_source, '20260930547000') > 0 then
		raise exception '20260930547000 (#1390 F1) is already applied'; end if;
	-- The body it replaces, by its md5: anything else refuses this migration.
	if md5(v_source) <> 'bcab1d1c0e5b9f7ca5c0a5b00517d85d' then
		raise exception '20260930547000 (#1390 F1): the receipts check differs from its pinned body'; end if;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table f1_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

-- Which run resumes from its receipts -----------------------------------------------------------------------------------

-- Plain reads. A coding session's turn is its worker's dispatch wake of the coding species (as
-- qorpera_authorize_coding_turn reads it).
create or replace function public.qorpera_run_resumes_from_receipts(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930539000 (G1 b): an Agent notebooks run with no log, and no coding session's turn.
	select exists (select 1 from public.qorpera_execution_runs as run
		where run.id = p_run_id and run.memory_mode is distinct from 'tree'
			and not exists (select 1 from public.qorpera_memory_run_logs as log
				where log.environment_id = run.environment_id and log.run_id = run.id)
			and not exists (select 1 from public.qorpera_wake_occurrences as wake
				where wake.run_id = run.id and wake.source_kind = 'worker-dispatch' and wake.payload ->> 'species' = 'coding')
			-- 20260930547000 (#1390 F1): that has sent no final; such a run fails and waits for review.
			and not exists (select 1 from public.qorpera_agent_sends as delivery
				where delivery.run_id = run.id and delivery.phase = 'final'))
$$;
revoke all on function public.qorpera_run_resumes_from_receipts(uuid) from public, anon, authenticated, service_role;

-- The deploy guard ---------------------------------------------------------------------------------------------------------

-- The marker occurs once, and these texts come in this order, each found after the one before it.
do $guard$
declare v_source text := (select prosrc from pg_proc
		where oid = 'public.qorpera_run_resumes_from_receipts(uuid)'::regprocedure);
	v_texts text[] := array['20260930539000', 'run.memory_mode is distinct from ''tree''', 'public.qorpera_memory_run_logs',
		'public.qorpera_wake_occurrences', '20260930547000', 'public.qorpera_agent_sends', 'delivery.phase = ''final'''];
	v_at integer := 0; v_next integer;
begin
	if (length(v_source) - length(replace(v_source, '20260930547000', ''))) / length('20260930547000') <> 1 then
		raise exception '20260930547000 marker is not once in qorpera_run_resumes_from_receipts(uuid)'; end if;
	for i in 1 .. cardinality(v_texts) loop
		v_next := strpos(substr(v_source, v_at + 1), v_texts[i]);
		if v_next = 0 then
			raise exception '20260930547000 check is out of place: %', v_texts[i]; end if;
		v_at := v_at + v_next;
	end loop;
end $guard$;

-- The catalog check -------------------------------------------------------------------------------------------------------

-- Exactly this function changed, only in its body; every other public function is as it was, and none came or went.
do $$ begin
	if (select count(*) from pg_temp.f1_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> 1
		or exists (select 1 from pg_temp.f1_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source
					and prior.oid <> 'public.qorpera_run_resumes_from_receipts(uuid)'::regprocedure))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.f1_before as prior)) then
		raise exception '20260930547000: the catalog did not change as expected'; end if;
end $$;

drop table pg_temp.f1_before;
