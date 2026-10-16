-- F3 step 5j-6a (the vault relay's database half; plan approved by the coordinator on 15 October 2026): MCP sign-ins
-- for coding sessions, and the fetch a running session makes through the broker.
--
-- 1. An MCP sign-in is a vault secret with the connector 'mcp', owned by a member or by the company and captured like
--    any other (begin, the broker's screen, complete). qorpera_coding_mcp_sign_ins records what the broker needs
--    beside the value: the server's origin (https://host[:port], lower case, no :443, a public name), the kind
--    (api_key now; oauth is 5j-7's, with room for its refresh secret) and the header that carries it (Authorization:
--    Bearer by default; never one the relay sets itself). Its vault name is derived from the origin
--    (qorpera_coding_mcp_secret_name), so the active-name index keeps one active sign-in per owner and origin.
--    qorpera_begin_coding_mcp_sign_in starts the capture and writes the record; completing a first version under 'mcp'
--    needs that record (a plain capture under 'mcp' never completes). A rotation is a plain capture of the existing
--    secret, which keeps its name and so its origin.
-- 2. Who gets it: a member's own sign-in reaches only that member's coding sessions (contract 11.5); the company's
--    reaches every coding session in the company (no per-repository grant, coordinator 15 October); for one origin,
--    the company's wins. Disconnect revokes it; a member who leaves loses their own (the custody's removal), and a
--    member made a viewer has no session that may run (the read refuses it). A company sign-in outlives its creator's
--    demotion, as a company connection does.
-- 3. qorpera_authorize_coding_mcp_sign_in, for the secret broker only: a coding session on a live lease gets the one
--    sign-in for the origin it asks for, or none (signIn null). One audit row per use (mcp_sign_in_used).
-- 4. qorpera_authorize_coding_repository_fetch, for the secret broker only: the company's GitHub connection for a
--    running session's own repository, under the agent's live grant, so the broker fetches (upload-pack only) while
--    the session runs; the repository credential stays for preparing and publishing. Audited as repository_fetch_used.
-- 5. Members: qorpera_list_coding_mcp_sign_ins (origins, headers and owners; never a value).
-- Both broker reads share 5j-1's session checks and lock order (qorpera_coding_relay_session), with the session
-- member's row taken at rank 1 (shared) so a demotion or a removal cannot commit while one serves, and the role taken
-- there decides; 5j-1's qorpera_authorize_coding_environment is patched to do so too. The broker refuses a private
-- address when it connects (5j-6b); this database only refuses names that never resolve publicly. The patched bodies
-- name 20260930440000, for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; so does a database without 5j-1 (the audit types below).
do $$ begin
	if to_regclass('public.qorpera_coding_mcp_sign_ins') is not null then
		raise exception '5j-6a (20260930440000) is already applied'; end if;
	if to_regclass('public.qorpera_coding_environment_grants') is null then
		raise exception '5j-6a (20260930440000) needs 5j-1 (20260930438000)'; end if;
end $$;

create function pg_temp.coding_mcp_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% differs from the text this migration patches, near %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The origin, the header and the name -----------------------------------------------------------------------------

-- An MCP server's origin, spelled one way: https, a lower-case DNS name of two labels or more whose last is not a
-- number, decimal or hex (no address literal in any spelling a URL parser reads as one), nor a name kept for private
-- networks, and a port only when it is not 443. No casts, so a constant argument never fails at planning.
create function public.qorpera_coding_mcp_origin_valid(p_origin text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when char_length(p_origin) <= 267
		and p_origin ~ '^https://[a-z0-9.-]+(:[1-9][0-9]{0,4})?$' then
		public.qorpera_company_account_host_valid(substring(p_origin from '^https://([a-z0-9.-]+)'))
		and substring(p_origin from '\.([a-z0-9-]+)(:[0-9]+)?$') !~ '^(0x[0-9a-f]*|[0-9]+)$'
		and substring(p_origin from '\.([a-z0-9-]+)(:[0-9]+)?$') <> all (array[
			'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'arpa', 'test', 'invalid',
			'example'])
		and coalesce(substring(p_origin from ':([0-9]+)$') <> '443'
			and (char_length(substring(p_origin from ':([0-9]+)$')) < 5 or substring(p_origin from ':([0-9]+)$') <= '65535'),
			true)
		else false end, false)
$$;

-- The header a sign-in travels in: a lower-case field name, never one the relay or HTTP itself sets (the connection,
-- the body's framing, cookies, forwarding, the browser's and MCP's own).
create function public.qorpera_coding_mcp_header_allowed(p_name text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'
		and p_name !~ '^(proxy|x-forwarded|mcp|sec)-'
		and p_name <> all (array[
			'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length',
			'content-type', 'content-encoding', 'cookie', 'accept', 'accept-encoding', 'expect', 'forwarded', 'via',
			'origin', 'referer', 'x-real-ip', 'last-event-id'
		]), false)
$$;

-- A sign-in's vault name: mcp-, the origin's host and port as a slug, and the start of the origin's SHA-256, so two
-- origins never share a name (at most 63 characters).
create function public.qorpera_coding_mcp_secret_name(p_origin text)
returns text language sql immutable set search_path = '' as $$
	select 'mcp-' || left(regexp_replace(substr(p_origin, 9), '[^a-z0-9]+', '-', 'g'), 42) || '-'
		|| left(encode(extensions.digest(p_origin, 'sha256'), 'hex'), 16)
$$;

-- 2. The record ------------------------------------------------------------------------------------------------------

create table public.qorpera_coding_mcp_sign_ins (
	-- The secret its capture creates (none until the first version completes), and that capture.
	secret_id uuid primary key,
	capture_ticket_id uuid not null unique
		references public.qorpera_cloud_secret_capture_tickets(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	origin text not null check (public.qorpera_coding_mcp_origin_valid(origin)),
	kind text not null default 'api_key' check (kind in ('api_key','oauth')),
	header_name text not null default 'authorization' check (public.qorpera_coding_mcp_header_allowed(header_name)),
	header_prefix text not null default 'Bearer ' check (header_prefix ~ '^([A-Za-z][A-Za-z0-9_-]{0,31} )?$'),
	-- An OAuth sign-in's refresh token, a secret of its own (5j-7).
	refresh_secret_id uuid unique references public.qorpera_cloud_secrets(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	check (kind = 'oauth' or refresh_secret_id is null),
	check (kind = 'api_key' or (header_name = 'authorization' and header_prefix = 'Bearer '))
);
create index qorpera_coding_mcp_sign_ins_origin
	on public.qorpera_coding_mcp_sign_ins (profile_id, environment_id, origin);
alter table public.qorpera_coding_mcp_sign_ins enable row level security;
revoke all on table public.qorpera_coding_mcp_sign_ins
	from public, anon, authenticated, service_role, qorpera_secret_broker;

comment on table public.qorpera_coding_mcp_sign_ins is
	'20260930440000 (5j-6a): what the broker needs beside an MCP sign-in''s value (connector mcp): the server''s origin, '
	'the kind and the header that carries it. Written by qorpera_begin_coding_mcp_sign_in with its capture; it serves '
	'while its secret is active.';

-- The audit event types as they stand, and the two new ones; both name their coding worker, as the other coding reads
-- do.
do $$
declare
	v_types text[];
	v_worker_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g')
		with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	select array_agg(m.value[1] order by m.value[1]) into v_worker_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m(value)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_coding_worker';
	if v_types is null or not 'environment_secret_used' = any(v_types) or 'mcp_sign_in_used' = any(v_types)
		or v_worker_types is distinct from array['environment_secret_used', 'repository_credential_used'] then
		raise exception '5j-6a (20260930440000): the audit event types differ: % / %', v_types, v_worker_types; end if;
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s)),
		drop constraint qorpera_cloud_secret_audit_events_coding_worker,
		add constraint qorpera_cloud_secret_audit_events_coding_worker check (
			(event_type in (''repository_credential_used'', ''environment_secret_used'', ''mcp_sign_in_used'',
				''repository_fetch_used'')) = (coding_worker_id is not null))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types || array['mcp_sign_in_used', 'repository_fetch_used']) with ordinality as u(t, o)));
