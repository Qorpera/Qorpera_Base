set local lock_timeout = '3s';

do $$
begin
	if to_regclass('public.qorpera_app_secret_grants') is not null then
		raise exception '20260930850000 (app vault secrets and code routines) is already applied';
	end if;
	if to_regclass('public.qorpera_coding_environment_grants') is null
		or to_regclass('public.qorpera_company_sites') is null
		or to_regprocedure('public.qorpera_read_coding_turn_context(jsonb)') is null
		or to_regprocedure('public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)') is null
		or to_regprocedure('public.qorpera_coding_owner_problem(uuid,uuid,text,uuid)') is null then
		raise exception '20260930850000 requires coding environment secrets, company sites, and folder routines';
	end if;
end $$;

create function pg_temp.w6c_patch(p_target regprocedure, p_edits text[])
returns void
language plpgsql
as $patch$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
	v_index integer;
begin
	for v_index in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * v_index - 1], '')))
			/ length(p_edits[2 * v_index - 1]);
		if v_found <> 1 then
			raise exception '20260930850000 anchor mismatch in % (% hits): %',
				p_target, v_found, left(p_edits[2 * v_index - 1], 100);
		end if;
		v_definition := replace(v_definition, p_edits[2 * v_index - 1], p_edits[2 * v_index]);
	end loop;
	execute v_definition;
end
$patch$;

create or replace function public.qorpera_coding_environment_name_allowed(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select coalesce(p_name ~ '^[a-z][a-z0-9_]{0,63}$'
		and p_name !~ '^(lc|git|ld|dyld|qorpera|ssh|xdg|docker|claude|codex)_'
		and p_name <> all (array[
			'home', 'path', 'tmpdir', 'tmp', 'temp', 'user', 'logname', 'shell', 'pwd', 'oldpwd', 'term', 'colorterm',
			'columns', 'lines', 'lang', 'language', 'tz', 'bash_env', 'env', 'ifs', 'ps1', 'ps2', 'ps4', 'prompt_command',
			'shellopts', 'bashopts', 'cdpath', 'globignore', 'hostname', 'shlvl', 'mail', 'mailpath', 'http_proxy',
			'https_proxy', 'no_proxy', 'all_proxy', 'ftp_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'node_extra_ca_certs'
		]), false)
$$;

alter table public.qorpera_coding_environment_grants
	add column scope text not null default 'all' check (scope in ('all', 'build', 'test', 'runtime')),
	add column target_env text not null default 'all' check (target_env in ('all', 'dev', 'test', 'prod')),
	add column site_id uuid references public.qorpera_company_sites(id) on delete cascade;

create function public.qorpera_set_coding_environment_grant_scope(
	p_profile_id uuid,
	p_grant_id uuid,
	p_scope text,
	p_target_env text,
	p_site_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_grant public.qorpera_coding_environment_grants%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501';
	end if;
	if coalesce(p_scope, '') not in ('all', 'build', 'test', 'runtime') then
		raise exception 'coding environment grant scope is invalid' using errcode = '22023';
	end if;
	if coalesce(p_target_env, '') not in ('all', 'dev', 'test', 'prod') then
		raise exception 'coding environment grant target environment is invalid' using errcode = '22023';
	end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501';
	end if;
	select environment_grant.* into v_grant from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.id = p_grant_id and environment_grant.profile_id = p_profile_id
		and environment_grant.status = 'active' for update;
	if v_grant.id is null then
		raise exception 'coding environment grant is unavailable' using errcode = '42501';
	end if;
	if p_site_id is not null and not exists (
		select 1 from public.qorpera_company_sites as site
		where site.id = p_site_id and site.profile_id = p_profile_id
			and site.environment_id = v_grant.environment_id
	) then
		raise exception 'hosted app site is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_coding_environment_grants
	set scope = p_scope, target_env = p_target_env, site_id = p_site_id
	where id = v_grant.id
	returning * into v_grant;
	return jsonb_build_object(
		'schema', 'qorpera.coding-environment-grant-scope/v1',
		'grantId', v_grant.id,
		'secretId', v_grant.secret_id,
		'repository', v_grant.repository,
		'scope', v_grant.scope,
		'targetEnv', v_grant.target_env,
		'siteId', v_grant.site_id,
		'status', v_grant.status
	);
end
$$;

select pg_temp.w6c_patch('public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure, array[
	$old$		where environment_grant.profile_id = v_session.profile_id
			and environment_grant.environment_id = v_session.environment_id
			and environment_grant.repository = v_repository and environment_grant.status = 'active'$old$,
	$new$		where environment_grant.profile_id = v_session.profile_id
			and environment_grant.environment_id = v_session.environment_id
			and environment_grant.repository = v_repository and environment_grant.status = 'active'
			and environment_grant.scope in ('all', 'build', 'test')
			and environment_grant.target_env in ('all', 'dev', 'test')$new$,
	$old$				where environment_grant.id = any(v_grant_ids) and environment_grant.secret_id = secret.id
					and environment_grant.repository = v_repository and environment_grant.status = 'active'$old$,
	$new$				where environment_grant.id = any(v_grant_ids) and environment_grant.secret_id = secret.id
					and environment_grant.repository = v_repository and environment_grant.status = 'active'
					and environment_grant.scope in ('all', 'build', 'test')
					and environment_grant.target_env in ('all', 'dev', 'test')$new$
]);

select pg_temp.w6c_patch('public.qorpera_read_coding_turn_context(jsonb)'::regprocedure, array[
	$old$	v_session public.qorpera_coding_sessions%rowtype; v_running jsonb; v_stopped jsonb; v_new_disk boolean;$old$,
	$new$	v_session public.qorpera_coding_sessions%rowtype; v_running jsonb; v_stopped jsonb; v_new_disk boolean;
	v_secret_names jsonb; v_owner_user_id uuid; v_repository text;$new$,
	$old$	return jsonb_build_object('schema','qorpera.coding-turn-context/v2','workerId',v_worker_id,'sequence',v_sequence,$old$,
	$new$	select worker.owner_user_id into v_owner_user_id from public.qorpera_runtime_workers as worker
	where worker.id = v_worker_id;
	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));
	select coalesce(jsonb_agg(names.secret_name order by names.secret_name), '[]'::jsonb) into v_secret_names
	from (
		select distinct upper(secret.secret_name) as secret_name
		from public.qorpera_cloud_secrets as secret
		join public.qorpera_cloud_secret_broker_authorities as authority
			on authority.id = secret.broker_authority_id and authority.status = 'active'
		where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
			and secret.connector_id = 'environment' and secret.status = 'active'
			and public.qorpera_coding_environment_name_allowed(secret.secret_name)
			and (
				(secret.owner_kind = 'member' and secret.owner_user_id = v_owner_user_id)
				or (secret.owner_kind = 'company' and exists (
					select 1 from public.qorpera_coding_environment_grants as environment_grant
					join public.qorpera_profile_members as issuer
						on issuer.profile_id = environment_grant.profile_id
						and issuer.user_id = environment_grant.issued_by_user_id
						and issuer.role in ('owner', 'admin')
					where environment_grant.secret_id = secret.id
						and environment_grant.profile_id = v_session.profile_id
						and environment_grant.environment_id = v_session.environment_id
						and environment_grant.repository = v_repository
						and environment_grant.status = 'active'
						and environment_grant.scope in ('all', 'build', 'test')
						and environment_grant.target_env in ('all', 'dev', 'test')
				))
			)
	) as names;
	return jsonb_build_object('schema','qorpera.coding-turn-context/v2','workerId',v_worker_id,'sequence',v_sequence,$new$,
	$old$		'machine', jsonb_build_object('newDisk', v_new_disk));$old$,
	$new$		'machine', jsonb_build_object('newDisk', v_new_disk),
		'secretNames', v_secret_names);$new$
]);

create table public.qorpera_app_secret_grants (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	secret_id uuid not null references public.qorpera_cloud_secrets(id) on delete restrict,
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	scope text not null default 'runtime' check (scope in ('build', 'test', 'runtime')),
	target_env text not null default 'prod' check (target_env in ('dev', 'prod')),
	issued_by_user_id uuid not null references auth.users(id) on delete restrict,
	status text not null default 'active' check (status in ('active', 'revoked')),
	created_at timestamptz not null default statement_timestamp(),
	revoked_at timestamptz,
	revoked_by_user_id uuid references auth.users(id) on delete restrict,
	check ((status = 'revoked') = (revoked_at is not null)),
	check (status = 'revoked' or revoked_by_user_id is null)
);

create unique index qorpera_app_secret_grants_active
	on public.qorpera_app_secret_grants (secret_id, site_id, scope, target_env) where status = 'active';
create index qorpera_app_secret_grants_site
	on public.qorpera_app_secret_grants (profile_id, environment_id, site_id, scope, target_env) where status = 'active';
create index qorpera_app_secret_grants_issuer
	on public.qorpera_app_secret_grants (profile_id, issued_by_user_id) where status = 'active';
alter table public.qorpera_app_secret_grants enable row level security;
revoke all on table public.qorpera_app_secret_grants
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

do $$
declare v_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g')
		with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	if v_types is null or not ('environment_secret_used' = any(v_types)) or ('app_secret_used' = any(v_types)) then
		raise exception '20260930850000: unexpected audit event types: %', v_types;
	end if;
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types || array['app_secret_grant_issued', 'app_secret_grant_revoked', 'app_secret_used'])
				with ordinality as u(t, o)));
end $$;

create function public.qorpera_revoke_app_secret_grants_on_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op = 'UPDATE' and new.role in ('owner', 'admin') then return new; end if;
	with revoked as (
		update public.qorpera_app_secret_grants as app_grant
		set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = auth.uid()
		where app_grant.profile_id = old.profile_id and app_grant.issued_by_user_id = old.user_id
			and app_grant.status = 'active'
		returning app_grant.*
	)
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id, environment_id, secret_id, secret_version, grant_id, event_type, actor_user_id, connector_id
	)
	select revoked.profile_id, revoked.environment_id, revoked.secret_id, secret.current_version, revoked.id,
		'app_secret_grant_revoked', auth.uid(), secret.connector_id
	from revoked join public.qorpera_cloud_secrets as secret on secret.id = revoked.secret_id;
	update public.qorpera_code_repositories
	set auto_redeploy_enabled = false,
		auto_redeploy_enabled_by_user_id = null,
		auto_redeploy_enabled_at = null
	where profile_id = old.profile_id
		and auto_redeploy_enabled_by_user_id = old.user_id
		and auto_redeploy_enabled;
	if tg_op = 'DELETE' then return old; end if;
	return new;
end
$$;

create trigger qorpera_app_secret_grant_authority
after update of role or delete on public.qorpera_profile_members
for each row execute function public.qorpera_revoke_app_secret_grants_on_membership_change();

select pg_temp.w6c_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure, array[
	$old$	perform 1 from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.secret_id = p_secret_id and environment_grant.profile_id = p_profile_id
		and environment_grant.status = 'active'
	order by environment_grant.id for update;$old$,
	$new$	perform 1 from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.secret_id = p_secret_id and environment_grant.profile_id = p_profile_id
		and environment_grant.status = 'active'
	order by environment_grant.id for update;
	perform 1 from public.qorpera_app_secret_grants as app_grant
	where app_grant.secret_id = p_secret_id and app_grant.profile_id = p_profile_id
		and app_grant.status = 'active'
	order by app_grant.id for update;$new$,
	$old$		update public.qorpera_coding_environment_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';$old$,
	$new$		update public.qorpera_coding_environment_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';
		perform 1 from public.qorpera_app_secret_grants as app_grant
		where app_grant.secret_id = v_secret.id and app_grant.status = 'active'
		order by app_grant.id for update nowait;
		update public.qorpera_app_secret_grants
		set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';$new$
]);

select pg_temp.w6c_patch('public.qorpera_folder_member_change_enter(uuid,uuid,text)'::regprocedure, array[
	$old$	perform 1 from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.profile_id = p_profile_id and environment_grant.issued_by_user_id = p_user_id
		and environment_grant.status = 'active'
	order by environment_grant.id for no key update;$old$,
	$new$	perform 1 from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.profile_id = p_profile_id and environment_grant.issued_by_user_id = p_user_id
		and environment_grant.status = 'active'
	order by environment_grant.id for no key update;
	perform 1 from public.qorpera_app_secret_grants as app_grant
	where app_grant.profile_id = p_profile_id and app_grant.issued_by_user_id = p_user_id
		and app_grant.status = 'active'
	order by app_grant.id for no key update;$new$
]);

