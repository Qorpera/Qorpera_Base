set local lock_timeout = '3s';

do $$ begin
	if exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_surfaces'
			and column_name = 'repository_subpath'
	) then
		raise exception '20260930934000_surface_repo_subpath_and_branch is already applied';
	end if;
	if to_regclass('public.qorpera_surfaces') is null
		or to_regclass('public.qorpera_code_repositories') is null
		or to_regclass('public.qorpera_code_requests') is null
		or to_regclass('public.qorpera_coding_sessions') is null
		or to_regprocedure('public.qorpera_create_surface(uuid,text,text,text,text,text,text,text,text,boolean)') is null
		or to_regprocedure('public.qorpera_propose_surface(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_native_surface_propose(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_surface_summary_json(public.qorpera_surfaces)') is null
		or to_regprocedure('public.qorpera_surface_describe_company_senses(uuid)') is null
		or to_regprocedure('public.qorpera_native_list_company_interfaces(jsonb)') is null
		or to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)') is null then
		raise exception '20260930934000 requires earlier surface and code repository migrations first';
	end if;
end $$;

create function public.qorpera_surface_repository_key_valid(p_key text)
returns boolean
language sql immutable set search_path = '' as $$
	select coalesce(
		p_key is not null
		and strpos(p_key, '/') > 0
		and split_part(p_key, '/', 3) = ''
		and split_part(p_key, '/', 1) ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'
		and split_part(p_key, '/', 2) ~ '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$'
		and split_part(p_key, '/', 2) not in ('.', '..')
		and left(split_part(p_key, '/', 2), 1) <> '.'
		and lower(right(split_part(p_key, '/', 2), 4)) <> '.git',
		false
	)
$$;

create function public.qorpera_surface_normalize_subpath(p_subpath text)
returns text
language plpgsql immutable set search_path = '' as $$
declare
	v_clean text := btrim(coalesce(p_subpath, ''), E' \t\r\n/');
begin
	if v_clean = '' or v_clean = '.' then
		return null;
	end if;
	return v_clean;
end $$;

create function public.qorpera_surface_repository_subpath_valid(p_subpath text)
returns boolean
language sql immutable set search_path = '' as $$
	select coalesce(
		p_subpath is not null
		and octet_length(p_subpath) between 1 and 240
		and left(p_subpath, 1) <> '/'
		and right(p_subpath, 1) <> '/'
		and strpos(p_subpath, '//') = 0
		and strpos(p_subpath, E'\\') = 0
		and not exists (
			select 1
			from unnest(string_to_array(p_subpath, '/')) as seg
			where seg = ''
				or seg in ('.', '..')
				or seg !~ '^[A-Za-z0-9_][A-Za-z0-9._-]*$'
		),
		false
	)
$$;

create function public.qorpera_surface_default_branch_valid(p_branch text)
returns boolean
language sql immutable set search_path = '' as $$
	select coalesce(
		p_branch is not null
		and octet_length(p_branch) between 1 and 128
		and p_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'
		and lower(p_branch) <> 'qorpera'
		and lower(p_branch) not like 'qorpera/%'
		and strpos(p_branch, '..') = 0
		and strpos(p_branch, '//') = 0
		and strpos(p_branch, '@{') = 0
		and right(p_branch, 1) not in ('/', '.')
		and right(p_branch, 5) <> '.lock'
		and not exists (
			select 1
			from unnest(string_to_array(p_branch, '/')) as part
			where part = ''
				or left(part, 1) = '.'
				or right(part, 1) = '.'
				or right(part, 5) = '.lock'
		),
		false
	)
$$;

