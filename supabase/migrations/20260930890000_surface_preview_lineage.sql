-- WHY: Captures preview base lineage on surface sessions and changes for preview-aware reads and automatic chain/standalone background reconciliation.
set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_reconciliations') is null
		or to_regprocedure('public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)') is null then
		raise exception '20260930890000 requires 20260930888000';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_surface_sessions'
			and column_name = 'preview_base_change_ids'
	) then
		raise exception '20260930890000 is already applied';
	end if;
end $$;

create temporary table spl_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.spl_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930890000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930890000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surface_sessions
	add column preview_base_change_ids uuid[] not null default '{}'::uuid[]
	check (cardinality(preview_base_change_ids) <= 64);

alter table public.qorpera_surface_changes
	add column preview_base_change_ids uuid[] not null default '{}'::uuid[]
	check (cardinality(preview_base_change_ids) <= 64);

create index qorpera_surface_changes_preview_base_gin
	on public.qorpera_surface_changes using gin(preview_base_change_ids)
	where cardinality(preview_base_change_ids) > 0;

create function public.qorpera_surface_normalize_paths(
	p_folder_root text,
	p_paths text[]
)
returns text[]
language sql immutable set search_path = '' as $$
	select coalesce(array_agg(distinct norm.p order by norm.p), '{}'::text[])
	from (
		select
			case
				when trim(both '/' from coalesce(p_folder_root, '')) <> ''
					and trim(both '/' from raw_p) like (trim(both '/' from coalesce(p_folder_root, '')) || '/%')
					then substr(trim(both '/' from raw_p), length(trim(both '/' from coalesce(p_folder_root, ''))) + 2)
				else trim(both '/' from raw_p)
			end as p
		from unnest(coalesce(p_paths, '{}'::text[])) as raw_p
		where nullif(btrim(raw_p), '') is not null
	) norm
	where norm.p <> ''
$$;

create function public.qorpera_surface_dependent_chain(
	p_surface_id uuid,
	p_seed_change_ids uuid[]
)
returns uuid[]
language sql stable security definer set search_path = '' as $$
	with recursive chain(cid, depth, visited) as (
		select ch.id, 0, array[ch.id]
		from public.qorpera_surface_changes ch
		where ch.surface_id = p_surface_id
			and ch.id = any(coalesce(p_seed_change_ids, '{}'::uuid[]))
			and ch.status in ('staged', 'conflicted')
		union all
		select dep.id, c.depth + 1, c.visited || dep.id
		from chain c
		join public.qorpera_surface_changes dep
			on dep.surface_id = p_surface_id
			and dep.status in ('staged', 'conflicted')
			and c.cid = any(dep.preview_base_change_ids)
		where c.depth < 16
			and not (dep.id = any(c.visited))
	),
	ordered as (
		select ch.id
		from (select distinct cid from chain) u
		join public.qorpera_surface_changes ch on ch.id = u.cid
		order by ch.created_at asc, ch.seq asc, ch.id asc
		limit 64
	)
	select coalesce(array_agg(id), '{}'::uuid[])
	from ordered
$$;

