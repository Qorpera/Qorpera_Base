set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_site_preview_domain()') is null
		or to_regprocedure('public.qorpera_web_edge_snapshot()') is null
		or to_regprocedure('public.qorpera_web_edge_redeem_member_pass(text,text)') is null
		or to_regprocedure('public.qorpera_web_edge_tls_allow(text)') is null
		or to_regprocedure('public.qorpera_surface_preview_kept_frame(public.qorpera_surface_previews,uuid,public.qorpera_company_sites)') is null
		or to_regprocedure('public.qorpera_complete_surface_preview_build(uuid,uuid,uuid,text,text,text)') is null
		or to_regprocedure('public.qorpera_surface_build_hand_back(uuid)') is null
		or to_regprocedure('public.qorpera_surface_shared_product_folder_roots(uuid)') is null
		or not exists (select 1 from pg_roles where rolname = 'qorpera_web_router') then
		raise exception '20260930916000 requires 20260930834000, 20260930861000, 20260930876000, 20260930878000, 20260930881000, and 20260930889000';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_company_site_member_passes'
			and column_name = 'version_id'
	) then
		raise exception '20260930916000 is already applied';
	end if;
end $$;

create function pg_temp.snep_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930916000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930916000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_company_site_member_passes
	add column version_id uuid references public.qorpera_company_site_versions(id) on delete cascade;

create index qorpera_company_site_member_passes_version_idx
	on public.qorpera_company_site_member_passes(version_id)
	where version_id is not null;

do $$
declare v_con text;
begin
	for v_con in
		select con.conname
		from pg_constraint as con
		where con.conrelid = 'public.qorpera_surface_preview_builds'::regclass
			and con.contype = 'c'
			and pg_get_constraintdef(con.oid) like '%built_tree_sha%'
	loop
		execute format('alter table public.qorpera_surface_preview_builds drop constraint %I', v_con);
	end loop;
end $$;

alter table public.qorpera_surface_preview_builds
	add column manifest_sha256 text check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
	add column manifest_json jsonb check (manifest_json is null or jsonb_typeof(manifest_json) = 'object'),
	add column file_count integer check (file_count is null or file_count between 1 and 10000),
	add column total_bytes bigint check (total_bytes is null or total_bytes between 0 and 536870912),
	add column has_credential_inputs boolean not null default false,
	add constraint qorpera_surface_preview_builds_built_tree_sha_check
		check (built_tree_sha is null or built_tree_sha ~ '^[0-9a-f]{40}$'),
	add constraint qorpera_surface_preview_builds_built_state_check
		check ((state = 'built') = (built_tree_sha is not null or (manifest_sha256 is not null and manifest_json is not null)));

create or replace function public.qorpera_site_preview_domain()
returns text language sql stable set search_path = '' as $$
	select coalesce((select settings.hosts_domain from public.qorpera_site_settings as settings limit 1), 'qorpera.site')
$$;
revoke all on function public.qorpera_site_preview_domain()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_preview_slot_host(p_slug text, p_slot integer)
returns text language sql stable set search_path = '' as $$
	select case
		when p_slug is null or p_slot is null or p_slot not between 0 and 7 then null
		else p_slug || '--p' || p_slot::text || '.' || public.qorpera_site_preview_domain()
	end
