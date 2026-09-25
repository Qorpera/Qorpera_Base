-- Hiring, worker, and memory wrappers replaced the path policy function OID.
-- Existing SECURITY DEFINER callers retain their owners and authorization logic,
-- but grants to the former OID do not authorize calls to the current wrapper.
-- Only these reviewed, still-live direct callers need the internal helper.
-- Responsibility escalation callers were retired in 20260920070000.
do $$
declare v_caller regprocedure; v_owner name; v_definer boolean;
begin
	foreach v_caller in array array[
		'public.qorpera_company_path_require(jsonb,text,text)'::regprocedure,
		'public.qorpera_list_company_paths(uuid,text,text,uuid,integer,jsonb)'::regprocedure,
		'public.qorpera_list_member_company_path_commands(uuid,uuid,integer)'::regprocedure,
		'public.qorpera_list_company_path_proposals(uuid,uuid,integer)'::regprocedure,
		'public.qorpera_company_path_approved_actor(uuid,text)'::regprocedure,
		'public.qorpera_presence_path_routes(jsonb,text[],boolean)'::regprocedure,
		'public.qorpera_list_member_company_snapshot_paths(uuid,uuid,text,integer)'::regprocedure
	] loop
		select pg_get_userbyid(proowner),prosecdef into strict v_owner,v_definer
		from pg_proc where oid=v_caller;
		if not v_definer or v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Company path policy caller must have a trusted SECURITY DEFINER owner: %',v_caller;
		end if;
		execute format('grant execute on function public.qorpera_company_path_allowed(jsonb,text,text) to %I',v_owner);
	end loop;
end
$$;
