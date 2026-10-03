-- Folder core slice P10 (the coordinator's C1–C5 audit, 2 October 2026; C5 early, RUNTIME-COMPANY-FOLDER-C1D.md §9.3
-- step 3): qorpera_verify_company_path_file, the version-1 proof of a staged file, refuses folder-v2 companies. A
-- folder-v2 company's files are proved on the byte path (open, confirm, seal: C1D §3), which also writes the chunk
-- index, so with this refusal the index is complete for every proof a folder-v2 company holds and no version-1 case is
-- left (C1D §9.3). No real route reached the function for folder-v2: only SQL test fixtures did, and F2's (#617) and
-- F1's (P09) now stage version 2.
--
-- The refusal comes first after the authority check, before the gc fence (the company row FOR UPDATE), so a refused
-- call takes no lock. It reads one row (qorpera_company_is_folder_v2) and raises 0A000 as the C1c-1 guards do for raw
-- object paths. Snapshot-v1 companies are unchanged. The body carries the marker 20260930001100 for release guards, and
-- the exact text 'folder-v2 refuses version 1', which the folder GC phase's switch (P11, 20260930009000) requires.

set local lock_timeout = '3s';

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_verify_company_path_file(uuid,text)'::regprocedure);
	c_anchor constant text := E'\t\traise exception ''Company File verifier authority is required'' using errcode = ''42501''; end if;\n';
	c_refusal constant text :=
		E'\t-- C5 early (folder core P10, 20260930001100): folder-v2 refuses version 1; a folder-v2 company proves its files\n'
		|| E'\t-- on the byte path only (the folder GC switch reads this text, 20260930009000).\n'
		|| E'\tif public.qorpera_company_is_folder_v2(p_profile_id) then\n'
		|| E'\t\traise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n';
begin
	if position('20260930001100' in v_definition) > 0 then raise exception 'P10 is already in the verifier'; end if;
	if (length(v_definition) - length(replace(v_definition, c_anchor, ''))) / length(c_anchor) <> 1 then
		raise exception 'P10 anchor not found once in the verifier'; end if;
	execute replace(v_definition, c_anchor, c_anchor || c_refusal);
end $$;
