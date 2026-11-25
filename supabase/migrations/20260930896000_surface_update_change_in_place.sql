-- WHY: Enables in-place updates of existing open surface changes when members steer or nudge a change across code_repo, folder, and native_ops surfaces.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_reply_surface_session(uuid,text,boolean)') is null
		or to_regprocedure('public.qorpera_reply_surface_session_with_images(uuid,text,boolean,uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)') is null
		or to_regprocedure('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)') is null
		or to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)') is null
		or to_regprocedure('public.qorpera_surface_normalize_paths(text,text[])') is null
		or to_regprocedure('public.qorpera_surface_enqueue_chain_reconciliation(uuid,uuid)') is null
		or to_regclass('public.qorpera_surface_build_handbacks') is null then
		raise exception '20260930896000 requires surface reply, record_change, build handback, and preview lineage migrations';
	end if;
	if to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)') is not null then
		raise exception '20260930896000 is already applied';
	end if;
end $$;

create temporary table suci_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.suci_apply_pairs(p_def text, p_label text, p_pairs text[])
returns text language plpgsql as $$
declare
	v_def text := p_def;
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930896000: invalid replacement pairs for %', p_label;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		if p_pairs[v_i] = '' then
			raise exception '20260930896000: empty anchor for %', p_label;
		end if;
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930896000: anchor matched % time(s) in %: %', v_hits, p_label, left(p_pairs[v_i], 140);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	return v_def;
end $$;

create function pg_temp.suci_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
begin
	execute pg_temp.suci_apply_pairs(v_def, p_target::text, p_pairs);
end $$;

create function public.qorpera_surface_deep_merge_jsonb(
	p_base jsonb,
	p_patch jsonb,
	p_depth integer default 0
)
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
	v_out jsonb;
	v_k text;
	v_v jsonb;
begin
	if p_depth > 20 or jsonb_typeof(p_base) <> 'object' or jsonb_typeof(p_patch) <> 'object' then
		return p_patch;
	end if;
	v_out := p_base;
	for v_k, v_v in select key, value from jsonb_each(p_patch) loop
		if jsonb_typeof(v_out -> v_k) = 'object' and jsonb_typeof(v_v) = 'object' then
			v_out := jsonb_set(
				v_out,
				array[v_k],
				public.qorpera_surface_deep_merge_jsonb(v_out -> v_k, v_v, p_depth + 1),
				true
			);
		else
			v_out := jsonb_set(v_out, array[v_k], v_v, true);
		end if;
	end loop;
	return v_out;
end $$;

create function public.qorpera_surface_merge_folder_patch_ops(
	p_folder_root text,
	p_existing_ops jsonb,
	p_new_ops jsonb,
	p_existing_base_files jsonb default null
)
returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
	v_prefix text := lower(trim(both '/' from coalesce(p_folder_root, '')));
	v_replaced_paths text[];
	v_non_delete_new_paths text[];
	v_created_paths text[];
	v_kept jsonb := '[]'::jsonb;
	v_appended jsonb := '[]'::jsonb;
	v_raw jsonb;
	v_out jsonb := '[]'::jsonb;
	v_merge_idx jsonb := '{}'::jsonb;
	v_elem jsonb;
	v_op text;
	v_path_key text;
	v_idx integer;
	v_prev jsonb;
	v_merged_patch jsonb;
