-- Exact pre-upgrade broker authority used only by the disposable Step 2 test.
do $$
declare
	v_definition text;
	v_old_guard text;
	v_new_guard text;
	v_target regprocedure;
begin
	foreach v_target in array array[
		'public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)'::regprocedure,
		'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)'::regprocedure,
		'public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure
	] loop
		v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
		v_new_guard := 'if session_user <> ''qorpera_secret_broker'' then';
		v_definition := pg_get_functiondef(v_target);
		if position(v_new_guard in v_definition) = 0 then
			raise exception 'hardened broker fixture source differs: %', v_target;
		end if;
		execute replace(v_definition,v_new_guard,v_old_guard);
	end loop;

	v_target := 'public.qorpera_native_connector_locked_grant(jsonb,uuid)'::regprocedure;
	v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
	v_new_guard := 'if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		raise exception 'hardened native connector fixture source differs';
	end if;
	execute replace(v_definition,v_new_guard,v_old_guard);

	v_target := 'public.qorpera_native_tool_locked_run(jsonb)'::regprocedure;
	v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
	v_new_guard := 'if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		raise exception 'hardened native tool binding fixture source differs';
	end if;
	execute replace(v_definition,v_new_guard,v_old_guard);
end
$$;

revoke all on function public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)
	from qorpera_secret_broker;
revoke all on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)
	from qorpera_secret_broker;
revoke all on function public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)
	from qorpera_secret_broker;
grant execute on function public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text) to service_role;
grant execute on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text) to service_role;
grant execute on function public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)
	to service_role;