create function public.qorpera_surface_preview_turn_context(
	p_surface public.qorpera_surfaces,
	p_base_change_ids uuid[]
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_manifest_budget constant integer := 69632;
	v_meta_budget constant integer := 77824;
	v_max_bytes constant integer := 98304;
	v_used_bytes integer := 0;
	v_open_ids uuid[] := '{}'::uuid[];
	v_changes jsonb := '[]'::jsonb;
	v_recs jsonb := '[]'::jsonb;
	v_ch record;
	v_rec record;
	v_full_item jsonb;
	v_meta_item jsonb;
	v_stub_item jsonb;
	v_stub_paths text[];
	v_paths_truncated boolean := false;
	v_rec_item jsonb;
	v_item_bytes integer;
	v_meta_bytes integer;
	v_stub_bytes integer;
begin
	if p_surface.id is null or coalesce(cardinality(p_base_change_ids), 0) = 0 then
		return jsonb_build_object(
			'previewBaseChanges', '[]'::jsonb,
			'previewReconciliations', '[]'::jsonb
		);
	end if;

	for v_ch in
		select
			ch.id,
			ch.title,
			ch.summary,
			ch.kind,
			ch.parent_sha,
			ch.head_sha,
			ch.affected_paths,
			ch.patch_manifest,
			ch.base_files,
			ch.preview_base_change_ids
		from public.qorpera_surface_changes ch
		where ch.surface_id = p_surface.id
			and ch.profile_id = p_surface.profile_id
			and ch.id = any(p_base_change_ids)
			and ch.status in ('staged', 'conflicted')
		order by ch.created_at asc, ch.seq asc, ch.id asc
		limit 64
	loop
		v_open_ids := array_append(v_open_ids, v_ch.id);
		v_meta_item := jsonb_build_object(
			'changeId', v_ch.id,
			'title', v_ch.title,
			'summary', v_ch.summary,
			'kind', v_ch.kind,
			'parentSha', v_ch.parent_sha,
			'headSha', v_ch.head_sha,
			'affectedPaths', to_jsonb(coalesce(v_ch.affected_paths, '{}'::text[])),
			'previewBaseChangeIds', to_jsonb(coalesce(v_ch.preview_base_change_ids, '{}'::uuid[]))
		);

		if v_ch.kind = 'folder_patch' and v_ch.patch_manifest is not null then
			v_full_item := v_meta_item || jsonb_build_object(
				'patchManifest', v_ch.patch_manifest,
				'baseFiles', v_ch.base_files
			);
			v_item_bytes := octet_length(v_full_item::text);
			if v_used_bytes + v_item_bytes <= v_manifest_budget then
				v_changes := v_changes || jsonb_build_array(v_full_item);
				v_used_bytes := v_used_bytes + v_item_bytes;
				continue;
			end if;
			v_full_item := v_meta_item || jsonb_build_object('patchManifest', v_ch.patch_manifest);
			v_item_bytes := octet_length(v_full_item::text);
			if v_used_bytes + v_item_bytes <= v_manifest_budget then
				v_changes := v_changes || jsonb_build_array(v_full_item);
				v_used_bytes := v_used_bytes + v_item_bytes;
				continue;
			end if;
			v_meta_item := v_meta_item || jsonb_build_object(
				'truncated', true,
				'pathsTruncated', coalesce(cardinality(v_ch.affected_paths), 0) > 200
			);
		end if;

		v_meta_bytes := octet_length(v_meta_item::text);
		if v_used_bytes + v_meta_bytes <= v_meta_budget then
			v_changes := v_changes || jsonb_build_array(v_meta_item);
			v_used_bytes := v_used_bytes + v_meta_bytes;
		else
			select
				coalesce(array_agg(left(p, 128) order by ord), '{}'::text[]),
				coalesce(bool_or(char_length(p) > 128), false) or coalesce(cardinality(v_ch.affected_paths), 0) > 32
			into v_stub_paths, v_paths_truncated
			from unnest(coalesce(v_ch.affected_paths[1:32], '{}'::text[])) with ordinality as u(p, ord);

			v_stub_item := jsonb_build_object(
				'changeId', v_ch.id,
				'title', public.qorpera_surface_utf8_left(coalesce(v_ch.title, ''), 80),
				'summary', '',
				'kind', v_ch.kind,
				'parentSha', v_ch.parent_sha,
				'headSha', v_ch.head_sha,
				'affectedPaths', to_jsonb(coalesce(v_stub_paths, '{}'::text[])),
				'previewBaseChangeIds', '[]'::jsonb,
				'truncated', true,
				'pathsTruncated', coalesce(v_paths_truncated, false)
			);
			v_stub_bytes := octet_length(v_stub_item::text);
			if v_used_bytes + v_stub_bytes > v_meta_budget then
				-- WHY: Reserves 20 KiB inside the 96 KiB cap and strips JSON-escaped chars so 64 pathless stubs always fit strictly under 96 KiB.
				v_stub_item := jsonb_build_object(
					'changeId', v_ch.id,
					'title', public.qorpera_surface_utf8_left(
						regexp_replace(coalesce(v_ch.title, ''), '[[:cntrl:]"\\]+', ' ', 'g'),
						48
					),
					'summary', '',
					'kind', v_ch.kind,
					'affectedPaths', '[]'::jsonb,
					'previewBaseChangeIds', '[]'::jsonb,
					'truncated', true,
					'pathsTruncated', coalesce(cardinality(v_ch.affected_paths), 0) > 0
				);
				v_stub_bytes := octet_length(v_stub_item::text);
			end if;
			v_changes := v_changes || jsonb_build_array(v_stub_item);
			v_used_bytes := v_used_bytes + v_stub_bytes;
		end if;
	end loop;

	if cardinality(v_open_ids) > 0 then
		for v_rec in
			select r.*
			from public.qorpera_surface_reconciliations r
			where r.surface_id = p_surface.id
				and r.base_fingerprint = public.qorpera_surface_base_fingerprint(p_surface)
				and r.status = 'ready'
				and r.expires_at > clock_timestamp()
				and r.selected_change_ids <@ v_open_ids
				and not exists (
					select 1
					from public.qorpera_surface_changes dep
					cross join lateral unnest(coalesce(dep.preview_base_change_ids, '{}'::uuid[])) as base_id
					where dep.surface_id = p_surface.id
						and dep.id = any(r.selected_change_ids)
						and base_id = any(v_open_ids)
						and not (base_id = any(r.selected_change_ids))
				)
			order by cardinality(r.selected_change_ids) desc, r.updated_at desc
			limit 8
		loop
			v_rec_item := public.qorpera_surface_reconciliation_json(v_rec);
			v_item_bytes := octet_length(v_rec_item::text);
			if v_used_bytes + v_item_bytes <= v_max_bytes then
				v_recs := v_recs || jsonb_build_array(v_rec_item);
				v_used_bytes := v_used_bytes + v_item_bytes;
			end if;
		end loop;
	end if;

	return jsonb_build_object(
		'previewBaseChanges', v_changes,
		'previewReconciliations', v_recs
	);
end $$;

create function public.qorpera_surface_reconciliation_omitted_bases(
	p_surface_id uuid,
	p_selected_ids uuid[]
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_max_bytes constant integer := 49152;
	v_used_bytes integer := 0;
	v_out jsonb := '[]'::jsonb;
	v_base record;
	v_full jsonb;
	v_meta jsonb;
	v_bytes integer;
begin
	if p_surface_id is null or coalesce(cardinality(p_selected_ids), 0) = 0 then
		return '[]'::jsonb;
	end if;

	for v_base in
		select distinct
			b.id,
			b.title,
			b.summary,
			b.kind,
			b.status,
			b.parent_sha,
			b.head_sha,
			b.affected_paths,
			b.patch_manifest,
			b.created_at,
			b.seq
		from public.qorpera_surface_changes ch
		cross join lateral unnest(coalesce(ch.preview_base_change_ids, '{}'::uuid[])) as base_id
		join public.qorpera_surface_changes b
			on b.id = base_id
			and b.surface_id = p_surface_id
			and b.status not in ('merged', 'merging')
		where ch.surface_id = p_surface_id
			and ch.id = any(p_selected_ids)
			and not (base_id = any(p_selected_ids))
		order by b.created_at asc, b.seq asc, b.id asc
		limit 16
	loop
		v_meta := jsonb_build_object(
			'changeId', v_base.id,
			'title', v_base.title,
			'summary', v_base.summary,
			'kind', v_base.kind,
			'status', v_base.status,
			'parentSha', v_base.parent_sha,
			'headSha', v_base.head_sha,
			'affectedPaths', to_jsonb(coalesce(v_base.affected_paths, '{}'::text[]))
		);
		if v_base.kind = 'folder_patch' and v_base.patch_manifest is not null then
			v_full := v_meta || jsonb_build_object('patchManifest', v_base.patch_manifest);
			v_bytes := octet_length(v_full::text);
			if v_used_bytes + v_bytes <= v_max_bytes then
				v_out := v_out || jsonb_build_array(v_full);
				v_used_bytes := v_used_bytes + v_bytes;
				continue;
			end if;
		end if;
		v_bytes := octet_length(v_meta::text);
		if v_used_bytes + v_bytes <= v_max_bytes then
			v_out := v_out || jsonb_build_array(v_meta);
			v_used_bytes := v_used_bytes + v_bytes;
		end if;
	end loop;

	return v_out;
end $$;

create function public.qorpera_surface_needs_standalone_reconciliation(
	p_surface public.qorpera_surfaces,
	p_target_ids uuid[]
)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
	v_has_omitted boolean := false;
	v_key_info jsonb;
begin
	if p_surface.id is null
		or p_surface.status <> 'active'
		or p_surface.source_kind not in ('folder', 'code_repo')
		or coalesce(cardinality(p_target_ids), 0) = 0 then
		return false;
	end if;

	select exists (
		select 1
		from public.qorpera_surface_changes ch
		cross join lateral unnest(coalesce(ch.preview_base_change_ids, '{}'::uuid[])) as base_id
		join public.qorpera_surface_changes b
			on b.id = base_id
			and b.surface_id = p_surface.id
			and b.status not in ('merged', 'merging')
		where ch.surface_id = p_surface.id
			and ch.id = any(p_target_ids)
			and not (base_id = any(p_target_ids))
	) into v_has_omitted;

	if not v_has_omitted then
		return false;
	end if;

	v_key_info := public.qorpera_surface_reconciliation_key(p_surface, p_target_ids);
	if v_key_info is null then
		return false;
	end if;

	return not exists (
		select 1
		from public.qorpera_surface_reconciliations r
		where r.surface_id = p_surface.id
			and r.composition_key = (v_key_info ->> 'compositionKey')
			and r.status = 'ready'
			and r.expires_at > clock_timestamp()
	);
end $$;

create function public.qorpera_surface_enqueue_chain_reconciliation(
	p_surface_id uuid,
	p_new_change_id uuid
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_new public.qorpera_surface_changes%rowtype;
	v_new_paths text[];
	v_overlapped_bases uuid[];
	v_dependents uuid[];
	v_chain_ids uuid[];
	v_overlap_paths text[];
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null or v_surface.status <> 'active' or v_surface.source_kind not in ('folder', 'code_repo') then
		return;
	end if;

	select * into v_new
	from public.qorpera_surface_changes
	where id = p_new_change_id and surface_id = p_surface_id;
	if v_new.id is null or v_new.status not in ('staged', 'conflicted') then
		return;
	end if;

	v_new_paths := public.qorpera_surface_normalize_paths(v_surface.folder_root, v_new.affected_paths);
	if coalesce(cardinality(v_new_paths), 0) = 0 then
		return;
	end if;

	select coalesce(array_agg(b.id order by b.created_at asc, b.seq asc, b.id asc), '{}'::uuid[])
	into v_overlapped_bases
	from public.qorpera_surface_changes b
	where b.surface_id = p_surface_id
		and b.id <> p_new_change_id
		and b.status in ('staged', 'conflicted')
		and public.qorpera_surface_normalize_paths(v_surface.folder_root, b.affected_paths) && v_new_paths
		and exists (
			select 1
			from public.qorpera_surface_changes dep
			where dep.surface_id = p_surface_id
				and dep.id <> p_new_change_id
				and dep.id <> b.id
				and dep.status in ('staged', 'conflicted')
				and b.id = any(dep.preview_base_change_ids)
				and not (
					dep.id = any(v_new.preview_base_change_ids)
					and public.qorpera_surface_normalize_paths(v_surface.folder_root, dep.affected_paths) && v_new_paths
				)
		);

	if coalesce(cardinality(v_overlapped_bases), 0) = 0 then
		return;
	end if;

	v_dependents := public.qorpera_surface_dependent_chain(p_surface_id, v_overlapped_bases);

	with recursive ancestors(cid, depth, visited) as (
		select ch.id, 0, array[ch.id]
		from public.qorpera_surface_changes ch
		where ch.surface_id = p_surface_id
			and ch.status in ('staged', 'conflicted')
			and (ch.id = any(v_dependents) or ch.id = p_new_change_id)
		union all
		select base_ch.id, a.depth + 1, a.visited || base_ch.id
		from ancestors a
		join public.qorpera_surface_changes cur
			on cur.id = a.cid and cur.surface_id = p_surface_id
		cross join lateral unnest(coalesce(cur.preview_base_change_ids, '{}'::uuid[])) as base_id
		join public.qorpera_surface_changes base_ch
			on base_ch.id = base_id
			and base_ch.surface_id = p_surface_id
			and base_ch.status in ('staged', 'conflicted')
		where a.depth < 16
			and not (base_ch.id = any(a.visited))
	)
	select coalesce(array_agg(ch.id order by ch.created_at asc, ch.seq asc, ch.id asc), '{}'::uuid[])
	into v_chain_ids
	from (select distinct cid from ancestors) u
	join public.qorpera_surface_changes ch on ch.id = u.cid;

	if coalesce(cardinality(v_chain_ids), 0) < 3 then
		return;
	end if;

	select coalesce(array_agg(distinct np order by np), '{}'::text[])
	into v_overlap_paths
	from public.qorpera_surface_changes b
	cross join lateral unnest(public.qorpera_surface_normalize_paths(v_surface.folder_root, b.affected_paths)) as np
	where b.surface_id = p_surface_id
		and b.id = any(v_overlapped_bases)
		and np = any(v_new_paths);

	begin
		perform public.qorpera_surface_enqueue_silent_reconciliation(
			p_surface_id,
			v_chain_ids,
			coalesce(v_overlap_paths, '{}'::text[]),
			null,
			false,
			false
		);
	exception when others then
		null;
	end;
end $$;

select pg_temp.spl_patch(
	'public.qorpera_start_surface_session(uuid,text,text,text,text,jsonb,integer,text,text[])'::regprocedure,
	array[
$old$	v_owner_label text;
	v_origin_kind text := coalesce(nullif(btrim(coalesce(p_origin_kind, '')), ''), 'member');
begin$old$,
$new$	v_owner_label text;
	v_origin_kind text := coalesce(nullif(btrim(coalesce(p_origin_kind, '')), ''), 'member');
	v_origin_ref jsonb := p_origin_ref;
	v_preview_base_ids uuid[] := '{}'::uuid[];
begin$new$,
$old$	v_placement := public.qorpera_surface_machine_placement_hint(v_surface.profile_id, 6);
	v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;$old$,
$new$	v_placement := public.qorpera_surface_machine_placement_hint(v_surface.profile_id, 6);
	v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;

	if jsonb_typeof(p_origin_ref) = 'object' and jsonb_typeof(p_origin_ref -> 'previewBaseChangeIds') = 'array' then
		select coalesce(array_agg(ordered.id order by ordered.created_at asc, ordered.seq asc, ordered.id asc), '{}'::uuid[])
		into v_preview_base_ids
		from (
			select distinct ch.id, ch.created_at, ch.seq
			from (
				select elem::uuid as cid
				from jsonb_array_elements_text(p_origin_ref -> 'previewBaseChangeIds') with ordinality as u(elem, ord)
				where ord <= 64
					and elem ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
			) raw_ids
			join public.qorpera_surface_changes ch
				on ch.id = raw_ids.cid
				and ch.surface_id = p_surface_id
				and ch.profile_id = v_surface.profile_id
				and ch.status in ('staged', 'conflicted')
			order by ch.created_at asc, ch.seq asc, ch.id asc
			limit 64
		) ordered;
		v_origin_ref := nullif(p_origin_ref - 'previewBaseChangeIds', '{}'::jsonb);
	end if;$new$,
$old$			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
			)
			values (
				v_surface.profile_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, v_origin_kind, coalesce(v_owner_label, 'Member'), p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
			)$old$,
$new$			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, origin_ref, preview_base_change_ids,
				created_by_user_id, state, base_sha
			)
			values (
				v_surface.profile_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, v_origin_kind, coalesce(v_owner_label, 'Member'), v_origin_ref, v_preview_base_ids,
				v_user_id, 'queued', v_surface.live_head_sha
			)$new$,
$old$		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
		)
		values (
			v_surface.profile_id, p_surface_id, v_machine_id, v_title, v_prompt,
			v_origin_kind, v_owner_label, p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
		)$old$,
$new$		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, origin_ref, preview_base_change_ids, created_by_user_id, state, base_sha
		)
		values (
			v_surface.profile_id, p_surface_id, v_machine_id, v_title, v_prompt,
			v_origin_kind, v_owner_label, v_origin_ref, v_preview_base_ids, v_user_id, 'queued', v_surface.live_head_sha
		)$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
	array[
$old$					'baseFiles', ch.base_files,$old$,
$new$					'baseFiles', ch.base_files,
					'previewBaseChangeIds', to_jsonb(coalesce(ch.preview_base_change_ids, '{}'::uuid[])),$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$		'folderRevision', v_surface.folder_revision,$old$,
$new$		'folderRevision', v_surface.folder_revision,
		'previewBaseChangeIds', to_jsonb(coalesce(v_session.preview_base_change_ids, '{}'::uuid[])),
		'previewContext', case
			when not v_session.is_internal and cardinality(coalesce(v_session.preview_base_change_ids, '{}'::uuid[])) > 0
			then public.qorpera_surface_preview_turn_context(v_surface, v_session.preview_base_change_ids)
			else jsonb_build_object('previewBaseChanges', '[]'::jsonb, 'previewReconciliations', '[]'::jsonb)
		end,$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
	array[
$old$	v_paths text[];
	v_prompt text;
	v_now timestamptz := clock_timestamp();$old$,
$new$	v_paths text[];
	v_prompt text;
	v_omitted_bases jsonb := '[]'::jsonb;
	v_chain_mode boolean := false;
	v_now timestamptz := clock_timestamp();$new$,
$old$begin
	perform pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('qorpera.surface-reconcile:' || p_surface_id::text, 0)
	);

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;$old$,
$new$begin
	-- WHY: Lock the surface row before the reconciliation advisory lock to match approve/merge callers and avoid 40P01 deadlocks.
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for key share;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;

	perform pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('qorpera.surface-reconcile:' || p_surface_id::text, 0)
	);

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;$new$,
$old$					'affectedPaths', to_jsonb(coalesce(ch.affected_paths, '{}'::text[])),
					'conflictPaths', to_jsonb(coalesce(ch.conflict_paths, '{}'::text[]))
				)$old$,