begin
	if jsonb_typeof(p_new_ops) <> 'array' or jsonb_array_length(p_new_ops) = 0 then
		return coalesce(p_existing_ops, '[]'::jsonb);
	end if;
	if jsonb_typeof(p_existing_ops) <> 'array' or jsonb_array_length(p_existing_ops) = 0 then
		v_raw := p_new_ops;
	else
		select
			coalesce(array_agg(distinct norm_path) filter (where op_kind in ('write_text', 'write_file', 'delete') and norm_path <> ''), '{}'::text[]),
			coalesce(array_agg(distinct norm_path) filter (where op_kind <> 'delete' and norm_path <> ''), '{}'::text[])
		into v_replaced_paths, v_non_delete_new_paths
		from (
			select
				elem ->> 'op' as op_kind,
				case
					when v_prefix <> '' and lower(trim(both '/' from coalesce(elem ->> 'path', ''))) like (v_prefix || '/%')
						then substr(lower(trim(both '/' from coalesce(elem ->> 'path', ''))), length(v_prefix) + 2)
					else lower(trim(both '/' from coalesce(elem ->> 'path', '')))
				end as norm_path
			from jsonb_array_elements(p_new_ops) as elem
		) new_rows;

		select coalesce(jsonb_agg(existing.elem order by existing.ord), '[]'::jsonb)
		into v_kept
		from (
			select
				elem,
				ord,
				case
					when v_prefix <> '' and lower(trim(both '/' from coalesce(elem ->> 'path', ''))) like (v_prefix || '/%')
						then substr(lower(trim(both '/' from coalesce(elem ->> 'path', ''))), length(v_prefix) + 2)
					else lower(trim(both '/' from coalesce(elem ->> 'path', '')))
				end as norm_path
			from jsonb_array_elements(p_existing_ops) with ordinality as e(elem, ord)
		) existing
		where existing.norm_path = '' or not (existing.norm_path = any(v_replaced_paths));

		if jsonb_typeof(p_existing_base_files) = 'object' then
			select coalesce(array_agg(distinct norm_key), '{}'::text[])
			into v_created_paths
			from (
				select
					case
						when v_prefix <> '' and lower(trim(both '/' from k)) like (v_prefix || '/%')
							then substr(lower(trim(both '/' from k)), length(v_prefix) + 2)
						else lower(trim(both '/' from k))
					end as norm_key
				from jsonb_each(p_existing_base_files) as bf(k, v)
				where jsonb_typeof(bf.v) = 'null'
			) base_nulls
			where norm_key <> '' and not (norm_key = any(v_non_delete_new_paths));
		else
			v_created_paths := '{}'::text[];
		end if;

		select coalesce(jsonb_agg(new_item.elem order by new_item.ord), '[]'::jsonb)
		into v_appended
		from (
			select
				elem,
				ord,
				elem ->> 'op' as op_kind,
				case
					when v_prefix <> '' and lower(trim(both '/' from coalesce(elem ->> 'path', ''))) like (v_prefix || '/%')
						then substr(lower(trim(both '/' from coalesce(elem ->> 'path', ''))), length(v_prefix) + 2)
					else lower(trim(both '/' from coalesce(elem ->> 'path', '')))
				end as norm_path
			from jsonb_array_elements(p_new_ops) with ordinality as n(elem, ord)
		) new_item
		where not (new_item.op_kind = 'delete' and new_item.norm_path = any(v_created_paths));

		v_raw := v_kept || v_appended;
	end if;

	for v_elem in select value from jsonb_array_elements(v_raw) loop
		v_op := v_elem ->> 'op';
		v_path_key := case
			when v_prefix <> '' and lower(trim(both '/' from coalesce(v_elem ->> 'path', ''))) like (v_prefix || '/%')
				then substr(lower(trim(both '/' from coalesce(v_elem ->> 'path', ''))), length(v_prefix) + 2)
			else lower(trim(both '/' from coalesce(v_elem ->> 'path', '')))
		end;
		if v_op = 'merge_json' and v_path_key <> '' and (v_merge_idx ? v_path_key) then
			v_idx := (v_merge_idx ->> v_path_key)::integer;
			v_prev := v_out -> v_idx;
			v_merged_patch := public.qorpera_surface_deep_merge_jsonb(
				coalesce(v_prev -> 'patch', '{}'::jsonb),
				coalesce(v_elem -> 'patch', '{}'::jsonb),
				0
			);
			v_out := jsonb_set(v_out, array[v_idx::text], jsonb_set(v_elem, array['patch'], v_merged_patch, true), false);
		else
			v_out := v_out || jsonb_build_array(v_elem);
			if v_op = 'merge_json' and v_path_key <> '' then
				v_merge_idx := jsonb_set(v_merge_idx, array[v_path_key], to_jsonb(jsonb_array_length(v_out) - 1), true);
			elsif v_path_key <> '' then
				v_merge_idx := v_merge_idx - v_path_key;
			end if;
		end if;
	end loop;

	if jsonb_array_length(v_out) = 0 then
		return p_new_ops;
	end if;
	return v_out;
end $$;

