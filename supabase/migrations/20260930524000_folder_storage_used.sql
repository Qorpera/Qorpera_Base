-- 20260930524000: a folder-v2 company's Storage shows what the company stores (Jonas, 21 October 2026).
--
-- The web's storage meter reads storage_used_bytes from qorpera_get_company_file, that is from
-- qorpera_company_file_json, which answered qorpera_company_files.storage_used_bytes: a count only snapshot-v1 kept.
-- Folder-v2 never fills that column (20260928489220), so every company showed "0 B used" while its folder held its
-- files. For a folder-v2 company the answer now carries the count its folder quota keeps and enforces:
-- qorpera_folder_storage_usage.bytes (20260928279520 §5). Before that row exists (it is seeded at the company's first
-- object change after it became folder-v2) the answer is the sum of the company's object catalog, which is what the row
-- seeds itself from. The answer is never below 0, as its readers require (the web refuses a negative size). A company
-- that is not folder-v2 keeps the column's count. Every other part of the answer, who may read it, its grants and the
-- column itself are unchanged; so is every caller (qorpera_get_company_file and the profile answers that embed a
-- company file). An exact-text patch; the inserted text names this migration, for deploy guards. SQL test 972.

set local lock_timeout = '3s';

create function pg_temp.folder_storage_used_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930524000: % does not hold the text to patch exactly once', p_function;
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.folder_storage_used_replace('public.qorpera_company_file_json(public.qorpera_company_files)'::regprocedure,
	$old$		'storage_used_bytes', p_file.storage_used_bytes,$old$,
	$new$		-- 20260930524000: a folder-v2 company's stored bytes, as its folder quota counts them (never below 0).
		'storage_used_bytes', case when public.qorpera_company_is_folder_v2(p_file.profile_id) then greatest(coalesce(
			(select usage.bytes from public.qorpera_folder_storage_usage as usage where usage.profile_id = p_file.profile_id),
			(select coalesce(sum(object.bytes), 0) from public.qorpera_profile_objects as object
				where object.profile_id = p_file.profile_id)
		), 0) else p_file.storage_used_bytes end,$new$);
