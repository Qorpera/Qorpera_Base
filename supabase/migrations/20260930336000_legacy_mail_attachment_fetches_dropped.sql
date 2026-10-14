-- 20260930336000: the legacy sweep, step D7 (the received mail attachments' fetch lane). Legacy sweep D4
-- (20260930333000) dropped the save request, the only thing that recorded a fetch, so the lane behind it goes too
-- (folder-v2 only, the founder's decision of 3 October): the mail-attachments Edge Function, its minute's pg_cron job,
-- the worker's claim, completion and failure, and the fetch table.
-- 1. The minute's job goes where it exists. The deploy notes scheduled it by hand (RUNTIME-EVENT-INTAKE.md, "Deploy
--    (M2c-1)"); a database without pg_cron, or whose job another role scheduled, is left as it is.
-- 2. Dropped: the claim, completion and failure. Only the Edge Function called them, and no trigger or policy names
--    them.
-- 3. The fetch table goes, which must be empty: nothing reads it but the dropped functions (no GC root, view or foreign
--    key names it). The chunks a stored fetch named stay as the company's objects.
-- Sent attachments (send_mail, mail-outbox) are unchanged.
set local lock_timeout = '3s';

-- 1. The minute's job. ------------------------------------------------------------------------------------------------

do $$
begin
	if to_regclass('cron.job') is not null then
		perform cron.unschedule(job.jobid) from cron.job as job where job.jobname = 'qorpera-mail-attachments';
	end if;
end $$;

-- 2. The worker's claim, completion and failure. ----------------------------------------------------------------------

drop function public.qorpera_claim_mail_attachment_fetches(integer,uuid);
drop function public.qorpera_complete_mail_attachment_fetch(uuid,uuid,text,bigint,jsonb);
drop function public.qorpera_fail_mail_attachment_fetch(uuid,uuid,text,boolean);

-- 3. Last, because dropping the table locks the tables its foreign keys name (the deliveries, profiles and
-- environments) until the migration commits. All in one statement, as 20260930330000 does: a bare LOCK TABLE fails
-- where each statement commits.
do $$
begin
	lock table public.qorpera_mail_attachment_fetches in access exclusive mode;
	if exists (select 1 from public.qorpera_mail_attachment_fetches) then
		raise exception 'Legacy sweep D7 drops the mail attachment fetches only while there are none'
			using errcode = '55000'; end if;
	drop table public.qorpera_mail_attachment_fetches;
end $$;

-- Nothing that runs may still name the lane.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_(claim_mail_attachment_fetches|(complete|fail)_mail_attachment_fetch'
				'|mail_attachment_fetches)\M')
	loop
		raise exception 'Function % still names the mail attachment fetch lane', v_name;
	end loop;
end $$;
