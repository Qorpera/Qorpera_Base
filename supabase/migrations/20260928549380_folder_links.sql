-- Links in the company folder, LK1 (deploy/first-node/RUNTIME-FOLDER-LINKS.md; contract amendment of 14 October 2026,
-- items 4 to 6): the SQL core.
--
-- 1. A link is an entry of kind 'symlink' holding its target, 1 to 4,095 bytes of text kept exactly and never resolved.
--    Its path versions hold the target too (a delete's does not), and so does a conflict copy of kind 'symlink'.
-- 2. The unit {op:"symlink", path, target, expectedVersion?}: without a version it lands only on a free path (else
--    exists); with one it replaces the file or link at that version (else version_changed). Its path version is a
--    'write' of kind 'symlink'. A write with a link's version makes it a file again. A new folder may hold links
--    ({path, kind:"symlink", target}); move, copy and delete carry them. Its authority is write on its path; its review
--    class is plain. A target of the wrong length is invalid; one that is not a string is a malformed request.
-- 3. A link stands only where a link may (qorpera_folder_link_problems): never on a structured file's path, on a folder
--    the company keeps or names, or in a summary tree, nor anywhere under interfaces/ and tables/; a move or copy
--    carries none there. Nothing below a link exists: its path is no folder.
-- 4. A link's conflict is kept on the run's receipt as a file's is: a conflict copy of kind 'symlink' with its target,
--    also for each link of a conflicting new folder (qorpera_folder_conflict_copies_of lists both). Erasure removes it.
-- 5. read, list, feed and a member's path history show a link's target, and an agent's listed proposal names each item
--    of a new folder by its kind, a link with its target.
-- A hard link needs nothing new: it is a write of another path's file reference, stored once.
-- Every new or patched body carries the marker 20260930380000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if exists (select 1 from pg_attribute where attrelid = 'public.qorpera_folder_entries'::regclass and attname = 'target'
		and not attisdropped) then
		raise exception 'LK1 (20260930380000) is already applied'; end if;
end $$;

-- 1. The kind and its target -----------------------------------------------------------------------------------------

alter table public.qorpera_folder_entries add column target text,
	drop constraint qorpera_folder_entries_kind_check,
	add constraint qorpera_folder_entries_kind_check check (kind in ('file','folder','claim','symlink')),
	add constraint qorpera_folder_entries_target_check check ((kind = 'symlink') = (target is not null)),
	add constraint qorpera_folder_entries_target_octets_check check (target is null or octet_length(target) between 1 and 4095);

-- A link's versions hold its target, as a file's hold its bytes: its write, a move's two sides and a copy's arrival.
alter table public.qorpera_folder_path_versions add column target text,
	drop constraint qorpera_folder_path_versions_kind_check,
	add constraint qorpera_folder_path_versions_kind_check check (kind in ('file','folder','symlink')),
	add constraint qorpera_folder_path_versions_target_check check ((target is not null) = (kind = 'symlink' and op <> 'delete')),
	add constraint qorpera_folder_path_versions_target_octets_check check (target is null or octet_length(target) between 1 and 4095);

-- A conflict copy is a file's (its bytes) or a link's (its target).
alter table public.qorpera_folder_conflict_copies add column kind text not null default 'file', add column target text,
	alter column manifest_sha256 drop not null, alter column file_sha256 drop not null, alter column bytes drop not null,
	alter column media_type drop not null, alter column executable drop not null,
	add constraint qorpera_folder_conflict_copies_kind_check check (
		(kind = 'file' and manifest_sha256 is not null and file_sha256 is not null and bytes is not null
			and media_type is not null and executable is not null and target is null)
		or (kind = 'symlink' and manifest_sha256 is null and file_sha256 is null and bytes is null and media_type is null
			and executable is null and target is not null and octet_length(target) between 1 and 4095));

-- 2. Where a link may stand ------------------------------------------------------------------------------------------

-- Not on a structured file's path, a folder the company keeps or names, or in a summary tree. interfaces/ and tables/
-- refuse every link themselves (qorpera_company_state_interface_paths), as human-tasks/ refuses one directly under it.
create function public.qorpera_folder_link_problems(p_key text)
returns jsonb language sql immutable set search_path = '' as $$
	-- 20260930380000 (LK1)
	select case when v.what is null then '[]'::jsonb else jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
		format('%s is %s; a link cannot stand there', left(p_key, 100), v.what))) end
	from (select case
		when public.qorpera_memory_tree_root_key(p_key) is not null then 'in a summary tree'
		when public.qorpera_structured_path_kind(p_key) is not null then 'the path of a structured file'
		when public.qorpera_company_state_seeded(p_key) then 'a folder the company keeps'
		when x.n is not null then coalesce(substr(x.n[cardinality(x.n)], strpos(x.n[cardinality(x.n)], ':') + 1),
			'a folder the company keeps')
	end as what from (select public.qorpera_structured_folder_names(p_key) as n) x) v
