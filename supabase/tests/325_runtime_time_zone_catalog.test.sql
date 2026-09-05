begin;
do $$
declare v_name text; v_bad jsonb; v_listener jsonb; v_schedule jsonb; v_role text;
begin
	if exists ((select name from pg_catalog.pg_timezone_names
		except select name from public.qorpera_runtime_time_zone_names)
		union all (select name from public.qorpera_runtime_time_zone_names
		except select name from pg_catalog.pg_timezone_names)) then
		raise exception 'Runtime timezone catalog differs from PostgreSQL'; end if;
	if (select count(*) from public.qorpera_runtime_time_zone_names) < 500 then
		raise exception 'Timezone parity fixture has insufficient coverage'; end if;
	v_listener := '{"id":"changes","kind":"listener","source":"company-file","path":"reports","match":"subtree","timeZone":"UTC","replyPolicy":"silent"}';
	v_schedule := '{"id":"tick","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"09:00","timeZone":"UTC","replyPolicy":"silent"}';
	for v_name in select name from public.qorpera_runtime_time_zone_names loop
		if not public.qorpera_runtime_time_zone_name_valid(v_name)
			or not public.qorpera_cloud_routine_trigger_valid(jsonb_set(v_listener,'{timeZone}',to_jsonb(v_name)))
			or not public.qorpera_cloud_routine_trigger_valid(jsonb_set(v_schedule,'{timeZone}',to_jsonb(v_name))) then
			raise exception 'Valid PostgreSQL timezone rejected: %',v_name; end if;
	end loop;
	for v_bad in select value from jsonb_array_elements('[null,0,true,[],{},"","auto"," europe/Copenhagen","Europe/Copenhagen ","Europe/copenhagen","UTC0","+02:00","Definitely/Invalid"]') loop
		if public.qorpera_cloud_routine_trigger_valid(jsonb_set(v_listener,'{timeZone}',v_bad))
			or public.qorpera_cloud_routine_trigger_valid(jsonb_set(v_schedule,'{timeZone}',v_bad)) then
			raise exception 'Invalid or non-canonical timezone accepted: %',v_bad; end if;
	end loop;
	if public.qorpera_runtime_time_zone_name_valid(null)
		or public.qorpera_cloud_routine_trigger_valid(v_listener || '{"replyPolicy":"invented"}')
		or public.qorpera_cloud_routine_trigger_valid(v_listener || '{"match":"invented"}')
		or public.qorpera_cloud_routine_trigger_valid(v_schedule || '{"intervalMinutes":4}')
		or public.qorpera_cloud_routine_trigger_valid(v_schedule || '{"weekdays":["monday","monday"]}')
		or public.qorpera_cloud_routine_trigger_valid(v_schedule || '{"localTime":"25:00"}') then
		raise exception 'Existing trigger constraints were weakened'; end if;
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_table_privilege(v_role,'public.qorpera_runtime_time_zone_names','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
			or has_function_privilege(v_role,'public.qorpera_runtime_time_zone_name_valid(text)','EXECUTE') then
			raise exception 'API role has direct catalog authority: %',v_role; end if;
	end loop;
	for v_name in select pg_get_functiondef(oid) from pg_proc where oid in (
		'public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure,
		'public.qorpera_cloud_routine_trigger_before_wake_bus(jsonb)'::regprocedure,
		'public.qorpera_runtime_time_zone_name_valid(text)'::regprocedure) loop
		if v_name like '%pg_catalog.pg_timezone_names%' then
			raise exception 'Runtime validation still computes the full timezone catalog'; end if;
	end loop;
end $$;
-- A caller authorized only for the existing validator can use it while the
-- newly introduced implementation table and predicate remain inaccessible.
create role runtime_timezone_caller nologin;
grant usage on schema public to runtime_timezone_caller;
grant execute on function public.qorpera_cloud_routine_trigger_valid(jsonb) to runtime_timezone_caller;
set local role runtime_timezone_caller;
do $$ begin
	if has_table_privilege(current_user,'public.qorpera_runtime_time_zone_names','SELECT')
		or has_function_privilege(current_user,'public.qorpera_runtime_time_zone_name_valid(text)','EXECUTE') then
		raise exception 'Validator caller gained catalog access'; end if;
	if not public.qorpera_cloud_routine_trigger_valid('{"id":"changes","kind":"listener","source":"company-file","path":"reports","match":"subtree","timeZone":"Europe/Copenhagen","replyPolicy":"silent"}')
		or not public.qorpera_cloud_routine_trigger_valid('{"id":"tick","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"09:00","timeZone":"Europe/Copenhagen"}') then
		raise exception 'Split-owner validation requires unintended caller privileges'; end if;
end $$;
reset role;
rollback;