$$;
revoke all on function public.qorpera_surface_preview_slot_host(text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_site_host_pattern(p_domain text)
returns text language sql immutable set search_path = '' as $$
	select '^([a-z0-9]+(?:-[a-z0-9]+)*)(--next|--p[0-7])?\.' || replace(p_domain, '.', '\.') || '$'
$$;

create or replace function public.qorpera_site_host(p_host text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_domain text := (select settings.hosts_domain from public.qorpera_site_settings as settings);
	v_label text;
	v_next boolean := false;
	v_preview_slot integer;
begin
	if v_domain is null or p_host is null or right(p_host, char_length(v_domain) + 1) <> ('.' || v_domain) then
		return null;
	end if;
	v_label := left(p_host, -(char_length(v_domain) + 1));
	if right(v_label, 6) = '--next' then
		v_next := true;
		v_label := left(v_label, -6);
	elsif v_label ~ '--p[0-7]$' then
		v_preview_slot := right(v_label, 1)::integer;
		v_label := left(v_label, -4);
	end if;
	if v_label !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_label) not between 3 and 48
		or not public.qorpera_site_slug_valid(v_label) then
		return null;
	end if;
	if v_preview_slot is not null then
		return jsonb_build_object('slug', v_label, 'scope', 'preview', 'previewSlot', v_preview_slot);
	end if;
	return jsonb_build_object('slug', v_label, 'scope', case when v_next then 'next' else 'site' end);
end $$;

create or replace function public.qorpera_web_edge_tls_allow(p_domain text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_host text := lower(btrim(coalesce(p_domain, '')));
	v_settings public.qorpera_site_settings%rowtype;
	v_parsed jsonb;
	v_allowed boolean := false;
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role', 'qorpera_web_router') then
		raise exception 'TLS check requires service_role' using errcode = '42501';
	end if;
	if right(v_host, 1) = '.' then
		v_host := left(v_host, -1);
	end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings limit 1;
	if coalesce(v_settings.enabled and v_settings.domains_enabled, false) then
		select exists (
			select 1
			from public.qorpera_company_site_domains as dom
			join public.qorpera_company_sites as site on site.id = dom.site_id
			where dom.hostname = v_host
				and dom.status in ('dns_verified', 'tls_active')
				and site.taken_down_at is null
		) into v_allowed;
		if v_allowed then
			return jsonb_build_object('allowed', true, 'reason', 'custom_domain');
		end if;
	end if;
	if coalesce(v_settings.enabled and v_settings.hosts_enabled, false) then
		v_parsed := public.qorpera_site_host(v_host);
		if v_parsed is not null and v_parsed ->> 'scope' in ('site', 'next', 'preview') then
			select exists (
				select 1
				from public.qorpera_company_sites as site
				where site.slug = v_parsed ->> 'slug'
					and site.taken_down_at is null
			) into v_allowed;
			if v_allowed then
				return jsonb_build_object('allowed', true, 'reason', 'site_host');
			end if;
		end if;
	end if;
	return jsonb_build_object('allowed', false, 'reason', 'denied');
end $$;

drop function public.qorpera_surface_mint_preview_pass(uuid, uuid, text);
create function public.qorpera_surface_mint_preview_pass(
	p_site_id uuid,
	p_user_id uuid,
	p_host text,
	p_version_id uuid default null
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
	v_pass text;
	v_now timestamptz := clock_timestamp();
begin
	if p_site_id is null or p_user_id is null or p_host is null then
		return null;
	end if;
	v_pass := replace(replace(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+', '-'), '/', '_');
	delete from public.qorpera_company_site_member_passes
	where user_id = p_user_id and expires_at <= v_now;

	insert into public.qorpera_company_site_member_passes(pass_sha256, site_id, user_id, host, version_id, created_at, expires_at)
	values (encode(extensions.digest(v_pass, 'sha256'), 'hex'), p_site_id, p_user_id, lower(p_host), p_version_id, v_now, v_now + interval '120 seconds');
	return v_pass;
end $$;
revoke all on function public.qorpera_surface_mint_preview_pass(uuid, uuid, text, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_web_edge_redeem_member_pass(p_host text, p_pass text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_host text := lower(btrim(coalesce(p_host, '')));
	v_host_of jsonb;
	v_scope text;
	v_site public.qorpera_company_sites%rowtype;
	v_pass public.qorpera_company_site_member_passes%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role', 'qorpera_web_router') then
		raise exception 'Edge member pass redeem requires service_role' using errcode = '42501';
	end if;
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' or not public.qorpera_site_hosts_on() then
		return '{"state":"refused"}'::jsonb;
	end if;
	v_host_of := public.qorpera_site_host(v_host);
	v_scope := v_host_of ->> 'scope';
	if v_host_of is null or v_scope not in ('site', 'preview') then
		return '{"state":"refused"}'::jsonb;
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.slug = v_host_of ->> 'slug'
		and site.kind = 'files'
		and (v_scope = 'preview' or site.current_version_id is not null or site.live_deployment_id is not null)
		and site.taken_down_at is null
		and not public.qorpera_company_deleting(site.profile_id);
	if not found then
		return '{"state":"refused"}'::jsonb;
	end if;
	delete from public.qorpera_company_site_member_passes as pass
	where pass.pass_sha256 = public.qorpera_site_sha256(p_pass)
		and pass.site_id = v_site.id
		and pass.host = v_host
		and pass.expires_at > v_now
	returning pass.* into v_pass;
	if v_pass.pass_sha256 is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_site.profile_id and member.user_id = v_pass.user_id
	) then
		return '{"state":"refused"}'::jsonb;
	end if;
	if v_scope = 'preview' then
		if v_pass.version_id is null
			or not exists (
				select 1 from public.qorpera_company_site_versions as ver
				where ver.id = v_pass.version_id
					and ver.site_id = v_site.id
					and ver.state in ('ready', 'live', 'kept')
			)
			or not exists (
				select 1
				from public.qorpera_surface_previews as sp
				join public.qorpera_surfaces as sf on sf.id = sp.surface_id
				where sf.site_id = v_site.id
					and sp.site_version_id = v_pass.version_id
					and sp.status = 'ready'
					and sp.expires_at > v_now
			) then
			return '{"state":"refused"}'::jsonb;
		end if;
		return jsonb_build_object(
			'state', 'open',
			'site_id', v_site.id,
			'version_id', v_pass.version_id,
			'password_version', v_site.password_version,
			'max_age', 43200
		);
	end if;
	return jsonb_build_object(
		'state', 'open',
		'site_id', v_site.id,
		'password_version', v_site.password_version,
		'max_age', 43200
	);
end $$;

create or replace function public.qorpera_surface_preview_kept_frame(
	p_preview public.qorpera_surface_previews,
	p_user_id uuid,
	p_site public.qorpera_company_sites
)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'previewId', kept.id,
		'doorActionUrl', 'https://' || public.qorpera_surface_preview_slot_host(p_site.slug, 0) || '/__qorpera/member',
		'memberPass', null
	)
	from public.qorpera_surface_previews kept
	where p_preview.status = 'failed' and p_site.id is not null
		and kept.surface_id = p_preview.surface_id and kept.id <> p_preview.id
		and kept.status = 'ready' and kept.expires_at > clock_timestamp()
		and kept.requested_by_user_id = p_user_id
	order by kept.updated_at desc, kept.id
	limit 1
$$;

create or replace function public.qorpera_mint_surface_preview_pass(p_preview_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_preview public.qorpera_surface_previews%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_user_id uuid;
	v_slot integer := 0;
	v_host text;
	v_pass text;
begin
	select * into v_preview from public.qorpera_surface_previews where id = p_preview_id;
	if v_preview.id is null then raise exception 'Preview not found' using errcode = 'P0002'; end if;
	select * into v_surface from public.qorpera_surfaces where id = v_preview.surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);
	perform public.qorpera_assert_surfaces_enabled();

	if v_preview.status <> 'ready' or v_preview.expires_at <= clock_timestamp() then
		raise exception 'Preview is not ready' using errcode = '55000';
	end if;
	if v_surface.site_id is null then
		raise exception 'Surface preview site not found' using errcode = 'P0002';
	end if;
	select * into v_site from public.qorpera_company_sites where id = v_surface.site_id;
	if v_site.id is null then
		raise exception 'Surface preview site not found' using errcode = 'P0002';
	end if;

	if v_preview.exploration_session_id is not null then
		select coalesce(array_position(ms.compare_session_ids, v_preview.exploration_session_id), 0)
		into v_slot
		from public.qorpera_member_surface_state ms
		where ms.user_id = v_user_id
			and ms.surface_id = v_surface.id
			and cardinality(coalesce(ms.compare_session_ids, '{}'::uuid[])) >= 2;
		v_slot := coalesce(v_slot, 0);
		if v_slot < 0 or v_slot > 7 then
			v_slot := 0;
		end if;
	end if;

	v_host := public.qorpera_surface_preview_slot_host(v_site.slug, v_slot);
	v_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_host, v_preview.site_version_id);
	return jsonb_build_object(
		'previewId', v_preview.id,
		'doorActionUrl', 'https://' || v_host || '/__qorpera/member',
		'memberPass', v_pass
	);
end $$;

select pg_temp.snep_patch('public.qorpera_get_surface_workspace(uuid)'::regprocedure, array[
$old$v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$old$,
$new$v_primary_host := public.qorpera_surface_preview_slot_host(v_site.slug, 0);$new$,
$old$			select s.id, coalesce(s.exploration_variant_label, s.title) as label
			from public.qorpera_surface_sessions s
			where s.id = any(v_compare) and s.surface_id = p_surface_id
			order by array_position(v_compare, s.id)$old$,
$new$			select s.id, coalesce(s.exploration_variant_label, s.title) as label, array_position(v_compare, s.id) as slot
			from public.qorpera_surface_sessions s
			where s.id = any(v_compare) and s.surface_id = p_surface_id
			order by array_position(v_compare, s.id)$new$,
$old$v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.' || public.qorpera_site_preview_domain();$old$,
$new$v_cmp_host := public.qorpera_surface_preview_slot_host(v_site.slug, v_cmp_session.slot);$new$
]);

select pg_temp.snep_patch('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure, array[
$old$			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.' || public.qorpera_site_preview_domain();
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host);$old$,
$new$			v_primary_host := public.qorpera_surface_preview_slot_host(v_site.slug, 0);
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host, v_preview.site_version_id);$new$,
$old$			select s.id, coalesce(s.exploration_variant_label, s.title) as label
			from public.qorpera_surface_sessions s
			where s.id = any(v_compare) and s.surface_id = p_surface_id
			order by array_position(v_compare, s.id)$old$,
$new$			select s.id, coalesce(s.exploration_variant_label, s.title) as label, array_position(v_compare, s.id) as slot
			from public.qorpera_surface_sessions s
			where s.id = any(v_compare) and s.surface_id = p_surface_id
			order by array_position(v_compare, s.id)$new$,
$old$					v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.' || public.qorpera_site_preview_domain();
					v_cmp_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_cmp_host);$old$,
$new$					v_cmp_host := public.qorpera_surface_preview_slot_host(v_site.slug, v_cmp_session.slot);
					v_cmp_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_cmp_host, v_cmp_preview.site_version_id);$new$
]);

