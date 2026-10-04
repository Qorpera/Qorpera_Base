-- Company folder core: artifacts refuse folder-v2 companies (from P13's activation checks, #779; inventory
-- 4 October 2026). A row in qorpera_artifacts, an artifact index entry, a retention hold or a completed reachability
-- graph fires a trigger that takes the gc fence: the company row FOR UPDATE, which no folder-v2 path may take
-- (core §3 step 3). A folder-v2 company keeps its bytes in its folder (C1D §9.3), and no product feature registers an
-- artifact for one, but two paths could reach the insert:
-- * qorpera_register_artifact_v2, which any member may call with a hash from the company's catalog;
-- * the runner broker's artifact lane (authorize and confirm an output object, register the artifact), with a leased
--   folder-v2 job's tokens; folder-v2 runs never publish outputs, and their completion refuses artifacts.
-- Each now refuses a folder-v2 company with 0A000 as its first statement, before any read under lock, so a refused call
-- takes no lock. So do qorpera_register_artifact (members may not execute it; the rest are refused by its own checks)
-- and the member functions that would take the fence over an artifact (index, hold, graph completion, GC plan cancel).
-- The test is the company's, as the fence is: an environment, job, artifact, graph or plan names its company by a plain
-- read. The worker's GC functions only meet
-- artifacts, so they need nothing. Office capture, export and import already refuse folder-v2 (20260928279470,
-- 20260928259430). Snapshot-v1 companies are unchanged. Every patched body carries the marker 20260930041000.

set local lock_timeout = '3s';

-- Inserts one statement at the start of a PL/pgSQL body, after its first line that is only "begin": before any lock the
-- function takes. The function must be PL/pgSQL, and the statement must not be there yet.
create function pg_temp.artifacts_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'Artifacts guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'Artifacts guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'Artifacts guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;

do $$
declare
	c_refuse constant text := 'then raise exception ''Artifacts do not serve folder-v2 companies'' using errcode = ''0A000''; end if; -- 20260930041000';
	v_function regprocedure;
begin
	-- A member's registration names the environment, and through it the company.
	perform pg_temp.artifacts_guard('public.qorpera_register_artifact(uuid,uuid,uuid,text,text,text,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2((select e.profile_id from public.qorpera_company_environments e where e.id = p_environment_id)) '
		|| c_refuse);
	perform pg_temp.artifacts_guard('public.qorpera_register_artifact_v2(uuid,uuid,uuid,text,text,text,text,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2((select e.profile_id from public.qorpera_company_environments e where e.id = p_environment_id)) '
		|| c_refuse);
	-- The runner broker's artifact lane names the job.
	perform pg_temp.artifacts_guard('public.qorpera_runner_broker_authorize_output_object(uuid,text,uuid,text,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2((select j.profile_id from public.qorpera_runner_jobs j where j.id = p_job_id)) '
		|| c_refuse);
	perform pg_temp.artifacts_guard('public.qorpera_runner_broker_confirm_output_object(uuid,text,uuid,text,text)',
		'if public.qorpera_company_is_folder_v2((select j.profile_id from public.qorpera_runner_jobs j where j.id = p_job_id)) '
		|| c_refuse);
	perform pg_temp.artifacts_guard('public.qorpera_runner_broker_register_artifact(uuid,text,uuid,text,uuid,text,text,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2((select j.profile_id from public.qorpera_runner_jobs j where j.id = p_job_id)) '
		|| c_refuse);
	-- The member functions that take the fence over an artifact, by the company of what they name (a plain read). An id
	-- that names nothing reads null, which is no folder-v2 company: the function refuses it as before.
	perform pg_temp.artifacts_guard('public.qorpera_create_artifact_index(uuid,uuid,uuid[])',
		'if public.qorpera_company_is_folder_v2((select e.profile_id from public.qorpera_company_environments e where e.id = p_environment_id)) '
		|| c_refuse);
	perform pg_temp.artifacts_guard('public.qorpera_create_artifact_retention_hold(uuid,uuid,text,timestamp with time zone)',
		'if public.qorpera_company_is_folder_v2((select a.profile_id from public.qorpera_artifacts a where a.id = p_artifact_id)) '
		|| c_refuse);
	perform pg_temp.artifacts_guard('public.qorpera_complete_object_reachability_graph(uuid)',
		'if public.qorpera_company_is_folder_v2((select g.profile_id from public.qorpera_object_reachability_graphs g where g.id = p_graph_id)) '
		|| c_refuse);
	perform pg_temp.artifacts_guard('public.qorpera_cancel_artifact_gc_plan(uuid)',
		'if public.qorpera_company_is_folder_v2((select p.profile_id from public.qorpera_artifact_gc_plans p where p.id = p_plan_id)) '
		|| c_refuse);

	-- The deploy guard: every patched body carries the marker.
	foreach v_function in array array['public.qorpera_register_artifact(uuid,uuid,uuid,text,text,text,text,bigint,text)',
		'public.qorpera_register_artifact_v2(uuid,uuid,uuid,text,text,text,text,text,bigint,text)',
		'public.qorpera_runner_broker_authorize_output_object(uuid,text,uuid,text,text,bigint,text)',
		'public.qorpera_runner_broker_confirm_output_object(uuid,text,uuid,text,text)',
		'public.qorpera_runner_broker_register_artifact(uuid,text,uuid,text,uuid,text,text,text,bigint,text)',
		'public.qorpera_create_artifact_index(uuid,uuid,uuid[])',
		'public.qorpera_create_artifact_retention_hold(uuid,uuid,text,timestamp with time zone)',
		'public.qorpera_complete_object_reachability_graph(uuid)',
		'public.qorpera_cancel_artifact_gc_plan(uuid)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930041000') = 0 then
			raise exception 'The artifacts refusal did not reach %', v_function; end if;
	end loop;
end $$;