create function public.qorpera_surface_session_open_changes_json(
	p_surface public.qorpera_surfaces,
	p_session_id uuid
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_manifest_budget constant integer := 32768;
	v_meta_budget constant integer := 40960;
	v_used_bytes integer := 32;
	v_out jsonb := '[]'::jsonb;
	v_ch record;
	v_meta_item jsonb;
	v_full_item jsonb;
	v_stub_item jsonb;
	v_item_bytes integer;
	v_meta_bytes integer;
	v_stub_bytes integer;
	v_paths text[];
begin
	if p_surface.id is null or p_session_id is null then
		return '[]'::jsonb;
	end if;

	for v_ch in
		select
			ch.id,
			ch.seq,
			ch.title,
			ch.summary,
			ch.kind,
			ch.status,
			ch.parent_sha,
			ch.head_sha,
			ch.affected_paths,
			ch.patch_manifest,
			ch.base_files,
			ch.preview_base_change_ids
		from public.qorpera_surface_changes ch
		where ch.session_id = p_session_id
			and ch.surface_id = p_surface.id
			and ch.profile_id = p_surface.profile_id
			and ch.status in ('staged', 'conflicted')
		order by ch.seq asc, ch.id asc
		limit 32
	loop
		v_paths := coalesce(v_ch.affected_paths[1:64], '{}'::text[]);
		v_meta_item := jsonb_build_object(
			'changeId', v_ch.id,
			'seq', v_ch.seq,
			'title', v_ch.title,
			'summary', public.qorpera_surface_utf8_left(coalesce(v_ch.summary, ''), 320),
			'kind', v_ch.kind,
			'status', v_ch.status,
			'parentSha', v_ch.parent_sha,
			'headSha', v_ch.head_sha,
			'affectedPaths', to_jsonb(v_paths),
			'previewBaseChangeIds', to_jsonb(coalesce(v_ch.preview_base_change_ids, '{}'::uuid[])),
			'actionKind', case
				when v_ch.kind = 'ops_action' and jsonb_typeof(v_ch.patch_manifest) = 'object'
				then v_ch.patch_manifest ->> 'actionKind'
				else null
			end
		);

		if v_ch.kind = 'folder_patch' and jsonb_typeof(v_ch.patch_manifest) = 'array' then
			v_full_item := v_meta_item || jsonb_build_object(
				'patchManifest', v_ch.patch_manifest,
				'baseFiles', v_ch.base_files
			);
			v_item_bytes := octet_length(v_full_item::text) + 2;
			if v_used_bytes + v_item_bytes <= v_manifest_budget then
				v_out := v_out || jsonb_build_array(v_full_item);
				v_used_bytes := v_used_bytes + v_item_bytes;
				continue;
			end if;
			v_full_item := v_meta_item || jsonb_build_object('patchManifest', v_ch.patch_manifest);
			v_item_bytes := octet_length(v_full_item::text) + 2;
			if v_used_bytes + v_item_bytes <= v_manifest_budget then
				v_out := v_out || jsonb_build_array(v_full_item);
				v_used_bytes := v_used_bytes + v_item_bytes;
				continue;
			end if;
			v_meta_item := v_meta_item || jsonb_build_object(
				'truncated', true,
				'pathsTruncated', coalesce(cardinality(v_ch.affected_paths), 0) > 64
			);
		end if;

		v_meta_bytes := octet_length(v_meta_item::text) + 2;
		if v_used_bytes + v_meta_bytes <= v_meta_budget then
			v_out := v_out || jsonb_build_array(v_meta_item);
			v_used_bytes := v_used_bytes + v_meta_bytes;
		else
			v_stub_item := jsonb_build_object(
				'changeId', v_ch.id,
				'seq', v_ch.seq,
				'title', public.qorpera_surface_utf8_left(
					regexp_replace(coalesce(v_ch.title, ''), '[[:cntrl:]"\\]+', ' ', 'g'),
					64
				),
				'summary', '',
				'kind', v_ch.kind,
				'status', v_ch.status,
				'parentSha', v_ch.parent_sha,
				'headSha', v_ch.head_sha,
				'affectedPaths', '[]'::jsonb,
				'previewBaseChangeIds', '[]'::jsonb,
				'truncated', true,
				'pathsTruncated', coalesce(cardinality(v_ch.affected_paths), 0) > 0
			);
			v_stub_bytes := octet_length(v_stub_item::text) + 2;
			v_out := v_out || jsonb_build_array(v_stub_item);
			v_used_bytes := v_used_bytes + v_stub_bytes;
		end if;
	end loop;

	return v_out;
end $$;

create function public.qorpera_surface_reply_target_change_id(p_session_id uuid)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
	v_member_change_id uuid;
	v_member_at timestamptz;
	v_handback_change_id uuid;
	v_handback_at timestamptz;
	v_candidate uuid;
begin
	if p_session_id is null then
		return null;
	end if;

	select m.change_id, m.created_at
	into v_member_change_id, v_member_at
	from public.qorpera_surface_session_messages m
	where m.session_id = p_session_id
		and m.author_kind = 'member'
	order by m.created_at desc, m.id desc
	limit 1;

	select h.change_id, coalesce(h.delivered_at, h.created_at)
	into v_handback_change_id, v_handback_at
	from public.qorpera_surface_build_handbacks h
	where h.session_id = p_session_id
		and h.kind = 'preview'
		and h.state = 'delivered'
		and h.change_id is not null
	order by coalesce(h.delivered_at, h.created_at) desc, h.id desc
	limit 1;

	if v_handback_change_id is not null
		and (v_member_at is null or v_handback_at > v_member_at) then
		v_candidate := v_handback_change_id;
	else
		v_candidate := v_member_change_id;
	end if;

	if v_candidate is null then
		return null;
	end if;

	if exists (
		select 1
		from public.qorpera_surface_changes ch
		where ch.id = v_candidate
			and ch.session_id = p_session_id
			and ch.status in ('staged', 'conflicted')
	) then
		return v_candidate;
	end if;

	return null;
end $$;

do $$
declare
	v_def text;
begin
	v_def := pg_get_functiondef('public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure);
	v_def := pg_temp.suci_apply_pairs(v_def, 'qorpera_reply_surface_session', array[
		'p_keep_open boolean DEFAULT true)',
		'p_keep_open boolean DEFAULT true, p_change_id uuid DEFAULT NULL::uuid)',
$old$	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_session.profile_id, p_session_id, 'member', v_user_id, v_body);$old$,
$new$	if p_change_id is not null and not exists (
		select 1 from public.qorpera_surface_changes ch
		where ch.id = p_change_id
			and ch.session_id = p_session_id
			and ch.profile_id = v_session.profile_id
	) then
		raise exception 'Surface change not found in session' using errcode = '22023';
	end if;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body, change_id)
	values (v_session.profile_id, p_session_id, 'member', v_user_id, v_body, p_change_id);$new$
	]);
	drop function public.qorpera_reply_surface_session(uuid, text, boolean);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_reply_surface_session_with_images(uuid,text,boolean,uuid,jsonb)'::regprocedure);
	v_def := pg_temp.suci_apply_pairs(v_def, 'qorpera_reply_surface_session_with_images', array[
		'p_images jsonb)',
		'p_images jsonb, p_change_id uuid DEFAULT NULL::uuid)',
		'return public.qorpera_reply_surface_session(p_session_id, p_message, p_keep_open);',
		'return public.qorpera_reply_surface_session(p_session_id, p_message, p_keep_open, p_change_id);',
		'v_result := public.qorpera_reply_surface_session(p_session_id, p_message, p_keep_open);',
		'v_result := public.qorpera_reply_surface_session(p_session_id, p_message, p_keep_open, p_change_id);'
	]);
	drop function public.qorpera_reply_surface_session_with_images(uuid, text, boolean, uuid, jsonb);
	execute v_def;
