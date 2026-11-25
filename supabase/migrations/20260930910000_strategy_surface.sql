set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surfaces') is null
		or to_regprocedure('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_propose_surface(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)') is null then
		raise exception '20260930910000 requires 20260930843000 and 20260930869000';
	end if;
	if position('''strategy''' in pg_get_functiondef(
		'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure
	)) > 0 then
		raise exception '20260930910000 is already applied';
	end if;
end $$;

create temporary table strategy_surface_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure,
	'public.qorpera_propose_surface(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)'::regprocedure
);

do $$
declare
	v_constraint text;
begin
	for v_constraint in
		select c.conname
		from pg_constraint c
		where c.conrelid = 'public.qorpera_surfaces'::regclass
			and c.contype = 'c'
			and pg_get_constraintdef(c.oid) like '%surface_kind%'
	loop
		execute format('alter table public.qorpera_surfaces drop constraint %I', v_constraint);
	end loop;
end $$;

alter table public.qorpera_surfaces
	add constraint qorpera_surfaces_surface_kind_check check (surface_kind in (
		'identity', 'strategy', 'website', 'web_app', 'mobile_app', 'desktop_app',
		'database', 'dashboard', 'brand', 'product', 'report', 'custom',
		'inbox', 'money', 'members', 'data', 'files'
	));

create function pg_temp.ss_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930910000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930910000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.ss_patch('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure, array[
$old$		'Global brand, voice, design tokens, and philosophy applied across every surface.',
		0, p_creator_user_id
	)
	on conflict (profile_id, slug) do nothing;$old$,
$new$		'Global brand, voice, design tokens, and philosophy applied across every surface.',
		0, p_creator_user_id
	)
	on conflict (profile_id, slug) do nothing;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, is_global,
		status, icon, source_kind, folder_root, preview_mode, brief_summary, sort_order, created_by_user_id
	)
	values (
		p_company_id, 'strategy', 'Strategy', 'products', 'studio', 'strategy', false,
		'active', 'figure:lighthouse', 'folder', 'surfaces/strategy', 'studio_overlay',
		'Grand plan, competing strategic plays, unit economics, market landscape, and falsifiable hypotheses.',
		5, p_creator_user_id
	)
	on conflict (profile_id, slug) do nothing;$new$
]);

select pg_temp.ss_patch(
	'public.qorpera_propose_surface(uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean)'::regprocedure,
	array[
$old$	v_repo_key text := nullif(btrim(coalesce(p_repository_key, '')), '');
	v_status text := case when coalesce(p_activate_immediately, false) then 'active' else 'proposed' end;
begin
	if p_archetype = 'live_build' and v_repo_key is null and v_slug <> '' then
		v_repo_key := 'surfaces/' || v_slug;
	end if;$old$,
$new$	v_repo_key text := nullif(btrim(coalesce(p_repository_key, '')), '');
	v_folder_root text := nullif(btrim(coalesce(p_folder_root, ''), '/ '), '');
	v_status text := case when coalesce(p_activate_immediately, false) then 'active' else 'proposed' end;
begin
	if p_archetype = 'live_build' and v_repo_key is null and v_slug <> '' then
		v_repo_key := 'surfaces/' || v_slug;
	end if;
	if p_archetype = 'studio' and v_folder_root is null and v_slug <> '' then
		v_folder_root := case when p_kind = 'identity' then 'identity' else 'surfaces/' || v_slug end;
	end if;$new$,
$old$		p_source_kind, v_repo_key, p_folder_root, coalesce(p_preview_mode, 'none'), p_brief_summary$old$,
$new$		p_source_kind, v_repo_key, v_folder_root, coalesce(p_preview_mode, 'none'), p_brief_summary$new$,
$old$		repository_key = coalesce(public.qorpera_surfaces.repository_key, excluded.repository_key),$old$,
$new$		repository_key = coalesce(public.qorpera_surfaces.repository_key, excluded.repository_key),
		folder_root = coalesce(public.qorpera_surfaces.folder_root, excluded.folder_root),$new$
	]
);

insert into public.qorpera_surfaces(
	profile_id, slug, title, surface_group, archetype, surface_kind, is_global,
	status, icon, source_kind, folder_root, preview_mode, brief_summary, sort_order
)
select
	s.profile_id, 'strategy', 'Strategy', 'products', 'studio', 'strategy', false,
	'active', 'figure:lighthouse', 'folder', 'surfaces/strategy', 'studio_overlay',
	'Grand plan, competing strategic plays, unit economics, market landscape, and falsifiable hypotheses.',
	5
from public.qorpera_surfaces s
where s.slug = 'identity'
	and not exists (
		select 1 from public.qorpera_surfaces existing
		where existing.profile_id = s.profile_id and existing.slug = 'strategy'
	)
on conflict (profile_id, slug) do nothing;

do $$ begin
	if exists (
		select 1 from pg_temp.strategy_surface_before as prior
		join pg_proc as patched on patched.oid = prior.oid
		where patched.prosecdef is distinct from prior.prosecdef
			or patched.proconfig is distinct from prior.proconfig
			or patched.provolatile is distinct from prior.provolatile
			or patched.proacl::text is distinct from prior.proacl::text
	) or (select count(*) from pg_temp.strategy_surface_before) <> 2 then
		raise exception '20260930910000: patched function attributes or grants drifted';
	end if;
end $$;
