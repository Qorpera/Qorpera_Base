-- 20260930410000: the legacy sweep, step D8 (company workspaces and snapshots). The snapshot-v1 workspace lane a
-- member's client used to commit a Company File tree goes (folder-v2 only, the founder's decision of 3 October). HP-C2
-- removed the client's calls, C-R8 left the runtime's broker client only a folder-v2 run's description, and legacy
-- sweep D2 (20260930331000) and D5 (20260930334000) dropped the other readers of the snapshot and substrate version
-- shapes.
-- 1. The runner broker's describe hands every job to the folder describe (P23), as F1d (20260930247000) did for
--    completion. The folder describe refuses a job whose company has no folder-v2 Company File.
-- 2. Dropped: the snapshot-v1 describe it fell back to, the workspace ensure and list, the snapshot commit and list,
--    the snapshot and substrate version shapes, and a profile's Company File output limit, whose other caller (the
--    runner broker's Company File object check) D5 dropped. Nothing outside the set calls them, and no trigger or
--    policy names them.
-- Kept for step G, with the tables they guard: the workspace and path workspace triggers. The member snapshot reads
-- wait for the client and gateway (G3, C5); step E takes the snapshot read and closure proofs.
set local lock_timeout = '3s';

-- 1. The runner broker's describe. ------------------------------------------------------------------------------------

create or replace function public.qorpera_runner_broker_describe(p_runner_id uuid, p_session_token_sha256 text,
	p_job_id uuid, p_lease_token_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930410000 (legacy sweep D8): folder-v2 only, so the folder core describes every job.
	return public.qorpera_folder_runner_broker_describe(p_runner_id, p_session_token_sha256, p_job_id,
		p_lease_token_sha256);
end
$function$;

-- 2. The snapshot-v1 describe, workspaces and snapshots. --------------------------------------------------------------

drop function public.qorpera_runner_broker_describe_before_path_runtime(uuid,text,uuid,text);
drop function public.qorpera_ensure_company_workspace(uuid,uuid,text,uuid);
drop function public.qorpera_list_company_workspaces(uuid);
drop function public.qorpera_commit_company_snapshot(uuid,uuid,uuid,text,integer,integer,integer,bigint);
drop function public.qorpera_list_company_snapshots(uuid,integer);
drop function public.qorpera_company_snapshot_json(public.qorpera_company_snapshots);
drop function public.qorpera_company_substrate_version_json(public.qorpera_company_substrate_versions);
drop function public.qorpera_profile_company_output_limit(uuid);

-- Nothing that runs may still name the lane.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_runner_broker_describe_before_path_runtime\M'
				|| '|qorpera_(ensure|list)_company_workspaces?\M|qorpera_(commit|list)_company_snapshots?\M'
				|| '|qorpera_company_(snapshot|substrate_version)_json\M|qorpera_profile_company_output_limit\M')
	loop
		raise exception 'Function % still names the company workspace lane', v_name;
	end loop;
end $$;