$new$					'affectedPaths', to_jsonb(coalesce(ch.affected_paths, '{}'::text[])),
					'conflictPaths', to_jsonb(coalesce(ch.conflict_paths, '{}'::text[])),
					'previewBaseChangeIds', to_jsonb(coalesce(ch.preview_base_change_ids, '{}'::uuid[]))
				)$new$,
$old$	v_prompt := 'Silently combine overlapping staged changes on ' || v_surface.title || ': ' || coalesce(v_titles, 'selected changes');$old$,
$new$	v_omitted_bases := public.qorpera_surface_reconciliation_omitted_bases(p_surface_id, v_ordered_ids);
	select exists (
		select 1
		from public.qorpera_surface_changes ch
		where ch.surface_id = p_surface_id
			and ch.id = any(v_ordered_ids)
			and ch.preview_base_change_ids && v_ordered_ids
	) and cardinality(v_ordered_ids) >= 3
	into v_chain_mode;

	v_prompt := case
		when v_chain_mode
		then 'Silently combine overlapping staged changes and adapt dependent changes on ' || v_surface.title || ': ' || coalesce(v_titles, 'selected changes')
		when jsonb_array_length(v_omitted_bases) > 0
		then 'Silently adapt staged changes on ' || v_surface.title || ' without omitted preview changes: ' || coalesce(v_titles, 'selected changes')
		else 'Silently combine overlapping staged changes on ' || v_surface.title || ': ' || coalesce(v_titles, 'selected changes')
	end;$new$,