create function public.qorpera_grant_app_secret(
	p_profile_id uuid,
	p_secret_id uuid,
	p_site_id uuid,
	p_scope text default 'runtime',
	p_target_env text default 'prod'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_site public.qorpera_company_sites%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_grant public.qorpera_app_secret_grants%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'app secret grants need an owner or administrator' using errcode = '42501';
	end if;
	if coalesce(p_scope, '') not in ('build', 'test', 'runtime') then
		raise exception 'app secret scope must be build, test, or runtime' using errcode = '22023';
	end if;
	if coalesce(p_target_env, '') not in ('dev', 'prod') then
		raise exception 'app secret target environment must be dev or prod' using errcode = '22023';
	end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'app secret grants need an owner or administrator' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'app secret grants need an owner or administrator' using errcode = '42501';
	end if;
	select site.* into v_site from public.qorpera_company_sites as site
	where site.id = p_site_id and site.profile_id = p_profile_id for share;
	if v_site.id is null then
		raise exception 'hosted app site is unavailable' using errcode = '42501';
	end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;
	if v_secret.id is null or v_secret.environment_id <> v_site.environment_id
		or v_secret.owner_kind <> 'company' or v_secret.connector_id <> 'environment'
		or v_secret.status <> 'active' or not public.qorpera_coding_environment_name_allowed(v_secret.secret_name) then
		raise exception 'company environment secret is unavailable' using errcode = '42501';
	end if;
	select app_grant.* into v_grant from public.qorpera_app_secret_grants as app_grant
	where app_grant.secret_id = v_secret.id and app_grant.site_id = v_site.id
		and app_grant.scope = p_scope and app_grant.target_env = p_target_env
		and app_grant.status = 'active';
	if v_grant.id is null then
		insert into public.qorpera_app_secret_grants (
			profile_id, environment_id, secret_id, site_id, scope, target_env, issued_by_user_id
		) values (
			v_secret.profile_id, v_secret.environment_id, v_secret.id, v_site.id, p_scope, p_target_env, v_user_id
		) returning * into v_grant;
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id, environment_id, secret_id, secret_version, grant_id, event_type, actor_user_id, connector_id
		) values (
			v_secret.profile_id, v_secret.environment_id, v_secret.id, v_secret.current_version, v_grant.id,
			'app_secret_grant_issued', v_user_id, v_secret.connector_id
		);
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.app-secret-grant/v1',
		'grantId', v_grant.id,
		'secretId', v_grant.secret_id,
		'siteId', v_grant.site_id,
		'slug', v_site.slug,
		'name', upper(v_secret.secret_name),
		'scope', v_grant.scope,
		'targetEnv', v_grant.target_env,
		'issuedByUserId', v_grant.issued_by_user_id,
		'status', v_grant.status,
		'createdAt', v_grant.created_at
	);
end
$$;

create function public.qorpera_revoke_app_secret_grant(p_profile_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_grant public.qorpera_app_secret_grants%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'app secret grants need an owner or administrator' using errcode = '42501';
	end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'app secret grants need an owner or administrator' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'app secret grants need an owner or administrator' using errcode = '42501';
	end if;
	select app_grant.* into v_grant from public.qorpera_app_secret_grants as app_grant
	where app_grant.id = p_grant_id and app_grant.profile_id = p_profile_id for update;
	if v_grant.id is null then
		raise exception 'app secret grant is unavailable' using errcode = '42501';
	end if;
	if v_grant.status = 'active' then
		update public.qorpera_app_secret_grants
		set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = v_user_id
		where id = v_grant.id returning * into v_grant;
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id, environment_id, secret_id, secret_version, grant_id, event_type, actor_user_id, connector_id
		)
		select v_grant.profile_id, v_grant.environment_id, v_grant.secret_id, secret.current_version, v_grant.id,
			'app_secret_grant_revoked', v_user_id, secret.connector_id
		from public.qorpera_cloud_secrets as secret where secret.id = v_grant.secret_id;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.app-secret-grant/v1',
		'grantId', v_grant.id,
		'secretId', v_grant.secret_id,
		'siteId', v_grant.site_id,
		'scope', v_grant.scope,
		'targetEnv', v_grant.target_env,
		'issuedByUserId', v_grant.issued_by_user_id,
		'status', v_grant.status,
		'createdAt', v_grant.created_at
	);
end
$$;

