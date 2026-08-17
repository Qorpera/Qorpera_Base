-- Recoverable artifact cleanup plans and service-role worker leases.
--
-- Authenticated desktop clients may prepare, inspect, retry, or cancel plans,
-- but never receive object paths or deletion authority. A service-role Edge
-- Function claims mature plans, fences new roots for the profile, removes only
-- objects that are still exclusive, and records immutable audit receipts.

alter table public.qorpera_artifacts
	add column gc_completed_at timestamptz;

create table public.qorpera_artifact_gc_plans (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	artifact_id uuid not null references public.qorpera_artifacts(id) on delete restrict,
	graph_id uuid not null references public.qorpera_object_reachability_graphs(id) on delete restrict,
	restore_proof_id uuid not null references public.qorpera_object_restore_proofs(id) on delete restrict,
	client_plan_id uuid not null,
	status text not null default 'waiting'
		check (status in ('waiting', 'deleting', 'retrying', 'completed', 'cancelled', 'failed')),
	object_count integer not null default 0 check (object_count between 0 and 400000),
	storage_bytes bigint not null default 0 check (storage_bytes between 0 and 2199023255552),
	not_before timestamptz not null default statement_timestamp() + interval '24 hours',
	next_attempt_at timestamptz not null default statement_timestamp() + interval '24 hours',
	attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
	lease_id uuid,
	lease_expires_at timestamptz,
	last_error text check (last_error is null or char_length(last_error) between 1 and 1000),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	started_at timestamptz,
	completed_at timestamptz,
	cancelled_by_user_id uuid references auth.users(id) on delete restrict,
	cancelled_at timestamptz,
	unique (profile_id, client_plan_id),
	check (not_before >= created_at + interval '24 hours'),
	check ((lease_id is null) = (lease_expires_at is null)),
	check ((status = 'completed') = (completed_at is not null)),
	check ((status = 'cancelled') = (cancelled_at is not null)),
	check ((cancelled_by_user_id is null) = (cancelled_at is null))
);

create unique index qorpera_artifact_gc_plans_active_artifact
	on public.qorpera_artifact_gc_plans (artifact_id)
	where status in ('waiting', 'deleting', 'retrying', 'failed');

create index qorpera_artifact_gc_plans_worker
	on public.qorpera_artifact_gc_plans (next_attempt_at, created_at)
	where status in ('waiting', 'deleting', 'retrying');

create table public.qorpera_artifact_gc_plan_entries (
	plan_id uuid not null references public.qorpera_artifact_gc_plans(id) on delete cascade,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 8388608),
	status text not null default 'pending' check (status in ('pending', 'deleted', 'retained')),
	acknowledged_at timestamptz,
	primary key (plan_id, object_sha256),
	check ((status = 'pending') = (acknowledged_at is null))
);

create table public.qorpera_artifact_gc_audit_receipts (
	id bigint generated always as identity primary key,
	plan_id uuid not null references public.qorpera_artifact_gc_plans(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	event_type text not null check (event_type in (
		'created', 'claimed', 'object_batch_acknowledged', 'retrying',
		'failed', 'completed', 'cancelled', 'manual_retry'
	)),
	payload jsonb not null check (jsonb_typeof(payload) = 'object'),
	actor_user_id uuid references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp()
);

create index qorpera_artifact_gc_audit_plan_sequence
	on public.qorpera_artifact_gc_audit_receipts (plan_id, id);

alter table public.qorpera_artifact_gc_plans enable row level security;
alter table public.qorpera_artifact_gc_plan_entries enable row level security;
alter table public.qorpera_artifact_gc_audit_receipts enable row level security;

revoke all on public.qorpera_artifact_gc_plans from anon, authenticated;
revoke all on public.qorpera_artifact_gc_plan_entries from anon, authenticated;
revoke all on public.qorpera_artifact_gc_audit_receipts from anon, authenticated;

create function public.qorpera_artifact_gc_plan_json(p_plan public.qorpera_artifact_gc_plans)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'plan_id', p_plan.id,
		'profile_id', p_plan.profile_id,
		'artifact_id', p_plan.artifact_id,
		'graph_id', p_plan.graph_id,
		'restore_proof_id', p_plan.restore_proof_id,
		'client_plan_id', p_plan.client_plan_id,
		'status', p_plan.status,
		'object_count', p_plan.object_count,
		'storage_bytes', p_plan.storage_bytes,
		'not_before', p_plan.not_before,
		'next_attempt_at', p_plan.next_attempt_at,
		'attempt_count', p_plan.attempt_count,
		'last_error', p_plan.last_error,
		'created_by_user_id', p_plan.created_by_user_id,
		'created_at', p_plan.created_at,
		'started_at', p_plan.started_at,
		'completed_at', p_plan.completed_at,
		'cancelled_by_user_id', p_plan.cancelled_by_user_id,
		'cancelled_at', p_plan.cancelled_at,
		'pending_object_count', (
			select count(*) from public.qorpera_artifact_gc_plan_entries as entry
			where entry.plan_id = p_plan.id and entry.status = 'pending'
		),
		'deleted_object_count', (
			select count(*) from public.qorpera_artifact_gc_plan_entries as entry
			where entry.plan_id = p_plan.id and entry.status = 'deleted'
		),
		'retained_object_count', (
			select count(*) from public.qorpera_artifact_gc_plan_entries as entry
			where entry.plan_id = p_plan.id and entry.status = 'retained'
		)
	)
