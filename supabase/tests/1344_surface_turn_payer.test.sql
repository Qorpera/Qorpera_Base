-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.stp_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_turn_payer: %', p_message;
	end if;
end $$;

create function pg_temp.stp_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.stp_payer(p_binding uuid)
returns uuid language sql as $$
	select created_by_user_id from public.qorpera_execution_sponsor_bindings where id = p_binding
$$;

create function pg_temp.stp_turn(p_session uuid)
returns public.qorpera_wake_occurrences language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
	v_wake public.qorpera_wake_occurrences;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = p_session;
	perform set_config('qorpera_test.claimed_sponsor', coalesce((
		select elem -> 'sponsor' ->> 'sponsorBindingId'
		from jsonb_array_elements(v_claimed -> 'sessions') elem
		where (elem ->> 'sessionId')::uuid = p_session
	), ''), true);
	v_enq := public.qorpera_surface_enqueue_session_run(p_session, v_lease);
	reset role;
	if v_enq ->> 'status' <> 'enqueued' then
		raise exception 'surface_turn_payer: enqueue failed: %', v_enq;
	end if;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	return v_wake;
end $$;

create function pg_temp.stp_settle(p_session uuid, p_wake uuid)
returns void language plpgsql as $$
begin
	update public.qorpera_wake_occurrences
	set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'turn settled by the test'
	where id = p_wake and status = 'queued';
	update public.qorpera_surface_sessions
	set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null, updated_at = clock_timestamp()
	where id = p_session;
end $$;

