set local lock_timeout = '3s';

do $$ begin
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_coding_snapshots'
			and column_name = 'base_image_fingerprint'
	) then
		raise exception 'Coding snapshots 5h and standby (20260930854000) are already applied'; end if;
	if to_regclass('public.qorpera_coding_snapshots') is null
		or to_regclass('public.qorpera_coding_session_loads') is null then
		raise exception 'Coding snapshots 5h and standby (20260930854000) need 20260928549430 and 20260930837000 first';
	end if;
end $$;

create function pg_temp.s5h_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930854000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

alter table public.qorpera_coding_snapshots
	add column base_image_fingerprint text check (base_image_fingerprint ~ '^[0-9a-f]{64}$'),
	add column image_bytes bigint check (image_bytes >= 0),
	add column expires_at timestamptz;

create index qorpera_coding_snapshots_plan_lookup
	on public.qorpera_coding_snapshots (environment_id, member_user_id, repository, setup_digest, owner, machine_id_sha256)
	where state = 'ready' and removed_at is null;

create index qorpera_coding_snapshots_sweep
	on public.qorpera_coding_snapshots (owner, machine_id_sha256, state)
	where removed_at is null;

alter table public.qorpera_coding_machines
	add column snapshot_id uuid references public.qorpera_coding_snapshots(id) on delete set null;

create index qorpera_coding_machines_snapshot
	on public.qorpera_coding_machines (snapshot_id)
	where snapshot_id is not null and removed_at is null;