$$;

create function public.qorpera_append_artifact_gc_audit(
	p_plan public.qorpera_artifact_gc_plans,
	p_event_type text,
	p_payload jsonb,
	p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_artifact_gc_audit_receipts (
		plan_id, profile_id, event_type, payload, actor_user_id
	)
	values (p_plan.id, p_plan.profile_id, p_event_type, p_payload, p_actor_user_id);
end
$$;

create function public.qorpera_artifact_gc_initial_guard_ready(p_artifact_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_artifact public.qorpera_artifacts%rowtype;
begin
	select artifact.* into v_artifact
	from public.qorpera_artifacts as artifact
	where artifact.id = p_artifact_id;
	if not found or v_artifact.gc_completed_at is not null
		or v_artifact.eligible_for_gc_at > statement_timestamp()
		or not public.qorpera_object_root_has_current_proof('artifact', p_artifact_id) then
		return false;
	end if;
	if exists (
		select 1 from public.qorpera_artifact_retention_holds as hold
		where hold.artifact_id = p_artifact_id and hold.released_at is null
			and (hold.expires_at is null or hold.expires_at > statement_timestamp())
	) or exists (
		select 1
		from public.qorpera_artifact_index_entries as index_entry
		join public.qorpera_company_substrate_versions as version
			on version.artifact_index_id = index_entry.index_id
		where index_entry.artifact_id = p_artifact_id
	) or exists (
		select 1 from public.qorpera_artifacts as other_artifact
		where other_artifact.profile_id = v_artifact.profile_id
			and other_artifact.id <> p_artifact_id
			and other_artifact.gc_completed_at is null
			and not public.qorpera_object_root_has_current_proof('artifact', other_artifact.id)
	) or exists (
		select 1 from public.qorpera_company_snapshots as snapshot
		where snapshot.profile_id = v_artifact.profile_id
			and not public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
	) then
		return false;
	end if;
	return true;
end
$$;

create function public.qorpera_profile_gc_deletion_active(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.qorpera_artifact_gc_plans as plan
		where plan.profile_id = p_profile_id and plan.status = 'deleting'
	)
$$;

create function public.qorpera_profile_object_writes_allowed(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_can_write_profile(p_profile_id)
		and not public.qorpera_profile_gc_deletion_active(p_profile_id)
$$;

revoke all on function public.qorpera_artifact_gc_plan_json(public.qorpera_artifact_gc_plans) from public;
revoke all on function public.qorpera_append_artifact_gc_audit(public.qorpera_artifact_gc_plans, text, jsonb, uuid) from public;
revoke all on function public.qorpera_artifact_gc_initial_guard_ready(uuid) from public;
revoke all on function public.qorpera_profile_gc_deletion_active(uuid) from public;
revoke all on function public.qorpera_profile_object_writes_allowed(uuid) from public;

alter policy qorpera_profile_objects_member_insert on storage.objects
	with check (
		bucket_id = 'qorpera-profile-objects'
		and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[0-9a-f]{64}$'
		and public.qorpera_profile_object_writes_allowed(((storage.foldername(name))[1])::uuid)
	);

create function public.qorpera_reject_profile_root_during_gc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if public.qorpera_profile_gc_deletion_active(new.profile_id) then
		raise exception 'profile object cleanup is in progress' using errcode = '40001';
	end if;
	return new;
end
$$;

create function public.qorpera_reject_graph_completion_during_gc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if old.status <> 'complete' and new.status = 'complete'
		and public.qorpera_profile_gc_deletion_active(new.profile_id) then
		raise exception 'profile object cleanup is in progress' using errcode = '40001';
	end if;
	return new;
end
$$;

create function public.qorpera_reject_gc_artifact_index_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if exists (
		select 1
		from public.qorpera_artifacts as artifact
		where artifact.id = new.artifact_id and artifact.gc_completed_at is not null
	) or exists (
		select 1
		from public.qorpera_artifact_gc_plans as plan
		where plan.artifact_id = new.artifact_id
			and plan.status in ('waiting', 'deleting', 'retrying', 'failed')
	) then
		raise exception 'artifact is quarantined for cleanup' using errcode = '22023';
	end if;
	return new;
end
$$;

create function public.qorpera_reject_gc_substrate_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.artifact_index_id is not null and exists (
		select 1
		from public.qorpera_artifact_index_entries as index_entry
		join public.qorpera_artifacts as artifact on artifact.id = index_entry.artifact_id
		left join public.qorpera_artifact_gc_plans as plan
			on plan.artifact_id = artifact.id
			and plan.status in ('waiting', 'deleting', 'retrying', 'failed')
		where index_entry.index_id = new.artifact_index_id
			and (artifact.gc_completed_at is not null or plan.id is not null)
	) then
		raise exception 'artifact index contains quarantined cleanup content' using errcode = '22023';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_reject_profile_root_during_gc() from public;
revoke all on function public.qorpera_reject_graph_completion_during_gc() from public;
revoke all on function public.qorpera_reject_gc_artifact_index_entry() from public;
revoke all on function public.qorpera_reject_gc_substrate_version() from public;

create trigger qorpera_company_snapshots_gc_fence
	before insert on public.qorpera_company_snapshots
	for each row execute function public.qorpera_reject_profile_root_during_gc();

create trigger qorpera_artifacts_gc_fence
	before insert on public.qorpera_artifacts
	for each row execute function public.qorpera_reject_profile_root_during_gc();

create trigger qorpera_object_graphs_gc_fence
	before update of status on public.qorpera_object_reachability_graphs
	for each row execute function public.qorpera_reject_graph_completion_during_gc();

create trigger qorpera_artifact_index_entries_gc_guard
	before insert on public.qorpera_artifact_index_entries
	for each row execute function public.qorpera_reject_gc_artifact_index_entry();

create trigger qorpera_substrate_versions_gc_guard
	before insert on public.qorpera_company_substrate_versions
	for each row execute function public.qorpera_reject_gc_substrate_version();

create function public.qorpera_create_artifact_gc_plan(
	p_artifact_id uuid,
	p_client_plan_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_artifact public.qorpera_artifacts%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_proof public.qorpera_object_restore_proofs%rowtype;
	v_existing public.qorpera_artifact_gc_plans%rowtype;
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	select artifact.* into v_artifact
	from public.qorpera_artifacts as artifact
	where artifact.id = p_artifact_id;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_artifact.profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if p_client_plan_id is null then
		raise exception 'artifact cleanup plan is invalid' using errcode = '22023';
	end if;

	select plan.* into v_existing
	from public.qorpera_artifact_gc_plans as plan
	where plan.profile_id = v_artifact.profile_id and plan.client_plan_id = p_client_plan_id;
	if found then
		if v_existing.artifact_id <> p_artifact_id then
			raise exception 'artifact cleanup client id is already bound to another artifact' using errcode = '23505';
		end if;
		return public.qorpera_artifact_gc_plan_json(v_existing);
	end if;
	if not public.qorpera_artifact_gc_initial_guard_ready(p_artifact_id) then
		raise exception 'artifact cleanup safety proof is incomplete' using errcode = '55000';
	end if;

	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.root_kind = 'artifact' and graph.root_id = p_artifact_id and graph.status = 'complete';
	select proof.* into v_proof
	from public.qorpera_object_restore_proofs as proof
	where proof.graph_id = v_graph.id and proof.valid_until > statement_timestamp()
	order by proof.valid_until desc
	limit 1;

	insert into public.qorpera_artifact_gc_plans (
		profile_id, artifact_id, graph_id, restore_proof_id,
		client_plan_id, created_by_user_id
	)
	values (
		v_artifact.profile_id, p_artifact_id, v_graph.id, v_proof.id,
		p_client_plan_id, v_user_id
	)
	returning * into v_plan;

	insert into public.qorpera_artifact_gc_plan_entries (plan_id, object_sha256, bytes)
	select v_plan.id, entry.object_sha256, entry.bytes
	from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = v_graph.id
		and not exists (
			select 1
			from public.qorpera_object_reachability_entries as retained_entry
			join public.qorpera_object_reachability_graphs as retained_graph
				on retained_graph.id = retained_entry.graph_id
			where retained_entry.object_sha256 = entry.object_sha256
				and retained_graph.id <> v_graph.id
				and retained_graph.profile_id = v_artifact.profile_id
				and retained_graph.status = 'complete'
		);

	update public.qorpera_artifact_gc_plans
	set object_count = summary.object_count,
		storage_bytes = summary.storage_bytes
	from (
		select count(*)::integer as object_count, coalesce(sum(entry.bytes), 0)::bigint as storage_bytes
		from public.qorpera_artifact_gc_plan_entries as entry
		where entry.plan_id = v_plan.id
	) as summary
	where id = v_plan.id
	returning * into v_plan;

	perform public.qorpera_append_artifact_gc_audit(
		v_plan,
		'created',
		jsonb_build_object(
			'not_before', v_plan.not_before,
			'object_count', v_plan.object_count,
			'storage_bytes', v_plan.storage_bytes
		),
		v_user_id
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create function public.qorpera_list_artifact_gc_plans(p_profile_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'artifact cleanup page is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(public.qorpera_artifact_gc_plan_json(plan) order by plan.created_at desc)
		from (
			select candidate.* from public.qorpera_artifact_gc_plans as candidate
			where candidate.profile_id = p_profile_id
			order by candidate.created_at desc limit p_limit
		) as plan
	), '[]'::jsonb);
end
$$;

create function public.qorpera_list_artifact_gc_audit(p_plan_id uuid, p_after_id bigint default 0, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id;
	if auth.uid() is null or not found or not public.qorpera_can_authorize_profile(v_plan.profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if p_after_id < 0 or p_limit not between 1 and 500 then
		raise exception 'artifact cleanup audit page is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'receipt_id', receipt.id,
			'plan_id', receipt.plan_id,
			'event_type', receipt.event_type,
			'payload', receipt.payload,
			'actor_user_id', receipt.actor_user_id,
			'created_at', receipt.created_at
		) order by receipt.id)
		from (
			select candidate.* from public.qorpera_artifact_gc_audit_receipts as candidate
			where candidate.plan_id = p_plan_id and candidate.id > p_after_id
			order by candidate.id limit p_limit
		) as receipt
	), '[]'::jsonb);
end
$$;

create function public.qorpera_cancel_artifact_gc_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_plan.profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if v_plan.status = 'cancelled' then return public.qorpera_artifact_gc_plan_json(v_plan); end if;
	if v_plan.started_at is not null or v_plan.status not in ('waiting', 'retrying') then
		raise exception 'artifact cleanup plan can no longer be cancelled' using errcode = '55000';
	end if;
	update public.qorpera_artifact_gc_plans
	set status = 'cancelled', cancelled_by_user_id = v_user_id,
		cancelled_at = statement_timestamp(), lease_id = null, lease_expires_at = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(v_plan, 'cancelled', '{}'::jsonb, v_user_id);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create function public.qorpera_retry_artifact_gc_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_plan.profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if v_plan.status <> 'failed' then return public.qorpera_artifact_gc_plan_json(v_plan); end if;
	update public.qorpera_artifact_gc_plans
	set status = 'retrying', next_attempt_at = statement_timestamp(), last_error = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(v_plan, 'manual_retry', '{}'::jsonb, v_user_id);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create function public.qorpera_claim_artifact_gc_plans(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_proof public.qorpera_object_restore_proofs%rowtype;
	v_result jsonb := '[]'::jsonb;
	v_ready boolean;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 20 or p_lease_id is null then
		raise exception 'artifact cleanup worker claim is invalid' using errcode = '42501';
	end if;
	for v_plan in
		select candidate.*
		from public.qorpera_artifact_gc_plans as candidate
		where candidate.status in ('waiting', 'retrying', 'deleting')
			and candidate.not_before <= statement_timestamp()
			and candidate.next_attempt_at <= statement_timestamp()
			and (candidate.lease_expires_at is null or candidate.lease_expires_at <= statement_timestamp())
		order by candidate.next_attempt_at, candidate.created_at
		for update skip locked
		limit p_limit
	loop
		if v_plan.started_at is null then
			v_ready := public.qorpera_artifact_gc_initial_guard_ready(v_plan.artifact_id);
		else
			v_ready := exists (
				select 1 from public.qorpera_artifacts as artifact
				where artifact.id = v_plan.artifact_id and artifact.gc_completed_at is null
					and not exists (
						select 1 from public.qorpera_artifact_retention_holds as hold
						where hold.artifact_id = artifact.id and hold.released_at is null
							and (hold.expires_at is null or hold.expires_at > statement_timestamp())
					)
					and not exists (
						select 1 from public.qorpera_artifact_index_entries as index_entry
						join public.qorpera_company_substrate_versions as version
							on version.artifact_index_id = index_entry.index_id
						where index_entry.artifact_id = artifact.id
					)
					and not exists (
						select 1 from public.qorpera_artifacts as other_artifact
						where other_artifact.profile_id = artifact.profile_id
							and other_artifact.id <> artifact.id
							and other_artifact.gc_completed_at is null
							and not public.qorpera_object_root_has_current_proof('artifact', other_artifact.id)
					)
					and not exists (
						select 1 from public.qorpera_company_snapshots as snapshot
						where snapshot.profile_id = artifact.profile_id
							and not public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
					)
			);
		end if;
		if not v_ready then
			update public.qorpera_artifact_gc_plans
			set status = 'retrying', next_attempt_at = statement_timestamp() + interval '1 hour',
				last_error = 'Cleanup safety proof is incomplete', lease_id = null, lease_expires_at = null
			where id = v_plan.id returning * into v_plan;
			continue;
		end if;
		if v_plan.started_at is null then
			select proof.* into v_proof
			from public.qorpera_object_restore_proofs as proof
			where proof.graph_id = v_plan.graph_id and proof.valid_until > statement_timestamp()
			order by proof.valid_until desc limit 1;
			update public.qorpera_artifact_gc_plans
			set restore_proof_id = v_proof.id, started_at = statement_timestamp()
			where id = v_plan.id returning * into v_plan;
		end if;
		update public.qorpera_artifact_gc_plans
		set status = 'deleting', attempt_count = attempt_count + 1,
			lease_id = p_lease_id, lease_expires_at = statement_timestamp() + interval '5 minutes',
			last_error = null
		where id = v_plan.id returning * into v_plan;
		perform public.qorpera_append_artifact_gc_audit(
			v_plan, 'claimed', jsonb_build_object('attempt_count', v_plan.attempt_count), null
		);
		v_result := v_result || jsonb_build_array(jsonb_build_object(
			'plan_id', v_plan.id,
			'profile_id', v_plan.profile_id,
			'lease_id', v_plan.lease_id,
			'attempt_count', v_plan.attempt_count
		));
	end loop;
	return v_result;
end
$$;

create function public.qorpera_claim_artifact_gc_objects(p_plan_id uuid, p_lease_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 100 then
		raise exception 'artifact cleanup object claim is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise exception 'artifact cleanup lease is unavailable' using errcode = '40001'; end if;

	update public.qorpera_artifact_gc_plan_entries as entry
	set status = 'retained', acknowledged_at = statement_timestamp()
	where entry.plan_id = p_plan_id and entry.status = 'pending'
		and exists (
			select 1
			from public.qorpera_object_reachability_entries as retained_entry
			join public.qorpera_object_reachability_graphs as retained_graph
				on retained_graph.id = retained_entry.graph_id
			where retained_entry.object_sha256 = entry.object_sha256
				and retained_graph.id <> v_plan.graph_id
				and retained_graph.profile_id = v_plan.profile_id
				and retained_graph.status = 'complete'
		);

	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', v_plan.profile_id::text || '/' || entry.object_sha256
		) order by entry.object_sha256)
		from (
			select candidate.* from public.qorpera_artifact_gc_plan_entries as candidate
			where candidate.plan_id = p_plan_id and candidate.status = 'pending'
			order by candidate.object_sha256 limit p_limit
		) as entry
	), '[]'::jsonb);
