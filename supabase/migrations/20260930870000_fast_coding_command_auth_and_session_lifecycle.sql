set local lock_timeout = '3s';

alter table public.qorpera_coding_sessions
	add column if not exists worktree_created_at timestamptz;

create or replace function public.qorpera_coding_session_claim_json(
	p_session public.qorpera_coding_sessions,
	p_worker public.qorpera_runtime_workers
)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-session-claim/v1','workerId',p_worker.id,'sequence',p_worker.sequence,
		'leaseToken',p_session.lease_token,'leaseUntil',p_session.lease_until,'profileId',p_worker.profile_id,'environmentId',p_worker.environment_id,
		'agentId',p_worker.staff_agent_id,'ownerUserId',p_worker.owner_user_id,
		'sponsor',jsonb_build_object('bindingId',p_worker.owner_sponsor_binding_id,'version',p_worker.owner_sponsor_version),
		'harness',p_session.harness,'model',p_session.model,'repository',p_session.repository,'branch',p_session.branch,'baseSha',p_session.base_sha,
		'worktreeCreatedAt',p_session.worktree_created_at,
		'harnessSessionRef',p_session.harness_session_ref,'pullRequest',p_session.pull_request,'title',p_worker.title,
		'dispatch',p_worker.dispatch,'followUp',p_worker.dispatch ->> 'followUp','todoId',p_worker.todo_id)
		|| case when p_session.surface_session_id is null then '{}'::jsonb else coalesce((
			select jsonb_build_object('surfaceSession', jsonb_build_object(
				'sessionId', ss.id,
				'surfaceId', surf.id,
				'slug', surf.slug,
				'title', coalesce(nullif(btrim(public.qorpera_surface_utf8_left(surf.title, 320)), ''), surf.slug)
			))
			from public.qorpera_surface_sessions ss
			join public.qorpera_surfaces surf on surf.id = ss.surface_id
			where ss.id = p_session.surface_session_id
		), '{}'::jsonb) end
$$;

