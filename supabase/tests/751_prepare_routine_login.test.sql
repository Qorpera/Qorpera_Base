-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Company state files, F2-1b part B: before the runtime commits a routine file, it sets up the login the run's requester
-- pays with for unattended work, as an agent's routine save does today (qorpera_ensure_unattended_sponsor), because the
-- commit reads it without a lock (qorpera_company_state_routine_payer).

-- The wake's work gate holds: nothing is set up before the run acknowledges.
select pg_temp.wake_error($q$select public.qorpera_prepare_routine_login(current_setting('qorpera_test.wake_binding')::jsonb)$q$, '55000',
	'Wake requires an acknowledgement before work');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb, 'progress', 'login-ack');

do $$
declare v_run public.qorpera_execution_runs; v_connection uuid; v_prepared jsonb; v_again jsonb; v_bindings bigint;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	v_connection := (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid;
	-- The member's login never consented to unattended work: a newer version without it, as before today.
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":3,"allow_autonomous":false}'::jsonb)).*
	from public.qorpera_provider_connection_versions v where connection_id = v_connection and version = 2;
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_agent_routine_sponsor(v_run))
		and not exists (select 1 from public.qorpera_company_state_routine_payer(v_run.profile_id, v_run.requested_by_user_id,
			v_run.sponsor_binding_id)), 'Fixture: nothing pays for unattended work yet');

	v_prepared := public.qorpera_prepare_routine_login(current_setting('qorpera_test.wake_binding')::jsonb);
	perform pg_temp.wake_assert(v_prepared ->> 'schema' = 'qorpera.routine-login/v1' and (v_prepared ->> 'runId')::uuid = v_run.id
		and jsonb_typeof(v_prepared -> 'login') = 'object', 'The run''s requester has a login set up');
	perform pg_temp.wake_assert((select allow_autonomous and consented_by_user_id = v_run.requested_by_user_id
			and consent_version = 'qorpera-unattended-default/v1'
		from public.qorpera_provider_connection_versions where connection_id = v_connection order by version desc limit 1),
		'Consent is recorded as a new version in the account owner''s name');
	-- The routine save's payer (the rule qorpera_agent_routine_sponsor reads, without its lock; the run's own login first,
	-- as a save by the run asks) finds the same login, as does today's routine save.
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_state_routine_payer(v_run.profile_id,
			v_run.requested_by_user_id, v_run.sponsor_binding_id) p
		where p.binding_id = (v_prepared -> 'login' ->> 'bindingId')::uuid and p.version = (v_prepared -> 'login' ->> 'version')::bigint)
		and exists (select 1 from public.qorpera_agent_routine_sponsor(v_run) p
		where p.binding_id = (v_prepared -> 'login' ->> 'bindingId')::uuid and p.version = (v_prepared -> 'login' ->> 'version')::bigint),
		'The routine save finds the login set up');
	-- A retry sets up nothing more.
	select count(*) into v_bindings from public.qorpera_execution_sponsor_bindings;
	v_again := public.qorpera_prepare_routine_login(current_setting('qorpera_test.wake_binding')::jsonb);
	perform pg_temp.wake_assert(v_again -> 'login' = v_prepared -> 'login'
		and (select count(*) from public.qorpera_execution_sponsor_bindings) = v_bindings, 'A retry finds the same login');
end $$;

-- Only the runtime's service calls it, with a run binding.
select pg_temp.wake_error($q$select public.qorpera_prepare_routine_login('{}')$q$, '22023');
set local role authenticated;
do $$
begin
	perform public.qorpera_prepare_routine_login(current_setting('qorpera_test.wake_binding')::jsonb);
	raise exception 'Members cannot call it';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