end $$;

revoke all on function
	public.qorpera_reply_surface_session(uuid, text, boolean, uuid),
	public.qorpera_reply_surface_session_with_images(uuid, text, boolean, uuid, jsonb, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_reply_surface_session(uuid, text, boolean, uuid),
	public.qorpera_reply_surface_session_with_images(uuid, text, boolean, uuid, jsonb, uuid)
	to authenticated;

do $$
declare
	v_def text;
begin
	v_def := pg_get_functiondef('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure);
	v_def := pg_temp.suci_apply_pairs(v_def, 'qorpera_record_surface_change', array[
		'p_finish_session boolean DEFAULT false)',
		'p_finish_session boolean DEFAULT false, p_change_id uuid DEFAULT NULL::uuid)',
$old$	v_retry_enqueued boolean := false;
	v_now timestamptz := clock_timestamp();$old$,
$new$	v_retry_enqueued boolean := false;
	v_replace_all boolean := false;
	v_allow_rebase boolean := false;
	v_has_later_git_change boolean := false;
	v_existing public.qorpera_surface_changes%rowtype;
	v_raw_parent_sha text;
	v_eff_parent_sha text;
	v_eff_head_sha text;
	v_eff_paths text[];
	v_eff_base_files jsonb;
	v_affected_change_ids uuid[];
	v_conflicted_downstream_ids uuid[];
	v_now timestamptz := clock_timestamp();$new$,
$old$	if coalesce(p_kind, 'git_range') = 'folder_patch'
		and jsonb_typeof(p_patch_manifest) = 'object'
		and jsonb_typeof(p_patch_manifest -> 'ops') = 'array' then
		v_patch_manifest := p_patch_manifest -> 'ops';
		v_base_files := case
			when jsonb_typeof(p_patch_manifest -> 'baseFiles') = 'object' then p_patch_manifest -> 'baseFiles'
			else null
		end;
	else
		v_patch_manifest := p_patch_manifest;
		v_base_files := null;
	end if;$old$,
$new$	if coalesce(p_kind, 'git_range') = 'folder_patch'
		and jsonb_typeof(p_patch_manifest) = 'object'
		and jsonb_typeof(p_patch_manifest -> 'ops') = 'array' then
		v_patch_manifest := p_patch_manifest -> 'ops';
		v_base_files := case
			when jsonb_typeof(p_patch_manifest -> 'baseFiles') = 'object' then p_patch_manifest -> 'baseFiles'
			else null
		end;
		v_replace_all := coalesce(
			jsonb_typeof(p_patch_manifest -> 'replaceAll') = 'boolean'
				and p_patch_manifest ->> 'replaceAll' = 'true',
			false
		);
	else
		v_patch_manifest := p_patch_manifest;
		v_base_files := null;
		v_replace_all := false;
	end if;$new$,
$old$	select coalesce(max(seq), 0)::smallint + 1 into v_next_seq
	from public.qorpera_surface_changes
	where session_id = p_session_id;$old$,
$new$	if p_change_id is not null then
		select * into v_existing
		from public.qorpera_surface_changes ch
		where ch.id = p_change_id
			and ch.session_id = p_session_id
			and ch.profile_id = v_session.profile_id
		for update;

		if v_existing.id is null then
			raise exception 'Surface change not found in session' using errcode = 'P0002';
		end if;
		if v_existing.status not in ('staged', 'conflicted') then
			raise exception 'Surface change is not open for update' using errcode = '22023';
		end if;
		if v_existing.kind is distinct from coalesce(p_kind, 'git_range') then
			raise exception 'Surface change kind cannot change on update' using errcode = '22023';
		end if;
		if p_change_id = any(coalesce(p_depends_on_change_ids, '{}'::uuid[])) then
			raise exception 'Surface change cannot depend on itself' using errcode = '22023';
		end if;

		if v_existing.kind = 'folder_patch' then
			select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
			if not v_replace_all
				and jsonb_typeof(v_existing.patch_manifest) = 'array'
				and jsonb_typeof(v_patch_manifest) = 'array' then
				v_patch_manifest := public.qorpera_surface_merge_folder_patch_ops(
					v_surface.folder_root,
					v_existing.patch_manifest,
					v_patch_manifest,
					v_existing.base_files
				);
			end if;
			if jsonb_typeof(v_patch_manifest) = 'array' then
				select coalesce(array_agg(distinct op_path order by op_path), '{}'::text[])
				into v_eff_paths
				from (
					select nullif(btrim(elem ->> 'path'), '') as op_path
					from jsonb_array_elements(v_patch_manifest) as elem
				) p
				where p.op_path is not null;
			else
				v_eff_paths := coalesce(p_affected_paths, v_existing.affected_paths, '{}'::text[]);
			end if;
			if v_existing.base_files is null and v_base_files is null then
				v_eff_base_files := null;
			else
				select coalesce(jsonb_object_agg(merged.k, merged.v), '{}'::jsonb)
				into v_eff_base_files
				from (
					select bf.k, bf.v
					from jsonb_each(coalesce(v_existing.base_files, '{}'::jsonb)) as bf(k, v)
					where bf.k = any(v_eff_paths)
						or public.qorpera_surface_normalize_paths(v_surface.folder_root, array[bf.k])
							&& public.qorpera_surface_normalize_paths(v_surface.folder_root, v_eff_paths)
					union all
					select nb.k, nb.v
					from jsonb_each(coalesce(v_base_files, '{}'::jsonb)) as nb(k, v)
					where (
						nb.k = any(v_eff_paths)
						or public.qorpera_surface_normalize_paths(v_surface.folder_root, array[nb.k])
							&& public.qorpera_surface_normalize_paths(v_surface.folder_root, v_eff_paths)
					)
						and not exists (
							select 1
							from jsonb_each(coalesce(v_existing.base_files, '{}'::jsonb)) as eb(k, v)
							where eb.k = nb.k
								or public.qorpera_surface_normalize_paths(v_surface.folder_root, array[eb.k])
									&& public.qorpera_surface_normalize_paths(v_surface.folder_root, array[nb.k])
						)
				) merged;
				if v_eff_base_files = '{}'::jsonb then
					v_eff_base_files := null;
				end if;
			end if;
			v_eff_parent_sha := v_existing.parent_sha;
			v_eff_head_sha := v_existing.head_sha;
		elsif v_existing.kind = 'git_range' then
			v_allow_rebase := coalesce(
				jsonb_typeof(p_patch_manifest) = 'object'
					and jsonb_typeof(p_patch_manifest -> 'rebase') = 'boolean'
					and p_patch_manifest ->> 'rebase' = 'true',
				false
			);
			select exists (
				select 1
				from public.qorpera_surface_changes later_ch
				where later_ch.session_id = p_session_id
					and later_ch.profile_id = v_session.profile_id
					and later_ch.kind = 'git_range'
					and later_ch.status in ('staged', 'conflicted')
					and (later_ch.seq > v_existing.seq or (later_ch.seq = v_existing.seq and later_ch.id > v_existing.id))
			) into v_has_later_git_change;

			v_eff_head_sha := coalesce(nullif(btrim(coalesce(p_head_sha, '')), ''), v_existing.head_sha);
			v_raw_parent_sha := nullif(btrim(coalesce(p_parent_sha, '')), '');

			if v_has_later_git_change and v_raw_parent_sha is null then
				raise exception 'Updating a non-tip git_range change requires an explicit parent_sha' using errcode = '22023';
			end if;
			if v_has_later_git_change and not v_allow_rebase
				and v_existing.parent_sha is not null
				and v_raw_parent_sha is distinct from v_existing.parent_sha then
				raise exception 'Non-tip git_range update parent_sha must match existing parent_sha unless rebasing' using errcode = '22023';
			end if;

			if v_raw_parent_sha is null then
				v_eff_parent_sha := v_existing.parent_sha;
			elsif not v_has_later_git_change
				and not v_allow_rebase
				and v_existing.parent_sha is not null
				and v_existing.head_sha is not null
				and v_raw_parent_sha = v_existing.head_sha
				and v_eff_head_sha is distinct from v_existing.head_sha then
				v_eff_parent_sha := v_existing.parent_sha;
			elsif not v_allow_rebase
				and v_existing.parent_sha is not null
				and v_raw_parent_sha is distinct from v_existing.parent_sha
				and (v_existing.head_sha is null or v_raw_parent_sha is distinct from v_existing.head_sha) then
				raise exception 'git_range update parent_sha must match existing parent_sha or head_sha unless rebasing' using errcode = '22023';
			else
				v_eff_parent_sha := v_raw_parent_sha;
			end if;

			if v_eff_parent_sha is null or v_eff_parent_sha !~ '^[0-9a-f]{40}$'
				or v_eff_head_sha is null or v_eff_head_sha !~ '^[0-9a-f]{40}$' then
				raise exception 'Git range change requires valid 40-hex parent and head commit SHAs' using errcode = '22023';
			end if;

			v_eff_paths := case
				when coalesce(cardinality(p_affected_paths), 0) > 0 then p_affected_paths
				else coalesce(v_existing.affected_paths, '{}'::text[])
			end;
			v_eff_base_files := v_existing.base_files;
		else
			v_eff_parent_sha := v_existing.parent_sha;
			v_eff_head_sha := v_existing.head_sha;
			v_eff_paths := coalesce(p_affected_paths, '{}'::text[]);
			v_eff_base_files := null;
		end if;

		update public.qorpera_surface_changes
		set
			title = btrim(p_title),
			summary = coalesce(p_summary, ''),
			parent_sha = v_eff_parent_sha,
			head_sha = v_eff_head_sha,
			depends_on_change_ids = case
				when p_depends_on_change_ids is not null then p_depends_on_change_ids
				else coalesce(depends_on_change_ids, '{}'::uuid[])
			end,
			affected_paths = coalesce(v_eff_paths, '{}'::text[]),
			diff_stats = coalesce(p_diff_stats, diff_stats),
			patch_manifest = case
				when kind in ('folder_patch', 'ops_action') then v_patch_manifest
				else patch_manifest
			end,
			base_files = case
				when kind = 'folder_patch' then v_eff_base_files
				else base_files
			end,
			status = 'staged',
			conflict_paths = null,
			resolved_at = null
		where id = v_existing.id
		returning * into v_change;

		v_conflicted_downstream_ids := '{}'::uuid[];
		if v_existing.kind = 'git_range'
			and v_existing.head_sha is not null
			and v_eff_head_sha is distinct from v_existing.head_sha then
			with recursive chained as (
				select ch.id, ch.head_sha
				from public.qorpera_surface_changes ch
				where ch.session_id = p_session_id
					and ch.profile_id = v_session.profile_id
					and ch.kind = 'git_range'
					and ch.status in ('staged', 'conflicted')
					and ch.id <> v_existing.id
					and ch.parent_sha = v_existing.head_sha
				union
				select next_ch.id, next_ch.head_sha
				from public.qorpera_surface_changes next_ch
				join chained on next_ch.parent_sha = chained.head_sha
				where next_ch.session_id = p_session_id
					and next_ch.profile_id = v_session.profile_id
					and next_ch.kind = 'git_range'
					and next_ch.status in ('staged', 'conflicted')
					and next_ch.id <> v_existing.id
					and chained.head_sha is not null
			),
			marked as (
				update public.qorpera_surface_changes ch
				set status = 'conflicted'
				from chained
				where ch.id = chained.id
					and ch.status = 'staged'
				returning ch.id
			)
			select coalesce(array_agg(id), '{}'::uuid[]) into v_conflicted_downstream_ids from marked;
		end if;
		v_affected_change_ids := array[v_change.id] || coalesce(v_conflicted_downstream_ids, '{}'::uuid[]);

		update public.qorpera_surface_reconciliations
		set
			expires_at = v_now,
			status = case when status in ('queued', 'running') then 'failed' else status end,
			error_detail = case when status in ('queued', 'running') then 'Change updated' else error_detail end,
			auto_approve_after = false,
			updated_at = v_now
		where surface_id = v_session.surface_id
			and selected_change_ids && v_affected_change_ids
			and (expires_at > v_now or status in ('queued', 'running'));

		update public.qorpera_surface_previews
		set expires_at = v_now, updated_at = v_now
		where surface_id = v_session.surface_id
			and selected_change_ids && v_affected_change_ids
			and status in ('composing', 'reconciling')
			and expires_at > v_now;

		perform public.qorpera_surface_enqueue_chain_reconciliation(v_session.surface_id, v_change.id);

		update public.qorpera_surface_sessions
		set
			branch_head_sha = coalesce(v_eff_head_sha, branch_head_sha),
			state = case when p_finish_session then 'ready' else state end,
			updated_at = v_now
		where id = p_session_id
		returning * into v_session;

		return jsonb_build_object(
			'changeId', v_change.id,
			'seq', v_change.seq,
			'updated', true,
			'session', public.qorpera_surface_session_json(v_session)
		);
	end if;

	select coalesce(max(seq), 0)::smallint + 1 into v_next_seq
	from public.qorpera_surface_changes
	where session_id = p_session_id;$new$
	]);
	drop function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure);
	v_def := pg_temp.suci_apply_pairs(v_def, 'qorpera_native_surface_record_change', array[
		'p_lease_token uuid DEFAULT NULL::uuid)',
		'p_lease_token uuid DEFAULT NULL::uuid, p_change_id uuid DEFAULT NULL::uuid)',
$old$	if coalesce(p_kind, 'git_range') = 'git_range' then
		if v_parent_sha is null then
			select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
			v_parent_sha := coalesce(
				(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
					where c.session_id = p_session_id and c.head_sha is not null
						and c.status in ('staged', 'conflicted')
					order by c.seq desc limit 1),$old$,
$new$	if coalesce(p_kind, 'git_range') = 'git_range' and p_change_id is null then
		if v_parent_sha is null then
			select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
			v_parent_sha := coalesce(
				(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
					where c.session_id = p_session_id and c.head_sha is not null
						and c.status in ('staged', 'conflicted')
					order by c.seq desc limit 1),$new$,
$old$	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session
	);$old$,
$new$	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session, p_change_id
	);$new$
	]);
	drop function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid);
	execute v_def;
