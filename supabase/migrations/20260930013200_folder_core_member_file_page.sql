-- Company folder core, C4 slice P33: the web file page on folder-v2 (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §4). Built by the Interfaces session.
--
-- * qorpera_member_company_file_mode answers mode 'folder' for a folder-v2 company. It answered 'legacy' (its path
--   gateway version is null), so a client could not tell a folder-v2 company from a whole-tree one. The web opens its
--   read-only folder page on 'folder' (the member functions of 20260930013000); 'governed' and 'legacy' are unchanged.
-- * qorpera_member_folder_history bounds its per-change-set query by its cap (`limit v_cap + 1`, #740's review):
--   the same answer, without relying on the cursor's plan to stop early.
--
-- Inert for today's companies: only an operator can create a folder-v2 company until the reset (C5).

create function pg_temp.folder_member_file_page_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

select pg_temp.folder_member_file_page_patch('public.qorpera_member_company_file_mode(uuid)',
	$old$'mode',case when v_file.path_gateway_version = 1 then 'governed' else 'legacy' end);$old$,
	$new$-- C4 P33 (20260930013200): a folder-v2 company is read through the folder core's member functions.
		'mode',case when v_file.core = 'folder-v2' then 'folder'
			when v_file.path_gateway_version = 1 then 'governed' else 'legacy' end);$new$);

select pg_temp.folder_member_file_page_patch('public.qorpera_member_folder_history(uuid,bigint,integer)',
	$old$			order by version.unit_no, version.version
		loop$old$,
	$new$			order by version.unit_no, version.version
			-- C4 P33 (20260930013200): at most the cap and the row that shows it was reached.
			limit v_cap + 1
		loop$new$);
