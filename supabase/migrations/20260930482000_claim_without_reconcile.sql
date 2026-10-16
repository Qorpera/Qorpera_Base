-- The claim no longer runs the whole reconcile, and the reconcile's sweep of reserved model requests uses an index
-- (production DB slowness, 16 October 2026).
--
-- Every orchestrator asks for work every 250 ms, and qorpera_claim_runner_job_for_orchestrator (20260916210000) first
-- ran qorpera_reconcile_runner_orchestrator: the gate, a heartbeat that rewrites the orchestrator row, and nine sweeps
-- over the whole fleet. Each orchestrator's reconcile lane runs the same reconcile every 2 seconds anyway, and only
-- claims after a good pass (packages/runner-orchestrator), so the claims repeated it about eight times a lane interval
-- for every orchestrator. In production that was 3.57 million claims at 2.7 ms each, about 90% of it the reconcile.
--
-- The claim now keeps the two things it needs from the reconcile:
--   1. The gate. Only an active orchestrator claims; a draining or revoked one gets the reconcile's error (42501
--      'orchestrator is unavailable'), before the replay lookup as before. The runner-orchestrator edge function lets a
--      draining orchestrator through, so this check is the one that stops it.
--   2. The heartbeat. Placement counts a fast host only if it was seen in the last 30 seconds, and while a slow provider
--      reconcile holds up the lane, the claims are what keep an idle host seen. The claim now writes the heartbeat only
--      when it is more than 5 seconds old (six times inside the 30), and skips it when the row is locked: the lane
--      holding it is writing the heartbeat itself. So a claim never waits on a lane pass.
-- What waits for the lane now: an expired lease is requeued and an expired claim released by the next pass (2 seconds
-- plus the pass) rather than by the next claim. Leases are 30 to 900 seconds, so that is noise. The other sweeps (the
-- 24-hour limit, the finishing window, a sponsor or computer that is gone) can fail a queued job up to one pass later.
--
-- The reconcile's sweep of expired reserved model requests read every finished job and checked each for a reserved
-- request: the only sweep with no index, and it grows with every job. It now starts from the expired reserved requests,
-- through a partial index. Nothing inserts model requests any more (the broker's reserve went in 20260928549280), so
-- the index is built at once and stays small.
--
-- Both functions are patched in place from pg_get_functiondef, so their settings (the claim's 25-second lock and
-- statement timeouts), their grants and every earlier patch stay. The claim keeps the three texts the bundle
-- activations look for. DB only: running orchestrators call the claim and the reconcile as before.
set local lock_timeout = '3s';

create function pg_temp.h_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930482000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

create index qorpera_runner_model_requests_reserved_expiry
on public.qorpera_runner_model_requests (reservation_expires_at, job_id)
where status = 'reserved';

select pg_temp.h_replace(
	'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)',
	E'\tperform public.qorpera_reconcile_runner_orchestrator(p_orchestrator_id);\n',
	E'\t-- 20260930482000: the orchestrator\'s reconcile lane sweeps; the claim only needs its orchestrator active and seen.\n'
	|| E'\tif not exists (\n'
	|| E'\t\tselect 1 from public.qorpera_runner_orchestrators as orchestrator\n'
	|| E'\t\twhere orchestrator.id = p_orchestrator_id and orchestrator.status = \'active\'\n'
	|| E'\t) then\n'
	|| E'\t\traise exception \'orchestrator is unavailable\' using errcode = \'42501\';\n'
	|| E'\tend if;\n'
	|| E'\tupdate public.qorpera_runner_orchestrators as orchestrator set last_heartbeat_at = statement_timestamp()\n'
	|| E'\twhere orchestrator.id = (\n'
	|| E'\t\tselect seen.id from public.qorpera_runner_orchestrators as seen\n'
	|| E'\t\twhere seen.id = p_orchestrator_id and seen.last_heartbeat_at < statement_timestamp() - interval \'5 seconds\'\n'
	|| E'\t\tfor no key update skip locked\n'
	|| E'\t);\n'
);

select pg_temp.h_replace(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)',
	E'\tperform public.qorpera_quarantine_runner_model_requests(\n'
	|| E'\t\tjob.id, \'The runner disappeared before the model gateway result was recorded\'\n'
	|| E'\t)\n'
	|| E'\tfrom public.qorpera_runner_jobs as job\n'
	|| E'\twhere job.status in (\'completed\', \'failed\', \'cancelled\')\n'
	|| E'\t\tand exists (\n'
	|| E'\t\t\tselect 1 from public.qorpera_runner_model_requests as request\n'
	|| E'\t\t\twhere request.job_id = job.id and request.status = \'reserved\'\n'
	|| E'\t\t\t\tand request.reservation_expires_at <= statement_timestamp()\n'
	|| E'\t\t);\n',
	E'\t-- 20260930482000: the expired reserved requests drive this sweep (qorpera_runner_model_requests_reserved_expiry),\n'
	|| E'\t-- not every finished job.\n'
	|| E'\tperform public.qorpera_quarantine_runner_model_requests(\n'
	|| E'\t\tjob.id, \'The runner disappeared before the model gateway result was recorded\'\n'
	|| E'\t)\n'
	|| E'\tfrom (\n'
	|| E'\t\tselect distinct request.job_id from public.qorpera_runner_model_requests as request\n'
	|| E'\t\twhere request.status = \'reserved\' and request.reservation_expires_at <= statement_timestamp()\n'
	|| E'\t) as expired\n'
	|| E'\tjoin public.qorpera_runner_jobs as job on job.id = expired.job_id\n'
	|| E'\twhere job.status in (\'completed\', \'failed\', \'cancelled\');\n'
);

do $$
declare
	v_claim text := pg_get_functiondef('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure);
	v_config text[];
begin
	select proconfig into v_config from pg_proc
	where oid = 'public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure;
	if position('20260930482000' in v_claim) = 0 or position('qorpera_reconcile_runner_orchestrator(' in v_claim) > 0
		or position('qorpera_runtime_orchestrator_nodes(v_adapter)' in v_claim) = 0
		or position('declared.runtime_bundle_sha256' in v_claim) = 0
		or position('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)' in v_claim) = 0
		or not v_config @> array['search_path=""', 'lock_timeout=25s', 'statement_timeout=25s'] then
		raise exception '20260930482000: the claim did not change as expected'; end if;
	if position('qorpera_runner_model_requests_reserved_expiry' in pg_get_functiondef(
		'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure)) = 0 then
		raise exception '20260930482000: the reconcile did not change as expected'; end if;
end $$;
