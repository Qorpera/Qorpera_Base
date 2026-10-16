-- 20260930335000: the legacy sweep, step D6 (the kernel-row writers). The agents' old todo, worker, routine and sidebar
-- writers go (folder-v2 only, the founder's decision of 3 October). C-P2 and C-P3 left the runtime's tools saving only
-- through the folder writers, and S2 stopped the activation template naming them. They served snapshot-v1 only: the
-- routine pair and the publication confirmation refuse a folder-v2 company by name, the others at the old path's actor
-- check (qorpera_company_path_actor).
-- 1. The native host's call list loses the seven requests, so the dispatch refuses them by name.
-- 2. Dropped: the seven requests, and the eight functions only they called (the todo and worker pages and listings, the
-- worker's dispatch payload, the sidebar's agent view and section lookup, and the path's live hash).
-- Nothing outside the set calls them, and no trigger or policy names them. Two kept bodies name a writer in a comment
-- (qorpera_company_state_worker_rules and qorpera_set_chatgpt_plan_work_while_away), so the last check looks for calls.
-- Kept: the todo, worker, routine and sidebar tables, which the company state index fills from the folder's files.
set local lock_timeout = '3s';

-- 1. The call list. ---------------------------------------------------------------------------------------------------

delete from public.qorpera_native_host_calls where name = 'qorpera_manage_agent_todo';
delete from public.qorpera_native_host_calls where name = 'qorpera_confirm_agent_todo_publication';
delete from public.qorpera_native_host_calls where name = 'qorpera_manage_agent_worker';
delete from public.qorpera_native_host_calls where name = 'qorpera_report_worker_result';
delete from public.qorpera_native_host_calls where name = 'qorpera_manage_agent_routine';
delete from public.qorpera_native_host_calls where name = 'qorpera_decide_agent_routine';
delete from public.qorpera_native_host_calls where name = 'qorpera_manage_agent_sidebar';

-- 2. The requests and the functions only they called. -----------------------------------------------------------------

drop function public.qorpera_manage_agent_todo(jsonb,jsonb);
drop function public.qorpera_confirm_agent_todo_publication(jsonb,jsonb);
drop function public.qorpera_agent_todo_page(public.qorpera_execution_runs,jsonb);
drop function public.qorpera_agent_todo_listing(public.qorpera_runtime_agent_todos,boolean);
drop function public.qorpera_manage_agent_worker(jsonb,jsonb);
drop function public.qorpera_report_worker_result(jsonb,jsonb);
drop function public.qorpera_agent_worker_page(public.qorpera_execution_runs,jsonb);
drop function public.qorpera_agent_worker_listing(public.qorpera_runtime_workers,text,boolean);
drop function public.qorpera_worker_dispatch_payload(public.qorpera_runtime_workers,public.qorpera_runtime_agent_todos);
drop function public.qorpera_manage_agent_routine(jsonb,jsonb);
drop function public.qorpera_decide_agent_routine(jsonb,jsonb);
drop function public.qorpera_manage_agent_sidebar(jsonb,jsonb);
drop function public.qorpera_sidebar_agent_view(uuid);
drop function public.qorpera_sidebar_section_ref(uuid,text);
drop function public.qorpera_company_path_live_sha256(uuid,text);

-- Nothing that runs may still call them. Every body runs with an empty search path, so a call names the schema.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('public\.qorpera_(manage_agent_(todo|worker|routine|sidebar)|report_worker_result'
				'|confirm_agent_todo_publication|decide_agent_routine|agent_(todo|worker)_(page|listing)'
				'|company_path_live_sha256|sidebar_(agent_view|section_ref)|worker_dispatch_payload)\(')
	loop
		raise exception 'Function % still calls a kernel-row writer', v_name;
	end loop;
end $$;