end $$;

-- The first version of an MCP sign-in completes only with its record: the capture qorpera_begin_coding_mcp_sign_in
-- started, under the name its origin gives. Checked after the ticket is taken and found pending, before the secret.
select pg_temp.coding_mcp_patch(
	'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
	$old$	if v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp() then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
$old$,
	$new$	if v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp() then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	-- 20260930440000 (5j-6a): an MCP sign-in's first version only with the record its own begin wrote.
	if v_ticket.connector_id = 'mcp' and v_ticket.target_version = 1 and not exists (
		select 1 from public.qorpera_coding_mcp_sign_ins as sign_in
		where sign_in.capture_ticket_id = v_ticket.id and sign_in.secret_id = v_ticket.secret_id
			and sign_in.profile_id = v_ticket.profile_id and sign_in.environment_id = v_ticket.environment_id
			and public.qorpera_coding_mcp_secret_name(sign_in.origin) = v_ticket.secret_name
	) then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
$new$);

-- 3. The broker's reads ----------------------------------------------------------------------------------------------

-- 5j-1's environment read checks the session member without a lock, after the session and before it waits for the
-- secrets (rank 8), so a demotion or a removal (the member row FOR UPDATE at rank 1) could commit while it waits, and it
-- would serve a member who may no longer write (review r1 of #1159). It now takes that row at rank 1 too, as the relay
-- reads below do, and checks the role it took there (review r2): a member row that was not there at rank 1 (the member
-- had left, and joined again while this waited) is not the session's.
select pg_temp.coding_mcp_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$	v_secrets jsonb := '[]'::jsonb;
$old$,
	$new$	v_secrets jsonb := '[]'::jsonb;
	v_member_role public.qorpera_profile_members.role%type; -- 20260930440000 (5j-6a)
$new$);
select pg_temp.coding_mcp_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$	-- The company row first (rank 0): the audit rows' key needs it.
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id) for key share;
$old$,
	$new$	-- The company row first (rank 0): the audit rows' key needs it.
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id) for key share;
	-- 20260930440000 (5j-6a): the session member's row at rank 1, shared, named by the worker (whose owner never
	-- changes), and its role kept for the member check below. A demotion or a removal takes it FOR UPDATE at rank 1, so
	-- one that committed first is read here, and none commits while this serves.
	select member.role into v_member_role from public.qorpera_profile_members as member
	join public.qorpera_runtime_workers as worker
		on worker.profile_id = member.profile_id and worker.owner_user_id = member.user_id
	where worker.id = p_worker_id and worker.profile_id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id)
	for share of member;