end $$;

revoke all on function
	public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid),
	public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function
	public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid),
	public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, uuid)
	to service_role;

select pg_temp.suci_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$		'previewBaseChangeIds', to_jsonb(coalesce(v_session.preview_base_change_ids, '{}'::uuid[])),$old$,
$new$		'sessionOpenChanges', case
			when not v_session.is_internal
			then public.qorpera_surface_session_open_changes_json(v_surface, v_session.id)
			else '[]'::jsonb
		end,
		'replyChangeId', case
			when not v_session.is_internal
			then public.qorpera_surface_reply_target_change_id(v_session.id)
			else null
		end,
		'previewBaseChangeIds', to_jsonb(coalesce(v_session.preview_base_change_ids, '{}'::uuid[])),$new$
	]
);

select pg_temp.suci_patch(
	'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure,
	array[
$old$	v_question jsonb;
	v_title text;$old$,
$new$	v_question jsonb;
	v_title text;
	v_tip_change public.qorpera_surface_changes%rowtype;
	v_turn_opened_at timestamptz;
	v_open_git_count integer := 0;
	v_reply_change_id uuid;$new$,
$old$		if v_head_sha ~ '^[0-9a-f]{40}$' and v_base_sha ~ '^[0-9a-f]{40}$' then
			select nullif(btrim(c.head_sha), '') into v_prev_sha
			from public.qorpera_surface_changes c
			where c.session_id = v_surf_session.id and c.head_sha is not null
				and c.status in ('staged', 'conflicted')
			order by c.seq desc
			limit 1;
			v_prev_sha := coalesce(v_prev_sha, v_base_sha);
			if v_head_sha <> v_prev_sha then
				v_title := left(coalesce(nullif(btrim(v_surf_session.title), ''), 'Staged update'), 160);
				perform public.qorpera_record_surface_change(
					v_surf_session.id,
					v_title,
					left(btrim(coalesce(p_summary, '')), 400),
					'git_range',
					v_prev_sha,
					v_head_sha,
					'{}'::uuid[],
					'{}'::text[],
					null,
					null,
					false
				);
			end if;
		end if;$old$,
$new$		if v_head_sha ~ '^[0-9a-f]{40}$' and v_base_sha ~ '^[0-9a-f]{40}$' then
			select * into v_tip_change
			from public.qorpera_surface_changes c
			where c.session_id = v_surf_session.id
				and c.kind = 'git_range'
				and c.head_sha is not null
				and c.status in ('staged', 'conflicted')
			order by c.seq desc, c.id desc
			limit 1;
			v_prev_sha := coalesce(nullif(btrim(v_tip_change.head_sha), ''), v_base_sha);
			if v_head_sha <> v_prev_sha then
				v_turn_opened_at := null;
				v_open_git_count := 0;
				v_reply_change_id := null;
				if p_worker.sequence > 1
					and v_tip_change.id is not null
					and not coalesce(v_surf_session.is_internal, false) then
					select t.created_at into v_turn_opened_at
					from public.qorpera_coding_session_turns t
					where t.worker_id = p_worker.id and t.sequence = p_worker.sequence;
					select count(*) into v_open_git_count
					from public.qorpera_surface_changes c
					where c.session_id = v_surf_session.id
						and c.kind = 'git_range'
						and c.status in ('staged', 'conflicted');
					v_reply_change_id := public.qorpera_surface_reply_target_change_id(v_surf_session.id);
				end if;
				if p_worker.sequence > 1
					and v_tip_change.id is not null
					and not coalesce(v_surf_session.is_internal, false)
					and v_tip_change.created_at <= coalesce(v_turn_opened_at, clock_timestamp())
					and (v_tip_change.id = v_reply_change_id or v_open_git_count = 1) then
					perform public.qorpera_record_surface_change(
						v_surf_session.id,
						v_tip_change.title,
						coalesce(nullif(left(btrim(coalesce(p_summary, '')), 400), ''), v_tip_change.summary),
						'git_range',
						coalesce(nullif(btrim(v_tip_change.parent_sha), ''), v_base_sha),
						v_head_sha,
						v_tip_change.depends_on_change_ids,
						v_tip_change.affected_paths,
						null,
						null,
						false,
						v_tip_change.id
					);
				else
					v_title := left(coalesce(nullif(btrim(v_surf_session.title), ''), 'Staged update'), 160);
					perform public.qorpera_record_surface_change(
						v_surf_session.id,
						v_title,
						left(btrim(coalesce(p_summary, '')), 400),
						'git_range',
						v_prev_sha,
						v_head_sha,
						'{}'::uuid[],
						'{}'::text[],
						null,
						null,
						false
					);
				end if;
			end if;
		end if;$new$
	]
);

revoke all on function
	public.qorpera_surface_deep_merge_jsonb(jsonb, jsonb, integer),
	public.qorpera_surface_merge_folder_patch_ops(text, jsonb, jsonb, jsonb),
	public.qorpera_surface_session_open_changes_json(public.qorpera_surfaces, uuid),
	public.qorpera_surface_reply_target_change_id(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_reply_surface_session(uuid,text,boolean,uuid)'::regprocedure,
			'public.qorpera_reply_surface_session_with_images(uuid,text,boolean,uuid,jsonb,uuid)'::regprocedure,
			'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure,
			'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,uuid)'::regprocedure,
			'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
			'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface update-in-place function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_deep_merge_jsonb(jsonb, jsonb, integer), public.qorpera_surface_merge_folder_patch_ops(text, jsonb, jsonb, jsonb), public.qorpera_surface_session_open_changes_json(public.qorpera_surfaces, uuid), public.qorpera_surface_reply_target_change_id(uuid), public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid), public.qorpera_reply_surface_session(uuid, text, boolean, uuid) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join suci_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930896000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.suci_patch(regprocedure, text[]);
drop function pg_temp.suci_apply_pairs(text, text, text[]);
drop table suci_before;
