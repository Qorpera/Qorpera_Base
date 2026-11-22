set local lock_timeout = '3s';

create index if not exists qorpera_runtime_machine_allocations_login_identity_adapter
	on public.qorpera_runtime_machine_allocations (login_compute_identity_id, provider_adapter)
	where login_compute_identity_id is not null;

create index if not exists qorpera_runner_jobs_queued_created
	on public.qorpera_runner_jobs (created_at, id)
	where status = 'queued';

create index if not exists qorpera_deleted_profile_object_gc_leases_expires
	on public.qorpera_deleted_profile_object_gc_leases (lease_expires_at);

create index if not exists qorpera_session_events_session_entry_id
	on public.qorpera_session_events (session_id, public.qorpera_memory_entry_id(body, event_id))
	where public.qorpera_memory_entry_id(body, event_id) is not null;

create index if not exists qorpera_session_events_session_part_entry_id
	on public.qorpera_session_events (session_id, (body ->> 'entryId'))
	where body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1';

create index if not exists qorpera_digital_post_letters_profile_received
	on public.qorpera_digital_post_letters (profile_id, received_at desc, id);

create index if not exists qorpera_digital_post_letters_kept_lease
	on public.qorpera_digital_post_letters (profile_id, write_lease_until)
	where status = 'kept' and write_lease_until is not null;

create index if not exists qorpera_folder_path_versions_move_in
	on public.qorpera_folder_path_versions (commit_id, prior_version)
	where op = 'move_in' and prior_version is not null;

create index if not exists qorpera_runner_assignments_offered_expires
	on public.qorpera_runner_assignments (expires_at)
	where status = 'offered';

create index if not exists qorpera_runner_job_claims_active_expires
	on public.qorpera_runner_job_claims (lease_expires_at)
	where status in ('claimed', 'assigned');

create index if not exists qorpera_profile_invitations_expires
	on public.qorpera_profile_invitations (expires_at);

create index if not exists qorpera_folder_object_gc_claimable
	on public.qorpera_folder_object_gc (unreferenced_since, profile_id, sha256 collate "C");

create index if not exists qorpera_coding_executors_owner_env
	on public.qorpera_coding_executors (owner, environment_id);

create index if not exists qorpera_company_machines_stopped_task
	on public.qorpera_company_machines (updated_at, id)
	where desired_state = 'stopped' and lifetime = 'task' and removed_at is null;

create index if not exists qorpera_folder_connection_file_work_dirty
	on public.qorpera_folder_connection_file_work (updated_at, secret_id)
	where dirty;

create index if not exists qorpera_folder_connection_file_work_profile
	on public.qorpera_folder_connection_file_work (profile_id);

create index if not exists qorpera_coding_results_files_due
	on public.qorpera_coding_results_files (created_at, worker_id);

create index if not exists qorpera_execution_runs_profile_created
	on public.qorpera_execution_runs (profile_id, created_at desc);

create index if not exists qorpera_execution_runs_profile_staff_created
	on public.qorpera_execution_runs (profile_id, staff_agent_id, created_at desc);

create index if not exists qorpera_wake_occurrences_queued_company_file
	on public.qorpera_wake_occurrences (routine_id, routine_version, created_at, id)
	where source_kind = 'company-file' and status = 'queued' and run_id is null;

create index if not exists qorpera_bank_transactions_profile_booked
	on public.qorpera_bank_transactions (profile_id, booked_on desc);

create index if not exists qorpera_company_storage_deletions_claim
	on public.qorpera_company_storage_deletions (attempts, requested_at, bucket, object_path)
	where removed_at is null;

create index if not exists qorpera_member_notifications_open_run_no_progress
	on public.qorpera_member_notifications (profile_id, dedupe_key)
	where kind = 'run_no_progress' and acknowledged_at is null;

create index if not exists qorpera_member_notifications_dedupe_history
	on public.qorpera_member_notifications (profile_id, user_id, kind, dedupe_key);
