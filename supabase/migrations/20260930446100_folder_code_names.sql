-- 20260930446100: step 5b, part 1 of 4: names under code/ (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Code areas
-- and git"; RUNTIME-COMPANY-FOLDER.md §6 "Names").
-- 1. '.git' and 'repo.git' are refused at any depth outside code/<owner>/<name>/ and accepted inside it: a repository's
--    git directory is code/<owner>/<name>/repo.git, and its worktrees' '.git' files sit deeper. node_modules stays
--    allowed only under code/, as before.
-- 2. Under code/, a name may hold '%' and ':' and may be a device name (con, aux, ...), as git's own names may. NFC, the
--    other characters refused everywhere, the trailing dot or space and no case-only siblings (the entries' key) stay.
-- 3. So a folder moved or copied out of code/ is refused ('reserved') when a name below it is one only code/ holds,
--    spelled as it would be stored: the unit is refused, not the change set (the entries' path check would abort it).
-- Both functions are replaced whole. Neither is ever narrowed, so rows saved under the old rules stay valid. The commit
-- (qorpera_folder_commit) is patched in place, and names this migration (20260930446100).

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.s5b_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5b anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. The reserved names. -----------------------------------------------------------------------------------------------

-- Adapter-only and system names never enter the folder. Dependency caches are allowed only under code/, and git's
-- directories ('.git', 'repo.git') only below code/<owner>/<name>/ (20260930446100).
create or replace function public.qorpera_folder_path_reserved(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select split_part(p_key, '/', 1) in ('.qorpera','trail','inbox','credentials','secrets')
		or (split_part(p_key, '/', 1) <> 'code'
			and exists (select 1 from unnest(string_to_array(p_key, '/')) as part where part = 'node_modules'))
		or exists (select 1 from unnest(string_to_array(p_key, '/')) with ordinality as p(part, n)
			where p.part in ('.git','repo.git') and (split_part(p_key, '/', 1) <> 'code' or p.n <= 3))
$$;

-- 2. Names under code/. ------------------------------------------------------------------------------------------------

-- A valid company path. Under code/ (by its key), '%', ':' and device names are allowed (20260930446100).
create or replace function public.qorpera_company_path_valid(p_path text, p_root boolean default false)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_candidate text; v_part text; v_code boolean;
begin
	if p_root and p_path = '' then return true; end if;
	if p_path is null or octet_length(p_path) not between 1 and 4096
		or p_path <> normalize(p_path, NFC) then return false; end if;
	v_code := split_part(public.qorpera_company_path_key(p_path), '/', 1) = 'code';
	foreach v_candidate in array array[p_path, public.qorpera_company_path_key(p_path)] loop
		if v_candidate ~ '[[:cntrl:]]' or strpos(v_candidate, chr(92)) > 0
			or (strpos(v_candidate, '%') > 0 and not v_code)
			or cardinality(string_to_array(v_candidate,'/')) <> cardinality(string_to_array(p_path,'/')) then return false; end if;
		foreach v_part in array string_to_array(v_candidate, '/') loop
			if v_part in ('', '.', '..') or v_part ~ '[. ]$'
				or (not v_code and (strpos(v_part, ':') > 0
					or v_part ~* '^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$'))
				then return false; end if;
		end loop;
	end loop;
	return true;
end
$$;

-- 3. A folder leaving code/. -------------------------------------------------------------------------------------------

select pg_temp.s5b_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$				where public.qorpera_folder_path_reserved(public.qorpera_folder_key(v_path || '/' || (c.value ->> 'path')))))) then
$old$,
	$new$				where public.qorpera_folder_path_reserved(public.qorpera_folder_key(v_path || '/' || (c.value ->> 'path')))))
			-- 20260930446100 (step 5b): a folder moved or copied out of code/ takes no name only code/ holds ('%', ':', a
			-- device name), each descendant spelled as it will be stored (qorpera_folder_apply_unit).
			or (v_op in ('move','copy') and v_row.kind = 'folder'
				and split_part(v_key, '/', 1) = 'code' and split_part(v_to_key, '/', 1) <> 'code'
				and exists (select 1 from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id and e.kind <> 'claim'
						and e.key_text like public.qorpera_folder_under(v_key)
						and not public.qorpera_company_path_valid(v_eff_to || substr(e.path, char_length(v_row.path) + 1))))) then
$new$]);