$$;
revoke all on function public.qorpera_folder_link_problems(text) from public, anon, authenticated, service_role;

-- 3. The patches -----------------------------------------------------------------------------------------------------

create function pg_temp.lk1_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'LK1 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- Apply: a file's row clears its target; a write replaces a file or a link; the symlink unit; a new folder's links; a
-- move or copy carries each link's target.
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$executable = excluded.executable, updated_at = clock_timestamp()$old$,
	$new$executable = excluded.executable, target = excluded.target, updated_at = clock_timestamp()$new$,
	3);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$v_prior := case when v_row.kind = 'file' then v_row.version end;$old$,
	$new$v_prior := case when v_row.kind in ('file','symlink') then v_row.version end;$new$);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$		where e.kind = 'claim' or (e.kind = 'file' and e.version = v_prior);$old$,
	$new$		where e.kind = 'claim' or (e.kind in ('file','symlink') and e.version = v_prior);$new$);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$	elsif p_op in ('mkdir','new_folder') then
$old$,
	$new$	elsif p_op = 'symlink' then
		-- 20260930380000 (LK1): a link lands as a write does, on its claim or on the file or link it replaces, holding its
		-- target and no file.
		v_prior := case when v_row.kind in ('file','symlink') then v_row.version end;
		insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
			commit_id, unit_no, target)
		values (v_version, p_environment_id, p_path, extensions.digest(v_key, 'sha256'), v_prior, 'write', 'symlink',
			p_commit_id, p_unit_no, p_unit ->> 'target');
		insert into public.qorpera_folder_entries as e(environment_id, path, kind, version, commit_id, target)
		values (p_environment_id, p_path, 'symlink', v_version, p_commit_id, p_unit ->> 'target')
		on conflict (environment_id, key_sha256) do update set path = excluded.path, kind = excluded.kind,
			version = excluded.version, commit_id = excluded.commit_id, manifest_sha256 = null, file_sha256 = null, bytes = null,
			media_type = null, executable = null, target = excluded.target, updated_at = clock_timestamp()
		where e.kind = 'claim' or (e.kind in ('file','symlink') and e.version = v_prior);
		get diagnostics v_placed = row_count;

	elsif p_op in ('mkdir','new_folder') then
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$				select s.ord, s.path, s.kind, s.file, extensions.gen_random_uuid() as version
$old$,
	$new$				select s.ord, s.path, s.kind, s.file, extensions.gen_random_uuid() as version,
					-- 20260930380000 (LK1): a link's target.
					case when s.kind = 'symlink' then p_unit -> 'contents' -> (s.ord::integer - 1) ->> 'target' end as target
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$case when c.kind = 'file' then 'write' else 'mkdir' end, c.kind, p_commit_id$old$,
	$new$case when c.kind in ('file','symlink') then 'write' else 'mkdir' end, c.kind, p_commit_id$new$);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$media_type, executable)
				select $old$,
	$new$media_type, executable, target)
				select $new$,
	2);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$(c.file ->> 'executable')::boolean
				from c
$old$,
	$new$(c.file ->> 'executable')::boolean, c.target
				from c
