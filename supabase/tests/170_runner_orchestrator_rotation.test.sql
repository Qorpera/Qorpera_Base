begin;

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;

select public.qorpera_register_runner_orchestrator(
	'17000000-0000-4000-8000-000000000001',
	'Rotation fixture', 'managed', repeat('a', 64), 300
);

select public.qorpera_rotate_runner_orchestrator_control(
	'17000000-0000-4000-8000-000000000001',
	repeat('a', 64), repeat('b', 64), 604800
);

do $$
begin
	if public.qorpera_runner_orchestrator_control_valid(
		'17000000-0000-4000-8000-000000000001', repeat('a', 64)
	) or not public.qorpera_runner_orchestrator_control_valid(
		'17000000-0000-4000-8000-000000000001', repeat('b', 64)
	) then
		raise exception 'orchestrator control token rotation did not replace authority';
	end if;
end
$$;

-- A retry authenticated by the already-installed token is exact and safe.
select public.qorpera_rotate_runner_orchestrator_control(
	'17000000-0000-4000-8000-000000000001',
	repeat('b', 64), repeat('b', 64), 604800
);

rollback;
