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
	v_raw text := coalesce(p_op_path, '');
	v_rooted boolean;
	v_body text;
	v_root text;
	v_candidate text;
begin
	if v_raw = '' then
		return null;
	end if;
	v_rooted := left(v_raw, 1) = '/';
	v_body := case when v_rooted then substr(v_raw, 2) else v_raw end;
	if v_body = '' then
		return null;
	end if;
	if v_rooted then
		v_candidate := v_body;
	else
		v_root := btrim(coalesce(p_folder_root, ''), '/');
		if v_root = '' then
			return null;
		end if;
		v_candidate := v_root || '/' || v_body;
	end if;
	if not public.qorpera_company_path_valid(v_candidate) then
		return null;
	end if;
	return v_candidate;
end $$;

revoke all on function public.qorpera_surface_change_file_company_path(text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_sync_surface_change_files(p_change_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	delete from public.qorpera_surface_change_files
	where change_id = p_change_id;

	insert into public.qorpera_surface_change_files (
		change_id,
		profile_id,
		surface_id,
		path,
		manifest_sha256
	)
	select
		latest.change_id,
		latest.profile_id,
		latest.surface_id,
		latest.company_path,
		latest.manifest_sha256
	from (
		select distinct on (public.qorpera_folder_key(resolved.company_path))
			c.id as change_id,
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
