-- 20260930581000: work that waited across a release runs on the release that runs it (5 Nov 2026).
-- Live on 5 Nov, right after v206: the Co-Founder's first run in a new company had waited since 17:32 on the founder's
-- used-up login (575000, 579000) and moved to his second login by his own pick (580000) at 18:55. Its run was made under
-- bundle 205, the bundle its kickoff input was pinned to when it was queued, while v206 had been live since 18:22: the
-- node's native host, which runs only the active bundle, refused it at once (NATIVE_BUNDLE_COMPATIBILITY), and the
-- thread showed "Co-Founder did not finish this run" with Dismiss only. A release drains the runs in flight, but since
-- 575000 a message or a first run may wait days at a usage limit, across any number of releases.
-- * A session input that has not begun (no run, no turn, not completed or failed) takes the active bundle when the
--   materializer, holding its lock, is about to make its run, if the active bundle is a newer version of the input's
--   own (qorpera_repin_waiting_input): it was accepted, nothing has run it, and only the active bundle can. Never
--   backwards (a roll back leaves newer inputs as they are) and never another bundle key. The provenance stays
--   immutable otherwise: the trigger allows only that change, only from that function.
-- * A session turn refused this way (its run's bundle no longer active, its job failed with NATIVE_BUNDLE_COMPATIBILITY,
--   nothing durable done, its conversation open, not released or discarded) is tried again once, as the member's Try
--   again would (qorpera_resolve_failed_execution_run 'retry'): its input is released and a new request follows its own,
--   on the same payer; the materializer then pins it to the active bundle. This runs when such a failure commits (a
--   deferred trigger on the job) and once now, for the turns refused before (the last three days). A failure here never
--   undoes the job's failure or this migration: the turn stays failed, as before.
-- Locks: the re-pin changes a row the materializer already holds. The retry takes the run and job, then the
-- conversation, then the input, as resolve does. Every new or changed body carries the marker 20260930581000.

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
		-- 20260930581000: an input that waited across a release takes the active bundle (qorpera_repin_waiting_input).
		and not (current_setting('qorpera.input_bundle_repin', true) = 'on' and new.actor_kind = old.actor_kind
			and old.completed_at is null and old.failed_at is null and old.execution_run_id is null and old.turn_id is null
			and (new.runtime_bundle_id, new.runtime_bundle_sha256) = (select active.runtime_bundle_id,
				active.runtime_bundle_sha256 from public.qorpera_active_runtime_bundle as active where active.singleton)) then$new$);

