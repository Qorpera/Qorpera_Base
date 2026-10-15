-- Coding snapshots, 5h-2 (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Setup file and snapshots"): the records.
--
-- 1. A snapshot is a member's repository set up on one node: the setup file's digest (5h-1) and the default branch's
--    commit it was built from, and the image its build left there. Snapshots are kept per node and never copied (Q7): a
--    node without one builds its own. At most one ready snapshot per member, repository and node; a newer one retires it.
-- 2. qorpera_begin_coding_snapshot_build, at a session's attach, under the session's lease and on the executor's node:
--    current (this node's snapshot has this digest and commit), waiting (a build of this member's repository runs, on any
--    node: at most one at a time), failed (this node's last build of this digest and commit failed; only a new commit or
--    setup tries again, an abandoned build is tried again at once) or started (a build lease for the caller). Every answer
--    names this node's snapshot, which a new machine starts from meanwhile: a failure never takes it away.
-- 3. The build's lease is renewed and finished with its own token. The log is the build's output already masked by 5j, at
--    most 64 KiB as a JSON string (its quotes aside), the form the coding control carries it in both ways; a failed
--    build's comes back with every failed answer, for the member and the agent.
-- 4. The node's list: each snapshot whose image may be on the node, and whether it is due for removal: retired, by a newer
--    snapshot or by the list itself when the member left the company (so a member who comes back builds again). The
--    executor removes the image, then records it. An image the list does not name is not kept: a build whose lease lapsed
--    cannot finish.
-- Every body carries the marker 20260930435000 for the deploy guard.

set local lock_timeout = '3s';

-- 1. The records --------------------------------------------------------------------------------------------------------

create table public.qorpera_coding_snapshots (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	member_user_id uuid not null references auth.users(id) on delete restrict,
	repository text not null check (repository ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'),
	setup_digest text not null check (setup_digest ~ '^[0-9a-f]{64}$'),
	commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
	owner text not null check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	machine_id_sha256 text not null check (machine_id_sha256 ~ '^[0-9a-f]{64}$'),
	state text not null default 'building' check (state in ('building','ready','failed','abandoned','retired')),
	lease_token uuid not null,
	lease_until timestamptz,
	image_fingerprint text check (image_fingerprint ~ '^[0-9a-f]{64}$'),
	failure text check (failure ~ '^[A-Z][A-Z0-9_:]{0,119}$'),
	-- 64 KiB as a JSON string, its two quotes aside.
	log text check (octet_length(to_jsonb(log)::text) <= 65538),
	started_at timestamptz not null default clock_timestamp(),
	finished_at timestamptz,
	retired_at timestamptz,
	removed_at timestamptz,
	constraint qorpera_coding_snapshots_lease check ((state = 'building') = (lease_until is not null)
		and (state = 'building') = (finished_at is null) and (state <> 'building' or log is null)),
	constraint qorpera_coding_snapshots_image check ((state in ('ready','retired')) = (image_fingerprint is not null)),
	constraint qorpera_coding_snapshots_failure check ((state in ('failed','abandoned')) = (failure is not null)),
	constraint qorpera_coding_snapshots_retired check ((state = 'retired') = (retired_at is not null)),
	constraint qorpera_coding_snapshots_removed check (removed_at is null or state = 'retired')
);
comment on table public.qorpera_coding_snapshots is
	'5h-2 (20260930435000): a member''s repository set up on one node (owner, machine_id_sha256), and each build of one. Scratch: nothing in an image is company data.';

-- At most one build at a time per member and repository, on any node.
create unique index qorpera_coding_snapshots_one_build on public.qorpera_coding_snapshots (environment_id, member_user_id, repository)
	where state = 'building';
-- At most one ready snapshot per member, repository and node.
create unique index qorpera_coding_snapshots_one_ready on public.qorpera_coding_snapshots (environment_id, member_user_id, repository,
	owner, machine_id_sha256) where state = 'ready';
-- An image on a node belongs to one snapshot until it is removed.
create unique index qorpera_coding_snapshots_image_once on public.qorpera_coding_snapshots (owner, machine_id_sha256, image_fingerprint)
	where image_fingerprint is not null and removed_at is null;
create index qorpera_coding_snapshots_key on public.qorpera_coding_snapshots (environment_id, member_user_id, repository, started_at);
create index qorpera_coding_snapshots_node on public.qorpera_coding_snapshots (owner, machine_id_sha256) where removed_at is null;
create index qorpera_coding_snapshots_profile on public.qorpera_coding_snapshots (profile_id);
create index qorpera_coding_snapshots_member on public.qorpera_coding_snapshots (member_user_id);

alter table public.qorpera_coding_snapshots enable row level security;
revoke all on public.qorpera_coding_snapshots from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Views of a row (internal) ------------------------------------------------------------------------------------------

create function public.qorpera_coding_snapshot_view(p_snapshot public.qorpera_coding_snapshots)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 5h-2 (20260930435000): the snapshot a new machine starts from.
	select case when p_snapshot.id is null then null else jsonb_build_object('snapshotId',p_snapshot.id,
		'setupDigest',p_snapshot.setup_digest,'commitSha',p_snapshot.commit_sha,'imageFingerprint',p_snapshot.image_fingerprint,
		'builtAt',p_snapshot.finished_at) end
$$;

create function public.qorpera_coding_snapshot_plan(p_state text, p_snapshot public.qorpera_coding_snapshots,
	p_build jsonb default null, p_waiting_until timestamptz default null, p_failure jsonb default null)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 5h-2 (20260930435000): every answer at attach has the same keys.
	select jsonb_build_object('schema','qorpera.coding-snapshot-plan/v1','state',p_state,
		'snapshot',public.qorpera_coding_snapshot_view(p_snapshot),'build',p_build,'waitingUntil',p_waiting_until,'failure',p_failure)
$$;

create function public.qorpera_coding_snapshot_lock(p_environment_id uuid, p_member_user_id uuid, p_repository text)
returns void language sql volatile security definer set search_path = '' as $$
	-- 5h-2 (20260930435000): one member's repository, on every node; after the session's lease, before any snapshot row.
	select pg_advisory_xact_lock(hashtextextended('qorpera.coding-snapshot:' || p_environment_id::text || ':'
		|| p_member_user_id::text || ':' || p_repository, 0))
$$;

-- 3. The plan at attach -------------------------------------------------------------------------------------------------

create function public.qorpera_begin_coding_snapshot_build(p_worker_id uuid, p_lease_token uuid, p_machine_id_sha256 text,
	p_setup_digest text, p_commit_sha text, p_lease_seconds integer default 120)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_repository text; v_ready public.qorpera_coding_snapshots%rowtype; v_last public.qorpera_coding_snapshots%rowtype;
	v_build public.qorpera_coding_snapshots%rowtype;
begin
	-- 5h-2 (20260930435000)
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' or coalesce(p_setup_digest, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_commit_sha, '') !~ '^[0-9a-f]{40}$' or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
		raise exception 'Coding snapshot input invalid' using errcode = '22023'; end if;
	-- The company's profile row first, as every coding machine call (20260925123000): a machine plan or an agent tool call
	-- holds it (the fence) while it locks this session, and the snapshot's insert below checks its key. A key share is the
	-- most this takes of it.
	perform 1 from public.qorpera_profiles as profile where profile.id = (select worker.profile_id
		from public.qorpera_runtime_workers as worker where worker.id = p_worker_id) for key share;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	perform 1 from public.qorpera_coding_executors where environment_id = v_worker.environment_id and owner = v_session.lease_owner
		and enabled and nas_machine_id_sha256 = p_machine_id_sha256 for share;
	if not found then raise exception 'Coding snapshot node unavailable' using errcode = '42501'; end if;
	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));
	if coalesce(v_repository, '') !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$' then
		raise exception 'Coding snapshot repository unsupported' using errcode = '22023'; end if;
	perform public.qorpera_coding_snapshot_lock(v_worker.environment_id, v_worker.owner_user_id, v_repository);

	-- A build whose lease lapsed, on any node, is given up; it cannot finish.
	update public.qorpera_coding_snapshots set state = 'abandoned', failure = 'LEASE_EXPIRED', lease_until = null,
		finished_at = clock_timestamp()
	where environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id and repository = v_repository
		and state = 'building' and lease_until <= clock_timestamp();

	select * into v_ready from public.qorpera_coding_snapshots where environment_id = v_worker.environment_id
		and member_user_id = v_worker.owner_user_id and repository = v_repository and owner = v_session.lease_owner
		and machine_id_sha256 = p_machine_id_sha256 and state = 'ready';
	if v_ready.setup_digest = p_setup_digest and v_ready.commit_sha = p_commit_sha then
		return public.qorpera_coding_snapshot_plan('current', v_ready); end if;

	select * into v_build from public.qorpera_coding_snapshots where environment_id = v_worker.environment_id
		and member_user_id = v_worker.owner_user_id and repository = v_repository and state = 'building';
	if v_build.id is not null then
		return public.qorpera_coding_snapshot_plan('waiting', v_ready, p_waiting_until => v_build.lease_until); end if;

	select * into v_last from public.qorpera_coding_snapshots where environment_id = v_worker.environment_id
		and member_user_id = v_worker.owner_user_id and repository = v_repository and owner = v_session.lease_owner
		and machine_id_sha256 = p_machine_id_sha256 and setup_digest = p_setup_digest and commit_sha = p_commit_sha
	order by started_at desc, id desc limit 1;
	if v_last.state = 'failed' then
		return public.qorpera_coding_snapshot_plan('failed', v_ready, p_failure => jsonb_build_object('buildId',v_last.id,
			'code',v_last.failure,'log',v_last.log,'finishedAt',v_last.finished_at)); end if;

	insert into public.qorpera_coding_snapshots (profile_id, environment_id, member_user_id, repository, setup_digest, commit_sha,
		owner, machine_id_sha256, lease_token, lease_until)
	values (v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_repository, p_setup_digest, p_commit_sha,
		v_session.lease_owner, p_machine_id_sha256, extensions.gen_random_uuid(), clock_timestamp() + make_interval(secs => p_lease_seconds))
	returning * into v_build;
	return public.qorpera_coding_snapshot_plan('started', v_ready, p_build => jsonb_build_object('buildId',v_build.id,
		'leaseToken',v_build.lease_token,'leaseUntil',v_build.lease_until));
