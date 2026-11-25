-- WHY: Materialize newly posted room wakes inline in the same transaction when realtime wakes are active so the first orchestrator wake claims a ready runner job without a separate materialize round-trip.
set local lock_timeout = '3s';

create function public.qorpera_folder_materialize_room_wakes_inline(
	p_profile_id uuid,
	p_environment_id uuid,
	p_session_id uuid,
	p_wake_ids uuid[]
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_now timestamptz := clock_timestamp();
	v_session public.qorpera_shared_sessions%rowtype;
	v_seq bigint;
	v_identity uuid;
	v_unavailable uuid[] := '{}'::uuid[];
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_compute_id uuid;
	v_mode text;
	v_worker_class text;
	v_payload jsonb;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_materialized integer := 0;
begin
	if p_profile_id is null or p_environment_id is null or p_session_id is null
		or coalesce(cardinality(p_wake_ids), 0) = 0 then
		return 0;
	end if;
	-- WHY: Bound lock waits tightly inside a user post transaction; any contention falls back cleanly to the orchestrator materializer.
	perform set_config('lock_timeout', '50ms', true);
	if not coalesce((select settings.enabled from public.qorpera_orchestrator_wake_settings as settings), false) then
		perform set_config('lock_timeout', v_lock_timeout, true);
		return 0;
	end if;
	if not exists (
		select 1 from public.qorpera_company_files
		where profile_id = p_profile_id and environment_id = p_environment_id and core = 'folder-v2'
	) or public.qorpera_company_execution_paused(p_profile_id)
		or public.qorpera_company_at_zero(p_profile_id, v_now) then
		perform set_config('lock_timeout', v_lock_timeout, true);
		return 0;
	end if;
	-- WHY: Never overtake an earlier queued session_turn request (such as a first-run kickoff) waiting in the same conversation.
	if exists (
		select 1 from public.qorpera_session_turn_requests as request
		join public.qorpera_session_inputs as input on input.id = request.input_id and input.session_id = request.session_id
		where request.session_id = p_session_id and request.status = 'queued'
			and input.completed_at is null and input.failed_at is null
			and input.execution_run_id is null and input.turn_id is null
	) then
		perform set_config('lock_timeout', v_lock_timeout, true);
		return 0;
	end if;
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id and status = 'open';
	v_seq := (select clock.last_seq from public.qorpera_folder_clocks as clock where clock.environment_id = p_environment_id);
	if v_session.id is null or v_seq is null then
		perform set_config('lock_timeout', v_lock_timeout, true);
		return 0;
	end if;
	-- WHY: Use NOWAIT locks because qorpera_folder_post_room_message already holds the conversation and admission locks; aborting on contention preserves deadlock-free lock ordering.
	perform 1 from public.qorpera_staff_execution_authorities as authority
	where authority.profile_id = p_profile_id
		and authority.staff_agent_id in (
			select wake.staff_agent_id from public.qorpera_wake_occurrences as wake
			where wake.id = any(p_wake_ids) and wake.staff_agent_id is not null
		)
	order by authority.staff_agent_id for key share nowait;
	perform 1 from public.qorpera_provider_connections as connection
	where connection.profile_id = p_profile_id and connection.id in (
		select sponsor.provider_connection_id
		from public.qorpera_execution_sponsor_versions as sponsor
		join public.qorpera_wake_occurrences as wake on wake.sponsor_binding_id = sponsor.binding_id
			and wake.sponsor_version = sponsor.version
		where wake.id = any(p_wake_ids)
	)
	order by connection.id for update nowait;
	perform 1 from public.qorpera_provider_connection_versions as version
	where (version.connection_id, version.version) in (
		select sponsor.provider_connection_id, sponsor.provider_connection_version
		from public.qorpera_execution_sponsor_versions as sponsor
		join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
			and connection.profile_id = p_profile_id
		join public.qorpera_wake_occurrences as wake on wake.sponsor_binding_id = sponsor.binding_id
			and wake.sponsor_version = sponsor.version
		where wake.id = any(p_wake_ids)
	)
	order by version.connection_id, version.version for update nowait;
	for v_identity in
		select distinct coalesce(capsule.compute_identity_id, computer.compute_identity_id) as identity_id
		from public.qorpera_wake_occurrences as wake
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = wake.sponsor_binding_id
			and sponsor.version = wake.sponsor_version
		join public.qorpera_provider_connection_versions as version on version.connection_id = sponsor.provider_connection_id
			and version.version = sponsor.provider_connection_version
		left join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
			and capsule.status = 'active'
		left join public.qorpera_logical_computers as computer on computer.id = wake.logical_computer_id
		where wake.id = any(p_wake_ids)
			and coalesce(capsule.compute_identity_id, computer.compute_identity_id) is not null
		order by 1
	loop
		if not public.qorpera_try_lock_execution_identity(p_profile_id, v_identity) then
			v_unavailable := v_unavailable || v_identity;
		end if;
	end loop;

	for v_wake in
		select * from public.qorpera_wake_occurrences as wake
		where wake.id = any(p_wake_ids)
			and wake.profile_id = p_profile_id
			and wake.environment_id = p_environment_id
			and wake.session_id = p_session_id
			and wake.wake_kind = 'room'
			and wake.status = 'queued'
			and wake.not_before <= v_now
		order by wake.id
	loop
		begin
			if public.qorpera_sponsor_waits_for_usage_limit(v_wake.sponsor_binding_id, v_wake.sponsor_version) then
				continue;
			end if;
			if exists (
				select 1 from public.qorpera_execution_runs as run
				join public.qorpera_runner_jobs as job on job.id = run.job_id
				where run.session_id = v_wake.session_id
					and run.source_kind in ('session_turn', 'wake', 'room_delivery')
					and job.status in ('queued', 'leased')
					and (v_session.staff_agent_id is not null or run.staff_agent_id = v_wake.staff_agent_id)
			) then
				continue;
			end if;
			if not public.qorpera_wake_authorized(v_wake) then
				continue;
			end if;
			if not exists (
				select 1 from public.qorpera_execution_sponsor_bindings as binding
				join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
					and sponsor.version = v_wake.sponsor_version
				join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
				where binding.id = v_wake.sponsor_binding_id
					and binding.profile_id = p_profile_id
					and binding.status = 'active'
					and connection.profile_id = p_profile_id
					and connection.status = 'active'
			) then
				continue;
			end if;
			if v_wake.logical_computer_id is not null and not exists (
				select 1 from public.qorpera_logical_computers
				where id = v_wake.logical_computer_id and profile_id = p_profile_id and status = 'active'
					and capabilities ? 'agent_turn'
			) then
				continue;
			end if;
			select capsule.compute_identity_id, version.authentication_mode into v_compute_id, v_mode
			from public.qorpera_execution_sponsor_versions as sponsor
			join public.qorpera_provider_connection_versions as version on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			left join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
				and capsule.status = 'active'
			where sponsor.binding_id = v_wake.sponsor_binding_id and sponsor.version = v_wake.sponsor_version;
			v_worker_class := 'managed_sandbox';
			if v_wake.logical_computer_id is not null then
				select computer_class into v_worker_class from public.qorpera_logical_computers
				where id = v_wake.logical_computer_id and (v_compute_id is null or compute_identity_id = v_compute_id);
				if v_compute_id is null then
					select compute_identity_id into v_compute_id from public.qorpera_logical_computers
					where id = v_wake.logical_computer_id;
				end if;
			end if;
			if (v_mode = 'native_subscription' and v_compute_id is null) or v_worker_class is null
				or v_compute_id = any(v_unavailable) then
				continue;
			end if;
			v_payload := jsonb_build_object('schema', 'qorpera.wake-run/v1', 'occurrenceId', v_wake.id);
			insert into public.qorpera_runner_jobs(profile_id, environment_id, session_id, client_job_id, required_capability,
				job_type, payload, created_by_user_id)
			values (p_profile_id, p_environment_id, v_wake.session_id, extensions.gen_random_uuid(), 'agent_turn', 'agent_turn',
				v_payload, v_wake.requested_by_user_id)
			returning * into v_job;
			insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
				company_seq, staff_agent_id, staff_version, input_ids, sponsor_binding_id, sponsor_version, required_capability,
				job_type, payload_sha256, publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
				compute_identity_id, worker_class, transcript_start_sequence, created_by_user_id)
			values (v_job.client_job_id, p_profile_id, p_environment_id, 'room_delivery', v_wake.id, v_wake.session_id, v_job.id,
				v_seq, v_wake.staff_agent_id,
				(select staff.version from public.qorpera_profile_staff as staff
					where staff.profile_id = p_profile_id and staff.staff_agent_id = v_wake.staff_agent_id),
				'{}'::uuid[], v_wake.sponsor_binding_id, v_wake.sponsor_version, 'agent_turn', 'agent_turn',
				encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex'),
				'automatic', null, '{}'::uuid[], v_wake.logical_computer_id, v_compute_id, v_worker_class,
				(select coalesce(max(event.sequence), 0) from public.qorpera_session_events as event
					where event.session_id = v_wake.session_id),
				v_wake.requested_by_user_id)
			returning * into v_run;
			update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
			if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
				raise exception 'Execution sponsor authority or quota is unavailable' using errcode = 'QFM01';
			end if;
			update public.qorpera_wake_occurrences set status = 'materialized', run_id = v_run.id, blocked_reason = null
			where id = v_wake.id;
			if current_setting('qorpera.folder_wake_admission', true) is distinct from p_profile_id::text then
				perform public.qorpera_folder_admit_wakes(p_profile_id);
			end if;
			insert into public.qorpera_execution_run_events(run_id, event_type) values (v_run.id, 'queued');
			v_materialized := v_materialized + 1;
		exception when others then
			-- WHY: Roll back only this wake's inline attempt so the queued wake stays intact for the orchestrator materializer.
			null;
		end;
	end loop;
	perform set_config('lock_timeout', v_lock_timeout, true);
	return v_materialized;
end $$;

revoke all on function public.qorpera_folder_materialize_room_wakes_inline(uuid, uuid, uuid, uuid[])
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.irpm_patch(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930906000 anchor differs in %: %', p_function, left(p_old, 80);
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.irpm_patch(
	'public.qorpera_folder_post_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure,
	$old$			v_ids := array_append(v_ids,v_id);
		end loop;
	end if;
	return jsonb_build_object('schema','qorpera.company-room-post/v1','roomId',v_room.id,'sessionId',v_room.session_id,$old$,
	$new$			v_ids := array_append(v_ids,v_id);
		end loop;
		-- WHY: Materialize newly inserted room wakes inline under a fail-open subtransaction so posting lands a ready runner job in one round-trip.
		if cardinality(v_ids) > 0 then
			begin
				perform public.qorpera_folder_materialize_room_wakes_inline(
					v_room.profile_id, v_room.environment_id, v_room.session_id, v_ids);
			exception when others then
				null;
			end;
		end if;
	end if;
	return jsonb_build_object('schema','qorpera.company-room-post/v1','roomId',v_room.id,'sessionId',v_room.session_id,$new$
);

drop function pg_temp.irpm_patch(regprocedure, text, text);
