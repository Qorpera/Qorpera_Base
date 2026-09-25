-- The driver clones the pre-19700 database and admits a real native v1 run
-- before applying the remaining migration chain. No producer or authority helper is substituted.
begin;
set local "request.jwt.claims" = '{"role":"service_role"}';
do $$
declare v_history public.qorpera_test_provenance_history%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_inputs jsonb; v_message text;
begin
	select * into strict v_history from public.qorpera_test_provenance_history;
	select * into strict v_run from public.qorpera_execution_runs where id = (v_history.binding ->> 'runId')::uuid;
	select jsonb_agg(to_jsonb(input) order by input.id) into v_inputs from public.qorpera_session_inputs input
	where input.id = any(v_run.input_ids);
	if to_jsonb(v_run) - array['reasoning_effort','reasoning_policy_sha256'] <> v_history.run
		or v_inputs is distinct from v_history.inputs then
		raise exception 'Upgrade rewrote historical admission provenance'; end if;
	if v_run.reasoning_effort is not null or v_run.reasoning_policy_sha256 is not null
		or public.qorpera_execution_run_json(v_run) -> 'reasoning_effort' <> 'null'::jsonb then
		raise exception 'Upgrade invented the effort of historical work'; end if;
	if not exists(select 1 from public.qorpera_runtime_bundles where id = v_run.runtime_bundle_id and version = 1)
		or not exists(select 1 from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
				and bundle.sha256 = active.runtime_bundle_sha256
			where bundle.sha256 = current_setting('qorpera_test.expected_runtime_bundle') and bundle.version > 1) then
		raise exception 'Upgrade lost the old bundle or failed to activate the new one'; end if;
	begin
		perform public.qorpera_execution_runtime_manifest(v_run);
		raise exception 'Historical symbolic bundle passed executable manifest validation';
	exception when insufficient_privilege then
		get stacked diagnostics v_message = message_text;
		if v_message <> 'Run requires an executable runtime bundle' then raise; end if;
	end;
	-- Current native admission checks wake authority before the manifest. A
	-- pre-wake-bus run must stay denied there too; never fabricate a wake to
	-- reach the later executable-bundle check exercised independently above.
	if exists(select 1 from public.qorpera_wake_occurrences where run_id = v_run.id) then
		raise exception 'Upgrade invented wake authority for historical work'; end if;
	set local role service_role;
	begin
		perform public.qorpera_describe_native_tool_authority(v_history.binding);
		raise exception 'Historical run without wake authority reached the native runtime';
	exception when insufficient_privilege then
		get stacked diagnostics v_message = message_text;
		if v_message <> 'Admitted wake authority is unavailable' then raise; end if;
	end;
	reset role;
	if v_run.audience_kind <> 'member_private' or v_run.audience_user_id <> v_run.requested_by_user_id then
		raise exception 'Upgrade fixture must retain an admitted private audience'; end if;
	-- Preserve a founder and transfer usage responsibility before removing the old requester.
	update public.qorpera_profile_members set role = 'owner' where user_id = '29000000-0000-4000-8000-000000000002';
	perform set_config('request.jwt.claims','{"role":"authenticated","sub":"29000000-0000-4000-8000-000000000002"}',true);
	perform public.qorpera_accept_computer_usage_ownership(v_run.profile_id,v_run.requested_by_user_id);
	update public.qorpera_profile_members set role = 'admin' where user_id = v_run.requested_by_user_id;
	perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',v_run.requested_by_user_id)::text,true);
	set local role authenticated;
	perform public.qorpera_cancel_session_run(v_run.session_id,v_run.id);
	reset role;
	perform set_config('request.jwt.claims','{"role":"authenticated","sub":"29000000-0000-4000-8000-000000000002"}',true);
	set local role authenticated;
	perform public.qorpera_remove_profile_member(v_run.profile_id,v_run.requested_by_user_id);
	reset role;
	if not exists(select 1 from public.qorpera_shared_sessions where id = v_run.session_id and status = 'closed')
		or not exists(select 1 from public.qorpera_execution_runs where id = v_run.id and audience_user_id = v_run.audience_user_id)
		or exists(select 1 from public.qorpera_profile_members where profile_id = v_run.profile_id and user_id = v_run.requested_by_user_id) then
		raise exception 'Pre-upgrade private history blocked membership removal or was erased'; end if;
end
$$;
rollback;