$new$,
	2);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$media_type, executable)
			select $old$,
	$new$media_type, executable, target)
			select $new$,
	3);
select pg_temp.lk1_replace('public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	$old$src.media_type, src.executable$old$,
	$new$src.media_type, src.executable, src.target$new$,
	3);

-- The commit: the unit's shape, its authority (write on its path; no other op), its outcome (exists or version_changed,
-- invalid for a target of the wrong length), a new folder's links, its parent, and its conflict kept on the receipt.
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			or v_op not in ('write','mkdir','new_folder','delete','move','copy') then$old$,
	$new$			or v_op not in ('write','mkdir','new_folder','delete','move','copy','symlink') then$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			or (v_op = 'write' and jsonb_typeof(v_unit -> 'file') is distinct from 'object')
$old$,
	$new$			or (v_op = 'write' and jsonb_typeof(v_unit -> 'file') is distinct from 'object')
			-- 20260930380000 (LK1): a link's target is text; its length is an outcome.
			or (v_op = 'symlink' and jsonb_typeof(v_unit -> 'target') is distinct from 'string')
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			if v_op in ('write','mkdir') then
				v_ok := public.qorpera_folder_actor_allowed($old$,
	$new$			if v_op in ('write','mkdir','symlink') then
				v_ok := public.qorpera_folder_actor_allowed($new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$						v_key, v_to, 'write');
			end if;
			if not v_ok then v_reason := 'denied'; end if;$old$,
	$new$						v_key, v_to, 'write');
			else v_ok := false; -- 20260930380000 (LK1): no other op.
			end if;
			if not v_ok then v_reason := 'denied'; end if;$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$if v_row.kind is distinct from 'file' or v_row.version::text is distinct from v_unit ->> 'expectedVersion' then$old$,
	$new$if (v_row.kind is distinct from 'file' and v_row.kind is distinct from 'symlink')
					or v_row.version::text is distinct from v_unit ->> 'expectedVersion' then$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		elsif v_ok and v_op = 'mkdir' then
			if v_row.kind is not null then v_ok := false; v_reason := 'exists'; end if;
$old$,
	$new$		elsif v_ok and v_op = 'mkdir' then
			if v_row.kind is not null then v_ok := false; v_reason := 'exists'; end if;
		elsif v_ok and v_op = 'symlink' then
			-- 20260930380000 (LK1): as a write, onto a free path or over the file or link at its version.
			if octet_length(v_unit ->> 'target') not between 1 and 4095 then
				v_ok := false; v_reason := 'invalid';
			elsif v_unit ? 'expectedVersion' and v_unit -> 'expectedVersion' <> 'null'::jsonb then
				if (v_row.kind is distinct from 'file' and v_row.kind is distinct from 'symlink')
					or v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
					v_ok := false; v_reason := 'version_changed'; end if;
			elsif v_row.kind is not null then
				v_ok := false; v_reason := 'exists';
			end if;
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$				or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file')
$old$,
	$new$				or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file'
					and kind is distinct from 'symlink')
				-- 20260930380000 (LK1): a link holds its target and no file; nothing else holds a target.
				or exists (select 1 from c where kind = 'symlink' and (jsonb_typeof(value -> 'target') is distinct from 'string'
					or octet_length(value ->> 'target') not between 1 and 4095 or value ? 'file'))
				or exists (select 1 from c where kind is distinct from 'symlink' and value ? 'target')
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$if v_ok and v_op in ('write','mkdir','new_folder','move','copy') and v_parent is not null$old$,
	$new$if v_ok and v_op in ('write','mkdir','new_folder','move','copy','symlink') and v_parent is not null$new$);