revoke all on function
	public.qorpera_surface_repository_key_valid(text),
	public.qorpera_surface_normalize_subpath(text),
	public.qorpera_surface_repository_subpath_valid(text),
	public.qorpera_surface_default_branch_valid(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_surfaces
	add column repository_subpath text
		check (repository_subpath is null or public.qorpera_surface_repository_subpath_valid(repository_subpath)),
	add column default_branch text not null default 'main'
		check (public.qorpera_surface_default_branch_valid(default_branch));

create temp table srsb_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
		'public.qorpera_surface_describe_company_senses(uuid)'::regprocedure,
		'public.qorpera_native_list_company_interfaces(jsonb)'::regprocedure,
		'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure
	]);

create function pg_temp.srsb_apply(p_def text, p_label text, p_pairs text[])
returns text language plpgsql as $$
declare
	v_def text := p_def;
	v_found integer;
begin
	for i in 1..cardinality(p_pairs) / 2 loop
		v_found := (length(v_def) - length(replace(v_def, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930934000 anchor found % time(s) in %, expected 1: %',
				v_found, p_label, left(p_pairs[2 * i - 1], 120);
		end if;
		v_def := replace(v_def, p_pairs[2 * i - 1], p_pairs[2 * i]);
	end loop;
	return v_def;
end $$;

create function pg_temp.srsb_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
begin
	execute pg_temp.srsb_apply(pg_get_functiondef(p_target), p_target::text, p_pairs);
end $$;

select pg_temp.srsb_patch(
	'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
	array[
$old$		'repositoryKey', p_surface.repository_key,$old$,
$new$		'repositoryKey', p_surface.repository_key,
		'repositorySubpath', p_surface.repository_subpath,
		'defaultBranch', p_surface.default_branch,$new$
	]
);

select pg_temp.srsb_patch(
	'public.qorpera_surface_describe_company_senses(uuid)'::regprocedure,
	array[
$old$						'repositoryKey', s.repository_key,$old$,
$new$						'repositoryKey', s.repository_key,
						'repositorySubpath', s.repository_subpath,
						'defaultBranch', s.default_branch,$new$
	]
);

select pg_temp.srsb_patch(
	'public.qorpera_native_list_company_interfaces(jsonb)'::regprocedure,
	array[
$old$					'repositoryKey', s.repository_key,$old$,
$new$					'repositoryKey', s.repository_key,
					'repositorySubpath', s.repository_subpath,
					'defaultBranch', s.default_branch,$new$,
$old$				select slug, title, surface_kind, archetype, source_kind, folder_root, repository_key, brief_summary, is_global, sort_order, created_at$old$,
$new$				select slug, title, surface_kind, archetype, source_kind, folder_root, repository_key, repository_subpath, default_branch, brief_summary, is_global, sort_order, created_at$new$
	]
);

select pg_temp.srsb_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$		'repositoryKey', v_surface.repository_key,$old$,
$new$		'repositoryKey', v_surface.repository_key,
		'repositorySubpath', v_surface.repository_subpath,
		'defaultBranch', v_surface.default_branch,$new$
	]
);

select pg_temp.srsb_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$					'repositoryKey', surf.repository_key,
					'folderRoot', surf.folder_root,
					'surfaceSlug', surf.slug,$old$,
$new$					'repositoryKey', surf.repository_key,
					'repositorySubpath', surf.repository_subpath,
					'defaultBranch', surf.default_branch,
					'folderRoot', surf.folder_root,
					'surfaceSlug', surf.slug,$new$,
$old$					'repositoryKey', surf.repository_key,
					'leaseToken', p.lease_token,$old$,
$new$					'repositoryKey', surf.repository_key,
					'repositorySubpath', surf.repository_subpath,
					'defaultBranch', surf.default_branch,
					'leaseToken', p.lease_token,$new$,
$old$				'sourceKind', surf.source_kind,
				'repositoryKey', surf.repository_key,
				'folderRoot', surf.folder_root,$old$,
$new$				'sourceKind', surf.source_kind,
				'repositoryKey', surf.repository_key,
				'repositorySubpath', surf.repository_subpath,
				'defaultBranch', surf.default_branch,
				'folderRoot', surf.folder_root,$new$,
$old$				'folderRoot', surf.folder_root,
				'repositoryKey', surf.repository_key,
				'siteId', surf.site_id,$old$,
$new$				'folderRoot', surf.folder_root,
				'repositoryKey', surf.repository_key,
				'repositorySubpath', surf.repository_subpath,
				'defaultBranch', surf.default_branch,
				'siteId', surf.site_id,$new$
	]
);

