-- 20260930581000: work that waited across a release runs on the release that runs it (5 Nov 2026).
-- Live on 5 Nov, right after v206: the Co-Founder's first run in a new company had waited since 17:32 on the founder's
-- used-up login (575000, 579000) and moved to his second login by his own pick (580000) at 18:55. Its run was made under
-- bundle 205, the bundle its kickoff input was pinned to when it was queued, while v206 had been live since 18:22: the
-- node's native host, which runs only the active bundle, refused it at once (NATIVE_BUNDLE_COMPATIBILITY), and the
-- thread showed "Co-Founder did not finish this run" with Dismiss only. A release drains the runs in flight, but since
-- 575000 a message or a first run may wait days at a usage limit, across any number of releases.
-- * A session input that has not begun (no run, no turn, not completed or failed) and waits in a queued turn request is
--   re-pinned to the active bundle when its company's materializer pass starts (qorpera_repin_waiting_inputs): it was
--   accepted, nothing has run it, and only the active bundle can. The provenance stays immutable otherwise: the trigger
--   allows only that change, only from that function.
-- * A session turn already refused this way (its run's bundle no longer active, failed with NATIVE_BUNDLE_COMPATIBILITY
--   in the last three days, nothing durable done, its conversation open, not yet resolved) is tried again once, as the
--   member's Try again would (qorpera_resolve_failed_execution_run 'retry'): its input is released and a new request
--   follows its own, on the same payer; the next pass pins it to the active bundle.
-- Locks: the re-pin takes the inputs FOR UPDATE SKIP LOCKED before the pass reads its work; one another transaction
-- holds is re-pinned by a later pass. Every new or changed body carries the marker 20260930581000.

set local lock_timeout = '3s';

create function pg_temp.lb581_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930581000' in v_definition) > 0 then
		raise exception '20260930581000 is already in %', p_target; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930581000 anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The input's bundle changes only to the active one, only before anything ran it, only from the re-pin below.
select pg_temp.lb581_patch('public.qorpera_pin_session_input_provenance()'::regprocedure,
	$old$is distinct from (old.actor_kind,old.runtime_bundle_id,old.runtime_bundle_sha256) then$old$,
	$new$is distinct from (old.actor_kind,old.runtime_bundle_id,old.runtime_bundle_sha256)
		-- 20260930581000: an input that waited across a release takes the active bundle (qorpera_repin_waiting_inputs).
		and not (current_setting('qorpera.input_bundle_repin', true) = 'on' and new.actor_kind = old.actor_kind
			and old.completed_at is null and old.failed_at is null and old.execution_run_id is null and old.turn_id is null
			and (new.runtime_bundle_id, new.runtime_bundle_sha256) = (select active.runtime_bundle_id,
				active.runtime_bundle_sha256 from public.qorpera_active_runtime_bundle as active where active.singleton)) then$new$);