select pg_temp.lk1_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$if not v_ok and v_op in ('write','new_folder') and v_reason in ($old$,
	$new$if not v_ok and v_op in ('write','new_folder','symlink') and v_reason in ($new$);

-- The hook: a link, and each link a new folder brings, stands only where a link may.
select pg_temp.lk1_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	if v_op = 'mkdir' then
		v_problems := public.qorpera_company_state_path_problems(p_eff_path, true);
$old$,
	$new$	-- 20260930380000 (LK1): a link stands only where a link may (qorpera_folder_link_problems); its target is never read.
	if v_op = 'symlink' then
		v_problems := public.qorpera_folder_link_problems(v_key);
		if jsonb_array_length(v_problems) > 0 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		return jsonb_build_object('ok', true);
	end if;

	if v_op = 'mkdir' then
		v_problems := public.qorpera_company_state_path_problems(p_eff_path, true);
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_entries := public.qorpera_company_state_entries(p_unit);
$old$,
	$new$	-- 20260930380000 (LK1): and each link a new folder brings stands only where a link may.
	if v_op = 'new_folder' then
		for v_content in select to_jsonb(s) from public.qorpera_folder_spelled_contents(p_eff_path, p_unit -> 'contents') s
			where s.kind = 'symlink' loop
			v_problems := public.qorpera_folder_link_problems(public.qorpera_folder_key(v_content ->> 'path'));
			if jsonb_array_length(v_problems) > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		end loop;
	end if;
	v_entries := public.qorpera_company_state_entries(p_unit);
$new$);

-- A move or copy carries a link only to where a link may stand, itself or inside a folder.
select pg_temp.lk1_replace(
	'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$	if p_row.kind = 'file' then
$old$,
	$new$	-- 20260930380000 (LK1): a link moves or copies only to where a link may stand.
	if p_row.kind = 'symlink' then
		v_problems := public.qorpera_folder_link_problems(v_to_key);
		if jsonb_array_length(v_problems) > 0 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		return jsonb_build_object('ok', true);
	end if;
	if p_row.kind = 'file' then
$new$);
select pg_temp.lk1_replace(
	'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$		if v_entry.kind = 'file' then
$old$,
	$new$		if v_entry.kind = 'symlink' then
			-- 20260930380000 (LK1)
			v_problems := public.qorpera_folder_link_problems(public.qorpera_folder_key(v_new_path));
			if jsonb_array_length(v_problems) > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		elsif v_entry.kind = 'file' then
$new$);

-- Summary trees: a link is a write (platform only), and a memory commit makes none (no tree path takes one).
select pg_temp.lk1_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$		if p_op in ('write','mkdir','new_folder') then
			if exists$old$,
	$new$		if p_op in ('write','mkdir','new_folder','symlink' /* 20260930380000 (LK1) */) then
			if exists$new$);
select pg_temp.lk1_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$			case when p_op = 'write' then 'file'
$old$,
	$new$			case when p_op = 'write' then 'file' when p_op = 'symlink' then 'symlink' /* 20260930380000 (LK1) */
$new$);
select pg_temp.lk1_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$case when c.kind = 'file' then 'write' else 'mkdir' end, c.kind$old$,
	$new$case when c.kind = 'file' then 'write' when c.kind = 'symlink' then 'symlink' else 'mkdir' end, c.kind$new$);

-- human-tasks/: a link lands as itself, never as a file, and none stands directly under the root.
select pg_temp.lk1_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$select p_key as key, case when p_op = 'mkdir' then 'folder' when p_op = 'new_folder' then 'folder' else 'file' end as kind
		where p_op in ('write','mkdir','new_folder')$old$,
	$new$select p_key as key, case when p_op = 'mkdir' then 'folder' when p_op = 'new_folder' then 'folder'
			when p_op = 'symlink' then 'symlink' else 'file' end as kind
		where p_op in ('write','mkdir','new_folder','symlink') /* 20260930380000 (LK1) */$new$);
select pg_temp.lk1_replace('public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$elsif v_landing.key ~ '^human-tasks/[^/]+$' and v_landing.kind = 'file' then$old$,
	$new$elsif v_landing.key ~ '^human-tasks/[^/]+$' and v_landing.kind <> 'folder' then$new$);

-- interfaces/ and tables/: a link lands as itself, which no place there takes.
select pg_temp.lk1_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$case when p_op in ('mkdir','new_folder') then 'folder' else 'file' end as kind
		where p_op in ('write','mkdir','new_folder')$old$,
	$new$case when p_op in ('mkdir','new_folder') then 'folder'
			when p_op = 'symlink' then 'symlink' else 'file' end as kind
		where p_op in ('write','mkdir','new_folder','symlink') /* 20260930380000 (LK1) */$new$);
