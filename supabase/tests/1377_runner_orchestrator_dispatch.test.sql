begin;

do $$
declare
	v_orch_id uuid := '13770000-0000-4000-8000-000000000001';
	v_token_sha text := repeat('a', 64);
	v_result jsonb;
	v_code text;
begin
	if has_function_privilege('anon', 'public.qorpera_runner_orchestrator_dispatch(uuid,text,text,jsonb)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_runner_orchestrator_dispatch(uuid,text,text,jsonb)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_runner_orchestrator_dispatch(uuid,text,text,jsonb)', 'execute') then
		raise exception 'dispatch privilege mismatch';
	end if;

	perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', true);
	perform public.qorpera_register_runner_orchestrator(v_orch_id, 'Dispatch fixture', 'managed', v_token_sha, 300);

	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin
		perform public.qorpera_runner_orchestrator_dispatch(v_orch_id, v_token_sha, 'qorpera_orchestrator_due_summary', '{}'::jsonb);
		raise exception 'expected non-service_role refusal';
	exception when sqlstate '42501' then
		null;
	end;

	perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', true);
	begin
		perform public.qorpera_runner_orchestrator_dispatch(v_orch_id, repeat('b', 64), 'qorpera_orchestrator_due_summary', '{}'::jsonb);
		raise exception 'expected invalid token refusal';
	exception when sqlstate '42501' then
		null;
	end;

	v_result := public.qorpera_runner_orchestrator_dispatch(v_orch_id, v_token_sha, 'qorpera_orchestrator_due_summary', '{}'::jsonb);
	if v_result is distinct from public.qorpera_orchestrator_due_summary() then
		raise exception 'dispatch due_summary result mismatch: %', v_result;
	end if;

	begin
		perform public.qorpera_runner_orchestrator_dispatch(v_orch_id, v_token_sha, 'qorpera_unknown_rpc', '{}'::jsonb);
		raise exception 'expected unknown rpc refusal';
	exception when others then
		get stacked diagnostics v_code = returned_sqlstate;
		if v_code <> 'QRD01' then
			raise exception 'expected QRD01 for unknown rpc, got %', v_code;
		end if;
	end;
end $$;

rollback;
