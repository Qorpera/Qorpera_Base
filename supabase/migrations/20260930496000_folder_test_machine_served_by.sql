-- The crashed service refusal for a test machine's view: F3 step 6, slice 6a, part 4
-- (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md, "The service that served a view" and rule 5 of "Reads"), on
-- 20260930446000 (step 5a, served_by).
-- qorpera_folder_view_renew treats a 'test_machine' view as it treats a coding or code host view:
-- 1. the renewal needs the folder service's id (p_service, 22023 without it);
-- 2. the first renewal sets served_by, and the same service renews;
-- 3. a renewal from another service while served_by is set closes the view as 'service_crashed': the old service may
--    have served reads it never released. The folder service drops the view; the executor, whose boundaries no longer
--    find it, restarts the machine (F3 6d-2b), and the next boot opens a new view. The read set keeps what was released.
-- qorpera_folder_service_stopped (a clean stop) already clears served_by on every view of the service, whatever its kind.
-- Exact-text patches: each fails unless renew has the text given exactly once. Body marker "20260930496000"; the
-- earlier markers (20260930104000, 20260930446000) stay.

set local lock_timeout = '3s';

do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure), '20260930496000') > 0
		then raise exception 'The test machine''s served_by (20260930496000) is already applied'; end if;
end $$;

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.folder_test_machine_served_by_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '% does not have the text this migration expects (% times): %', p_target, v_found,
				left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.folder_test_machine_served_by_patch('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', array[
	$old$	if v_view.kind in ('coding_session','code_host') and p_service is null then$old$,
	$new$	-- 20260930496000 (F3 6a-4): and a test machine's view, whose reads a crashed service may have left unreleased.
	if v_view.kind in ('coding_session','code_host','test_machine') and p_service is null then$new$,
	$old$	if v_view.kind in ('coding_session','code_host') and v_view.served_by <> p_service then$old$,
	$new$	if v_view.kind in ('coding_session','code_host','test_machine') and v_view.served_by <> p_service then$new$,
	$old$		served_by = case when v_view.kind in ('coding_session','code_host') then p_service end$old$,
	$new$		served_by = case when v_view.kind in ('coding_session','code_host','test_machine') then p_service end$new$]);