$old$			'folderRevision', v_surface.folder_revision,
			'changes', coalesce(v_changes, '[]'::jsonb)
		),$old$,
$new$			'folderRevision', v_surface.folder_revision,
			'chainMode', v_chain_mode,
			'omittedBaseChanges', coalesce(v_omitted_bases, '[]'::jsonb),
			'changes', coalesce(v_changes, '[]'::jsonb)
		),$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure,
	array[
$old$	v_folder_prefix text;
	v_missing_paths text[];
	v_now timestamptz := clock_timestamp();$old$,
$new$	v_folder_prefix text;
	v_missing_paths text[];
	v_preview_base_ids uuid[] := '{}'::uuid[];
	v_retry_rec public.qorpera_surface_reconciliations%rowtype;
	v_recent_reconcile_attempts integer := 0;
	v_retry_enqueued boolean := false;
	v_now timestamptz := clock_timestamp();$new$,
$old$			where p.surface_id = v_session.surface_id
				and p.status in ('reconciling', 'conflicted')$old$,
$new$			where p.surface_id = v_session.surface_id
				and p.status in ('reconciling', 'conflicted', 'ready')$new$,
$old$		if v_rec.auto_approve_after
			and v_rec.base_fingerprint = public.qorpera_surface_base_fingerprint(v_surface)
			and not exists (
				select 1 from public.qorpera_surface_jobs j
				where j.surface_id = v_session.surface_id
					and j.kind in ('land_change', 'undo_change')
					and j.status in ('queued', 'running')
					and exists (
						select 1
						from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
						where x::uuid = any(v_rec.selected_change_ids)
					)
			) then
			if (
				select count(*) from public.qorpera_surface_changes ch
				where ch.surface_id = v_session.surface_id
					and ch.id = any(v_rec.selected_change_ids)
					and ch.status in ('staged', 'conflicted')
			) = cardinality(v_rec.selected_change_ids) then
				select ch.session_id into v_target_session_id
				from public.qorpera_surface_changes ch
				where ch.id = v_rec.selected_change_ids[1];

				update public.qorpera_surface_changes
				set status = 'merging', conflict_paths = null
				where surface_id = v_session.surface_id
					and id = any(v_rec.selected_change_ids)
					and status in ('staged', 'conflicted');

				insert into public.qorpera_surface_jobs(
					profile_id, surface_id, session_id, kind, payload, requested_by_user_id
				)
				values (
					v_session.profile_id,
					v_session.surface_id,
					v_target_session_id,
					'land_change',
					jsonb_build_object(
						'changeIds', to_jsonb(v_rec.selected_change_ids),
						'reconciliationId', v_rec.id,
						'autoPublish', v_surface.auto_publish
					),
					v_rec.created_by_user_id
				);
			end if;
		end if;$old$,
$new$		if v_rec.auto_approve_after
			and not exists (
				select 1 from public.qorpera_surface_jobs j
				where j.surface_id = v_session.surface_id
					and j.kind in ('land_change', 'undo_change')
					and j.status in ('queued', 'running')
					and (
						(j.payload ? 'changeId' and (j.payload ->> 'changeId')::uuid = any(v_rec.selected_change_ids))
						or exists (
							select 1
							from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
							where x::uuid = any(v_rec.selected_change_ids)
						)
					)
			) then
			if (
				select count(*) from public.qorpera_surface_changes ch
				where ch.surface_id = v_session.surface_id
					and ch.id = any(v_rec.selected_change_ids)
					and ch.status in ('staged', 'conflicted')
			) = cardinality(v_rec.selected_change_ids) then
				update public.qorpera_surface_reconciliations
				set auto_approve_after = false, updated_at = v_now
				where id = v_rec.id;

				select ch.session_id into v_target_session_id
				from public.qorpera_surface_changes ch
				where ch.id = v_rec.selected_change_ids[1];

				if v_rec.base_fingerprint = public.qorpera_surface_base_fingerprint(v_surface) then
					update public.qorpera_surface_changes
					set
						status = 'merging',
						conflict_paths = null,
						approved_by_user_id = coalesce(v_rec.created_by_user_id, approved_by_user_id)
					where surface_id = v_session.surface_id
						and id = any(v_rec.selected_change_ids)
						and status in ('staged', 'conflicted');

					insert into public.qorpera_surface_jobs(
						profile_id, surface_id, session_id, kind, payload, requested_by_user_id
					)
					values (
						v_session.profile_id,
						v_session.surface_id,
						v_target_session_id,
						'land_change',
						jsonb_build_object(
							'changeIds', to_jsonb(v_rec.selected_change_ids),
							'reconciliationId', v_rec.id,
							'autoPublish', v_surface.auto_publish
						),
						v_rec.created_by_user_id
					);

					update public.qorpera_member_surface_state
					set toggled_change_ids = array(
						select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_rec.selected_change_ids))
					)
					where surface_id = v_session.surface_id;
				elsif jsonb_typeof(v_session.origin_ref -> 'omittedBaseChanges') = 'array'
					and jsonb_array_length(v_session.origin_ref -> 'omittedBaseChanges') > 0
					and not public.qorpera_surface_needs_standalone_reconciliation(v_surface, v_rec.selected_change_ids) then
					update public.qorpera_surface_changes
					set
						status = 'merging',
						conflict_paths = null,
						approved_by_user_id = coalesce(v_rec.created_by_user_id, approved_by_user_id)
					where surface_id = v_session.surface_id
						and id = any(v_rec.selected_change_ids)
						and status in ('staged', 'conflicted');

					insert into public.qorpera_surface_jobs(
						profile_id, surface_id, session_id, kind, payload, requested_by_user_id
					)
					values (
						v_session.profile_id,
						v_session.surface_id,
						v_target_session_id,
						'land_change',
						jsonb_build_object(
							'changeIds', to_jsonb(v_rec.selected_change_ids),
							'autoPublish', v_surface.auto_publish
						),
						v_rec.created_by_user_id
					);

					update public.qorpera_member_surface_state
					set toggled_change_ids = array(
						select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_rec.selected_change_ids))
					)
					where surface_id = v_session.surface_id;
				else
					select count(*)
					into v_recent_reconcile_attempts
					from public.qorpera_surface_sessions rs
					where rs.surface_id = v_session.surface_id
						and rs.is_internal
						and rs.created_at > v_now - interval '10 minutes'
						and rs.origin_ref -> 'changeIds' = to_jsonb(v_rec.selected_change_ids);

					v_retry_enqueued := false;
					if v_surface.status = 'active' and v_recent_reconcile_attempts < 3 then
						begin
							v_retry_rec := public.qorpera_surface_enqueue_silent_reconciliation(
								v_session.surface_id,
								v_rec.selected_change_ids,
								coalesce(v_rec.conflict_paths, '{}'::text[]),
								v_rec.created_by_user_id,
								true,
								false
							);
							if v_retry_rec.id is not null and v_retry_rec.status = 'failed' then
								v_retry_rec := public.qorpera_surface_enqueue_silent_reconciliation(
									v_session.surface_id,
									v_rec.selected_change_ids,
									coalesce(v_rec.conflict_paths, '{}'::text[]),
									v_rec.created_by_user_id,
									true,
									true
								);
							end if;
							if v_retry_rec.id is not null and v_retry_rec.status in ('queued', 'running') then
								v_retry_enqueued := true;
							elsif v_retry_rec.id is not null and v_retry_rec.status = 'ready' then
								update public.qorpera_surface_changes
								set
									status = 'merging',
									conflict_paths = null,
									approved_by_user_id = coalesce(v_rec.created_by_user_id, approved_by_user_id)
								where surface_id = v_session.surface_id
									and id = any(v_rec.selected_change_ids)
									and status in ('staged', 'conflicted');

								insert into public.qorpera_surface_jobs(
									profile_id, surface_id, session_id, kind, payload, requested_by_user_id
								)
								values (
									v_session.profile_id,
									v_session.surface_id,
									v_target_session_id,
									'land_change',
									jsonb_build_object(
										'changeIds', to_jsonb(v_rec.selected_change_ids),
										'reconciliationId', v_retry_rec.id,
										'autoPublish', v_surface.auto_publish
									),
									v_rec.created_by_user_id
								);

								update public.qorpera_member_surface_state
								set toggled_change_ids = array(
									select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_rec.selected_change_ids))
								)
								where surface_id = v_session.surface_id;
								v_retry_enqueued := true;
							end if;
						exception when others then
							v_retry_enqueued := false;
						end;
					end if;

					if not v_retry_enqueued then
						insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
						select distinct
							v_session.profile_id,
							ch.session_id,
							'system',
							'Could not apply this change automatically. Try approving again.'
						from public.qorpera_surface_changes ch
						where ch.surface_id = v_session.surface_id
							and ch.id = any(v_rec.selected_change_ids);
					end if;
				end if;
			end if;
		end if;$new$,
