-- @fixture 708_folder_state_routines.test.sql until "-- 1. The company and two agents"
-- WHY: Verify batched follow-up convergence, run-scoped follow-up kick, wake triggers, combined founding open+vision, and fail-open mail/invitation pg_net kicks.

create function pg_temp.save_w4(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('70700000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70700000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;

create function pg_temp.hire_w4(p_handle text, p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_handle, 'agent', 'active'))),
			jsonb_build_object('path','routines','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_handle, 'agent', 'active'), pg_temp.agent_parse(p_id, p_handle, 'agent', 'active'))))
$$;

do $$
declare
	v_seed jsonb;
	v_units jsonb := '[]'::jsonb;
	v_i integer;
	v_agent uuid;
	v_commit jsonb;
	v_step jsonb;
	v_auth_before bigint;
	v_auth_after bigint;
begin
	v_seed := pg_temp.commit('{"kind":"platform"}', 'w4-seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','QorperaOS'),
		jsonb_build_object('op','mkdir','path','QorperaOS/vision'),
		pg_temp.vision('Nordlys W4'),
		jsonb_build_object('op','mkdir','path','QorperaOS/agents'),
		pg_temp.write('QorperaOS/agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70700000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')
	));
	if exists (select 1 from jsonb_array_elements(v_seed -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Expected W4 seed commit to save: %', v_seed;
	end if;
	for v_i in 1..12 loop
		v_agent := ('13870000-0000-4000-8000-' || lpad(v_i::text, 12, '0'))::uuid;
		v_units := v_units || jsonb_build_array(pg_temp.hire_w4('team-' || v_i::text, v_agent));
	end loop;
	v_commit := pg_temp.save_w4(pg_temp.owner(), 'w4-hire-team-12', v_units);
	if exists (select 1 from jsonb_array_elements(v_commit -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Expected all 12 team hires to save: %', v_commit;
	end if;
	select count(*) into v_auth_before
	from public.qorpera_folder_journal
	where environment_id = '70700000-0000-4000-8000-000000000020' and kind = 'authority';

	perform set_config('request.jwt.claims', '', true);
	v_step := public.qorpera_folder_follow_up_step();
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	if (v_step ->> 'convergedCount')::integer <> 12
		or jsonb_array_length(v_step -> 'convergedItems') <> 12
		or v_step -> 'converged' is null
		or v_step #>> '{converged,result}' <> 'done' then
		raise exception 'Expected 12 hires to converge in one batched step: %', v_step;
	end if;
	if exists (
		select 1 from public.qorpera_folder_follow_ups w
		where w.environment_id = '70700000-0000-4000-8000-000000000020' and w.dirty
	) then
		raise exception 'Expected zero dirty follow-ups after batched step';
	end if;
	select count(*) into v_auth_after
	from public.qorpera_folder_journal
	where environment_id = '70700000-0000-4000-8000-000000000020' and kind = 'authority';
	if v_auth_after <> v_auth_before + 1 then
		raise exception 'Expected one coalesced authority journal row for 12 hires, got %', v_auth_after - v_auth_before;
	end if;
end $$;

do $$
declare
	v_agent uuid := '13870000-0000-4000-8000-000000000099';
	v_step1 jsonb;
	v_step2 jsonb;
begin
	perform pg_temp.save_w4(pg_temp.owner(), 'w4-mixed-company-agent', jsonb_build_array(
		pg_temp.hire_w4('solo-mix', v_agent),
		pg_temp.vision('Nordlys Batched Rename')
	));
	perform set_config('request.jwt.claims', '', true);
	v_step1 := public.qorpera_folder_follow_up_step();
	v_step2 := public.qorpera_folder_follow_up_step();
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if (v_step1 ->> 'convergedCount')::integer <> 1 or (v_step2 ->> 'convergedCount')::integer <> 1 then
		raise exception 'Expected company subject to remain isolated from agent subjects: % / %', v_step1, v_step2;
	end if;
	if (select name from public.qorpera_profiles where id = '70700000-0000-4000-8000-000000000010') <> 'Nordlys Batched Rename' then
		raise exception 'Expected company rename to converge';
	end if;
end $$;

do $$
declare
	v_routine uuid := '13870000-0000-4000-8000-000000000150';
	v_hired uuid := '13870000-0000-4000-8000-000000000151';
	v_run_actor jsonb;
	v_commit jsonb;
	v_commit_id uuid;
	v_kick jsonb;
begin
	perform public.qorpera_set_provider_execution_policy(
		'openai', 'native_subscription', 'codex-cli', 'supported', 'enabled', 32, null, 'w4-fixture'
	);
	perform pg_temp.save_w4(pg_temp.owner(), 'w4-routine-for-run-kick', jsonb_build_array(
		pg_temp.routine(
			'QorperaOS/agents/team-1/routines/kick.md',
			pg_temp.rparse(v_routine, 'Kick Hire', pg_temp.every(60))
		)
	));
	v_run_actor := pg_temp.routine_run(v_routine);
	v_commit := pg_temp.reviewed(
		v_run_actor,
		'w4-run-commit-hire',
		jsonb_build_array(pg_temp.hire_w4('run-kicked', v_hired))
	);
	if v_commit #>> '{units,0,outcome}' <> 'saved' then
		raise exception 'Expected reviewed run hire commit to save: %', v_commit;
	end if;
	v_commit_id := (v_commit ->> 'commitId')::uuid;
	begin
		perform public.qorpera_folder_follow_up_run_commit(
			'70700000-0000-4000-8000-000000000020',
			jsonb_build_object('kind', 'run', 'runId', '13870000-0000-4000-8000-000000000199'),
			v_commit_id
		);
		raise exception 'Expected mismatched runId to be refused';
	exception when insufficient_privilege then
		null;
	end;
	v_kick := public.qorpera_folder_follow_up_run_commit(
		'70700000-0000-4000-8000-000000000020',
		v_run_actor,
		v_commit_id
	);
	if v_kick ->> 'result' <> 'done'
		or (v_kick ->> 'convergedCount')::integer <> 1
		or (v_kick ->> 'more')::boolean is not false then
		raise exception 'Expected run commit follow-up kick to converge immediately: %', v_kick;
	end if;
	if exists (
		select 1 from public.qorpera_folder_follow_ups w
		where w.environment_id = '70700000-0000-4000-8000-000000000020'
			and w.subject_kind = 'agent'
			and w.subject_id = v_hired
			and w.dirty
	) then
		raise exception 'Expected run-kicked agent follow-up to be clean after immediate kick';
	end if;
end $$;

do $$
declare
	v_fn text;
begin
	if not exists (
		select 1 from public.qorpera_native_host_calls
		where name = 'qorpera_folder_follow_up_run_commit' and scope = 'folder' and budget = 'standard'
	) then
		raise exception 'qorpera_folder_follow_up_run_commit must be listed in qorpera_native_host_calls';
	end if;
	if has_function_privilege('anon', 'public.qorpera_folder_follow_up_run_commit(uuid,jsonb,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_follow_up_run_commit(uuid,jsonb,uuid)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_follow_up_run_commit(uuid,jsonb,uuid)', 'execute') then
		raise exception 'qorpera_folder_follow_up_run_commit has wrong role privileges';
	end if;
	foreach v_fn in array array[
		'public.qorpera_folder_follow_up_converge_inner(public.qorpera_folder_follow_ups,boolean)',
		'public.qorpera_wake_coding_executors_internal()',
		'public.qorpera_wake_object_gateway_internal()',
		'public.qorpera_notify_shared_vault_internal()',
		'public.qorpera_mail_outbox_kick()',
		'public.qorpera_profile_invitation_email_kick()'
	] loop
		if has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute')
			or has_function_privilege('service_role', v_fn, 'execute') then
			raise exception 'Internal helper % must not be executable by API roles', v_fn;
		end if;
	end loop;
end $$;

do $$
declare
	v_missing text;
begin
	select string_agg(t.rel || ':' || t.trg, ', ') into v_missing
	from (values
		('qorpera_surface_reconciliations', 'qorpera_surface_reconciliations_insert_wake_orchestrators'),
		('qorpera_surface_reconciliations', 'qorpera_surface_reconciliations_status_wake_orchestrators'),
		('qorpera_surface_automations', 'qorpera_surface_automations_insert_wake_orchestrators'),
		('qorpera_surface_automations', 'qorpera_surface_automations_update_wake_orchestrators'),
		('qorpera_folder_journal', 'qorpera_folder_journal_insert_wake_orchestrators'),
		('qorpera_runtime_workers', 'qorpera_runtime_workers_insert_wake_orchestrators'),
		('qorpera_runtime_workers', 'qorpera_runtime_workers_update_wake_orchestrators'),
		('qorpera_coding_sessions', 'qorpera_coding_sessions_insert_wake_orchestrators'),
		('qorpera_coding_sessions', 'qorpera_coding_sessions_phase_wake_orchestrators'),
		('qorpera_coding_sessions', 'qorpera_coding_sessions_insert_wake_executors'),
		('qorpera_runner_jobs', 'qorpera_runner_jobs_terminal_wake_executors'),
		('qorpera_surface_previews', 'qorpera_surface_previews_insert_wake_executors'),
		('qorpera_surface_jobs', 'qorpera_surface_jobs_insert_wake_executors'),
		('qorpera_surface_reconciliations', 'qorpera_surface_reconciliations_insert_wake_executors'),
		('qorpera_company_machines', 'qorpera_company_machines_insert_wake_executors'),
		('qorpera_company_machines', 'qorpera_company_machines_wake_executors'),
		('qorpera_company_machine_placements', 'qorpera_company_machine_placements_insert_wake_executors'),
		('qorpera_folder_company_creations', 'qorpera_folder_company_creations_insert_wake_gateway'),
		('qorpera_coding_results_files', 'qorpera_coding_results_files_insert_wake_gateway'),
		('qorpera_folder_connection_file_marks', 'qorpera_folder_connection_file_marks_insert_wake_gateway'),
		('qorpera_surface_jobs', 'qorpera_surface_jobs_insert_wake_gateway'),
		('qorpera_surface_previews', 'qorpera_surface_previews_insert_wake_gateway'),
		('qorpera_profiles', 'qorpera_profiles_notify_shared_vault'),
		('qorpera_company_mail_outbox', 'qorpera_company_mail_outbox_kick'),
		('qorpera_profile_invitation_deliveries', 'qorpera_profile_invitation_deliveries_insert_kick'),
		('qorpera_profile_invitation_deliveries', 'qorpera_profile_invitation_deliveries_status_kick')
	) as t(rel, trg)
	where not exists (
		select 1 from pg_trigger tg
		where tg.tgrelid = ('public.' || t.rel)::regclass
			and tg.tgname = t.trg
			and not tg.tgisinternal
			and not tg.tgdeferrable
	);
	if v_missing is not null then
		raise exception 'Missing or deferrable W4-PR5 wake/kick triggers: %', v_missing;
	end if;
end $$;

do $$
declare
	v_table jsonb;
	v_table2 jsonb;
begin
	update auth.users
	set email_confirmed_at = coalesce(email_confirmed_at, clock_timestamp())
	where id = '70700000-0000-4000-8000-000000000001';
	perform set_config('request.jwt.claims',
		'{"role":"authenticated","sub":"70700000-0000-4000-8000-000000000001","email":"todos-owner@example.test"}', true);
	set local role authenticated;
	v_table := public.qorpera_open_company_founding(
		'13870000-0000-4000-8000-000000000201',
		'Combined Vision Co',
		'  Build instant workflows.  '
	);
	if v_table ->> 'vision' is distinct from 'Build instant workflows.'
		or v_table ->> 'companyName' is distinct from 'Combined Vision Co' then
		raise exception 'Expected combined open+vision result, got %', v_table;
	end if;
	v_table2 := public.qorpera_open_company_founding(
		'13870000-0000-4000-8000-000000000202',
		'Legacy Two Arg Co'
	);
	if v_table2 ->> 'vision' is distinct from ''
		or v_table2 ->> 'companyName' is distinct from 'Legacy Two Arg Co' then
		raise exception 'Expected 2-arg backward-compatible open result, got %', v_table2;
	end if;
	begin
		perform public.qorpera_open_company_founding(
			'13870000-0000-4000-8000-000000000203',
			'Too Long Vision',
			repeat('a', 16385)
		);
		raise exception 'Expected oversized vision to be refused';
	exception when invalid_parameter_value then
		null;
	end;
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

do $$
declare
	v_inv uuid := '13870000-0000-4000-8000-000000000301';
begin
	insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, expires_at)
	values (
		v_inv,
		'70700000-0000-4000-8000-000000000010',
		'w4-invite@example.test',
		'contributor',
		'70700000-0000-4000-8000-000000000001',
		clock_timestamp() + interval '7 days'
	);
	if not exists (
		select 1 from public.qorpera_profile_invitation_deliveries
		where invitation_id = v_inv and status = 'pending'
	) then
		raise exception 'Expected invitation delivery row to enqueue cleanly when pg_net is absent';
	end if;
end $$;

rollback;
