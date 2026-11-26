create table public.qorpera_surface_change_files (
	change_id uuid not null references public.qorpera_surface_changes(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	path text collate "C" not null check (public.qorpera_company_path_valid(path)),
	key_text text collate "C" generated always as (public.qorpera_folder_key(path)) stored,
	manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	primary key (change_id, key_text)
);

create index qorpera_surface_change_files_manifest
	on public.qorpera_surface_change_files (profile_id, manifest_sha256);

create index qorpera_surface_change_files_surface
	on public.qorpera_surface_change_files (surface_id);

alter table public.qorpera_surface_change_files enable row level security;
revoke all on public.qorpera_surface_change_files from public, anon, authenticated, service_role;

create or replace function public.qorpera_surface_change_file_company_path(
	p_folder_root text,
	p_op_path text
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
	v_root text := btrim(btrim(coalesce(p_folder_root, '')), '/');
	v_norm text := btrim(btrim(coalesce(p_op_path, '')), '/');
	v_candidate text;
begin
	if v_root = '' or v_norm = '' or not public.qorpera_company_path_valid(v_root) then
		return null;
	end if;
	v_candidate := case
		when v_norm = v_root or starts_with(v_norm, v_root || '/') then v_norm
		else v_root || '/' || v_norm
	end;
	if not starts_with(v_candidate, v_root || '/') then
		return null;
	end if;
	if not public.qorpera_company_path_valid(v_candidate) then
		return null;
	end if;
	return v_candidate;
end $$;

revoke all on function public.qorpera_surface_change_file_company_path(text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_enqueue_surface_change_gc(
	p_profile_ids uuid[],
	p_manifests text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if coalesce(cardinality(p_manifests), 0) = 0 then
		return;
	end if;
	insert into public.qorpera_folder_object_gc (profile_id, sha256, unreferenced_since)
	select hash.profile_id, hash.sha256, clock_timestamp()
	from (
		select g.profile_id, g.manifest_sha256 as sha256
		from unnest(p_profile_ids, p_manifests) as g(profile_id, manifest_sha256)
		union
		select chunk.profile_id, chunk.chunk_sha256
		from unnest(p_profile_ids, p_manifests) as g(profile_id, manifest_sha256)
		join public.qorpera_folder_file_chunks as chunk
			on chunk.profile_id = g.profile_id
			and chunk.manifest_sha256 = g.manifest_sha256
	) as hash
	where public.qorpera_folder_gc_company(hash.profile_id)
		and exists (
			select 1
			from public.qorpera_profile_objects as obj
			where obj.profile_id = hash.profile_id
				and obj.sha256 = hash.sha256
		)
		and not public.qorpera_folder_object_rooted(hash.profile_id, hash.sha256)
	order by hash.profile_id, hash.sha256 collate "C"
	on conflict (profile_id, sha256) do update
	set unreferenced_since = greatest(
		public.qorpera_folder_object_gc.unreferenced_since,
		excluded.unreferenced_since
	);
end $$;

revoke all on function public.qorpera_enqueue_surface_change_gc(uuid[], text[])
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_sync_surface_change_files(p_change_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_desired_profiles uuid[];
	v_desired_surfaces uuid[];
	v_desired_paths text[];
	v_desired_manifests text[];
	v_profile_id uuid;
	v_needed_hashes text[];
	v_locked_count integer;
	v_removed_profiles uuid[];
	v_removed_manifests text[];
begin
	select
		array_agg(latest.profile_id),
		array_agg(latest.surface_id),
		array_agg(latest.company_path),
		array_agg(latest.manifest_sha256)
	into
		v_desired_profiles,
		v_desired_surfaces,
		v_desired_paths,
		v_desired_manifests
	from (
		select distinct on (public.qorpera_folder_key(resolved.company_path))
			c.profile_id,
			c.surface_id,
			resolved.company_path,
			elem.op ->> 'op' as op_kind,
			elem.op -> 'file' ->> 'manifestSha256' as manifest_sha256
		from public.qorpera_surface_changes c
		join public.qorpera_surfaces s
			on s.id = c.surface_id
			and s.profile_id = c.profile_id
		cross join lateral jsonb_array_elements(c.patch_manifest) with ordinality as elem(op, ord)
		cross join lateral (
			select public.qorpera_surface_change_file_company_path(s.folder_root, elem.op ->> 'path') as company_path
		) resolved
		where c.id = p_change_id
			and c.kind = 'folder_patch'
			and c.status in ('staged', 'merging', 'conflicted')
			and jsonb_typeof(c.patch_manifest) = 'array'
			and resolved.company_path is not null
		order by public.qorpera_folder_key(resolved.company_path), elem.ord desc
	) latest
	where latest.op_kind = 'write_file'
		and coalesce(latest.manifest_sha256, '') ~ '^[0-9a-f]{64}$';

	-- WHY: Enforce G1/G3 by taking FOR KEY SHARE on newly rooted manifest and chunk rows and refusing absent or deleting objects.
	if coalesce(cardinality(v_desired_manifests), 0) > 0 then
		v_profile_id := v_desired_profiles[1];
		select array_agg(h.sha256 order by h.sha256 collate "C")
		into v_needed_hashes
		from (
			select distinct m as sha256
			from unnest(v_desired_manifests) as m
			union
			select distinct chunk.chunk_sha256
			from unnest(v_desired_manifests) as m
			join public.qorpera_folder_file_chunks as chunk
				on chunk.profile_id = v_profile_id
				and chunk.manifest_sha256 = m
		) h;

		select count(*)::integer
		into v_locked_count
		from (
			select o.sha256
			from public.qorpera_profile_objects o
			where o.profile_id = v_profile_id
				and o.sha256 = any(v_needed_hashes)
			order by o.sha256 collate "C"
			for key share
		) locked;

		if v_locked_count <> cardinality(v_needed_hashes) then
			raise exception 'Staged surface file object is unavailable' using errcode = '42501';
		end if;

		if exists (
			select 1
			from unnest(v_needed_hashes) as sha256
			where public.qorpera_folder_object_marked(v_profile_id, sha256)
		) then
			perform public.qorpera_folder_object_collecting();
		end if;
	end if;

	with gone as (
		delete from public.qorpera_surface_change_files
		where change_id = p_change_id
		returning profile_id, manifest_sha256
	)
	select
		array_agg(distinct_gone.profile_id),
		array_agg(distinct_gone.manifest_sha256)
	into v_removed_profiles, v_removed_manifests
	from (
		select distinct g.profile_id, g.manifest_sha256
		from gone g
		where not (
			g.profile_id = coalesce(v_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
			and g.manifest_sha256 = any(coalesce(v_desired_manifests, '{}'::text[]))
		)
	) distinct_gone;

	if coalesce(cardinality(v_desired_manifests), 0) > 0 then
		insert into public.qorpera_surface_change_files (
			change_id,
			profile_id,
			surface_id,
			path,
			manifest_sha256
		)
		select
			p_change_id,
			d.profile_id,
			d.surface_id,
			d.path,
			d.manifest_sha256
		from unnest(
			v_desired_profiles,
			v_desired_surfaces,
			v_desired_paths,
			v_desired_manifests
		) as d(profile_id, surface_id, path, manifest_sha256);
	end if;

	perform public.qorpera_enqueue_surface_change_gc(v_removed_profiles, v_removed_manifests);
end $$;

revoke all on function public.qorpera_sync_surface_change_files(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_surface_changes_sync_files_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform public.qorpera_sync_surface_change_files(new.id);
	return null;
end $$;

revoke all on function public.qorpera_surface_changes_sync_files_trigger()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create trigger qorpera_surface_changes_sync_files
	after insert or update of status, kind, patch_manifest, surface_id, profile_id
	on public.qorpera_surface_changes
	for each row
	execute function public.qorpera_surface_changes_sync_files_trigger();

create or replace function public.qorpera_surface_changes_release_files_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_removed_profiles uuid[];
	v_removed_manifests text[];
begin
	if public.qorpera_company_purge_active() then
		return old;
	end if;
	with gone as (
		delete from public.qorpera_surface_change_files
		where change_id = old.id
		returning profile_id, manifest_sha256
	)
	select
		array_agg(distinct_gone.profile_id),
		array_agg(distinct_gone.manifest_sha256)
	into v_removed_profiles, v_removed_manifests
	from (
		select distinct g.profile_id, g.manifest_sha256
		from gone g
	) distinct_gone;

	perform public.qorpera_enqueue_surface_change_gc(v_removed_profiles, v_removed_manifests);
	return old;
end $$;

revoke all on function public.qorpera_surface_changes_release_files_trigger()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create trigger qorpera_surface_changes_release_files
	before delete
	on public.qorpera_surface_changes
	for each row
	execute function public.qorpera_surface_changes_release_files_trigger();

create or replace function public.qorpera_surfaces_sync_change_files_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_change_id uuid;
begin
	for v_change_id in
		select c.id
		from public.qorpera_surface_changes c
		where c.surface_id = new.id
			and c.kind = 'folder_patch'
			and c.status in ('staged', 'merging', 'conflicted')
	loop
		perform public.qorpera_sync_surface_change_files(v_change_id);
	end loop;
	return null;
end $$;

revoke all on function public.qorpera_surfaces_sync_change_files_trigger()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create trigger qorpera_surfaces_sync_change_files
	after update of folder_root
	on public.qorpera_surfaces
	for each row
	when (old.folder_root is distinct from new.folder_root)
	execute function public.qorpera_surfaces_sync_change_files_trigger();

do $$
declare
	v_change_id uuid;
begin
	for v_change_id in
		select c.id
		from public.qorpera_surface_changes c
		where c.kind = 'folder_patch'
			and c.status in ('staged', 'merging', 'conflicted')
	loop
		perform public.qorpera_sync_surface_change_files(v_change_id);
	end loop;
end $$;

-- WHY: Returning 'historical' keeps viaActive=false so gateway rechecks staged changes after discard without active-fence caching.
create or replace function public.qorpera_folder_object_readable_state(
	p_environment_id uuid,
	p_profile_id uuid,
	p_auth jsonb,
	p_sha256 text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_code_host boolean := coalesce(p_auth -> 'view' ->> 'kind' = 'code_host', false);
	v_state text;
begin
	with rules as materialized (
		select r.rkey collate "C" as rkey,
			r.rkey_prefix collate "C" as rkey_prefix,
			r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed
		from public.qorpera_folder_actor_rules(p_environment_id, p_profile_id, p_auth, 'read') r
	),
	has_allowed as materialized (
		select exists (select 1 from rules r where r.allowed and not r.is_shared) as ok
	),
	manifests as materialized (
		select p_sha256 as manifest
		union
		select c.manifest_sha256
		from public.qorpera_folder_file_chunks c
		where c.profile_id = p_profile_id and c.chunk_sha256 = p_sha256
	)
	select case
		when not (select ok from has_allowed) then 'none'
		else coalesce(
			(
				select case
					when cov.scope in ('company_shared', 'company_rules', 'member_private')
						and not (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C" and position('/repo.git/objects/' in e.key_text) > 0)
					then 'active_fenceable'
					else 'active'
				end
				from manifests m
				join public.qorpera_folder_entries e
					on e.environment_id = p_environment_id and e.kind = 'file' and e.manifest_sha256 = m.manifest
				cross join lateral (
					select r.scope, r.owner_user_id, r.is_shared, r.allowed
					from rules r
					where r.rkey = e.key_text
						or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
					order by r.rkey_len desc, r.resource_id
					limit 1
				) cov
				where (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
					and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
					and cov.allowed and not cov.is_shared
					and not (
						split_part(e.key_text, '/', 1) = 'members'
						and split_part(e.key_text, '/', 3) = 'private'
						and (cov.scope is distinct from 'member_private'
							or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
					)
				limit 1
			),
			case
				when exists (
					select 1
					from manifests m
					join public.qorpera_folder_path_versions v
						on v.environment_id = p_environment_id and v.manifest_sha256 is not null and v.manifest_sha256 = m.manifest
					cross join lateral (select public.qorpera_folder_key(v.path) collate "C" as k) vk
					cross join lateral (
						select r.scope, r.owner_user_id, r.is_shared, r.allowed
						from rules r
						where r.rkey = vk.k
							or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(vk.k, r.rkey_prefix)))
						order by r.rkey_len desc, r.resource_id
						limit 1
					) cov
					where (not v_code_host or vk.k = 'code' or (vk.k >= 'code/' collate "C" and vk.k < 'code0' collate "C"))
						and split_part(vk.k, '/', 1) not in ('credentials', 'secrets')
						and cov.allowed and not cov.is_shared
						and not (
							split_part(vk.k, '/', 1) = 'members'
							and split_part(vk.k, '/', 3) = 'private'
							and (cov.scope is distinct from 'member_private'
								or cov.owner_user_id::text is distinct from split_part(vk.k, '/', 2))
						)
				) then 'historical'
				when exists (
					select 1
					from manifests m
					join public.qorpera_folder_conflict_copies k
						on k.environment_id = p_environment_id and k.manifest_sha256 = m.manifest
					cross join lateral (
						select r.scope, r.owner_user_id, r.is_shared, r.allowed
						from rules r
						where r.rkey = k.key_text
							or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(k.key_text, r.rkey_prefix)))
						order by r.rkey_len desc, r.resource_id
						limit 1
					) cov
					where (not v_code_host or k.key_text = 'code' or (k.key_text >= 'code/' collate "C" and k.key_text < 'code0' collate "C"))
						and split_part(k.key_text, '/', 1) not in ('credentials', 'secrets')
						and cov.allowed and not cov.is_shared
						and not (
							split_part(k.key_text, '/', 1) = 'members'
							and split_part(k.key_text, '/', 3) = 'private'
							and (cov.scope is distinct from 'member_private'
								or cov.owner_user_id::text is distinct from split_part(k.key_text, '/', 2))
						)
				) then 'historical'
				when exists (
					select 1
					from manifests m
					join public.qorpera_company_files f
						on f.environment_id = p_environment_id and f.profile_id = p_profile_id and f.core = 'folder-v2'
					join public.qorpera_surface_change_files scf
						on scf.profile_id = p_profile_id and scf.manifest_sha256 = m.manifest
					cross join lateral (
						select r.scope, r.owner_user_id, r.is_shared, r.allowed
						from rules r
						where r.rkey = scf.key_text
							or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(scf.key_text, r.rkey_prefix)))
						order by r.rkey_len desc, r.resource_id
						limit 1
					) cov
					where (not v_code_host or scf.key_text = 'code' or (scf.key_text >= 'code/' collate "C" and scf.key_text < 'code0' collate "C"))
						and split_part(scf.key_text, '/', 1) not in ('credentials', 'secrets')
						and cov.allowed and not cov.is_shared
						and not (
							split_part(scf.key_text, '/', 1) = 'members'
							and split_part(scf.key_text, '/', 3) = 'private'
							and (cov.scope is distinct from 'member_private'
								or cov.owner_user_id::text is distinct from split_part(scf.key_text, '/', 2))
						)
				) then 'historical'
				else 'none'
			end
		)
	end
	into v_state;
	return coalesce(v_state, 'none');
end $$;

revoke all on function public.qorpera_folder_object_readable_state(uuid, uuid, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_folder_object_rooted(
	p_profile_id uuid,
	p_sha256 text,
	p_except_intent uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
			select 1 from (select p_sha256 as manifest
				union
				select c.manifest_sha256 from public.qorpera_folder_file_chunks c
				where c.profile_id = p_profile_id and c.chunk_sha256 = p_sha256) m
			join public.qorpera_company_files f on f.profile_id = p_profile_id and f.core = 'folder-v2'
			where exists (select 1 from public.qorpera_folder_entries e
					where e.environment_id = f.environment_id and e.kind = 'file' and e.manifest_sha256 = m.manifest)
				or exists (select 1 from public.qorpera_folder_path_versions v
					where v.environment_id = f.environment_id and v.manifest_sha256 = m.manifest)
				or exists (select 1 from public.qorpera_folder_conflict_copies k
					where k.environment_id = f.environment_id and k.manifest_sha256 = m.manifest)
				or exists (select 1 from public.qorpera_folder_proposal_paths q
					where q.environment_id = f.environment_id and q.manifest_sha256 = m.manifest)
				or exists (select 1 from public.qorpera_surface_change_files scf
					where scf.profile_id = p_profile_id and scf.manifest_sha256 = m.manifest))
		or exists (select 1 from public.qorpera_folder_upload_intent_objects o
			join public.qorpera_folder_upload_intents i on i.id = o.intent_id
			where o.profile_id = p_profile_id and o.sha256 = p_sha256
				and i.expires_at > clock_timestamp() - interval '24 hours'
				and i.id is distinct from p_except_intent)
$$;