select pg_temp.srsb_patch(
	'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	array[
$old$						select 1 from public.qorpera_surfaces surf
						where surf.profile_id = p_profile_id
							and surf.source_kind = 'code_repo'
							and surf.status <> 'archived'$old$,
$new$						select 1 from public.qorpera_surfaces surf
						where surf.profile_id = p_profile_id
							and surf.source_kind = 'code_repo'
							and surf.status <> 'archived'
							and surf.repository_subpath is null$new$
	]
);

drop function public.qorpera_create_surface(uuid, text, text, text, text, text, text, text, text, boolean);
create function public.qorpera_create_surface(
	p_company_id uuid,
	p_title text,
	p_slug text default null,
	p_archetype text default 'live_build',
	p_kind text default 'custom',
	p_icon text default 'globe',
	p_accent_hex text default null,
	p_folder_root text default null,
	p_brief_summary text default null,
	p_is_global boolean default false,
	p_repository_key text default null,
	p_repository_subpath text default null,
	p_default_branch text default 'main'
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid;
	v_title text := btrim(coalesce(p_title, ''));
	v_slug text;
	v_base_slug text;
	v_suffix integer := 1;
	v_source_kind text;
	v_preview_mode text;
	v_folder_root text;
	v_repo_key text := lower(nullif(btrim(coalesce(p_repository_key, '')), ''));
	v_repo_subpath text := public.qorpera_surface_normalize_subpath(p_repository_subpath);
	v_default_branch text := coalesce(nullif(btrim(coalesce(p_default_branch, '')), ''), 'main');
	v_sort_order integer;
	v_surface public.qorpera_surfaces%rowtype;
begin
	v_user_id := public.qorpera_assert_surface_member(p_company_id, true);
	if char_length(v_title) < 1 or char_length(v_title) > 80 then
		raise exception 'Title must be 1..80 characters' using errcode = '22023';
	end if;
	if p_archetype not in ('live_build', 'studio', 'ops') then
		raise exception 'Invalid archetype' using errcode = '22023';
	end if;
	if p_archetype <> 'live_build' then
		if v_repo_key is not null or v_repo_subpath is not null then
			raise exception 'Only live build surfaces can bind a code repository' using errcode = '22023';
		end if;
		v_default_branch := 'main';
	else
		if v_repo_key is not null and not public.qorpera_surface_repository_key_valid(v_repo_key) then
			raise exception 'Invalid repositoryKey' using errcode = '22023';
		end if;
		if v_repo_subpath is not null and not public.qorpera_surface_repository_subpath_valid(v_repo_subpath) then
			raise exception 'Invalid repositorySubpath' using errcode = '22023';
		end if;
		if not public.qorpera_surface_default_branch_valid(v_default_branch) then
			raise exception 'Invalid defaultBranch' using errcode = '22023';
		end if;
	end if;

	v_base_slug := lower(regexp_replace(coalesce(nullif(btrim(coalesce(p_slug, '')), ''), v_title), '[^a-zA-Z0-9]+', '-', 'g'));
	v_base_slug := left(btrim(v_base_slug, '-'), 56);
	if v_base_slug = '' then
		v_base_slug := 'surface';
	end if;
	v_slug := v_base_slug;
	while exists (select 1 from public.qorpera_surfaces where profile_id = p_company_id and slug = v_slug) loop
		v_suffix := v_suffix + 1;
		v_slug := left(v_base_slug, 52) || '-' || v_suffix::text;
	end loop;

	v_source_kind := case
		when p_archetype = 'ops' then 'native_ops'
		when p_archetype = 'studio' then 'folder'
		else 'code_repo'
	end;
	v_preview_mode := case
		when p_archetype = 'ops' then 'none'
		when p_archetype = 'studio' then 'studio_overlay'
		else 'static_site'
	end;
	v_folder_root := case
		when p_archetype = 'studio' then coalesce(nullif(btrim(coalesce(p_folder_root, ''), '/ '), ''), v_slug)
		else nullif(btrim(coalesce(p_folder_root, ''), '/ '), '')
	end;
	if p_archetype = 'live_build' and v_repo_key is null then
		v_repo_key := 'surfaces/' || v_slug;
	end if;
	if p_archetype = 'live_build'
		and v_repo_key is distinct from 'surfaces/' || v_slug
		and coalesce(public.qorpera_member_role(p_company_id)::text, '') not in ('owner', 'admin') then
		raise exception 'Only founders and admins can bind an existing code repository' using errcode = '42501';
	end if;

	select coalesce(max(sort_order), 0) + 10 into v_sort_order
	from public.qorpera_surfaces
	where profile_id = p_company_id and surface_group = case when p_archetype = 'ops' then 'operations' else 'products' end;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, accent_hex, is_global,
		status, icon, source_kind, repository_key, repository_subpath, default_branch, folder_root,
		preview_mode, brief_summary, sort_order, created_by_user_id
	)
	values (
		p_company_id, v_slug, v_title,
		case when p_archetype = 'ops' then 'operations' else 'products' end,
		p_archetype, coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'custom'),
		nullif(btrim(coalesce(p_accent_hex, '')), ''),
		coalesce(p_is_global, false) or p_kind = 'identity',
		'active', coalesce(nullif(btrim(coalesce(p_icon, '')), ''), 'globe'),
		v_source_kind,
		v_repo_key,
		case when p_archetype = 'live_build' then v_repo_subpath else null end,
		v_default_branch,
		v_folder_root, v_preview_mode,
		nullif(btrim(coalesce(p_brief_summary, '')), ''),
		v_sort_order, v_user_id
	)
	returning * into v_surface;

	if v_surface.archetype = 'live_build' and v_surface.site_id is null then
		perform public.qorpera_surface_ensure_site(v_surface.id);
		select * into v_surface from public.qorpera_surfaces where id = v_surface.id;
	end if;

	return public.qorpera_surface_summary_json(v_surface);