select pg_temp.snep_patch('public.qorpera_web_edge_snapshot()'::regprocedure, array[
$old$					from public.qorpera_company_site_deployments as dep
					join public.qorpera_company_site_versions as ver on ver.id = dep.version_id
					where dep.site_id = site.id
						and dep.version_id is not null
						and ver.state in ('ready', 'live', 'kept')$old$,
$new$					from public.qorpera_company_site_deployments as dep
					join public.qorpera_company_site_versions as ver on ver.id = dep.version_id
					where dep.site_id = site.id
						and dep.version_id is not null
						and ver.state in ('ready', 'live', 'kept')
						and (
							ver.id = site.current_version_id
							or exists (
								select 1 from public.qorpera_surface_previews as sp
								where sp.site_version_id = ver.id
									and sp.status = 'ready'
									and sp.expires_at > clock_timestamp()
							)
							or exists (
								select 1 from public.qorpera_company_site_tickets as tk
								where tk.site_id = site.id
									and tk.version_id = ver.id
									and tk.expires_at > clock_timestamp()
							)
							or exists (
								select 1 from public.qorpera_company_site_member_passes as mp
								where mp.site_id = site.id
									and mp.version_id = ver.id
									and mp.expires_at > clock_timestamp()
							)
							or ver.id in (
								select newest.id
								from public.qorpera_company_site_versions as newest
								where newest.site_id = site.id
									and newest.state = 'ready'
								order by newest.created_at desc, newest.id desc
								limit 3
							)
						)$new$
]);

create trigger qorpera_web_notify_surface_previews
	after insert or update of status, site_version_id, expires_at on public.qorpera_surface_previews
	for each row when (new.status = 'ready' and new.site_version_id is not null)
	execute function public.qorpera_web_notify_route_change();

