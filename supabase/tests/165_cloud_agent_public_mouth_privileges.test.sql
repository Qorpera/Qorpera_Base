begin;

do $$
declare
	v_function text;
	v_role text;
begin
	foreach v_function in array array[
		'public.qorpera_send_runner_agent_message(uuid,text,uuid,text,uuid,text,text,text)',
		'public.qorpera_send_native_agent_message(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)'
	] loop
		foreach v_role in array array['anon', 'authenticated'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception 'client role % can execute the cloud mouth: %', v_role, v_function;
			end if;
		end loop;
		if not has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception 'cloud service cannot execute the mouth: %', v_function;
		end if;
	end loop;
	foreach v_function in array array[
		'public.qorpera_enforce_agent_send_event()',
		'public.qorpera_require_final_agent_send()'
	] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception 'API role % can directly execute a mouth trigger: %', v_role, v_function;
			end if;
		end loop;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_table_privilege(v_role, 'public.qorpera_agent_sends', 'INSERT,UPDATE,DELETE,TRUNCATE') then
			raise exception 'API role % can mutate send receipts outside the mouth', v_role;
		end if;
	end loop;
end
$$;

rollback;
