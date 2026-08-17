-- Serialize GC safety decisions with profile-root writes, renew deletion leases
-- immediately before Storage calls, recover abandoned plans, and make proof
-- cost proportional to the candidate rather than every historical root.

create function public.qorpera_lock_profile_gc_fence(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform 1
	from public.qorpera_profiles as profile
	where profile.id = p_profile_id
	for update;
	if not found then
		raise exception 'profile is unavailable' using errcode = '40001';
	end if;
end
$$;

revoke all on function public.qorpera_lock_profile_gc_fence(uuid) from public;

create or replace function public.qorpera_reject_profile_root_during_gc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform public.qorpera_lock_profile_gc_fence(new.profile_id);
	if public.qorpera_profile_gc_deletion_active(new.profile_id) then
		raise exception 'profile object cleanup is in progress' using errcode = '40001';
	end if;
	return new;
end
$$;

create or replace function public.qorpera_reject_graph_completion_during_gc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if old.status <> 'complete' and new.status = 'complete' then
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if public.qorpera_profile_gc_deletion_active(new.profile_id) then
			raise exception 'profile object cleanup is in progress' using errcode = '40001';
		end if;
	end if;
	return new;
end
$$;

create or replace function public.qorpera_reject_gc_artifact_index_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select artifact.profile_id into v_profile_id
	from public.qorpera_artifacts as artifact
	where artifact.id = new.artifact_id;
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
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

create or replace function public.qorpera_reject_gc_substrate_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	if new.artifact_index_id is not null then
		select artifact_index.profile_id into v_profile_id
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.id = new.artifact_index_id;
		perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	end if;
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

create function public.qorpera_reject_gc_artifact_retention_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select artifact.profile_id into v_profile_id
	from public.qorpera_artifacts as artifact
	where artifact.id = new.artifact_id;
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	if exists (
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

revoke all on function public.qorpera_reject_gc_artifact_retention_hold() from public;

create trigger qorpera_artifact_retention_holds_gc_guard
	before insert or update of artifact_id on public.qorpera_artifact_retention_holds
	for each row execute function public.qorpera_reject_gc_artifact_retention_hold();

create function public.qorpera_profile_reachability_coverage_ready(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select
		not exists (
			select 1
			from public.qorpera_artifacts as artifact
			left join public.qorpera_object_reachability_graphs as graph
				on graph.root_kind = 'artifact' and graph.root_id = artifact.id
			where artifact.profile_id = p_profile_id
				and artifact.gc_completed_at is null
				and (graph.id is null or graph.status <> 'complete' or not graph.closure_verified)
		)
		and not exists (
			select 1
			from public.qorpera_company_snapshots as snapshot
			left join public.qorpera_object_reachability_graphs as graph
				on graph.root_kind = 'company_snapshot' and graph.root_id = snapshot.id
			where snapshot.profile_id = p_profile_id
				and (graph.id is null or graph.status <> 'complete' or not graph.closure_verified)
		)
$$;

revoke all on function public.qorpera_profile_reachability_coverage_ready(uuid) from public;

create or replace function public.qorpera_artifact_gc_initial_guard_ready(p_artifact_id uuid)
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
		or not public.qorpera_object_root_has_current_proof('artifact', p_artifact_id)
		or not public.qorpera_profile_reachability_coverage_ready(v_artifact.profile_id) then
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
	) then
		return false;
	end if;
	return true;
end
$$;

create or replace function public.qorpera_list_artifact_gc_candidates_without_worker(
	p_profile_id uuid,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_coverage boolean;
begin
	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'artifact garbage collection requires full access' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'artifact garbage collection page is invalid' using errcode = '22023';
	end if;
	v_profile_coverage := public.qorpera_profile_reachability_coverage_ready(p_profile_id);

	return coalesce((
		select jsonb_agg(
			public.qorpera_artifact_json(assessed.artifact)
			|| jsonb_build_object(
				'reachability_graph_id', assessed.graph_id,
				'reachability_ready', assessed.reachability_ready,
				'deletable_object_count', assessed.deletable_object_count,
				'deletable_storage_bytes', assessed.deletable_storage_bytes,
				'object_deletion_ready', false,
				'blocked_reason', case
					when not assessed.candidate_has_graph then 'artifact reachability closure is not independently verified'
					when not assessed.candidate_has_proof then 'artifact restore proof is missing or expired'
					when not assessed.profile_coverage then 'profile reachability closure coverage is incomplete'
					when not assessed.objects_available then 'one or more reachable objects are unavailable'
					else 'physical deletion worker is not deployed'
				end
			)
			order by (assessed.artifact).eligible_for_gc_at, (assessed.artifact).id
		)
		from (
			select
				candidate as artifact,
				graph.id as graph_id,
				(graph.id is not null and graph.status = 'complete' and graph.closure_verified) as candidate_has_graph,
				coalesce(public.qorpera_object_root_has_current_proof('artifact', candidate.id), false)
					as candidate_has_proof,
				coalesce(public.qorpera_object_graph_objects_available(graph.id), false) as objects_available,
				v_profile_coverage as profile_coverage,
				coalesce((
					select count(*)
					from public.qorpera_object_reachability_entries as candidate_entry
					where candidate_entry.graph_id = graph.id
						and not exists (
							select 1
							from public.qorpera_object_reachability_entries as retained_entry
							join public.qorpera_object_reachability_graphs as retained_graph
								on retained_graph.id = retained_entry.graph_id
							where retained_entry.object_sha256 = candidate_entry.object_sha256
								and retained_graph.id <> graph.id
								and retained_graph.profile_id = p_profile_id
								and retained_graph.status = 'complete'
						)
				), 0)::integer as deletable_object_count,
				coalesce((
					select sum(candidate_entry.bytes)
					from public.qorpera_object_reachability_entries as candidate_entry
					where candidate_entry.graph_id = graph.id
						and not exists (
							select 1
							from public.qorpera_object_reachability_entries as retained_entry
							join public.qorpera_object_reachability_graphs as retained_graph
								on retained_graph.id = retained_entry.graph_id
							where retained_entry.object_sha256 = candidate_entry.object_sha256
								and retained_graph.id <> graph.id
								and retained_graph.profile_id = p_profile_id
								and retained_graph.status = 'complete'
						)
				), 0)::bigint as deletable_storage_bytes,
				(
					graph.id is not null
					and graph.status = 'complete'
					and graph.closure_verified
					and public.qorpera_object_root_has_current_proof('artifact', candidate.id)
					and v_profile_coverage
				) as reachability_ready
			from public.qorpera_artifacts as candidate
			left join public.qorpera_object_reachability_graphs as graph
				on graph.root_kind = 'artifact' and graph.root_id = candidate.id
			where candidate.profile_id = p_profile_id
				and candidate.eligible_for_gc_at <= statement_timestamp()
				and candidate.gc_completed_at is null
				and not exists (
					select 1
					from public.qorpera_artifact_retention_holds as hold
					where hold.artifact_id = candidate.id
						and hold.released_at is null
						and (hold.expires_at is null or hold.expires_at > statement_timestamp())
				)
				and not exists (
					select 1
					from public.qorpera_artifact_index_entries as index_entry
					join public.qorpera_company_substrate_versions as version
						on version.artifact_index_id = index_entry.index_id
					where index_entry.artifact_id = candidate.id
				)
			order by candidate.eligible_for_gc_at, candidate.id
			limit p_limit
		) as assessed
	), '[]'::jsonb);
end
$$;

create or replace function public.qorpera_cancel_artifact_gc_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_expired_recovery boolean;
begin
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_plan.profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if v_plan.status = 'cancelled' then return public.qorpera_artifact_gc_plan_json(v_plan); end if;
	v_expired_recovery := v_plan.status = 'deleting'
		and v_plan.lease_expires_at <= statement_timestamp() - interval '1 minute';
	if (v_plan.started_at is not null and not v_expired_recovery)
		or (v_plan.status not in ('waiting', 'retrying') and not v_expired_recovery) then
		raise exception 'artifact cleanup plan can no longer be cancelled' using errcode = '55000';
	end if;
	perform public.qorpera_lock_profile_gc_fence(v_plan.profile_id);
	update public.qorpera_artifact_gc_plans
	set status = 'cancelled', cancelled_by_user_id = v_user_id,
		cancelled_at = statement_timestamp(), lease_id = null, lease_expires_at = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan,
		'cancelled',
		jsonb_build_object('expired_lease_recovery', v_expired_recovery),
		v_user_id
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create or replace function public.qorpera_claim_artifact_gc_plans(p_limit integer, p_lease_id uuid)
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
		perform public.qorpera_lock_profile_gc_fence(v_plan.profile_id);
		v_ready := public.qorpera_artifact_gc_initial_guard_ready(v_plan.artifact_id);
		if not v_ready then
			update public.qorpera_artifact_gc_plans
			set status = 'retrying', next_attempt_at = statement_timestamp() + interval '1 hour',
				last_error = 'Cleanup safety proof is incomplete', lease_id = null, lease_expires_at = null
			where id = v_plan.id returning * into v_plan;
			continue;
		end if;
		select proof.* into v_proof
		from public.qorpera_object_restore_proofs as proof
		where proof.graph_id = v_plan.graph_id and proof.valid_until > statement_timestamp()
		order by proof.valid_until desc limit 1;
		update public.qorpera_artifact_gc_plans
		set restore_proof_id = v_proof.id,
			started_at = coalesce(started_at, statement_timestamp()),
			status = 'deleting', attempt_count = attempt_count + 1,
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

create function public.qorpera_renew_artifact_gc_lease(
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
begin
	if auth.role() <> 'service_role'
		or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		)
		or exists (
			select 1 from unnest(p_object_sha256s) as sha256
			where sha256 !~ '^[0-9a-f]{64}$'
		) then
		raise exception 'artifact cleanup lease renewal is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then
		raise exception 'artifact cleanup lease is unavailable' using errcode = '40001';
	end if;
	perform public.qorpera_lock_profile_gc_fence(v_plan.profile_id);
	if exists (
		select 1
		from unnest(p_object_sha256s) as sha256
		left join public.qorpera_artifact_gc_plan_entries as entry
			on entry.plan_id = p_plan_id
			and entry.object_sha256 = sha256
			and entry.status = 'pending'
		where entry.object_sha256 is null
	) then
		raise exception 'artifact cleanup lease renewal is outside the pending plan' using errcode = '40001';
	end if;
	update public.qorpera_artifact_gc_plans
	set lease_expires_at = statement_timestamp() + interval '5 minutes'
	where id = p_plan_id
	returning * into v_plan;
	return jsonb_build_object('lease_expires_at', v_plan.lease_expires_at);
end
$$;

revoke all on function public.qorpera_renew_artifact_gc_lease(uuid, uuid, text[]) from public;
grant execute on function public.qorpera_renew_artifact_gc_lease(uuid, uuid, text[]) to service_role;