end
$$;
comment on function public.qorpera_begin_coding_snapshot_build(uuid, uuid, text, text, text, integer) is
	'5h-2 (20260930435000): at attach, the session''s snapshot on this node and whether to build one. Locks the company''s profile row (key share), the leased session, the executor (share), the member''s repository (advisory), then its snapshot rows.';

-- 4. The build's lease --------------------------------------------------------------------------------------------------

create function public.qorpera_renew_coding_snapshot_build(p_build_id uuid, p_lease_token uuid, p_lease_seconds integer default 120)
returns timestamptz language plpgsql volatile security definer set search_path = '' as $$
declare v_until timestamptz;
begin
	-- 5h-2 (20260930435000)
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if p_build_id is null or p_lease_token is null or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
		raise exception 'Coding snapshot input invalid' using errcode = '22023'; end if;
	update public.qorpera_coding_snapshots set lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
	where id = p_build_id and lease_token = p_lease_token and state = 'building' and lease_until > clock_timestamp()
	returning lease_until into v_until;
	if v_until is null then raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;
	return v_until;
end
$$;

-- A finish sent again gets the same answer; any other finish of a finished build, or of one whose lease lapsed, is refused.
create function public.qorpera_finish_coding_snapshot_build(p_build_id uuid, p_lease_token uuid, p_outcome text,
	p_image_fingerprint text default null, p_failure text default null, p_log text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.qorpera_coding_snapshots%rowtype;
begin
	-- 5h-2 (20260930435000)
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if p_build_id is null or p_lease_token is null or p_outcome is null or p_outcome not in ('ready','failed','abandoned')
		or (p_outcome = 'ready') <> (p_image_fingerprint is not null) or (p_outcome = 'ready') = (p_failure is not null)
		or p_image_fingerprint !~ '^[0-9a-f]{64}$' or p_failure !~ '^[A-Z][A-Z0-9_:]{0,119}$'
		or octet_length(to_jsonb(p_log)::text) > 65538 then
		raise exception 'Coding snapshot input invalid' using errcode = '22023'; end if;
	select * into v_row from public.qorpera_coding_snapshots where id = p_build_id;
	if v_row.id is null or v_row.lease_token is distinct from p_lease_token then
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;
	perform public.qorpera_coding_snapshot_lock(v_row.environment_id, v_row.member_user_id, v_row.repository);
	select * into strict v_row from public.qorpera_coding_snapshots where id = p_build_id for update;

	if v_row.state <> 'building' then
		if (v_row.state = p_outcome or (p_outcome = 'ready' and v_row.state = 'retired'))
			and v_row.image_fingerprint is not distinct from p_image_fingerprint and v_row.failure is not distinct from p_failure then
			return jsonb_build_object('schema','qorpera.coding-snapshot-build/v1','buildId',v_row.id,'state',v_row.state); end if;
		raise exception 'Coding snapshot build lease unavailable' using errcode = '42501';
	end if;
	if v_row.lease_until <= clock_timestamp() then raise exception 'Coding snapshot build lease unavailable' using errcode = '42501'; end if;

	if p_outcome = 'ready' then
		if exists (select 1 from public.qorpera_coding_snapshots where owner = v_row.owner and machine_id_sha256 = v_row.machine_id_sha256
			and image_fingerprint = p_image_fingerprint and removed_at is null) then
			raise exception 'Coding snapshot image is already recorded' using errcode = '55000'; end if;
		update public.qorpera_coding_snapshots set state = 'retired', retired_at = clock_timestamp()
		where environment_id = v_row.environment_id and member_user_id = v_row.member_user_id and repository = v_row.repository
			and owner = v_row.owner and machine_id_sha256 = v_row.machine_id_sha256 and state = 'ready';
	end if;
	update public.qorpera_coding_snapshots set state = p_outcome, image_fingerprint = p_image_fingerprint, failure = p_failure,
		log = p_log, lease_until = null, finished_at = clock_timestamp()
	where id = v_row.id returning * into v_row;
	return jsonb_build_object('schema','qorpera.coding-snapshot-build/v1','buildId',v_row.id,'state',v_row.state);
end
$$;
comment on function public.qorpera_finish_coding_snapshot_build(uuid, uuid, text, text, text, text) is
	'5h-2 (20260930435000): ready (the image; it retires this node''s older snapshot), failed (the setup failed; the old snapshot stays) or abandoned (tried again at the next attach). Locks the member''s repository (advisory), then the row.';

-- 5. The node's images --------------------------------------------------------------------------------------------------

create function public.qorpera_list_coding_snapshots(p_owner text, p_machine_id_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.qorpera_coding_snapshots%rowtype;
begin
	-- 5h-2 (20260930435000)
	if auth.role() is distinct from 'service_role' or coalesce(p_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding snapshot custody required' using errcode = '42501'; end if;
	-- A ready snapshot whose member left the company is retired before the list names it due: once its image may go, no
	-- attach answers current with it, and a member who comes back builds again. Each under its member's repository's lock,
	-- as a build's finish, in one order.
	for v_row in select * from public.qorpera_coding_snapshots snapshot where snapshot.owner = p_owner
		and snapshot.machine_id_sha256 = p_machine_id_sha256 and snapshot.state = 'ready' and not exists (select 1
			from public.qorpera_profile_members member where member.profile_id = snapshot.profile_id
				and member.user_id = snapshot.member_user_id)
		order by snapshot.environment_id, snapshot.member_user_id, snapshot.repository, snapshot.id
	loop
		perform public.qorpera_coding_snapshot_lock(v_row.environment_id, v_row.member_user_id, v_row.repository);
		update public.qorpera_coding_snapshots snapshot set state = 'retired', retired_at = clock_timestamp()
		where snapshot.id = v_row.id and snapshot.state = 'ready' and not exists (select 1
			from public.qorpera_profile_members member where member.profile_id = snapshot.profile_id
				and member.user_id = snapshot.member_user_id);
	end loop;
	return coalesce((select jsonb_agg(listed.entry order by listed.started_at, listed.id) from (
		select snapshot.started_at, snapshot.id, jsonb_build_object('schema','qorpera.coding-snapshot-state/v1',
			'snapshotId',snapshot.id,'state',snapshot.state,'imageFingerprint',snapshot.image_fingerprint,'setupDigest',snapshot.setup_digest,'commitSha',snapshot.commit_sha,
			'startedAt',snapshot.started_at,'builtAt',snapshot.finished_at,'leaseUntil',snapshot.lease_until,
			'removeDue',snapshot.state = 'retired') entry
		from public.qorpera_coding_snapshots snapshot
		where snapshot.owner = p_owner and snapshot.machine_id_sha256 = p_machine_id_sha256 and snapshot.removed_at is null
			and (snapshot.state in ('ready','retired') or (snapshot.state = 'building' and snapshot.lease_until > clock_timestamp()))) listed),
		'[]'::jsonb);
end
$$;

-- The image is gone from the node. Only a retired snapshot: one the list named due for removal.
create function public.qorpera_record_coding_snapshot_removed(p_snapshot_id uuid, p_owner text, p_machine_id_sha256 text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.qorpera_coding_snapshots%rowtype;
begin
	-- 5h-2 (20260930435000)
	if auth.role() is distinct from 'service_role' or p_snapshot_id is null or coalesce(p_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding snapshot custody required' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_coding_snapshots where id = p_snapshot_id and owner = p_owner
		and machine_id_sha256 = p_machine_id_sha256;
	if v_row.id is null then raise exception 'Coding snapshot custody required' using errcode = '42501'; end if;
	perform public.qorpera_coding_snapshot_lock(v_row.environment_id, v_row.member_user_id, v_row.repository);
	select * into strict v_row from public.qorpera_coding_snapshots where id = p_snapshot_id for update;
	if v_row.removed_at is null then
		if v_row.state <> 'retired' then raise exception 'Coding snapshot is not due for removal' using errcode = '55000'; end if;
		update public.qorpera_coding_snapshots set removed_at = clock_timestamp() where id = v_row.id returning * into v_row;
	end if;
	-- Sent again, the same answer.
	return jsonb_build_object('schema','qorpera.coding-snapshot-removed/v1','snapshotId',v_row.id,'removedAt',v_row.removed_at);
end
$$;

-- 6. Privileges ---------------------------------------------------------------------------------------------------------

-- Internal: reached only through the functions below.
revoke all on function public.qorpera_coding_snapshot_view(public.qorpera_coding_snapshots)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_coding_snapshot_plan(text, public.qorpera_coding_snapshots, jsonb, timestamptz, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_coding_snapshot_lock(uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The coding executor's (control: CODING_SNAPSHOT_RPCS).
revoke all on function public.qorpera_begin_coding_snapshot_build(uuid, uuid, text, text, text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_renew_coding_snapshot_build(uuid, uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_finish_coding_snapshot_build(uuid, uuid, text, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_list_coding_snapshots(text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_record_coding_snapshot_removed(uuid, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_begin_coding_snapshot_build(uuid, uuid, text, text, text, integer) to service_role;
grant execute on function public.qorpera_renew_coding_snapshot_build(uuid, uuid, integer) to service_role;
grant execute on function public.qorpera_finish_coding_snapshot_build(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.qorpera_list_coding_snapshots(text, text) to service_role;
grant execute on function public.qorpera_record_coding_snapshot_removed(uuid, text, text) to service_role;
