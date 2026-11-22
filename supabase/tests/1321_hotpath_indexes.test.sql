begin;

create function pg_temp.assert_index_present(p_table text, p_index text) returns void language plpgsql as $$
begin
	if not exists (
		select 1
		from pg_index i
		join pg_class idx on idx.oid = i.indexrelid
		join pg_class tbl on tbl.oid = i.indrelid
		where idx.relnamespace = 'public'::regnamespace
			and tbl.relnamespace = 'public'::regnamespace
			and tbl.relname = p_table
			and idx.relname = p_index
			and i.indisvalid
			and i.indisready
	) then
		raise exception 'Expected valid index public.% on public.%', p_index, p_table;
	end if;
end $$;

create function pg_temp.assert_plan_uses_index(p_sql text, p_index text) returns void language plpgsql as $$
declare
	v_plan jsonb;
begin
	execute 'explain (format json) ' || p_sql into v_plan;
	if position(p_index in v_plan::text) = 0 then
		raise exception 'Expected plan for [%] to reference index %, got %', p_sql, p_index, v_plan::text;
	end if;
end $$;

select pg_temp.assert_index_present(tbl, idx)
from (values
	('qorpera_runtime_machine_allocations', 'qorpera_runtime_machine_allocations_login_identity_adapter'),
	('qorpera_runner_jobs', 'qorpera_runner_jobs_queued_created'),
	('qorpera_deleted_profile_object_gc_leases', 'qorpera_deleted_profile_object_gc_leases_expires'),
	('qorpera_session_events', 'qorpera_session_events_session_entry_id'),
	('qorpera_session_events', 'qorpera_session_events_session_part_entry_id'),
	('qorpera_digital_post_letters', 'qorpera_digital_post_letters_profile_received'),
	('qorpera_digital_post_letters', 'qorpera_digital_post_letters_kept_lease'),
	('qorpera_folder_path_versions', 'qorpera_folder_path_versions_move_in'),
	('qorpera_runner_assignments', 'qorpera_runner_assignments_offered_expires'),
	('qorpera_runner_job_claims', 'qorpera_runner_job_claims_active_expires'),
	('qorpera_profile_invitations', 'qorpera_profile_invitations_expires'),
	('qorpera_folder_object_gc', 'qorpera_folder_object_gc_claimable'),
	('qorpera_coding_executors', 'qorpera_coding_executors_owner_env'),
	('qorpera_company_machines', 'qorpera_company_machines_stopped_task'),
	('qorpera_folder_connection_file_work', 'qorpera_folder_connection_file_work_dirty'),
	('qorpera_folder_connection_file_work', 'qorpera_folder_connection_file_work_profile'),
	('qorpera_coding_results_files', 'qorpera_coding_results_files_due'),
	('qorpera_execution_runs', 'qorpera_execution_runs_profile_created'),
	('qorpera_execution_runs', 'qorpera_execution_runs_profile_staff_created'),
	('qorpera_wake_occurrences', 'qorpera_wake_occurrences_queued_company_file'),
	('qorpera_bank_transactions', 'qorpera_bank_transactions_profile_booked'),
	('qorpera_company_storage_deletions', 'qorpera_company_storage_deletions_claim'),
	('qorpera_member_notifications', 'qorpera_member_notifications_open_run_no_progress'),
	('qorpera_member_notifications', 'qorpera_member_notifications_dedupe_history')
) as expected(tbl, idx);

set local enable_seqscan = off;

select pg_temp.assert_plan_uses_index(
	$$select 1 from public.qorpera_runtime_machine_allocations
	  where login_compute_identity_id = '00000000-0000-4000-8000-000000000001'
	    and provider_adapter = 'lxd'$$,
	'qorpera_runtime_machine_allocations_login_identity_adapter'
);

select pg_temp.assert_plan_uses_index(
	$$select id from public.qorpera_runner_jobs
	  where status = 'queued' order by created_at, id limit 1$$,
	'qorpera_runner_jobs_queued_created'
);

select pg_temp.assert_plan_uses_index(
	$$select 1 from public.qorpera_session_events
	  where session_id = '00000000-0000-4000-8000-000000000001'
	    and public.qorpera_memory_entry_id(body, event_id) = 'entry-1'$$,
	'qorpera_session_events_session_entry_id'
);

select pg_temp.assert_plan_uses_index(
	$$select 1 from public.qorpera_session_events
	  where session_id = '00000000-0000-4000-8000-000000000001'
	    and body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
	    and body ->> 'entryId' = 'entry-1'$$,
	'qorpera_session_events_session_part_entry_id'
);

select pg_temp.assert_plan_uses_index(
	$$select id from public.qorpera_digital_post_letters
	  where profile_id = '00000000-0000-4000-8000-000000000001'
	  order by received_at desc, id limit 200$$,
	'qorpera_digital_post_letters_profile_received'
);

select pg_temp.assert_plan_uses_index(
	$$select 1 from public.qorpera_digital_post_letters
	  where profile_id = '00000000-0000-4000-8000-000000000001'
	    and status = 'kept' and write_lease_until > clock_timestamp()$$,
	'qorpera_digital_post_letters_kept_lease'
);

select pg_temp.assert_plan_uses_index(
	$$select version from public.qorpera_folder_path_versions
	  where commit_id = '00000000-0000-4000-8000-000000000001'
	    and op = 'move_in' and prior_version = '00000000-0000-4000-8000-000000000002'$$,
	'qorpera_folder_path_versions_move_in'
);

select pg_temp.assert_plan_uses_index(
	$$select id from public.qorpera_company_machines
	  where desired_state = 'stopped' and lifetime = 'task' and removed_at is null
	  order by updated_at, id limit 8$$,
	'qorpera_company_machines_stopped_task'
);

select pg_temp.assert_plan_uses_index(
	$$select id from public.qorpera_wake_occurrences
	  where source_kind = 'company-file' and status = 'queued' and run_id is null
	    and routine_id = '00000000-0000-4000-8000-000000000001' and routine_version = 1
	  order by created_at, id limit 1$$,
	'qorpera_wake_occurrences_queued_company_file'
);

select pg_temp.assert_plan_uses_index(
	$$select booked_on from public.qorpera_bank_transactions
	  where profile_id = '00000000-0000-4000-8000-000000000001'
	  order by booked_on desc limit 1$$,
	'qorpera_bank_transactions_profile_booked'
);

select pg_temp.assert_plan_uses_index(
	$$select 1 from public.qorpera_member_notifications
	  where kind = 'run_no_progress' and acknowledged_at is null$$,
	'qorpera_member_notifications_open_run_no_progress'
);

rollback;