$old$	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, affected_paths, diff_stats, patch_manifest, base_files, status
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, v_patch_manifest, v_base_files, 'staged'
	)
	returning * into v_change;$old$,
$new$	if cardinality(coalesce(v_session.preview_base_change_ids, '{}'::uuid[])) > 0 then
		select coalesce(array_agg(ch.id order by ch.created_at asc, ch.seq asc, ch.id asc), '{}'::uuid[])
		into v_preview_base_ids
		from public.qorpera_surface_changes ch
		where ch.surface_id = v_session.surface_id
			and ch.profile_id = v_session.profile_id
			and ch.id = any(v_session.preview_base_change_ids)
			and ch.status in ('staged', 'conflicted');
	end if;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, preview_base_change_ids,
		affected_paths, diff_stats, patch_manifest, base_files, status
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(v_preview_base_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, v_patch_manifest, v_base_files, 'staged'
	)
	returning * into v_change;

	perform public.qorpera_surface_enqueue_chain_reconciliation(v_session.surface_id, v_change.id);$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_discard_surface_change(uuid)'::regprocedure,
	array[
$old$declare
	v_change public.qorpera_surface_changes%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
begin
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_change.profile_id, true);$old$,
$new$declare
	v_lookup record;
	v_change public.qorpera_surface_changes%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_discarded_count integer := 0;
	v_dep record;
	v_target_ids uuid[];
