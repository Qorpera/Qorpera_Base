-- 20260930413000: the legacy sweep, step D14 (the hosted primary's turn and wake executor). The snapshot-v1 hosted
-- primary's lease-based executor goes (folder-v2 only, the founder's decision of 3 October): it claimed a session's
-- turn or a wake against the company's head snapshot and the staff version, renewed and completed the lease,
-- quarantined a turn, read its status, and listed and resolved a session's recoveries. A folder-v2 conversation is a
-- room, and its runs go through the folder core's execution runs; a folder-v2 company never has a head snapshot to
-- pin. HP-E1 removed cloud-client's hosted primary, the last caller.
-- 1. Dropped: the eleven. None of them is a native host call, and no trigger, policy, constraint or default names them.
-- Kept: qorpera_get_execution_run_recovery, which the web calls; the session turns (a recovery is a quarantined turn)
-- and the wake claims, which other functions use (step G); and the helpers the eleven called, which others call too.
-- The runtime bundle's template and the v178 activation no longer name the wake claim; only earlier activations do.
set local lock_timeout = '3s';

-- 1. The executor. ----------------------------------------------------------------------------------------------------

drop function public.qorpera_claim_session_turn(uuid,uuid,integer,uuid,bigint);
drop function public.qorpera_renew_session_turn_v2(uuid,uuid,uuid,integer);
drop function public.qorpera_complete_session_turn_v2(uuid,uuid,uuid,bigint);
drop function public.qorpera_quarantine_session_turn(uuid,uuid,uuid,text);
drop function public.qorpera_get_session_turn_status(uuid,uuid,uuid);
drop function public.qorpera_list_session_recoveries(uuid,timestamp with time zone,uuid,integer);
drop function public.qorpera_list_session_execution_run_recoveries(uuid,integer);
drop function public.qorpera_resolve_session_recovery(uuid,uuid,text);
drop function public.qorpera_claim_wake_v2(uuid,text,uuid,integer,uuid,uuid,bigint);
drop function public.qorpera_renew_wake(uuid,text,uuid,integer);
drop function public.qorpera_complete_wake(uuid,text,uuid);

-- Nothing that runs may still name them.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_((claim|quarantine)_session_turn|(renew|complete)_session_turn_v2'
				'|get_session_turn_status|list_session_(execution_run_)?recoveries|resolve_session_recovery'
				'|claim_wake_v2|(renew|complete)_wake)\M')
	loop
		raise exception 'Function % still names the hosted primary''s turn or wake executor', v_name;
	end loop;
end $$;