end $$;

do $$
declare
	v_def text;
begin
	v_def := pg_get_functiondef('public.qorpera_propose_surface(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)'::regprocedure);
	v_def := pg_temp.srsb_apply(v_def, 'qorpera_propose_surface', array[
		'p_is_global boolean DEFAULT false, p_activate_immediately boolean DEFAULT false)',
		'p_is_global boolean DEFAULT false, p_activate_immediately boolean DEFAULT false, p_repository_subpath text DEFAULT NULL::text, p_default_branch text DEFAULT ''main''::text)',
$old$	v_repo_key text := nullif(btrim(coalesce(p_repository_key, '')), '');
	v_folder_root text := nullif(btrim(coalesce(p_folder_root, ''), '/ '), '');
	v_status text := case when coalesce(p_activate_immediately, false) then 'active' else 'proposed' end;
begin
	if p_archetype = 'live_build' and v_repo_key is null and v_slug <> '' then
		v_repo_key := 'surfaces/' || v_slug;
	end if;$old$,
$new$	v_repo_key text := lower(nullif(btrim(coalesce(p_repository_key, '')), ''));
	v_repo_subpath text := public.qorpera_surface_normalize_subpath(p_repository_subpath);
	v_default_branch text := coalesce(nullif(btrim(coalesce(p_default_branch, '')), ''), 'main');
	v_folder_root text := nullif(btrim(coalesce(p_folder_root, ''), '/ '), '');
	v_status text := case when coalesce(p_activate_immediately, false) then 'active' else 'proposed' end;
begin
	if p_archetype = 'live_build' and v_repo_key is null and v_slug <> '' then
		v_repo_key := 'surfaces/' || v_slug;
	end if;
	if p_source_kind = 'code_repo' or p_archetype = 'live_build' then
		if v_repo_key is not null and not public.qorpera_surface_repository_key_valid(v_repo_key) then
			raise exception 'Invalid repositoryKey' using errcode = '22023';
		end if;
		if v_repo_subpath is not null and not public.qorpera_surface_repository_subpath_valid(v_repo_subpath) then
			raise exception 'Invalid repositorySubpath' using errcode = '22023';
		end if;
		if not public.qorpera_surface_default_branch_valid(v_default_branch) then
			raise exception 'Invalid defaultBranch' using errcode = '22023';
		end if;
	else
		v_repo_subpath := null;
		v_default_branch := 'main';
	end if;$new$,
$old$		status, icon, source_kind, repository_key, folder_root, preview_mode, brief_summary$old$,
$new$		status, icon, source_kind, repository_key, repository_subpath, default_branch, folder_root, preview_mode, brief_summary$new$,
$old$		p_source_kind, v_repo_key, v_folder_root, coalesce(p_preview_mode, 'none'), p_brief_summary$old$,
$new$		p_source_kind, v_repo_key, v_repo_subpath, v_default_branch, v_folder_root, coalesce(p_preview_mode, 'none'), p_brief_summary$new$
	]);
	drop function public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_native_surface_propose(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)'::regprocedure);
	v_def := pg_temp.srsb_apply(v_def, 'qorpera_native_surface_propose', array[
		'p_is_global boolean DEFAULT false, p_activate_immediately boolean DEFAULT false)',
		'p_is_global boolean DEFAULT false, p_activate_immediately boolean DEFAULT false, p_repository_subpath text DEFAULT NULL::text, p_default_branch text DEFAULT ''main''::text)',
$old$		p_kind, p_accent_hex, p_is_global, p_activate_immediately
	);$old$,
$new$		p_kind, p_accent_hex, p_is_global, p_activate_immediately, p_repository_subpath, p_default_branch
	);$new$
	]);
	drop function public.qorpera_native_surface_propose(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean);
	execute v_def;
