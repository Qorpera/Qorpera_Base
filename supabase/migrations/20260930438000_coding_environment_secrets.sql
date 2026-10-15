-- F3 step 5j-1 (secrets and the vault relay; plan approved by the coordinator on 15 October 2026): environment
-- secrets for coding machines, and the grant that gives a company secret to one repository's sessions.
--
-- 1. An environment secret is a vault secret with the connector 'environment', owned by a member or by the company
--    and captured like any other (begin, the broker's screen, complete). Its vault name is its variable's name in
--    lower case: NPM_TOKEN is npm_token. qorpera_coding_environment_name_allowed decides the names:
--    [a-z][a-z0-9_]{0,63}, never one the coding machine sets itself (HOME, PATH, TMPDIR, the proxy and certificate
--    variables, LC_*, GIT_*, LD_*, DYLD_*, SSH_*, XDG_*, DOCKER_*, QORPERA_*), and never one that names a harness's
--    login or provider (ANTHROPIC_*, CLAUDE_*, CODEX_*, OPENAI_*), so no secret switches who pays for a session.
--    A capture under another name is refused (22023).
-- 2. qorpera_coding_environment_grants: one company secret for one repository (owner/name in lower case, as GitHub
--    compares them), issued by a current owner or administrator. It ends with its secret, when an owner or
--    administrator withdraws it, and for good when its issuer stops being an owner or administrator or leaves (a
--    later promotion never revives it). Folder-v2's member changes take its rows at rank 8, after the operation
--    grants and before the secrets; Disconnect takes them after the operation grants and before the secret, and one
--    created while it waited for the secret NOWAIT (55P03, as the operation grants).
-- 3. qorpera_authorize_coding_environment, for the secret broker only: a coding session on a live lease gets the
--    envelopes of the member's own environment secrets and of the company secrets granted on its repository by an
--    issuer who is still an owner or administrator. A company secret without a grant never serves. When a member
--    secret and a granted company secret share a name, the company's wins. One audit row per secret
--    (environment_secret_used).
-- 4. Members: qorpera_grant_coding_environment_secret and qorpera_revoke_coding_environment_grant (owners and
--    administrators), and qorpera_list_coding_environment (names, owners and live grants; never a value).
-- Each patched body names 20260930438000, for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; so does a database without E4b's capture check (the anchor below).
do $$ begin
	if to_regclass('public.qorpera_coding_environment_grants') is not null then
		raise exception '5j-1 (20260930438000) is already applied'; end if;
	if position('20260930280000' in pg_get_functiondef(
		'public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure)) = 0 then
		raise exception '5j-1 (20260930438000) needs E4b (20260930280000)'; end if;
end $$;

create function pg_temp.environment_secrets_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% differs from the text this migration patches, near %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The names -------------------------------------------------------------------------------------------------------

create function public.qorpera_coding_environment_name_allowed(p_name text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_name ~ '^[a-z][a-z0-9_]{0,63}$'
		and p_name !~ '^(lc|git|ld|dyld|qorpera|ssh|xdg|docker|anthropic|claude|codex|openai)_'
		and p_name <> all (array[
			'home', 'path', 'tmpdir', 'tmp', 'temp', 'user', 'logname', 'shell', 'pwd', 'oldpwd', 'term', 'colorterm',
			'columns', 'lines', 'lang', 'language', 'tz', 'bash_env', 'env', 'ifs', 'ps1', 'ps2', 'ps4', 'prompt_command',
			'shellopts', 'bashopts', 'cdpath', 'globignore', 'hostname', 'shlvl', 'mail', 'mailpath', 'http_proxy',
			'https_proxy', 'no_proxy', 'all_proxy', 'ftp_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'node_extra_ca_certs'
		]), false)
$$;

select pg_temp.environment_secrets_patch(
	'public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure,
	$old$	if p_connector_id = 'event_hook' and public.qorpera_company_is_folder_v2(p_profile_id) then
		raise exception 'A hook''s signing secret comes from the vault' using errcode = '0A000';
	end if;
$old$,
	$new$	if p_connector_id = 'event_hook' and public.qorpera_company_is_folder_v2(p_profile_id) then
		raise exception 'A hook''s signing secret comes from the vault' using errcode = '0A000';
	end if;
	-- 20260930438000 (5j-1): an environment secret is named for its variable, never for one the coding machine sets
	-- itself or one that names a harness's login. Refused before any lock.
	if p_connector_id = 'environment' and not public.qorpera_coding_environment_name_allowed(p_secret_name) then
		raise exception 'That name is not available for an environment variable' using errcode = '22023';
	end if;
$new$);

-- 2. The grants ------------------------------------------------------------------------------------------------------

create table public.qorpera_coding_environment_grants (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	secret_id uuid not null references public.qorpera_cloud_secrets(id) on delete restrict,
	repository text not null check (repository ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'),
	issued_by_user_id uuid not null references auth.users(id) on delete restrict,
	status text not null default 'active' check (status in ('active','revoked')),
	created_at timestamptz not null default statement_timestamp(),
	revoked_at timestamptz,
	revoked_by_user_id uuid references auth.users(id) on delete restrict,
	check ((status = 'revoked') = (revoked_at is not null)),
	check (status = 'revoked' or revoked_by_user_id is null)
);
create unique index qorpera_coding_environment_grants_active
	on public.qorpera_coding_environment_grants (secret_id, repository) where status = 'active';
create index qorpera_coding_environment_grants_repository
	on public.qorpera_coding_environment_grants (profile_id, environment_id, repository) where status = 'active';
create index qorpera_coding_environment_grants_issuer
	on public.qorpera_coding_environment_grants (profile_id, issued_by_user_id) where status = 'active';
alter table public.qorpera_coding_environment_grants enable row level security;
revoke all on table public.qorpera_coding_environment_grants
	from public, anon, authenticated, service_role, qorpera_secret_broker;

comment on table public.qorpera_coding_environment_grants is
	'20260930438000 (5j-1): a company environment secret given to the coding sessions of one repository (owner/name, '
	'lower case). Revoked with its secret, by an owner or administrator, and for good when its issuer stops being one.';

-- The audit event types as they stand, and the three new ones; a used environment secret names its coding worker, as a
-- used repository credential does.
do $$
declare v_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g')
		with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	if v_types is null or not 'hook_secret_used' = any(v_types) or 'environment_grant_issued' = any(v_types) then
		raise exception '5j-1 (20260930438000): the audit event types differ: %', v_types; end if;
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s)),
		drop constraint qorpera_cloud_secret_audit_events_coding_worker,
		add constraint qorpera_cloud_secret_audit_events_coding_worker check (
			(event_type in (''repository_credential_used'', ''environment_secret_used''))
				= (coding_worker_id is not null))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types
				|| array['environment_grant_issued', 'environment_grant_revoked', 'environment_secret_used'])
				with ordinality as u(t, o)));