$new$);
select pg_temp.coding_mcp_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$	if not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_session.profile_id and member.user_id = v_worker.owner_user_id
			and member.role in ('owner','admin','contributor')
	) then
		raise exception 'coding session member is unavailable' using errcode = '42501';
$old$,
	$new$	-- 20260930440000 (5j-6a): the member row taken at rank 1; none there means none for this session.
	if v_member_role is null or v_member_role not in ('owner','admin','contributor') then
		raise exception 'coding session member is unavailable' using errcode = '42501';
$new$);

-- The coding session a relay read serves, checked and taken as qorpera_authorize_coding_environment takes it: the
-- company row's key share first (rank 0), the session member's row and its role (rank 1), the broker's authority, the session on a
-- live lease of this executor in a phase that runs commands, the worker and its executor, the agent's grant for the
-- session's repository, and that the member row taken at rank 1 may still write. The callers check the broker's role
-- and the request's shape first.
create function public.qorpera_coding_relay_session(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_worker_id uuid,
	p_lease_token uuid,
	p_executor_owner text
)
returns public.qorpera_coding_sessions
language plpgsql set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_member_role public.qorpera_profile_members.role%type;
begin
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id) for key share;
	-- Rank 1: the session member's row, named by the worker (whose owner never changes), shared, and its role kept for the
	-- member check below. A demotion or a removal takes it FOR UPDATE at rank 1, so one that committed first is read here,
	-- and none commits while this serves. With no row here the session has no member, even if one joins while this waits.
	select member.role into v_member_role from public.qorpera_profile_members as member
	join public.qorpera_runtime_workers as worker
		on worker.profile_id = member.profile_id and worker.owner_user_id = member.user_id
	where worker.id = p_worker_id and worker.profile_id = (
		select authority.profile_id from public.qorpera_cloud_secret_broker_authorities as authority
		where authority.id = p_broker_authority_id)
	for share of member;
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
	if v_member_role is null or v_member_role not in ('owner','admin','contributor') then
		raise exception 'coding session member is unavailable' using errcode = '42501';
	end if;
	return v_session;
