-- 20260930333000: the legacy sweep, step D4 (saving a received mail attachment). The save request goes (folder-v2
-- only, the founder's decision of 3 October). It served snapshot-v1 companies only: a folder-v2 company was refused
-- (0A000, until its folder adds mail attachments as a GC root). C-P4 removed the runtime's save_attachment tool, and S2
-- stopped the activation template naming the request; both ride v178.
-- 1. The native host's call list loses the request, so the dispatch refuses it by name.
-- 2. Dropped: the request and the two functions only it called, its immediate call to the fetch worker and its receipt.
-- Nothing outside the set calls them, and no trigger or policy names them.
-- Kept: the fetch table and the worker's claim, completion and failure, which the mail-attachments Edge Function calls
-- (each minute through pg_cron, which posts to the function itself). Nothing records a fetch any more; the lane stores
-- into the company's objects and goes with them in step E. Sent attachments (send_mail) are unchanged.
set local lock_timeout = '3s';

-- 1. The call list. --------------------------------------------------------------------------------------------

delete from public.qorpera_native_host_calls where name = 'qorpera_native_mail_attachment';

-- 2. The request, its immediate call and its receipt. ----------------------------------------------------------

drop function public.qorpera_native_mail_attachment(jsonb,jsonb);
drop function public.qorpera_mail_attachments_kick();
drop function public.qorpera_mail_attachment_receipt(uuid,public.qorpera_mail_attachment_fetches);

-- Nothing that runs may still name them.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ 'qorpera_(native_mail_attachment|mail_attachments_kick|mail_attachment_receipt)\M'
	loop
		raise exception 'Function % still names the mail attachment save', v_name;
	end loop;
end $$;
