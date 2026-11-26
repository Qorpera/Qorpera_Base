-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.cnc_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'company_name_change: %', p_message;
	end if;
end $$;

create function pg_temp.cnc_stage_as(p_env uuid, p_actor jsonb, p_text text)
returns jsonb language plpgsql as $$
declare
	v_manifest text := pg_temp.manifest_v2(p_text);
	v_open jsonb;
	v_object jsonb;
	v_seal jsonb;
begin
	perform pg_temp.as_service();
	v_open := public.qorpera_folder_open_upload(p_env, p_actor, v_manifest);
	for v_object in select c from jsonb_array_elements(v_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object(
			'sha256', encode(extensions.digest(convert_to(v_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(v_manifest, 'utf8'))
		) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(
				p_env, p_actor, (v_open ->> 'intentId')::uuid,
				v_object ->> 'sha256', (v_object ->> 'bytes')::bigint
			);
		end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload(p_env, p_actor, (v_open ->> 'intentId')::uuid);
	perform pg_temp.cnc_assert(v_seal ->> 'state' = 'sealed', 'stage_as failed: ' || v_seal::text);
	return v_seal -> 'file';
end $$;

create function pg_temp.cnc_commit_vision(p_env uuid, p_actor jsonb, p_key text, p_name text)
returns jsonb language plpgsql as $$
declare
	v_text text := E'# ' || p_name || E'\n\nUpdated vision.\n';
	v_expected uuid;
	v_res jsonb;
begin
	perform pg_temp.as_service();
	select version into v_expected
	from public.qorpera_folder_entries
	where environment_id = p_env and key_text = 'qorperaos/vision/vision.md';
	v_res := public.qorpera_folder_commit(
		p_env,
		p_actor,
		p_key,
		jsonb_build_array(
			jsonb_build_object(
				'op', 'write',
				'path', 'QorperaOS/vision/vision.md',
				'file', pg_temp.cnc_stage_as(p_env, p_actor, v_text),
				'expectedVersion', v_expected,
				'structured', jsonb_build_array(
					pg_temp.entry('QorperaOS/vision/vision.md', 'vision', v_text, jsonb_build_object('kind', 'vision', 'name', p_name))
				)
			)
		)
	);
	perform pg_temp.cnc_assert(v_res -> 'units' -> 0 ->> 'outcome' = 'saved', 'vision commit failed: ' || v_res::text);
	perform pg_temp.follow_ups(p_env);
	return v_res;
end $$;

create function pg_temp.cnc_enable_rename_bundle()
returns void language plpgsql as $$
declare
	v_active public.qorpera_runtime_bundles%rowtype;
	v_manifest jsonb;
	v_bundle public.qorpera_runtime_bundles%rowtype;
begin
	select b.* into strict v_active
	from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id
	where a.singleton;
	v_manifest := jsonb_set(
		v_active.manifest,
		'{implementation,packages/runtime/src/cloud-company-rename-wake.ts}',
		to_jsonb(repeat('e', 64))
	);
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle
	set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
end $$;

create function pg_temp.cnc_start_run(p_orchestrator uuid, p_run uuid)
returns jsonb language plpgsql as $$
declare
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
	v_lease jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_try integer;
begin
	perform pg_temp.as_service();
	for v_try in 1..16 loop
		v_claim := public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator, extensions.gen_random_uuid(), 120);
		exit when v_claim is null or v_claim #>> '{work,run_id}' = p_run::text;
	end loop;
	perform pg_temp.cnc_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'cnc-fixture');
	v_assignment := public.qorpera_assign_runner_job(
		p_orchestrator, (v_claim ->> 'claim_id')::uuid, (v_runner ->> 'runner_id')::uuid,
		extensions.gen_random_uuid(), repeat('3', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		(v_runner ->> 'runner_id')::uuid, repeat('2', 64), (v_assignment ->> 'assignment_id')::uuid,
		(v_claim #>> '{work,job_id}')::uuid, repeat('3', 64)
	);
	v_lease := public.qorpera_acquire_native_provider_connection_lease(
		p_run, (v_runner ->> 'runner_id')::uuid, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, repeat('3', 64), 120
	);
	select * into strict v_run from public.qorpera_execution_runs where id = p_run;
	return jsonb_build_object(
		'leaseId', v_lease ->> 'lease_id',
		'runId', p_run,
		'jobId', v_claim #>> '{work,job_id}',
		'runnerId', v_runner ->> 'runner_id',
		'assignmentId', v_assignment ->> 'assignment_id',
		'credentialCapsuleId', v_lease ->> 'credential_capsule_id',
		'computeIdentityId', v_lease ->> 'compute_identity_id',
		'provider', v_run.model_provider,
		'nativeHarness', case when v_run.model_provider = 'anthropic' then 'claude-code' else 'codex-cli' end,
		'model', v_run.model_id
	);
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid := (v_claim ->> 'environmentId')::uuid;
	v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_orch constant uuid := '13970000-0000-4000-8000-000000000097';
	v_owner_actor jsonb := jsonb_build_object('kind', 'member', 'userId', '85600000-0000-4000-8000-000000000001');
	v_role text;
	v_fn text;
	v_problems jsonb;
	v_lobby_id uuid;
	v_lobby_env_name text;
	v_site_id uuid;
	v_site_slug text;
	v_hint_count integer;
	v_hosted jsonb;
	v_rename_1 public.qorpera_company_renames%rowtype;
	v_rename_2 public.qorpera_company_renames%rowtype;
	v_rename_3 public.qorpera_company_renames%rowtype;
	v_rename_4 public.qorpera_company_renames%rowtype;
	v_run_actor jsonb;
	v_lobby_env uuid;
	v_non_v2_id uuid;
	v_step jsonb;
	v_mat jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_policy jsonb;
	v_binding jsonb;
	v_read_wake jsonb;
	v_review jsonb;
	v_ifaces jsonb;
	v_gw_begin jsonb;
	v_gw_due jsonb;
	v_gw_sync jsonb;
	v_audit jsonb;
	v_reviews jsonb;
	v_sched jsonb;
	v_surface_id uuid;
	v_identity_commit jsonb;
	v_good_will_key text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.cnc_assert(
			not has_table_privilege(v_role, 'public.qorpera_company_renames', 'select,insert,update,delete'),
			'qorpera_company_renames exposed to ' || v_role
		);
		foreach v_fn in array array[
			'public.qorpera_company_rename_wake_ready()',
			'public.qorpera_company_rename_sponsor(uuid,uuid,uuid)',
			'public.qorpera_schedule_company_rename_jobs()'
		] loop
			perform pg_temp.cnc_assert(
				not has_function_privilege(v_role, v_fn, 'execute'),
				v_fn || ' exposed to ' || v_role
			);
		end loop;
	end loop;

	foreach v_fn in array array[
		'public.qorpera_company_rename_wake_step(uuid,integer)',
		'public.qorpera_company_rename_audit_step(integer,uuid)',
		'public.qorpera_operator_company_rename_reviews(integer,uuid)'
	] loop
		perform pg_temp.cnc_assert(
			not has_function_privilege('anon', v_fn, 'execute')
				and not has_function_privilege('authenticated', v_fn, 'execute')
				and has_function_privilege('service_role', v_fn, 'execute'),
			v_fn || ' execute privilege mismatch'
		);
	end loop;

	perform pg_temp.cnc_assert(
		(select relrowsecurity from pg_class where oid = 'public.qorpera_company_renames'::regclass) is true,
		'qorpera_company_renames must have RLS enabled'
	);

	perform pg_temp.as_user(v_owner);
	perform pg_temp.refused('select public.qorpera_company_rename_wake_step()', '42501');
	perform pg_temp.refused('select public.qorpera_company_rename_audit_step()', '42501');
	perform pg_temp.refused('select public.qorpera_operator_company_rename_reviews()', '42501');

	perform pg_temp.as_service();
	v_problems := public.qorpera_company_state_parse_problems('vision', jsonb_build_object('kind', 'vision', 'name', E'\u00a0\u2003\u3000'));
	perform pg_temp.cnc_assert(
		jsonb_array_length(v_problems) = 1 and (v_problems -> 0 ->> 'message') like '%(name)%',
		'Unicode-only whitespace name must be rejected: ' || v_problems::text
	);
	v_problems := public.qorpera_company_state_parse_problems('vision', jsonb_build_object('kind', 'vision', 'name', 'Solstice Roasters'));
	perform pg_temp.cnc_assert(jsonb_array_length(v_problems) = 0, 'Valid vision name rejected: ' || v_problems::text);

	perform pg_temp.as_user(v_owner);
	set local role authenticated;
	v_lobby_id := (public.qorpera_open_company_founding('13970000-0000-4000-8000-000000000100', 'Initial Name') ->> 'profileId')::uuid;
	perform public.qorpera_update_company_founding(v_lobby_id, 1, 'Renamed Lobby', 'Testing sync.');
	reset role;
	select e.name into v_lobby_env_name from public.qorpera_company_environments e where e.profile_id = v_lobby_id;
	perform pg_temp.cnc_assert(v_lobby_env_name = 'Renamed Lobby', 'founding rename must sync environment name, got ' || coalesce(v_lobby_env_name, 'null'));

	perform pg_temp.as_service();
	update public.qorpera_profiles set name = 'No name yet' where id = v_profile;
	insert into public.qorpera_surfaces(id, profile_id, slug, title, surface_group, surface_kind, archetype, source_kind, status, folder_root)
	values (
		'13970000-0000-4000-8000-000000000201',
		v_profile,
		'landing',
		'Landing',
		'products',
		'website',
		'live_build',
		'code_repo',
		'active',
		null
	)
	returning id into v_surface_id;
	v_site_id := public.qorpera_surface_ensure_site(v_surface_id);
	select s.slug into v_site_slug from public.qorpera_company_sites s where s.id = v_site_id;
	perform pg_temp.cnc_assert(
		v_site_slug is not null and v_site_slug not like 'no-name-yet%',
		'No name yet must not leak into site slug: ' || coalesce(v_site_slug, 'null')
	);
	delete from public.qorpera_surfaces where id = v_surface_id;
	delete from public.qorpera_company_sites where id = v_site_id;
	update public.qorpera_profiles set name = 'Nordlys Kaffe' where id = v_profile;

	delete from realtime.messages where topic like 'qorpera-live-%';
	perform set_config('qorpera.live_hints_sent', '', true);
	perform set_config('qorpera.live_hints_failed', '', true);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-1', 'Solstice Coffee');
	set constraints qorpera_live_hint_profile_name immediate;
	set constraints qorpera_live_hint_profile_name deferred;

	perform pg_temp.cnc_assert(
		(select name from public.qorpera_profiles where id = v_profile) = 'Solstice Coffee'
			and (select name_changed_at from public.qorpera_profiles where id = v_profile) is not null
			and (select name from public.qorpera_company_environments where id = v_env) = 'Solstice Coffee',
		'profile and environment names must converge on vision rename'
	);

	select count(*) into v_hint_count
	from realtime.messages m
	where m.topic like 'qorpera-live-%' and m.event = 'company-profile';
	perform pg_temp.cnc_assert(v_hint_count >= 1, 'profile rename must emit company-profile live hint');

	perform pg_temp.as_user(v_owner);
	set local role authenticated;
	select item into v_hosted
	from jsonb_array_elements(public.qorpera_list_hosted_profiles()) item
	where item ->> 'profile_id' = v_profile::text;
	reset role;
	perform pg_temp.cnc_assert(
		v_hosted ->> 'profile_name' = 'Solstice Coffee' and nullif(v_hosted ->> 'name_changed_at', '') is not null,
		'qorpera_list_hosted_profiles must return updated name and name_changed_at: ' || coalesce(v_hosted::text, 'null')
	);

	perform pg_temp.as_service();
	select * into strict v_rename_1
	from public.qorpera_company_renames
	where profile_id = v_profile;
	perform pg_temp.cnc_assert(
		v_rename_1.old_name = 'Nordlys Kaffe'
			and v_rename_1.new_name = 'Solstice Coffee'
			and v_rename_1.actor_kind = 'member'
			and v_rename_1.renamed_by_user_id = v_owner
			and v_rename_1.wake_state = 'pending'
			and v_rename_1.audit_state = 'pending'
			and v_rename_1.audit_due_at >= v_rename_1.created_at + interval '29 minutes',
		'first rename row mismatch: ' || to_jsonb(v_rename_1)::text
	);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-2', 'Solstice Roasters');
	select * into strict v_rename_2
	from public.qorpera_company_renames
	where id = v_rename_1.id;
	perform pg_temp.cnc_assert(
		(select count(*) from public.qorpera_company_renames where profile_id = v_profile) = 1
			and v_rename_2.old_name = 'Nordlys Kaffe'
			and v_rename_2.new_name = 'Solstice Roasters'
			and v_rename_2.wake_state = 'pending',
		'rapid pending rename must coalesce keeping original old_name: ' || to_jsonb(v_rename_2)::text
	);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-revert', 'Nordlys Kaffe');
	select * into strict v_rename_2
	from public.qorpera_company_renames
	where id = v_rename_1.id;
	perform pg_temp.cnc_assert(
		v_rename_2.wake_state = 'skipped'
			and v_rename_2.wake_problem = 'reverted'
			and v_rename_2.audit_state = 'superseded',
		'reverting to old_name before wake must mark rename reverted: ' || to_jsonb(v_rename_2)::text
	);

	insert into public.qorpera_good_will_customers(profile_id, livemode, stripe_customer_id)
	values (v_profile, false, 'cus_cnctest1');

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-live', 'Solstice Roasters');
	select * into strict v_rename_3
	from public.qorpera_company_renames
	where profile_id = v_profile and wake_state = 'pending';
	perform pg_temp.cnc_assert(
		v_rename_3.old_name = 'Nordlys Kaffe'
			and v_rename_3.new_name = 'Solstice Roasters'
			and v_rename_3.stripe_sync_state = 'pending',
		'live rename with Stripe customer must queue pending stripe sync: ' || to_jsonb(v_rename_3)::text
	);

	v_step := public.qorpera_company_rename_wake_step(v_env, 16);
	perform pg_temp.cnc_assert(
		v_step ->> 'state' = 'not_ready' and (v_step ->> 'woken')::integer = 0,
		'wake step must gate on active runtime bundle: ' || v_step::text
	);

	perform pg_temp.cnc_enable_rename_bundle();
	v_step := public.qorpera_company_rename_wake_step(v_env, 16);
	perform pg_temp.cnc_assert(
		v_step ->> 'state' = 'done' and (v_step ->> 'woken')::integer = 1,
		'wake step must wake Co-Founder once bundle is ready: ' || v_step::text
	);

	select * into strict v_rename_3 from public.qorpera_company_renames where id = v_rename_3.id;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_rename_3.wake_id;
	perform pg_temp.cnc_assert(
		v_rename_3.wake_state = 'woken'
			and v_wake.wake_kind = 'agent'
			and v_wake.source_kind = 'company-rename'
			and v_wake.source_id = v_rename_3.id
			and v_wake.staff_agent_id = v_cofounder
			and v_wake.payload ->> 'schema' = 'qorpera.company-rename-wake/v1'
			and v_wake.payload ->> 'oldName' = 'Nordlys Kaffe'
			and v_wake.payload ->> 'newName' = 'Solstice Roasters'
			and (v_wake.payload ->> 'renamedAt') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$'
			and public.qorpera_folder_wake_authorized(v_wake),
		'company-rename wake occurrence invalid: ' || to_jsonb(v_wake)::text
	);

	update public.qorpera_session_turn_requests
	set status = 'cancelled'
	where profile_id = v_profile and status = 'queued';
	perform set_config('qorpera.folder_wake_admission', '', true);
	v_mat := public.qorpera_folder_materialize_company(v_profile, 16);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_rename_3.wake_id;
	perform pg_temp.cnc_assert(v_wake.run_id is not null, 'materialize must create Co-Founder run: ' || v_mat::text);

	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.cnc_assert(
		public.qorpera_run_autonomous_authority(v_run),
		'renaming member must authorize Co-Founder company-rename run'
	);

	v_policy := public.qorpera_runtime_wake_policy_internal(v_run.id);
	perform pg_temp.cnc_assert(
		v_policy ->> 'kind' = 'agent'
			and v_policy ->> 'final' = case when v_wake.session_id is not null then 'optional' else 'forbidden' end,
		'company-rename wake policy mismatch: ' || v_policy::text
	);

	perform public.qorpera_register_runner_orchestrator(v_orch, 'CNC fixture', 'process', repeat('0', 64), 3600);
	v_binding := pg_temp.cnc_start_run(v_orch, v_run.id);
	v_read_wake := public.qorpera_folder_read_wake(v_binding);
	perform pg_temp.cnc_assert(
		v_read_wake -> 'source' ->> 'kind' = 'company-rename'
			and v_read_wake -> 'payload' ->> 'oldName' = 'Nordlys Kaffe'
			and v_read_wake -> 'payload' ->> 'newName' = 'Solstice Roasters'
			and v_read_wake ->> 'actorUserId' = v_owner::text,
		'qorpera_folder_read_wake mismatch: ' || v_read_wake::text
	);

	v_ifaces := public.qorpera_native_list_company_interfaces(v_binding);
	perform pg_temp.cnc_assert(
		v_ifaces -> 'company' ->> 'name' = 'Solstice Roasters'
			and v_ifaces -> 'company' ->> 'previousName' = 'Nordlys Kaffe'
			and nullif(v_ifaces -> 'company' ->> 'renamedAt', '') is not null,
		'qorpera_native_list_company_interfaces missing live company metadata: ' || v_ifaces::text
	);

	v_review := public.qorpera_begin_action_review(
		v_binding,
		jsonb_build_object(
			'tool', 'company_write',
			'argumentSha256', repeat('a', 64)
		)
	);
	perform pg_temp.cnc_assert(
		v_review #>> '{company,name}' = 'Solstice Roasters',
		'action review company name mismatch: ' || v_review::text
	);

	v_good_will_key := 'cnc-test-billing-key';
	insert into public.qorpera_computer_hour_billing_keys(key_sha256)
	values (encode(extensions.digest(v_good_will_key, 'sha256'), 'hex'));
	insert into public.qorpera_computer_hour_testers(user_id)
	values (v_owner)
	on conflict do nothing;

	v_gw_begin := public.qorpera_good_will_billing(
		v_good_will_key,
		'card_begin',
		jsonb_build_object('userId', v_owner, 'profileId', v_profile, 'livemode', false)
	);
	perform pg_temp.cnc_assert(
		v_gw_begin ->> 'nameSyncRenameId' = v_rename_3.id::text and v_gw_begin ->> 'companyName' = 'Solstice Roasters',
		'good will card_begin must return nameSyncRenameId: ' || v_gw_begin::text
	);

	v_gw_due := public.qorpera_good_will_billing(v_good_will_key, 'due', jsonb_build_object('livemode', false));
	perform pg_temp.cnc_assert(
		exists (
			select 1 from jsonb_array_elements(v_gw_due -> 'nameSyncs') ns
			where ns ->> 'renameId' = v_rename_3.id::text
				and ns ->> 'customerId' = 'cus_cnctest1'
				and ns ->> 'companyName' = 'Solstice Roasters'
		),
		'good will due must include pending nameSyncs: ' || v_gw_due::text
	);

	v_gw_sync := public.qorpera_good_will_billing(v_good_will_key, 'name_sync_due', jsonb_build_object('livemode', false));
	perform pg_temp.cnc_assert(
		jsonb_array_length(v_gw_sync -> 'customers') >= 1,
		'good will name_sync_due must return pending customers: ' || v_gw_sync::text
	);

	v_audit := public.qorpera_company_rename_audit_step(5, null);
	perform pg_temp.cnc_assert(
		(v_audit ->> 'audited')::integer = 0,
		'30-min audit must wait until audit_due_at unless forced: ' || v_audit::text
	);

	v_identity_commit := public.qorpera_folder_commit(
		v_env,
		v_owner_actor,
		'cnc-identity-post-rename',
		jsonb_build_array(
			jsonb_build_object('op', 'mkdir', 'path', 'identity'),
			jsonb_build_object(
				'op', 'write',
				'path', 'identity/company.json',
				'file', pg_temp.cnc_stage_as(v_env, v_owner_actor, '{"name":"Solstice Roasters"}')
			)
		)
	);
	perform pg_temp.cnc_assert(v_identity_commit -> 'units' -> 1 ->> 'outcome' = 'saved', 'identity commit failed');

	v_gw_sync := public.qorpera_good_will_billing(
		v_good_will_key,
		'name_synced',
		jsonb_build_object('profileId', v_profile, 'renameId', v_rename_3.id, 'companyName', 'Solstice Roasters', 'livemode', false)
	);
	perform pg_temp.cnc_assert((v_gw_sync ->> 'synced')::boolean, 'name_synced must mark pending rename synced');

	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runner_jobs
	set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = v_run.job_id;
	if v_wake.session_id is not null then
		insert into public.qorpera_session_events(
			session_id, sequence, event_id, event_type, actor_user_id, execution_kind, execution_id,
			execution_claimant_id, runner_assignment_id, body, event_hash, created_at
		)
		values (
			v_wake.session_id,
			coalesce((select max(sequence) from public.qorpera_session_events where session_id = v_wake.session_id), 0) + 1,
			extensions.gen_random_uuid(),
			'message',
			v_owner,
			'run',
			v_run.id,
			v_run.id,
			(v_binding ->> 'assignmentId')::uuid,
			jsonb_build_object('text', 'Updated company to Solstice Roasters.'),
			repeat('b', 64),
			clock_timestamp()
		);
	end if;
	perform set_config('session_replication_role', 'origin', true);

	v_audit := public.qorpera_company_rename_audit_step(5, v_rename_3.id);
	perform pg_temp.cnc_assert((v_audit ->> 'audited')::integer = 1, 'forced audit must complete rename row');

	v_reviews := public.qorpera_operator_company_rename_reviews(10, v_profile);
	perform pg_temp.cnc_assert(
		v_reviews ->> 'schema' = 'qorpera.operator-company-rename-reviews/v1'
			and exists (
				select 1 from jsonb_array_elements(v_reviews -> 'reviews') rev
				where rev ->> 'id' = v_rename_3.id::text
					and rev ->> 'auditState' = 'completed'
					and rev ->> 'auditOutcome' = 'clean'
					and rev ->> 'stripeSyncState' = 'synced'
					and (rev #>> '{auditReport,convergence,dbConverged}')::boolean
					and (rev #>> '{auditReport,cofounder,postsAfterRename}')::integer >= case when v_wake.session_id is not null then 1 else 0 end
			),
		'operator rename review scorecard mismatch: ' || v_reviews::text
	);

	if to_regnamespace('cron') is null then
		create schema cron;
		create table cron.job(
			jobid bigint generated always as identity primary key,
			schedule text not null,
			command text not null,
			jobname text not null,
			username text not null default current_user,
			unique (jobname, username)
		);
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v_sched := public.qorpera_schedule_company_rename_jobs();
	perform pg_temp.cnc_assert(
		(v_sched ->> 'scheduled')::boolean
			and (select schedule from cron.job where jobname = 'qorpera-company-rename-wakes') = '* * * * *'
			and (select schedule from cron.job where jobname = 'qorpera-company-rename-audits') = '*/5 * * * *',
		'pg_cron schedule mismatch: ' || v_sched::text
	);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-unnamed', 'No name yet');
	select * into strict v_rename_4
	from public.qorpera_company_renames
	where profile_id = v_profile and wake_state = 'pending';
	perform pg_temp.cnc_assert(
		v_rename_4.new_name = 'No name yet' and v_rename_4.stripe_sync_state = 'none',
		'No name yet must not queue pending Stripe sync: ' || to_jsonb(v_rename_4)::text
	);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-beta', 'Solstice Beta');
	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-gamma', 'Solstice Gamma');
	select * into strict v_rename_4
	from public.qorpera_company_renames
	where id = v_rename_4.id;
	v_gw_sync := public.qorpera_good_will_billing(
		v_good_will_key,
		'name_synced',
		jsonb_build_object('profileId', v_profile, 'renameId', v_rename_4.id, 'companyName', 'Solstice Beta', 'livemode', false)
	);
	perform pg_temp.cnc_assert(
		not (v_gw_sync ->> 'synced')::boolean
			and (select stripe_sync_state from public.qorpera_company_renames where id = v_rename_4.id) = 'pending',
		'stale coalesced name_synced must not clear newer name: ' || v_gw_sync::text
	);
	v_gw_sync := public.qorpera_good_will_billing(
		v_good_will_key,
		'name_synced',
		jsonb_build_object('profileId', v_profile, 'renameId', v_rename_4.id, 'companyName', 'Solstice Gamma', 'livemode', false)
	);
	perform pg_temp.cnc_assert(
		(v_gw_sync ->> 'synced')::boolean
			and (select stripe_sync_state from public.qorpera_company_renames where id = v_rename_4.id) = 'synced',
		'matching name_synced must mark coalesced rename synced: ' || v_gw_sync::text
	);

	update public.qorpera_company_renames
	set created_at = clock_timestamp() - interval '25 hours'
	where id = v_rename_4.id;
	v_step := public.qorpera_company_rename_wake_step(v_env, 16);
	select * into strict v_rename_4 from public.qorpera_company_renames where id = v_rename_4.id;
	perform pg_temp.cnc_assert(
		(v_step ->> 'skipped')::integer = 1
			and v_rename_4.wake_state = 'skipped'
			and v_rename_4.wake_problem = 'expired',
		'stale pending rename older than 24h must expire: ' || v_step::text || ' ' || to_jsonb(v_rename_4)::text
	);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-temp', 'Solstice Temp');
	select * into strict v_rename_4
	from public.qorpera_company_renames
	where profile_id = v_profile and wake_state = 'pending';
	v_gw_sync := public.qorpera_good_will_billing(
		v_good_will_key,
		'name_synced',
		jsonb_build_object('profileId', v_profile, 'renameId', v_rename_4.id, 'companyName', 'Solstice Temp', 'livemode', false)
	);
	perform pg_temp.cnc_assert((v_gw_sync ->> 'synced')::boolean, 'temp rename must sync to Stripe');
	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-temp-revert', 'Solstice Gamma');
	select * into strict v_rename_4 from public.qorpera_company_renames where id = v_rename_4.id;
	perform pg_temp.cnc_assert(
		v_rename_4.wake_state = 'skipped'
			and v_rename_4.wake_problem = 'reverted'
			and v_rename_4.stripe_sync_state = 'pending'
			and v_rename_4.stripe_synced_at is null,
		'reverting after Stripe sync must re-queue pending Stripe sync: ' || to_jsonb(v_rename_4)::text
	);
	v_gw_sync := public.qorpera_good_will_billing(
		v_good_will_key,
		'name_synced',
		jsonb_build_object('profileId', v_profile, 'renameId', v_rename_4.id, 'companyName', 'Solstice Temp', 'livemode', false)
	);
	perform pg_temp.cnc_assert(not (v_gw_sync ->> 'synced')::boolean, 'stale name must not clear reverted Stripe sync');
	v_gw_sync := public.qorpera_good_will_billing(
		v_good_will_key,
		'name_synced',
		jsonb_build_object('profileId', v_profile, 'renameId', v_rename_4.id, 'companyName', 'Solstice Gamma', 'livemode', false)
	);
	perform pg_temp.cnc_assert(
		(v_gw_sync ->> 'synced')::boolean
			and (select stripe_sync_state from public.qorpera_company_renames where id = v_rename_4.id) = 'synced',
		'reverted old_name must clear reverted Stripe sync: ' || v_gw_sync::text
	);

	perform pg_temp.cnc_commit_vision(v_env, v_owner_actor, 'cnc-rename-paused', 'Solstice Paused');
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values (v_profile, v_owner, 'cnc pause test');
	select * into strict v_rename_4
	from public.qorpera_company_renames
	where profile_id = v_profile and wake_state = 'pending';
	select e.id into strict v_lobby_env from public.qorpera_company_environments e where e.profile_id = v_lobby_id;
	insert into public.qorpera_company_renames(
		profile_id, environment_id, old_name, new_name, created_at, updated_at
	)
	values (
		v_lobby_id, v_lobby_env, 'Initial Name', 'Renamed Lobby',
		clock_timestamp() + interval '1 second', clock_timestamp() + interval '1 second'
	)
	returning id into v_non_v2_id;
	v_step := public.qorpera_company_rename_wake_step(null, 1);
	select * into strict v_rename_4 from public.qorpera_company_renames where id = v_rename_4.id;
	perform pg_temp.cnc_assert(
		(v_step ->> 'busy')::integer = 1
			and v_rename_4.wake_state = 'pending'
			and v_rename_4.wake_attempts = 1
			and v_rename_4.wake_last_attempt_at is not null
			and v_rename_4.wake_problem = 'paused',
		'paused company must record backoff attempt: ' || v_step::text || ' ' || to_jsonb(v_rename_4)::text
	);
	v_step := public.qorpera_company_rename_wake_step(null, 1);
	perform pg_temp.cnc_assert(
		(v_step ->> 'skipped')::integer = 1
			and (select wake_state from public.qorpera_company_renames where id = v_non_v2_id) = 'skipped'
			and (select wake_problem from public.qorpera_company_renames where id = v_non_v2_id) = 'no_cofounder',
		'backed-off paused company must not starve next environment: ' || v_step::text
	);
	delete from public.qorpera_company_execution_pauses where profile_id = v_profile;
	update public.qorpera_company_renames
	set wake_state = 'skipped', wake_problem = 'test_done'
	where id = v_rename_4.id;

	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runner_jobs
	set status = 'leased', result = null, finished_at = null,
		lease_token_sha256 = repeat('3', 64), lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_run.job_id;
	update public.qorpera_execution_sponsor_versions
	set allow_autonomous = false
	where binding_id in (select id from public.qorpera_execution_sponsor_bindings where profile_id = v_profile);
	update public.qorpera_provider_connection_versions
	set allow_autonomous = false
	where connection_id in (select id from public.qorpera_provider_connections where profile_id = v_profile);
	perform set_config('session_replication_role', 'origin', true);

	v_run_actor := jsonb_build_object(
		'kind', 'run',
		'runId', v_binding ->> 'runId',
		'jobId', v_binding ->> 'jobId',
		'runnerId', v_binding ->> 'runnerId',
		'assignmentId', v_binding ->> 'assignmentId'
	);
	perform pg_temp.cnc_commit_vision(v_env, v_run_actor, 'cnc-rename-agent-1', 'Solstice Agent');
	select * into strict v_rename_4
	from public.qorpera_company_renames
	where profile_id = v_profile and wake_state = 'pending';
	perform pg_temp.cnc_assert(
		v_rename_4.actor_kind = 'staff_agent'
			and v_rename_4.actor_id = v_cofounder
			and v_rename_4.renamed_by_user_id is null,
		'agent-authored rename must not inherit requester as renamed_by_user_id: ' || to_jsonb(v_rename_4)::text
	);
	v_step := public.qorpera_company_rename_wake_step(v_env, 16);
	select * into strict v_rename_4 from public.qorpera_company_renames where id = v_rename_4.id;
	perform pg_temp.cnc_assert(
		(v_step ->> 'unpaid')::integer = 1
			and (v_step ->> 'woken')::integer = 0
			and v_rename_4.wake_state = 'unpaid'
			and v_rename_4.wake_problem = 'no_payer',
		'agent-authored rename must not bypass allow_autonomous: ' || v_step::text || ' ' || to_jsonb(v_rename_4)::text
	);
end $$;

rollback;