end
$$;

-- The sign-in for one MCP server a coding session reaches through the relay, for the secret broker only
-- (20260930440000): the company's for that origin, else the session member's own; only one this broker sealed. Both
-- candidates are taken in id order before one is chosen, so a Disconnect that commits while this waits is read; then
-- the version; one audit row. No sign-in for the origin answers signIn null and writes nothing. The value never
-- reaches this database.
create function public.qorpera_authorize_coding_mcp_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_worker_id uuid,
	p_lease_token uuid,
	p_executor_owner text,
	p_origin text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_secret_ids uuid[];
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_sign_in public.qorpera_coding_mcp_sign_ins%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_worker_id is null or p_lease_token is null
		or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or not public.qorpera_coding_mcp_origin_valid(p_origin) then
		raise exception 'coding MCP sign-in request is invalid' using errcode = '22023';
	end if;
	v_session := public.qorpera_coding_relay_session(p_broker_authority_id, p_broker_capability_sha256, p_worker_id,
		p_lease_token, p_executor_owner);
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority where authority.id = p_broker_authority_id;
	select worker.* into v_worker from public.qorpera_runtime_workers as worker where worker.id = v_session.worker_id;
	select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_secret_ids
	from (
		select secret.id
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
			and secret.connector_id = 'mcp' and secret.status = 'active'
			and secret.secret_name = public.qorpera_coding_mcp_secret_name(p_origin)
			and secret.broker_authority_id = v_authority.id
			and (secret.owner_kind = 'company'
				or (secret.owner_kind = 'member' and secret.owner_user_id = v_worker.owner_user_id))
			and exists (
				select 1 from public.qorpera_coding_mcp_sign_ins as sign_in
				where sign_in.secret_id = secret.id and sign_in.origin = p_origin
					and sign_in.profile_id = secret.profile_id and sign_in.environment_id = secret.environment_id
			)
		order by secret.id
		for share of secret
	) as locked;
	select secret.* into v_secret
	from public.qorpera_cloud_secrets as secret
	where secret.id = any(v_secret_ids)
	order by secret.owner_kind = 'company' desc, secret.id
	limit 1;
	if v_secret.id is null then
		return jsonb_build_object(
			'schema','qorpera.coding-mcp-sign-in-authorization/v1',
			'companyId',v_session.profile_id,'environmentId',v_session.environment_id,'workerId',v_worker.id,
			'origin',p_origin,'signIn',null
		);
	end if;
	select sign_in.* into v_sign_in
	from public.qorpera_coding_mcp_sign_ins as sign_in where sign_in.secret_id = v_secret.id;
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
		'mcp_sign_in_used',v_secret.connector_id,v_worker.id
	);
	return jsonb_build_object(
		'schema','qorpera.coding-mcp-sign-in-authorization/v1',
		'companyId',v_session.profile_id,'environmentId',v_session.environment_id,'workerId',v_worker.id,
		'origin',p_origin,
		'signIn',jsonb_build_object(
			'secretId',v_secret.id,'secretVersion',v_secret.current_version,'keyId',v_version.key_id,
			'ownerKind',v_secret.owner_kind,'kind',v_sign_in.kind,
			'headerName',v_sign_in.header_name,'headerPrefix',v_sign_in.header_prefix,
			'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),
			'envelopeSha256',v_version.envelope_sha256
		)
	);
end
$$;