end
$$;

create function public.qorpera_complete_artifact_gc_objects(
	p_plan_id uuid,
	p_lease_id uuid,
	p_object_sha256s text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_count integer;
	v_bytes bigint;
begin
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		) or exists (select 1 from unnest(p_object_sha256s) as sha256 where sha256 !~ '^[0-9a-f]{64}$') then
		raise exception 'artifact cleanup acknowledgement is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise exception 'artifact cleanup lease is unavailable' using errcode = '40001'; end if;
	if exists (
		select 1 from unnest(p_object_sha256s) as sha256
		left join public.qorpera_artifact_gc_plan_entries as entry
			on entry.plan_id = p_plan_id and entry.object_sha256 = sha256 and entry.status = 'pending'
		where entry.object_sha256 is null
	) then
		raise exception 'artifact cleanup acknowledgement is outside the plan' using errcode = '22023';
	end if;
	select count(*), coalesce(sum(entry.bytes), 0) into v_count, v_bytes
	from public.qorpera_artifact_gc_plan_entries as entry
	where entry.plan_id = p_plan_id and entry.object_sha256 = any(p_object_sha256s);
	update public.qorpera_artifact_gc_plan_entries
	set status = 'deleted', acknowledged_at = statement_timestamp()
	where plan_id = p_plan_id and object_sha256 = any(p_object_sha256s);
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, 'object_batch_acknowledged',
		jsonb_build_object('object_count', v_count, 'storage_bytes', v_bytes), null
	);
	return jsonb_build_object('object_count', v_count, 'storage_bytes', v_bytes);