-- An unbegun input under an older version of the active bundle's key takes the active bundle. The caller holds its row.
create function public.qorpera_repin_waiting_input(p_input_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	-- 20260930581000: the active bundle read FOR SHARE, so an activation waits for this change, not the other way.
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton for share;
	if not exists (select 1 from public.qorpera_session_inputs as input
		join public.qorpera_runtime_bundles as own on own.id = input.runtime_bundle_id
		join public.qorpera_runtime_bundles as active on active.id = v_bundle.runtime_bundle_id
		where input.id = p_input_id and input.completed_at is null and input.failed_at is null
			and input.execution_run_id is null and input.turn_id is null
			and input.runtime_bundle_id <> v_bundle.runtime_bundle_id
			and own.bundle_key = active.bundle_key and own.version < active.version) then
		return false;
	end if;
	perform set_config('qorpera.input_bundle_repin', 'on', true);
	update public.qorpera_session_inputs
	set runtime_bundle_id = v_bundle.runtime_bundle_id, runtime_bundle_sha256 = v_bundle.runtime_bundle_sha256
	where id = p_input_id;
	perform set_config('qorpera.input_bundle_repin', '', true);
	return true;
end $$;

-- A session turn refused because its bundle was no longer active, tried again once, as the member's Try again would.
-- True when it was; false when it is not such a turn, or its conversation or input moved on. Without p_wait (as the
-- job's commit calls it) it never waits for a lock: a row another transaction holds leaves the turn failed, as before.
create function public.qorpera_retry_run_refused_for_retired_bundle(p_run_id uuid, p_wait boolean default true)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_request public.qorpera_session_turn_requests%rowtype;
	v_retry uuid := extensions.gen_random_uuid(); v_changed integer;
begin
	-- 20260930581000
	select run.* into v_run from public.qorpera_execution_runs as run
	join public.qorpera_runner_jobs as job on job.id = run.job_id and job.run_id = run.id and job.status = 'failed'
	where run.id = p_run_id and run.source_kind = 'session_turn'
		and job.last_error like '%[code=NATIVE_BUNDLE_COMPATIBILITY:%'
		and run.runtime_bundle_sha256 <> (select active.runtime_bundle_sha256
			from public.qorpera_active_runtime_bundle as active where active.singleton)
		and not exists (select 1 from public.qorpera_execution_run_events as resolved where resolved.run_id = run.id
			and resolved.event_type in ('recovery_released', 'recovery_discarded'))
		and not exists (select 1 from public.qorpera_run_operation_receipts as receipt where receipt.run_id = run.id)
		and not exists (select 1 from public.qorpera_company_proposals as proposal
			where proposal.execution_kind = 'run' and proposal.execution_id = run.id and proposal.status = 'open')
	for update of run, job skip locked;
	if not found then return false; end if;
	if p_wait then
		select request.* into v_request from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
		where request.id = v_run.source_id and request.run_id = v_run.id and request.status = 'materialized'
			and request.session_id = v_run.session_id and array[request.input_id] = v_run.input_ids
		for no key update of session;
	else
		select request.* into v_request from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
		where request.id = v_run.source_id and request.run_id = v_run.id and request.status = 'materialized'
			and request.session_id = v_run.session_id and array[request.input_id] = v_run.input_ids
		for no key update of session skip locked;
	end if;
	if not found then return false; end if;
	if not p_wait and exists (select 1 from public.qorpera_session_inputs as input where input.id = any(v_run.input_ids)
		and input.execution_run_id = v_run.id and input.completed_at is null
		and input.id not in (select held.id from public.qorpera_session_inputs as held where held.id = any(v_run.input_ids)
			for update skip locked)) then
		return false;
	end if;
	update public.qorpera_session_inputs
	set execution_run_id = null, failed_at = null, failure_reason = null
	where id = any(v_run.input_ids) and execution_run_id = v_run.id and completed_at is null;
	get diagnostics v_changed = row_count;
	if v_changed <> cardinality(v_run.input_ids) then
		raise exception '20260930581000: the refused run''s inputs changed: %', v_run.id; end if;
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
	return true;
end $$;

revoke all on function public.qorpera_repin_waiting_input(uuid), public.qorpera_retry_run_refused_for_retired_bundle(uuid, boolean)
	from public, anon, authenticated, service_role;

-- When such a failure commits, its turn goes again. A failure of the retry leaves the turn failed, as before.
create function public.qorpera_retry_refused_run_on_failure()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930581000
	begin
		perform public.qorpera_retry_run_refused_for_retired_bundle(new.run_id, false);
	exception when others then
		raise warning '20260930581000: the refused run % was not tried again: %', new.run_id, sqlstate;
	end;
	return null;
end $$;
revoke all on function public.qorpera_retry_refused_run_on_failure() from public, anon, authenticated, service_role;
create constraint trigger qorpera_runner_jobs_retry_refused_for_retired_bundle
	after update of status on public.qorpera_runner_jobs
	deferrable initially deferred
	for each row when (new.status = 'failed' and old.status is distinct from 'failed' and new.run_id is not null
		and new.last_error like '%[code=NATIVE_BUNDLE_COMPATIBILITY:%')
	execute function public.qorpera_retry_refused_run_on_failure();

-- The materializer re-pins a waiting input it holds before it makes its run.
select pg_temp.lb581_patch('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	$old$				v_skipped := v_skipped + 1;
				continue;
			end if;
			v_reason := null;
			select * into v_staff$old$,
	$new$				v_skipped := v_skipped + 1;
				continue;
			end if;
			-- 20260930581000: an input that waited across a release takes the active bundle, the only one a node runs.
			if public.qorpera_repin_waiting_input(v_input.id) then
				select * into v_input from public.qorpera_session_inputs where id = v_request.input_id;
			end if;
			v_reason := null;
			select * into v_staff$new$);

-- The turns already refused this way (the last three days) go again once; one that cannot stays failed.
do $$
declare v_run uuid;
begin
	for v_run in select run.id from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id and job.status = 'failed'
		where run.source_kind = 'session_turn' and job.last_error like '%[code=NATIVE_BUNDLE_COMPATIBILITY:%'
			and coalesce(job.finished_at, run.created_at) > statement_timestamp() - interval '3 days'
		order by run.created_at, run.id
	loop
		begin
			if public.qorpera_retry_run_refused_for_retired_bundle(v_run) then
				raise notice '20260930581000: the refused run % goes again', v_run; end if;
		exception when others then
			raise warning '20260930581000: the refused run % was not tried again: %', v_run, sqlstate;
		end;
	end loop;
end $$;

drop function pg_temp.lb581_patch(regprocedure, text, text);
