-- 20260930446100: step 5b, part 1 of 4: names under code/ (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Code areas
-- and git"; RUNTIME-COMPANY-FOLDER.md §6 "Names").
-- 1. '.git' and 'repo.git' are refused at any depth outside code/<owner>/<name>/ and accepted inside it: a repository's
--    git directory is code/<owner>/<name>/repo.git, and its worktrees' '.git' files sit deeper. node_modules stays
--    allowed only under code/, as before.
-- 2. Under code/, a name may hold '%' and ':' and may be a device name (con, aux, ...), as git's own names may. NFC, the
--    other characters refused everywhere, the trailing dot or space and no case-only siblings (the entries' key) stay.
-- Both functions are replaced whole. Neither is ever narrowed, so rows saved under the old rules stay valid.

set local lock_timeout = '3s';

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
