-- WHY: Validate orchestrator control token and invoke the allowlisted orchestrator RPC in one Postgres round trip instead of two.
create function public.qorpera_runner_orchestrator_dispatch(
	p_orchestrator_id uuid,
	p_control_token_sha256 text,
	p_rpc text,
	p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_args jsonb := coalesce(p_args, '{}'::jsonb);
	v_conflict_paths text[];
	v_note_paths text[];
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runner orchestrator authority is required' using errcode = '42501';
	end if;
	if not coalesce(public.qorpera_runner_orchestrator_control_valid(p_orchestrator_id, p_control_token_sha256), false) then
		raise exception 'Runner orchestrator control token is invalid' using errcode = '42501';
	end if;
	if jsonb_typeof(v_args) is distinct from 'object' then
		raise exception 'Orchestrator dispatch arguments must be an object' using errcode = '22023';
	end if;

	case p_rpc
		when 'qorpera_orchestrator_due_summary' then
			return public.qorpera_orchestrator_due_summary();
		when 'qorpera_reconcile_runner_orchestrator' then
			return public.qorpera_reconcile_runner_orchestrator((v_args ->> 'p_orchestrator_id')::uuid);
		when 'qorpera_list_retained_runner_claims' then
			return public.qorpera_list_retained_runner_claims((v_args ->> 'p_orchestrator_id')::uuid);
		when 'qorpera_claim_runner_job_for_orchestrator' then
			return public.qorpera_claim_runner_job_for_orchestrator(
				(v_args ->> 'p_orchestrator_id')::uuid,
				(v_args ->> 'p_client_claim_id')::uuid,
				(v_args ->> 'p_lease_seconds')::integer
			);
		when 'qorpera_renew_runner_job_claim' then
			return public.qorpera_renew_runner_job_claim(
				(v_args ->> 'p_orchestrator_id')::uuid,
				(v_args ->> 'p_claim_id')::uuid,
				(v_args ->> 'p_lease_seconds')::integer
			);
		when 'qorpera_assign_runner_job' then
			return public.qorpera_assign_runner_job(
				(v_args ->> 'p_orchestrator_id')::uuid,
				(v_args ->> 'p_claim_id')::uuid,
				(v_args ->> 'p_runner_id')::uuid,
				(v_args ->> 'p_client_assignment_id')::uuid,
				v_args ->> 'p_capability_sha256',
				(v_args ->> 'p_assignment_seconds')::integer
			);
		when 'qorpera_release_runner_job_claim' then
			return public.qorpera_release_runner_job_claim(
				(v_args ->> 'p_orchestrator_id')::uuid,
				(v_args ->> 'p_claim_id')::uuid,
				(v_args ->> 'p_client_assignment_id')::uuid,
				v_args ->> 'p_error'
			);
		when 'qorpera_list_routine_schedule_heads' then
			return public.qorpera_list_routine_schedule_heads(
				(v_args ->> 'p_after_routine_id')::uuid,
				(v_args ->> 'p_limit')::integer
			);
		when 'qorpera_enqueue_routine_wake' then
			return public.qorpera_enqueue_routine_wake(
				(v_args ->> 'p_routine_id')::uuid,
				(v_args ->> 'p_expected_version')::bigint,
				(v_args ->> 'p_occurrence_id')::uuid,
				v_args ->> 'p_occurrence_key',
				v_args ->> 'p_trigger_id',
				(v_args ->> 'p_scheduled_for')::timestamptz,
				(v_args ->> 'p_expected_last_scheduled_for')::timestamptz,
				(v_args ->> 'p_next_due_at')::timestamptz,
				coalesce(v_args -> 'p_payload', '{}'::jsonb)
			);
		when 'qorpera_advance_routine_next_due' then
			return public.qorpera_advance_routine_next_due(
				(v_args ->> 'p_routine_id')::uuid,
				(v_args ->> 'p_expected_version')::bigint,
				v_args ->> 'p_trigger_id',
				(v_args ->> 'p_expected_last_scheduled_for')::timestamptz,
				(v_args ->> 'p_next_due_at')::timestamptz
			);
		when 'qorpera_skip_checked_routine_wake' then
			return public.qorpera_skip_checked_routine_wake(
				(v_args ->> 'p_routine_id')::uuid,
				(v_args ->> 'p_expected_version')::bigint,
				v_args ->> 'p_trigger_id',
				(v_args ->> 'p_scheduled_for')::timestamptz,
				(v_args ->> 'p_expected_last_scheduled_for')::timestamptz,
				(v_args ->> 'p_next_due_at')::timestamptz,
				(v_args ->> 'p_healthy')::boolean,
				v_args ->> 'p_summary',
				v_args ->> 'p_detail'
			);
		when 'qorpera_read_routine_code_checks' then
			return public.qorpera_read_routine_code_checks(
				(v_args ->> 'p_routine_id')::uuid,
				v_args ->> 'p_repo'
			);
		when 'qorpera_folder_dynamic_routines_due' then
			return public.qorpera_folder_dynamic_routines_due(
				(v_args ->> 'p_after_routine_id')::uuid,
				(v_args ->> 'p_limit')::integer
			);
		when 'qorpera_folder_restore_dynamic_routine_run' then
			return public.qorpera_folder_restore_dynamic_routine_run(
				(v_args ->> 'p_routine_id')::uuid,
				(v_args ->> 'p_expected_version')::bigint
			);
		when 'qorpera_folder_materialize_due' then
			return public.qorpera_folder_materialize_due(
				(v_args ->> 'p_after_profile_id')::uuid,
				(v_args ->> 'p_limit')::integer
			);
		when 'qorpera_folder_materialize_company' then
			return public.qorpera_folder_materialize_company(
				(v_args ->> 'p_profile_id')::uuid,
				(v_args ->> 'p_limit')::integer
			);
		when 'qorpera_folder_listen_due' then
			return public.qorpera_folder_listen_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_listen_company' then
			return public.qorpera_folder_listen_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_workers_due' then
			return public.qorpera_folder_workers_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_workers_company' then
			return public.qorpera_folder_workers_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_human_tasks_due' then
			return public.qorpera_folder_human_tasks_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_human_tasks_company' then
			return public.qorpera_folder_human_tasks_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_machine_events_due' then
			return public.qorpera_folder_machine_events_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_machine_events_company' then
			return public.qorpera_folder_machine_events_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_office_wakes_due' then
			return public.qorpera_folder_office_wakes_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_office_wakes_company' then
			return public.qorpera_folder_office_wakes_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_machine_checkins_due' then
			return public.qorpera_folder_machine_checkins_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_machine_checkins_company' then
			return public.qorpera_folder_machine_checkins_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_coding_checkins_due' then
			return public.qorpera_folder_coding_checkins_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_coding_checkins_company' then
			return public.qorpera_folder_coding_checkins_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_event_wakes_due' then
			return public.qorpera_folder_event_wakes_due((v_args ->> 'p_after_environment')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_folder_event_wakes_company' then
			return public.qorpera_folder_event_wakes_company((v_args ->> 'p_environment_id')::uuid, (v_args ->> 'p_limit')::integer);
		when 'qorpera_surface_claim_pending_jobs_for_lane' then
			return public.qorpera_surface_claim_pending_jobs_for_lane((v_args ->> 'p_limit')::integer, v_args ->> 'p_lane');
		when 'qorpera_surface_claim_pending_jobs' then
			return public.qorpera_surface_claim_pending_jobs((v_args ->> 'p_limit')::integer);
		when 'qorpera_surface_shared_product_folder_roots' then
			return to_jsonb(public.qorpera_surface_shared_product_folder_roots((v_args ->> 'p_profile_id')::uuid));
		when 'qorpera_surface_enqueue_session_run' then
			return public.qorpera_surface_enqueue_session_run(
				(v_args ->> 'p_session_id')::uuid,
				(v_args ->> 'p_lease_token')::uuid
			);
		when 'qorpera_surface_trigger_automation' then
			return public.qorpera_surface_trigger_automation((v_args ->> 'p_automation_id')::uuid);
		when 'qorpera_surface_update_rebased_changes' then
			if jsonb_typeof(v_args -> 'p_conflict_paths') = 'array' then
				select array_agg(item) into v_conflict_paths from jsonb_array_elements_text(v_args -> 'p_conflict_paths') as item;
			end if;
			return public.qorpera_surface_update_rebased_changes(
				(v_args ->> 'p_surface_id')::uuid,
				(v_args ->> 'p_session_id')::uuid,
				v_args ->> 'p_branch_head_sha',
				coalesce(v_args -> 'p_rebased_changes', '[]'::jsonb),
				(v_args ->> 'p_conflicted_change_id')::uuid,
				v_conflict_paths
			);
		when 'qorpera_surface_renew_lease' then
			return public.qorpera_surface_renew_lease(
				v_args ->> 'p_kind',
				(v_args ->> 'p_id')::uuid,
				(v_args ->> 'p_lease_token')::uuid,
				(v_args ->> 'p_extend_seconds')::integer
			);
		when 'qorpera_surface_release_session_claim' then
			return public.qorpera_surface_release_session_claim(
				(v_args ->> 'p_session_id')::uuid,
				(v_args ->> 'p_lease_token')::uuid
			);
		when 'qorpera_surface_complete_preview' then
			return public.qorpera_surface_complete_preview(
				(v_args ->> 'p_preview_id')::uuid,
				v_args ->> 'p_status',
				v_args ->> 'p_composite_tree_sha',
				(v_args ->> 'p_site_version_id')::uuid,
				case when v_args -> 'p_conflict_report' = 'null'::jsonb then null else v_args -> 'p_conflict_report' end,
				v_args ->> 'p_error_detail',
				(v_args ->> 'p_lease_token')::uuid
			);
		when 'qorpera_surface_complete_session_turn' then
			if jsonb_typeof(v_args -> 'p_note_paths') = 'array' then
				select array_agg(item) into v_note_paths from jsonb_array_elements_text(v_args -> 'p_note_paths') as item;
			end if;
			return public.qorpera_surface_complete_session_turn(
				(v_args ->> 'p_session_id')::uuid,
				v_args ->> 'p_state',
				v_args ->> 'p_reply_text',
				case when v_args -> 'p_question' = 'null'::jsonb then null else v_args -> 'p_question' end,
				v_note_paths,
				v_args ->> 'p_branch_head_sha',
				(v_args ->> 'p_lease_token')::uuid
			);
		when 'qorpera_surface_complete_merge' then
			if jsonb_typeof(v_args -> 'p_conflict_paths') = 'array' then
				select array_agg(item) into v_conflict_paths from jsonb_array_elements_text(v_args -> 'p_conflict_paths') as item;
			end if;
			return public.qorpera_surface_complete_merge(
				(v_args ->> 'p_job_id')::uuid,
				v_args ->> 'p_status',
				v_args ->> 'p_main_before',
				v_args ->> 'p_main_after',
				(v_args ->> 'p_conflict_change_id')::uuid,
				v_conflict_paths,
				v_args ->> 'p_error_detail',
				case when v_args -> 'p_pre_merge_snapshot' = 'null'::jsonb then null else v_args -> 'p_pre_merge_snapshot' end,
				(v_args ->> 'p_lease_token')::uuid
			);
		when 'qorpera_surface_complete_publish' then
			return public.qorpera_surface_complete_publish(
				(v_args ->> 'p_job_id')::uuid,
				v_args ->> 'p_status',
				v_args ->> 'p_published_head_sha',
				v_args ->> 'p_error_detail',
				(v_args ->> 'p_lease_token')::uuid
			);
		else
			raise exception 'Unknown orchestrator dispatch RPC' using errcode = 'QRD01';
	end case;
end $$;

revoke all on function public.qorpera_runner_orchestrator_dispatch(uuid, text, text, jsonb)
	from public, anon, authenticated;
grant execute on function public.qorpera_runner_orchestrator_dispatch(uuid, text, text, jsonb)
	to service_role;