create function public.qorpera_list_app_secrets(p_profile_id uuid, p_site_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select case
		when not public.qorpera_can_read_profile(p_profile_id)
			or not exists (select 1 from public.qorpera_company_sites as site
				where site.id = p_site_id and site.profile_id = p_profile_id)
		then '[]'::jsonb
		else coalesce((
			select jsonb_agg(jsonb_build_object(
				'schema', 'qorpera.app-secret-grant/v1',
				'grantId', app_grant.id,
				'secretId', secret.id,
				'siteId', app_grant.site_id,
				'name', upper(secret.secret_name),
				'scope', app_grant.scope,
				'targetEnv', app_grant.target_env,
				'version', secret.current_version,
				'issuedByUserId', app_grant.issued_by_user_id,
				'createdAt', app_grant.created_at
			) order by secret.secret_name, app_grant.scope, app_grant.target_env, app_grant.id)
			from public.qorpera_app_secret_grants as app_grant
			join public.qorpera_cloud_secrets as secret on secret.id = app_grant.secret_id
			join public.qorpera_profile_members as issuer
				on issuer.profile_id = app_grant.profile_id
				and issuer.user_id = app_grant.issued_by_user_id
				and issuer.role in ('owner', 'admin')
			where app_grant.profile_id = p_profile_id
				and app_grant.site_id = p_site_id
				and app_grant.status = 'active'
				and secret.connector_id = 'environment'
				and secret.owner_kind = 'company'
				and secret.status = 'active'
				and public.qorpera_coding_environment_name_allowed(secret.secret_name)
		), '[]'::jsonb)
	end
$$;

create function public.qorpera_authorize_app_secrets(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_site_id uuid,
	p_scope text default 'runtime',
	p_target_env text default 'prod',
	p_executor_owner text default null,
	p_machine_id_sha256 text default null,
	p_deployment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_grant_ids uuid[];
	v_secret_ids uuid[];
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_grant_id uuid;
	v_secrets jsonb := '[]'::jsonb;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if coalesce(p_broker_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_broker_authority_id is null or p_site_id is null
		or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'app secret request is invalid' using errcode = '22023';
	end if;
	if coalesce(p_scope, '') not in ('build', 'test', 'runtime') then
		raise exception 'app secret scope must be build, test, or runtime' using errcode = '22023';
	end if;
	if coalesce(p_target_env, '') not in ('dev', 'prod') then
		raise exception 'app secret target environment must be dev or prod' using errcode = '22023';
	end if;
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id
	) for key share;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	select site.* into v_site
	from public.qorpera_company_sites as site
	where site.id = p_site_id and site.profile_id = v_authority.profile_id for share;
	if v_site.id is null then
		raise exception 'hosted app site is unavailable to this broker' using errcode = '42501';
	end if;
	if not public.qorpera_code_care_holder(v_site.environment_id, p_executor_owner, p_machine_id_sha256) then
		raise exception 'hosted app site is unavailable to this executor' using errcode = '42501';
	end if;
	if p_scope = 'runtime' then
		if p_deployment_id is null or not exists (
			select 1 from public.qorpera_company_site_deployments as dep
			where dep.id = p_deployment_id
				and dep.site_id = v_site.id
				and dep.profile_id = v_site.profile_id
				and dep.state in ('building', 'ready', 'live')
		) then
			raise exception 'hosted app deployment proof is unavailable' using errcode = '42501';
		end if;
	else
		if not (
			(p_deployment_id is not null and exists (
				select 1 from public.qorpera_company_site_deployments as dep
				where dep.id = p_deployment_id
					and dep.site_id = v_site.id
					and dep.profile_id = v_site.profile_id
					and dep.state in ('building', 'ready', 'live')
			))
			or exists (
				select 1
				from public.qorpera_code_repositories as repo
				join public.qorpera_code_changes as ch
					on ch.environment_id = repo.environment_id
					and ch.owner = repo.owner
					and ch.name = repo.name
				where repo.site_id = v_site.id
					and repo.environment_id = v_site.environment_id
					and ch.site_state = 'made'
			)
			or exists (
				select 1 from public.qorpera_coding_sessions as cs
				where cs.environment_id = v_site.environment_id
					and cs.profile_id = v_site.profile_id
					and cs.lease_owner = p_executor_owner
					and cs.lease_until > clock_timestamp()
			)
		) then
			raise exception 'hosted app build proof is unavailable' using errcode = '42501';
		end if;
	end if;
	select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_grant_ids
	from (
		select app_grant.id from public.qorpera_app_secret_grants as app_grant
		where app_grant.profile_id = v_site.profile_id
			and app_grant.environment_id = v_site.environment_id
			and app_grant.site_id = v_site.id
			and app_grant.scope = p_scope
			and app_grant.target_env = p_target_env
			and app_grant.status = 'active'
		order by app_grant.id for share
	) as locked;
	select coalesce(array_agg(chosen.id), '{}'::uuid[]) into v_secret_ids
	from (
		select secret.id
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_site.profile_id
			and secret.environment_id = v_site.environment_id
			and secret.connector_id = 'environment'
			and secret.owner_kind = 'company'
			and secret.status = 'active'
			and secret.broker_authority_id = v_authority.id
			and public.qorpera_coding_environment_name_allowed(secret.secret_name)
			and exists (
				select 1 from public.qorpera_app_secret_grants as app_grant
				join public.qorpera_profile_members as issuer
					on issuer.profile_id = app_grant.profile_id
					and issuer.user_id = app_grant.issued_by_user_id
					and issuer.role in ('owner', 'admin')
				where app_grant.id = any(v_grant_ids)
					and app_grant.secret_id = secret.id
					and app_grant.status = 'active'
			)
		order by secret.id
		for share of secret
	) as chosen;
	for v_secret in
		select secret.* from public.qorpera_cloud_secrets as secret
		where secret.id = any(v_secret_ids)
		order by secret.secret_name, secret.id
	loop
		select version.* into v_version
		from public.qorpera_cloud_secret_versions as version
		where version.secret_id = v_secret.id and version.version = v_secret.current_version for share;
		if v_version.secret_id is null or v_version.broker_authority_id <> v_authority.id
			or v_version.key_id <> v_authority.key_id then
			raise exception 'cloud secret version is unavailable' using errcode = '42501';
		end if;
		select app_grant.id into v_grant_id
		from public.qorpera_app_secret_grants as app_grant
		where app_grant.id = any(v_grant_ids) and app_grant.secret_id = v_secret.id
		order by app_grant.id limit 1;
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id, environment_id, secret_id, secret_version, grant_id, event_type, connector_id
		) values (
			v_secret.profile_id, v_secret.environment_id, v_secret.id, v_secret.current_version,
			v_grant_id, 'app_secret_used', v_secret.connector_id
		);
		v_secrets := v_secrets || jsonb_build_object(
			'name', upper(v_secret.secret_name),
			'secretId', v_secret.id,
			'secretVersion', v_secret.current_version,
			'keyId', v_version.key_id,
			'ownerKind', v_secret.owner_kind,
			'scope', p_scope,
			'targetEnv', p_target_env,
			'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
			'envelopeSha256', v_version.envelope_sha256
		);
	end loop;
	return jsonb_build_object(
		'schema', 'qorpera.app-secrets-authorization/v1',
		'companyId', v_site.profile_id,
		'environmentId', v_site.environment_id,
		'siteId', v_site.id,
		'slug', v_site.slug,
		'scope', p_scope,
		'targetEnv', p_target_env,
		'secrets', v_secrets
	);
end
$$;

select pg_temp.w6c_patch('public.qorpera_code_sites_due(text,text,integer)'::regprocedure, array[
	$old$		v_due := v_due || jsonb_build_object('companyId', v_repository.profile_id, 'environmentId', v_repository.environment_id,
			'owner', v_repository.owner, 'name', v_repository.name, 'change', (v_point ->> 'change')::integer,
			'site', v_point -> 'site');$old$,
	$new$		v_due := v_due || (jsonb_build_object('companyId', v_repository.profile_id, 'environmentId', v_repository.environment_id,
			'owner', v_repository.owner, 'name', v_repository.name, 'change', (v_point ->> 'change')::integer,
			'site', v_point -> 'site')
			|| case when v_repository.site_id is not null then jsonb_build_object('siteId', v_repository.site_id) else '{}'::jsonb end);$new$
]);

alter table public.qorpera_code_repositories
	add column auto_redeploy_enabled boolean not null default false,
	add column auto_redeploy_enabled_by_user_id uuid,
	add column auto_redeploy_enabled_at timestamptz,
	add constraint qorpera_code_repositories_auto_redeploy_check
		check (not auto_redeploy_enabled or (auto_redeploy_enabled_by_user_id is not null and auto_redeploy_enabled_at is not null));

create function public.qorpera_set_code_site_auto_redeploy(
	p_profile_id uuid,
	p_owner text,
	p_name text,
	p_enabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
	v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_repo public.qorpera_code_repositories%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_role is null
		or v_role not in ('owner', 'admin') then
		raise exception 'Releases unavailable' using errcode = '42501';
	end if;
	if p_profile_id is null or p_owner is null or p_name is null or p_enabled is null then
		raise exception 'Auto-redeploy setting is invalid' using errcode = '22023';
	end if;
	perform 1 from public.qorpera_profiles profile where profile.id = p_profile_id for key share;
	select repository.* into v_repo
	from public.qorpera_code_repositories repository
	join public.qorpera_company_files file on file.environment_id = repository.environment_id
		and file.profile_id = p_profile_id and file.core = 'folder-v2'
	where repository.profile_id = p_profile_id
		and lower(repository.owner) = lower(p_owner)
		and lower(repository.name) = lower(p_name)
	for update of repository;
	if not found then
		raise exception 'No such repository' using errcode = 'P0002';
	end if;
	update public.qorpera_code_repositories
	set auto_redeploy_enabled = p_enabled,
		auto_redeploy_enabled_by_user_id = case when p_enabled then auth.uid() else null end,
		auto_redeploy_enabled_at = case when p_enabled then v_now else null end
	where environment_id = v_repo.environment_id and owner = v_repo.owner and name = v_repo.name
	returning * into v_repo;
	return jsonb_build_object(
		'schema', 'qorpera.code-site-auto-redeploy-policy/v1',
		'owner', v_repo.owner,
		'name', v_repo.name,
		'autoRedeployEnabled', v_repo.auto_redeploy_enabled,
		'enabledByUserId', v_repo.auto_redeploy_enabled_by_user_id,
		'enabledAt', v_repo.auto_redeploy_enabled_at
	);
end
$$;

create function public.qorpera_code_site_for_auto_redeploy(
	p_owner text,
	p_machine_id_sha256 text,
	p_environment_id uuid,
	p_repository_owner text,
	p_name text,
	p_change integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_repo public.qorpera_code_repositories%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_live public.qorpera_code_releases%rowtype;
	v_point jsonb;
	v_existing_dep_id uuid;
	v_existing_image_ref text;
	v_tree text;
	v_site_spec jsonb;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null or p_change is null or p_change < 1 then
		raise exception 'Code site lookup is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256) then
		return jsonb_build_object('schema', 'qorpera.code-site-auto-redeploy/v1', 'found', false);
	end if;
	select * into v_repo
	from public.qorpera_code_repositories
	where environment_id = p_environment_id
		and lower(owner) = lower(p_repository_owner)
		and lower(name) = lower(p_name)
	limit 1;
	if v_repo.site_id is null
		or not v_repo.auto_redeploy_enabled
		or v_repo.auto_redeploy_enabled_by_user_id is null
		or not exists (
			select 1 from public.qorpera_profile_members m
			where m.profile_id = v_repo.profile_id
				and m.user_id = v_repo.auto_redeploy_enabled_by_user_id
				and m.role in ('owner', 'admin')
		)
		or exists (select 1 from public.qorpera_company_deletions d where d.profile_id = v_repo.profile_id) then
		return jsonb_build_object('schema', 'qorpera.code-site-auto-redeploy/v1', 'found', false);
	end if;
	select * into v_site
	from public.qorpera_company_sites
	where id = v_repo.site_id
		and profile_id = v_repo.profile_id
		and taken_down_at is null
		and current_version_id is not null
		and live_deployment_id is not null;
	if v_site.id is null then
		return jsonb_build_object('schema', 'qorpera.code-site-auto-redeploy/v1', 'found', false);
	end if;
	v_live := public.qorpera_code_release_live(v_repo);
	if v_live.n is null then
		return jsonb_build_object('schema', 'qorpera.code-site-auto-redeploy/v1', 'found', false);
	end if;
	select * into v_dep
	from public.qorpera_company_site_deployments
	where id = v_site.live_deployment_id and site_id = v_site.id;
	if not found or v_dep.kind is distinct from 'server' or v_dep.oci_image_ref is null then
		return jsonb_build_object('schema', 'qorpera.code-site-auto-redeploy/v1', 'found', false);
	end if;
	v_point := public.qorpera_code_release_point(v_repo, p_change, false);
	if v_point is null or v_point -> 'site' ->> 'kind' is distinct from 'server' then
		return jsonb_build_object('schema', 'qorpera.code-site-auto-redeploy/v1', 'found', false);
	end if;
	v_tree := v_point ->> 'tree';
	v_site_spec := v_point -> 'site';
	select dep.id, dep.oci_image_ref
	into v_existing_dep_id, v_existing_image_ref
	from public.qorpera_company_site_versions ver
	join public.qorpera_company_site_deployments dep
		on dep.version_id = ver.id and dep.site_id = v_site.id
	where ver.site_id = v_site.id
		and ver.tree = v_tree
		and dep.kind = 'server'
		and dep.oci_image_ref is not null
	limit 1;
	return jsonb_build_object(
		'schema', 'qorpera.code-site-auto-redeploy/v1',
		'found', true,
		'companyId', v_site.profile_id,
		'siteId', v_site.id,
		'slug', v_site.slug,
		'kind', 'server',
		'tree', v_tree,
		'dockerfile', v_site_spec ->> 'dockerfile',
		'currentDeploymentId', v_dep.id,
		'currentImageRef', v_dep.oci_image_ref,
		'existingDeploymentId', v_existing_dep_id,
		'existingImageRef', v_existing_image_ref,
		'appPort', coalesce((v_site_spec ->> 'port')::integer, v_dep.app_port, 3000),
		'healthPath', coalesce(v_site_spec ->> 'healthPath', v_dep.health_path, '/'),
		'idleTimeoutSec', coalesce((v_site_spec ->> 'idleTimeoutSec')::integer, v_dep.idle_timeout_sec, 900),
		'memoryMb', coalesce((v_site_spec ->> 'memoryMb')::integer, v_dep.memory_mb, 512),
		'vcpuLimit', coalesce((v_site_spec ->> 'vcpuLimit')::numeric, v_dep.vcpu_limit, 1.00)
	);
end
$$;

create function public.qorpera_code_site_auto_redeploy_switch(
	p_owner text,
	p_machine_id_sha256 text,
	p_environment_id uuid,
	p_site_id uuid,
	p_deployment_id uuid,
	p_upstream_addr text default null,
	p_mode text default 'release'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
	c_schema constant text := 'qorpera.code-site-auto-redeploy-switch/v1';
	v_repo public.qorpera_code_repositories%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_dep public.qorpera_company_site_deployments%rowtype;
	v_ver public.qorpera_company_site_versions%rowtype;
	v_live public.qorpera_code_releases%rowtype;
	v_prior public.qorpera_code_releases%rowtype;
	v_point jsonb;
	v_n integer;
	v_release_version integer;
	v_port integer;
	v_now timestamptz := clock_timestamp();
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_site_id is null or p_deployment_id is null
		or coalesce(p_mode, '') not in ('release', 'back') then
		raise exception 'Auto-redeploy switch is invalid' using errcode = '22023';
	end if;
	if p_upstream_addr is not null then
		if p_upstream_addr !~ '^127\.0\.0\.1:[0-9]{1,5}$' then
			raise exception 'Auto-redeploy upstream is invalid' using errcode = '22023';
		end if;
		v_port := split_part(p_upstream_addr, ':', 2)::integer;
		if v_port not between 1 and 65535 then
			raise exception 'Auto-redeploy upstream is invalid' using errcode = '22023';
		end if;
	end if;
	if not public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256) then
		return jsonb_build_object('schema', c_schema, 'state', 'lost');
	end if;
	perform 1 from public.qorpera_profiles profile
	where profile.id = (
		select repo.profile_id from public.qorpera_code_repositories repo
		where repo.environment_id = p_environment_id and repo.site_id = p_site_id
		limit 1
	) for key share;
	select * into v_repo
	from public.qorpera_code_repositories
	where environment_id = p_environment_id and site_id = p_site_id
	for update;
	if not found
		or exists (select 1 from public.qorpera_company_deletions d where d.profile_id = v_repo.profile_id) then
		return jsonb_build_object('schema', c_schema, 'state', 'lost');
	end if;
	if not v_repo.auto_redeploy_enabled
		or v_repo.auto_redeploy_enabled_by_user_id is null
		or not exists (
			select 1 from public.qorpera_profile_members m
			where m.profile_id = v_repo.profile_id
				and m.user_id = v_repo.auto_redeploy_enabled_by_user_id
				and m.role in ('owner', 'admin')
		) then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'AUTO_REDEPLOY_NOT_AUTHORIZED');
	end if;
	select * into v_site
	from public.qorpera_company_sites
	where id = p_site_id and environment_id = p_environment_id and profile_id = v_repo.profile_id
	for update;
	if not found then
		return jsonb_build_object('schema', c_schema, 'state', 'lost');
	end if;
	if v_site.taken_down_at is not null
		or v_site.current_version_id is null
		or v_site.live_deployment_id is null then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_NOT_LIVE');
	end if;
	select * into v_dep
	from public.qorpera_company_site_deployments
	where id = p_deployment_id and site_id = v_site.id
	for update;
	if not found or v_dep.kind is distinct from 'server'
		or v_dep.version_id is null or v_dep.oci_image_ref is null then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'DEPLOYMENT_UNAVAILABLE');
	end if;
	if v_site.is_public and coalesce(v_dep.has_credential_inputs, false) then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'SITE_CONTAINS_CREDENTIAL_INPUTS');
	end if;
	select * into v_ver
	from public.qorpera_company_site_versions
	where id = v_dep.version_id and site_id = v_site.id
	for update;
	if not found then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'VERSION_UNAVAILABLE');
	end if;
	v_live := public.qorpera_code_release_live(v_repo);
	if v_live.n is null then
		return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'RELEASE_NOT_LIVE');
	end if;
	v_n := v_repo.last_release + 1;
	if p_mode = 'release' then
		v_point := public.qorpera_code_release_point(v_repo, v_ver.change, true);
		if v_point is null
			or (v_point ->> 'versionId')::uuid is distinct from v_ver.id
			or v_point -> 'site' ->> 'kind' is distinct from 'server' then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'RELEASE_POINT_MOVED');
		end if;
		v_release_version := v_repo.last_version + 1;
		insert into public.qorpera_code_releases (
			environment_id, owner, name, n, profile_id, kind, version, change, main_sha, tree,
			version_id, replaces, prior, changes, shown_sha256, by_user_id
		) values (
			v_repo.environment_id, v_repo.owner, v_repo.name, v_n, v_repo.profile_id, 'release',
			v_release_version, (v_point ->> 'change')::integer, v_point ->> 'mainSha', v_point ->> 'tree',
			v_ver.id, v_live.n, v_live.n,
			array(select held.n::integer from jsonb_array_elements_text(v_point -> 'held') with ordinality held(n, place)
				order by held.place),
			v_point ->> 'token', v_repo.auto_redeploy_enabled_by_user_id
		);
		update public.qorpera_code_repositories
		set last_release = v_n, live_release = v_n, last_version = v_release_version, index_version = index_version + 1
		where environment_id = v_repo.environment_id and owner = v_repo.owner and name = v_repo.name;
	else
		select * into v_prior
		from public.qorpera_code_releases release
		where release.environment_id = v_repo.environment_id and release.owner = v_repo.owner
			and release.name = v_repo.name and release.n = v_live.prior;
		if v_prior.version_id is distinct from v_ver.id then
			return jsonb_build_object('schema', c_schema, 'state', 'refused', 'code', 'PRIOR_RELEASE_MOVED');
		end if;
		v_release_version := v_prior.version;
		insert into public.qorpera_code_releases (
			environment_id, owner, name, n, profile_id, kind, version, change, main_sha, tree,
			version_id, replaces, prior, by_user_id
		) values (
			v_repo.environment_id, v_repo.owner, v_repo.name, v_n, v_repo.profile_id, 'back',
			v_prior.version, v_prior.change, v_prior.main_sha, v_prior.tree,
			v_ver.id, v_live.n, v_prior.prior, v_repo.auto_redeploy_enabled_by_user_id
		);
		update public.qorpera_code_repositories
		set last_release = v_n, live_release = v_n, index_version = index_version + 1
		where environment_id = v_repo.environment_id and owner = v_repo.owner and name = v_repo.name;
	end if;
	update public.qorpera_company_site_versions
	set state = 'kept'
	where site_id = v_site.id and state = 'live' and id <> v_ver.id;
	update public.qorpera_company_site_versions
	set state = 'live', published_at = v_now
	where id = v_ver.id;
	update public.qorpera_company_sites
	set current_version_id = v_ver.id,
		title = coalesce(v_ver.title, title),
		published_at = v_now,
		published_by_user_id = v_repo.auto_redeploy_enabled_by_user_id,
		published_by_staff_agent_id = null,
		updated_at = v_now
	where id = v_site.id;
	update public.qorpera_company_site_deployments
	set upstream_addr = null
	where site_id = v_site.id and id <> v_dep.id and upstream_addr is not null;
	update public.qorpera_company_site_deployments
	set upstream_addr = p_upstream_addr
	where id = v_dep.id;
	return jsonb_build_object(
		'schema', c_schema,
		'state', 'live',
		'siteId', v_site.id,
		'deploymentId', v_dep.id,
		'versionId', v_ver.id,
		'releaseVersion', v_release_version,
		'upstreamAddr', p_upstream_addr
	);
end
$$;

