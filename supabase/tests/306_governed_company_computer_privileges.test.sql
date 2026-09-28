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

	-- Exact signatures, not names: Step 7 added a second signature of the
	-- capture completion (account label), and a name-only check would also pass
	-- any other overload the broker inherited. Bundle v88 added the coding
	-- executor's repository credential. Member-reviewed email adds only the
	-- capability-bound claim and provider-receipt completion functions. Model
	-- logins in the vault (Stateless Compute step 1) add handing a live run its
	-- login and saving or giving back one renewal.
	select array_agg(function.oid::regprocedure::text order by function.oid::regprocedure::text collate "C") into v_functions
	from pg_proc as function
	join pg_namespace as namespace on namespace.oid = function.pronamespace
	where namespace.nspname = 'public'
		and function.proname like 'qorpera_%'
		and has_function_privilege('qorpera_secret_broker', function.oid, 'EXECUTE');
	if v_functions is distinct from array[
		'qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)',
		'qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)',
		'qorpera_claim_email_draft_action(uuid,text,uuid,text)',
		'qorpera_commit_model_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamp with time zone,timestamp with time zone)',
		'qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)',
		'qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)',
		'qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)',
		'qorpera_finish_email_draft_action(uuid,text,uuid,text,jsonb)',
		'qorpera_issue_model_login(uuid,text,jsonb,bigint,boolean)',
		'qorpera_release_model_login_renewal(uuid,text,uuid,uuid,boolean,text)'
	]::text[] then
		raise exception 'Broker inherited a function outside its fixed custody calls';
	end if;
	if has_schema_privilege('qorpera_secret_broker', 'public', 'CREATE') then
		raise exception 'Broker can create objects in the public schema';
	end if;
end
$$;

rollback;