create function public.qorpera_surface_site_deployment_register(
	p_surface_id uuid,
	p_tree_sha text,
	p_manifest_sha256 text,
	p_manifest_json jsonb,
	p_file_count integer,
	p_total_bytes bigint,
	p_has_credential_inputs boolean default false,
	p_promote_live boolean default false,
	p_main_sha text default null,
	p_title text default null
)
returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_tree_key text;
	v_main_sha text;
	v_next_change integer;
	v_next_version integer;
	v_title text;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Surface site deployment register requires service_role' using errcode = '42501';
	end if;
	if p_surface_id is null
		or p_tree_sha is null or p_tree_sha !~ '^[0-9a-f]{40}$'
		or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(coalesce(p_manifest_json, 'null'::jsonb)) <> 'object'
		or p_file_count is null or p_file_count not between 1 and 10000
		or p_total_bytes is null or p_total_bytes not between 0 and 536870912
		or (p_main_sha is not null and p_main_sha !~ '^[0-9a-f]{40}$') then
		raise exception 'Surface site deployment input is invalid' using errcode = '22023';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for key share;
	if v_surface.id is null or v_surface.site_id is null then
		raise exception 'Surface preview site not found' using errcode = 'P0002';
	end if;
	select * into v_site from public.qorpera_company_sites where id = v_surface.site_id for update;
	if v_site.id is null then
		raise exception 'Surface preview site not found' using errcode = 'P0002';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if public.qorpera_company_deleting(v_site.profile_id) then
		raise exception 'Company is deleting' using errcode = '55000';
	end if;
	if coalesce(p_promote_live, false) and v_site.is_public and coalesce(p_has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;

	v_tree_key := left(p_manifest_sha256, 40);
	v_main_sha := coalesce(p_main_sha, p_tree_sha);
	v_title := nullif(btrim(coalesce(p_title, '')), '');

	select * into v_version
	from public.qorpera_company_site_versions as ver
	where ver.site_id = v_site.id and ver.tree = v_tree_key
	for update;

	if coalesce(p_promote_live, false) then
		update public.qorpera_company_site_versions
		set state = 'kept'
		where site_id = v_site.id
			and state = 'live'
			and (v_version.id is null or id <> v_version.id);
	end if;

	if v_version.id is null then
		select coalesce(max(ver.change), 0) + 1 into v_next_change
		from public.qorpera_company_site_versions as ver
		where ver.site_id = v_site.id;

		insert into public.qorpera_company_site_versions (
			site_id, state, first_publish, title, source_path, manifest_sha256,
			file_count, total_bytes, tree, change, main_sha, listed, published_at
		) values (
			v_site.id,
			case when coalesce(p_promote_live, false) then 'live' else 'ready' end,
			v_site.current_version_id is null,
			coalesce(v_title, v_site.title, v_surface.title),
			v_site.source_path,
			p_manifest_sha256,
			p_file_count,
			p_total_bytes,
			v_tree_key,
			v_next_change,
			v_main_sha,
			true,
			case when coalesce(p_promote_live, false) then v_now else null end
		)
		returning * into v_version;
	else
		update public.qorpera_company_site_versions
		set
			state = case
				when coalesce(p_promote_live, false) then 'live'
				when state = 'uploading' then 'ready'
				else state
			end,
			listed = true,
			manifest_sha256 = p_manifest_sha256,
			file_count = p_file_count,
			total_bytes = p_total_bytes,
			published_at = case
				when coalesce(p_promote_live, false) then coalesce(published_at, v_now)
				else published_at
			end
		where id = v_version.id
		returning * into v_version;
	end if;

	select * into v_dep
	from public.qorpera_company_site_deployments as dep
	where dep.version_id = v_version.id
	for update;

	if v_dep.id is null then
		select coalesce(max(dep.version_number), 0) + 1 into v_next_version
		from public.qorpera_company_site_deployments as dep
		where dep.site_id = v_site.id;

		insert into public.qorpera_company_site_deployments (
			site_id, profile_id, version_number, version_id, kind, state,
			manifest_sha256, manifest_json, file_count, total_bytes,
			has_credential_inputs, change_number, main_sha, live_at
		) values (
			v_site.id,
			v_site.profile_id,
			v_next_version,
			v_version.id,
			'static',
			case when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then 'live' else 'ready' end,
			p_manifest_sha256,
			p_manifest_json,
			p_file_count,
			p_total_bytes,
			coalesce(p_has_credential_inputs, false),
			v_version.change,
			v_version.main_sha,
			case when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then v_now else null end
		)
		returning * into v_dep;
	else
		update public.qorpera_company_site_deployments
		set
			kind = 'static',
			state = case when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then 'live' else state end,
			manifest_sha256 = p_manifest_sha256,
			manifest_json = p_manifest_json,
			file_count = p_file_count,
			total_bytes = p_total_bytes,
			has_credential_inputs = coalesce(p_has_credential_inputs, false),
			live_at = case
				when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then coalesce(live_at, v_now)
				else live_at
			end,
			stopped_at = case
				when coalesce(p_promote_live, false) or v_site.current_version_id = v_version.id then null
				else stopped_at
			end
		where id = v_dep.id
		returning * into v_dep;
	end if;

	if coalesce(p_promote_live, false) then
		update public.qorpera_company_site_deployments
		set state = 'ready', stopped_at = v_now
		where site_id = v_site.id and state = 'live' and id <> v_dep.id;

		update public.qorpera_company_sites
		set
			current_version_id = v_version.id,
			live_deployment_id = v_dep.id,
			deployment_kind = 'static',
			storage_mode = 'blob',
			title = coalesce(v_title, title),
			updated_at = v_now
		where id = v_site.id;
	elsif v_site.current_version_id = v_version.id then
		update public.qorpera_company_sites
		set
			live_deployment_id = v_dep.id,
			deployment_kind = 'static',
			storage_mode = 'blob',
			updated_at = v_now
		where id = v_site.id;
	end if;

	perform public.qorpera_code_site_prune(v_site.id);
	delete from public.qorpera_company_site_deployments
	where site_id = v_site.id
		and version_id is null
		and id is distinct from v_dep.id
		and state <> 'live';

	return jsonb_build_object(
		'siteId', v_site.id,
		'slug', v_site.slug,
		'versionId', v_version.id,
		'deploymentId', v_dep.id,
		'versionNumber', v_dep.version_number,
		'state', v_version.state
	);
end $$;
revoke all on function public.qorpera_surface_site_deployment_register(uuid, text, text, jsonb, integer, bigint, boolean, boolean, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_surface_site_deployment_register(uuid, text, text, jsonb, integer, bigint, boolean, boolean, text, text)
	to service_role;

create or replace function public.qorpera_surface_preview_build_settle(p_build_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_now timestamptz := clock_timestamp();
	v_job public.qorpera_surface_jobs%rowtype;
	v_reg jsonb;
	v_version_id uuid;
	v_publish_head_sha text;
	v_sqlstate text;
	v_err text;
begin
	select * into v_build from public.qorpera_surface_preview_builds where id = p_build_id;
	if v_build.id is null or v_build.state in ('queued', 'running') then
		return;
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_build.surface_id;

	if v_build.state = 'failed' then
		update public.qorpera_surface_previews
		set status = 'failed', error_detail = v_build.error_detail, lease_expires_at = null, lease_token = null, updated_at = v_now
		where build_id = v_build.id and status = 'building' and lease_token is null;
	elsif v_surface.id is null or v_surface.status = 'archived' then
		update public.qorpera_surface_previews
		set status = 'failed', error_detail = 'The interface was deleted', lease_expires_at = null, lease_token = null,
			updated_at = v_now
		where build_id = v_build.id and status = 'building' and lease_token is null;
	elsif v_build.state = 'built' and v_build.manifest_json is not null and v_build.manifest_sha256 is not null then
		if exists (
			select 1 from public.qorpera_surface_previews p
			where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null
		) then
			begin
				v_reg := public.qorpera_surface_site_deployment_register(
					v_build.surface_id,
					v_build.tree_sha,
					v_build.manifest_sha256,
					v_build.manifest_json,
					v_build.file_count,
					v_build.total_bytes,
					v_build.has_credential_inputs,
					false,
					v_build.commit_sha,
					null
				);
				if v_reg ->> 'state' = 'refused' or nullif(v_reg ->> 'versionId', '') is null then
					raise exception '%', coalesce(nullif(v_reg ->> 'code', ''), 'SITE_REGISTER_REFUSED');
				end if;
				v_version_id := (v_reg ->> 'versionId')::uuid;
				update public.qorpera_surface_previews p
				set
					status = 'ready',
					composite_tree_sha = v_build.tree_sha,
					site_version_id = v_version_id,
					conflict_report = null,
					error_detail = null,
					attempts = 0,
					lease_expires_at = null,
					lease_token = null,
					expires_at = case when public.qorpera_surface_preview_selected(p.id) then p.expires_at else least(p.expires_at, v_now) end,
					updated_at = v_now
				where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null;
			exception when others then
				v_sqlstate := sqlstate;
				if v_sqlstate in ('55P03', '57014', '40P01', '40001') then
					update public.qorpera_surface_previews p
					set
						status = 'composing',
						attempts = 0,
						lease_expires_at = null,
						lease_token = null,
						expires_at = case when public.qorpera_surface_preview_selected(p.id) then p.expires_at else least(p.expires_at, v_now) end,
						updated_at = v_now
					where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null;
				else
					v_err := public.qorpera_surface_preview_build_detail(
						'PREVIEW_BUILD_FAILED',
						'The built preview could not be registered: ' || left(sqlerrm, 700)
					);
					update public.qorpera_surface_preview_builds
					set state = 'failed', error_detail = v_err, built_tree_sha = null,
						manifest_sha256 = null, manifest_json = null, file_count = null, total_bytes = null, has_credential_inputs = false,
						updated_at = v_now
					where id = v_build.id
					returning * into v_build;
					update public.qorpera_surface_previews
					set status = 'failed', error_detail = v_err, lease_expires_at = null, lease_token = null, updated_at = v_now
					where build_id = v_build.id and status = 'building' and lease_token is null;
					perform public.qorpera_surface_build_hand_back(v_build.id);
				end if;
			end;
		end if;
	else
		update public.qorpera_surface_previews p
		set
			status = 'composing',
			attempts = 0,
			lease_expires_at = null,
			lease_token = null,
			expires_at = case when public.qorpera_surface_preview_selected(p.id) then p.expires_at else least(p.expires_at, v_now) end,
			updated_at = v_now
		where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null;
	end if;

	for v_job in
		select * from public.qorpera_surface_jobs
		where build_id = v_build.id and kind = 'publish_surface' and status = 'running' and lease_token is null
		for update
	loop
		if v_build.state = 'built' and v_build.manifest_json is not null and v_build.manifest_sha256 is not null then
			v_publish_head_sha := coalesce(
				nullif(v_job.payload ->> 'requestedHeadSha', ''),
				nullif(v_job.payload ->> 'liveHeadSha', ''),
				v_build.commit_sha
			);
			begin
				v_reg := public.qorpera_surface_site_deployment_register(
					v_build.surface_id,
					v_build.tree_sha,
					v_build.manifest_sha256,
					v_build.manifest_json,
					v_build.file_count,
					v_build.total_bytes,
					v_build.has_credential_inputs,
					true,
					v_publish_head_sha,
					null
				);
				if v_reg ->> 'state' = 'refused' or nullif(v_reg ->> 'versionId', '') is null then
					raise exception '%', coalesce(nullif(v_reg ->> 'code', ''), 'SITE_REGISTER_REFUSED');
				end if;
				update public.qorpera_surfaces
				set
					published_head_sha = coalesce(v_publish_head_sha, live_head_sha),
					unpublished_change_count = 0,
					publish_status = 'idle',
					last_publish_error = null,
					updated_at = v_now
				where id = v_job.surface_id;
				update public.qorpera_surface_changes
				set
					published_at = v_now,
					published_by_user_id = v_job.requested_by_user_id
				where surface_id = v_job.surface_id and status = 'merged' and published_at is null;
				update public.qorpera_surface_jobs
				set
					status = 'completed',
					error_detail = null,
					lease_expires_at = null,
					completed_at = v_now,
					updated_at = v_now
				where id = v_job.id;
			exception when others then
				v_sqlstate := sqlstate;
				if v_sqlstate in ('55P03', '57014', '40P01', '40001') then
					update public.qorpera_surface_jobs
					set status = 'queued', attempts = 0, lease_expires_at = null, updated_at = v_now
					where id = v_job.id;
				else
					v_err := public.qorpera_surface_preview_build_detail(
						'PREVIEW_BUILD_FAILED',
						'The built site could not be published: ' || left(sqlerrm, 700)
					);
					update public.qorpera_surface_preview_builds
					set state = 'failed', error_detail = v_err, built_tree_sha = null,
						manifest_sha256 = null, manifest_json = null, file_count = null, total_bytes = null, has_credential_inputs = false,
						updated_at = v_now
					where id = v_build.id
					returning * into v_build;
					update public.qorpera_surfaces
					set publish_status = 'failed', last_publish_error = v_err, updated_at = v_now
					where id = v_job.surface_id;
					update public.qorpera_surface_jobs
					set status = 'failed', error_detail = v_err, lease_expires_at = null, completed_at = v_now, updated_at = v_now
					where id = v_job.id;
					perform public.qorpera_surface_build_hand_back(v_build.id);
				end if;
			end;
		elsif v_build.state = 'built' then
			update public.qorpera_surface_jobs
			set status = 'queued', attempts = 0, lease_expires_at = null, updated_at = v_now
			where id = v_job.id;
		else
			update public.qorpera_surfaces
			set
				publish_status = 'failed',
				last_publish_error = coalesce(v_build.error_detail,
					public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_FAILED', 'The build was dropped.')),
				updated_at = v_now
			where id = v_job.surface_id;
			update public.qorpera_surface_jobs
			set
				status = 'failed',
				error_detail = coalesce(v_build.error_detail,
					public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_FAILED', 'The build was dropped.')),
				lease_expires_at = null,
				completed_at = v_now,
				updated_at = v_now
			where id = v_job.id;
		end if;
	end loop;
end $$;

create or replace function public.qorpera_surface_preview_build_fail(p_build_id uuid, p_detail text)
returns void language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_surface_preview_builds
	set state = 'failed', error_detail = left(p_detail, 1000), built_tree_sha = null,
		manifest_sha256 = null, manifest_json = null, file_count = null, total_bytes = null, has_credential_inputs = false,
		worker_id = null, worker_sequence = null, started_at = null, finished_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = p_build_id and state in ('queued', 'running');
	if found then
		perform public.qorpera_surface_preview_build_settle(p_build_id);
	end if;
end $$;

create or replace function public.qorpera_surface_request_build(
	p_kind text,
	p_id uuid,
	p_lease_token uuid,
	p_commit_sha text,
	p_tree_sha text,
	p_recipe jsonb,
	p_stale_built_tree text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_preview public.qorpera_surface_previews%rowtype;
	v_job public.qorpera_surface_jobs%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_member uuid;
	v_recipe_sha text;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_old public.qorpera_surface_preview_builds%rowtype;
	v_now timestamptz := clock_timestamp();
	v_kick text;
	v_detail text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Surface code host authority required' using errcode = '42501';
	end if;
	if p_kind not in ('preview', 'publish') or p_id is null or p_lease_token is null
		or coalesce(p_commit_sha, '') !~ '^[0-9a-f]{40}$' or coalesce(p_tree_sha, '') !~ '^[0-9a-f]{40}$'
		or not public.qorpera_surface_preview_recipe_valid(p_recipe)
		or (p_stale_built_tree is not null and p_stale_built_tree !~ '^[0-9a-f]{40}$' and p_stale_built_tree !~ '^[0-9a-f]{64}$') then
		raise exception 'Surface build request is invalid' using errcode = '22023';
	end if;

	if p_kind = 'preview' then
		select * into v_preview from public.qorpera_surface_previews where id = p_id for update;
		if v_preview.id is null or v_preview.status <> 'building' or v_preview.lease_token is distinct from p_lease_token then
			raise exception 'Preview lease mismatch' using errcode = '55000';
		end if;
		select * into v_surface from public.qorpera_surfaces where id = v_preview.surface_id;
		v_member := v_preview.requested_by_user_id;
	else
		select * into v_job from public.qorpera_surface_jobs where id = p_id for update;
		if v_job.id is null or v_job.kind <> 'publish_surface' or v_job.status <> 'running'
			or v_job.lease_token is distinct from p_lease_token then
			raise exception 'Surface job lease mismatch' using errcode = '55000';
		end if;
		select * into v_surface from public.qorpera_surfaces where id = v_job.surface_id;
		v_member := v_job.requested_by_user_id;
	end if;
	if v_surface.id is null or v_surface.source_kind <> 'code_repo' then
		raise exception 'Surface is not a code interface' using errcode = '22023';
	end if;
	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.user_id = v_member
			and m.role in ('owner', 'admin', 'contributor')
	) then
		v_member := v_surface.created_by_user_id;
	end if;
	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.user_id = v_member
			and m.role in ('owner', 'admin', 'contributor')
	) then
		select m.user_id into v_member from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.role in ('owner', 'admin', 'contributor')
		order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.joined_at asc limit 1;
	end if;
	if v_member is null then
		raise exception 'No member can build this interface' using errcode = '42501';
	end if;

	v_recipe_sha := encode(extensions.digest(convert_to(p_recipe::text, 'utf8'), 'sha256'), 'hex');
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.surface-build:' || v_surface.id::text, 0));

	select * into v_build from public.qorpera_surface_preview_builds
	where surface_id = v_surface.id and tree_sha = p_tree_sha and recipe_sha256 = v_recipe_sha
	for update;

	if v_build.id is not null and v_build.state = 'built'
		and (
			p_stale_built_tree is null
			or (
				v_build.built_tree_sha is distinct from p_stale_built_tree
				and v_build.manifest_sha256 is distinct from p_stale_built_tree
			)
		) then
		if p_kind = 'preview' then
			update public.qorpera_surface_previews set build_id = v_build.id where id = v_preview.id;
		else
			update public.qorpera_surface_jobs set build_id = v_build.id where id = v_job.id;
		end if;
		return jsonb_build_object(
			'state', 'built',
			'buildId', v_build.id,
			'builtTreeSha', v_build.built_tree_sha,
			'manifestSha256', v_build.manifest_sha256,
			'manifestJson', v_build.manifest_json,
			'fileCount', v_build.file_count,
			'totalBytes', v_build.total_bytes,
			'hasCredentialInputs', v_build.has_credential_inputs
		);
	end if;

	if public.qorpera_company_coding_at_zero(v_surface.profile_id, v_now) then
		v_detail := public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_NO_HOURS', 'The company has no computer hours left, so the build did not run.');
		perform public.qorpera_surface_build_waiter_fail(p_kind, p_id, v_detail);
		return jsonb_build_object('state', 'failed', 'buildId', v_build.id, 'errorDetail', v_detail);
	end if;

	insert into public.qorpera_surface_preview_builders(profile_id, surface_id, member_user_id)
	values (v_surface.profile_id, v_surface.id, v_member)
	on conflict (surface_id, member_user_id) do nothing;
	select * into v_builder from public.qorpera_surface_preview_builders
	where surface_id = v_surface.id and member_user_id = v_member;

	if v_build.id is null then
		insert into public.qorpera_surface_preview_builds(
			profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256
		)
		values (
			v_surface.profile_id, v_surface.id, v_builder.id, coalesce(v_surface.repository_key, 'surfaces/' || lower(v_surface.slug)),
			p_commit_sha, p_tree_sha, p_recipe, v_recipe_sha
		)
		returning * into v_build;
	elsif v_build.state in ('built', 'failed', 'dropped') then
		update public.qorpera_surface_preview_builds
		set state = 'queued', builder_id = v_builder.id, commit_sha = p_commit_sha, built_tree_sha = null,
			manifest_sha256 = null, manifest_json = null, file_count = null, total_bytes = null, has_credential_inputs = false,
			error_detail = null, worker_id = null, worker_sequence = null, attempts = 0, queued_at = v_now,
			started_at = null, finished_at = null, updated_at = v_now
		where id = v_build.id
		returning * into v_build;
	end if;

	if p_kind = 'preview' then
		update public.qorpera_surface_previews
		set build_id = v_build.id, lease_token = null, lease_expires_at = null, error_detail = null, updated_at = v_now
		where id = v_preview.id;
	else
		update public.qorpera_surface_jobs
		set
			build_id = v_build.id,
			payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{requestedHeadSha}', to_jsonb(p_commit_sha), true),
			lease_token = null,
			lease_expires_at = null,
			updated_at = v_now
		where id = v_job.id;
	end if;

	for v_old in
		select * from public.qorpera_surface_preview_builds b
		where b.builder_id = v_build.builder_id and b.state = 'queued' and b.id <> v_build.id
		order by b.queued_at, b.id
		for update skip locked
	loop
		if not exists (
			select 1 from public.qorpera_surface_jobs j
			where j.build_id = v_old.id and j.kind = 'publish_surface' and j.status = 'running' and j.lease_token is null
		) and not exists (
			select 1 from public.qorpera_surface_previews p
			where p.build_id = v_old.id and p.status = 'building' and p.lease_token is null
				and public.qorpera_surface_preview_selected(p.id)
		) then
			update public.qorpera_surface_preview_builds
			set state = 'dropped', finished_at = v_now, updated_at = v_now
			where id = v_old.id;
			perform public.qorpera_surface_preview_build_settle(v_old.id);
		end if;
	end loop;

	if v_build.state = 'queued' then
		select * into v_builder from public.qorpera_surface_preview_builders where id = v_build.builder_id;
		v_kick := public.qorpera_surface_preview_builder_kick(v_builder.id);
		perform public.qorpera_surface_preview_kick_failed(v_builder.id, v_kick);
		select * into v_build from public.qorpera_surface_preview_builds where id = v_build.id;
		if v_build.state = 'failed' then
			return jsonb_build_object('state', 'failed', 'buildId', v_build.id, 'errorDetail', v_build.error_detail);
		end if;
	end if;
	return jsonb_build_object('state', 'waiting', 'buildId', v_build.id);
end $$;

create or replace function public.qorpera_begin_surface_preview_build(p_worker_id uuid, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_now timestamptz := clock_timestamp();
	v_hold text;
begin
	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into v_builder from public.qorpera_surface_preview_builders where worker_id = p_worker_id for update;
	if v_builder.id is null then
		raise exception 'Coding session is not a preview builder' using errcode = '42501';
	end if;
	if v_session.phase <> 'preparing' or v_worker.state <> 'active' then
		raise exception 'Preview build turn is not preparing' using errcode = '55000';
	end if;

	update public.qorpera_surface_preview_builds
	set state = 'queued', worker_id = null, worker_sequence = null, started_at = null, queued_at = v_now, updated_at = v_now
	where builder_id = v_builder.id and state = 'running';

	v_hold := public.qorpera_surface_preview_builder_hold(v_builder.id, v_now);
	if v_hold <> 'go' then
		return jsonb_build_object('state', v_hold);
	end if;
	select * into v_build from public.qorpera_surface_preview_builds
	where builder_id = v_builder.id and state = 'queued'
	order by queued_at, id
	limit 1
	for update skip locked;
	if v_build.id is null then
		return jsonb_build_object('state', 'none');
	end if;

	update public.qorpera_surface_preview_builds
	set state = 'running', worker_id = v_worker.id, worker_sequence = v_worker.sequence, started_at = v_now,
		attempts = attempts + 1, updated_at = v_now
	where id = v_build.id
	returning * into v_build;

	select * into v_surface from public.qorpera_surfaces where id = v_build.surface_id;

	return jsonb_build_object(
		'state', 'build',
		'build', jsonb_build_object(
			'buildId', v_build.id,
			'surfaceId', v_build.surface_id,
			'surfaceTitle', v_surface.title,
			'repositoryKey', v_build.repository_key,
			'commitSha', v_build.commit_sha,
			'treeSha', v_build.tree_sha,
			'recipe', v_build.recipe,
			'attempt', v_build.attempts,
			'productFolderRoots', to_jsonb(public.qorpera_surface_shared_product_folder_roots(v_build.profile_id))
		)
	);
end $$;

drop function public.qorpera_complete_surface_preview_build(uuid, uuid, uuid, text, text, text);
create function public.qorpera_complete_surface_preview_build(
	p_worker_id uuid,
	p_lease_token uuid,
	p_build_id uuid,
	p_outcome text,
	p_built_tree_sha text default null,
	p_error_detail text default null,
	p_manifest_sha256 text default null,
	p_manifest_json jsonb default null,
	p_file_count integer default null,
	p_total_bytes bigint default null,
	p_has_credential_inputs boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_has_manifest boolean := p_manifest_sha256 is not null or p_manifest_json is not null;
	v_now timestamptz := clock_timestamp();
	v_kick text;
begin
	if p_outcome not in ('built', 'failed', 'none')
		or (p_outcome = 'none') <> (p_build_id is null)
		or (p_outcome = 'built') <> (p_built_tree_sha is not null or v_has_manifest)
		or (p_built_tree_sha is not null and p_built_tree_sha !~ '^[0-9a-f]{40}$')
		or (v_has_manifest and (
			p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
			or jsonb_typeof(coalesce(p_manifest_json, 'null'::jsonb)) <> 'object'
			or p_file_count is null or p_file_count not between 1 and 10000
			or p_total_bytes is null or p_total_bytes not between 0 and 536870912
		))
		or (p_outcome = 'failed') <> (p_error_detail is not null)
		or (p_error_detail is not null and (char_length(p_error_detail) > 1000 or p_error_detail !~ '^PREVIEW_BUILD_[A-Z_]{1,40}\n')) then
		raise exception 'Preview build result is invalid' using errcode = '22023';
	end if;
	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into v_builder from public.qorpera_surface_preview_builders where worker_id = p_worker_id for update;
	if v_builder.id is null then
		raise exception 'Coding session is not a preview builder' using errcode = '42501';
	end if;

	if p_build_id is not null then
		select * into v_build from public.qorpera_surface_preview_builds where id = p_build_id for update;
		if v_build.id is null or v_build.builder_id <> v_builder.id or v_build.state <> 'running'
			or v_build.worker_id is distinct from p_worker_id or v_build.worker_sequence is distinct from v_worker.sequence then
			raise exception 'Preview build is not running in this turn' using errcode = '55000';
		end if;
		if p_outcome = 'built' then
			update public.qorpera_surface_preview_builds
			set state = 'built',
				built_tree_sha = p_built_tree_sha,
				manifest_sha256 = p_manifest_sha256,
				manifest_json = p_manifest_json,
				file_count = p_file_count,
				total_bytes = p_total_bytes,
				has_credential_inputs = coalesce(p_has_credential_inputs, false),
				error_detail = null,
				worker_id = null,
				worker_sequence = null,
				started_at = null,
				finished_at = v_now,
				updated_at = v_now
			where id = v_build.id;
			perform public.qorpera_surface_preview_build_settle(v_build.id);
		else
			perform public.qorpera_surface_preview_build_fail(v_build.id, p_error_detail);
			perform public.qorpera_surface_build_hand_back(v_build.id);
		end if;
	end if;

	perform public.qorpera_complete_coding_turn(
		p_worker_id, p_lease_token,
		case when p_outcome = 'failed' then 'failed' else 'succeeded' end,
		case p_outcome when 'built' then 'Built the interface preview.' when 'failed' then 'The interface preview build failed.'
			else 'No interface preview was waiting to be built.' end
	);

	if exists (select 1 from public.qorpera_surface_preview_builds b where b.builder_id = v_builder.id and b.state = 'queued') then
		v_kick := public.qorpera_surface_preview_builder_kick(v_builder.id);
		perform public.qorpera_surface_preview_kick_failed(v_builder.id, v_kick);
	end if;
	return jsonb_build_object('workerId', p_worker_id, 'outcome', p_outcome);
end $$;
revoke all on function public.qorpera_complete_surface_preview_build(uuid, uuid, uuid, text, text, text, text, jsonb, integer, bigint, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_surface_preview_build(uuid, uuid, uuid, text, text, text, text, jsonb, integer, bigint, boolean)
	to service_role;

drop function pg_temp.snep_patch(regprocedure, text[]);

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
			'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
			'public.qorpera_mint_surface_preview_pass(uuid)'::regprocedure,
			'public.qorpera_surface_preview_kept_frame(public.qorpera_surface_previews,uuid,public.qorpera_company_sites)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Patched surface preview function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_preview_slot_host(text, integer), public.qorpera_surface_mint_preview_pass(uuid, uuid, text, uuid) to %I',
			v_owner
		);
	end loop;
end $$;
