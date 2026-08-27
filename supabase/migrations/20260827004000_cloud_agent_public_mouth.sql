-- Runtime step 1: the only agent-authored messages admitted to a cloud
-- conversation are explicit sends. Provider output is never a transcript.
-- Delivery reuses the canonical, hash-chained session event store and the
-- existing run/runner/assignment authority. The ledger is an idempotency
-- receipt, not another conversation or Company File store.

create table public.qorpera_agent_sends (
	event_id uuid primary key,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	assignment_id uuid not null references public.qorpera_runner_assignments(id) on delete restrict,
	idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	phase text not null check (phase in ('progress', 'final')),
	text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
	body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default statement_timestamp(),
	unique (run_id, idempotency_key)
);

create unique index qorpera_agent_sends_one_final on public.qorpera_agent_sends (run_id) where phase = 'final';
alter table public.qorpera_agent_sends enable row level security;
revoke all on public.qorpera_agent_sends from public, anon, authenticated, service_role;
grant select on public.qorpera_agent_sends to service_role;

-- Fail closed for every cloud event writer, including the older generic
-- transcript RPC. This leaves existing history intact but does not grant it
-- permission to admit new model text, reasoning, or tool payloads.
create function public.qorpera_enforce_agent_send_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.execution_kind = 'run' and new.event_type = 'message' and not exists (
		select 1 from public.qorpera_agent_sends as delivery
		where delivery.event_id = new.event_id and delivery.run_id = new.execution_id
			and delivery.session_id = new.session_id and delivery.assignment_id = new.runner_assignment_id
			and delivery.body_sha256 = encode(extensions.digest(convert_to(new.body::text, 'utf8'), 'sha256'), 'hex')
	) then
		raise exception 'cloud agent messages require an explicit send' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_session_events_public_mouth
before insert on public.qorpera_session_events
for each row execute function public.qorpera_enforce_agent_send_event();

