-- 20260930414000: the legacy sweep, step D15 (the hosted primary's plain sessions, operation receipts and account
-- events). The snapshot-v1 hosted primary's session surface goes (folder-v2 only, the founder's decision of 3 October):
-- it created a plain shared session pinned to the company's head snapshot and the staff version, found one by its
-- client id, listed an environment's sessions in one page, appended an account event under a turn or wake claim, and
-- began, staged, completed and resolved an operation receipt of a claimed turn or wake. A folder-v2 conversation is a
-- room, which the folder core opens itself, and a folder-v2 run keeps its receipts as run operation receipts. HP-E2
-- removed cloud-client's plain sessions, receipts and account events, the last caller; D14 dropped the turn and wake
-- claims these receipts and account events were bound to.
-- 1. Dropped: the eleven, and the four profile-scope helpers only they called (three of the session creators, one of
-- the account event). None of them is a native host call, and no trigger, policy, constraint or default names them.
-- Kept: qorpera_list_shared_sessions_page, which the web calls; qorpera_close_shared_session, which also closes a
-- folder-v2 room's thread (C1c's lock order names it; test 657 C2); qorpera_resolve_run_operation_receipt, the folder
-- core's; the operation receipts and the session events (step G); and the other helpers the fifteen called, which
-- others call too.
set local lock_timeout = '3s';

-- 1. The plain sessions, receipts and account events. -----------------------------------------------------------------

drop function public.qorpera_create_shared_session_v4(uuid,uuid,text,text,uuid,jsonb,uuid,bigint);
drop function public.qorpera_create_shared_session_v3(uuid,uuid,text,text,uuid,jsonb);
drop function public.qorpera_create_shared_session_v3_profile_scope(uuid,uuid,text,text,uuid,jsonb);
drop function public.qorpera_create_shared_session_v2(uuid,uuid,text,text,uuid);
drop function public.qorpera_create_shared_session_v2_profile_scope(uuid,uuid,text,text,uuid);
drop function public.qorpera_create_shared_session(uuid,text,text,uuid);
drop function public.qorpera_create_shared_session_profile_scope(uuid,text,text,uuid);
drop function public.qorpera_get_shared_session_by_client(uuid,uuid);
drop function public.qorpera_list_shared_sessions(uuid);
drop function public.qorpera_append_account_event(uuid,uuid,text,jsonb,bigint,text,uuid,uuid);
drop function public.qorpera_append_account_event_profile_scope(uuid,uuid,text,jsonb,bigint,text,uuid,uuid);
drop function public.qorpera_begin_operation_receipt(text,uuid,uuid,uuid,text,text);
drop function public.qorpera_stage_operation_receipt_objects(uuid,uuid,uuid,jsonb);
drop function public.qorpera_complete_operation_receipt(uuid,uuid,uuid,jsonb);
drop function public.qorpera_resolve_operation_receipt(uuid,text,jsonb);

-- Nothing that runs may still name them.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_(create_shared_session(_v[234])?'
				'|create_shared_session(_v[23])?_profile_scope|get_shared_session_by_client|list_shared_sessions'
				'|append_account_event(_profile_scope)?|(begin|complete|resolve)_operation_receipt'
				'|stage_operation_receipt_objects)\M')
	loop
		raise exception 'Function % still names the hosted primary''s plain sessions, receipts or account events',
			v_name;
	end loop;
end $$;
