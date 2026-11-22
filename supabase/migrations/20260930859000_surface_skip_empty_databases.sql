set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)') is null
		or to_regclass('public.qorpera_surfaces') is null
		or to_regclass('public.qorpera_folder_entries') is null
		or to_regclass('public.qorpera_company_files') is null then
		raise exception '20260930859000 requires 20260930843000 and 20260928120000';
	end if;
	if to_regprocedure('public.qorpera_company_has_database(uuid)') is not null then
		raise exception '20260930859000 is already applied';
	end if;
end $$;

create temporary table ssed_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function public.qorpera_company_database_toml_path(p_key text, p_path text)
returns boolean
language sql immutable strict parallel safe set search_path = '' as $$
	select p_key >= 'data/' collate "C"
		and p_key < 'data0' collate "C"
		and (p_key collate "C") ~ '^data/[a-z][a-z0-9_]{0,39}/database\.toml$'
		and (split_part(p_path, '/', 2) collate "C") ~ '^[a-z][a-z0-9_]{0,39}$'
		and split_part(p_key, '/', 2) <> 'qorpera'
		and (split_part(p_key, '/', 2) collate "C") !~ '^(pg_|qorpera_)'
$$;

create function public.qorpera_company_has_database(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_company_files f
		join public.qorpera_folder_entries e
			on e.environment_id = f.environment_id
		where f.profile_id = p_company_id
			and f.core = 'folder-v2'
			and e.kind = 'file'
			and e.key_text >= 'data/' collate "C"
			and e.key_text < 'data0' collate "C"
			and public.qorpera_company_database_toml_path(e.key_text, e.path)
	)
$$;

create function pg_temp.ssed_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930859000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930859000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.ssed_patch(
	'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure,
	array[
$old$	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order, created_by_user_id
	)
	values
		(p_company_id, 'inbox', 'Inbox', 'operations', 'ops', 'inbox', 'active', 'mail', 'native_ops', 'none', 100, p_creator_user_id),
		(p_company_id, 'money', 'Money', 'operations', 'ops', 'money', 'active', 'coin', 'native_ops', 'none', 110, p_creator_user_id),
		(p_company_id, 'members', 'Members', 'operations', 'ops', 'members', 'active', 'members', 'native_ops', 'none', 120, p_creator_user_id),
		(p_company_id, 'data', 'Databases', 'operations', 'ops', 'data', 'active', 'database', 'native_ops', 'none', 130, p_creator_user_id),
		(p_company_id, 'files', 'Files', 'operations', 'ops', 'files', 'active', 'drawers', 'native_ops', 'none', 140, p_creator_user_id)
	on conflict (profile_id, slug) do nothing;$old$,
$new$	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order, created_by_user_id
	)
	values
		(p_company_id, 'inbox', 'Inbox', 'operations', 'ops', 'inbox', 'active', 'mail', 'native_ops', 'none', 100, p_creator_user_id),
		(p_company_id, 'money', 'Money', 'operations', 'ops', 'money', 'active', 'coin', 'native_ops', 'none', 110, p_creator_user_id),
		(p_company_id, 'members', 'Members', 'operations', 'ops', 'members', 'active', 'members', 'native_ops', 'none', 120, p_creator_user_id),
		(p_company_id, 'files', 'Files', 'operations', 'ops', 'files', 'active', 'drawers', 'native_ops', 'none', 140, p_creator_user_id)
	on conflict (profile_id, slug) do nothing;

	if public.qorpera_company_has_database(p_company_id) then
		insert into public.qorpera_surfaces(
			profile_id, slug, title, surface_group, archetype, surface_kind,
			status, icon, source_kind, preview_mode, sort_order, created_by_user_id
		)
		values (
			p_company_id, 'data', 'Databases', 'operations', 'ops', 'data',
			'active', 'database', 'native_ops', 'none', 130, p_creator_user_id
		)
		on conflict (profile_id, slug) do nothing;
	end if;$new$
	]
);