select pg_temp.lk1_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$(v_landing.kind = 'file' or p_op in ('move','copy'))$old$,
	$new$(v_landing.kind <> 'folder' or p_op in ('move','copy'))$new$);

-- Conflict copies: a conflicting link's target, and each link of a conflicting new folder; their bytes need no check.
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$	elsif p_unit ->> 'op' = 'new_folder' and jsonb_typeof(p_unit -> 'contents') = 'array' then
$old$,
	$new$	-- 20260930380000 (LK1): a link's copy holds its target.
	elsif p_unit ->> 'op' = 'symlink' then
		v_files := jsonb_build_array(jsonb_build_object('no', 1, 'path', p_path, 'kind', 'symlink', 'target', p_unit -> 'target'));
	elsif p_unit ->> 'op' = 'new_folder' and jsonb_typeof(p_unit -> 'contents') = 'array' then
$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$			select value ->> 'kind' as kind,$old$,
	$new$			select value, value ->> 'kind' as kind,$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$			or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file')
$old$,
	$new$			or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file'
				and kind is distinct from 'symlink')
			or exists (select 1 from c where kind = 'symlink' and (jsonb_typeof(value -> 'target') is distinct from 'string'
				or octet_length(value ->> 'target') not between 1 and 4095 or value ? 'file'))
			or exists (select 1 from c where kind is distinct from 'symlink' and value ? 'target')
$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$		select coalesce(jsonb_agg(jsonb_build_object('no', s.ord, 'path', s.path, 'file', s.file) order by s.ord), '[]')
		into v_files from public.qorpera_folder_spelled_contents(p_path, p_unit -> 'contents') s where s.kind = 'file';$old$,
	$new$		select coalesce(jsonb_agg(jsonb_build_object('no', s.ord, 'path', s.path, 'kind', s.kind, 'file', s.file,
			'target', p_unit -> 'contents' -> (s.ord::integer - 1) -> 'target') order by s.ord), '[]')
		into v_files from public.qorpera_folder_spelled_contents(p_path, p_unit -> 'contents') s
		where s.kind in ('file','symlink');$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$		where jsonb_typeof(f -> 'file') is distinct from 'object'
			or jsonb_typeof(f -> 'file' -> 'executable') is distinct from 'boolean'
			or coalesce(f -> 'file' ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
			or coalesce(f -> 'file' ->> 'bytes', '') !~ '^[0-9]{1,15}$'
$old$,
	$new$		where (f ->> 'kind' is distinct from 'symlink' and (jsonb_typeof(f -> 'file') is distinct from 'object'
				or jsonb_typeof(f -> 'file' -> 'executable') is distinct from 'boolean'
				or coalesce(f -> 'file' ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
				or coalesce(f -> 'file' ->> 'bytes', '') !~ '^[0-9]{1,15}$'))
			-- 20260930380000 (LK1): a link's target.
			or (f ->> 'kind' = 'symlink' and (jsonb_typeof(f -> 'target') is distinct from 'string'
				or octet_length(f ->> 'target') not between 1 and 4095))
$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$	for v_one in select value from jsonb_array_elements(v_files) loop$old$,
	$new$	for v_one in select value from jsonb_array_elements(v_files) where value ->> 'kind' is distinct from 'symlink' loop$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$		file_sha256, bytes, media_type, executable)
$old$,
	$new$		file_sha256, bytes, media_type, executable, kind, target)
$new$);
select pg_temp.lk1_replace(
	'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure,
	$old$		(f -> 'file' ->> 'executable')::boolean
	from jsonb_array_elements(v_files) f;$old$,
	$new$		(f -> 'file' ->> 'executable')::boolean, coalesce(f ->> 'kind', 'file'), f ->> 'target'
	from jsonb_array_elements(v_files) f;$new$);