create function public.qorpera_glob_matches(p_pattern text, p_path text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_clean text;
	v_escaped text;
	v_regex text;
begin
	if p_pattern is null or p_path is null
		or char_length(p_pattern) not between 1 and 256
		or char_length(p_path) not between 1 and 4096
		or p_pattern ~ '[[:cntrl:]]'
		or p_path ~ '[[:cntrl:]]' then
		return false;
	end if;
	v_clean := regexp_replace(p_pattern, '\*{3,}', '**', 'g');
	v_escaped := replace(v_clean, '\', '\\');
	v_escaped := replace(v_escaped, '.', '\.');
	v_escaped := replace(v_escaped, '+', '\+');
	v_escaped := replace(v_escaped, '(', '\(');
	v_escaped := replace(v_escaped, ')', '\)');
	v_escaped := replace(v_escaped, '[', '\[');
	v_escaped := replace(v_escaped, ']', '\]');
	v_escaped := replace(v_escaped, '{', '\{');
	v_escaped := replace(v_escaped, '}', '\}');
	v_escaped := replace(v_escaped, '^', '\^');
	v_escaped := replace(v_escaped, '$', '\$');
	v_escaped := replace(v_escaped, '|', '\|');
	v_regex := replace(v_escaped, '**/', chr(1));
	v_regex := replace(v_regex, '**', chr(2));
	v_regex := replace(v_regex, '*', '[^/]*');
	v_regex := replace(v_regex, '?', '[^/]');
	v_regex := replace(v_regex, chr(1), '(?:.*/)?');
	v_regex := replace(v_regex, chr(2), '.*');
	return p_path ~ ('^' || v_regex || '$');
end
$$;

create function public.qorpera_routine_check_before_wake_valid(p_check jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_kind text;
begin
	if p_check is null or jsonb_typeof(p_check) <> 'object' then return false; end if;
	v_kind := p_check ->> 'kind';
	if v_kind = 'http_probe' then
		if not (p_check ?& array['kind', 'url'])
			or (p_check - array['kind', 'url', 'expectStatus', 'timeoutMs']) <> '{}'::jsonb
			or jsonb_typeof(p_check -> 'url') <> 'string'
			or char_length(p_check ->> 'url') not between 10 and 1024
			or (p_check ->> 'url') !~ '^https://[^/@[:space:][:cntrl:]]+(/[^[:space:][:cntrl:]]*)?$' then
			return false;
		end if;
		if p_check ? 'expectStatus' and (jsonb_typeof(p_check -> 'expectStatus') <> 'number'
			or (p_check ->> 'expectStatus') !~ '^[1-5][0-9]{2}$') then
			return false;
		end if;
		if p_check ? 'timeoutMs' and (jsonb_typeof(p_check -> 'timeoutMs') <> 'number'
			or (p_check ->> 'timeoutMs') !~ '^[0-9]{3,5}$'
			or (p_check ->> 'timeoutMs')::integer not between 500 and 30000) then
			return false;
		end if;
		return true;
	elsif v_kind = 'code_checks' then
		if not (p_check ? 'kind')
			or (p_check - array['kind', 'repo', 'timeoutMs']) <> '{}'::jsonb then
			return false;
		end if;
		if p_check ? 'repo' and (jsonb_typeof(p_check -> 'repo') <> 'string'
			or (p_check ->> 'repo') !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$') then
			return false;
		end if;
		if p_check ? 'timeoutMs' and (jsonb_typeof(p_check -> 'timeoutMs') <> 'number'
			or (p_check ->> 'timeoutMs') !~ '^[0-9]{3,6}$'
			or (p_check ->> 'timeoutMs')::integer not between 1000 and 300000) then
			return false;
		end if;
		return true;
	end if;
	return false;
end
$$;

do $$
declare v_kinds text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_kinds
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_-]+)''', 'g')
		with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_wake_occurrences'::regclass
		and c.conname = 'qorpera_wake_occurrences_source_kind_check';
	if v_kinds is null or not ('event' = any(v_kinds)) or ('code-change' = any(v_kinds)) then
		raise exception '20260930850000: unexpected wake source kinds: %', v_kinds;
	end if;
	execute format('alter table public.qorpera_wake_occurrences
		drop constraint qorpera_wake_occurrences_source_kind_check,
		add constraint qorpera_wake_occurrences_source_kind_check check (source_kind in (%s))',
		(select string_agg(quote_literal(k), ', ' order by o)
			from unnest(v_kinds || array['code-change', 'app-unhealthy', 'data-change'])
				with ordinality as u(k, o)));
end $$;

select pg_temp.w6c_patch('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure, array[
	$old$	elsif p_kind = 'routine' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['conclusion','effort','ends','id','instructions','kind','quiet','reply','runs','status','timezone','title','trigger'] then
			v_bad := array_append(v_bad, 'keys'); end if;$old$,
	$new$	elsif p_kind = 'routine' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) not in (
			array['conclusion','effort','ends','id','instructions','kind','quiet','reply','runs','status','timezone','title','trigger'],
			array['checkBeforeWake','conclusion','effort','ends','id','instructions','kind','quiet','reply','runs','status','timezone','title','trigger']
		) then
			v_bad := array_append(v_bad, 'keys'); end if;
		if p_parse ? 'checkBeforeWake' and jsonb_typeof(p_parse -> 'checkBeforeWake') <> 'null'
			and not public.qorpera_routine_check_before_wake_valid(p_parse -> 'checkBeforeWake') then
			v_bad := array_append(v_bad, 'checkBeforeWake'); end if;$new$,
	$old$			or coalesce(v_when ->> 'when', '') not in ('every','weekly','window','once','file-change','event') then$old$,
	$new$			or coalesce(v_when ->> 'when', '') not in ('every','weekly','window','once','file-change','event','code-change','app-unhealthy','data-change') then$new$,
	$old$				when 'file-change' then array['match','watch','when'] else array['hook','only','when'] end)$old$,
	$new$				when 'file-change' then array['match','watch','when']
				when 'event' then array['hook','only','when']
				when 'code-change' then array['events','paths','repo','when']
				when 'app-unhealthy' then array['site','when']
				else array['database','operations','tables','when'] end)
			or (v_when ->> 'when' = 'code-change' and (
				coalesce(v_when ->> 'repo', '') !~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$'
				or jsonb_typeof(v_when -> 'events') <> 'array'
				or jsonb_array_length(v_when -> 'events') not between 1 and 4
				or exists (select 1 from jsonb_array_elements(v_when -> 'events') ev
					where jsonb_typeof(ev) <> 'string' or (ev #>> '{}') not in ('landed','undone','checks_failed','conflict'))
				or (select count(distinct ev) from jsonb_array_elements(v_when -> 'events') ev) <> jsonb_array_length(v_when -> 'events')
				or (jsonb_typeof(v_when -> 'paths') <> 'null' and (jsonb_typeof(v_when -> 'paths') <> 'array'
					or jsonb_array_length(v_when -> 'paths') not between 1 and 20
					or exists (select 1 from jsonb_array_elements(v_when -> 'paths') pat
						where not public.qorpera_company_state_one_line(pat, 1, 256))
					or (select count(distinct pat) from jsonb_array_elements(v_when -> 'paths') pat) <> jsonb_array_length(v_when -> 'paths')))))
			or (v_when ->> 'when' = 'app-unhealthy' and (
				jsonb_typeof(v_when -> 'site') <> 'string'
				or (coalesce(v_when ->> 'site', '') !~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
					and coalesce(v_when ->> 'site', '') !~ c_uuid)))
			or (v_when ->> 'when' = 'data-change' and (
				coalesce(v_when ->> 'database', '') !~ '^[a-z][a-z0-9_-]{0,63}$'
				or (jsonb_typeof(v_when -> 'tables') <> 'null' and (jsonb_typeof(v_when -> 'tables') <> 'array'
					or jsonb_array_length(v_when -> 'tables') not between 1 and 20
					or exists (select 1 from jsonb_array_elements(v_when -> 'tables') tb
						where jsonb_typeof(tb) <> 'string' or (tb #>> '{}') !~ '^[a-z][a-z0-9_]{0,63}$')
					or (select count(distinct tb) from jsonb_array_elements(v_when -> 'tables') tb) <> jsonb_array_length(v_when -> 'tables')))
				or (jsonb_typeof(v_when -> 'operations') <> 'null' and (jsonb_typeof(v_when -> 'operations') <> 'array'
					or jsonb_array_length(v_when -> 'operations') not between 1 and 3
					or exists (select 1 from jsonb_array_elements(v_when -> 'operations') op
						where jsonb_typeof(op) <> 'string' or (op #>> '{}') not in ('insert','update','delete'))
					or (select count(distinct op) from jsonb_array_elements(v_when -> 'operations') op) <> jsonb_array_length(v_when -> 'operations')))))$new$
]);

select pg_temp.w6c_patch('public.qorpera_company_state_routine_trigger(jsonb)'::regprocedure, array[
	$old$		when 'event' then jsonb_build_object('kind', 'listener', 'source', 'event', 'hookId', v_when -> 'hook',
				'timeZone', p_parse -> 'timezone')
			|| case when jsonb_typeof(v_when -> 'only') = 'array' then jsonb_build_object('only', v_when -> 'only')
				else '{}'::jsonb end end;$old$,
	$new$		when 'event' then jsonb_build_object('kind', 'listener', 'source', 'event', 'hookId', v_when -> 'hook',
				'timeZone', p_parse -> 'timezone')
			|| case when jsonb_typeof(v_when -> 'only') = 'array' then jsonb_build_object('only', v_when -> 'only')
				else '{}'::jsonb end
		when 'code-change' then jsonb_build_object('kind', 'listener', 'source', 'code-change',
				'repo', to_jsonb(lower(v_when ->> 'repo')), 'events', v_when -> 'events', 'timeZone', p_parse -> 'timezone')
			|| case when jsonb_typeof(v_when -> 'paths') = 'array' then jsonb_build_object('paths', v_when -> 'paths')
				else '{}'::jsonb end
		when 'app-unhealthy' then jsonb_build_object('kind', 'listener', 'source', 'app-unhealthy',
				'site', v_when -> 'site', 'timeZone', p_parse -> 'timezone')
		when 'data-change' then jsonb_build_object('kind', 'listener', 'source', 'data-change',
				'database', v_when -> 'database', 'timeZone', p_parse -> 'timezone')
			|| case when jsonb_typeof(v_when -> 'tables') = 'array' then jsonb_build_object('tables', v_when -> 'tables')
				else '{}'::jsonb end
			|| case when jsonb_typeof(v_when -> 'operations') = 'array' then jsonb_build_object('operations', v_when -> 'operations')
				else '{}'::jsonb end end;$new$,
	$old$	return v_trigger || jsonb_build_object('id', 'file', 'replyPolicy', p_parse -> 'reply');$old$,
	$new$	return v_trigger || jsonb_build_object('id', 'file', 'replyPolicy', p_parse -> 'reply')
		|| case when jsonb_typeof(p_parse -> 'checkBeforeWake') = 'object'
			then jsonb_build_object('checkBeforeWake', p_parse -> 'checkBeforeWake')
			else '{}'::jsonb end;$new$
]);

select pg_temp.w6c_patch('public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure, array[
	$old$	if p_trigger ->> 'kind' = 'schedule' then
		return public.qorpera_cloud_routine_trigger_before_wake_bus(p_trigger - 'replyPolicy');
	end if;$old$,
	$new$	if p_trigger ? 'checkBeforeWake' and (
		p_trigger ->> 'kind' <> 'schedule'
		or not public.qorpera_routine_check_before_wake_valid(p_trigger -> 'checkBeforeWake')
	) then return false; end if;
	if p_trigger ->> 'kind' = 'schedule' then
		return public.qorpera_cloud_routine_trigger_before_wake_bus(p_trigger - 'replyPolicy' - 'checkBeforeWake');
	end if;$new$,
	$old$	if p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'event' then$old$,
	$new$	if p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'code-change' then
		return coalesce(p_trigger ?& array['id','kind','source','repo','events','timeZone']
			and p_trigger - array['id','kind','source','repo','events','paths','timeZone','replyPolicy'] = '{}'::jsonb
			and jsonb_typeof(p_trigger -> 'id') = 'string'
			and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
			and jsonb_typeof(p_trigger -> 'repo') = 'string'
			and p_trigger ->> 'repo' ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'
			and jsonb_typeof(p_trigger -> 'events') = 'array'
			and jsonb_array_length(p_trigger -> 'events') between 1 and 4
			and not exists (select 1 from jsonb_array_elements(p_trigger -> 'events') as ev(value)
				where jsonb_typeof(ev.value) <> 'string'
					or ev.value #>> '{}' not in ('landed','undone','checks_failed','conflict'))
			and (select count(distinct ev.value) from jsonb_array_elements(p_trigger -> 'events') as ev(value))
				= jsonb_array_length(p_trigger -> 'events')
			and (not p_trigger ? 'paths' or (jsonb_typeof(p_trigger -> 'paths') = 'array'
				and jsonb_array_length(p_trigger -> 'paths') between 1 and 20
				and not exists (select 1 from jsonb_array_elements(p_trigger -> 'paths') as pat(value)
					where jsonb_typeof(pat.value) <> 'string'
						or char_length(pat.value #>> '{}') not between 1 and 256
						or (pat.value #>> '{}') ~ '[[:cntrl:]]')
				and (select count(distinct pat.value) from jsonb_array_elements(p_trigger -> 'paths') as pat(value))
					= jsonb_array_length(p_trigger -> 'paths')))
			and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
			and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'), false);
	end if;
	if p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'app-unhealthy' then
		return coalesce(p_trigger ?& array['id','kind','source','site','timeZone']
			and p_trigger - array['id','kind','source','site','timeZone','replyPolicy'] = '{}'::jsonb
			and jsonb_typeof(p_trigger -> 'id') = 'string'
			and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
			and jsonb_typeof(p_trigger -> 'site') = 'string'
			and (p_trigger ->> 'site' ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
				or p_trigger ->> 'site' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
			and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
			and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'), false);
	end if;
	if p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'data-change' then
		return coalesce(p_trigger ?& array['id','kind','source','database','timeZone']
			and p_trigger - array['id','kind','source','database','tables','operations','timeZone','replyPolicy'] = '{}'::jsonb
			and jsonb_typeof(p_trigger -> 'id') = 'string'
			and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
			and jsonb_typeof(p_trigger -> 'database') = 'string'
			and p_trigger ->> 'database' ~ '^[a-z][a-z0-9_-]{0,63}$'
			and (not p_trigger ? 'tables' or (jsonb_typeof(p_trigger -> 'tables') = 'array'
				and jsonb_array_length(p_trigger -> 'tables') between 1 and 20
				and not exists (select 1 from jsonb_array_elements(p_trigger -> 'tables') as tb(value)
					where jsonb_typeof(tb.value) <> 'string' or tb.value #>> '{}' !~ '^[a-z][a-z0-9_]{0,63}$')
				and (select count(distinct tb.value) from jsonb_array_elements(p_trigger -> 'tables') as tb(value))
					= jsonb_array_length(p_trigger -> 'tables')))
			and (not p_trigger ? 'operations' or (jsonb_typeof(p_trigger -> 'operations') = 'array'
				and jsonb_array_length(p_trigger -> 'operations') between 1 and 3
				and not exists (select 1 from jsonb_array_elements(p_trigger -> 'operations') as op(value)
					where jsonb_typeof(op.value) <> 'string' or op.value #>> '{}' not in ('insert','update','delete'))
				and (select count(distinct op.value) from jsonb_array_elements(p_trigger -> 'operations') as op(value))
					= jsonb_array_length(p_trigger -> 'operations')))
			and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
			and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'), false);
	end if;
	if p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'event' then$new$
]);

select pg_temp.w6c_patch('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure, array[
	$old$	elsif v_zone is not null then$old$,
	$new$	elsif p_parse ? 'checkBeforeWake' and jsonb_typeof(p_parse -> 'checkBeforeWake') = 'object'
		and v_when not in ('every','weekly','window') then
		v_problem := 'checkBeforeWake is only supported on recurring scheduled routines';
	elsif p_parse ? 'checkBeforeWake' and jsonb_typeof(p_parse -> 'checkBeforeWake') = 'object'
		and p_parse -> 'checkBeforeWake' ->> 'kind' = 'code_checks'
		and p_parse -> 'checkBeforeWake' ? 'repo'
		and (v_owner is null or not exists (
			select 1 from public.qorpera_coding_repository_grants g
			where g.environment_id = p_environment_id and g.staff_agent_id = v_owner and g.enabled
				and lower((g.repository ->> 'owner') || '/' || (g.repository ->> 'name'))
					= lower(p_parse -> 'checkBeforeWake' ->> 'repo'))) then
		v_problem := 'this routine''s agent does not have access to repository '
			|| left(coalesce(p_parse -> 'checkBeforeWake' ->> 'repo', ''), 100);
	elsif v_when = 'code-change' and (v_owner is null or not exists (
		select 1 from public.qorpera_coding_repository_grants g
		where g.environment_id = p_environment_id and g.staff_agent_id = v_owner and g.enabled
			and lower((g.repository ->> 'owner') || '/' || (g.repository ->> 'name'))
				= lower(coalesce(p_parse -> 'trigger' ->> 'repo', '')))) then
		v_problem := 'this routine''s agent does not have access to repository '
			|| left(coalesce(p_parse -> 'trigger' ->> 'repo', ''), 100);
	elsif v_when = 'data-change' and (v_owner is null or not public.qorpera_folder_actor_allowed(
		p_environment_id, p_profile_id,
		jsonb_build_object('kind', 'staff_agent', 'staffAgentId', v_owner,
			'requesterUserId', coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId'),
			'audience', jsonb_build_object('kind', 'company'), 'sessionKind', 'in_house'),
		'data/' || coalesce(p_parse -> 'trigger' ->> 'database', ''), 'read')) then
		v_problem := 'this routine''s agent may not read database '
			|| left(coalesce(p_parse -> 'trigger' ->> 'database', ''), 64);
	elsif v_when = 'app-unhealthy' and not exists (select 1 from public.qorpera_company_sites site
		where site.profile_id = p_profile_id and site.environment_id = p_environment_id
			and (site.slug = p_parse -> 'trigger' ->> 'site' or site.id::text = p_parse -> 'trigger' ->> 'site')) then
		v_problem := 'site ' || left(coalesce(p_parse -> 'trigger' ->> 'site', ''), 48)
			|| ' is not a hosted app of this company';
	elsif v_when in ('code-change','app-unhealthy','data-change') and (exists (
			select 1 from public.qorpera_company_state_routine_payer(p_profile_id,
				coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, v_version.sponsor_binding_id) payer
			where public.qorpera_sponsor_version_is_chatgpt_plan(payer.binding_id, payer.version))
		or exists (select 1 from public.qorpera_execution_runs run where p_actor ->> 'kind' = 'staff_agent'
			and run.id = (p_actor ->> 'runId')::uuid
			and public.qorpera_sponsor_version_is_chatgpt_plan(run.sponsor_binding_id, run.sponsor_version))) then
		v_problem := 'a ChatGPT plan pays only for work its member starts; a listener routine needs another AI login';
	elsif v_zone is not null then$new$
]);

select pg_temp.w6c_patch('public.qorpera_activate_company_file_listener()'::regprocedure, array[
	$old$	if v_trigger ->> 'source' = 'event' then$old$,
	$new$	if v_trigger ->> 'source' in ('code-change','app-unhealthy','data-change') then
		if not public.qorpera_cloud_routine_trigger_valid(v_trigger) then
			raise exception 'Routine listener trigger is invalid' using errcode = '22023';
		end if;
		return new;
	end if;
	if v_trigger ->> 'source' = 'event' then$new$
]);

select pg_temp.w6c_patch('public.qorpera_pin_wake_occurrence()'::regprocedure, array[
	$old$			or new.source_kind not in ('schedule','company-file','event') then$old$,
	$new$			or (new.source_kind = 'code-change' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'code-change' or new.file_event_id is not null))
			or (new.source_kind = 'app-unhealthy' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'app-unhealthy' or new.file_event_id is not null
				or new.source_id is null))
			or (new.source_kind = 'data-change' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'data-change' or new.file_event_id is not null))
			or new.source_kind not in ('schedule','company-file','event','code-change','app-unhealthy','data-change') then$new$,
	$old$		new.source_id := case when new.source_kind = 'event' then (v_trigger ->> 'hookId')::uuid
			when new.source_kind = 'company-file' then new.source_id
			else coalesce(new.file_event_id,new.routine_id) end;$old$,
	$new$		new.source_id := case when new.source_kind = 'event' then (v_trigger ->> 'hookId')::uuid
			when new.source_kind in ('company-file','app-unhealthy') then new.source_id
			when new.source_kind in ('code-change','data-change') then coalesce(new.source_id, new.routine_id)
			else coalesce(new.file_event_id,new.routine_id) end;$new$,
	$old$		else
			if new.parent_run_id is not null or new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
		end if;$old$,
	$new$		elsif new.source_kind in ('code-change','data-change') then
			if new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
			if new.parent_run_id is not null then
				select r.staff_agent_id into v_actor from public.qorpera_execution_runs r
				where r.id = new.parent_run_id and r.profile_id = new.profile_id and r.environment_id = new.environment_id;
				if not found then
					raise exception 'Wake parent run is unavailable' using errcode = '42501'; end if;
			end if;
		else
			if new.parent_run_id is not null or new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
		end if;$new$
]);

create or replace function public.qorpera_listener_source(p_source_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select p_source_kind in ('company-file', 'event', 'human-task', 'code-change', 'app-unhealthy', 'data-change')
$$;

select pg_temp.w6c_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure, array[
	$old$	-- A member's login pays only for work that member started (20260928230000).$old$,
	$new$	if p_wake.source_kind = 'app-unhealthy' and not exists (select 1 from public.qorpera_company_sites site
		where site.id = p_wake.source_id and site.profile_id = p_wake.profile_id
			and site.environment_id = p_wake.environment_id) then
		return false;
	end if;
	if p_wake.source_kind = 'code-change' and not exists (
		select 1 from public.qorpera_coding_repository_grants g
		where g.environment_id = p_wake.environment_id and g.staff_agent_id = p_wake.staff_agent_id and g.enabled
			and lower((g.repository ->> 'owner') || '/' || (g.repository ->> 'name'))
				= lower(coalesce(p_wake.payload ->> 'repo', ''))) then
		return false;
	end if;
	if p_wake.source_kind = 'data-change' and not public.qorpera_folder_actor_allowed(
		p_wake.environment_id, p_wake.profile_id,
		jsonb_build_object('kind', 'staff_agent', 'staffAgentId', p_wake.staff_agent_id,
			'requesterUserId', p_wake.requested_by_user_id,
			'audience', jsonb_build_object('kind', 'company'), 'sessionKind', 'in_house'),
		'data/' || coalesce(p_wake.payload ->> 'database', ''), 'read') then
		return false;
	end if;
	-- A member's login pays only for work that member started (20260928230000).$new$
]);

select pg_temp.w6c_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure, array[
	$old$			or (v_wake.source_kind = 'event' and v_wake.file_event_id is not null)$old$,
	$new$			or (v_wake.source_kind in ('event','code-change','app-unhealthy','data-change') and v_wake.file_event_id is not null)$new$,
	$old$			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file','event'))$old$,
	$new$			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file','event','code-change','app-unhealthy','data-change'))$new$,
	$old$			or (v_wake.source_kind = 'event' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'event'
				or v_wake.source_id is distinct from (v_trigger ->> 'hookId')::uuid)) then$old$,
	$new$			or (v_wake.source_kind = 'event' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'event'
				or v_wake.source_id is distinct from (v_trigger ->> 'hookId')::uuid))
			or (v_wake.source_kind = 'code-change' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'code-change'))
			or (v_wake.source_kind = 'app-unhealthy' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'app-unhealthy'))
			or (v_wake.source_kind = 'data-change' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'data-change')) then$new$
]);

create table public.qorpera_routine_check_states (
	routine_id uuid primary key references public.qorpera_cloud_routines(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	last_healthy boolean not null,
	last_summary text not null check (char_length(last_summary) between 1 and 500 and last_summary !~ '[[:cntrl:]]'),
	last_detail text check (last_detail is null or char_length(last_detail) <= 2000),
	consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
	checked_at timestamptz not null default clock_timestamp(),
	state_changed_at timestamptz not null default clock_timestamp()
);
create index qorpera_routine_check_states_env on public.qorpera_routine_check_states (environment_id, checked_at desc);
alter table public.qorpera_routine_check_states enable row level security;
revoke all on table public.qorpera_routine_check_states
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

create function public.qorpera_record_routine_check_result(
	p_routine_id uuid,
	p_healthy boolean,
	p_summary text,
	p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_routine public.qorpera_cloud_routines%rowtype;
	v_prev public.qorpera_routine_check_states%rowtype;
	v_now timestamptz := clock_timestamp();
	v_summary text := btrim(coalesce(p_summary, ''));
	v_detail text := case when p_detail is null then null else left(p_detail, 2000) end;
	v_state_changed boolean;
	v_should_wake boolean;
	v_failures integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Routine check authority is required' using errcode = '42501';
	end if;
	if p_routine_id is null or p_healthy is null or char_length(v_summary) not between 1 and 500 or v_summary ~ '[[:cntrl:]]' then
		raise exception 'Routine check result is invalid' using errcode = '22023';
	end if;
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id for share;
	if v_routine.id is null then
		raise exception 'Routine is unavailable' using errcode = '42501';
	end if;
	select * into v_prev from public.qorpera_routine_check_states where routine_id = p_routine_id for update;
	v_state_changed := v_prev.routine_id is not null and v_prev.last_healthy is distinct from p_healthy;
	v_failures := case when p_healthy then 0 else coalesce(v_prev.consecutive_failures, 0) + 1 end;
	v_should_wake := (not p_healthy) or v_state_changed;
	insert into public.qorpera_routine_check_states (
		routine_id, profile_id, environment_id, last_healthy, last_summary, last_detail,
		consecutive_failures, checked_at, state_changed_at
	) values (
		v_routine.id, v_routine.profile_id, v_routine.environment_id, p_healthy, v_summary, v_detail,
		v_failures, v_now, v_now
	)
	on conflict (routine_id) do update set
		last_healthy = excluded.last_healthy,
		last_summary = excluded.last_summary,
		last_detail = excluded.last_detail,
		consecutive_failures = excluded.consecutive_failures,
		checked_at = excluded.checked_at,
		state_changed_at = case
			when public.qorpera_routine_check_states.last_healthy is distinct from excluded.last_healthy
			then excluded.checked_at
			else public.qorpera_routine_check_states.state_changed_at
		end;
	return jsonb_build_object(
		'schema', 'qorpera.routine-check-result/v1',
		'routineId', v_routine.id,
		'healthy', p_healthy,
		'previousHealthy', v_prev.last_healthy,
		'stateChanged', v_state_changed,
		'shouldWake', v_should_wake,
		'consecutiveFailures', v_failures,
		'checkedAt', v_now
	);
end
$$;

create function public.qorpera_emit_code_change_routine_wakes(
	p_environment_id uuid,
	p_owner text,
	p_name text,
	p_kind text,
	p_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	c_schema constant text := 'qorpera.code-change-wakes/v1';
	v_profile uuid;
	v_repo text := lower(coalesce(p_owner, '') || '/' || coalesce(p_name, ''));
	v_listeners jsonb;
	v_targets jsonb;
	v_kept jsonb := '[]'::jsonb;
	v_listener record;
	v_item record;
	v_session uuid;
	v_sessions uuid[];
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_wakes integer := 0;
	v_skipped integer := 0;
	v_wake_ids jsonb := '[]'::jsonb;
	v_event_paths jsonb;
	v_main_before jsonb;
	v_found_paths jsonb;
	v_found_before text;
	v_parent_run_id uuid;
	v_parent_actor uuid;
	v_payload jsonb;
	v_change_key text;
	v_message text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if v_repo !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'
		or coalesce(p_kind, '') not in ('landed', 'undone', 'checks_failed', 'conflict')
		or p_event is null or jsonb_typeof(p_event) <> 'object' then
		raise exception 'Code change wake event is invalid' using errcode = '22023';
	end if;
	select profile_id into v_profile from public.qorpera_company_files
	where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then
		return jsonb_build_object('schema', c_schema, 'state', 'not_folder', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	v_event_paths := case when jsonb_typeof(p_event -> 'paths') = 'array' then p_event -> 'paths' else '[]'::jsonb end;
	v_main_before := p_event -> 'mainBefore';
	if coalesce(p_event ->> 'parentRunId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		select r.id, r.staff_agent_id into v_parent_run_id, v_parent_actor
		from public.qorpera_execution_runs as r
		where r.id = (p_event ->> 'parentRunId')::uuid
			and r.profile_id = v_profile
			and r.environment_id = p_environment_id;
	elsif coalesce(p_event ->> 'workerId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		select r.id, r.staff_agent_id into v_parent_run_id, v_parent_actor
		from public.qorpera_coding_sessions as cs
		join public.qorpera_coding_session_turns as t
			on t.worker_id = cs.worker_id and t.input_run_id is not null
		join public.qorpera_execution_runs as r
			on r.id = t.input_run_id and r.profile_id = cs.profile_id and r.environment_id = cs.environment_id
		where cs.worker_id = (p_event ->> 'workerId')::uuid
			and cs.profile_id = v_profile
			and cs.environment_id = p_environment_id
		order by t.sequence desc
		limit 1;
	end if;
	if p_kind = 'landed' and (jsonb_array_length(v_event_paths) = 0 or v_main_before is null) then
		select
			case
				when jsonb_typeof(c.paths) = 'array' then
					coalesce((select jsonb_agg(item ->> 'path') from jsonb_array_elements(c.paths) item where item ? 'path'), '[]'::jsonb)
				else '[]'::jsonb
			end,
			c.main_before
		into v_found_paths, v_found_before
		from public.qorpera_code_changes c
		where c.environment_id = p_environment_id
			and c.owner = lower(p_owner)
			and c.name = lower(p_name)
			and (
				((p_event ->> 'change') ~ '^[0-9]+$' and c.n = (p_event ->> 'change')::integer)
				or (c.main_after = (p_event ->> 'mainAfter'))
			)
		order by c.n desc
		limit 1;
		if found then
			if jsonb_array_length(v_event_paths) = 0 then
				v_event_paths := coalesce(v_found_paths, '[]'::jsonb);
			end if;
			if v_main_before is null and v_found_before is not null then
				v_main_before := to_jsonb(v_found_before);
			end if;
		end if;
	end if;
	select coalesce(jsonb_agg(l.listener order by l.routine_id), '[]'::jsonb) into v_listeners
	from (
		select jsonb_build_object(
				'routineId', r.id, 'version', r.current_version, 'triggerId', t.value ->> 'id',
				'staff', v.staff_agent_id, 'requester', v.created_by_user_id, 'trigger', t.value
			) as listener, r.id as routine_id
		from public.qorpera_cloud_routines r
		join public.qorpera_cloud_routine_versions v on v.routine_id = r.id and v.version = r.current_version
		join lateral (select x.value from jsonb_array_elements(v.triggers) x(value) limit 1) t
			on public.qorpera_cloud_routine_trigger_valid(t.value)
		where r.profile_id = v_profile and r.environment_id = p_environment_id
			and r.status = 'active' and r.folder_path is not null
			and t.value ->> 'kind' = 'listener' and t.value ->> 'source' = 'code-change'
			and t.value ->> 'repo' = v_repo
			and exists (select 1 from jsonb_array_elements_text(t.value -> 'events') ev(val) where ev.val = p_kind)
			and (not (t.value ? 'paths') or exists (
				select 1 from jsonb_array_elements_text(t.value -> 'paths') pat(val),
					jsonb_array_elements(v_event_paths) ep(val)
				where jsonb_typeof(ep.val) = 'string'
					and public.qorpera_glob_matches(pat.val, ep.val #>> '{}')
			))
		order by r.id limit 64
	) l;
	if jsonb_array_length(v_listeners) = 0 then
		return jsonb_build_object('schema', c_schema, 'state', 'idle', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from jsonb_array_elements(v_listeners) l, lateral (values
			(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || (l.value ->> 'requester'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities', 'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', l.value ->> 'routineId', 'mode', 'nokeyupdate'))
		) x(t)
	) y;
	v_change_key := coalesce(
		nullif(btrim(p_event ->> 'change'), ''),
		encode(extensions.digest(convert_to(v_repo || ':' || p_kind || ':' || p_event::text, 'utf8'), 'sha256'), 'hex')
	);
	v_payload := jsonb_build_object(
		'schema', 'qorpera.code-change-wake/v1',
		'repo', v_repo,
		'owner', lower(p_owner),
		'name', lower(p_name),
		'kind', p_kind,
		'change', p_event -> 'change',
		'mainBefore', v_main_before,
		'mainAfter', p_event -> 'mainAfter',
		'workerId', p_event -> 'workerId',
		'paths', v_event_paths,
		'checks', p_event -> 'checks'
	);
	begin
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		for v_listener in select x.value as l from jsonb_array_elements(v_listeners) x loop
			if not exists (select 1 from public.qorpera_cloud_routines r
				where r.id = (v_listener.l ->> 'routineId')::uuid and r.status = 'active'
					and r.current_version = (v_listener.l ->> 'version')::bigint and r.folder_path is not null)
				or not exists (select 1 from public.qorpera_profile_staff s
					where s.profile_id = v_profile and s.staff_agent_id = (v_listener.l ->> 'staff')::uuid
						and s.employment_status = 'active')
				or not exists (select 1 from public.qorpera_profile_members m
					where m.profile_id = v_profile and m.user_id = (v_listener.l ->> 'requester')::uuid)
				or not exists (select 1 from public.qorpera_coding_repository_grants g
					where g.environment_id = p_environment_id and g.staff_agent_id = (v_listener.l ->> 'staff')::uuid
						and g.enabled and lower((g.repository ->> 'owner') || '/' || (g.repository ->> 'name')) = v_repo)
				or (v_parent_run_id is not null and public.qorpera_wake_ancestry(
					v_parent_run_id, v_parent_actor, (v_listener.l ->> 'staff')::uuid, (v_listener.l ->> 'routineId')::uuid
				) is null) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_session := public.qorpera_folder_wake_public_session(v_profile, p_environment_id,
				(v_listener.l ->> 'staff')::uuid, (v_listener.l ->> 'requester')::uuid);
			if coalesce(v_listener.l -> 'trigger' ->> 'replyPolicy', 'required') = 'required' and v_session is null then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_kept := v_kept || jsonb_build_array(v_listener.l || jsonb_build_object(
				'session', v_session,
				'key', 'code-change:' || (v_listener.l ->> 'version') || ':' || (v_listener.l ->> 'triggerId') || ':' || left(v_change_key, 128)
			));
		end loop;
		select coalesce(array_agg(distinct (x.value ->> 'session')::uuid), '{}') into v_sessions
		from jsonb_array_elements(v_kept) x where x.value ->> 'session' is not null;
		perform 1 from public.qorpera_shared_sessions where id = any(v_sessions) and profile_id = v_profile order by id for key share;
		if jsonb_array_length(v_kept) > 0 then perform public.qorpera_folder_admit_wakes(v_profile); end if;
		for v_item in select x.value as w from jsonb_array_elements(v_kept) x loop
			begin
				v_wake := null;
				insert into public.qorpera_wake_occurrences (
					id, profile_id, environment_id, routine_id, routine_version, wake_kind,
					source_kind, trigger_id, occurrence_key, scheduled_for, not_before, parent_run_id, payload
				) values (
					extensions.gen_random_uuid(), v_profile, p_environment_id, (v_item.w ->> 'routineId')::uuid,
					(v_item.w ->> 'version')::bigint, 'routine', 'code-change', v_item.w ->> 'triggerId',
					v_item.w ->> 'key', clock_timestamp(), clock_timestamp(), v_parent_run_id, v_payload
				)
				on conflict (routine_id, occurrence_key) do nothing
				returning * into v_wake;
				if v_wake.id is not null then
					if v_wake.session_id is distinct from (v_item.w ->> 'session')::uuid then
						raise exception 'Wake routine audience changed' using errcode = 'QE2S0';
					end if;
					v_wakes := v_wakes + 1;
					v_wake_ids := v_wake_ids || to_jsonb(v_wake.id);
				end if;
			exception
				when sqlstate '55000' or sqlstate '42501' then
					get stacked diagnostics v_message = message_text;
					if v_message not in ('Routine has expired', 'Routine occurrence limit reached', 'Wake causal ancestry is fenced',
						'Wake recipient authority is unavailable', 'Wake public audience is unavailable') then raise; end if;
					v_skipped := v_skipped + 1;
			end;
		end loop;
	exception
		when lock_not_available or deadlock_detected or sqlstate 'QE2S0' then
			return jsonb_build_object('schema', c_schema, 'state', 'busy', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'wakes', v_wakes, 'skipped', v_skipped, 'wakeIds', v_wake_ids);
end
$$;

create function public.qorpera_emit_app_unhealthy_routine_wakes(
	p_environment_id uuid,
	p_site_id uuid,
	p_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	c_schema constant text := 'qorpera.app-unhealthy-wakes/v1';
	v_profile uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_listeners jsonb;
	v_targets jsonb;
	v_kept jsonb := '[]'::jsonb;
	v_listener record;
	v_item record;
	v_session uuid;
	v_sessions uuid[];
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_wakes integer := 0;
	v_skipped integer := 0;
	v_wake_ids jsonb := '[]'::jsonb;
	v_payload jsonb;
	v_incident_key text;
	v_message text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_environment_id is null or p_site_id is null or p_event is null or jsonb_typeof(p_event) <> 'object' then
		raise exception 'App unhealthy wake event is invalid' using errcode = '22023';
	end if;
	select profile_id into v_profile from public.qorpera_company_files
	where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then
		return jsonb_build_object('schema', c_schema, 'state', 'not_folder', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	select * into v_site from public.qorpera_company_sites
	where id = p_site_id and profile_id = v_profile and environment_id = p_environment_id;
	if v_site.id is null then
		return jsonb_build_object('schema', c_schema, 'state', 'idle', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	select coalesce(jsonb_agg(l.listener order by l.routine_id), '[]'::jsonb) into v_listeners
	from (
		select jsonb_build_object(
				'routineId', r.id, 'version', r.current_version, 'triggerId', t.value ->> 'id',
				'staff', v.staff_agent_id, 'requester', v.created_by_user_id, 'trigger', t.value
			) as listener, r.id as routine_id
		from public.qorpera_cloud_routines r
		join public.qorpera_cloud_routine_versions v on v.routine_id = r.id and v.version = r.current_version
		join lateral (select x.value from jsonb_array_elements(v.triggers) x(value) limit 1) t
			on public.qorpera_cloud_routine_trigger_valid(t.value)
		where r.profile_id = v_profile and r.environment_id = p_environment_id
			and r.status = 'active' and r.folder_path is not null
			and t.value ->> 'kind' = 'listener' and t.value ->> 'source' = 'app-unhealthy'
			and t.value ->> 'site' in (v_site.slug, v_site.id::text)
		order by r.id limit 64
	) l;
	if jsonb_array_length(v_listeners) = 0 then
		return jsonb_build_object('schema', c_schema, 'state', 'idle', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from jsonb_array_elements(v_listeners) l, lateral (values
			(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || (l.value ->> 'requester'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities', 'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', l.value ->> 'routineId', 'mode', 'nokeyupdate'))
		) x(t)
	) y;
	v_incident_key := coalesce(
		nullif(btrim(p_event ->> 'incidentKey'), ''),
		encode(extensions.digest(convert_to(v_site.id::text || ':' || coalesce(p_event ->> 'status', 'unhealthy')
			|| ':' || coalesce(p_event ->> 'restartCount', '0') || ':' || coalesce(p_event ->> 'error', ''), 'utf8'), 'sha256'), 'hex')
	);
	v_payload := jsonb_build_object(
		'schema', 'qorpera.app-unhealthy-wake/v1',
		'siteId', v_site.id,
		'slug', v_site.slug,
		'status', coalesce(nullif(btrim(p_event ->> 'status'), ''), 'unhealthy'),
		'restartCount', coalesce(case when jsonb_typeof(p_event -> 'restartCount') = 'number'
			and (p_event ->> 'restartCount') ~ '^[0-9]{1,9}$'
			then (p_event ->> 'restartCount')::integer end, 0),
		'error', p_event -> 'error'
	);
	begin
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		perform 1 from public.qorpera_company_sites site
		where site.id = v_site.id and site.profile_id = v_profile and site.environment_id = p_environment_id
		for key share;
		if not found then
			return jsonb_build_object('schema', c_schema, 'state', 'idle', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		for v_listener in select x.value as l from jsonb_array_elements(v_listeners) x loop
			if not exists (select 1 from public.qorpera_cloud_routines r
				where r.id = (v_listener.l ->> 'routineId')::uuid and r.status = 'active'
					and r.current_version = (v_listener.l ->> 'version')::bigint and r.folder_path is not null)
				or not exists (select 1 from public.qorpera_profile_staff s
					where s.profile_id = v_profile and s.staff_agent_id = (v_listener.l ->> 'staff')::uuid
						and s.employment_status = 'active')
				or not exists (select 1 from public.qorpera_profile_members m
					where m.profile_id = v_profile and m.user_id = (v_listener.l ->> 'requester')::uuid) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_session := public.qorpera_folder_wake_public_session(v_profile, p_environment_id,
				(v_listener.l ->> 'staff')::uuid, (v_listener.l ->> 'requester')::uuid);
			if coalesce(v_listener.l -> 'trigger' ->> 'replyPolicy', 'required') = 'required' and v_session is null then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_kept := v_kept || jsonb_build_array(v_listener.l || jsonb_build_object(
				'session', v_session,
				'key', 'app-unhealthy:' || (v_listener.l ->> 'version') || ':' || (v_listener.l ->> 'triggerId') || ':' || left(v_incident_key, 128)
			));
		end loop;
		select coalesce(array_agg(distinct (x.value ->> 'session')::uuid), '{}') into v_sessions
		from jsonb_array_elements(v_kept) x where x.value ->> 'session' is not null;
		perform 1 from public.qorpera_shared_sessions where id = any(v_sessions) and profile_id = v_profile order by id for key share;
		if jsonb_array_length(v_kept) > 0 then perform public.qorpera_folder_admit_wakes(v_profile); end if;
		for v_item in select x.value as w from jsonb_array_elements(v_kept) x loop
			begin
				v_wake := null;
				insert into public.qorpera_wake_occurrences (
					id, profile_id, environment_id, routine_id, routine_version, wake_kind,
					source_kind, source_id, trigger_id, occurrence_key, scheduled_for, not_before, payload
				) values (
					extensions.gen_random_uuid(), v_profile, p_environment_id, (v_item.w ->> 'routineId')::uuid,
					(v_item.w ->> 'version')::bigint, 'routine', 'app-unhealthy', v_site.id,
					v_item.w ->> 'triggerId', v_item.w ->> 'key', clock_timestamp(), clock_timestamp(), v_payload
				)
				on conflict (routine_id, occurrence_key) do nothing
				returning * into v_wake;
				if v_wake.id is not null then
					if v_wake.session_id is distinct from (v_item.w ->> 'session')::uuid then
						raise exception 'Wake routine audience changed' using errcode = 'QE2S0';
					end if;
					v_wakes := v_wakes + 1;
					v_wake_ids := v_wake_ids || to_jsonb(v_wake.id);
				end if;
			exception
				when sqlstate '55000' or sqlstate '42501' then
					get stacked diagnostics v_message = message_text;
					if v_message not in ('Routine has expired', 'Routine occurrence limit reached', 'Wake causal ancestry is fenced',
						'Wake recipient authority is unavailable', 'Wake public audience is unavailable') then raise; end if;
					v_skipped := v_skipped + 1;
			end;
		end loop;
	exception
		when lock_not_available or deadlock_detected or sqlstate 'QE2S0' then
			return jsonb_build_object('schema', c_schema, 'state', 'busy', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'wakes', v_wakes, 'skipped', v_skipped, 'wakeIds', v_wake_ids);
end
$$;

create function public.qorpera_emit_data_change_routine_wakes(
	p_environment_id uuid,
	p_database text,
	p_event jsonb,
	p_parent_run_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	c_schema constant text := 'qorpera.data-change-wakes/v1';
	v_profile uuid;
	v_table text;
	v_tables jsonb;
	v_operation text;
	v_parent_run_id uuid;
	v_parent_actor uuid;
	v_listeners jsonb;
	v_targets jsonb;
	v_kept jsonb := '[]'::jsonb;
	v_listener record;
	v_item record;
	v_session uuid;
	v_sessions uuid[];
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_wakes integer := 0;
	v_skipped integer := 0;
	v_wake_ids jsonb := '[]'::jsonb;
	v_payload jsonb;
	v_event_key text;
	v_message text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if coalesce(p_database, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_event is null or jsonb_typeof(p_event) <> 'object' then
		raise exception 'Data change wake event is invalid' using errcode = '22023';
	end if;
	v_table := nullif(btrim(p_event ->> 'table'), '');
	v_tables := case
		when jsonb_typeof(p_event -> 'tables') = 'array' then p_event -> 'tables'
		when v_table is not null then jsonb_build_array(v_table)
		else '[]'::jsonb
	end;
	v_operation := nullif(lower(btrim(p_event ->> 'operation')), '');
	if v_operation is not null and v_operation not in ('insert', 'update', 'delete') then
		raise exception 'Data change operation is invalid' using errcode = '22023';
	end if;
	select profile_id into v_profile from public.qorpera_company_files
	where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then
		return jsonb_build_object('schema', c_schema, 'state', 'not_folder', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	v_parent_run_id := coalesce(
		p_parent_run_id,
		case
			when coalesce(p_event ->> 'parentRunId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			then (p_event ->> 'parentRunId')::uuid
		end
	);
	if v_parent_run_id is not null then
		select r.id, r.staff_agent_id into v_parent_run_id, v_parent_actor
		from public.qorpera_execution_runs as r
		where r.id = v_parent_run_id and r.profile_id = v_profile and r.environment_id = p_environment_id;
	end if;
	select coalesce(jsonb_agg(l.listener order by l.routine_id), '[]'::jsonb) into v_listeners
	from (
		select jsonb_build_object(
				'routineId', r.id, 'version', r.current_version, 'triggerId', t.value ->> 'id',
				'staff', v.staff_agent_id, 'requester', v.created_by_user_id, 'trigger', t.value
			) as listener, r.id as routine_id
		from public.qorpera_cloud_routines r
		join public.qorpera_cloud_routine_versions v on v.routine_id = r.id and v.version = r.current_version
		join lateral (select x.value from jsonb_array_elements(v.triggers) x(value) limit 1) t
			on public.qorpera_cloud_routine_trigger_valid(t.value)
		where r.profile_id = v_profile and r.environment_id = p_environment_id
			and r.status = 'active' and r.folder_path is not null
			and t.value ->> 'kind' = 'listener' and t.value ->> 'source' = 'data-change'
			and t.value ->> 'database' = p_database
			and (not (t.value ? 'tables') or exists (
				select 1 from jsonb_array_elements_text(t.value -> 'tables') wt(val),
					jsonb_array_elements(v_tables) et(val)
				where jsonb_typeof(et.val) = 'string'
					and wt.val = (et.val #>> '{}')
			))
			and (not (t.value ? 'operations') or (v_operation is not null and exists (
				select 1 from jsonb_array_elements_text(t.value -> 'operations') wo(val)
				where wo.val = v_operation
			)))
		order by r.id limit 64
	) l;
	if jsonb_array_length(v_listeners) = 0 then
		return jsonb_build_object('schema', c_schema, 'state', 'idle', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end if;
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from jsonb_array_elements(v_listeners) l, lateral (values
			(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || (l.value ->> 'requester'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities', 'key', v_profile::text || ':' || (l.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', l.value ->> 'routineId', 'mode', 'nokeyupdate'))
		) x(t)
	) y;
	v_event_key := coalesce(
		nullif(btrim(p_event ->> 'eventKey'), ''),
		encode(extensions.digest(convert_to(p_database || ':' || v_tables::text || ':' || coalesce(v_operation, '')
			|| ':' || coalesce(p_event ->> 'rowId', '') || ':' || coalesce(p_event ->> 'at', ''), 'utf8'), 'sha256'), 'hex')
	);
	v_payload := jsonb_build_object(
		'schema', 'qorpera.data-change-wake/v1',
		'database', p_database,
		'table', coalesce(v_table, case when jsonb_array_length(v_tables) = 1 then v_tables ->> 0 end),
		'tables', v_tables,
		'operation', v_operation,
		'rowId', p_event -> 'rowId'
	);
	begin
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
		end if;
		for v_listener in select x.value as l from jsonb_array_elements(v_listeners) x loop
			if not exists (select 1 from public.qorpera_cloud_routines r
				where r.id = (v_listener.l ->> 'routineId')::uuid and r.status = 'active'
					and r.current_version = (v_listener.l ->> 'version')::bigint and r.folder_path is not null)
				or not exists (select 1 from public.qorpera_profile_staff s
					where s.profile_id = v_profile and s.staff_agent_id = (v_listener.l ->> 'staff')::uuid
						and s.employment_status = 'active')
				or not exists (select 1 from public.qorpera_profile_members m
					where m.profile_id = v_profile and m.user_id = (v_listener.l ->> 'requester')::uuid)
				or not public.qorpera_folder_actor_allowed(
					p_environment_id, v_profile,
					jsonb_build_object('kind', 'staff_agent', 'staffAgentId', (v_listener.l ->> 'staff')::uuid,
						'requesterUserId', (v_listener.l ->> 'requester')::uuid,
						'audience', jsonb_build_object('kind', 'company'), 'sessionKind', 'in_house'),
					'data/' || p_database, 'read')
				or (v_parent_run_id is not null and public.qorpera_wake_ancestry(
					v_parent_run_id, v_parent_actor, (v_listener.l ->> 'staff')::uuid, (v_listener.l ->> 'routineId')::uuid
				) is null) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_session := public.qorpera_folder_wake_public_session(v_profile, p_environment_id,
				(v_listener.l ->> 'staff')::uuid, (v_listener.l ->> 'requester')::uuid);
			if coalesce(v_listener.l -> 'trigger' ->> 'replyPolicy', 'required') = 'required' and v_session is null then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_kept := v_kept || jsonb_build_array(v_listener.l || jsonb_build_object(
				'session', v_session,
				'key', 'data-change:' || (v_listener.l ->> 'version') || ':' || (v_listener.l ->> 'triggerId') || ':' || left(v_event_key, 128)
			));
		end loop;
		select coalesce(array_agg(distinct (x.value ->> 'session')::uuid), '{}') into v_sessions
		from jsonb_array_elements(v_kept) x where x.value ->> 'session' is not null;
		perform 1 from public.qorpera_shared_sessions where id = any(v_sessions) and profile_id = v_profile order by id for key share;
		if jsonb_array_length(v_kept) > 0 then perform public.qorpera_folder_admit_wakes(v_profile); end if;
		for v_item in select x.value as w from jsonb_array_elements(v_kept) x loop
			begin
				v_wake := null;
				insert into public.qorpera_wake_occurrences (
					id, profile_id, environment_id, routine_id, routine_version, wake_kind,
					source_kind, trigger_id, occurrence_key, scheduled_for, not_before, parent_run_id, payload
				) values (
					extensions.gen_random_uuid(), v_profile, p_environment_id, (v_item.w ->> 'routineId')::uuid,
					(v_item.w ->> 'version')::bigint, 'routine', 'data-change', v_item.w ->> 'triggerId',
					v_item.w ->> 'key', clock_timestamp(), clock_timestamp(), v_parent_run_id, v_payload
				)
				on conflict (routine_id, occurrence_key) do nothing
				returning * into v_wake;
				if v_wake.id is not null then
					if v_wake.session_id is distinct from (v_item.w ->> 'session')::uuid then
						raise exception 'Wake routine audience changed' using errcode = 'QE2S0';
					end if;
					v_wakes := v_wakes + 1;
					v_wake_ids := v_wake_ids || to_jsonb(v_wake.id);
				end if;
			exception
				when sqlstate '55000' or sqlstate '42501' then
					get stacked diagnostics v_message = message_text;
					if v_message not in ('Routine has expired', 'Routine occurrence limit reached', 'Wake causal ancestry is fenced',
						'Wake recipient authority is unavailable', 'Wake public audience is unavailable') then raise; end if;
					v_skipped := v_skipped + 1;
			end;
		end loop;
	exception
		when lock_not_available or deadlock_detected or sqlstate 'QE2S0' then
			return jsonb_build_object('schema', c_schema, 'state', 'busy', 'wakes', 0, 'skipped', 0, 'wakeIds', '[]'::jsonb);
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'wakes', v_wakes, 'skipped', v_skipped, 'wakeIds', v_wake_ids);
end
$$;

create function public.qorpera_skip_checked_routine_wake(
	p_routine_id uuid,
	p_expected_version bigint,
	p_trigger_id text,
	p_scheduled_for timestamptz,
	p_expected_last_scheduled_for timestamptz,
	p_next_due_at timestamptz,
	p_healthy boolean,
	p_summary text,
	p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_routine public.qorpera_cloud_routines%rowtype;
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
	v_prev public.qorpera_routine_check_states%rowtype;
	v_now timestamptz := clock_timestamp();
	v_summary text := btrim(coalesce(p_summary, ''));
	v_detail text := case when p_detail is null then null else left(p_detail, 2000) end;
	v_state_changed boolean;
	v_should_wake boolean;
	v_failures integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Routine check authority is required' using errcode = '42501';
	end if;
	if p_routine_id is null or p_expected_version is null or p_expected_version < 1
		or octet_length(convert_to(btrim(coalesce(p_trigger_id, '')), 'utf8')) not between 1 and 160
		or p_trigger_id ~ E'[\r\n]'
		or p_scheduled_for is null or not isfinite(p_scheduled_for)
		or p_next_due_at is null or not isfinite(p_next_due_at)
		or p_next_due_at <= p_scheduled_for
		or (p_expected_last_scheduled_for is not null
			and (not isfinite(p_expected_last_scheduled_for) or p_scheduled_for <= p_expected_last_scheduled_for))
		or p_healthy is null
		or char_length(v_summary) not between 1 and 500
		or v_summary ~ '[[:cntrl:]]' then
		raise exception 'Routine check wake decision is invalid' using errcode = '22023';
	end if;
	select routine.profile_id into v_profile_id
	from public.qorpera_cloud_routines as routine where routine.id = p_routine_id;
	if v_profile_id is null then
		return jsonb_build_object('schema', 'qorpera.routine-check-wake/v1', 'status', 'stale', 'shouldWake', false);
	end if;
	perform 1 from public.qorpera_profiles where id = v_profile_id for key share;
	select routine.* into v_routine
	from public.qorpera_cloud_routines as routine where routine.id = p_routine_id for share;
	select cursor.* into v_cursor
	from public.qorpera_cloud_routine_schedule_cursors as cursor
	where cursor.routine_id = p_routine_id
		and cursor.routine_version = p_expected_version
		and cursor.trigger_id = btrim(p_trigger_id)
	for update;
	if v_routine.id is null or v_routine.status <> 'active'
		or v_routine.current_version <> p_expected_version
		or v_cursor.routine_id is null
		or v_cursor.last_scheduled_for is distinct from p_expected_last_scheduled_for
		or not exists (
			select 1 from public.qorpera_cloud_routine_versions as version
			cross join lateral jsonb_array_elements(version.triggers) as trigger(value)
			where version.routine_id = p_routine_id and version.version = p_expected_version
				and trigger.value ->> 'id' = btrim(p_trigger_id)
				and trigger.value ->> 'kind' = 'schedule'
				and trigger.value ? 'checkBeforeWake'
		) then
		return jsonb_build_object('schema', 'qorpera.routine-check-wake/v1', 'status', 'stale', 'shouldWake', false);
	end if;
	select * into v_prev from public.qorpera_routine_check_states where routine_id = p_routine_id for update;
	v_state_changed := v_prev.routine_id is not null and v_prev.last_healthy is distinct from p_healthy;
	v_failures := case when p_healthy then 0 else coalesce(v_prev.consecutive_failures, 0) + 1 end;
	v_should_wake := (not p_healthy) or v_state_changed;
	insert into public.qorpera_routine_check_states (
		routine_id, profile_id, environment_id, last_healthy, last_summary, last_detail,
		consecutive_failures, checked_at, state_changed_at
	) values (
		v_routine.id, v_routine.profile_id, v_routine.environment_id, p_healthy, v_summary, v_detail,
		v_failures, v_now, v_now
	)
	on conflict (routine_id) do update set
		last_healthy = excluded.last_healthy,
		last_summary = excluded.last_summary,
		last_detail = excluded.last_detail,
		consecutive_failures = excluded.consecutive_failures,
		checked_at = excluded.checked_at,
		state_changed_at = case
			when public.qorpera_routine_check_states.last_healthy is distinct from excluded.last_healthy
			then excluded.checked_at
			else public.qorpera_routine_check_states.state_changed_at
		end;
	if not v_should_wake then
		update public.qorpera_cloud_routine_schedule_cursors
		set last_scheduled_for = p_scheduled_for, next_due_at = p_next_due_at, updated_at = statement_timestamp()
		where routine_id = p_routine_id and routine_version = p_expected_version
			and trigger_id = btrim(p_trigger_id);
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.routine-check-wake/v1',
		'status', case when v_should_wake then 'wake_required' else 'skipped' end,
		'routineId', v_routine.id,
		'healthy', p_healthy,
		'previousHealthy', v_prev.last_healthy,
		'stateChanged', v_state_changed,
		'shouldWake', v_should_wake,
		'consecutiveFailures', v_failures,
		'nextDueAt', p_next_due_at,
		'checkedAt', v_now
	);
end
$$;

create function public.qorpera_read_routine_code_checks(
	p_routine_id uuid,
	p_repo text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_routine public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_repo text := nullif(lower(btrim(coalesce(p_repo, ''))), '');
	v_latest record;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Routine check authority is required' using errcode = '42501';
	end if;
	if p_routine_id is null then
		raise exception 'Routine id is required' using errcode = '22023';
	end if;
	if v_repo is not null and v_repo !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$' then
		raise exception 'Repository name is invalid' using errcode = '22023';
	end if;
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id;
	if v_routine.id is null or v_routine.status <> 'active' then
		return jsonb_build_object('schema', 'qorpera.routine-code-checks/v1', 'ok', false,
			'summary', 'Routine is unavailable', 'detail', null);
	end if;
	select * into v_version from public.qorpera_cloud_routine_versions
	where routine_id = v_routine.id and version = v_routine.current_version;
	if v_repo is not null and not exists (
		select 1 from public.qorpera_coding_repository_grants g
		where g.environment_id = v_routine.environment_id
			and g.staff_agent_id = v_version.staff_agent_id
			and g.enabled
			and lower((g.repository ->> 'owner') || '/' || (g.repository ->> 'name')) = v_repo
	) then
		return jsonb_build_object('schema', 'qorpera.routine-code-checks/v1', 'ok', false,
			'summary', 'Repository grant is unavailable', 'detail', v_repo);
	end if;
	select ch.owner, ch.name, ch.n, ch.state, ch.checks_state, ch.checks
	into v_latest
	from (
		select distinct on (lower(c.owner), lower(c.name))
			c.owner, c.name, c.n, c.state, c.checks_state, c.checks
		from public.qorpera_code_changes as c
		join public.qorpera_coding_repository_grants as g
			on g.environment_id = c.environment_id
			and g.staff_agent_id = v_version.staff_agent_id
			and g.enabled
			and lower((g.repository ->> 'owner') || '/' || (g.repository ->> 'name'))
				= lower(c.owner) || '/' || lower(c.name)
		where c.environment_id = v_routine.environment_id
			and (v_repo is null or lower(c.owner) || '/' || lower(c.name) = v_repo)
		order by lower(c.owner), lower(c.name), c.n desc
	) as ch
	order by (ch.state in ('conflict', 'refused')) desc, ch.n desc
	limit 1;
	if not found then
		return jsonb_build_object('schema', 'qorpera.routine-code-checks/v1', 'ok', true,
			'summary', 'No failed code checks recorded', 'detail', null);
	end if;
	if v_latest.state in ('conflict', 'refused') then
		return jsonb_build_object('schema', 'qorpera.routine-code-checks/v1', 'ok', false,
			'summary', lower(v_latest.owner) || '/' || lower(v_latest.name) || ' change #' || v_latest.n || ' ' || v_latest.state,
			'detail', coalesce(v_latest.checks::text, v_latest.state));
	end if;
	return jsonb_build_object('schema', 'qorpera.routine-code-checks/v1', 'ok', true,
		'summary', lower(v_latest.owner) || '/' || lower(v_latest.name) || ' change #' || v_latest.n || ' checks ' || coalesce(v_latest.checks_state, 'ok'),
		'detail', null);
end
$$;

create function public.qorpera_folder_emit_data_change_wakes(
	p_binding jsonb,
	p_database text,
	p_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_tool jsonb;
	v_run public.qorpera_execution_runs%rowtype;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	if coalesce(p_database, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_event is null or jsonb_typeof(p_event) <> 'object' then
		raise exception 'Data change wake event is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_folder_actor_allowed(
		v_run.environment_id, v_run.profile_id, v_tool -> 'resolved', 'data/' || p_database, 'read'
	) then
		raise exception 'Database is unavailable to this run' using errcode = '42501';
	end if;
	return public.qorpera_emit_data_change_routine_wakes(v_run.environment_id, p_database, p_event, v_run.id);
end
$$;

revoke all on function
	public.qorpera_set_coding_environment_grant_scope(uuid, uuid, text, text, uuid),
	public.qorpera_revoke_app_secret_grants_on_membership_change(),
	public.qorpera_grant_app_secret(uuid, uuid, uuid, text, text),
	public.qorpera_revoke_app_secret_grant(uuid, uuid),
	public.qorpera_list_app_secrets(uuid, uuid),
	public.qorpera_authorize_app_secrets(uuid, text, uuid, text, text, text, text, uuid),
	public.qorpera_set_code_site_auto_redeploy(uuid, text, text, boolean),
	public.qorpera_code_site_for_auto_redeploy(text, text, uuid, text, text, integer),
	public.qorpera_code_site_auto_redeploy_switch(text, text, uuid, uuid, uuid, text, text),
	public.qorpera_glob_matches(text, text),
	public.qorpera_routine_check_before_wake_valid(jsonb),
	public.qorpera_record_routine_check_result(uuid, boolean, text, text),
	public.qorpera_skip_checked_routine_wake(uuid, bigint, text, timestamptz, timestamptz, timestamptz, boolean, text, text),
	public.qorpera_read_routine_code_checks(uuid, text),
	public.qorpera_emit_code_change_routine_wakes(uuid, text, text, text, jsonb),
	public.qorpera_emit_app_unhealthy_routine_wakes(uuid, uuid, jsonb),
	public.qorpera_emit_data_change_routine_wakes(uuid, text, jsonb, uuid),
	public.qorpera_folder_emit_data_change_wakes(jsonb, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_site_relay;

grant execute on function
	public.qorpera_set_coding_environment_grant_scope(uuid, uuid, text, text, uuid),
	public.qorpera_set_code_site_auto_redeploy(uuid, text, text, boolean),
	public.qorpera_grant_app_secret(uuid, uuid, uuid, text, text),
	public.qorpera_revoke_app_secret_grant(uuid, uuid),
	public.qorpera_list_app_secrets(uuid, uuid)
	to authenticated;

grant execute on function
	public.qorpera_authorize_app_secrets(uuid, text, uuid, text, text, text, text, uuid)
	to qorpera_secret_broker;

grant execute on function
	public.qorpera_code_site_for_auto_redeploy(text, text, uuid, text, text, integer),
	public.qorpera_code_site_auto_redeploy_switch(text, text, uuid, uuid, uuid, text, text),
	public.qorpera_record_routine_check_result(uuid, boolean, text, text),
	public.qorpera_skip_checked_routine_wake(uuid, bigint, text, timestamptz, timestamptz, timestamptz, boolean, text, text),
	public.qorpera_read_routine_code_checks(uuid, text),
	public.qorpera_emit_code_change_routine_wakes(uuid, text, text, text, jsonb),
	public.qorpera_emit_app_unhealthy_routine_wakes(uuid, uuid, jsonb),
	public.qorpera_emit_data_change_routine_wakes(uuid, text, jsonb, uuid),
	public.qorpera_folder_emit_data_change_wakes(jsonb, text, jsonb)
	to service_role;

drop function pg_temp.w6c_patch(regprocedure, text[]);

comment on table public.qorpera_app_secret_grants is
	'20260930850000: scoped company environment secret grants for hosted app sites (build/test/runtime x dev/prod).';
comment on table public.qorpera_routine_check_states is
	'20260930850000: deterministic check-first routine state tracker used to wake LLM agents only on failure or state transition.';
comment on function public.qorpera_coding_environment_name_allowed(text) is
	'20260930850000: allows company-owned OPENAI_* and ANTHROPIC_* coding environment secrets while keeping host and harness internals refused.';
comment on function public.qorpera_authorize_app_secrets(uuid, text, uuid, text, text, text, text, uuid) is
	'20260930850000: broker-only scoped secret authorization for hosted app tmpfs injection bound to live executor custody and deployment or build proof.';
comment on function public.qorpera_skip_checked_routine_wake(uuid, bigint, text, timestamptz, timestamptz, timestamptz, boolean, text, text) is
	'20260930850000: records deterministic checkBeforeWake result and advances schedule cursor without waking the LLM when healthy and unchanged.';
