-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sds_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_discard_session: %', p_message;
	end if;
end $$;

create function pg_temp.sds_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sds_discard(p_user uuid, p_session uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.sds_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_discard_surface_session(p_session);
	reset role;
	return v_result;
end $$;

create function pg_temp.sds_refused(p_user uuid, p_session uuid, p_state text)
returns void language plpgsql as $$
begin
	perform pg_temp.sds_as(p_user);
	set local role authenticated;
	begin
		perform public.qorpera_discard_surface_session(p_session);
	exception when others then
		reset role;
		if sqlstate is distinct from p_state then
			raise exception 'surface_discard_session: expected %, got % (%)', p_state, sqlstate, sqlerrm;
		end if;
		return;
	end;
	reset role;
	raise exception 'surface_discard_session: expected % for %', p_state, p_session;
end $$;

create function pg_temp.sds_turn(p_session uuid)
returns jsonb language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = p_session;
	v_enq := public.qorpera_surface_enqueue_session_run(p_session, v_lease);
	reset role;
	if v_enq ->> 'status' <> 'enqueued' then
		raise exception 'surface_discard_session: enqueue failed: %', v_enq;
	end if;
	return v_enq;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_vic constant uuid := '13660000-0000-4000-8000-000000000003';
	v_out constant uuid := '13660000-0000-4000-8000-000000000004';
	v_other_owner constant uuid := '13660000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13660000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13660000-0000-4000-8000-000000000021';
	v_job constant uuid := '13660000-0000-4000-8000-000000000031';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_site uuid;
	v_note uuid;
	v_code_session uuid;
	v_note_session uuid;
	v_routine uuid;
	v_proposal uuid;
	v_landed uuid;
	v_landing uuid;
	v_variant uuid;
	v_untouched uuid;
	v_staged uuid;
	v_worker uuid;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_enq jsonb;
	v_result jsonb;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	-- WHY: Exercise the pre-v284 wake-based surface session path tested by this suite.
	update public.qorpera_active_runtime_bundle a
	set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256
	from public.qorpera_runtime_bundles b
	where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = 283;
	insert into auth.users(id, email) values
		(v_vic, 'vic-sds@example.test'), (v_out, 'out-sds@example.test'), (v_other_owner, 'owner-sds-b@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_vic, 'vic-sds@example.test', 'Vic', 'viewer');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Executor Template Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Executor Template Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1366', true, array['codex', 'claude-code']);

	perform pg_temp.sds_assert(
		has_function_privilege('authenticated', 'public.qorpera_discard_surface_session(uuid)', 'EXECUTE')
			and not has_function_privilege('anon', 'public.qorpera_discard_surface_session(uuid)', 'EXECUTE'),
		'only a signed-in member reaches the call'
	);

	perform pg_temp.sds_as(v_anna);
	set local role authenticated;
	v_site := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_note := (public.qorpera_create_surface(
		v_company, 'Launch Note', 'launch-note', 'studio', 'report', 'figure:book', null, 'surfaces/launch-note', null, false
	) ->> 'id')::uuid;
	v_code_session := (public.qorpera_start_surface_session(v_site, 'Build the landing page', 'Landing') ->> 'id')::uuid;
	reset role;
	v_enq := pg_temp.sds_turn(v_code_session);
	v_worker := (v_enq ->> 'workerId')::uuid;
	perform pg_temp.sds_assert(
		(select state from public.qorpera_runtime_workers where id = v_worker) = 'active',
		'the website session works on a coding worker: ' || v_enq::text
	);

	perform pg_temp.sds_as(v_anna);
	set local role authenticated;
	v_note_session := (public.qorpera_start_surface_session(v_note, 'Write the launch note', 'Note') ->> 'id')::uuid;
	reset role;
	v_enq := pg_temp.sds_turn(v_note_session);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.sds_assert(public.qorpera_folder_wake_authorized(v_wake), 'the studio session works on a wake');

	perform pg_temp.sds_as(v_anna);
	set local role authenticated;
	v_routine := (public.qorpera_start_surface_session(v_note, 'Weekly pulse', 'Co-Founder Pulse') ->> 'id')::uuid;
	v_proposal := (public.qorpera_start_surface_session(v_note, 'Add the wordmark', 'Wordmark') ->> 'id')::uuid;
	v_landed := (public.qorpera_start_surface_session(v_note, 'Fix a typo', 'Typo') ->> 'id')::uuid;
	v_landing := (public.qorpera_start_surface_session(v_note, 'Bigger title', 'Title') ->> 'id')::uuid;
	v_untouched := (public.qorpera_start_surface_session(v_note, 'Leave me be', 'Stay') ->> 'id')::uuid;
	v_variant := (public.qorpera_start_surface_session(
		v_site, 'Try two looks', 'Looks', 'member', null, null, 2, 'Two looks'
	) ->> 'id')::uuid;
	reset role;
	update public.qorpera_surface_sessions
	set state = 'ready', has_active_chat = true, lease_token = null, lease_expires_at = null
	where id in (v_routine, v_proposal, v_landed, v_landing, v_untouched);
	update public.qorpera_surface_sessions
	set state = 'needs_input', question = '{"text":"Serif or sans?"}'::jsonb
	where id = v_proposal;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, status)
	values
		(v_company, v_note, v_proposal, 1, 'Wordmark in the header', 'staged'),
		(v_company, v_note, v_proposal, 2, 'Wordmark in the footer', 'conflicted'),
		(v_company, v_note, v_landed, 1, 'Typo fixed', 'merged'),
		(v_company, v_note, v_landed, 2, 'Second typo', 'staged'),
		(v_company, v_note, v_landing, 1, 'Bigger title', 'merging'),
		(v_company, v_note, v_untouched, 1, 'Kept change', 'staged');
	select id into strict v_staged from public.qorpera_surface_changes where session_id = v_proposal and seq = 1;
	insert into public.qorpera_member_surface_state(user_id, surface_id, toggled_change_ids, active_route)
	values (v_anna, v_note, array[
		v_staged,
		(select id from public.qorpera_surface_changes where session_id = v_untouched)
	], '/')
	on conflict (user_id, surface_id) do update set toggled_change_ids = excluded.toggled_change_ids;

	perform pg_temp.sds_refused(v_vic, v_routine, '42501');
	perform pg_temp.sds_refused(v_out, v_routine, '42501');
	perform pg_temp.sds_refused(v_anna, '13660000-0000-4000-8000-0000000000ff', 'P0002');
	perform pg_temp.sds_refused(v_anna, v_variant, '55000');
	perform pg_temp.sds_refused(v_anna, v_landing, '55000');
	perform pg_temp.sds_assert(
		(select state from public.qorpera_surface_sessions where id = v_routine) = 'ready'
			and (select state from public.qorpera_surface_sessions where id = v_variant) <> 'discarded'
			and (select status from public.qorpera_surface_changes where session_id = v_landing) = 'merging',
		'a refused call changes nothing'
	);

	v_result := pg_temp.sds_discard(v_anna, v_routine);
	perform pg_temp.sds_assert(
		v_result ->> 'id' = v_routine::text and v_result ->> 'state' = 'discarded',
		'a finished routine with no changes is discarded: ' || v_result::text
	);
	perform pg_temp.sds_assert(
		(select not s.has_active_chat and s.closed_at is not null from public.qorpera_surface_sessions s where s.id = v_routine),
		'its chat is closed'
	);
	perform pg_temp.sds_as(v_anna);
	set local role authenticated;
	v_result := public.qorpera_get_surface_workspace(v_note);
	reset role;
	perform pg_temp.sds_assert(
		not exists (select 1 from jsonb_array_elements(v_result -> 'activeSessions') e where e ->> 'id' = v_routine::text)
			and exists (select 1 from jsonb_array_elements(v_result -> 'recentHistory') e where e ->> 'id' = v_routine::text),
		'it leaves the Changes list for history'
	);

	v_result := pg_temp.sds_discard(v_anna, v_proposal);
	perform pg_temp.sds_assert(
		v_result ->> 'state' = 'discarded'
			and (select array_agg(c.status order by c.seq) from public.qorpera_surface_changes c where c.session_id = v_proposal)
				= array['discarded', 'discarded']
			and (select s.question is null from public.qorpera_surface_sessions s where s.id = v_proposal),
		'a session waiting on a question drops its staged and conflicted changes and its question'
	);
	perform pg_temp.sds_assert(
		(select toggled_change_ids from public.qorpera_member_surface_state where user_id = v_anna and surface_id = v_note)
			= array[(select id from public.qorpera_surface_changes where session_id = v_untouched)],
		'its change leaves the preview, another session''s stays'
	);

	v_result := pg_temp.sds_discard(v_anna, v_landed);
	perform pg_temp.sds_assert(
		v_result ->> 'state' = 'completed'
			and (select array_agg(c.status order by c.seq) from public.qorpera_surface_changes c where c.session_id = v_landed)
				= array['merged', 'discarded'],
		'a session with a landed change completes, its open change is dropped and the landed one stays'
	);

	insert into public.qorpera_surface_jobs(id, profile_id, surface_id, session_id, kind, status)
	values (v_job, v_company, v_note, v_untouched, 'land_change', 'queued');
	perform pg_temp.sds_refused(v_anna, v_untouched, '55000');
	delete from public.qorpera_surface_jobs where id = v_job;

	v_result := pg_temp.sds_discard(v_anna, v_code_session);
	perform pg_temp.sds_assert(
		v_result ->> 'state' = 'discarded'
			and (select s.lease_token is null and s.lease_expires_at is null and s.wake_id is null
				from public.qorpera_surface_sessions s where s.id = v_code_session)
			and (select state from public.qorpera_runtime_workers where id = v_worker) = 'cancelled'
			and (select phase from public.qorpera_coding_sessions where worker_id = v_worker) = 'cancelled',
		'a working website session stops: its coding worker is cancelled and it holds no lease'
	);

	v_result := pg_temp.sds_discard(v_anna, v_note_session);
	perform pg_temp.sds_assert(
		v_result ->> 'state' = 'discarded' and not public.qorpera_folder_wake_authorized(v_wake),
		'a working studio session stops: its wake may no longer run'
	);

	perform pg_temp.sds_assert(
		pg_temp.sds_discard(v_anna, v_note_session) ->> 'state' = 'discarded'
			and pg_temp.sds_discard(v_anna, v_landed) ->> 'state' = 'completed',
		'a second call answers the same'
	);
	perform pg_temp.sds_assert(
		(select state from public.qorpera_surface_sessions where id = v_untouched) = 'ready'
			and (select status from public.qorpera_surface_changes where session_id = v_untouched) = 'staged',
		'other sessions are left alone'
	);
end $$;