-- The receipt lists a link's copy by its kind and target, a file's by its manifest.
select pg_temp.lk1_replace('public.qorpera_folder_conflict_copies_of(uuid,uuid)'::regprocedure,
	$old$jsonb_build_object('unit', k.unit_no, 'file', k.file_no, 'path', k.path,
			'manifestSha256', k.manifest_sha256) order by$old$,
	$new$jsonb_build_object('unit', k.unit_no, 'file', k.file_no, 'path', k.path)
			|| case when k.kind = 'symlink' then jsonb_build_object('kind', 'symlink', 'target', k.target) /* 20260930380000 (LK1) */
				else jsonb_build_object('manifestSha256', k.manifest_sha256) end order by$new$);

-- Erasure: a link's copy names no bytes.
select pg_temp.lk1_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$					select b ->> 'manifest' as h from jsonb_array_elements(v_copy_batch) b
$old$,
	$new$					select b ->> 'manifest' as h from jsonb_array_elements(v_copy_batch) b
					where b ->> 'manifest' is not null /* 20260930380000 (LK1): a link's copy has none */
$new$);

-- Readers: a link's target.
select pg_temp.lk1_replace('public.qorpera_folder_read(uuid,jsonb,text)'::regprocedure,
	$old$e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at)
$old$,
	$new$e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at)
				|| case when e.kind = 'symlink' then jsonb_build_object('target', e.target) else '{}'::jsonb end /* 20260930380000 (LK1) */
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_list(uuid,jsonb,text,text,integer,boolean)'::regprocedure,
	$old$p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
$old$,
	$new$p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
			|| case when p.kind = 'symlink' then jsonb_build_object('target', p.target) else '{}'::jsonb end /* 20260930380000 (LK1) */
$new$);
select pg_temp.lk1_replace('public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)'::regprocedure,
	$old$				v.file_sha256, v.bytes, v.media_type, v.executable
			from public.qorpera_folder_path_versions v$old$,
	$new$				v.file_sha256, v.bytes, v.media_type, v.executable, v.target /* 20260930380000 (LK1) */
			from public.qorpera_folder_path_versions v$new$);
select pg_temp.lk1_replace('public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)'::regprocedure,
	$old$'mediaType', s.media_type, 'executable', s.executable, 'updatedAt', e.updated_at))$old$,
	$new$'mediaType', s.media_type, 'executable', s.executable, 'target', s.target, 'updatedAt', e.updated_at))$new$);
select pg_temp.lk1_replace('public.qorpera_member_folder_path_history(uuid,text,uuid,integer)'::regprocedure,
	$old$'executable', page.executable, 'at', page.committed_at$old$,
	$new$'executable', page.executable, 'target', page.target /* 20260930380000 (LK1) */, 'at', page.committed_at$new$);
-- A listed proposal's new folder: each item by the kind its unit gives it (a link has no manifest and is no folder), a
-- link with its target, for the review to read.
select pg_temp.lk1_replace('public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)'::regprocedure,
	$old$'kind', case when q.manifest_sha256 is null then 'folder' else 'file' end) order by q.item_no)$old$,
	$new$'kind', u.v -> 'contents' -> (q.item_no - 1) ->> 'kind',
								'target', u.v -> 'contents' -> (q.item_no - 1) -> 'target' /* 20260930380000 (LK1) */) order by q.item_no)$new$);

drop function pg_temp.lk1_replace(regprocedure, text, text, integer);

-- 4. The deploy guard ------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_folder_link_problems(text)',
		'public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)',
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)',
		'public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)',
		'public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)',
		'public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)',
		'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)',
		'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])',
		'public.qorpera_folder_conflict_copies_of(uuid,uuid)', 'public.qorpera_folder_erasure_step(integer,integer,integer)',
		'public.qorpera_folder_read(uuid,jsonb,text)', 'public.qorpera_folder_list(uuid,jsonb,text,text,integer,boolean)',
		'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)',
		'public.qorpera_member_folder_path_history(uuid,text,uuid,integer)',
		'public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930380000') = 0 then
			raise exception 'LK1 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