create function public.qorpera_coding_machine_policy_matches(
	p_machine public.qorpera_coding_machines,
	p_vm_policy jsonb
)
returns boolean language sql stable security definer set search_path = '' as $$
	select case
		when p_machine.snapshot_id is null then
			(p_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId']) = p_vm_policy
		else
			(p_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId','imageFingerprint'])
				= (p_vm_policy - 'imageFingerprint')
			and exists (
				select 1 from public.qorpera_coding_snapshots snapshot
				where snapshot.id = p_machine.snapshot_id
					and snapshot.image_fingerprint = (p_machine.binding ->> 'imageFingerprint')
					and snapshot.base_image_fingerprint = (p_vm_policy ->> 'imageFingerprint')
					and (
						p_machine.instance_sha256 is not null
						or (
							snapshot.state = 'ready'
							and snapshot.removed_at is null
							and (snapshot.expires_at is null or snapshot.expires_at > clock_timestamp())
						)
					)
			)
	end
$$;

revoke all on function public.qorpera_coding_machine_policy_matches(public.qorpera_coding_machines, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.s5h_patch('public.qorpera_begin_coding_snapshot_build(uuid,uuid,text,text,text,integer)'::regprocedure, array[
$old$	v_build public.qorpera_coding_snapshots%rowtype;$old$,
$new$	v_build public.qorpera_coding_snapshots%rowtype; v_base_image_fingerprint text;$new$,
$old$	perform 1 from public.qorpera_coding_executors where environment_id = v_worker.environment_id and owner = v_session.lease_owner
		and enabled and nas_machine_id_sha256 = p_machine_id_sha256 for share;$old$,
$new$	select vm_policy ->> 'imageFingerprint' into v_base_image_fingerprint
	from public.qorpera_coding_executors where environment_id = v_worker.environment_id and owner = v_session.lease_owner
		and enabled and nas_machine_id_sha256 = p_machine_id_sha256 for share;$new$,
$old$	if v_ready.setup_digest = p_setup_digest and v_ready.commit_sha = p_commit_sha then
		return public.qorpera_coding_snapshot_plan('current', v_ready); end if;$old$,
$new$	if v_ready.setup_digest = p_setup_digest and v_ready.commit_sha = p_commit_sha
		and (v_base_image_fingerprint is null or v_ready.base_image_fingerprint = v_base_image_fingerprint)
		and (v_ready.expires_at is null or v_ready.expires_at > clock_timestamp()) then
		return public.qorpera_coding_snapshot_plan('current', v_ready); end if;$new$,
$old$	select * into v_last from public.qorpera_coding_snapshots where environment_id = v_worker.environment_id
		and member_user_id = v_worker.owner_user_id and repository = v_repository and owner = v_session.lease_owner
		and machine_id_sha256 = p_machine_id_sha256 and setup_digest = p_setup_digest and commit_sha = p_commit_sha
	order by started_at desc, id desc limit 1;$old$,
$new$	select * into v_last from public.qorpera_coding_snapshots where environment_id = v_worker.environment_id
		and member_user_id = v_worker.owner_user_id and repository = v_repository and owner = v_session.lease_owner
		and machine_id_sha256 = p_machine_id_sha256 and setup_digest = p_setup_digest and commit_sha = p_commit_sha
		and base_image_fingerprint is not distinct from v_base_image_fingerprint
	order by started_at desc, id desc limit 1;$new$,
$old$	insert into public.qorpera_coding_snapshots (profile_id, environment_id, member_user_id, repository, setup_digest, commit_sha,
		owner, machine_id_sha256, lease_token, lease_until)
	values (v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_repository, p_setup_digest, p_commit_sha,
		v_session.lease_owner, p_machine_id_sha256, extensions.gen_random_uuid(), clock_timestamp() + make_interval(secs => p_lease_seconds))$old$,
$new$	insert into public.qorpera_coding_snapshots (profile_id, environment_id, member_user_id, repository, setup_digest, commit_sha,
		owner, machine_id_sha256, base_image_fingerprint, lease_token, lease_until)
	values (v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_repository, p_setup_digest, p_commit_sha,
		v_session.lease_owner, p_machine_id_sha256, v_base_image_fingerprint, extensions.gen_random_uuid(), clock_timestamp() + make_interval(secs => p_lease_seconds))$new$
]);

select pg_temp.s5h_patch('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, array[
$old$	v_session_attached boolean := false; v_rehomed boolean := false; v_volume_pinned_here boolean := false;$old$,
$new$	v_session_attached boolean := false; v_rehomed boolean := false; v_volume_pinned_here boolean := false;
	v_ready_snapshot public.qorpera_coding_snapshots%rowtype; v_effective_vm_policy jsonb;
	v_snapshot_build_needed boolean := false;$new$,
$old$	if v_executor.vm_policy is null or v_executor.nas_policy is null or v_executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding machine deployment policy unavailable' using errcode = '42501'; end if;$old$,
$new$	if v_executor.vm_policy is null or v_executor.nas_policy is null or v_executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding machine deployment policy unavailable' using errcode = '42501'; end if;
	-- WHY: 20260930854000 (step 5h): lock-free snapshot lookup avoids inverting coding-machine and coding-snapshot locks.
	select * into v_ready_snapshot
	from public.qorpera_coding_snapshots snapshot
	where snapshot.environment_id = v_worker.environment_id
		and snapshot.member_user_id = v_worker.owner_user_id
		and snapshot.repository = v_repository
		and snapshot.owner = v_session.lease_owner
		and snapshot.machine_id_sha256 = p_machine_id_sha256
		and snapshot.setup_digest = v_setup_digest
		and snapshot.base_image_fingerprint = (v_executor.vm_policy ->> 'imageFingerprint')
		and snapshot.state = 'ready'
		and snapshot.removed_at is null
		and (snapshot.expires_at is null or snapshot.expires_at > clock_timestamp())
	order by snapshot.finished_at desc nulls last, snapshot.id desc
	limit 1;
	v_effective_vm_policy := case
		when v_ready_snapshot.id is not null then
			v_executor.vm_policy || jsonb_build_object('imageFingerprint', v_ready_snapshot.image_fingerprint)
		else v_executor.vm_policy
	end;
	if v_setup_digest <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		and v_ready_snapshot.id is null
		and not exists (
			select 1 from public.qorpera_coding_snapshots building
			where building.environment_id = v_worker.environment_id
				and building.member_user_id = v_worker.owner_user_id
				and building.repository = v_repository
				and building.state = 'building'
				and building.lease_until > clock_timestamp()
		) then
		v_snapshot_build_needed := true;
	end if;$new$,
$old$			if v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
				if v_machine.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_machine.id returning * into v_machine;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_machine.id returning * into v_machine;
				end if;
			end if;$old$,
$new$			if not public.qorpera_coding_machine_policy_matches(v_machine, v_executor.vm_policy) then
				if v_machine.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_effective_vm_policy,
						snapshot_id = v_ready_snapshot.id where id = v_machine.id returning * into v_machine;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_machine.id returning * into v_machine;
				end if;
			end if;$new$,
$old$			if v_candidate.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
				if v_candidate.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_candidate.id returning * into v_candidate;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_candidate.id returning * into v_candidate;
				end if;
			end if;$old$,
$new$			if not public.qorpera_coding_machine_policy_matches(v_candidate, v_executor.vm_policy) then
				if v_candidate.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_effective_vm_policy,
						snapshot_id = v_ready_snapshot.id where id = v_candidate.id returning * into v_candidate;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_candidate.id returning * into v_candidate;
				end if;
			end if;$new$,
$old$				insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
					staff_agent_id, repository, setup_digest, number)
				values (v_machine.id, 'member', v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_session.lease_owner,
					p_machine_id_sha256, jsonb_build_object('schema','qorpera.lxd-coding-machine/v1','machineId',v_machine.id,
						'companyId',v_worker.profile_id,'environmentId',v_worker.environment_id,'memberUserId',v_worker.owner_user_id) || v_executor.vm_policy,
					v_worker.staff_agent_id, v_repository, v_setup_digest, v_number)$old$,
$new$				insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
					staff_agent_id, repository, setup_digest, number, snapshot_id)
				values (v_machine.id, 'member', v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_session.lease_owner,
					p_machine_id_sha256, jsonb_build_object('schema','qorpera.lxd-coding-machine/v1','machineId',v_machine.id,
						'companyId',v_worker.profile_id,'environmentId',v_worker.environment_id,'memberUserId',v_worker.owner_user_id) || v_effective_vm_policy,
					v_worker.staff_agent_id, v_repository, v_setup_digest, v_number, v_ready_snapshot.id)$new$,
$old$	v_result := jsonb_build_object('schema','qorpera.coding-machine-plan/v1','state','planned','machineId',v_machine.id,'binding',v_machine.binding);$old$,
$new$	v_result := jsonb_build_object(
		'schema','qorpera.coding-machine-plan/v1',
		'state','planned',
		'machineId',v_machine.id,
		'binding',v_machine.binding,
		'snapshotBuildNeeded',v_snapshot_build_needed
	);
	if v_machine.snapshot_id is not null then
		v_result := v_result || jsonb_build_object(
			'snapshotId', v_machine.snapshot_id,
			'snapshotImageFingerprint', v_machine.binding ->> 'imageFingerprint'
		);
	end if;$new$
]);

