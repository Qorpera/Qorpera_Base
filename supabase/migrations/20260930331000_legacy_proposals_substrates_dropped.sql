-- 20260930331000: the legacy sweep, step D2 (the whole-tree lane, its proposals and the substrate versions). The
-- snapshot-v1 lane a member used to publish or propose a whole Company File tree goes (folder-v2 only, the founder's
-- decision of 3 October): the revision prepare and publish, the proposal prepare, submit, rebase, accept, reject,
-- reads, comments and review retry, and the substrate version capture and reads. HP-B and HP-C1 moved their callers off
-- them and S2 removed their activation guards (all ride v178). A folder-v2 company proposes through C2's path
-- proposals (P40), which keep qorpera_company_proposal_audience_allowed.
-- 1. Dropped: the seventeen functions. Nothing outside the set calls them, and no trigger or policy names them.
-- 2. The comments table goes, which must be empty: only the dropped append and list read or wrote it. A review
--    assignment's comment_id stays as a plain column (its foreign key goes) until step G drops the proposal tables.
-- Kept for step G, with the tables they write: the proposal and review triggers (the submission record, the review
-- seed and the proposal wake status), qorpera_company_substrate_version_json (the runner broker's describe reads it),
-- qorpera_ensure_current_company_substrate and the substrate GC guard.
set local lock_timeout = '3s';

-- 1. The whole-tree lane and its proposals, then the substrate versions. ------------------------------------------

drop function public.qorpera_prepare_company_file_revision(uuid,uuid,uuid,text,integer,integer,integer,bigint);
drop function public.qorpera_publish_company_file_revision(uuid,uuid,uuid);
drop function public.qorpera_prepare_company_file_proposal(uuid,uuid,uuid,text,integer,integer,integer,bigint);
drop function public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[]);
drop function public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid);
drop function public.qorpera_accept_company_proposal(uuid,uuid);
drop function public.qorpera_reject_company_proposal(uuid,uuid);
drop function public.qorpera_get_company_proposal(uuid);
drop function public.qorpera_list_company_proposals(uuid,text,timestamp with time zone,uuid,integer);
drop function public.qorpera_append_company_proposal_comment(uuid,uuid,text);
drop function public.qorpera_list_company_proposal_comments(uuid,timestamp with time zone,uuid,integer);
drop function public.qorpera_retry_company_proposal_review(uuid);
drop function public.qorpera_company_proposal_json(public.qorpera_company_proposals);

drop function public.qorpera_capture_company_substrate_version(uuid,uuid,integer);
drop function public.qorpera_capture_company_substrate_version_v2(uuid,uuid,integer,uuid);
drop function public.qorpera_get_company_substrate_version(uuid);
drop function public.qorpera_list_company_substrate_operations(uuid,bigint,integer);

-- 2. Last, because dropping the table locks the tables its foreign keys name (the proposals and auth.users) until the
-- migration commits. It goes only while empty; the lock keeps a comment from arriving between the check and the drop,
-- and the review assignments are locked first, as their foreign key is dropped before the table. All in one statement,
-- as 20260930330000 does: a bare LOCK TABLE fails where each statement commits.
do $$
declare v_constraint name;
begin
	lock table public.qorpera_company_proposal_review_assignments, public.qorpera_company_proposal_comments
		in access exclusive mode;
	if exists (select 1 from public.qorpera_company_proposal_comments) then
		raise exception 'Legacy sweep D2 drops the proposal comments only while there are none' using errcode = '55000'; end if;
	select constraint_row.conname into strict v_constraint from pg_constraint constraint_row
		where constraint_row.conrelid = 'public.qorpera_company_proposal_review_assignments'::regclass
			and constraint_row.confrelid = 'public.qorpera_company_proposal_comments'::regclass
			and constraint_row.contype = 'f';
	execute format('alter table public.qorpera_company_proposal_review_assignments drop constraint %I', v_constraint);
	drop table public.qorpera_company_proposal_comments;
end $$;

-- Nothing that runs may still name the lane.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_(accept|get|rebase|reject|submit)_company_proposal\M'
				|| '|qorpera_list_company_proposal(s|_comments)\M|qorpera_append_company_proposal_comment\M'
				|| '|qorpera_company_proposal_json\M|qorpera_retry_company_proposal_review\M'
				|| '|qorpera_prepare_company_file_(revision|proposal)\M|qorpera_publish_company_file_revision\M'
				|| '|qorpera_capture_company_substrate_version(_v2)?\M|qorpera_get_company_substrate_version\M'
				|| '|qorpera_list_company_substrate_operations\M|qorpera_company_proposal_comments\M')
	loop
		raise exception 'Function % still names the old whole-tree lane', v_name;
	end loop;
end $$;