end $$;

-- Disconnect: the secret's repository grants after its operation grants and before the secret, as rank 8 orders them;
-- one created while it waited, NOWAIT once the secret is held (a member change may hold it and wait for this one).
select pg_temp.environment_secrets_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure,
$old$		order by grant_row.id for update;
	end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;$old$,
$new$		order by grant_row.id for update;
	end if;
	-- 20260930438000 (5j-1): an environment secret's repository grants, after the operation grants.
	perform 1 from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.secret_id = p_secret_id and environment_grant.profile_id = p_profile_id
		and environment_grant.status = 'active'
	order by environment_grant.id for update;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;$new$);
select pg_temp.environment_secrets_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure,
$old$		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';$old$,
$new$		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';
		-- 20260930438000 (5j-1): and its repository grants; one created while this waited, NOWAIT.
		perform 1 from public.qorpera_coding_environment_grants as environment_grant
		where environment_grant.secret_id = v_secret.id and environment_grant.status = 'active'
		order by environment_grant.id for update nowait;
		update public.qorpera_coding_environment_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';$new$);

-- The grants an owner or administrator issued end, for good, when the issuer stops being one or leaves: a later
-- promotion or invitation never revives them.
create function public.qorpera_revoke_coding_environment_grants_on_membership_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'UPDATE' and new.role in ('owner','admin') then return new; end if;
	with revoked as (
		update public.qorpera_coding_environment_grants as environment_grant
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = auth.uid()
		where environment_grant.profile_id = old.profile_id and environment_grant.issued_by_user_id = old.user_id
			and environment_grant.status = 'active'
		returning environment_grant.*
	)
	insert into public.qorpera_cloud_secret_audit_events(
		profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id)
	select revoked.profile_id,revoked.environment_id,revoked.secret_id,secret.current_version,revoked.id,
		'environment_grant_revoked',auth.uid(),secret.connector_id
	from revoked join public.qorpera_cloud_secrets as secret on secret.id = revoked.secret_id;
	if tg_op = 'DELETE' then return old; end if;
	return new;
