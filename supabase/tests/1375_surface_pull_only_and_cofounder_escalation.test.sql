-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spe_assert(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
	if not coalesce(p_ok, false) then
		raise exception 'surface_pull_only_and_cofounder_escalation: %', p_msg;
	end if;
end $$;

create function pg_temp.spe_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_contrib constant uuid := '13750000-0000-4000-8000-000000000002';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_cofounder uuid;
	v_surface uuid;
	v_sess_input uuid;
	v_sess_fail uuid;
	v_sess_merge uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_change_1 uuid;
	v_change_2 uuid;
	v_job_id uuid;
	v_job_lease uuid;
	v_esc_input public.qorpera_surface_escalations%rowtype;
	v_esc_fail public.qorpera_surface_escalations%rowtype;
	v_esc_conflict public.qorpera_surface_escalations%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_policy jsonb;
	v_summary jsonb;
	v_steered jsonb;
	v_obs jsonb;
	v_run_id uuid;
begin
	perform pg_temp.spe_assert(
		not has_table_privilege('authenticated', 'public.qorpera_surface_escalations', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_escalations', 'SELECT')
		and not has_table_privilege('anon', 'public.qorpera_surface_escalations', 'SELECT'),
		'qorpera_surface_escalations is private to security definer functions'
	);
	perform pg_temp.spe_assert(
		has_function_privilege('service_role', 'public.qorpera_native_surface_steer_session(uuid,uuid,text,text)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_native_surface_steer_session(uuid,uuid,text,text)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_native_surface_steer_session(uuid,uuid,text,text)', 'EXECUTE'),
		'qorpera_native_surface_steer_session is service_role only'
	);
	perform pg_temp.spe_assert(
		exists (
			select 1 from public.qorpera_native_host_calls
			where name = 'qorpera_native_surface_steer_session' and scope = 'profile'
		),
		'qorpera_native_surface_steer_session is registered in qorpera_native_host_calls'
	);

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id, staff_agent_id into strict v_env, v_cofounder
	from public.qorpera_company_cofounders where profile_id = v_company;

	insert into auth.users(id, email) values (v_contrib, 'contrib-1375@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_contrib, 'contrib-1375@example.test', 'Bo Contrib', 'contributor');

	perform pg_temp.spe_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#2563eb', null, null, false
	) ->> 'id')::uuid;
	v_sess_input := (public.qorpera_start_surface_session(v_surface, 'Refresh pricing', 'Refresh pricing copy') ->> 'id')::uuid;
	v_sess_fail := (public.qorpera_start_surface_session(v_surface, 'Wire webhook', 'Wire billing webhook') ->> 'id')::uuid;
	v_sess_merge := (public.qorpera_start_surface_session(v_surface, 'Update hero', 'Update hero banner') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_sess_input;

	perform public.qorpera_surface_complete_session_turn(
		v_sess_input,
		'needs_input',
		'Which tier should be highlighted first?',
		jsonb_build_object('text', 'Which pricing tier should be highlighted first?'),
		'{}'::text[],
		null,
		v_lease
	);
	reset role;

	select * into strict v_esc_input
	from public.qorpera_surface_escalations
	where session_id = v_sess_input
	order by created_at desc limit 1;
	select * into strict v_wake
	from public.qorpera_wake_occurrences
	where id = v_esc_input.wake_id;
	perform pg_temp.spe_assert(
		v_esc_input.reason = 'needs_input'
		and v_esc_input.wake_id is not null
		and v_wake.wake_kind = 'agent'
		and v_wake.source_kind = 'surface-escalation'
		and v_wake.staff_agent_id = v_cofounder
		and v_wake.payload ->> 'schema' = 'qorpera.surface-escalation-wake/v1'
		and (v_wake.payload ->> 'surfaceSessionId')::uuid = v_sess_input
		and (v_wake.payload ->> 'surfaceId')::uuid = v_surface
		and v_wake.payload ->> 'surfaceSlug' = 'website'
		and v_wake.payload ->> 'reason' = 'needs_input'
		and v_wake.payload -> 'question' ->> 'text' = 'Which pricing tier should be highlighted first?',
		'needs_input emits surface-escalation wake to Co-Founder: ' || to_jsonb(v_wake)::text
	);
	perform pg_temp.spe_assert(
		public.qorpera_folder_wake_authorized(v_wake),
		'surface-escalation wake passes qorpera_folder_wake_authorized'
	);
	v_policy := public.qorpera_runtime_wake_policy_internal(v_wake.id);
	perform pg_temp.spe_assert(
		v_policy ->> 'schema' = 'qorpera.wake-policy/v1'
		and v_policy ->> 'initial' = 'required'
		and v_policy ->> 'final' = 'required'
		and (v_policy ->> 'silenceAllowed')::boolean is false,
		'surface-escalation wake uses continuation reporting policy: ' || v_policy::text
	);

	update public.qorpera_surface_sessions set retry_count = 3 where id = v_sess_fail;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_sess_fail;
	perform public.qorpera_surface_complete_session_turn(
		v_sess_fail,
		'failed',
		'Webhook endpoint returned 500 repeatedly.',
		null,
		'{}'::text[],
		'Webhook build failed',
		v_lease
	);
	reset role;

	select * into strict v_esc_fail
	from public.qorpera_surface_escalations
	where session_id = v_sess_fail
	order by created_at desc limit 1;
	perform pg_temp.spe_assert(
		v_esc_fail.reason = 'failed' and v_esc_fail.wake_id is not null,
		'terminal failed surface turn emits failed escalation wake to Co-Founder'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_sess_merge;
	v_change_1 := (public.qorpera_native_surface_record_change(
		v_company, v_sess_merge, 'Hero v1', 'Update hero copy', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false, v_lease
	) ->> 'changeId')::uuid;
	v_change_2 := (public.qorpera_native_surface_record_change(
		v_company, v_sess_merge, 'Hero v2', 'Update hero layout', 'git_range',
		repeat('2', 40), repeat('3', 40), array[v_change_1], array['src/hero.tsx'], null, null, false, v_lease
	) ->> 'changeId')::uuid;
	reset role;

	perform pg_temp.spe_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_change_2, false);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (m ->> 'jobId')::uuid, (m ->> 'leaseToken')::uuid
	into strict v_job_id, v_job_lease
	from jsonb_array_elements(v_claimed -> 'merges') m
	where (m ->> 'surfaceId')::uuid = v_surface
	limit 1;
	reset role;
	update public.qorpera_surface_jobs
	set payload = payload || jsonb_build_object('reconciliationId', extensions.gen_random_uuid())
	where id = v_job_id;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_job_id, 'conflicted', repeat('4', 40), null, v_change_2, array['src/hero.tsx'], 'Conflict in hero.tsx', null, v_job_lease
	);
	reset role;

	select * into strict v_esc_conflict
	from public.qorpera_surface_escalations
	where session_id = v_sess_merge
	order by created_at desc limit 1;
	perform pg_temp.spe_assert(
		v_esc_conflict.reason = 'conflict'
		and v_esc_conflict.wake_id is not null
		and v_esc_conflict.summary like '%src/hero.tsx%',
		'conflicted merge emits conflict escalation wake to Co-Founder'
	);

	update public.qorpera_surfaces
	set unpublished_change_count = 1, live_head_sha = repeat('5', 40), published_head_sha = repeat('1', 40),
		publish_status = 'idle', auto_publish = false
	where id = v_surface;
	perform pg_temp.spe_as(v_contrib);
	set local role authenticated;
	perform public.qorpera_ask_surface_publish(v_surface, v_owner);
	reset role;

	select public.qorpera_surface_summary_json(s) into strict v_summary
	from public.qorpera_surfaces s where s.id = v_surface;
	perform pg_temp.spe_assert(
		(v_summary ->> 'needsAttentionCount')::integer = 0
		and v_summary -> 'publishAsk' is not null
		and (v_summary -> 'publishAsk' ->> 'askedByUserId')::uuid = v_contrib,
		'summary sets needsAttentionCount to 0 while keeping teammate publishAsk: ' || v_summary::text
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_steered := public.qorpera_native_surface_steer_session(
		v_company, v_sess_input, 'Highlight the Pro tier first.', 'Co-Founder'
	);
	reset role;
	perform pg_temp.spe_assert(
		v_steered ->> 'state' = 'queued'
		and (v_steered -> 'question') = 'null'::jsonb
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_sess_input
				and m.author_kind = 'member'
				and m.author_user_id is null
				and m.body = 'Highlight the Pro tier first.'
		),
		'native_surface_steer_session appends unattributed member guidance, clears question, and re-queues session: ' || v_steered::text
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_folder_materialize_company(v_company, 16);
	reset role;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'completed', lease_token_sha256 = null, lease_expires_at = null,
		result = '{}'::jsonb, finished_at = clock_timestamp() - interval '1 minute'
	where profile_id = v_company and status in ('queued', 'leased');
	update public.qorpera_wake_occurrences
	set status = 'completed', finished_at = clock_timestamp() - interval '1 minute'
	where profile_id = v_company and status = 'materialized' and id <> v_esc_input.wake_id;
	set local session_replication_role = origin;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_obs := public.qorpera_folder_materialize_company(v_company, 16);
	reset role;
	select * into v_wake
	from public.qorpera_wake_occurrences
	where id in (v_esc_input.wake_id, v_esc_fail.wake_id, v_esc_conflict.wake_id)
		and status = 'materialized'
		and run_id is not null
	limit 1;
	v_run_id := v_wake.run_id;
	perform pg_temp.spe_assert(
		v_run_id is not null and v_wake.status = 'materialized',
		'surface-escalation wake materializes into a Co-Founder run: mat=' || coalesce(v_obs::text, 'null')
			|| ' wakes=' || coalesce((select jsonb_agg(jsonb_build_object('id', id, 'status', status, 'run_id', run_id, 'blocked_reason', blocked_reason))
				from public.qorpera_wake_occurrences where profile_id = v_company)::text, 'null')
	);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_obs := public.qorpera_record_runtime_observation(v_run_id, jsonb_build_object(
		'schema', 'qorpera.runtime-observation/v1',
		'attemptId', extensions.gen_random_uuid(),
		'parentAttemptId', null,
		'assignmentId', null,
		'phase', 'start',
		'operation', 'steer_surface_session',
		'logicalOperationSha256', repeat('9', 64),
		'observedAt', '2026-11-24T10:00:00.000Z',
		'durationMs', null,
		'status', 'started',
		'errorCategory', null,
		'receiptId', null,
		'readId', null,
		'inputBytes', null,
		'outputBytes', null,
		'inputTokens', null,
		'outputTokens', null,
		'cachedInputTokens', null,
		'cacheWriteInputTokens', null,
		'reasoningOutputTokens', null,
		'totalTokens', null
	));
	reset role;
	perform pg_temp.spe_assert(
		v_obs ->> 'schema' = 'qorpera.runtime-observation-receipt/v1',
		'runtime observation vocabulary accepts steer_surface_session: ' || v_obs::text
	);
end $$;

rollback;