begin
	select session_id, surface_id, profile_id into v_lookup
	from public.qorpera_surface_changes
	where id = p_change_id;
	if v_lookup.session_id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_lookup.profile_id, true);

	-- WHY: Acquire session -> surface -> change locks in canonical order before silent reconciliation to avoid 40P01 deadlocks.
	perform 1 from public.qorpera_surface_sessions where id = v_lookup.session_id for update;
	select * into v_surface from public.qorpera_surfaces where id = v_lookup.surface_id for key share;
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;$new$,
$old$	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = clock_timestamp()
	where id = p_change_id and status in ('staged', 'conflicted');$old$,
$new$	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = clock_timestamp()
	where id = p_change_id and status in ('staged', 'conflicted');
	get diagnostics v_discarded_count = row_count;$new$,
$old$	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);$old$,
$new$	if v_discarded_count > 0 then
		if v_surface.id is not null and v_surface.status = 'active' and v_surface.source_kind in ('folder', 'code_repo') then
			for v_dep in
				select ch.id, ch.preview_base_change_ids
				from public.qorpera_surface_changes ch
				where ch.surface_id = v_change.surface_id
					and ch.id <> p_change_id
					and ch.status in ('staged', 'conflicted')
					and p_change_id = any(ch.preview_base_change_ids)
				order by ch.created_at asc, ch.seq asc, ch.id asc
				limit 8
			loop
				select coalesce(array_agg(open_ch.id order by open_ch.created_at asc, open_ch.seq asc, open_ch.id asc), array[v_dep.id])
				into v_target_ids
				from public.qorpera_surface_changes open_ch
				where open_ch.surface_id = v_change.surface_id
					and open_ch.status in ('staged', 'conflicted')
					and (open_ch.id = v_dep.id or open_ch.id = any(v_dep.preview_base_change_ids));
				begin
					perform public.qorpera_surface_enqueue_silent_reconciliation(
						v_change.surface_id, v_target_ids, '{}'::text[], null, false, false
					);
				exception when others then
					null;
				end;
			end loop;
		end if;
	end if;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_approve_surface_change(uuid,boolean)'::regprocedure,
	array[
$old$	v_needs_worker boolean := false;
	v_merged_count integer;
begin$old$,
$new$	v_needs_worker boolean := false;
	v_merged_count integer;
	v_deferred_for_reconcile boolean := false;
	v_rec public.qorpera_surface_reconciliations%rowtype;
begin$new$,
$old$	if v_needs_worker then
		update public.qorpera_surface_changes
		set
			status = 'merging',
			conflict_paths = null,
			approved_by_user_id = v_user_id
		where id = any(v_target_ids)
			and session_id = v_change.session_id
			and status in ('staged', 'conflicted');

		insert into public.qorpera_surface_jobs(
			profile_id, surface_id, session_id, kind, payload, requested_by_user_id
		)
		values (
			v_change.profile_id, v_change.surface_id, v_change.session_id, 'land_change',
			jsonb_build_object('changeIds', to_jsonb(v_target_ids), 'autoPublish', v_surface.auto_publish),
			v_user_id
		);$old$,
$new$	if v_needs_worker then
		if public.qorpera_surface_needs_standalone_reconciliation(v_surface, v_target_ids) then
			v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
				v_change.surface_id, v_target_ids, '{}'::text[], v_user_id, true, false
			);
			if v_rec.id is not null and v_rec.status = 'failed' then
				v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
					v_change.surface_id, v_target_ids, '{}'::text[], v_user_id, true, true
				);
			end if;
			if v_rec.id is not null and v_rec.status in ('queued', 'running') then
				v_deferred_for_reconcile := true;
			end if;
		end if;
		if not v_deferred_for_reconcile then
			update public.qorpera_surface_changes
			set
				status = 'merging',
				conflict_paths = null,
				approved_by_user_id = v_user_id
			where id = any(v_target_ids)
				and session_id = v_change.session_id
				and status in ('staged', 'conflicted');

			insert into public.qorpera_surface_jobs(
				profile_id, surface_id, session_id, kind, payload, requested_by_user_id
			)
			values (
				v_change.profile_id, v_change.surface_id, v_change.session_id, 'land_change',
				jsonb_build_object('changeIds', to_jsonb(v_target_ids), 'autoPublish', v_surface.auto_publish),
				v_user_id
			);
		end if;$new$,
