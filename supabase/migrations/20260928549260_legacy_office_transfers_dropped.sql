-- 20260930332000: the legacy sweep, step D3 (the office's file transfers). The office's import of a snapshot-v1
-- artifact or Company File path and its export of a file to one go (folder-v2 only, the founder's decision of 3
-- October). Nothing ever wired them: no office image gave its guest the file imports or exports, so each transfer
-- answered as unavailable and never called them. C-F1 removed the runtime's transfer classes, and the runtime refuses a
-- computer transfer at its authorize (both ride v178). The old office image still names the import and the export in its
-- closed list of calls, which only allows them; it never calls them.
-- 1. Dropped: the three functions. Nothing outside the set calls them, and no trigger or policy names them.
-- 2. The import table goes, which must be empty: only the dropped import read or wrote it.
-- Kept: qorpera_native_office_import_source and qorpera_native_office_company_file_source (the office operation calls
-- them); the export table and qorpera_runtime_office_file_export_json (the member file exports and the shared file
-- export source read them, step E); the company file import table, its immutability trigger and
-- qorpera_office_company_file_closure (the object graph owner check calls it, with the reachability family).
set local lock_timeout = '3s';

-- 1. The import, its Company File confirmation and the export. ---------------------------------------------------

drop function public.qorpera_native_office_file_import(jsonb,jsonb,jsonb,text,uuid,text,text);
drop function public.qorpera_confirm_office_company_file_import(jsonb,jsonb,jsonb,text,uuid,jsonb);
drop function public.qorpera_native_office_file_export(jsonb,jsonb,jsonb,text,uuid,text,jsonb,text);

-- 2. Last, because dropping the table locks the tables its foreign keys name (the office resources and the artifacts)
-- until the migration commits. It goes only while empty; the lock keeps an import from arriving between the check and
-- the drop. All in one statement, as 20260930330000 does: a bare LOCK TABLE fails where each statement commits.
do $$
begin
	lock table public.qorpera_runtime_office_file_imports in access exclusive mode;
	if exists (select 1 from public.qorpera_runtime_office_file_imports) then
		raise exception 'Legacy sweep D3 drops the office file imports only while there are none' using errcode = '55000'; end if;
	drop table public.qorpera_runtime_office_file_imports;
end $$;

-- Nothing that runs may still name the transfers.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_native_office_file_(import|export)\M|qorpera_confirm_office_company_file_import\M'
				|| '|qorpera_runtime_office_file_imports\M')
	loop
		raise exception 'Function % still names the office''s old file transfers', v_name;
	end loop;
end $$;
