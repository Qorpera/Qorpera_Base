-- W4b: native workers read their parent and check its saved view through their own live binding.
-- The existing service-only readers retain their distinct names: native dispatch refuses overloaded functions.
-- This does not compose a worker's context or change its payer.
set local lock_timeout = '3s';

create function public.qorpera_folder_worker_parent_run(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	return public.qorpera_folder_worker_parent((v_tool #>> '{run,environment_id}')::uuid, v_tool -> 'actor');
end $$;
revoke all on function public.qorpera_folder_worker_parent_run(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_worker_parent_run(jsonb) to service_role;

-- A reference may include branches, so its conversations need not be the worker's own. The existing reader
-- validates all of them against the company derived from the binding, after the binding's run check.
create function public.qorpera_memory_view_reference_check_run(p_binding jsonb, p_view jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	return public.qorpera_memory_view_reference_check((v_tool #>> '{run,environment_id}')::uuid, p_view);
end $$;
revoke all on function public.qorpera_memory_view_reference_check_run(jsonb, jsonb)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_view_reference_check_run(jsonb, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_folder_worker_parent_run', 'binding'),
	('qorpera_memory_view_reference_check_run', 'binding');
