-- 20260930536000: Try again on a failed folder-v2 turn queues a new turn (WB F4).
--
-- On folder-v2 a member's turn and an agent's first run start from a turn request: the materializer
-- (qorpera_folder_materialize_company, 20260928469310) makes the request's run, job and wake, and the run's id is the
-- request's. Try again on a failed turn (qorpera_resolve_failed_execution_run) released the run's input and recorded
-- recovery_released, but queued nothing: the input's one request was already materialized, so no step made a new run.
-- The card went away and the input waited for ever (production, 28 Oct 2026: a Researcher's first run).
--
-- 1. A turn request may follow one earlier request of its own input (retry_of_request_id), so an input has one first
--    request and one chain of retries. input_id stays unique among first requests.
-- 2. Try again on a session turn needs the run's own materialized request, in an open conversation; the conversation is
--    locked before the input, as the materializer locks them. It releases the input as before and queues a new request
--    for it with a new id (so the new run, job and runner get new ids), copying the old request's requester, payer,
--    computer and policy. The materializer's own checks and refusals apply on its next pass: a payer that is no longer
--    usable fails the new request and the input, with its reason. recovery_released names the new request. A run with a
--    durable operation outcome or an open proposal is still refused, and so is a retry by a member other than the one
--    whose ChatGPT plan pays (20260928359950).
--    Order: the new request is the newest in its conversation, so it runs after every request already queued there; one
--    turn at a time, in request order, as before.
-- 3. A retried run's wake is its own occurrence (input:<input>:retry:<run>), and a first run's wake stays once per agent
--    except a retry's.
-- 4. The first run's state, its queue and its start read the head of the input's chain (the request no retry follows).
-- An input an earlier Try again released keeps only its materialized request, and this migration does not queue it.
--
-- The edited functions are patched in place through their current text, so each keeps its ACL. Deploy order: either; the
-- web hides the failed card once recovery_released exists, as before.

set local lock_timeout = '3s';

-- 1. One first request per input, and one chain of retries after it.
alter table public.qorpera_session_turn_requests add column retry_of_request_id uuid unique;
alter table public.qorpera_session_turn_requests add constraint qorpera_session_turn_requests_id_input_id_key
	unique (id, input_id);
alter table public.qorpera_session_turn_requests add constraint qorpera_session_turn_requests_retry_of_fkey
	foreign key (retry_of_request_id, input_id) references public.qorpera_session_turn_requests(id, input_id);
alter table public.qorpera_session_turn_requests drop constraint qorpera_session_turn_requests_input_id_key;
create unique index qorpera_session_turn_requests_first_input on public.qorpera_session_turn_requests(input_id)
	where retry_of_request_id is null;

create function pg_temp.f4_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'F4 patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- 2. Try again queues a new request for the released input.
select pg_temp.f4_patch('public.qorpera_resolve_failed_execution_run(uuid,text)',
	$old$	v_changed integer;
begin$old$,
	$new$	v_changed integer;
	v_request public.qorpera_session_turn_requests%rowtype; -- 20260930536000 (F4)
	v_retry uuid := extensions.gen_random_uuid();
begin$new$);
select pg_temp.f4_patch('public.qorpera_resolve_failed_execution_run(uuid,text)',
	$old$		update public.qorpera_session_inputs
		set execution_run_id = null, failed_at = null, failure_reason = null$old$,
	$new$		-- 20260930536000 (F4): the run's own materialized request, in an open conversation, is the one a new request
		-- follows. The conversation is locked before the input, as the materializer locks them.
		select request.* into v_request from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session on session.id = request.session_id and session.status = 'open'
		where request.id = v_run.source_id and request.run_id = v_run.id and request.status = 'materialized'
			and request.session_id = v_run.session_id and array[request.input_id] = v_run.input_ids
		for no key update of session;
		if not found then
			raise exception 'execution recovery action is unavailable' using errcode = '55000';
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = null, failed_at = null, failure_reason = null$new$);
select pg_temp.f4_patch('public.qorpera_resolve_failed_execution_run(uuid,text)',
	$old$		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_released', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
		update public.qorpera_shared_sessions set updated_at = statement_timestamp()
		where id = v_run.session_id;$old$,
	$new$		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_released', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid(),
			'retry_turn_request_id', v_retry -- 20260930536000 (F4)
		));
		update public.qorpera_shared_sessions set updated_at = statement_timestamp()
		where id = v_run.session_id;
		-- 20260930536000 (F4): the input's next request, the newest in its conversation, so it runs after every request
		-- already queued there. The materializer's next pass checks and refuses it as any request.
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
			v_request.sponsored_at, v_request.initial_execution_selection, v_request.id);$new$);

-- 3. A retried run's wake is its own occurrence; a first run's wake stays once per agent except a retry's.
select pg_temp.f4_patch('public.qorpera_admit_input_wake()',
	$old$'input:' || v_source::text,$old$,
	$new$'input:' || v_source::text
		-- 20260930536000 (F4): a retried turn's wake is its own occurrence.
		|| case when exists (select 1 from public.qorpera_session_turn_requests as request
			where request.id = v_run.source_id and request.retry_of_request_id is not null)
		then ':retry:' || v_run.id::text else '' end,$new$);
drop index public.qorpera_wake_first_run_once;
create unique index qorpera_wake_first_run_once on public.qorpera_wake_occurrences(environment_id, staff_agent_id)
	where wake_kind = 'first-run' and occurrence_key not like 'input:%:retry:%';

-- 4. The first run reads the head of its input's chain.
select pg_temp.f4_patch('public.qorpera_folder_company_first_run_state(uuid)',
	$old$	left join public.qorpera_session_turn_requests as request on request.input_id = input.id$old$,
	$new$	-- 20260930536000 (F4): the head of the input's requests, the one no retry follows.
	left join public.qorpera_session_turn_requests as request on request.input_id = input.id
		and not exists (select 1 from public.qorpera_session_turn_requests as retry where retry.retry_of_request_id = request.id)$new$);
select pg_temp.f4_patch('public.qorpera_queue_agent_first_run(uuid,uuid,jsonb)',
	$old$	select id into v_request from public.qorpera_session_turn_requests where input_id = v_input.id;$old$,
	$new$	-- 20260930536000 (F4): the head of the input's requests, the one no retry follows.
	select request.id into v_request from public.qorpera_session_turn_requests as request where request.input_id = v_input.id
		and not exists (select 1 from public.qorpera_session_turn_requests as retry where retry.retry_of_request_id = request.id);$new$);
select pg_temp.f4_patch('public.qorpera_start_agent_first_run(uuid,uuid,uuid,bigint)',
	$old$			(select id from public.qorpera_session_turn_requests where input_id = v_input.id)); end if;$old$,
	$new$			-- 20260930536000 (F4): the head of the input's requests, the one no retry follows.
			(select request.id from public.qorpera_session_turn_requests as request where request.input_id = v_input.id
				and not exists (select 1 from public.qorpera_session_turn_requests as retry
					where retry.retry_of_request_id = request.id))); end if;$new$);