end
$$;
create trigger qorpera_coding_environment_grant_authority
after update of role or delete on public.qorpera_profile_members
for each row execute function public.qorpera_revoke_coding_environment_grants_on_membership_change();

-- Rank 8 of a folder-v2 member change: the repository grants the member issued, which the trigger revokes, after the
-- operation grants and before the secrets.
select pg_temp.environment_secrets_patch('public.qorpera_folder_member_change_enter(uuid,uuid,text)'::regprocedure,
$old$	order by grant_row.id for no key update;
	if p_mode = 'remove' then
$old$,
$new$	order by grant_row.id for no key update;
	-- 20260930438000 (5j-1): the repository grants it issued.
	perform 1 from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.profile_id = p_profile_id and environment_grant.issued_by_user_id = p_user_id
		and environment_grant.status = 'active'
	order by environment_grant.id for no key update;
	if p_mode = 'remove' then
$new$);

-- 3. The broker's read -----------------------------------------------------------------------------------------------

-- A coding session's environment, for the secret broker only (20260930438000). The session must hold a live lease of
-- this executor in a phase that runs commands, its agent an enabled grant for its repository, and its member must still
-- be one who may write. It gets:
--   - the member's own environment secrets;
--   - the company's environment secrets granted on its repository (owner/name, lower case) by an issuer who is still an
--     owner or administrator; a company secret without a grant never serves;
--   - for a name both have, the company's.
-- Only secrets this broker sealed, under names still allowed. The repository's live grants are taken first, as an
-- operation's grant is (rank 8), and only those taken serve; then the secrets in id order, then their current
-- versions; one audit row each. The values never reach this database.
create function public.qorpera_authorize_coding_environment(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_worker_id uuid,
	p_lease_token uuid,
	p_executor_owner text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_repository text;
	v_grant_ids uuid[];
	v_secret_ids uuid[];
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_secrets jsonb := '[]'::jsonb;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_worker_id is null or p_lease_token is null
		or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
		raise exception 'coding environment request is invalid' using errcode = '22023';
	end if;
	-- The company row first (rank 0): the audit rows' key needs it.
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id) for key share;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	select session.* into v_session
	from public.qorpera_coding_sessions as session
	where session.worker_id = p_worker_id for share;
	if v_session.worker_id is null or v_session.profile_id <> v_authority.profile_id then
		raise exception 'coding session is unavailable to this broker' using errcode = '42501';
	end if;
	if v_session.phase not in ('preparing','running','awaiting_input','input_ready','publishing')
		or v_session.lease_owner is distinct from p_executor_owner
		or v_session.lease_token is distinct from p_lease_token
		or v_session.lease_until <= clock_timestamp() then
		raise exception 'coding session lease is unavailable' using errcode = '42501';
	end if;
	select worker.* into v_worker
	from public.qorpera_runtime_workers as worker
	where worker.id = v_session.worker_id;
	if v_worker.id is null or v_worker.species <> 'coding' or v_worker.state <> 'active'
		or v_worker.profile_id <> v_session.profile_id or v_worker.environment_id <> v_session.environment_id
		or not exists (
			select 1 from public.qorpera_coding_executors as executor
			where executor.environment_id = v_session.environment_id and executor.owner = p_executor_owner
				and executor.enabled
		) then
		raise exception 'coding executor is unavailable' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = v_worker.profile_id and staff.staff_agent_id = v_worker.staff_agent_id
			and staff.employment_status = 'active'
	) or not exists (
		select 1 from public.qorpera_coding_repository_grants as repository_grant
		where repository_grant.environment_id = v_session.environment_id
			and repository_grant.staff_agent_id = v_worker.staff_agent_id
			and repository_grant.repository = v_session.repository and repository_grant.enabled
	) then
		raise exception 'coding repository grant is unavailable' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_session.profile_id and member.user_id = v_worker.owner_user_id
			and member.role in ('owner','admin','contributor')
	) then
		raise exception 'coding session member is unavailable' using errcode = '42501';
	end if;
	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));
	-- The repository's live grants before the secrets, and only those serve: a withdrawal, a Disconnect or an issuer's
	-- demotion that commits while this waits is read below, none can end a grant while this serves it, and a grant made
	-- meanwhile (not taken here) serves from the next read.
	select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_grant_ids
	from (
		select environment_grant.id from public.qorpera_coding_environment_grants as environment_grant
		where environment_grant.profile_id = v_session.profile_id
			and environment_grant.environment_id = v_session.environment_id
			and environment_grant.repository = v_repository and environment_grant.status = 'active'
		order by environment_grant.id for share
	) as locked;
	with granted as (
		select secret.id, secret.secret_name
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
			and secret.connector_id = 'environment' and secret.owner_kind = 'company' and secret.status = 'active'
			and secret.broker_authority_id = v_authority.id
			and public.qorpera_coding_environment_name_allowed(secret.secret_name)
			and exists (
				select 1 from public.qorpera_coding_environment_grants as environment_grant
				where environment_grant.id = any(v_grant_ids) and environment_grant.secret_id = secret.id
					and environment_grant.repository = v_repository and environment_grant.status = 'active'
					and exists (
						select 1 from public.qorpera_profile_members as issuer
						where issuer.profile_id = environment_grant.profile_id
							and issuer.user_id = environment_grant.issued_by_user_id and issuer.role in ('owner','admin')
					)
			)
	)
	select coalesce(array_agg(chosen.id), '{}'::uuid[]) into v_secret_ids
	from (
		select secret.id
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
			and secret.connector_id = 'environment' and secret.status = 'active'
			and secret.broker_authority_id = v_authority.id
			and public.qorpera_coding_environment_name_allowed(secret.secret_name)
			and (secret.id in (select granted.id from granted)
				or (secret.owner_kind = 'member' and secret.owner_user_id = v_worker.owner_user_id
					and secret.secret_name not in (select granted.secret_name from granted)))
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
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id,environment_id,secret_id,secret_version,event_type,connector_id,coding_worker_id
		) values (
			v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,
			'environment_secret_used',v_secret.connector_id,v_worker.id
		);
		v_secrets := v_secrets || jsonb_build_object(
			'name',upper(v_secret.secret_name),'secretId',v_secret.id,'secretVersion',v_secret.current_version,
			'keyId',v_version.key_id,'ownerKind',v_secret.owner_kind,
			'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),
			'envelopeSha256',v_version.envelope_sha256
		);
	end loop;
	return jsonb_build_object(
		'schema','qorpera.coding-environment-authorization/v1',
		'companyId',v_session.profile_id,'environmentId',v_session.environment_id,
		'workerId',v_worker.id,'repository',v_session.repository,
		'secrets',v_secrets
	);
