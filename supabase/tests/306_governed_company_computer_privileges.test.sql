-- Run after the Step 2 migrations, including the independent broker role.
-- A production-schema replay also exercises the retained legacy trigger.
begin;

do $$
declare
	v_guard regprocedure := to_regprocedure('public.qorpera_company_computer_binding_guard()');
	v_role text;
	v_functions text[];
begin
	if v_guard is not null then
		if not exists (
			select 1 from pg_proc where oid = v_guard and prorettype = 'trigger'::regtype
		) then
			raise exception 'Retained Company Computer guard changed its signature';
		end if;
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_guard, 'EXECUTE') then
				raise exception 'Legacy Company Computer guard is exposed to %', v_role;
			end if;
		end loop;
		if not exists (select 1 from pg_trigger where tgfoid = v_guard and not tgisinternal) then
			raise exception 'Legacy Company Computer guard lost its existing trigger';
		end if;
	end if;

	-- Distinct names: Step 7 added a second signature of the capture completion
	-- (account label); it is the same custody call, not a new capability.
	select array_agg(distinct function.proname::text order by function.proname::text) into v_functions
	from pg_proc as function
	join pg_namespace as namespace on namespace.oid = function.pronamespace
	where namespace.nspname = 'public'
		and function.proname like 'qorpera_%'
		and has_function_privilege('qorpera_secret_broker', function.oid, 'EXECUTE');
	if v_functions is distinct from array[
		'qorpera_authorize_cloud_secret_operation',
		'qorpera_complete_cloud_secret_capture',
		'qorpera_describe_cloud_secret_capture'
	]::text[] then
		raise exception 'Broker inherited a function outside its three fixed custody calls';
	end if;
	if has_schema_privilege('qorpera_secret_broker', 'public', 'CREATE') then
		raise exception 'Broker can create objects in the public schema';
	end if;
end
$$;

rollback;