end $$;

create function public.qorpera_list_company_code_repositories(p_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	perform public.qorpera_assert_surface_member(p_company_id, false);
	return coalesce(
		(
			select jsonb_agg(
				jsonb_build_object(
					'repositoryKey', r.owner || '/' || r.name,
					'owner', r.owner,
					'name', r.name,
					'mainSha', coalesce(r.last_main, r.main_sha),
					'sourceBranch', coalesce(
						case
							when public.qorpera_surface_default_branch_valid(nullif(btrim(coalesce(r.imported_from ->> 'branch', '')), ''))
							then btrim(r.imported_from ->> 'branch')
							else null
						end,
						'main'
					),
					'sourceUrl', case
						when r.imported_from ->> 'kind' = 'github'
							and nullif(btrim(coalesce(r.imported_from ->> 'repository', '')), '') is not null
						then 'https://github.com/' || btrim(r.imported_from ->> 'repository')
						else null
					end,
					'boundSurfaceSlugs', coalesce(
						(
							select jsonb_agg(s.slug order by s.sort_order asc, s.slug asc)
							from public.qorpera_surfaces s
							where s.profile_id = p_company_id
								and s.status in ('active', 'proposed')
								and s.source_kind = 'code_repo'
								and lower(coalesce(nullif(btrim(s.repository_key), ''), 'surfaces/' || s.slug)) = lower(r.owner || '/' || r.name)
						),
						'[]'::jsonb
					),
					'createdAt', r.created_at,
					'updatedAt', coalesce(r.imported_at, r.last_ok_at, r.last_care_at, r.created_at)
				)
				order by case when lower(r.owner) = 'surfaces' then 1 else 0 end asc, r.owner asc, r.name asc
			)
			from public.qorpera_code_repositories r
			where r.profile_id = p_company_id
				and not exists (
					select 1
					from public.qorpera_code_requests req
					where req.environment_id = r.environment_id
						and req.owner = r.owner
						and req.name = r.name
						and req.kind = 'import'
						and req.state in ('queued', 'running')
				)
		),
		'[]'::jsonb
	);
end $$;

create function public.qorpera_bind_surface_repository(
	p_surface_id uuid,
	p_repository_key text,
	p_repository_subpath text default null,
	p_default_branch text default 'main'
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid;
	v_role public.qorpera_profile_role;
	v_surface public.qorpera_surfaces%rowtype;
	v_repo_key text := lower(nullif(btrim(coalesce(p_repository_key, '')), ''));
	v_repo_subpath text := public.qorpera_surface_normalize_subpath(p_repository_subpath);
	v_default_branch text := coalesce(nullif(btrim(coalesce(p_default_branch, '')), ''), 'main');
	v_repo_changed boolean;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins can change a surface code repository' using errcode = '42501';
	end if;
	select s.profile_id into v_profile_id
	from public.qorpera_surfaces s
	where s.id = p_surface_id;
	v_role := case when v_profile_id is null then null else public.qorpera_member_role(v_profile_id) end;
	if v_profile_id is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins can change a surface code repository' using errcode = '42501';
	end if;
	if v_repo_key is null or not public.qorpera_surface_repository_key_valid(v_repo_key) then
		raise exception 'Invalid repositoryKey' using errcode = '22023';
	end if;
	if v_repo_subpath is not null and not public.qorpera_surface_repository_subpath_valid(v_repo_subpath) then
		raise exception 'Invalid repositorySubpath' using errcode = '22023';
	end if;
	if not public.qorpera_surface_default_branch_valid(v_default_branch) then
		raise exception 'Invalid defaultBranch' using errcode = '22023';
	end if;

	perform 1
	from public.qorpera_surface_jobs j
	where j.surface_id = p_surface_id and j.status in ('queued', 'running')
	order by j.id asc
	for update;

	perform 1
	from public.qorpera_surface_sessions ss
	where ss.surface_id = p_surface_id and ss.state not in ('completed', 'discarded')
	order by ss.id asc
	for update;

	select * into v_surface
	from public.qorpera_surfaces s
	where s.id = p_surface_id
	for update;
	if v_surface.id is null then
		raise exception 'Only founders and admins can change a surface code repository' using errcode = '42501';
	end if;
	if v_surface.status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;
	if v_surface.source_kind <> 'code_repo' then
		raise exception 'Only code repository surfaces can bind a code repository' using errcode = '22023';
	end if;

	if exists (
		select 1
		from public.qorpera_surface_sessions ss
		where ss.surface_id = p_surface_id
			and ss.state in ('queued', 'running', 'reconciling', 'reconciling_running')
	) then
		raise exception 'Wait for running sessions to finish before changing the code source' using errcode = '55000';
	end if;

	if exists (
		select 1
		from public.qorpera_surface_jobs j
		where j.surface_id = p_surface_id
			and j.status in ('queued', 'running')
	) then
		raise exception 'Wait for pending merge or publish jobs to finish before changing the code source' using errcode = '55000';
	end if;

	v_repo_changed := lower(coalesce(v_surface.repository_key, '')) is distinct from v_repo_key;

	if v_repo_changed and exists (
		select 1
		from public.qorpera_surface_sessions ss
		where ss.surface_id = p_surface_id
			and ss.state not in ('completed', 'discarded')
	) then
		raise exception 'Close or discard open sessions before switching repositories' using errcode = '55000';
	end if;

	if v_repo_changed and exists (
		select 1
		from public.qorpera_surface_changes ch
		where ch.surface_id = p_surface_id
			and ch.kind = 'git_range'
			and ch.status in ('staged', 'conflicted', 'merging')
	) then
		raise exception 'Approve or discard open changes before switching repositories' using errcode = '55000';
	end if;

	if v_repo_subpath is null and exists (
		select 1
		from public.qorpera_coding_sessions cs
		where cs.profile_id = v_surface.profile_id
			and cs.surface_session_id is null
			and cs.phase in ('queued', 'preparing', 'running', 'awaiting_input', 'input_ready', 'publishing')
			and cs.repository ->> 'host' = 'qorpera'
			and lower(coalesce(cs.repository ->> 'owner', '')) || '/' || lower(coalesce(cs.repository ->> 'name', '')) = v_repo_key
	) then
		raise exception 'Wait for active coding sessions on this repository to finish before binding the whole repository' using errcode = '55000';
	end if;

	update public.qorpera_surfaces
	set
		repository_key = v_repo_key,
		repository_subpath = v_repo_subpath,
		default_branch = v_default_branch,
		live_head_sha = case when v_repo_changed then null else live_head_sha end,
		published_head_sha = case when v_repo_changed then null else published_head_sha end,
		unpublished_change_count = case when v_repo_changed then 0 else unpublished_change_count end,
		publish_status = case when v_repo_changed then 'idle' else publish_status end,
		last_publish_error = case when v_repo_changed then null else last_publish_error end,
		updated_at = v_now
	where id = p_surface_id
	returning * into v_surface;

	update public.qorpera_surface_previews
	set expires_at = v_now, updated_at = v_now
	where surface_id = p_surface_id and expires_at > v_now;

	return public.qorpera_surface_summary_json(v_surface);
end $$;

revoke all on function
	public.qorpera_create_surface(uuid, text, text, text, text, text, text, text, text, boolean, text, text, text),
	public.qorpera_list_company_code_repositories(uuid),
	public.qorpera_bind_surface_repository(uuid, text, text, text)
	from public, anon, qorpera_secret_broker;
grant execute on function
	public.qorpera_create_surface(uuid, text, text, text, text, text, text, text, text, boolean, text, text, text),
	public.qorpera_list_company_code_repositories(uuid),
	public.qorpera_bind_surface_repository(uuid, text, text, text)
	to authenticated;

revoke all on function
	public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text, text),
	public.qorpera_native_surface_propose(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function
	public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text, text),
	public.qorpera_native_surface_propose(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text, text)
	to service_role;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_create_surface(uuid,text,text,text,text,text,text,text,text,boolean,text,text,text)'::regprocedure,
			'public.qorpera_propose_surface(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text,text)'::regprocedure,
			'public.qorpera_native_surface_propose(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,text,text)'::regprocedure,
			'public.qorpera_list_company_code_repositories(uuid)'::regprocedure,
			'public.qorpera_bind_surface_repository(uuid,text,text,text)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930934000 function has an API owner: %', v_owner;
		end if;
		execute format('grant select, insert, update on public.qorpera_surfaces to %I', v_owner);
		execute format('grant select on public.qorpera_code_repositories, public.qorpera_code_requests, public.qorpera_coding_sessions, public.qorpera_surface_sessions, public.qorpera_surface_jobs, public.qorpera_surface_changes to %I', v_owner);
		execute format('grant select, update on public.qorpera_surface_previews to %I', v_owner);
		execute format(
			'grant execute on function public.qorpera_assert_surface_member(uuid, boolean), '
			|| 'public.qorpera_member_role(uuid), '
			|| 'public.qorpera_surface_ensure_site(uuid), '
			|| 'public.qorpera_surface_summary_json(public.qorpera_surfaces), '
			|| 'public.qorpera_surface_repository_key_valid(text), '
			|| 'public.qorpera_surface_normalize_subpath(text), '
			|| 'public.qorpera_surface_repository_subpath_valid(text), '
			|| 'public.qorpera_surface_default_branch_valid(text), '
			|| 'public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean, text, text) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join srsb_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930934000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.srsb_patch(regprocedure, text[]);
drop function pg_temp.srsb_apply(text, text, text[]);
drop table srsb_before;
