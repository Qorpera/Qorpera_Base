-- Folder core slice P01 (the coordinator's C1–C5 audit, 2 October 2026; F3's proposal P1): a company being deleted
-- serves its folder to no one. qorpera_folder_read_actor sent members and the platform back before any stop check, so
-- read, list, the feed, agent todos and routine reads kept answering them while the company was being deleted; runs and
-- views already stop there (qorpera_company_execution_paused counts deletions, 20260928279470), and the download check
-- refuses everyone (20260928279520). Now members and the platform stop too, with 55000 'Company is being deleted', as
-- the upload actor says it. Runs and views keep their 'Company execution is paused' (the runtime reads that text).
--
-- One line set before the early returns: a plain read of the company's deletion row, no lock (the read path takes
-- none, test 632). Folder-v2 only in effect: every caller is a folder-v2 function. The body carries the marker
-- 20260930001000 for release guards.
--
-- Also (found by #714's review, decided by F3 on 3 October 2026): qorpera_folder_view_renew closed a view that no
-- longer matched its anchor under the FOR NO KEY UPDATE it renews with, which never waits for a commit's KEY SHARE on
-- the view. C1B §4 says closing takes the view FOR UPDATE and waits out the view's commit in flight, so that once a
-- view is closed nothing more lands through it; C1B is right, and the renewal now takes the view FOR UPDATE before it
-- closes it. A renewal that renews still takes only FOR NO KEY UPDATE. Upgrading the lock it holds cannot deadlock: no
-- other transaction holds FOR NO KEY UPDATE on the row beside it, and the commits it waits for take nothing it holds.
-- Folder-v2 only and inert. The body carries the same marker.

set local lock_timeout = '3s';

create function pg_temp.p01_insert_before(p_target regprocedure, p_anchor text, p_statement text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930001000' in v_definition) > 0 then raise exception 'P01 is already in %', p_target; end if;
	if (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor) <> 1 then
		raise exception 'P01 anchor not found once in %', p_target; end if;
	execute replace(v_definition, p_anchor, p_statement || p_anchor);
end $$;

select pg_temp.p01_insert_before('public.qorpera_folder_read_actor(uuid,jsonb)',
	$anchor$	if p_actor ->> 'kind' = 'platform' and p_actor - array['kind'] = '{}'::jsonb then return null; end if;
$anchor$,
	$statement$	-- A company being deleted serves its folder to no one (F3 P1, 20260930001000): members and the platform stop
	-- here; runs and views stop at the stop check below, which counts deletions.
	if p_actor ->> 'kind' in ('platform', 'member') and exists (select 1 from public.qorpera_company_files f
		join public.qorpera_company_deletions d on d.profile_id = f.profile_id where f.environment_id = p_environment_id) then
		raise exception 'Company is being deleted' using errcode = '55000'; end if;
$statement$);

select pg_temp.p01_insert_before('public.qorpera_folder_view_renew(uuid,text,timestamp with time zone)',
	$anchor$		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(),
			close_reason = case when v_view.lease_until <= clock_timestamp() then 'expired' else 'ended' end
$anchor$,
	$statement$		-- Closing waits out the view's commit in flight (C1B §4, 20260930001000): renewal alone never waits.
		perform 1 from public.qorpera_folder_views where id = v_view.id for update;
$statement$);
