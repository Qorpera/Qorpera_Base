set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_get_surface_app_runtime_config(uuid)') is not null then
		raise exception '20260930936000_surface_app_secrets_and_auth_unblock is already applied';
	end if;
	if to_regclass('public.qorpera_company_sites') is null
		or to_regclass('public.qorpera_company_site_domains') is null
		or to_regclass('public.qorpera_app_secret_grants') is null
		or to_regprocedure('public.qorpera_set_company_site_public(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_remove_company_site_domain(uuid)') is null
		or to_regprocedure('public.qorpera_web_deployment_promote(uuid,uuid,text,uuid)') is null
		or to_regprocedure('public.qorpera_web_sync_live_deployment()') is null
		or to_regprocedure('public.qorpera_code_site_for_auto_redeploy(text,text,uuid,text,text,integer)') is null
		or to_regprocedure('public.qorpera_code_site_auto_redeploy_switch(text,text,uuid,uuid,uuid,text,text)') is null
		or to_regprocedure('public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)') is null then
		raise exception '20260930936000 requires surface app host server hosting (20260930935000)';
	end if;
end $$;

alter table public.qorpera_company_sites
	add column runtime_env_config jsonb not null default '{}'::jsonb
		check (jsonb_typeof(runtime_env_config) = 'object' and pg_column_size(runtime_env_config) <= 32768),
	add column linked_database_name text
		check (
			linked_database_name is null
			or (
				linked_database_name ~ '^[a-z][a-z0-9_]{0,39}$'
				and linked_database_name <> 'qorpera'
				and linked_database_name !~ '^(pg_|qorpera_)'
			)
		);

create function public.qorpera_site_credential_inputs_blocked(
	p_site_id uuid,
	p_deployment_kind text,
	p_has_credential_inputs boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(p_has_credential_inputs, false)
		and coalesce(nullif(btrim(coalesce(p_deployment_kind, '')), ''), 'static') = 'static'
		and not exists (
			select 1
			from public.qorpera_company_site_domains as dom
			where dom.site_id = p_site_id
				and dom.status in ('dns_verified', 'tls_active')
		)
$$;

revoke all on function public.qorpera_site_credential_inputs_blocked(uuid, text, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create temp table sasa_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_set_company_site_public(uuid,boolean)'::regprocedure,
		'public.qorpera_remove_company_site_domain(uuid)'::regprocedure,
		'public.qorpera_web_deployment_promote(uuid,uuid,text,uuid)'::regprocedure,
		'public.qorpera_web_sync_live_deployment()'::regprocedure,
		'public.qorpera_code_site_for_auto_redeploy(text,text,uuid,text,text,integer)'::regprocedure,
		'public.qorpera_code_site_auto_redeploy_switch(text,text,uuid,uuid,uuid,text,text)'::regprocedure,
		'public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)'::regprocedure
	]);