create function public.qorpera_claim_coding_snapshot_build(
	p_worker_id uuid,
	p_lease_token uuid,
	p_machine_id_sha256 text,
	p_setup_digest text,
	p_commit_sha text,
	p_lease_seconds integer default 120,
	p_ttl_seconds integer default 604800
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_executor public.qorpera_coding_executors%rowtype;
	v_repository text;
	v_base_image_fingerprint text;
	v_ready public.qorpera_coding_snapshots%rowtype;
	v_last public.qorpera_coding_snapshots%rowtype;
	v_build public.qorpera_coding_snapshots%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_setup_digest, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_commit_sha, '') !~ '^[0-9a-f]{40}$'
		or p_lease_seconds is null or p_lease_seconds not between 30 and 300
		or (p_ttl_seconds is not null and p_ttl_seconds not between 300 and 7776000) then
		raise exception 'Coding snapshot input invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_profiles as profile where profile.id = (
		select worker.profile_id from public.qorpera_runtime_workers as worker where worker.id = p_worker_id
	) for key share;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	select * into v_executor from public.qorpera_coding_executors
	where environment_id = v_worker.environment_id and owner = v_session.lease_owner
		and enabled and nas_machine_id_sha256 = p_machine_id_sha256 for share;
	if v_executor.owner is null or v_executor.vm_policy is null then
		raise exception 'Coding snapshot node unavailable' using errcode = '42501'; end if;
	v_base_image_fingerprint := v_executor.vm_policy ->> 'imageFingerprint';
	if coalesce(v_base_image_fingerprint, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding snapshot node unavailable' using errcode = '42501'; end if;
	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));
	if coalesce(v_repository, '') !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$' then
		raise exception 'Coding snapshot repository unsupported' using errcode = '22023'; end if;
	perform public.qorpera_coding_snapshot_lock(v_worker.environment_id, v_worker.owner_user_id, v_repository);

	update public.qorpera_coding_snapshots
	set state = 'abandoned', failure = 'LEASE_EXPIRED', lease_until = null, finished_at = clock_timestamp()
	where environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id and repository = v_repository
		and state = 'building' and lease_until <= clock_timestamp();

	select * into v_ready from public.qorpera_coding_snapshots
	where environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id
		and repository = v_repository and owner = v_session.lease_owner
		and machine_id_sha256 = p_machine_id_sha256 and state = 'ready';
	if v_ready.setup_digest = p_setup_digest and v_ready.commit_sha = p_commit_sha
		and v_ready.base_image_fingerprint = v_base_image_fingerprint
		and (v_ready.expires_at is null or v_ready.expires_at > clock_timestamp()) then
		return jsonb_build_object(
			'schema', 'qorpera.coding-snapshot-claim/v1',
			'state', 'current',
			'baseImageFingerprint', v_base_image_fingerprint,
			'snapshot', public.qorpera_coding_snapshot_view(v_ready),
			'build', null,
			'waitingUntil', null,
			'failure', null
		);
	end if;

	select * into v_build from public.qorpera_coding_snapshots
	where environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id
		and repository = v_repository and state = 'building';
	if v_build.id is not null then
		return jsonb_build_object(
			'schema', 'qorpera.coding-snapshot-claim/v1',
			'state', 'waiting',
			'baseImageFingerprint', v_base_image_fingerprint,
			'snapshot', public.qorpera_coding_snapshot_view(v_ready),
			'build', null,
			'waitingUntil', v_build.lease_until,
			'failure', null
		);
	end if;

	select * into v_last from public.qorpera_coding_snapshots
	where environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id
		and repository = v_repository and owner = v_session.lease_owner
		and machine_id_sha256 = p_machine_id_sha256 and setup_digest = p_setup_digest
		and commit_sha = p_commit_sha and base_image_fingerprint = v_base_image_fingerprint
	order by started_at desc, id desc limit 1;
	if v_last.state = 'failed' then
		return jsonb_build_object(
			'schema', 'qorpera.coding-snapshot-claim/v1',
			'state', 'failed',
			'baseImageFingerprint', v_base_image_fingerprint,
			'snapshot', public.qorpera_coding_snapshot_view(v_ready),
			'build', null,
			'waitingUntil', null,
			'failure', jsonb_build_object('buildId', v_last.id, 'code', v_last.failure, 'log', v_last.log, 'finishedAt', v_last.finished_at)
		);
	end if;

	insert into public.qorpera_coding_snapshots (
		profile_id, environment_id, member_user_id, repository, setup_digest, commit_sha,
		owner, machine_id_sha256, base_image_fingerprint, lease_token, lease_until
	)
	values (
		v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_repository, p_setup_digest, p_commit_sha,
		v_session.lease_owner, p_machine_id_sha256, v_base_image_fingerprint, extensions.gen_random_uuid(),
		clock_timestamp() + make_interval(secs => p_lease_seconds)
	)
	returning * into v_build;

	return jsonb_build_object(
		'schema', 'qorpera.coding-snapshot-claim/v1',
		'state', 'claimed',
		'baseImageFingerprint', v_base_image_fingerprint,
		'snapshot', public.qorpera_coding_snapshot_view(v_ready),
		'build', jsonb_build_object(
			'buildId', v_build.id,
			'leaseToken', v_build.lease_token,
			'leaseUntil', v_build.lease_until,
			'profileId', v_build.profile_id,
			'environmentId', v_build.environment_id,
			'memberUserId', v_build.member_user_id,
			'repository', v_build.repository,
			'setupDigest', v_build.setup_digest,
			'commitSha', v_build.commit_sha,
			'baseImageFingerprint', v_build.base_image_fingerprint,
			'ttlSeconds', p_ttl_seconds
		),
		'waitingUntil', null,
		'failure', null
	);