create function public.qorpera_ensure_data_surface_on_database_toml()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid;
begin
	if not public.qorpera_surfaces_enabled() then
		return new;
	end if;
	select f.profile_id into v_profile_id
	from public.qorpera_company_files f
	where f.environment_id = new.environment_id
		and f.core = 'folder-v2';
	if v_profile_id is null then
		return new;
	end if;
	-- WHY: Leave unbootstrapped companies at zero rows so SurfacesStore still bootstraps Identity and core ops surfaces.
	if not exists (
		select 1 from public.qorpera_surfaces s
		where s.profile_id = v_profile_id
			and s.status in ('active', 'proposed')
	) then
		return new;
	end if;
	if exists (
		select 1 from public.qorpera_surfaces s
		where s.profile_id = v_profile_id
			and s.slug = 'data'
			and s.status <> 'proposed'
	) then
		return new;
	end if;
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order, created_by_user_id
	)
	values (
		v_profile_id, 'data', 'Databases', 'operations', 'ops', 'data',
		'active', 'database', 'native_ops', 'none', 130, null
	)
	on conflict (profile_id, slug) do update set
		status = 'active',
		updated_at = clock_timestamp()
	where public.qorpera_surfaces.status = 'proposed'
		and public.qorpera_surfaces.archetype = 'ops'
		and public.qorpera_surfaces.surface_kind = 'data';
	return new;
end $$;

create trigger qorpera_folder_entries_ensure_data_surface
	after insert or update of kind, path on public.qorpera_folder_entries
	for each row
	when (
		new.kind = 'file'
		and new.key_text >= 'data/' collate "C"
		and new.key_text < 'data0' collate "C"
		and public.qorpera_company_database_toml_path(new.key_text, new.path)
	)
	execute function public.qorpera_ensure_data_surface_on_database_toml();

create function public.qorpera_prune_empty_data_surfaces()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
	v_deleted integer := 0;
begin
	delete from public.qorpera_surfaces s
	where s.slug = 'data'
		and s.archetype = 'ops'
		and s.surface_kind = 'data'
		and s.source_kind = 'native_ops'
		and s.status = 'active'
		and not public.qorpera_company_has_database(s.profile_id)
		and not exists (
			select 1 from public.qorpera_surface_sessions ss where ss.surface_id = s.id
		)
		and not exists (
			select 1 from public.qorpera_surface_explorations se where se.surface_id = s.id
		)
		and not exists (
			select 1 from public.qorpera_surface_changes sc where sc.surface_id = s.id
		)
		and not exists (
			select 1 from public.qorpera_surface_jobs sj where sj.surface_id = s.id
		)
		and not exists (
			select 1 from public.qorpera_surface_previews sp where sp.surface_id = s.id
		)
		and not exists (
			select 1 from public.qorpera_surface_automations sa
			where sa.profile_id = s.profile_id and sa.target_surface_slug = 'data'
		);
	get diagnostics v_deleted = row_count;
	return v_deleted;
end $$;

revoke all on function public.qorpera_company_database_toml_path(text, text),
	public.qorpera_company_has_database(uuid),
	public.qorpera_ensure_data_surface_on_database_toml(),
	public.qorpera_prune_empty_data_surfaces()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select public.qorpera_prune_empty_data_surfaces();

do $guard$
declare
	v_bootstrap text := pg_get_functiondef('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure);
	v_patched constant regprocedure[] := array[
		'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure
	];
	v_added constant regprocedure[] := array[
		'public.qorpera_company_database_toml_path(text,text)'::regprocedure,
		'public.qorpera_company_has_database(uuid)'::regprocedure,
		'public.qorpera_ensure_data_surface_on_database_toml()'::regprocedure,
		'public.qorpera_prune_empty_data_surfaces()'::regprocedure
	];
begin
	if strpos(v_bootstrap, 'qorpera_company_has_database(p_company_id)') = 0 then
		raise exception '20260930859000 guard failed for qorpera_service_bootstrap_company_surfaces';
	end if;
	if (select count(*) from pg_temp.ssed_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> cardinality(v_patched)
		or exists (select 1 from pg_temp.ssed_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and not (prior.oid = any(v_patched))))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.ssed_before as prior)
			and not (p.oid = any(v_added))) then
		raise exception '20260930859000: catalog changed unexpectedly';
	end if;
end $guard$;

drop function pg_temp.ssed_patch(regprocedure, text[]);
drop table pg_temp.ssed_before;