-- The company's GitHub connection for a coding session's own repository while it runs, for the secret broker only
-- (20260930440000), so the broker fetches for it (upload-pack only, enforced where it connects): the session as the
-- relay reads take it, then the agent's live grants on the connection (rank 8), then the connection (the "primary"
-- company GitHub secret this broker sealed), only under a grant taken here and issued by a current owner or
-- administrator; then the version; one audit row. The token never reaches this database.
create function public.qorpera_authorize_coding_repository_fetch(
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
	v_grant_ids uuid[];
	v_secret_ids uuid[];
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_worker_id is null or p_lease_token is null
		or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
		raise exception 'coding repository fetch request is invalid' using errcode = '22023';
	end if;
	v_session := public.qorpera_coding_relay_session(p_broker_authority_id, p_broker_capability_sha256, p_worker_id,
		p_lease_token, p_executor_owner);
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority where authority.id = p_broker_authority_id;
	select worker.* into v_worker from public.qorpera_runtime_workers as worker where worker.id = v_session.worker_id;
	select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_grant_ids
	from (
		select grant_row.id
		from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.profile_id = v_session.profile_id and grant_row.environment_id = v_session.environment_id
			and grant_row.staff_agent_id = v_worker.staff_agent_id and grant_row.status = 'active'
			and exists (
				select 1 from public.qorpera_cloud_secrets as secret
				where secret.id = grant_row.secret_id and secret.owner_kind = 'company' and secret.connector_id = 'github'
					and secret.secret_name = 'primary' and secret.status = 'active'
			)
		order by grant_row.id
		for share
	) as locked;
	select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_secret_ids
	from (
		select secret.id
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
			and secret.owner_kind = 'company' and secret.connector_id = 'github' and secret.secret_name = 'primary'
			and secret.status = 'active' and secret.broker_authority_id = v_authority.id
			and exists (
				select 1 from public.qorpera_cloud_secret_operation_grants as grant_row
				where grant_row.id = any(v_grant_ids) and grant_row.secret_id = secret.id
					and grant_row.status = 'active'
					and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
					and exists (
						select 1 from public.qorpera_profile_members as issuer
						where issuer.profile_id = grant_row.profile_id and issuer.user_id = grant_row.issued_by_user_id
							and issuer.role in ('owner','admin')
					)
			)
		order by secret.id
		for share of secret
	) as locked;
	-- The active-name index allows one; the order keeps the pick deterministic regardless.
	select secret.* into v_secret
	from public.qorpera_cloud_secrets as secret
	where secret.id = any(v_secret_ids)
	order by secret.updated_at desc, secret.id
	limit 1;
	if v_secret.id is null then
		raise exception 'company GitHub connection is unavailable to this agent' using errcode = '42501';
	end if;
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
		'repository_fetch_used',v_secret.connector_id,v_worker.id
	);
	return jsonb_build_object(
		'schema','qorpera.coding-repository-fetch-authorization/v1',
		'companyId',v_secret.profile_id,'environmentId',v_secret.environment_id,
		'secretId',v_secret.id,'secretVersion',v_secret.current_version,'keyId',v_version.key_id,
		'connectorId',v_secret.connector_id,'credentialName','access_token',
		'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),
		'envelopeSha256',v_version.envelope_sha256,
		'workerId',v_worker.id,'repository',v_session.repository
	);
end
$$;

-- 4. Members ---------------------------------------------------------------------------------------------------------