create function pg_temp.stp_materialize(p_profile uuid)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, 16);
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_dee constant uuid := '13440000-0000-4000-8000-000000000004';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_surface uuid;
	v_member_session uuid;
	v_agent_session uuid;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_errcode text;
	v_errmsg text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	-- WHY: Exercise the pre-v284 wake-based surface session path tested by this suite.
	update public.qorpera_active_runtime_bundle a
	set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256
	from public.qorpera_runtime_bundles b
	where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = 283;

	perform pg_temp.stp_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_company, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true) ->> 'id')::uuid;
	v_member_session := (public.qorpera_start_surface_session(v_surface, 'Warm the accent', 'Accent') ->> 'id')::uuid;
	reset role;

	v_wake := pg_temp.stp_turn(v_member_session);
	perform pg_temp.stp_assert(
		v_wake.requested_by_user_id = v_anna and pg_temp.stp_payer(v_wake.sponsor_binding_id) = v_anna
			and (v_wake.payload ->> 'memberInitiated')::boolean,
		'the starter''s first turn is requested by and paid with the starter''s own login'
	);
	perform pg_temp.stp_settle(v_member_session, v_wake.id);

	perform pg_temp.stp_as(v_bo);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_member_session, 'Make it a little darker', true);
	reset role;
	select * into strict v_session from public.qorpera_surface_sessions where id = v_member_session;
	perform pg_temp.stp_assert(
		v_session.turn_requested_by_user_id = v_bo and v_session.created_by_user_id = v_anna and v_session.state = 'queued',
		'a teammate''s reply records the teammate as the next turn''s requester and keeps the starter'
	);

	v_wake := pg_temp.stp_turn(v_member_session);
	perform pg_temp.stp_assert(
		pg_temp.stp_payer(nullif(current_setting('qorpera_test.claimed_sponsor'), '')::uuid) = v_bo,
		'the sessions lane claim names the replier''s sponsor'
	);
	perform pg_temp.stp_assert(
		v_wake.requested_by_user_id = v_bo and pg_temp.stp_payer(v_wake.sponsor_binding_id) = v_bo
			and (v_wake.payload ->> 'memberInitiated')::boolean,
		'the teammate''s turn is requested by and paid with the teammate''s own login, never the starter''s'
	);

	set local session_replication_role = replica;
	update public.qorpera_execution_sponsor_versions
	set allow_autonomous = false
	where binding_id in (select id from public.qorpera_execution_sponsor_bindings where profile_id = v_company);
	set local session_replication_role = origin;

	perform pg_temp.stp_materialize(v_company);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.stp_assert(
		v_wake.status = 'materialized' and v_wake.run_id is not null,
		'the teammate''s reply runs as a member turn without unattended permission'
	);
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.stp_assert(
		v_run.requested_by_user_id = v_bo
			and public.qorpera_run_autonomous_authority(v_run)
			and not public.qorpera_run_autonomous_authority(
				jsonb_populate_record(v_run, jsonb_build_object('requested_by_user_id', v_anna))
			),
		'the member-turn authority belongs to the replier''s run only'
	);

	update public.qorpera_surface_sessions set turn_requested_by_user_id = v_anna where id = v_member_session;
	perform pg_temp.stp_assert(
		public.qorpera_run_autonomous_authority(v_run),
		'a later reply on the session does not take authority from a run already made for the earlier replier'
	);
	update public.qorpera_surface_sessions set turn_requested_by_user_id = v_bo where id = v_member_session;
	perform pg_temp.stp_settle(v_member_session, v_wake.id);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_agent_session := (public.qorpera_native_surface_start_session(
		v_company, v_surface, 'Refresh the palette notes', 'Palette', 'cofounder', 'Co-Founder'
	) ->> 'sessionId')::uuid;
	reset role;
	v_wake := pg_temp.stp_turn(v_agent_session);
	perform pg_temp.stp_assert(
		not (v_wake.payload ->> 'memberInitiated')::boolean,
		'an agent-started session''s own turn is not a member turn'
	);
	perform pg_temp.stp_settle(v_agent_session, v_wake.id);

	perform pg_temp.stp_as(v_bo);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_agent_session, 'Keep the old green', true);
	reset role;
	v_wake := pg_temp.stp_turn(v_agent_session);
	perform pg_temp.stp_assert(
		v_wake.requested_by_user_id = v_bo and pg_temp.stp_payer(v_wake.sponsor_binding_id) = v_bo
			and (v_wake.payload ->> 'memberInitiated')::boolean,
		'a member''s reply in an agent-started session is that member''s own turn'
	);
	perform pg_temp.stp_materialize(v_company);
	perform pg_temp.stp_assert(
		(select status from public.qorpera_wake_occurrences where id = v_wake.id) = 'materialized',
		'the member reply in an agent-started session runs without unattended permission'
	);

	select * into strict v_session from public.qorpera_surface_sessions where id = v_member_session;
	perform pg_temp.stp_assert(
		public.qorpera_surface_coding_member_initiated(v_session, v_bo)
			and not public.qorpera_surface_coding_member_initiated(v_session, v_anna)
			and not public.qorpera_surface_coding_member_initiated(v_session, null),
		'a coding turn is a member turn only for the member who asked for it'
	);

	insert into auth.users(id, email) values (v_dee, 'dee-stp@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_dee, 'dee-stp@example.test', 'Dee', 'contributor');
	v_errcode := null;
	perform pg_temp.stp_as(v_dee);
	set local role authenticated;
	begin
		perform public.qorpera_reply_surface_session(v_member_session, 'Can it be blue?', true);
	exception when others then
		v_errcode := sqlstate;
		v_errmsg := sqlerrm;
	end;
	reset role;
	perform pg_temp.stp_assert(
		v_errcode = '42501' and v_errmsg like 'Connect a model account%',
		'a member without a usable login is told to connect one and never borrows another member''s'
	);
	perform pg_temp.stp_assert(
		(select turn_requested_by_user_id from public.qorpera_surface_sessions where id = v_member_session) = v_bo
			and not exists (
				select 1 from public.qorpera_surface_session_messages
				where session_id = v_member_session and author_user_id = v_dee
			),
		'a refused reply leaves the session and its messages unchanged'
	);

	perform pg_temp.stp_assert(
		not has_function_privilege('authenticated', 'public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)', 'execute')
			and not has_function_privilege('anon', 'public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions)', 'execute'),
		'the turn helpers are not callable from the API'
	);
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_surface uuid;
	v_session uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
	v_worker_id uuid;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding_claim jsonb;
	v_begin jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_errcode text;
begin
	select environment_id into strict v_env from public.qorpera_company_cofounders where profile_id = v_company;
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env, 'exec-1344', true, array['codex', 'claude-code']);

	perform pg_temp.stp_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Build the landing page', 'Landing') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_session, v_lease);
	v_worker_id := (v_enq ->> 'workerId')::uuid;
	reset role;
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13440000-0000-4000-8000-0000000000d0', 'member', v_company, v_env, v_anna, 'exec-1344', repeat('7', 64), '{}');
	set local session_replication_role = origin;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1344', 60);
	if v_coding_claim is null then
		raise exception 'surface_turn_payer: no coding claim for the starter''s turn: %', v_enq;
	end if;
	perform public.qorpera_complete_coding_turn(
		p_worker_id => v_worker_id,
		p_lease_token => (v_coding_claim ->> 'leaseToken')::uuid,
		p_outcome => 'succeeded',
		p_summary => 'Staged the landing page.',
		p_artifacts => jsonb_build_array(jsonb_build_object(
			'kind', 'staged', 'branch', 'qorpera/coding/' || v_worker_id::text,
			'baseSha', repeat('a', 40), 'headSha', repeat('c', 40)
		))
	);
	reset role;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	perform pg_temp.stp_assert(
		v_worker.owner_user_id = v_anna and pg_temp.stp_payer(v_worker.owner_sponsor_binding_id) = v_anna
			and (select state from public.qorpera_surface_sessions where id = v_session) = 'ready',
		'the starter''s coding turn runs on the starter''s login: ' || coalesce(v_enq::text, 'null')
	);

	update public.qorpera_coding_sessions set harness = 'claude-code' where worker_id = v_worker_id;
	v_errcode := null;
	perform pg_temp.stp_as(v_bo);
	set local role authenticated;
	begin
		perform public.qorpera_reply_surface_session(v_session, 'Add pricing too', true);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.stp_assert(
		v_errcode = '42501'
			and (select state from public.qorpera_surface_sessions where id = v_session) = 'ready'
			and (select turn_requested_by_user_id from public.qorpera_surface_sessions where id = v_session) is null
			and (select state from public.qorpera_runtime_workers where id = v_worker_id) = 'succeeded',
		'a replier with no login for the session''s coding harness is refused before anything changes'
	);
	update public.qorpera_coding_sessions set harness = 'codex' where worker_id = v_worker_id;

	update public.qorpera_coding_executors set enabled = false where environment_id = v_env;
	v_errcode := null;
	perform pg_temp.stp_as(v_bo);
	set local role authenticated;
	begin
		perform public.qorpera_reply_surface_session(v_session, 'Add pricing too', true);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	reset role;
	perform pg_temp.stp_assert(
		v_errcode is null,
		'with coding switched off the reply is kept as before, not refused for a login: ' || coalesce(v_errcode, 'accepted')
	);
	update public.qorpera_coding_executors set enabled = true where environment_id = v_env;

	perform pg_temp.stp_as(v_bo);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_session, 'Add pricing too', true);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_session, v_lease);
	reset role;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	perform pg_temp.stp_assert(
		(v_enq ->> 'workerId')::uuid = v_worker_id
			and v_worker.owner_user_id = v_bo and v_worker.requested_by_user_id = v_bo
			and pg_temp.stp_payer(v_worker.owner_sponsor_binding_id) = v_bo
			and exists (
				select 1 from public.qorpera_coding_session_turns t
				where t.worker_id = v_worker_id and t.sequence = 2 and t.input_from = 'member'
			),
		'the teammate''s coding follow-up moves the worker''s owner, requester and payer to the teammate: ' || v_enq::text
	);

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13440000-0000-4000-8000-0000000000d1', 'member', v_company, v_env, v_bo, 'exec-1344', repeat('8', 64), '{}');
	update public.qorpera_execution_sponsor_versions
	set allow_autonomous = false
	where binding_id in (select id from public.qorpera_execution_sponsor_bindings where profile_id = v_company);
	update public.qorpera_provider_connection_versions
	set allow_autonomous = false
	where connection_id in (select id from public.qorpera_provider_connections where profile_id = v_company);
	set local session_replication_role = origin;

	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	perform pg_temp.stp_assert(
		public.qorpera_coding_session_login_state(v_worker) = 'ready',
		'the teammate''s coding turn is ready on the teammate''s login without unattended permission'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1344', 60);
	v_begin := public.qorpera_begin_coding_turn(v_worker_id, (v_coding_claim ->> 'leaseToken')::uuid, '{}');
	reset role;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.stp_assert(
		v_wake.requested_by_user_id = v_bo and pg_temp.stp_payer(v_wake.sponsor_binding_id) = v_bo,
		'the teammate''s coding wake is requested by and paid with the teammate''s login'
	);
	perform pg_temp.stp_materialize(v_company);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.stp_assert(
		v_wake.status = 'materialized' and v_wake.run_id is not null,
		'the teammate''s coding wake runs as a member turn without unattended permission'
	);
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.stp_assert(
		public.qorpera_run_autonomous_authority(v_run)
			and not public.qorpera_run_autonomous_authority(
				jsonb_populate_record(v_run, jsonb_build_object('requested_by_user_id', v_anna))
			),
		'the coding run''s member-turn authority belongs to the teammate only'
	);
end $$;