$old$	update public.qorpera_member_surface_state
	set toggled_change_ids = array(
		select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_target_ids))
	)
	where surface_id = v_change.surface_id;$old$,
$new$	if not v_deferred_for_reconcile then
		update public.qorpera_member_surface_state
		set toggled_change_ids = array(
			select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_target_ids))
		)
		where surface_id = v_change.surface_id;
	end if;$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_approve_session_all(uuid)'::regprocedure,
	array[
$old$	v_needs_worker boolean := false;
	v_merged_count integer;
	v_last_sha text;
begin$old$,
$new$	v_needs_worker boolean := false;
	v_merged_count integer;
	v_last_sha text;
	v_deferred_for_reconcile boolean := false;
	v_rec public.qorpera_surface_reconciliations%rowtype;
begin$new$,
$old$	if cardinality(v_change_ids) > 0 and coalesce(v_needs_worker, false) then
		update public.qorpera_surface_changes
		set status = 'merging', conflict_paths = null, approved_by_user_id = v_user_id
		where id = any(v_change_ids);

		insert into public.qorpera_surface_jobs(
			profile_id, surface_id, session_id, kind, payload, requested_by_user_id
		)
		values (
			v_session.profile_id, v_session.surface_id, p_session_id, 'land_change',
			jsonb_build_object('changeIds', to_jsonb(v_change_ids), 'autoPublish', v_surface.auto_publish),
			v_user_id
		);$old$,
$new$	if cardinality(v_change_ids) > 0 and coalesce(v_needs_worker, false) then
		if public.qorpera_surface_needs_standalone_reconciliation(v_surface, v_change_ids) then
			v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
				v_session.surface_id, v_change_ids, '{}'::text[], v_user_id, true, false
			);
			if v_rec.id is not null and v_rec.status = 'failed' then
				v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
					v_session.surface_id, v_change_ids, '{}'::text[], v_user_id, true, true
				);
			end if;
			if v_rec.id is not null and v_rec.status in ('queued', 'running') then
				v_deferred_for_reconcile := true;
			end if;
		end if;
		if not v_deferred_for_reconcile then
			update public.qorpera_surface_changes
			set status = 'merging', conflict_paths = null, approved_by_user_id = v_user_id
			where id = any(v_change_ids);

			insert into public.qorpera_surface_jobs(
				profile_id, surface_id, session_id, kind, payload, requested_by_user_id
			)
			values (
				v_session.profile_id, v_session.surface_id, p_session_id, 'land_change',
				jsonb_build_object('changeIds', to_jsonb(v_change_ids), 'autoPublish', v_surface.auto_publish),
				v_user_id
			);
		end if;$new$,
$old$	if cardinality(v_change_ids) > 0 then
		update public.qorpera_member_surface_state
		set toggled_change_ids = array(
			select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_change_ids))
		)
		where surface_id = v_session.surface_id;
	end if;$old$,