end
$$;

create function public.qorpera_complete_coding_snapshot_build(
	p_build_id uuid,
	p_lease_token uuid,
	p_image_fingerprint text,
	p_image_bytes bigint,
	p_log text default null,
	p_ttl_seconds integer default 604800
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_coding_snapshots%rowtype;
	v_expires_at timestamptz;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if p_build_id is null or p_lease_token is null
		or coalesce(p_image_fingerprint, '') !~ '^[0-9a-f]{64}$'
		or p_image_bytes is null or p_image_bytes < 0 or p_image_bytes > 1099511627776
		or octet_length(to_jsonb(p_log)::text) > 65538
		or (p_ttl_seconds is not null and p_ttl_seconds not between 300 and 7776000) then
		raise exception 'Coding snapshot input invalid' using errcode = '22023'; end if;

	select * into v_row from public.qorpera_coding_snapshots where id = p_build_id;
	if v_row.id is null or v_row.lease_token is distinct from p_lease_token then
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;
	perform public.qorpera_coding_snapshot_lock(v_row.environment_id, v_row.member_user_id, v_row.repository);
	select * into strict v_row from public.qorpera_coding_snapshots where id = p_build_id for update;

	if v_row.state <> 'building' then
		if v_row.state in ('ready', 'retired')
			and v_row.image_fingerprint is not distinct from p_image_fingerprint
			and v_row.image_bytes is not distinct from p_image_bytes then
			return jsonb_build_object(
				'schema', 'qorpera.coding-snapshot-build/v1',
				'buildId', v_row.id,
				'state', v_row.state,
				'imageFingerprint', v_row.image_fingerprint,
				'imageBytes', v_row.image_bytes,
				'expiresAt', v_row.expires_at
			);
		end if;
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501';
	end if;
	if v_row.lease_until <= clock_timestamp() then
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;

	if exists (
		select 1 from public.qorpera_coding_snapshots
		where owner = v_row.owner and machine_id_sha256 = v_row.machine_id_sha256
			and image_fingerprint = p_image_fingerprint and removed_at is null
	) then
		raise exception 'Coding snapshot image is already recorded' using errcode = '55000'; end if;

	update public.qorpera_coding_snapshots
	set state = 'retired', retired_at = clock_timestamp()
	where environment_id = v_row.environment_id and member_user_id = v_row.member_user_id
		and repository = v_row.repository and owner = v_row.owner
		and machine_id_sha256 = v_row.machine_id_sha256 and state = 'ready';

	v_expires_at := case when p_ttl_seconds is not null then clock_timestamp() + make_interval(secs => p_ttl_seconds) end;
	update public.qorpera_coding_snapshots
	set state = 'ready',
		image_fingerprint = p_image_fingerprint,
		image_bytes = p_image_bytes,
		log = p_log,
		lease_until = null,
		finished_at = clock_timestamp(),
		expires_at = v_expires_at
	where id = v_row.id
	returning * into v_row;

	return jsonb_build_object(
		'schema', 'qorpera.coding-snapshot-build/v1',
		'buildId', v_row.id,
		'state', v_row.state,
		'imageFingerprint', v_row.image_fingerprint,
		'imageBytes', v_row.image_bytes,
		'expiresAt', v_row.expires_at
	);
end
$$;

create function public.qorpera_fail_coding_snapshot_build(
	p_build_id uuid,
	p_lease_token uuid,
	p_failure text,
	p_log text default null,
	p_abandoned boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_coding_snapshots%rowtype;
	v_target text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if p_build_id is null or p_lease_token is null
		or coalesce(p_failure, '') !~ '^[A-Z][A-Z0-9_:]{0,119}$'
		or octet_length(to_jsonb(p_log)::text) > 65538 then
		raise exception 'Coding snapshot input invalid' using errcode = '22023'; end if;
	v_target := case when coalesce(p_abandoned, false) then 'abandoned' else 'failed' end;

	select * into v_row from public.qorpera_coding_snapshots where id = p_build_id;
	if v_row.id is null or v_row.lease_token is distinct from p_lease_token then
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;
	perform public.qorpera_coding_snapshot_lock(v_row.environment_id, v_row.member_user_id, v_row.repository);
	select * into strict v_row from public.qorpera_coding_snapshots where id = p_build_id for update;

	if v_row.state <> 'building' then
		if v_row.state = v_target and v_row.failure is not distinct from p_failure then
			return jsonb_build_object(
				'schema', 'qorpera.coding-snapshot-build/v1',
				'buildId', v_row.id,
				'state', v_row.state,
				'failure', v_row.failure
			);
		end if;
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501';
	end if;
	if v_row.lease_until <= clock_timestamp() then
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;

	update public.qorpera_coding_snapshots
	set state = v_target,
		failure = p_failure,
		log = p_log,
		lease_until = null,
		finished_at = clock_timestamp()
	where id = v_row.id
	returning * into v_row;

	return jsonb_build_object(
		'schema', 'qorpera.coding-snapshot-build/v1',
		'buildId', v_row.id,
		'state', v_row.state,
		'failure', v_row.failure
	);
end
$$;

create function public.qorpera_sweep_coding_snapshots(
	p_owner text,
	p_machine_id_sha256 text,
	p_current_base_image_fingerprint text default null
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_row public.qorpera_coding_snapshots%rowtype;
	v_abandoned integer := 0;
	v_retired integer := 0;
	v_count integer := 0;
begin
	if auth.role() is distinct from 'service_role'
		or coalesce(p_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$'
		or (p_current_base_image_fingerprint is not null and p_current_base_image_fingerprint !~ '^[0-9a-f]{64}$') then
		raise exception 'Coding snapshot custody required' using errcode = '42501'; end if;

	for v_row in
		select * from public.qorpera_coding_snapshots snapshot
		where snapshot.owner = p_owner
			and snapshot.machine_id_sha256 = p_machine_id_sha256
			and (
				(snapshot.state = 'building' and snapshot.lease_until <= clock_timestamp())
				or (
					snapshot.state = 'ready'
					and (
						(snapshot.expires_at is not null and snapshot.expires_at <= clock_timestamp())
						or (
							p_current_base_image_fingerprint is not null
							and snapshot.base_image_fingerprint is not null
							and snapshot.base_image_fingerprint <> p_current_base_image_fingerprint
						)
						or not exists (
							select 1 from public.qorpera_profile_members member
							where member.profile_id = snapshot.profile_id
								and member.user_id = snapshot.member_user_id
						)
					)
				)
			)
		order by snapshot.environment_id, snapshot.member_user_id, snapshot.repository, snapshot.id
	loop
		perform public.qorpera_coding_snapshot_lock(v_row.environment_id, v_row.member_user_id, v_row.repository);
		if v_row.state = 'building' then
			update public.qorpera_coding_snapshots snapshot
			set state = 'abandoned', failure = 'LEASE_EXPIRED', lease_until = null, finished_at = clock_timestamp()
			where snapshot.id = v_row.id and snapshot.state = 'building' and snapshot.lease_until <= clock_timestamp();
			get diagnostics v_count = row_count;
			v_abandoned := v_abandoned + v_count;
		else
			update public.qorpera_coding_snapshots snapshot
			set state = 'retired', retired_at = clock_timestamp()
			where snapshot.id = v_row.id
				and snapshot.state = 'ready'
				and (
					(snapshot.expires_at is not null and snapshot.expires_at <= clock_timestamp())
					or (
						p_current_base_image_fingerprint is not null
						and snapshot.base_image_fingerprint is not null
						and snapshot.base_image_fingerprint <> p_current_base_image_fingerprint
					)
					or not exists (
						select 1 from public.qorpera_profile_members member
						where member.profile_id = snapshot.profile_id
							and member.user_id = snapshot.member_user_id
					)
				);
			get diagnostics v_count = row_count;
			v_retired := v_retired + v_count;
		end if;
	end loop;

	return jsonb_build_object(
		'schema', 'qorpera.coding-snapshot-sweep/v1',
		'abandonedBuilds', v_abandoned,
		'retiredSnapshots', v_retired,
		'pruneImages', coalesce((
			select jsonb_agg(
				jsonb_build_object(
					'snapshotId', snapshot.id,
					'imageFingerprint', snapshot.image_fingerprint,
					'imageBytes', snapshot.image_bytes
				)
				order by snapshot.retired_at nulls last, snapshot.id
			)
			from public.qorpera_coding_snapshots snapshot
			where snapshot.owner = p_owner
				and snapshot.machine_id_sha256 = p_machine_id_sha256
				and snapshot.state = 'retired'
				and snapshot.removed_at is null
				and snapshot.image_fingerprint is not null
				and not exists (
					select 1 from public.qorpera_coding_machines machine
					where machine.snapshot_id = snapshot.id and machine.removed_at is null
				)
		), '[]'::jsonb),
		'keepImageFingerprints', coalesce((
			select jsonb_agg(distinct snapshot.image_fingerprint order by snapshot.image_fingerprint)
			from public.qorpera_coding_snapshots snapshot
			where snapshot.owner = p_owner
				and snapshot.machine_id_sha256 = p_machine_id_sha256
				and snapshot.removed_at is null
				and snapshot.image_fingerprint is not null
				and (
					snapshot.state = 'ready'
					or (
						snapshot.state = 'retired'
						and exists (
							select 1 from public.qorpera_coding_machines machine
							where machine.snapshot_id = snapshot.id and machine.removed_at is null
						)
					)
				)
		), '[]'::jsonb)
	);
end
$$;

create function public.qorpera_fallback_coding_machine_base_image(
	p_worker_id uuid,
	p_lease_token uuid,
	p_machine_id uuid,
	p_machine_id_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_executor public.qorpera_coding_executors%rowtype;
	v_machine public.qorpera_coding_machines%rowtype;
	v_snapshot public.qorpera_coding_snapshots%rowtype;
	v_binding text;
	v_instance_sha256 text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if p_worker_id is null or p_lease_token is null or p_machine_id is null
		or coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine input invalid' using errcode = '22023'; end if;

	perform public.qorpera_folder_machine_fence(worker.profile_id)
	from public.qorpera_runtime_workers worker where worker.id = p_worker_id;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	select * into v_executor from public.qorpera_coding_executors
	where environment_id = v_worker.environment_id and owner = v_session.lease_owner and enabled for share;
	if v_executor.vm_policy is null or v_executor.nas_policy is null
		or v_executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding machine deployment policy unavailable' using errcode = '42501'; end if;

	perform pg_advisory_xact_lock(hashtextextended('qorpera.coding-machine:' || v_worker.environment_id::text || ':' || v_worker.owner_user_id::text, 0));
	select * into v_machine from public.qorpera_coding_machines where id = p_machine_id for update;
	if v_machine.id is null
		or v_machine.profile_id <> v_worker.profile_id
		or v_machine.environment_id <> v_worker.environment_id
		or v_machine.member_user_id <> v_worker.owner_user_id
		or v_machine.owner <> v_session.lease_owner
		or v_machine.machine_id_sha256 <> p_machine_id_sha256
		or v_machine.removed_at is not null
		or v_machine.retire_requested_at is not null
		or v_machine.removing_at is not null then
		raise exception 'Coding machine fallback unavailable' using errcode = '42501'; end if;

	if v_machine.snapshot_id is null then
		if (v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId']) = v_executor.vm_policy then
			v_binding := public.qorpera_coding_machine_binding_text(v_machine.binding);
			return jsonb_build_object(
				'schema', 'qorpera.coding-machine-plan/v1',
				'state', 'planned',
				'machineId', v_machine.id,
				'binding', v_machine.binding,
				'bindingText', v_binding,
				'snapshotBuildNeeded', v_machine.setup_digest <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
			);
		end if;
		raise exception 'Coding machine fallback unavailable' using errcode = '42501';
	end if;

	if (v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId','imageFingerprint'])
		<> (v_executor.vm_policy - 'imageFingerprint') then
		raise exception 'Coding machine fallback unavailable' using errcode = '42501'; end if;

	if exists (
		select 1 from public.qorpera_coding_sessions attached
		where attached.attached_machine_id = v_machine.id and attached.attached_at is not null
	) then
		raise exception 'Coding machine fallback unavailable' using errcode = '42501'; end if;

	select * into v_snapshot from public.qorpera_coding_snapshots where id = v_machine.snapshot_id;
	if v_snapshot.id is not null then
		perform public.qorpera_coding_snapshot_lock(v_snapshot.environment_id, v_snapshot.member_user_id, v_snapshot.repository);
		update public.qorpera_coding_snapshots
		set state = 'retired', retired_at = coalesce(retired_at, clock_timestamp())
		where id = v_snapshot.id and state = 'ready';
	end if;

	v_machine.binding := v_machine.binding || jsonb_build_object('imageFingerprint', v_executor.vm_policy ->> 'imageFingerprint');
	v_binding := public.qorpera_coding_machine_binding_text(v_machine.binding);
	v_instance_sha256 := encode(extensions.digest(convert_to(v_binding, 'utf8'), 'sha256'), 'hex');

	update public.qorpera_coding_machines
	set binding = v_machine.binding,
		snapshot_id = null,
		instance_sha256 = v_instance_sha256
	where id = v_machine.id
	returning * into v_machine;

	update public.qorpera_runtime_machine_allocations
	set instance_sha256 = v_instance_sha256
	where id = v_machine.id and released_at is null;

	return jsonb_build_object(
		'schema', 'qorpera.coding-machine-plan/v1',
		'state', 'planned',
		'machineId', v_machine.id,
		'binding', v_machine.binding,
		'bindingText', v_binding,
		'snapshotBuildNeeded', v_machine.setup_digest <> 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
	);
end
$$;

revoke all on function public.qorpera_claim_coding_snapshot_build(uuid, uuid, text, text, text, integer, integer),
	public.qorpera_complete_coding_snapshot_build(uuid, uuid, text, bigint, text, integer),
	public.qorpera_fail_coding_snapshot_build(uuid, uuid, text, text, boolean),
	public.qorpera_sweep_coding_snapshots(text, text, text),
	public.qorpera_fallback_coding_machine_base_image(uuid, uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_claim_coding_snapshot_build(uuid, uuid, text, text, text, integer, integer),
	public.qorpera_complete_coding_snapshot_build(uuid, uuid, text, bigint, text, integer),
	public.qorpera_fail_coding_snapshot_build(uuid, uuid, text, text, boolean),
	public.qorpera_sweep_coding_snapshots(text, text, text),
	public.qorpera_fallback_coding_machine_base_image(uuid, uuid, uuid, text)
	to service_role;

comment on function public.qorpera_coding_machine_policy_matches(public.qorpera_coding_machines, jsonb) is
	'20260930854000 (step 5h): internal helper verifying a coding machine binding matches either base vm_policy or a valid snapshot derived from base vm_policy.';
comment on function public.qorpera_plan_coding_machine(uuid, uuid, text, text) is
	'20260930828000 (step 5k) / 20260930837000 / 20260930854000 (step 5h): plans sessions with active-only capacity accounting, cross-node overflow, detached re-homing, ready snapshot selection, and background snapshot build triggering.';
comment on function public.qorpera_claim_coding_snapshot_build(uuid, uuid, text, text, text, integer, integer) is
	'20260930854000 (step 5h): claims a leased snapshot build for a session setup_digest, commit_sha, and base image fingerprint.';
comment on function public.qorpera_complete_coding_snapshot_build(uuid, uuid, text, bigint, text, integer) is
	'20260930854000 (step 5h): completes a claimed snapshot build with published LXD image fingerprint, image size bytes, and expiry.';
comment on function public.qorpera_fail_coding_snapshot_build(uuid, uuid, text, text, boolean) is
	'20260930854000 (step 5h): marks a claimed snapshot build failed or abandoned while preserving any prior ready snapshot.';
comment on function public.qorpera_sweep_coding_snapshots(text, text, text) is
	'20260930854000 (step 5h): abandons stale builds, retires expired or mismatched-base-image snapshots, and returns unreferenced retired LXD images for pruning.';
comment on function public.qorpera_fallback_coding_machine_base_image(uuid, uuid, uuid, text) is
	'20260930854000 (step 5h): atomically rebinds an unstarted snapshot-planned machine to base vm_policy and retires the missing snapshot when absent from local LXD.';

select pg_temp.s5h_patch('public.qorpera_enroll_runtime_node_inventory(jsonb)'::regprocedure, array[
$a$'infrastructure','buildSpace','codeHosts']<>'{}'::jsonb$a$,
$b$'infrastructure','buildSpace','codeHosts','codingAuxiliary']<>'{}'::jsonb$b$,

$a$<>6+(p_policy ? 'buildSpace')::integer+(p_policy ? 'codeHosts')::integer$a$,
$b$<>6+(p_policy ? 'buildSpace')::integer+(p_policy ? 'codeHosts')::integer+(p_policy ? 'codingAuxiliary')::integer$b$,

$a$
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-inventory-policy/v1' then$a$,
$b$
  -- WHY: 20260930854000 (step 5h): register coding snapshot builders and stopped standby VMs in node inventory headroom.
  or (p_policy ? 'codingAuxiliary' and (jsonb_typeof(p_policy->'codingAuxiliary') is distinct from 'object'
   or (p_policy->'codingAuxiliary')-array['project','storagePool','cpus','memoryBytes','rootDiskBytes','maxBuilders','maxStandby']<>'{}'::jsonb
   or (select count(*) from jsonb_object_keys(p_policy->'codingAuxiliary'))<>7
   or jsonb_typeof(p_policy->'codingAuxiliary'->'project') is distinct from 'string'
   or coalesce(p_policy->'codingAuxiliary'->>'project','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
   or coalesce(p_policy->'codingAuxiliary'->>'project','') ~ '^qorpera-codehost-[0-9a-f]{32}$'
   or jsonb_typeof(p_policy->'codingAuxiliary'->'storagePool') is distinct from 'string'
   or coalesce(p_policy->'codingAuxiliary'->>'storagePool','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
   or exists(select 1 from (values ('cpus',1::numeric,64::numeric,1::numeric),
     ('memoryBytes',1073741824,1099511627776,1073741824),('rootDiskBytes',10737418240,2199023255552,1073741824),
     ('maxBuilders',0,4,1),('maxStandby',0,8,1)) b(k,low,high,unit)
    where jsonb_typeof(p_policy->'codingAuxiliary'->b.k) is distinct from 'number'
     or case when coalesce(p_policy->'codingAuxiliary'->>b.k,'') ~ '^(0|[1-9][0-9]{0,15})$'
      then (p_policy->'codingAuxiliary'->>b.k)::numeric not between b.low and b.high or mod((p_policy->'codingAuxiliary'->>b.k)::numeric,b.unit)<>0
      else true end)
   or (p_policy->'codingAuxiliary'->>'maxBuilders')::integer+(p_policy->'codingAuxiliary'->>'maxStandby')::integer<1))
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-inventory-policy/v1' then$b$,

$a$ v_memory:=v_memory+coalesce((p_policy->'codeHosts'->>'running')::numeric*(p_policy->'codeHosts'->>'memoryBytes')::numeric,0);$a$,
$b$ v_memory:=v_memory+coalesce((p_policy->'codeHosts'->>'running')::numeric*(p_policy->'codeHosts'->>'memoryBytes')::numeric,0);
 v_cpu:=v_cpu+coalesce((p_policy->'codingAuxiliary'->>'maxBuilders')::numeric*(p_policy->'codingAuxiliary'->>'cpus')::numeric*1000,0);
 v_memory:=v_memory+coalesce((p_policy->'codingAuxiliary'->>'maxBuilders')::numeric*(p_policy->'codingAuxiliary'->>'memoryBytes')::numeric,0);$b$,

$a$ or coalesce(p_policy->'buildSpace'->>'project','') ~ '^qorpera-codehost-[0-9a-f]{32}$' then$a$,
$b$ or coalesce(p_policy->'buildSpace'->>'project','') ~ '^qorpera-codehost-[0-9a-f]{32}$'
  or (p_policy ? 'buildSpace' and p_policy ? 'codingAuxiliary'
   and p_policy->'buildSpace'->>'project'=p_policy->'codingAuxiliary'->>'project') then$b$
]);

select pg_temp.s5h_patch('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)'::regprocedure, array[
$a$ v_build_cpu numeric:=0; v_build_memory numeric:=0; v_code_hosts integer:=0;$a$,
$b$ v_build_cpu numeric:=0; v_build_memory numeric:=0; v_code_hosts integer:=0; v_snap_builders integer:=0; v_standbys integer:=0;$b$,

$a$   +coalesce((v_policy->'codeHosts'->>'running')::numeric*(v_policy->'codeHosts'->>'cpus')::numeric*1000,0)>(v_context->>'headroomCpuMillis')::numeric$a$,
$b$   +coalesce((v_policy->'codeHosts'->>'running')::numeric*(v_policy->'codeHosts'->>'cpus')::numeric*1000,0)
   +coalesce((v_policy->'codingAuxiliary'->>'maxBuilders')::numeric*(v_policy->'codingAuxiliary'->>'cpus')::numeric*1000,0)>(v_context->>'headroomCpuMillis')::numeric$b$,

$a$   +coalesce((v_policy->'codeHosts'->>'running')::numeric*(v_policy->'codeHosts'->>'memoryBytes')::numeric,0)>(v_context->>'headroomMemoryBytes')::numeric$a$,
$b$   +coalesce((v_policy->'codeHosts'->>'running')::numeric*(v_policy->'codeHosts'->>'memoryBytes')::numeric,0)
   +coalesce((v_policy->'codingAuxiliary'->>'maxBuilders')::numeric*(v_policy->'codingAuxiliary'->>'memoryBytes')::numeric,0)>(v_context->>'headroomMemoryBytes')::numeric$b$,

$a$'infrastructure','build','code-host','unmanaged')$a$,
$b$'infrastructure','build','code-host','coding-snapshot-builder','coding-standby','unmanaged')$b$,

$a$'BUILD_SPACE_EXCEEDED','INSTANCE_IMAGE_NOT_RELEASED','CODE_HOST_SPACE_EXCEEDED'))$a$,
$b$'BUILD_SPACE_EXCEEDED','INSTANCE_IMAGE_NOT_RELEASED','CODE_HOST_SPACE_EXCEEDED','CODING_SNAPSHOT_BUILDER_SPACE_EXCEEDED','CODING_STANDBY_SPACE_EXCEEDED'))$b$,

$a$   raise exception 'Node inventory mixes the code hosts with other instances' using errcode='42501'; end if;$a$,
$b$   raise exception 'Node inventory mixes the code hosts with other instances' using errcode='42501'; end if;
  if (v_item->>'category'='coding-snapshot-builder' and (not v_policy ? 'codingAuxiliary'
    or v_item->>'project' is distinct from v_policy->'codingAuxiliary'->>'project'
    or v_item->>'name' !~ '^qorpera-coding-snap-[0-9a-f]{24}$'))
   or (v_item->>'category'='coding-standby' and (not v_policy ? 'codingAuxiliary'
    or v_item->>'project' is distinct from v_policy->'codingAuxiliary'->>'project'
    or v_item->>'name' !~ '^qorpera-coding-standby-[0-9a-f]{24}$')) then
   raise exception 'Node inventory mixes coding auxiliary instances with other projects' using errcode='42501'; end if;$b$,

$a$   if v_item->>'state'<>'suspended' then v_code_hosts:=v_code_hosts+1; end if;$a$,
$b$   if v_item->>'state'<>'suspended' then v_code_hosts:=v_code_hosts+1; end if;
  elsif v_item->>'category'='coding-snapshot-builder' then
   if v_item->'allocation'<>'null'::jsonb then raise exception 'A snapshot builder cannot claim an allocation' using errcode='42501'; end if;
   if v_item->>'type' is distinct from 'virtual-machine'
    or v_item->>'cpuMillis' is null or (v_item->>'cpuMillis')::numeric>(v_policy->'codingAuxiliary'->>'cpus')::numeric*1000
    or v_item->>'memoryBytes' is null or (v_item->>'memoryBytes')::numeric>(v_policy->'codingAuxiliary'->>'memoryBytes')::numeric then v_ready:=false; end if;
   v_snap_builders:=v_snap_builders+1;
  elsif v_item->>'category'='coding-standby' then
   if v_item->'allocation'<>'null'::jsonb then raise exception 'A coding standby VM cannot claim an allocation' using errcode='42501'; end if;
   if v_item->>'type' is distinct from 'virtual-machine'
    or v_item->>'state' is distinct from 'suspended'
    or v_item->'cpuMillis' is distinct from to_jsonb((v_policy->'codingAuxiliary'->>'cpus')::numeric*1000)
    or v_item->'memoryBytes' is distinct from v_policy->'codingAuxiliary'->'memoryBytes' then v_ready:=false; end if;
   v_standbys:=v_standbys+1;$b$,

$a$ if v_code_hosts>coalesce((v_policy->'codeHosts'->>'running')::integer,0) then v_ready:=false; end if;$a$,
$b$ if v_code_hosts>coalesce((v_policy->'codeHosts'->>'running')::integer,0) then v_ready:=false; end if;
 if v_snap_builders>coalesce((v_policy->'codingAuxiliary'->>'maxBuilders')::integer,0) then v_ready:=false; end if;
 if v_standbys>coalesce((v_policy->'codingAuxiliary'->>'maxStandby')::integer,0) then v_ready:=false; end if;$b$
]);

drop function pg_temp.s5h_patch(regprocedure, text[]);