end
$$;

-- 4. Members ---------------------------------------------------------------------------------------------------------

-- Gives a company environment secret to the coding sessions of one repository (owner/name, any case). Owners and
-- administrators only; giving it again returns the live grant.
create function public.qorpera_grant_coding_environment_secret(p_profile_id uuid, p_secret_id uuid, p_repository text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_repository text;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_grant public.qorpera_coding_environment_grants%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501'; end if;
	if coalesce(p_repository, '')
		!~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$' then
		raise exception 'A repository is named owner/name' using errcode = '22023'; end if;
	v_repository := lower(p_repository);
	-- The company row first (rank 0), then the caller's member row, then the secret (rank 8).
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501'; end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;
	if v_secret.id is null or v_secret.owner_kind <> 'company' or v_secret.connector_id <> 'environment'
		or v_secret.status <> 'active' or not public.qorpera_coding_environment_name_allowed(v_secret.secret_name) then
		raise exception 'company environment secret is unavailable' using errcode = '42501'; end if;
	select environment_grant.* into v_grant from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.secret_id = v_secret.id and environment_grant.repository = v_repository
		and environment_grant.status = 'active';
	if v_grant.id is null then
		insert into public.qorpera_coding_environment_grants(
			profile_id,environment_id,secret_id,repository,issued_by_user_id)
		values (v_secret.profile_id,v_secret.environment_id,v_secret.id,v_repository,v_user_id)
		returning * into v_grant;
		insert into public.qorpera_cloud_secret_audit_events(
			profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id)
		values (v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,v_grant.id,
			'environment_grant_issued',v_user_id,v_secret.connector_id);
	end if;
	return jsonb_build_object('schema','qorpera.coding-environment-grant/v1','grantId',v_grant.id,
		'secretId',v_grant.secret_id,'repository',v_grant.repository,'issuedByUserId',v_grant.issued_by_user_id,
		'status',v_grant.status,'createdAt',v_grant.created_at);
end
$$;

-- Withdraws a repository grant. Owners and administrators only; a withdrawn one stays withdrawn.
create function public.qorpera_revoke_coding_environment_grant(p_profile_id uuid, p_grant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
	v_grant public.qorpera_coding_environment_grants%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501'; end if;
	-- The company row first (rank 0), then the caller's member row, then the grant (rank 8).
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'coding environment grants need an owner or administrator' using errcode = '42501'; end if;
	select environment_grant.* into v_grant from public.qorpera_coding_environment_grants as environment_grant
	where environment_grant.id = p_grant_id and environment_grant.profile_id = p_profile_id for update;
	if v_grant.id is null then
		raise exception 'coding environment grant is unavailable' using errcode = '42501'; end if;
	if v_grant.status = 'active' then
		update public.qorpera_coding_environment_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where id = v_grant.id returning * into v_grant;
		insert into public.qorpera_cloud_secret_audit_events(
			profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id)
		select v_grant.profile_id,v_grant.environment_id,v_grant.secret_id,secret.current_version,v_grant.id,
			'environment_grant_revoked',v_user_id,secret.connector_id
		from public.qorpera_cloud_secrets as secret where secret.id = v_grant.secret_id;
	end if;
	return jsonb_build_object('schema','qorpera.coding-environment-grant/v1','grantId',v_grant.id,
		'secretId',v_grant.secret_id,'repository',v_grant.repository,'issuedByUserId',v_grant.issued_by_user_id,
		'status',v_grant.status,'createdAt',v_grant.created_at);
end
$$;

-- A member's view of one environment's coding variables: the company's environment secrets and the caller's own, each
-- with its name as a variable, its owner and, for the company's, the repositories it is granted on (live grants only).
-- Never a value.
create function public.qorpera_list_coding_environment(p_profile_id uuid, p_environment_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select case when not public.qorpera_can_read_profile(p_profile_id) then '[]'::jsonb else coalesce((
		select jsonb_agg(jsonb_build_object(
			'schema','qorpera.coding-environment-secret/v1','secretId',secret.id,
			'name',upper(secret.secret_name),'ownerKind',secret.owner_kind,'purpose',secret.purpose,
			'version',secret.current_version,
			'grants',coalesce((
				select jsonb_agg(jsonb_build_object(
					'grantId',environment_grant.id,'repository',environment_grant.repository,
					'issuedByUserId',environment_grant.issued_by_user_id,'createdAt',environment_grant.created_at
				) order by environment_grant.repository, environment_grant.id)
				from public.qorpera_coding_environment_grants as environment_grant
				where environment_grant.secret_id = secret.id and environment_grant.status = 'active'
					and exists (
						select 1 from public.qorpera_profile_members as issuer
						where issuer.profile_id = environment_grant.profile_id
							and issuer.user_id = environment_grant.issued_by_user_id and issuer.role in ('owner','admin')
					)
			), '[]'::jsonb),
			'createdAt',secret.created_at,
			'updatedAt',secret.updated_at
		) order by secret.secret_name, secret.owner_kind, secret.id)
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
			and secret.connector_id = 'environment' and secret.status = 'active'
			and (secret.owner_kind = 'company' or secret.owner_user_id = auth.uid())
	), '[]'::jsonb) end
$$;

-- 5. Privileges ------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_coding_environment_name_allowed(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_revoke_coding_environment_grants_on_membership_change()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)
	to qorpera_secret_broker;
revoke all on function public.qorpera_grant_coding_environment_secret(uuid,uuid,text)
	from public, anon, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_revoke_coding_environment_grant(uuid,uuid)
	from public, anon, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_list_coding_environment(uuid,uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_grant_coding_environment_secret(uuid,uuid,text) to authenticated;
grant execute on function public.qorpera_revoke_coding_environment_grant(uuid,uuid) to authenticated;
grant execute on function public.qorpera_list_coding_environment(uuid,uuid) to authenticated;
