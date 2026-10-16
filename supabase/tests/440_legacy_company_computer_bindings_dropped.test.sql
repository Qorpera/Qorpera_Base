-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Legacy sweep D16 (20260930415000): the governed Company Computer and the legacy computer teardown are gone, with
-- their tables, functions and triggers. Only a governed binding admitted company computer work, so on the base's run,
-- its runner and the runner's assignment worker class company_computer stays refused, with the old errors; an existing
-- company computer runner may still be revoked. A turn request has the run's guard function and trigger (pinned in 1);
-- a folder-v2 run has no turn request.

-- 1. Gone.
do $$
begin
	perform pg_temp.base_assert(to_regclass('public.qorpera_governed_company_computers') is null
		and to_regclass('public.qorpera_legacy_company_computer_teardowns') is null, 'the binding tables are gone');
	perform pg_temp.base_assert(not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in (
		'qorpera_governed_company_computer_policy', 'qorpera_governed_company_computer_matches',
		'qorpera_guard_governed_company_computer_update', 'qorpera_register_governed_company_computer',
		'qorpera_describe_governed_company_computer', 'qorpera_legacy_company_computer_authority_sha256',
		'qorpera_legacy_company_computer_teardown_matches', 'qorpera_register_legacy_company_computer_teardown',
		'qorpera_guard_legacy_company_computer_teardown', 'qorpera_guard_torn_down_legacy_company_computer',
		'qorpera_guard_torn_down_legacy_computer_work', 'qorpera_guard_torn_down_legacy_computer_assignment')),
		'the bindings'' functions are gone');
	perform pg_temp.base_assert(not exists (select 1 from pg_trigger where not tgisinternal
		and (tgname like 'qorpera_guard_torn_down_legacy_%' or tgname = 'qorpera_guard_governed_company_computer_update')),
		'the bindings'' triggers are gone');
	-- The work guards keep their triggers, so their place in the firing order.
	perform pg_temp.base_assert((select count(*) from pg_trigger where not tgisinternal and tgname in (
		'qorpera_governed_company_computer_turn_request', 'qorpera_governed_company_computer_execution_run',
		'qorpera_governed_company_computer_runner', 'qorpera_governed_company_computer_assignment')) = 4,
		'the work guards keep their four triggers');
end
$$;

-- 2. Company computer work stays refused.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set worker_class = %L where id = %L',
		'company_computer', v_binding ->> 'runId'), '42501', 'Company computer work requires cloud-governed path mediation');
	perform pg_temp.base_error(format('update public.qorpera_runners set worker_class = %L where id = %L',
		'company_computer', v_binding ->> 'runnerId'), '42501', 'Company computer runner requires cloud-governed path mediation');

	-- A company computer runner from before, made here without the triggers: its assignment and any change but its
	-- revocation are refused.
	set local session_replication_role = replica;
	update public.qorpera_runners set worker_class = 'company_computer' where id = (v_binding ->> 'runnerId')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.base_error(format('update public.qorpera_runner_assignments set runner_id = runner_id where id = %L',
		v_binding ->> 'assignmentId'), '42501', 'Company computer assignment requires cloud-governed path mediation');
	perform pg_temp.base_error(format('update public.qorpera_runners set worker_class = worker_class where id = %L',
		v_binding ->> 'runnerId'), '42501', 'Company computer runner requires cloud-governed path mediation');
	update public.qorpera_runners
	set status = 'revoked', session_token_sha256 = null, session_expires_at = null,
		previous_session_token_sha256 = null, previous_session_expires_at = null,
		last_renewal_id = null, revoked_by_user_id = '92400000-0000-4000-8000-000000000001', revoked_at = statement_timestamp()
	where id = (v_binding ->> 'runnerId')::uuid;
	perform pg_temp.base_assert((select status = 'revoked' from public.qorpera_runners where id = (v_binding ->> 'runnerId')::uuid),
		'the company computer runner is revoked');
end
$$;

rollback;
