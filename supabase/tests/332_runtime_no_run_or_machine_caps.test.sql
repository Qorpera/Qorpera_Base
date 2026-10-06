-- No run, machine or API-key caps (runtime v92, 2026-09-24). A company has no
-- running-machine limit (node capacity is the only bound), an API-key
-- connection has no monthly budget and no per-run call, token or cost cap
-- (its concurrency stays; see SQL 330), and a run has no deadline: neither a
-- run nor its native connection lease is bounded by 24 hours, and usage of a
-- run longer than a day is recorded as is. A run reads, asks its model, hires
-- and opens group chats without a count.
begin;

do $$
declare v_default text; v_check text; v_lease_check text;
begin
	if to_regclass('public.qorpera_company_machine_limits') is not null
		or to_regprocedure('public.qorpera_set_company_machine_limit(uuid,integer,bigint)') is not null
		or to_regprocedure('public.qorpera_company_machine_capacity(uuid)') is not null then
		raise exception 'A company machine limit object still exists'; end if;
	-- Only the operator's history of past refusals may still name the old refusal.
	if exists (select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and (procedure.prosrc like '%max_machines%' or procedure.prosrc like '%machine-capacity/v1%'
				or (procedure.prosrc like '%MACHINE_CAPACITY_EXHAUSTED%'
					and procedure.oid <> 'public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)'::regprocedure))) then
		raise exception 'A function still enforces the company machine limit'; end if;
	if exists (select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and procedure.proname in ('qorpera_reserve_runtime_machine','qorpera_reserve_runtime_login_machine',
				'qorpera_reserve_runtime_account_refresh_machine','qorpera_authorize_coding_machine')
			and procedure.prosrc not like '%qorpera_company_execution_paused%'
			and procedure.proname <> 'qorpera_authorize_coding_machine') then
		raise exception 'Machine admission lost the pause'; end if;

	-- API-key runs: the model gateway meters but never refuses or ends a run over a per-run budget.
	if (select prosrc from pg_proc where oid = 'public.qorpera_runner_broker_reserve_model_request(uuid,text,uuid,text,uuid,text,text,text,bigint,bigint)'::regprocedure)
			like '%v_policy.max_calls%'
		or (select prosrc from pg_proc where oid = 'public.qorpera_runner_broker_finalize_model_request(uuid,text,uuid,text,uuid,text,text,bigint,bigint,bigint,jsonb,text)'::regprocedure)
			like '%least(v_policy.max_cost_microusd%'
		or (select prosrc from pg_proc where oid = 'public.qorpera_runner_model_gateway_authority(uuid)'::regprocedure)
			not like '%9007199254740991%'
		or (select prosrc from pg_proc where oid = 'public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure)
			like '%monthly_microusd%' then
		raise exception 'An API-key budget or per-run cap is still enforced'; end if;

	-- No run deadline, no 24 h native lease, no 24 h usage bound.
	select column_default into strict v_default from information_schema.columns
	where table_schema = 'public' and table_name = 'qorpera_execution_runs' and column_name = 'deadline_at';
	select pg_get_constraintdef(oid) into strict v_check from pg_constraint where conname = 'qorpera_execution_runs_check2';
	select pg_get_constraintdef(oid) into strict v_lease_check from pg_constraint
	where conname = 'qorpera_native_provider_connection_leases_check';
	if v_default not like '%100 years%' or v_check like '%24:00:00%' or v_lease_check like '%24:00:00%' then
		raise exception 'A 24 h run or lease bound remains: % / % / %', v_default, v_check, v_lease_check; end if;
	if exists (select 1 from information_schema.columns where table_schema = 'public'
			and table_name = 'qorpera_runner_usage_observations' and column_name in ('execution_ms','wall_time_limit_ms')
			and data_type <> 'bigint')
		or exists (select 1 from pg_constraint where conrelid = 'public.qorpera_runner_usage_observations'::regclass
			and pg_get_constraintdef(oid) like '%86400000%')
		or (select prosrc from pg_proc where oid = 'public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure)
			like '%86400000%' then
		raise exception 'Usage of a run longer than a day would be refused'; end if;

	-- No per-run count on reads, model requests, hires or group chats (SQL 334 and 375 run them).
	if exists (select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and (procedure.prosrc like '%Read observation budget exceeded%'
				or procedure.prosrc like '%context read set is full%'
				or procedure.prosrc like '%cardinality(p_paths) > 128%'
				or procedure.prosrc like '%Context view budget exceeded%'
				or procedure.prosrc like '%reached its limit for new%'))
		or exists (select 1 from pg_constraint where conname = 'qorpera_native_context_views_ordinal_check'
			and pg_get_constraintdef(oid) like '%256%') then
		raise exception 'A per-run count on reads, model requests or hires remains'; end if;

	-- No worker turn, dispatch or per-todo count; no 16-agent chain anywhere a chain is read back.
	if exists (select 1 from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and (procedure.prosrc like '%Worker dispatch limit for this hour%'
				or procedure.prosrc like '%already has eight workers%'
				or procedure.prosrc like '%v_worker.sequence >= 12%'
				or procedure.prosrc like '%v_worker.sequence >= 64%'
				or procedure.prosrc like '%causal_agent_ids) not between 1 and 16%'
				or procedure.prosrc like '%cardinality(v_agents) >= 16%'
				or procedure.prosrc like '%Office continuation ancestry exceeds its bound%between 0 and 7%'))
		or exists (select 1 from pg_constraint where conname in ('qorpera_runtime_workers_sequence_check',
			'qorpera_runtime_worker_events_sequence_check') and pg_get_constraintdef(oid) ~ '<=') then
		raise exception 'A worker or chain count remains'; end if;
	-- Waiting to start is bounded from the last time a job was queued, which every requeue records.
	-- (The usage-limit handoff, the other requeue path, is gone since 20260930059000.)
	if (select count(*) from pg_proc where oid = 'public.qorpera_terminalize_runner_attempt_before_native_start(uuid,text,text,boolean)'::regprocedure
			and prosrc like '%queued_at = statement_timestamp()%') <> 1 then
		raise exception 'A requeue path does not record when the job was queued again'; end if;
end
$$;

-- A notice kind for the removed machine limit is refused.
insert into auth.users(id,email) values ('33200000-0000-4000-8000-000000000001','caps-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('33200000-0000-4000-8000-000000000010','Caps fixture','33200000-0000-4000-8000-000000000001');
do $$
begin
	insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
	values ('33200000-0000-4000-8000-000000000010','33200000-0000-4000-8000-000000000001','company_ceiling_tripped','{}','removed');
	raise exception 'The removed machine-capacity notice kind was accepted';
exception when check_violation then null;
end
$$;

rollback;