$new$	if cardinality(v_change_ids) > 0 and not v_deferred_for_reconcile then
		update public.qorpera_member_surface_state
		set toggled_change_ids = array(
			select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_change_ids))
		)
		where surface_id = v_session.surface_id;
	end if;$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)'::regprocedure,
	array[
$old$	v_salt integer;
	v_row public.qorpera_surface_previews%rowtype;
begin$old$,
$new$	v_salt integer;
	v_initial_status text := 'composing';
	v_row public.qorpera_surface_previews%rowtype;
begin
	if p_surface.source_kind = 'code_repo'
		and p_exploration_session_id is null
		and coalesce(cardinality(p_selected_change_ids), 0) > 0
		and exists (
			select 1
			from public.qorpera_surface_reconciliations r
			where r.surface_id = p_surface.id
				and r.base_fingerprint = public.qorpera_surface_base_fingerprint(p_surface)
				and r.status in ('queued', 'running')
				and r.expires_at > v_now
				and (
					select array_agg(x order by x) from unnest(r.selected_change_ids) as x
				) = (
					select array_agg(y order by y) from unnest(p_selected_change_ids) as y
				)
		) then
		v_initial_status := 'reconciling';
	end if;$new$,
$old$				p_exploration_session_id, 'composing', v_now + interval '24 hours', v_now$old$,
$new$				p_exploration_session_id, v_initial_status, v_now + interval '24 hours', v_now$new$,
$old$				status = case
					when public.qorpera_surface_previews.status = 'failed' then 'composing'
					else public.qorpera_surface_previews.status
				end$old$,
$new$				status = case
					when public.qorpera_surface_previews.status = 'failed' then v_initial_status
					else public.qorpera_surface_previews.status
				end$new$
	]
);

select pg_temp.spl_patch(
	'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
	array[
$old$	v_reconcile_summary text;
	v_conflict_paths text[];$old$,
$new$	v_reconcile_summary text;
	v_preview_base_summary text;
	v_conflict_paths text[];$new$,
$old$			if v_session.is_internal and v_session.origin_ref ? 'reconciliationId' then
				v_goal := public.qorpera_surface_utf8_left(
					v_goal || E'\nNon-interactive automatic reconciliation: preserve all compatible changes from every listed change. If two changes directly contradict on the exact same choice, prefer the newer change. Never call coding_ask.',
					2000
				);
			end if;$old$,
$new$			if v_session.is_internal and v_session.origin_ref ? 'reconciliationId' then
				v_goal := public.qorpera_surface_utf8_left(
					v_goal
						|| E'\nNon-interactive automatic reconciliation: preserve all compatible changes from every listed change. If two changes directly contradict on the exact same choice, prefer the newer change. Never call coding_ask.'
						|| case
							when v_session.origin_ref ->> 'chainMode' = 'true'
							then E'\nDependent chain reconciliation: adapt downstream dependent changes so they stay consistent with modifications to their base changes.'
							when jsonb_typeof(v_session.origin_ref -> 'omittedBaseChanges') = 'array'
								and jsonb_array_length(v_session.origin_ref -> 'omittedBaseChanges') > 0
							then E'\nStandalone adaptation: adapt the listed change(s) to work cleanly on main without the omitted preview base changes.'
							else ''
						end,
					2000
				);
			elsif not v_session.is_internal and cardinality(coalesce(v_session.preview_base_change_ids, '{}'::uuid[])) > 0 then
				select string_agg(
					ch.title || case
						when ch.parent_sha is not null and ch.head_sha is not null
						then ' (' || left(ch.parent_sha, 12) || '..' || left(ch.head_sha, 12) || ')'
						when ch.head_sha is not null
						then ' (' || left(ch.head_sha, 12) || ')'
						else ''
					end,
					'; ' order by ch.created_at asc, ch.seq asc, ch.id asc
				) into v_preview_base_summary
				from public.qorpera_surface_changes ch
				where ch.surface_id = v_surface.id
					and ch.id = any(v_session.preview_base_change_ids)
					and ch.status in ('staged', 'conflicted');
				if nullif(v_preview_base_summary, '') is not null then
					v_goal := public.qorpera_surface_utf8_left(
						v_goal || E'\nActive preview changes visible when requested (inspect via git show): ' || v_preview_base_summary,
						2000
					);
				end if;
			end if;$new$
	]
);

revoke all on function
	public.qorpera_surface_normalize_paths(text, text[]),
	public.qorpera_surface_dependent_chain(uuid, uuid[]),
	public.qorpera_surface_preview_turn_context(public.qorpera_surfaces, uuid[]),
	public.qorpera_surface_reconciliation_omitted_bases(uuid, uuid[]),
	public.qorpera_surface_needs_standalone_reconciliation(public.qorpera_surfaces, uuid[]),
	public.qorpera_surface_enqueue_chain_reconciliation(uuid, uuid)
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
			'public.qorpera_start_surface_session(uuid,text,text,text,text,jsonb,integer,text,text[])'::regprocedure,
			'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
			'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
			'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
			'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure,
			'public.qorpera_discard_surface_change(uuid)'::regprocedure,
			'public.qorpera_approve_surface_change(uuid,boolean)'::regprocedure,
			'public.qorpera_approve_session_all(uuid)'::regprocedure,
			'public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Preview lineage function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_normalize_paths(text, text[]), public.qorpera_surface_dependent_chain(uuid, uuid[]), public.qorpera_surface_preview_turn_context(public.qorpera_surfaces, uuid[]), public.qorpera_surface_reconciliation_omitted_bases(uuid, uuid[]), public.qorpera_surface_needs_standalone_reconciliation(public.qorpera_surfaces, uuid[]), public.qorpera_surface_enqueue_chain_reconciliation(uuid, uuid) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join spl_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930890000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.spl_patch(regprocedure, text[]);
drop table spl_before;
