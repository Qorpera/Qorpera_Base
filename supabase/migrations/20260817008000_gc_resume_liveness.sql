-- Restore resumability for partially-deleted cleanup plans.
--
-- 20260817005000 unified the claim guard, which made resuming a started plan
-- require a current restore proof for the candidate itself. A started plan may
-- already have removed some of the candidate's bytes, so a fresh proof can
-- never be minted again: the plan loops 'retrying' hourly forever while the
-- profile fence stays logically reachable and no operator escape exists
-- (cancel correctly refuses partially-applied plans). Resuming instead
-- re-checks every abort condition that can still change after deletion began
-- (completion, retention holds, substrate references, profile closure
-- coverage) but not the candidate's own proof, which was verified against the
-- intact bytes before the first removal. This mirrors the deliberate split in
-- 20260816018000.
--
-- The proof lookup also moves inside the readiness decision: a proof that
-- expires between the guard and the lookup now sends the one plan to
-- 'retrying' instead of aborting the whole claim batch on a null id.

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
		v_proof := null;
		if v_plan.started_at is null then
			v_ready := public.qorpera_artifact_gc_initial_guard_ready(v_plan.artifact_id);
			if v_ready then
				select proof.* into v_proof
				from public.qorpera_object_restore_proofs as proof
				where proof.graph_id = v_plan.graph_id and proof.valid_until > statement_timestamp()
				order by proof.valid_until desc limit 1;
				v_ready := found;
			end if;
		else
			v_ready := exists (
				select 1
				from public.qorpera_artifacts as artifact
				where artifact.id = v_plan.artifact_id
					and artifact.gc_completed_at is null
					and not exists (
						select 1
						from public.qorpera_artifact_retention_holds as hold
						where hold.artifact_id = artifact.id
							and hold.released_at is null
							and (hold.expires_at is null or hold.expires_at > statement_timestamp())
					)
					and not exists (
						select 1
						from public.qorpera_artifact_index_entries as index_entry
						join public.qorpera_company_substrate_versions as version
							on version.artifact_index_id = index_entry.index_id
						where index_entry.artifact_id = artifact.id
					)
			) and public.qorpera_profile_reachability_coverage_ready(v_plan.profile_id);
		end if;
		if not v_ready then
			update public.qorpera_artifact_gc_plans
			set status = 'retrying', next_attempt_at = statement_timestamp() + interval '1 hour',
				last_error = 'Cleanup safety proof is incomplete', lease_id = null, lease_expires_at = null
			where id = v_plan.id returning * into v_plan;
			continue;
		end if;
		update public.qorpera_artifact_gc_plans
		set restore_proof_id = coalesce(v_proof.id, restore_proof_id),
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
