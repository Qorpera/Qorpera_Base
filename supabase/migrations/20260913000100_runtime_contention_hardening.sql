-- Runtime contention hardening (v23 live root cause, 2026-09-12).
--
-- Observed on the live node: the PostgREST `authenticator` role runs with
-- statement_timeout = 8 s and lock_timeout = 8 s. Every runtime RPC inherits
-- both. A lock wait of eight seconds on qorpera_runner_jobs (validation holds
-- the job row while it waits for the profile GC fence; assignment, renewal
-- and completion queue behind that job row) is cancelled, surfaces as an
-- HTTP 500 to the guest, and the guest's authority monitor aborts the native
-- execution fail-closed. The artifact GC worker held the profile GC fence for
-- the whole eight seconds of every attempt, so the convoy formed every five
-- minutes. This migration is source-only and local; nothing here changes the
-- role configuration, which is a deployment step.

-- 1. Per-function lock budgets for the authority-critical RPCs.
--
-- lock_timeout is armed per lock wait, so a function-level value takes effect
-- for every lock the function waits on (verified: a function declared with
-- lock_timeout = '3s' waits the full three seconds under a 500 ms session
-- value). The guest-side deadline for lease validation is already 30 s, so a
-- convoy of up to 25 s no longer cancels these calls at the lock level.
--
-- statement_timeout is different: PostgreSQL arms the statement timer when
-- the calling statement starts, using the session (role) value, and a
-- function-level SET does not re-arm it (verified: a function declared with
-- statement_timeout = '5s' is still cancelled after one second under a
-- session value of 1 s). The declaration below therefore documents the budget
-- these RPCs need, but it only becomes effective once the role-level 8 s on
-- `authenticator` is raised to at least 25 s for these calls. Until then the
-- effective ceiling on every wait remains the role's statement_timeout.
alter function public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)
	set lock_timeout = '25s' set statement_timeout = '25s';
alter function public.qorpera_renew_runner_job(uuid,text,uuid,text)
	set lock_timeout = '25s' set statement_timeout = '25s';
alter function public.qorpera_assign_runner_job(uuid,uuid,uuid,uuid,text,integer)
	set lock_timeout = '25s' set statement_timeout = '25s';
alter function public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)
	set lock_timeout = '25s' set statement_timeout = '25s';
alter function public.qorpera_release_runtime_machine(uuid,text,text)
	set lock_timeout = '25s' set statement_timeout = '25s';
alter function public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)
	set lock_timeout = '25s' set statement_timeout = '25s';

-- 2. Company object GC: select candidates before taking the profile GC fence.
--
-- The previous body evaluated qorpera_company_retained_object_hashes() once
-- per profile object row inside the candidate scan, took the fence for every
-- profile it visited (including profiles it then skipped, whose row locks
-- stayed held until the statement ended), and never finished within the
-- worker's 8 s budget, so the fence was held for the full budget on every
-- attempt and the attempt was then rolled back.
--
-- The candidate set is now computed without any fence: profiles ordered by
-- their oldest aged object, one retained-hash evaluation per profile, at most
-- p_limit objects. The fence is taken only for the single profile that is
-- about to be leased, and only around the lease and entry inserts. Under the
-- fence the bounded candidate set is checked against the retained hashes once
-- more, because a Company File write that landed between selection and the
-- fence may have retained one of the candidates. Semantics are unchanged:
-- objects older than 24 hours, retained hashes excluded, p_limit objects for
-- one profile per call, profiles under an active deletion lease or plan are
-- skipped. Profile order now follows the oldest aged object of each profile
-- (retained or not) rather than the oldest unretained object; that changes
-- only which eligible profile is visited first, not which objects are
-- reclaimable.
create index qorpera_profile_objects_profile_created
	on public.qorpera_profile_objects (profile_id, created_at, sha256);