-- Starts an MCP sign-in for the server at p_origin: the member's own (any member who may write) or the company's
-- (owners and administrators), as qorpera_begin_cloud_secret_capture decides, carried in p_header_name with
-- p_header_prefix before the value. Returns the capture (its ticket and capability for the broker's screen) and the
-- sign-in. An origin or header that is not available is refused (22023) before the capture starts.
create function public.qorpera_begin_coding_mcp_sign_in(
	p_profile_id uuid,
	p_environment_id uuid,
	p_owner_kind text,
	p_origin text,
	p_header_name text default 'authorization',
	p_header_prefix text default 'Bearer '
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_capture jsonb;
	v_sign_in public.qorpera_coding_mcp_sign_ins%rowtype;
begin
	if v_user_id is null then
		raise exception 'secret capture requires company write access' using errcode = '42501';
	end if;
	if not public.qorpera_coding_mcp_origin_valid(p_origin) then
		raise exception 'An MCP server is named by its origin, https://host[:port]' using errcode = '22023';
	end if;
	if not public.qorpera_coding_mcp_header_allowed(p_header_name) or p_header_prefix is null
		or p_header_prefix !~ '^([A-Za-z][A-Za-z0-9_-]{0,31} )?$' then
		raise exception 'That header is not available for an MCP sign-in' using errcode = '22023';
	end if;
	v_capture := public.qorpera_begin_cloud_secret_capture(p_profile_id, p_environment_id, p_owner_kind,
		case when p_owner_kind = 'member' then v_user_id end, 'mcp', public.qorpera_coding_mcp_secret_name(p_origin),
		'Sign-in for the MCP server at ' || p_origin, null);
	insert into public.qorpera_coding_mcp_sign_ins (
		secret_id, capture_ticket_id, profile_id, environment_id, origin, kind, header_name, header_prefix
	) values (
		(v_capture #>> '{scope,secretId}')::uuid, (v_capture ->> 'ticketId')::uuid, p_profile_id, p_environment_id,
		p_origin, 'api_key', p_header_name, p_header_prefix
	) returning * into v_sign_in;
	return v_capture || jsonb_build_object('signIn', jsonb_build_object(
		'schema','qorpera.coding-mcp-sign-in/v1','secretId',v_sign_in.secret_id,'origin',v_sign_in.origin,
		'kind',v_sign_in.kind,'headerName',v_sign_in.header_name,'headerPrefix',v_sign_in.header_prefix
	));
end
$$;

-- The company's MCP sign-ins and the caller's own in one environment, for anyone who can read the company: the
-- origin, the kind, the header and the owner. Never a value.
create function public.qorpera_list_coding_mcp_sign_ins(p_profile_id uuid, p_environment_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select case when not public.qorpera_can_read_profile(p_profile_id) then '[]'::jsonb else coalesce((
		select jsonb_agg(jsonb_build_object(
			'schema','qorpera.coding-mcp-sign-in/v1','secretId',secret.id,'secretName',secret.secret_name,
			'origin',sign_in.origin,'kind',sign_in.kind,'headerName',sign_in.header_name,
			'headerPrefix',sign_in.header_prefix,'ownerKind',secret.owner_kind,'version',secret.current_version,
			'createdAt',secret.created_at,'updatedAt',secret.updated_at
		) order by sign_in.origin, secret.owner_kind, secret.id)
		from public.qorpera_cloud_secrets as secret
		join public.qorpera_coding_mcp_sign_ins as sign_in on sign_in.secret_id = secret.id
			and sign_in.profile_id = secret.profile_id and sign_in.environment_id = secret.environment_id
		where secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
			and secret.connector_id = 'mcp' and secret.status = 'active'
			and (secret.owner_kind = 'company' or secret.owner_user_id = auth.uid())
	), '[]'::jsonb) end
$$;

-- 5. Privileges ------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_coding_mcp_origin_valid(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_coding_mcp_header_allowed(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_coding_mcp_secret_name(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_coding_relay_session(uuid,text,uuid,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_authorize_coding_mcp_sign_in(uuid,text,uuid,uuid,text,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_coding_mcp_sign_in(uuid,text,uuid,uuid,text,text)
	to qorpera_secret_broker;
revoke all on function public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)
	to qorpera_secret_broker;
revoke all on function public.qorpera_begin_coding_mcp_sign_in(uuid,uuid,text,text,text,text)
	from public, anon, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_list_coding_mcp_sign_ins(uuid,uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_coding_mcp_sign_in(uuid,uuid,text,text,text,text) to authenticated;
grant execute on function public.qorpera_list_coding_mcp_sign_ins(uuid,uuid) to authenticated;

drop function pg_temp.coding_mcp_patch(regprocedure, text, text);
