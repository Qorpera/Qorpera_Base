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
