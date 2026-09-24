-- Bundle v88: the cloud coding executor reaches repositories through the
-- company's GitHub connection, and company connections are always shared.
--
-- Founder, 2026-09-23/24: members never hand-place tokens (static executor
-- token files are proof-only plumbing; the product path is GitHub connector ->
-- executor), connections belong to the company, and a company connection is
-- shared with every agent with no toggle.
--
--   1. Always shared. Capture completion shares a company-owned connection
--      with every active agent in the same transaction that seals it (v87 left
--      that to the web page, which called qorpera_grant_cloud_connector after
--      connecting). Stop sharing (qorpera_unshare_cloud_connector) is dropped.
--      qorpera_grant_cloud_connector stays as the idempotent repair: it issues
--      only missing or dead grants. Existing company connections are shared
--      once here.
--   2. The repository credential. The executor never holds a GitHub token at
--      rest. For one leased coding session it asks the company's secret broker,
--      which asks this kernel, which answers with the sealed envelope of the
--      company's GitHub connection only when the session, its lease, its
--      executor, its repository, the agent's repository grant, the connection
--      and the agent's grant on it all hold. Every answer is audited. The broker
--      unwraps the token and returns it to the executor's Git broker only; it
--      never enters the repository VM, a model turn or this database.
--   3. Health receipt retention. A node observer now publishes every few
--      seconds; each observation prunes that node's receipts older than seven
--      days, a bounded number per call, never the one its latest row names.
--   4. Runtime bundle manifest capacity. The v87 manifest used 131 036 of its
--      131 072 bytes; the v88 activation (after this migration) needs more.

create function pg_temp.coding_connector_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding repository connector integration differs: %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Company connections are always shared
-- ---------------------------------------------------------------------------

-- Marks one active company-owned connection shared and issues every missing or
-- dead grant of it to every active agent. Idempotent: live grants stay. The
-- issuer is the preferred member when an owner or admin, else the member who
-- connected it when still one, else a current owner (or admin); a company grant
-- holds only while its issuer is an owner or admin (the kernel rechecks at every
-- call). Returns the number of grants issued.
create function public.qorpera_share_company_connection(p_secret_id uuid, p_preferred_issuer uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_issuer uuid;
	v_agents uuid[];
begin
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id for update;
	if v_secret.id is null or v_secret.status <> 'active' or v_secret.owner_kind <> 'company' then
		return 0;
	end if;
	update public.qorpera_cloud_secrets set available_to_all_agents = true, updated_at = statement_timestamp()
	where id = v_secret.id and not available_to_all_agents;
	select member.user_id into v_issuer
	from public.qorpera_profile_members as member
	where member.profile_id = v_secret.profile_id and member.role in ('owner','admin')
	order by member.user_id = p_preferred_issuer desc nulls last,
		member.user_id = v_secret.created_by_user_id desc,
		member.role = 'owner' desc, member.user_id
	limit 1;
	if v_issuer is null then
		return 0;
	end if;
	select coalesce(array_agg(staff.staff_agent_id order by staff.staff_agent_id), '{}'::uuid[]) into v_agents
	from public.qorpera_profile_staff as staff
	where staff.profile_id = v_secret.profile_id and staff.employment_status = 'active';
	return public.qorpera_grant_cloud_connector_operations(
		v_secret.profile_id, v_secret.environment_id, v_secret.id, v_issuer, v_agents
	);
end
$$;

-- Capture completion (the seven-argument body of 20260924040000; the
-- six-argument Step 2 signature delegates to it) shares a company-owned
-- connection as it seals it, first capture and rotation alike, under the
-- owner or admin who captured it. A member's own secret is never shared.
select pg_temp.coding_connector_patch(
	'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)',
	$old$		v_ticket.created_by_user_id,v_ticket.connector_id
	);
$old$,
	$new$		v_ticket.created_by_user_id,v_ticket.connector_id
	);
	-- Always shared (bundle v88): a company connection is every agent's from
	-- the moment it is sealed.
	if v_ticket.owner_kind = 'company' then
		perform public.qorpera_share_company_connection(v_ticket.secret_id, v_ticket.created_by_user_id);
	end if;
$new$);

-- No toggle: Stop sharing is gone. A single grant can still be revoked
-- (qorpera_revoke_cloud_secret_grant), and disconnecting revokes the
-- connection with all its grants (qorpera_revoke_cloud_secret).
drop function public.qorpera_unshare_cloud_connector(uuid,uuid,uuid);

-- Existing company connections are shared once, including any that were
-- stopped under v87. Idempotent for connections that are already shared.
do $$
declare v_secret uuid;
begin
	for v_secret in
		select secret.id from public.qorpera_cloud_secrets as secret
		where secret.owner_kind = 'company' and secret.status = 'active'
		order by secret.id
	loop
		perform public.qorpera_share_company_connection(v_secret, null);
	end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The coding executor's repository credential
-- ---------------------------------------------------------------------------

alter table public.qorpera_cloud_secret_audit_events
	add column coding_worker_id uuid,
	drop constraint qorpera_cloud_secret_audit_events_event_type_check,
	add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (
		'capture_started','captured','rotated','grant_issued','grant_revoked','secret_revoked','effect_authorized',
		'repository_credential_used'
	)),
	add constraint qorpera_cloud_secret_audit_events_coding_worker check (
		(event_type = 'repository_credential_used') = (coding_worker_id is not null)
	);

comment on column public.qorpera_cloud_secret_audit_events.coding_worker_id is
	'The coding session (worker) a repository credential was released for; set only on repository_credential_used.';