create function public.qorpera_send_runner_agent_message(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_idempotency_key text,
	p_text text,
	p_phase text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_delivery public.qorpera_agent_sends%rowtype;
	v_event public.qorpera_session_events%rowtype;
	v_event_id uuid := extensions.gen_random_uuid();
	v_text_sha256 text;
	v_parent_id text;
	v_body jsonb;
	v_result jsonb;
begin
	-- This locks the job and rechecks sponsor, company membership, deadline,
	-- compute identity and the current lease at the effect boundary.
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.session_id is null or v_job.job_type <> 'agent_turn'
		or p_assignment_id is distinct from v_job.client_lease_id
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.run_id = v_run.id
				and assignment.job_id = v_job.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted' and assignment.expires_at > statement_timestamp()
		) then
		raise exception 'agent send audience or assignment is unavailable' using errcode = '42501';
	end if;
	if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or p_text is null or p_text !~ '[^[:space:]]'
		or octet_length(convert_to(p_text, 'utf8')) > 65536
		or p_phase is null or p_phase not in ('progress', 'final') then
		raise exception 'agent send arguments are invalid' using errcode = '22023';
	end if;
	v_text_sha256 := encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex');
	select delivery.* into v_delivery from public.qorpera_agent_sends as delivery
	where delivery.run_id = v_run.id and delivery.idempotency_key = p_idempotency_key;
	if found then
		if v_delivery.text_sha256 <> v_text_sha256 or v_delivery.phase <> p_phase then
			raise exception 'agent send key is bound to different content' using errcode = '23505';
		end if;
		select event.* into strict v_event from public.qorpera_session_events as event where event.event_id = v_delivery.event_id;
		return jsonb_build_object(
			'schema', 'qorpera.agent-send/v1', 'runId', v_run.id, 'sessionId', v_delivery.session_id,
			'messageId', v_delivery.event_id, 'phase', v_delivery.phase, 'sequence', v_event.sequence
		);
	end if;
	if exists (select 1 from public.qorpera_agent_sends as delivery where delivery.run_id = v_run.id and delivery.phase = 'final') then
		raise exception 'agent public output is already final' using errcode = '55000';
	end if;
	-- Serialize against all other session writers before selecting the parent.
	perform 1 from public.qorpera_shared_sessions as session where session.id = v_run.session_id for update;
	select coalesce(event.body #>> '{entry,id}', event.body ->> 'entryId') into v_parent_id
	from public.qorpera_session_events as event
	where event.session_id = v_run.session_id and (
		(event.body #>> '{entry,id}') is not null or
		(event.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
			and (event.body ->> 'partIndex')::integer = (event.body ->> 'partCount')::integer - 1)
	) order by event.sequence desc limit 1;
	v_body := jsonb_build_object(
		'schema', 'qorpera.runner-transcript-entry/v1',
		'entry', jsonb_build_object(
			'type', 'message', 'id', v_event_id, 'parentId', v_parent_id,
			'timestamp', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text))),
			'delivery', jsonb_build_object('schema', 'qorpera.agent-send/v1', 'phase', p_phase),
			'execution', jsonb_build_object('kind', 'run', 'id', v_run.id, 'claimantId', v_run.id, 'runnerAssignmentId', p_assignment_id)
		)
	);
	insert into public.qorpera_agent_sends (event_id, run_id, session_id, assignment_id, idempotency_key, phase, text_sha256, body_sha256)
	values (v_event_id, v_run.id, v_run.session_id, p_assignment_id, p_idempotency_key, p_phase, v_text_sha256,
		encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'));
	v_result := public.qorpera_append_runner_transcript_event(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, v_event_id, 'message', v_body, null
	);
	return jsonb_build_object(
		'schema', 'qorpera.agent-send/v1', 'runId', v_run.id, 'sessionId', v_run.session_id,
		'messageId', v_event_id, 'phase', p_phase, 'sequence', (v_result ->> 'sequence')::bigint
	);
end
$$;

-- The native host has a service capability, but the harness has only a random
-- bearer token to its one-run mouth. Neither runner credentials nor authority
-- selectors are exposed as tool arguments or placed in Company File storage.
create function public.qorpera_send_native_agent_message(
	p_lease_id uuid, p_run_id uuid, p_job_id uuid, p_runner_id uuid,
	p_assignment_id uuid, p_credential_capsule_id uuid, p_compute_identity_id uuid,
	p_provider text, p_native_harness text,
	p_idempotency_key text, p_text text, p_phase text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_session_token_sha256 text;
	v_lease_token_sha256 text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'native agent send authority is required' using errcode = '42501';
	end if;
	-- Match the job-first lock order used by runner operations and completion.
	perform 1 from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	perform public.qorpera_validate_native_provider_execution_lease(
		p_lease_id, p_run_id, p_job_id, p_runner_id, p_assignment_id,
		p_credential_capsule_id, p_compute_identity_id, p_provider, p_native_harness
	);
	select runner.session_token_sha256 into strict v_session_token_sha256
	from public.qorpera_runners as runner where runner.id = p_runner_id;
	select job.lease_token_sha256 into strict v_lease_token_sha256
	from public.qorpera_runner_jobs as job where job.id = p_job_id;
	return public.qorpera_send_runner_agent_message(
		p_runner_id, v_session_token_sha256, p_job_id, v_lease_token_sha256,
		p_assignment_id, p_idempotency_key, p_text, p_phase
	);
end
$$;

-- An acknowledgement is not a delivered result. Completion cannot be faked
-- with a custom receipt or private model text, even by an old runner binary.
create function public.qorpera_require_final_agent_send()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.status = 'completed' and old.status is distinct from 'completed'
		and new.job_type = 'agent_turn' and exists (
			select 1 from public.qorpera_execution_runs as run
			where run.id = new.run_id and run.session_id is not null
		) and not exists (
			select 1 from public.qorpera_agent_sends as delivery
			join public.qorpera_session_events as event on event.event_id = delivery.event_id
			where delivery.run_id = new.run_id and delivery.phase = 'final'
				and event.execution_id = new.run_id
		) then
		raise exception 'agent conversation turn requires a final send' using errcode = '55000';
	end if;
	return new;
end
$$;

create trigger qorpera_runner_jobs_final_send
before update of status on public.qorpera_runner_jobs
for each row execute function public.qorpera_require_final_agent_send();

revoke all on function public.qorpera_enforce_agent_send_event() from public;
revoke all on function public.qorpera_require_final_agent_send() from public;
revoke all on function public.qorpera_send_runner_agent_message(uuid, text, uuid, text, uuid, text, text, text) from public;
revoke all on function public.qorpera_send_native_agent_message(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text) from public;
grant execute on function public.qorpera_send_runner_agent_message(uuid, text, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.qorpera_send_native_agent_message(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text) to service_role;