create function public.qorpera_record_coding_worktree_created(p_worker_id uuid, p_lease_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_session public.qorpera_coding_sessions%rowtype;
	v_created_at timestamptz;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	update public.qorpera_coding_sessions
	set worktree_created_at = coalesce(worktree_created_at, clock_timestamp()),
		updated_at = clock_timestamp()
	where worker_id = v_session.worker_id
	returning worktree_created_at into v_created_at;
	return jsonb_build_object(
		'schema', 'qorpera.coding-worktree-created/v1',
		'workerId', v_session.worker_id,
		'worktreeCreatedAt', v_created_at
	);
end
$$;

create function public.qorpera_coding_environment_version(
	p_profile_id uuid,
	p_environment_id uuid,
	p_owner_user_id uuid,
	p_repository text,
	p_machine_id uuid default null
)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
	v_member_role text;
	v_authorities text;
	v_company_secrets text;
	v_member_secrets text;
	v_mask_history text := '';
	v_current_secret_ids uuid[] := '{}'::uuid[];
begin
	select member.role::text into v_member_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = p_owner_user_id;

	select coalesce(string_agg(authority.id::text || ':' || authority.key_id, ',' order by authority.id), '')
	into v_authorities
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.profile_id = p_profile_id and authority.status = 'active';

	select
		coalesce(
			string_agg(
				environment_grant.id::text || ':' || secret.id::text || ':' || secret.secret_name || ':'
					|| secret.current_version::text || ':' || secret.broker_authority_id::text || ':'
					|| coalesce(version.envelope_sha256, '') || ':' || coalesce(issuer.role::text, ''),
				',' order by environment_grant.id, secret.id
			),
			''
		),
		coalesce(array_agg(distinct secret.id), '{}'::uuid[])
	into v_company_secrets, v_current_secret_ids
	from public.qorpera_coding_environment_grants as environment_grant
	join public.qorpera_cloud_secrets as secret on secret.id = environment_grant.secret_id
	join public.qorpera_profile_members as issuer
		on issuer.profile_id = environment_grant.profile_id
		and issuer.user_id = environment_grant.issued_by_user_id
		and issuer.role in ('owner', 'admin')
	left join public.qorpera_cloud_secret_versions as version
		on version.secret_id = secret.id and version.version = secret.current_version
	where environment_grant.profile_id = p_profile_id
		and environment_grant.environment_id = p_environment_id
		and environment_grant.repository = p_repository
		and environment_grant.status = 'active'
		and environment_grant.scope in ('all', 'build', 'test')
		and environment_grant.target_env in ('all', 'dev', 'test')
		and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id
		and secret.connector_id = 'environment'
		and secret.owner_kind = 'company'
		and secret.status = 'active'
		and public.qorpera_coding_environment_name_allowed(secret.secret_name);

	select
		coalesce(
			string_agg(
				secret.id::text || ':' || secret.secret_name || ':' || secret.current_version::text || ':'
					|| secret.broker_authority_id::text || ':' || coalesce(version.envelope_sha256, ''),
				',' order by secret.id
			),
			''
		),
		v_current_secret_ids || coalesce(array_agg(distinct secret.id), '{}'::uuid[])
	into v_member_secrets, v_current_secret_ids
	from public.qorpera_cloud_secrets as secret
	left join public.qorpera_cloud_secret_versions as version
		on version.secret_id = secret.id and version.version = secret.current_version
	where secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id
		and secret.connector_id = 'environment'
		and secret.owner_kind = 'member'
		and secret.owner_user_id = p_owner_user_id
		and secret.status = 'active'
		and public.qorpera_coding_environment_name_allowed(secret.secret_name);

	if p_machine_id is not null then
		select coalesce(
			string_agg(distinct (secret.id::text || ':' || audit.secret_version::text), ',' order by (secret.id::text || ':' || audit.secret_version::text)),
			''
		)
		into v_mask_history
		from public.qorpera_cloud_secret_audit_events as audit
		join public.qorpera_runtime_workers as used_by on used_by.id = audit.coding_worker_id
		join public.qorpera_cloud_secrets as secret on secret.id = audit.secret_id
		where audit.coding_machine_id = p_machine_id
			and audit.event_type = 'environment_secret_used'
			and audit.profile_id = p_profile_id
			and audit.environment_id = p_environment_id
			and used_by.profile_id = p_profile_id
			and used_by.owner_user_id = p_owner_user_id
			and secret.profile_id = p_profile_id
			and secret.environment_id = p_environment_id
			and secret.connector_id = 'environment'
			and secret.status = 'active'
			and (secret.owner_kind = 'company' or secret.owner_user_id = p_owner_user_id)
			and public.qorpera_coding_environment_name_allowed(secret.secret_name)
			and not (secret.id = any(v_current_secret_ids) and audit.secret_version = secret.current_version);
	end if;

	return encode(
		extensions.digest(
			convert_to(
				'v1|' || coalesce(v_member_role, '') || '|' || v_authorities || '|'
					|| v_company_secrets || '|' || v_member_secrets || '|' || v_mask_history,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);
end
$$;

create function public.qorpera_authorize_coding_command_v2(
	p_binding jsonb,
	p_holder text,
	p_scope jsonb,
	p_action text,
	p_command_id uuid,
	p_input_sha256 text,
	p_lease_token uuid default null,
	p_binding_text text default null,
	p_storage jsonb default null,
	p_machine_id_sha256 text default null
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_binding jsonb;
	v_worker_id uuid;
	v_vm_id uuid;
	v_machine public.qorpera_coding_machines%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_route jsonb;
	v_run_authority jsonb := null;
	v_disk_epoch uuid;
	v_vault_env_version text;
	v_local_count integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding command authority required' using errcode = '42501';
	end if;
	if p_holder is not null then
		if public.qorpera_native_binding_proven(p_binding, p_holder) is distinct from true then
			raise exception 'native binding proof is refused' using errcode = '42501';
		end if;
	end if;
	v_local_count := num_nonnulls(p_lease_token, p_binding_text, p_storage, p_machine_id_sha256);
	if v_local_count not in (0, 4) then
		raise exception 'Coding command input invalid' using errcode = '22023';
	end if;

	v_binding := public.qorpera_authorize_coding_command(p_binding, p_scope, p_action, p_command_id, p_input_sha256);
	v_worker_id := (p_scope ->> 'workerId')::uuid;
	v_vm_id := (p_scope ->> 'vmId')::uuid;

	select * into v_machine from public.qorpera_coding_machines where id = v_vm_id;
	if v_machine.id is null or v_machine.removing_at is not null or v_machine.removed_at is not null
		or not exists (
			select 1 from public.qorpera_coding_executors as executor
			where executor.environment_id = v_machine.environment_id
				and executor.owner = v_machine.owner
				and executor.nas_machine_id_sha256 = v_machine.machine_id_sha256
		)
		or not exists (
			select 1 from public.qorpera_runtime_machine_allocations as allocation
			join public.qorpera_runtime_node_demands as demand on demand.allocation_id = allocation.id
			join public.qorpera_runtime_nodes as node on node.id = demand.node_id
			where allocation.id = v_machine.id
				and allocation.released_at is null
				and allocation.instance_sha256 = v_machine.instance_sha256
				and demand.reserved_at is not null
				and demand.released_at is null
				and demand.suspended_at is null
				and node.machine_id_sha256 = v_machine.machine_id_sha256
		) then
		raise exception 'Coding command placement unavailable' using errcode = '42501';
	end if;

	v_route := jsonb_build_object(
		'schema', 'qorpera.coding-command-route/v1',
		'executorOwner', v_machine.owner,
		'providerId', v_machine.binding ->> 'providerId',
		'machineId', v_machine.id
	);

	if v_local_count = 4 then
		v_run_authority := public.qorpera_authorize_coding_machine_run(
			v_worker_id,
			p_lease_token,
			p_binding_text,
			p_storage,
			p_machine_id_sha256
		);
		-- WHY: Re-read machine after run authority take-in so rebuildDue reflects any newly set new_disk_at mark.
		select * into v_machine from public.qorpera_coding_machines where id = v_vm_id;
	end if;

	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;

	select restart.operation_id into v_disk_epoch
	from public.qorpera_coding_machine_folder_restarts as restart
	where restart.machine_id = v_machine.id and restart.state = 'replaced'
	order by restart.recorded_at desc, restart.operation_id desc
	limit 1;

	v_vault_env_version := public.qorpera_coding_environment_version(
		v_session.profile_id,
		v_session.environment_id,
		v_worker.owner_user_id,
		lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name')),
		v_session.attached_machine_id
	);

	return jsonb_build_object(
		'schema', 'qorpera.coding-command-authority/v2',
		'binding', v_binding,
		'route', v_route,
		'runAuthority', v_run_authority,
		'rebuildDue', (v_machine.new_disk_at is not null),
		'diskEpoch', v_disk_epoch,
		'vaultEnvVersion', v_vault_env_version
	);
end
$$;

revoke all on function public.qorpera_record_coding_worktree_created(uuid, uuid),
	public.qorpera_coding_environment_version(uuid, uuid, uuid, text, uuid),
	public.qorpera_authorize_coding_command_v2(jsonb, text, jsonb, text, uuid, text, uuid, text, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_record_coding_worktree_created(uuid, uuid),
	public.qorpera_authorize_coding_command_v2(jsonb, text, jsonb, text, uuid, text, uuid, text, jsonb, text)
	to service_role;