end
$$;

create function public.qorpera_complete_artifact_gc_plan(p_plan_id uuid, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_artifact public.qorpera_artifacts%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'artifact cleanup completion requires the worker' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise exception 'artifact cleanup lease is unavailable' using errcode = '40001'; end if;
	perform public.qorpera_claim_artifact_gc_objects(p_plan_id, p_lease_id, 100);
	if exists (
		select 1 from public.qorpera_artifact_gc_plan_entries as entry
		where entry.plan_id = p_plan_id and entry.status = 'pending'
	) then
		raise exception 'artifact cleanup still has pending objects' using errcode = '40001';
	end if;
	if exists (
		select 1
		from public.qorpera_artifact_gc_plan_entries as entry
		join storage.objects as object
			on object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_plan.profile_id::text || '/' || entry.object_sha256
		where entry.plan_id = p_plan_id and entry.status = 'deleted'
	) then
		raise exception 'artifact cleanup storage removal is not yet visible' using errcode = '40001';
	end if;
	select artifact.* into v_artifact from public.qorpera_artifacts as artifact
	where artifact.id = v_plan.artifact_id for update;
	if exists (
		select 1 from public.qorpera_artifact_retention_holds as hold
		where hold.artifact_id = v_artifact.id and hold.released_at is null
			and (hold.expires_at is null or hold.expires_at > statement_timestamp())
	) or exists (
		select 1 from public.qorpera_artifact_index_entries as index_entry
		join public.qorpera_company_substrate_versions as version
			on version.artifact_index_id = index_entry.index_id
		where index_entry.artifact_id = v_artifact.id
	) then
		raise exception 'artifact cleanup became retained before completion' using errcode = '40001';
	end if;
	update public.qorpera_artifacts set gc_completed_at = statement_timestamp()
	where id = v_artifact.id;
	update public.qorpera_artifact_gc_plans
	set status = 'completed', completed_at = statement_timestamp(),
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, 'completed', jsonb_build_object(
			'deleted_object_count', (
				select count(*) from public.qorpera_artifact_gc_plan_entries as entry
				where entry.plan_id = p_plan_id and entry.status = 'deleted'
			),
			'retained_object_count', (
				select count(*) from public.qorpera_artifact_gc_plan_entries as entry
				where entry.plan_id = p_plan_id and entry.status = 'retained'
			)
		), null
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create function public.qorpera_fail_artifact_gc_plan(
	p_plan_id uuid,
	p_lease_id uuid,
	p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_status text;
begin
	if auth.role() <> 'service_role' then
		raise exception 'artifact cleanup failure requires the worker' using errcode = '42501';
	end if;
	select plan.* into v_plan from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise exception 'artifact cleanup lease is unavailable' using errcode = '40001'; end if;
	v_status := case when v_plan.attempt_count >= 8 then 'failed' else 'retrying' end;
	update public.qorpera_artifact_gc_plans
	set status = v_status,
		next_attempt_at = statement_timestamp() + make_interval(
			secs => least(3600, (30 * power(2, greatest(attempt_count - 1, 0)))::integer)
		),
		last_error = left(coalesce(nullif(btrim(p_error), ''), 'Storage cleanup failed'), 1000),
		lease_id = null, lease_expires_at = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan, case when v_status = 'failed' then 'failed' else 'retrying' end,
		jsonb_build_object('attempt_count', v_plan.attempt_count, 'error', v_plan.last_error), null
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

-- Preserve the detailed assessment from the reachability migration while
-- replacing its deployment placeholder with the worker-backed readiness
-- contract. Completed artifacts and artifacts with an active plan disappear
-- from the candidate list; plan creation still rechecks every guard under lock.
alter function public.qorpera_list_artifact_gc_candidates(uuid, integer)
	rename to qorpera_list_artifact_gc_candidates_without_worker;

revoke all on function public.qorpera_list_artifact_gc_candidates_without_worker(uuid, integer) from public;
revoke execute on function public.qorpera_list_artifact_gc_candidates_without_worker(uuid, integer) from authenticated;

create function public.qorpera_list_artifact_gc_candidates(
	p_profile_id uuid,
	p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(jsonb_agg(
		candidate.value
		|| jsonb_build_object(
			'object_deletion_ready', (candidate.value ->> 'reachability_ready')::boolean,
			'blocked_reason', case
				when (candidate.value ->> 'reachability_ready')::boolean then 'null'::jsonb
				else candidate.value -> 'blocked_reason'
			end
		)
		order by candidate.ordinality
	), '[]'::jsonb)
	from jsonb_array_elements(
		public.qorpera_list_artifact_gc_candidates_without_worker(p_profile_id, p_limit)
	) with ordinality as candidate(value, ordinality)
	join public.qorpera_artifacts as artifact
		on artifact.id = (candidate.value ->> 'artifact_id')::uuid
	where artifact.gc_completed_at is null
		and not exists (
			select 1
			from public.qorpera_artifact_gc_plans as plan
			where plan.artifact_id = artifact.id
				and plan.status in ('waiting', 'deleting', 'retrying', 'failed')
		)
$$;

revoke all on function public.qorpera_create_artifact_gc_plan(uuid, uuid) from public;
revoke all on function public.qorpera_list_artifact_gc_plans(uuid, integer) from public;
revoke all on function public.qorpera_list_artifact_gc_audit(uuid, bigint, integer) from public;
revoke all on function public.qorpera_cancel_artifact_gc_plan(uuid) from public;
revoke all on function public.qorpera_retry_artifact_gc_plan(uuid) from public;
revoke all on function public.qorpera_claim_artifact_gc_plans(integer, uuid) from public;
revoke all on function public.qorpera_claim_artifact_gc_objects(uuid, uuid, integer) from public;
revoke all on function public.qorpera_complete_artifact_gc_objects(uuid, uuid, text[]) from public;
revoke all on function public.qorpera_complete_artifact_gc_plan(uuid, uuid) from public;
revoke all on function public.qorpera_fail_artifact_gc_plan(uuid, uuid, text) from public;
revoke all on function public.qorpera_list_artifact_gc_candidates(uuid, integer) from public;

grant execute on function public.qorpera_create_artifact_gc_plan(uuid, uuid) to authenticated;
grant execute on function public.qorpera_list_artifact_gc_plans(uuid, integer) to authenticated;
grant execute on function public.qorpera_list_artifact_gc_audit(uuid, bigint, integer) to authenticated;
grant execute on function public.qorpera_cancel_artifact_gc_plan(uuid) to authenticated;
grant execute on function public.qorpera_retry_artifact_gc_plan(uuid) to authenticated;
grant execute on function public.qorpera_claim_artifact_gc_plans(integer, uuid) to service_role;
grant execute on function public.qorpera_claim_artifact_gc_objects(uuid, uuid, integer) to service_role;
grant execute on function public.qorpera_complete_artifact_gc_objects(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_complete_artifact_gc_plan(uuid, uuid) to service_role;
grant execute on function public.qorpera_fail_artifact_gc_plan(uuid, uuid, text) to service_role;
grant execute on function public.qorpera_list_artifact_gc_candidates(uuid, integer) to authenticated;