-- Called by the company's secret broker (the dedicated qorpera_secret_broker
-- login, its authority id and capability digest, as for every broker RPC). The
-- executor names the session it holds (worker, lease token), its own owner and
-- the repository; nothing here trusts the caller for more than naming. Refused
-- unless all of these hold:
--   - the broker authority is active, holds this capability and belongs to the
--     session's company;
--   - the session is leased to this executor owner with this lease token, the
--     lease is live and the session is preparing (seed) or publishing (push,
--     draft PR), the phases in which the executor touches the repository;
--   - the worker is an active coding worker and this owner is the company's
--     enabled coding executor;
--   - the repository is the session's, and the session's agent is active and
--     holds an enabled repository grant for it;
--   - the company has an active company-owned GitHub connection sealed by this
--     broker, on which the agent holds a live grant (active, unexpired, issued
--     by a current owner or admin). A member's own GitHub secret never serves.
-- Returns the current envelope and what the broker needs to open it, and
-- writes one audit event. The token itself never reaches this database.
create function public.qorpera_authorize_coding_repository_credential(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_worker_id uuid,
	p_lease_token uuid,
	p_executor_owner text,
	p_repository jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_worker_id is null or p_lease_token is null
		or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or not public.qorpera_coding_repository_valid(p_repository) then
		raise exception 'coding repository credential request is invalid' using errcode = '22023';
	end if;
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
	if v_session.phase not in ('preparing','publishing')
		or v_session.lease_owner is distinct from p_executor_owner
		or v_session.lease_token is distinct from p_lease_token
		or v_session.lease_until <= clock_timestamp() then
		raise exception 'coding session lease is unavailable' using errcode = '42501';
	end if;
	if v_session.repository is distinct from p_repository then
		raise exception 'coding repository differs from the session' using errcode = '42501';
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
	-- One company GitHub connection per company in practice (the web page names
	-- it "primary"); with several, the most recently connected or rotated one
	-- the agent may use serves.
	select secret.* into v_secret
	from public.qorpera_cloud_secrets as secret
	where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
		and secret.owner_kind = 'company' and secret.connector_id = 'github' and secret.status = 'active'
		and secret.broker_authority_id = v_authority.id
		and exists (
			select 1 from public.qorpera_cloud_secret_operation_grants as grant_row
			where grant_row.secret_id = secret.id and grant_row.profile_id = secret.profile_id
				and grant_row.environment_id = secret.environment_id
				and grant_row.staff_agent_id = v_worker.staff_agent_id and grant_row.status = 'active'
				and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
				and exists (
					select 1 from public.qorpera_profile_members as issuer
					where issuer.profile_id = grant_row.profile_id and issuer.user_id = grant_row.issued_by_user_id
						and issuer.role in ('owner','admin')
				)
		)
	order by secret.updated_at desc, secret.id
	limit 1
	for share of secret;
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
		'repository_credential_used',v_secret.connector_id,v_worker.id
	);
	return jsonb_build_object(
		'schema','qorpera.coding-repository-credential-authorization/v1',
		'companyId',v_secret.profile_id,'environmentId',v_secret.environment_id,
		'secretId',v_secret.id,'secretVersion',v_secret.current_version,'keyId',v_version.key_id,
		'connectorId',v_secret.connector_id,'credentialName','access_token',
		'encryptedEnvelopeBase64',encode(v_version.encrypted_envelope,'base64'),
		'envelopeSha256',v_version.envelope_sha256,
		'workerId',v_worker.id,'repository',v_session.repository
	);
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Health receipt retention
-- ---------------------------------------------------------------------------

-- qorpera_observe_runtime_node_health as of 20260913000500 (body of
-- 20260909000700 with the policy bridge). At about one receipt every five
-- seconds a node writes some 17 000 rows a day; nothing pruned them. Each call
-- now deletes at most 500 of that node's receipts observed more than seven days
-- ago (the history index leads with node_id, observed_at), after the receipt
-- and the latest row are written, and never the receipt the latest row names.
-- Other nodes' receipts are untouched.
select pg_temp.coding_connector_patch(
	'public.qorpera_observe_runtime_node_health(jsonb)',
	$old$ return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_old.observed_at);$old$,
	$new$ -- Bounded retention (bundle v88): seven days, at most 500 rows per call.
 delete from public.qorpera_runtime_node_health_receipts where node_id=v_id and observation_id in (
  select h.observation_id from public.qorpera_runtime_node_health_receipts h
  where h.node_id=v_id and h.observed_at<clock_timestamp()-interval '7 days'
   and not exists(select 1 from public.qorpera_runtime_node_health_latest l
    where l.node_id=h.node_id and l.observation_id=h.observation_id)
  order by h.observed_at,h.observation_id limit 500);
 return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_old.observed_at);$new$);

-- ---------------------------------------------------------------------------
-- 4. Runtime bundle manifest capacity
-- ---------------------------------------------------------------------------

-- As 20260908000850 did for v15: the full source closure has outgrown the
-- 128 KiB manifest (v87: 131 036 bytes of 131 072, one path and digest per
-- migration and source file). Apply before the v88 activation; keep all source
-- hashes and the immutable-bundle/checksum constraints. Logical bytes, not
-- TOAST size.
alter table public.qorpera_runtime_bundles drop constraint qorpera_runtime_bundles_manifest_check;
alter table public.qorpera_runtime_bundles add constraint qorpera_runtime_bundles_manifest_check
	check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 262144);

-- ---------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.qorpera_share_company_connection(uuid,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)
	to qorpera_secret_broker;