create or replace function public.qorpera_claim_company_object_gc(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_cutoff timestamptz := statement_timestamp() - interval '24 hours';
	v_candidates text[];
	v_objects jsonb;
begin
	if auth.role() <> 'service_role' or p_lease_id is null or p_limit not between 1 and 100 then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where lease_expires_at <= statement_timestamp();

	-- Candidate selection runs without the profile GC fence.
	for v_profile_id in
		select object.profile_id
		from public.qorpera_profile_objects as object
		where object.created_at < v_cutoff
			and exists (
				select 1 from public.qorpera_company_files as file
				where file.profile_id = object.profile_id
			)
		group by object.profile_id
		order by min(object.created_at), object.profile_id
	loop
		if public.qorpera_profile_gc_deletion_active(v_profile_id) then
			continue;
		end if;
		-- One retained-hash evaluation for this profile, still without the fence.
		select array_agg(candidate.sha256 order by candidate.created_at, candidate.sha256)
		into v_candidates
		from (
			with retained as materialized (
				select retained.object_sha256
				from public.qorpera_company_retained_object_hashes(v_profile_id) as retained
			)
			select object.sha256, object.created_at
			from public.qorpera_profile_objects as object
			where object.profile_id = v_profile_id
				and object.created_at < v_cutoff
				and not exists (
					select 1 from retained where retained.object_sha256 = object.sha256
				)
			order by object.created_at, object.sha256
			limit p_limit
		) as candidate;
		if v_candidates is null then
			continue;
		end if;

		-- Fence: one profile, held only around the lease and entry inserts.
		perform public.qorpera_lock_profile_gc_fence(v_profile_id);
		if public.qorpera_profile_gc_deletion_active(v_profile_id) then
			continue;
		end if;
		insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
		values (v_profile_id, p_lease_id, statement_timestamp() + interval '10 minutes');
		insert into public.qorpera_company_object_gc_entries (profile_id, lease_id, object_sha256, bytes)
		with retained as materialized (
			select retained.object_sha256
			from public.qorpera_company_retained_object_hashes(v_profile_id) as retained
		)
		select object.profile_id, p_lease_id, object.sha256, object.bytes
		from public.qorpera_profile_objects as object
		where object.profile_id = v_profile_id
			and object.sha256 = any (v_candidates)
			and object.created_at < v_cutoff
			and not exists (
				select 1 from retained where retained.object_sha256 = object.sha256
			)
		order by object.created_at, object.sha256
		limit p_limit;
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', entry.profile_id::text || '/' || entry.object_sha256,
			'backend', coalesce(object.backend, 'missing')
		) order by entry.object_sha256) into v_objects
		from public.qorpera_company_object_gc_entries as entry
		left join public.qorpera_profile_objects as object
			on object.profile_id = entry.profile_id and object.sha256 = entry.object_sha256
		where entry.profile_id = v_profile_id and entry.lease_id = p_lease_id;
		if v_objects is null then
			delete from public.qorpera_company_object_gc_leases
			where profile_id = v_profile_id and lease_id = p_lease_id;
			continue;
		end if;
		return jsonb_build_object(
			'profile_id', v_profile_id,
			'lease_id', p_lease_id,
			'objects', v_objects
		);
	end loop;
	return null;
end
$$;

-- The GC worker keeps an 8 s budget per attempt. As explained above this
-- declaration cannot shorten or extend the timer armed by the calling
-- statement; it pins the intended budget for this function once role-level
-- timeouts change.
alter function public.qorpera_claim_company_object_gc(integer, uuid)
	set statement_timeout = '8s';

-- 3. Retire stale managed runners during orchestrator reconciliation.
--
-- Every native run leaves its managed-sandbox qorpera_runners row `active`
-- with an expired session token; the orchestrator then carries those rows
-- forever (40 on the live node today). Retire a runner only when its current
-- session and its previous-session grace window both expired more than
-- 30 minutes ago, it holds no queued or leased job, and no live assignment is
-- addressed to it. Runners with a live session or an unfinished job are never
-- touched. The terminal state and audit are the ones qorpera_revoke_runner
-- writes: status 'revoked', tokens cleared, revoked_at set, and a
-- 'runner_revoked' receipt. The runners check constraint requires
-- revoked_by_user_id whenever revoked_at is set, so the reconciler records
-- the runner's registering member as the revoking user and no actor on the
-- receipt (the receipt payload names the reason).
create function public.qorpera_retire_stale_managed_runners()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_runner public.qorpera_runners%rowtype;
	v_retired integer := 0;
begin
	for v_runner in
		select runner.*
		from public.qorpera_runners as runner
		where runner.status = 'active'
			and runner.worker_class = 'managed_sandbox'
			and runner.provider_adapter is not null
			and runner.session_expires_at < statement_timestamp() - interval '30 minutes'
			and (
				runner.previous_session_expires_at is null
				or runner.previous_session_expires_at < statement_timestamp() - interval '30 minutes'
			)
			and not exists (
				select 1 from public.qorpera_runner_jobs as job
				where job.runner_id = runner.id and job.status in ('queued', 'leased')
			)
			and not exists (
				select 1 from public.qorpera_runner_assignments as assignment
				where assignment.runner_id = runner.id
					and assignment.status in ('offered', 'accepted')
					and assignment.expires_at > statement_timestamp()
			)
		order by runner.session_expires_at, runner.id
		limit 100
		for update of runner skip locked
	loop
		update public.qorpera_runners
		set status = 'revoked', session_token_sha256 = null, session_expires_at = null,
			previous_session_token_sha256 = null, previous_session_expires_at = null,
			last_renewal_id = null, revoked_by_user_id = v_runner.registered_by_user_id,
			revoked_at = statement_timestamp()
		where id = v_runner.id and status = 'active';
		if not found then
			continue;
		end if;
		perform public.qorpera_append_runner_audit(
			v_runner.profile_id, v_runner.id, null, 'runner_revoked',
			jsonb_build_object(
				'reason', 'stale_managed_session',
				'session_expires_at', v_runner.session_expires_at,
				'worker_class', v_runner.worker_class,
				'provider_adapter', v_runner.provider_adapter
			),
			null
		);
		v_retired := v_retired + 1;
	end loop;
	return v_retired;
end
$$;

revoke all on function public.qorpera_retire_stale_managed_runners() from public, anon, authenticated, service_role;

-- Checked replacement preserves the deployed reconciler's owner, ACL and body;
-- the retirement step runs after the leased-job loop and before the claim and
-- assignment expiry updates.
do $$
declare
	v_target regprocedure := 'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old text := E'\tupdate public.qorpera_runner_assignments as assignment\n'
		|| E'\tset status = \'expired\', last_error = \'Assignment was not accepted before expiry\'\n';
	v_new text := E'\tperform public.qorpera_retire_stale_managed_runners();\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Orchestrator reconciler assignment expiry differs from its approved upgrade source';
	end if;
	execute replace(v_definition, v_old, v_new || v_old);
end $$;
