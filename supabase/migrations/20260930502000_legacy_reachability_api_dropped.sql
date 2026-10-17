-- 20260930502000: the legacy sweep, step E2 (the member's reachability graph and restore proof functions, and the
-- Company File verifier's). Snapshot-v1 only (folder-v2 only, the founder's decision of 3 October): a member uploaded the
-- object graph under an artifact or a company snapshot, completed it and proved a restore, and the company-file-verifier
-- Edge Function read a snapshot with its graph and recorded the snapshot's closure. A folder-v2 company has neither:
-- 20260930041000 made graph completion refuse it, E1 (20260930400000) took the artifact registration, and a folder-v2
-- company never has a snapshot. HP-D took the runtime's callers and this change takes the Edge Function; nothing else
-- calls them, so they go whole.
-- Dropped: the member's graph begin, append, completion and read and the restore proof, with the graph and proof JSON
-- helpers; the snapshot read and the verifier's closure record; the old Company File graph promotion (no caller); and
-- the artifact JSON helper, whose last callers went with E1.
-- Kept: the graph, entry and proof tables with their triggers and owner guards, which the old path lane's publish
-- still writes; qorpera_object_graph_objects_available and qorpera_object_root_has_current_proof, which the old path
-- lane's gateway, the member snapshot readers and the runner's pre-start terminalization still use (later E slices);
-- and the snapshots.
set local lock_timeout = '3s';

-- The member's graph and restore proof functions.
drop function public.qorpera_begin_object_reachability_graph(text,uuid,uuid,text,integer,text,integer,bigint);
drop function public.qorpera_append_object_reachability_entries(uuid,jsonb);
drop function public.qorpera_complete_object_reachability_graph(uuid);
drop function public.qorpera_get_object_reachability_graph(uuid);
drop function public.qorpera_create_object_restore_proof(uuid,uuid,text,bigint);

-- The Company File verifier's snapshot read and closure record, and the graph promotion nothing calls.
drop function public.qorpera_get_company_snapshot(uuid);
drop function public.qorpera_verify_company_snapshot_closure(uuid,uuid,uuid,text,integer,bigint,text,bigint,text);
drop function public.qorpera_promote_company_file_graph_to_supabase(uuid,uuid);

-- Last, the JSON helpers the functions above (and E1's) returned their rows with.
drop function public.qorpera_object_reachability_graph_json(public.qorpera_object_reachability_graphs);
drop function public.qorpera_object_restore_proof_json(public.qorpera_object_restore_proofs);
drop function public.qorpera_artifact_json(public.qorpera_artifacts);

-- Nothing that runs may still name what went.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_(begin|complete|get)_object_reachability_graph\M'
				|| '|qorpera_append_object_reachability_entries\M|qorpera_create_object_restore_proof\M'
				|| '|qorpera_object_(reachability_graph|restore_proof)_json\M|qorpera_get_company_snapshot\M'
				|| '|qorpera_verify_company_snapshot_closure\M|qorpera_promote_company_file_graph_to_supabase\M'
				|| '|qorpera_artifact_json\M')
	loop
		raise exception 'Function % still names a function legacy sweep E2 dropped', v_name;
	end loop;
end $$;
