-- 20260930582000: a turn refused for its bundle is tried again only on a newer bundle (5 Nov 2026).
-- Found in v207's prep: 20260930581000 retries a session turn the node refused for its bundle whenever the run's bundle
-- is not the active one. After a roll back (N+1 to N), a turn of N+1 that an N node refuses is tried again, its input
-- stays N+1 (the re-pin only moves forward), its new run is refused again, and so on without end. Now the retry, like
-- the re-pin, needs the active bundle to be a newer version of the run's own; otherwise the turn stays failed, as before
-- 581000. Every changed body carries the marker 20260930582000.

set local lock_timeout = '3s';

do $do$
declare v_definition text := pg_get_functiondef('public.qorpera_retry_run_refused_for_retired_bundle(uuid,boolean)'::regprocedure);
	v_old text := $old$		and run.runtime_bundle_sha256 <> (select active.runtime_bundle_sha256
			from public.qorpera_active_runtime_bundle as active where active.singleton)
$old$;
	v_new text := $new$		-- 20260930582000: only when the active bundle is a newer version of the run's own, as the re-pin moves inputs: after
		-- a roll back a newer run's retry would be refused again, without end.
		and exists (select 1 from public.qorpera_runtime_bundles as own
			join public.qorpera_active_runtime_bundle as active on active.singleton
			join public.qorpera_runtime_bundles as live on live.id = active.runtime_bundle_id
			where own.id = run.runtime_bundle_id and own.bundle_key = live.bundle_key and own.version < live.version)
$new$;
begin
	if position('20260930582000' in v_definition) > 0 then
		raise exception '20260930582000 is already in qorpera_retry_run_refused_for_retired_bundle'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930582000 anchor differs in qorpera_retry_run_refused_for_retired_bundle'; end if;
	execute replace(v_definition, v_old, v_new);
end $do$;