create function pg_temp.sasa_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_found integer;
begin
	for i in 1..cardinality(p_pairs) / 2 loop
		v_found := (length(v_def) - length(replace(v_def, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930936000 anchor found % time(s) in %, expected 1: %',
				v_found, p_target::text, left(p_pairs[2 * i - 1], 120);
		end if;
		v_def := replace(v_def, p_pairs[2 * i - 1], p_pairs[2 * i]);
	end loop;
	execute v_def;
end $$;

select pg_temp.sasa_patch('public.qorpera_set_company_site_public(uuid,boolean)', array[
	$old$			if coalesce(v_dep.has_credential_inputs, false) then
				raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
			end if;$old$,
	$new$			if public.qorpera_site_credential_inputs_blocked(v_site.id, v_dep.kind, v_dep.has_credential_inputs) then
				raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
			end if;$new$
]);

select pg_temp.sasa_patch('public.qorpera_web_deployment_promote(uuid,uuid,text,uuid)', array[
	$old$	if v_site.is_public and coalesce(v_dep.has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;$old$,
	$new$	if v_site.is_public and public.qorpera_site_credential_inputs_blocked(v_site.id, v_dep.kind, v_dep.has_credential_inputs) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;$new$
]);

select pg_temp.sasa_patch('public.qorpera_web_sync_live_deployment()', array[
	$old$	if new.is_public and coalesce(v_dep.has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;$old$,
	$new$	if new.is_public and public.qorpera_site_credential_inputs_blocked(new.id, v_dep.kind, v_dep.has_credential_inputs) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;$new$
]);

select pg_temp.sasa_patch('public.qorpera_code_site_auto_redeploy_switch(text,text,uuid,uuid,uuid,text,text)', array[
	$old$	if v_site.is_public and coalesce(v_dep.has_credential_inputs, false) then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_CONTAINS_CREDENTIAL_INPUTS');
	end if;$old$,
	$new$	if v_site.is_public and public.qorpera_site_credential_inputs_blocked(v_site.id, v_dep.kind, v_dep.has_credential_inputs) then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_CONTAINS_CREDENTIAL_INPUTS');
	end if;$new$
]);

select pg_temp.sasa_patch('public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)', array[
	$old$	if (coalesce(p_promote_live, false) or coalesce(p_check_public_promote, false))
		and v_site.is_public
		and coalesce(p_has_credential_inputs, false) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;$old$,
	$new$	if (coalesce(p_promote_live, false) or coalesce(p_check_public_promote, false))
		and v_site.is_public
		and public.qorpera_site_credential_inputs_blocked(v_site.id, v_kind, p_has_credential_inputs) then
		raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
	end if;$new$
]);

select pg_temp.sasa_patch('public.qorpera_remove_company_site_domain(uuid)', array[
	$old$declare v_dom public.qorpera_company_site_domains%rowtype;
	v_role public.qorpera_profile_role;$old$,
	$new$declare v_dom public.qorpera_company_site_domains%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_role public.qorpera_profile_role;$new$,
	$old$	select dom.* into v_dom from public.qorpera_company_site_domains as dom where dom.id = p_domain_id for update;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_dom.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	delete from public.qorpera_company_site_domains where id = v_dom.id;$old$,
	$new$	select dom.* into v_dom from public.qorpera_company_site_domains as dom where dom.id = p_domain_id;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_dom.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site where site.id = v_dom.site_id for update;
	select dom.* into v_dom from public.qorpera_company_site_domains as dom where dom.id = p_domain_id for update;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	if v_dom.status in ('dns_verified', 'tls_active')
		and v_site.id is not null
		and v_site.is_public
		and v_site.live_deployment_id is not null then
		select dep.* into v_dep from public.qorpera_company_site_deployments as dep where dep.id = v_site.live_deployment_id;
		if coalesce(v_dep.has_credential_inputs, false)
			and coalesce(v_dep.kind, 'static') = 'static'
			and not exists (
				select 1
				from public.qorpera_company_site_domains as other
				where other.site_id = v_site.id
					and other.id <> v_dom.id
					and other.status in ('dns_verified', 'tls_active')
			) then
			raise exception 'SITE_CONTAINS_CREDENTIAL_INPUTS' using errcode = '22023';
		end if;
	end if;
	delete from public.qorpera_company_site_domains where id = v_dom.id;$new$
]);

select pg_temp.sasa_patch('public.qorpera_code_site_for_auto_redeploy(text,text,uuid,text,text,integer)', array[
	$old$		'vcpuLimit', coalesce((v_site_spec ->> 'vcpuLimit')::numeric, v_dep.vcpu_limit, 1.00)
	);$old$,
	$new$		'vcpuLimit', coalesce((v_site_spec ->> 'vcpuLimit')::numeric, v_dep.vcpu_limit, 1.00),
		'runtimeEnvConfig', v_site.runtime_env_config,
		'linkedDatabaseName', v_site.linked_database_name
	);$new$
]);

create function public.qorpera_get_surface_app_runtime_config(p_surface_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_role public.qorpera_profile_role;
	v_env_id uuid;
	v_grants jsonb := '[]'::jsonb;
	v_available jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Authentication required' using errcode = '42501';
	end if;
	if p_surface_id is null then
		raise exception 'Surface id is required' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, false);
	v_role := public.qorpera_member_role(v_surface.profile_id);

	if v_surface.site_id is not null then
		select * into v_site
		from public.qorpera_company_sites
		where id = v_surface.site_id and profile_id = v_surface.profile_id;
	end if;

	v_env_id := coalesce(
		v_site.environment_id,
		(
			select env.id
			from public.qorpera_company_environments as env
			where env.profile_id = v_surface.profile_id
			order by env.created_at asc, env.id asc
			limit 1
		)
	);

	if v_site.id is not null then
		v_grants := coalesce(public.qorpera_list_app_secrets(v_surface.profile_id, v_site.id), '[]'::jsonb);
	end if;

	if v_env_id is not null then
		select coalesce(
			jsonb_agg(
				jsonb_build_object(
					'secretId', secret.id,
					'name', upper(secret.secret_name),
					'purpose', secret.purpose,
					'version', secret.current_version
				)
				order by secret.secret_name, secret.id
			),
			'[]'::jsonb
		)
		into v_available
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_surface.profile_id
			and secret.environment_id = v_env_id
			and secret.owner_kind = 'company'
			and secret.connector_id = 'environment'
			and secret.status = 'active'
			and public.qorpera_coding_environment_name_allowed(secret.secret_name);
	end if;

	return jsonb_build_object(
		'schema', 'qorpera.surface-app-runtime-config/v1',
		'surfaceId', v_surface.id,
		'profileId', v_surface.profile_id,
		'siteId', v_site.id,
		'slug', v_site.slug,
		'deploymentKind', v_site.deployment_kind,
		'runtimeEnvConfig', coalesce(v_site.runtime_env_config, '{}'::jsonb),
		'linkedDatabaseName', v_site.linked_database_name,
		'canManage', coalesce(v_role in ('owner', 'admin'), false),
		'grants', v_grants,
		'availableSecrets', v_available
	);
end $$;

revoke all on function public.qorpera_get_surface_app_runtime_config(uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_get_surface_app_runtime_config(uuid)
	to authenticated;

create function public.qorpera_set_surface_app_runtime_config(
	p_surface_id uuid,
	p_runtime_env_config jsonb,
	p_linked_database_name text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
	v_user_id uuid := auth.uid();
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_role public.qorpera_profile_role;
	v_clean_env jsonb := '{}'::jsonb;
	v_entry record;
	v_val text;
	v_count integer := 0;
	v_db_name text := nullif(btrim(coalesce(p_linked_database_name, '')), '');
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'Only founders and admins manage app runtime settings' using errcode = '42501';
	end if;
	if p_surface_id is null or p_runtime_env_config is null or jsonb_typeof(p_runtime_env_config) <> 'object' then
		raise exception 'App runtime configuration must be a JSON object' using errcode = '22023';
	end if;
	if pg_column_size(p_runtime_env_config) > 32768 then
		raise exception 'App runtime configuration exceeds size limit' using errcode = '22023';
	end if;
	if v_db_name is not null and (
		v_db_name !~ '^[a-z][a-z0-9_]{0,39}$'
		or v_db_name = 'qorpera'
		or v_db_name ~ '^(pg_|qorpera_)'
	) then
		raise exception 'Linked database name is invalid' using errcode = '22023';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	v_role := public.qorpera_member_role(v_surface.profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage app runtime settings' using errcode = '42501';
	end if;

	perform 1 from public.qorpera_profiles as profile where profile.id = v_surface.profile_id for key share;
	select member.role into v_role
	from public.qorpera_profile_members as member
	where member.profile_id = v_surface.profile_id and member.user_id = v_user_id
	for share;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage app runtime settings' using errcode = '42501';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	if v_surface.source_kind <> 'code_repo' then
		raise exception 'Only code-backed interfaces support runtime configuration' using errcode = '22023';
	end if;
	if v_surface.site_id is null then
		raise exception 'Hosted app site not found for surface' using errcode = 'P0002';
	end if;

	select * into v_site
	from public.qorpera_company_sites
	where id = v_surface.site_id and profile_id = v_surface.profile_id
	for update;
	if v_site.id is null then
		raise exception 'Hosted app site not found for surface' using errcode = 'P0002';
	end if;
	if v_site.taken_down_at is not null then
		raise exception 'SITE_TAKEN_DOWN' using errcode = '42501';
	end if;
	if public.qorpera_company_deleting(v_site.profile_id) then
		raise exception 'Company is deleting' using errcode = '55000';
	end if;

	for v_entry in select key, value from jsonb_each(p_runtime_env_config) order by key loop
		v_count := v_count + 1;
		if v_count > 64 then
			raise exception 'App runtime configuration allows at most 64 variables' using errcode = '22023';
		end if;
		if v_entry.key !~ '^[A-Z][A-Z0-9_]{0,63}$'
			or not public.qorpera_coding_environment_name_allowed(lower(v_entry.key))
			or v_entry.key in ('PORT', 'NODE_ENV', 'DATABASE_URL') then
			raise exception 'Runtime environment variable name is not allowed: %', v_entry.key using errcode = '22023';
		end if;
		if jsonb_typeof(v_entry.value) <> 'string' then
			raise exception 'Runtime environment variable values must be strings' using errcode = '22023';
		end if;
		v_val := v_entry.value #>> '{}';
		if char_length(v_val) > 4096 or v_val ~ '[[:cntrl:]]' then
			raise exception 'Runtime environment variable value is invalid for %', v_entry.key using errcode = '22023';
		end if;
		v_clean_env := v_clean_env || jsonb_build_object(v_entry.key, v_val);
	end loop;

	if pg_column_size(v_clean_env) > 32768 then
		raise exception 'App runtime configuration exceeds size limit' using errcode = '22023';
	end if;

	update public.qorpera_company_sites
	set
		runtime_env_config = v_clean_env,
		linked_database_name = v_db_name,
		updated_at = clock_timestamp()
	where id = v_site.id;

	return public.qorpera_get_surface_app_runtime_config(p_surface_id);
end $$;

revoke all on function public.qorpera_set_surface_app_runtime_config(uuid, jsonb, text)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_set_surface_app_runtime_config(uuid, jsonb, text)
	to authenticated;

create function public.qorpera_surface_site_runtime_config(p_surface_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_has_dev_secrets boolean := false;
	v_has_prod_secrets boolean := false;
begin
	if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role') then
		raise exception 'Surface site runtime config requires service_role' using errcode = '42501';
	end if;
	if p_surface_id is null then
		raise exception 'Surface id is required' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null or v_surface.site_id is null then
		return jsonb_build_object('schema', 'qorpera.surface-site-runtime-config/v1', 'found', false);
	end if;
	select * into v_site
	from public.qorpera_company_sites
	where id = v_surface.site_id and profile_id = v_surface.profile_id;
	if v_site.id is null then
		return jsonb_build_object('schema', 'qorpera.surface-site-runtime-config/v1', 'found', false);
	end if;

	select
		coalesce(bool_or(app_grant.target_env = 'dev'), false),
		coalesce(bool_or(app_grant.target_env = 'prod'), false)
	into v_has_dev_secrets, v_has_prod_secrets
	from public.qorpera_app_secret_grants as app_grant
	join public.qorpera_cloud_secrets as secret on secret.id = app_grant.secret_id
	join public.qorpera_profile_members as issuer
		on issuer.profile_id = app_grant.profile_id
		and issuer.user_id = app_grant.issued_by_user_id
		and issuer.role in ('owner', 'admin')
	where app_grant.profile_id = v_site.profile_id
		and app_grant.site_id = v_site.id
		and app_grant.status = 'active'
		and app_grant.scope = 'runtime'
		and secret.connector_id = 'environment'
		and secret.owner_kind = 'company'
		and secret.status = 'active'
		and public.qorpera_coding_environment_name_allowed(secret.secret_name);

	return jsonb_build_object(
		'schema', 'qorpera.surface-site-runtime-config/v1',
		'found', true,
		'surfaceId', v_surface.id,
		'siteId', v_site.id,
		'slug', v_site.slug,
		'runtimeEnvConfig', v_site.runtime_env_config,
		'linkedDatabaseName', v_site.linked_database_name,
		'hasRuntimeDevSecrets', v_has_dev_secrets,
		'hasRuntimeProdSecrets', v_has_prod_secrets
	);
end $$;

revoke all on function public.qorpera_surface_site_runtime_config(uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_surface_site_runtime_config(uuid)
	to service_role;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid in (select oid from sasa_before)
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930936000: patched function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_site_credential_inputs_blocked(uuid, text, boolean) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc p
	join sasa_before b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930936000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.sasa_patch(regprocedure, text[]);
drop table sasa_before;