-- A company's inputs that wait in queued turn requests under a bundle that is no longer active take the active one.
create function public.qorpera_repin_waiting_inputs(p_profile_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_bundle public.qorpera_active_runtime_bundle%rowtype; v_count integer;
begin
	-- 20260930581000
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	if not exists (select 1 from public.qorpera_session_turn_requests as request
		join public.qorpera_session_inputs as input on input.id = request.input_id
		where request.profile_id = p_profile_id and request.status = 'queued'
			and (input.runtime_bundle_id, input.runtime_bundle_sha256)
				is distinct from (v_bundle.runtime_bundle_id, v_bundle.runtime_bundle_sha256)) then
		return 0;
	end if;
	perform set_config('qorpera.input_bundle_repin', 'on', true);
	update public.qorpera_session_inputs as input
	set runtime_bundle_id = v_bundle.runtime_bundle_id, runtime_bundle_sha256 = v_bundle.runtime_bundle_sha256
	where input.id in (select waiting.id from public.qorpera_session_inputs as waiting
		where waiting.id in (select request.input_id from public.qorpera_session_turn_requests as request
				where request.profile_id = p_profile_id and request.status = 'queued')
			and waiting.completed_at is null and waiting.failed_at is null and waiting.execution_run_id is null
			and waiting.turn_id is null
			and (waiting.runtime_bundle_id, waiting.runtime_bundle_sha256)
				is distinct from (v_bundle.runtime_bundle_id, v_bundle.runtime_bundle_sha256)
		for update skip locked);
	get diagnostics v_count = row_count;
	perform set_config('qorpera.input_bundle_repin', '', true);
	return v_count;
end $$;

-- Session turns refused because their bundle was no longer active, tried again once, as the member's Try again would.
create function public.qorpera_retry_runs_refused_for_retired_bundle()
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_request public.qorpera_session_turn_requests%rowtype;
	v_retry uuid; v_changed integer; v_count integer := 0;
begin
	-- 20260930581000
	for v_run in select run.* from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id and job.run_id = run.id and job.status = 'failed'
		where run.source_kind = 'session_turn'
			and run.runtime_bundle_sha256 <> (select active.runtime_bundle_sha256
				from public.qorpera_active_runtime_bundle as active where active.singleton)
			and exists (select 1 from public.qorpera_execution_run_events as failed
				where failed.run_id = run.id and failed.event_type = 'failed'
					and failed.created_at > statement_timestamp() - interval '3 days'
					and failed.payload ->> 'error' like '%[code=NATIVE_BUNDLE_COMPATIBILITY:%')
			and not exists (select 1 from public.qorpera_execution_run_events as resolved where resolved.run_id = run.id
				and resolved.event_type in ('recovery_released', 'recovery_discarded', 'recovery_acknowledged'))
			and not exists (select 1 from public.qorpera_run_operation_receipts as receipt where receipt.run_id = run.id)
			and not exists (select 1 from public.qorpera_company_proposals as proposal
				where proposal.execution_kind = 'run' and proposal.execution_id = run.id and proposal.status = 'open')
		order by run.created_at, run.id
		for update of run, job skip locked
	loop
		select request.* into v_request from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
		where request.id = v_run.source_id and request.run_id = v_run.id and request.status = 'materialized'
			and request.session_id = v_run.session_id and array[request.input_id] = v_run.input_ids
		for no key update of session;
		continue when not found;
		if (select count(*) from public.qorpera_session_inputs as input where input.id = any(v_run.input_ids)
			and input.execution_run_id = v_run.id and input.completed_at is null) <> cardinality(v_run.input_ids) then
			continue;
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = null, failed_at = null, failure_reason = null
		where id = any(v_run.input_ids) and execution_run_id = v_run.id and completed_at is null;
		get diagnostics v_changed = row_count;
		if v_changed <> cardinality(v_run.input_ids) then
			raise exception '20260930581000: the refused run''s inputs changed: %', v_run.id; end if;
		v_retry := extensions.gen_random_uuid();
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_released', jsonb_build_object('action', 'retry', 'resolved_by_user_id', null,
			'retry_turn_request_id', v_retry, 'reason', 'runtime_bundle_retired'));
		update public.qorpera_shared_sessions set updated_at = statement_timestamp() where id = v_run.session_id;
		insert into public.qorpera_session_turn_requests(id, profile_id, session_id, client_request_id, input_id,
			requested_by_user_id, sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id,
			requested_sponsor_user_id, compute_identity_id, logical_computer_id, worker_class, required_capability, job_type,
			publication_mode, review_policy_key, reviewer_staff_ids, status, sponsored_at, initial_execution_selection,
			retry_of_request_id)
		values (v_retry, v_request.profile_id, v_request.session_id, v_retry, v_request.input_id,
			v_request.requested_by_user_id, v_request.sponsor_mode, v_request.sponsor_binding_id, v_request.sponsor_version,
			v_request.sponsored_by_user_id, v_request.requested_sponsor_user_id, v_request.compute_identity_id,
			v_request.logical_computer_id, v_request.worker_class, v_request.required_capability, v_request.job_type,
			v_request.publication_mode, v_request.review_policy_key, v_request.reviewer_staff_ids, 'queued',
			v_request.sponsored_at, v_request.initial_execution_selection, v_request.id);
		v_count := v_count + 1;
	end loop;
	return v_count;
end $$;

revoke all on function public.qorpera_repin_waiting_inputs(uuid), public.qorpera_retry_runs_refused_for_retired_bundle()
	from public, anon, authenticated, service_role;

-- The materializer's pass re-pins its company's waiting inputs before it reads its work.
select pg_temp.lb581_patch('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	$old$-- The work, read without a lock: it names the rows to lock in rank order.$old$,
	$new$-- 20260930581000: inputs that waited across a release take the active bundle, the only one a node runs.
	perform public.qorpera_repin_waiting_inputs(p_profile_id);

	-- The work, read without a lock: it names the rows to lock in rank order.$new$);

-- The turns already refused this way go again once.
select public.qorpera_retry_runs_refused_for_retired_bundle();

drop function pg_temp.lb581_patch(regprocedure, text, text);
