-- @fixture 290_company_file_path_gateway.test.sql until "-- Human content reads bind a current path/version"
-- One call before every model request (20260928339400). qorpera_fence_native_context makes, in one
-- transaction and in their order, the seven calls a runtime host made before: run authority and the
-- read set, again, the context view, again. Real admission, native start and first commit from 290.

set local role service_role;
select pg_temp.path_begin(current_setting('qorpera_test.path_binding')::jsonb);
reset role;

-- Only the service role calls it, like each call it makes.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)','EXECUTE')
				is distinct from (v_role = 'service_role') then
			raise exception 'One-call fence boundary is incorrect for %', v_role; end if;
	end loop;
end
$$;

create function pg_temp.fence_view(p_request text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.native-context-view/v1','requestId',p_request,'threadId','thread-1',
		'turnId','turn-1','purpose','turn','outputs','[]'::jsonb)
$$;
-- The seven calls as the host made them, each as it was, then the same answer shape.
create function pg_temp.fence_separate(p_binding jsonb, p_paths text[], p_view jsonb) returns jsonb language plpgsql as $$
declare v_environment uuid := '29000000-0000-4000-8000-000000000020'; v_receipt jsonb; v_authority jsonb;
begin
	perform public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(v_environment,p_binding,p_paths);
	perform public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(v_environment,p_binding,p_paths);
	v_receipt := public.qorpera_record_native_context_view(v_environment,p_binding,p_view);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	perform public.qorpera_assert_company_path_reads(v_environment,p_binding,p_paths);
	return jsonb_build_object('schema','qorpera.native-context-fence/v1','authority',v_authority,'receipt',v_receipt);
end
$$;
-- A call's answer (without its generated ids and times, and without the one call's "kept", which the
-- separate calls do not report and which is pinned below), or the SQLSTATE it refused with. Rolled back
-- either way.
create function pg_temp.fence_outcome(p_call text) returns text language plpgsql as $$
declare v_value jsonb;
begin
	begin
		execute p_call into v_value;
		raise exception using errcode = 'QTF00', message = ((v_value - 'kept') #- '{receipt,viewId}' #- '{authority,validForMs}')::text;
	exception when sqlstate 'QTF00' then return sqlerrm;
		when others then return sqlstate;
	end;
end
$$;

-- Parity: under each condition the one call answers exactly as the seven calls did, or refuses with
-- the same SQLSTATE.
do $$
declare v_binding jsonb; v_case text; v_paths text[]; v_view jsonb; v_separate text; v_one text; v_seen text[] := '{}';
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
begin
	foreach v_case in array array['current','claims','binding','lease','assignment','job','grant','expired-grant','resource',
		'staff','requester','sponsor','session','path','no-paths','view','replay'] loop
		begin
			v_binding := current_setting('qorpera_test.path_binding')::jsonb;
			v_paths := array['note.md'];
			v_view := pg_temp.fence_view('parity-' || v_case);
			perform pg_temp.path_claims('service_role');
			if v_case = 'claims' then
				perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
			elsif v_case = 'binding' then
				v_binding := v_binding || jsonb_build_object('leaseId',extensions.gen_random_uuid());
			elsif v_case = 'lease' then
				update public.qorpera_native_provider_connection_leases set status = 'revoked',released_at = clock_timestamp()
				where id = (v_binding ->> 'leaseId')::uuid;
			elsif v_case = 'assignment' then
				update public.qorpera_runner_assignments set expires_at = clock_timestamp() - interval '1 second'
				where id = (v_binding ->> 'assignmentId')::uuid;
			elsif v_case = 'job' then
				set local role service_role;
				perform public.qorpera_terminalize_runner_attempt((v_binding ->> 'jobId')::uuid,'failed','Fence parity',false);
				reset role;
			elsif v_case = 'grant' then
				update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = current_setting('qorpera_test.path_grant')::uuid;
			elsif v_case = 'expired-grant' then
				update public.qorpera_company_path_grants set expires_at = clock_timestamp() + interval '20 milliseconds'
				where id = current_setting('qorpera_test.path_grant')::uuid;
				perform pg_sleep(0.03);
			elsif v_case = 'resource' then
				update public.qorpera_company_path_resources set version = extensions.gen_random_uuid() where path = '';
			elsif v_case = 'staff' then
				update public.qorpera_profile_staff set employment_status = 'archived' where staff_agent_id = '29000000-0000-4000-8000-000000000030';
			elsif v_case = 'requester' then
				insert into auth.users(id,email) values ('29000000-0000-4000-8000-0000000000f1','path-cofounder@example.test');
				insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
				values ('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-0000000000f1','path-cofounder@example.test','Co-founder','owner');
				update public.qorpera_profile_members set role = 'viewer' where user_id = '29000000-0000-4000-8000-000000000001';
			elsif v_case = 'sponsor' then
				update public.qorpera_execution_sponsor_bindings set status = 'revoked'
				where id = (current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid;
			elsif v_case = 'session' then
				update public.qorpera_shared_sessions set status = 'closed' where id = '29000000-0000-4000-8000-000000000040';
			elsif v_case = 'path' then
				v_paths := array['members/29000000-0000-4000-8000-000000000001/private/future.txt'];
			elsif v_case = 'no-paths' then
				v_paths := null;
			elsif v_case = 'view' then
				v_view := v_view || '{"purpose":"billing"}';
			elsif v_case = 'replay' then
				set local role service_role;
				perform public.qorpera_record_native_context_view(v_environment,v_binding,v_view);
				reset role;
				v_view := v_view || '{"threadId":"thread-2"}';
			end if;
			set local role service_role;
			v_separate := pg_temp.fence_outcome(format('select pg_temp.fence_separate(%L::jsonb,%L::text[],%L::jsonb)',
				v_binding, v_paths, v_view));
			v_one := pg_temp.fence_outcome(format('select public.qorpera_fence_native_context(%L::uuid,%L::jsonb,%L::text[],%L::jsonb)',
				v_environment, v_binding, v_paths, v_view));
			reset role;
			if v_one is distinct from v_separate then
				raise exception 'One-call fence differs for %: separate calls %, one call %', v_case, v_separate, v_one; end if;
			v_seen := v_seen || (v_case || ' ' || case when v_one like '{%' then 'answered' else v_one end);
			raise exception using errcode = 'QTF01';
		exception when sqlstate 'QTF01' then null; end;
	end loop;
	raise notice 'One-call fence outcomes: %', v_seen;
	-- Beside parity, every outcome is pinned, so a vacuous pass shows. A requester who became a viewer
	-- is still a member and still reads, through the separate calls as through the one call.
	if v_seen is distinct from array['current answered','claims 42501','binding 42501','lease 42501','assignment 42501',
		'job 42501','grant 42501','expired-grant 42501','resource 42501','staff 42501','requester answered',
		'sponsor 42501','session 42501','path 42501','no-paths 22023','view 22023','replay 23505'] then
		raise exception 'One-call fence refusals changed: %', v_seen; end if;
end
$$;

-- An answer: the view is recorded once, its receipt is the record function's, and the authority is the
-- describe function's for this run.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_result jsonb; v_replay jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
begin
	-- Rolled back at the end: the races below start from the fixture as it is.
	set local role service_role;
	v_result := public.qorpera_fence_native_context(v_environment,v_binding,array['note.md'],pg_temp.fence_view('answer-1'));
	v_replay := public.qorpera_record_native_context_view(v_environment,v_binding,pg_temp.fence_view('answer-1'));
	reset role;
	if v_result ->> 'schema' <> 'qorpera.native-context-fence/v1'
		or v_result -> 'receipt' <> v_replay
		or v_result #> '{authority,identity}' <> public.qorpera_describe_native_tool_authority(v_binding) -> 'identity'
		or (v_result #>> '{authority,validForMs}')::bigint not between 1 and 30000
		-- 290's read kept note.md under exactly that name.
		or v_result -> 'kept' is distinct from '["note.md"]'::jsonb
		or (select count(*) from public.qorpera_native_context_views where run_id = (v_binding ->> 'runId')::uuid
			and request_id = 'answer-1') <> 1 then
		raise exception 'One-call fence answer differs: %', v_result; end if;
	raise exception using errcode = 'QTF03';
exception when sqlstate 'QTF03' then reset role;
end
$$;

-- The read set: the host sends each path once, the database keeps it and checks the whole set on every
-- call, so a path the host leaves out is still checked.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_environment uuid := '29000000-0000-4000-8000-000000000020'; v_result jsonb;
begin
	-- note.md entered the set when 290 read it; a path only the host knows (a write) enters with its first call.
	set local role service_role;
	v_result := public.qorpera_fence_native_context(v_environment,v_binding,array['notes/written.md'],pg_temp.fence_view('set-1'));
	reset role;
	if (select array_agg(path order by path) from public.qorpera_company_run_read_paths where run_id = v_run)
		is distinct from array['note.md','notes/written.md'] or v_result -> 'kept' is distinct from '["notes/written.md"]'::jsonb then
		raise exception 'The run read set did not keep the sent path: %', v_result -> 'kept'; end if;
	update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = current_setting('qorpera_test.path_grant')::uuid;
	-- Each path alone, left out by the host, still stops the next model request.
	for v_path in 0..1 loop
		begin
			delete from public.qorpera_company_run_read_paths where run_id = v_run
				and path <> (array['note.md','notes/written.md'])[v_path + 1];
			set local role service_role;
			begin
				perform public.qorpera_fence_native_context(v_environment,v_binding,'{}',pg_temp.fence_view('omitted'));
				raise exception 'A path left out by the host escaped the check';
			exception when insufficient_privilege then null; end;
			reset role;
			raise exception using errcode = 'QTF02';
		exception when sqlstate 'QTF02' then null; end;
	end loop;
	-- Without any kept path the same call passes: the refusals above came from the kept paths.
	delete from public.qorpera_company_run_read_paths where run_id = v_run;
	set local role service_role;
	perform public.qorpera_fence_native_context(v_environment,v_binding,'{}',pg_temp.fence_view('empty-set'));
	reset role;
	if exists (select 1 from public.qorpera_native_context_views where run_id = v_run and request_id = 'omitted') then
		raise exception 'A refused call recorded its view'; end if;
	raise exception using errcode = 'QTF03';
exception when sqlstate 'QTF03' then reset role;
end
$$;

-- A second spelling (review 551). The run's read set keeps one row per path key, which ignores letter case, so
-- the call reports kept only the sent paths it holds under exactly that name, and the host sends every other
-- spelling again on every call, as when it sent its whole list. Here the model looked up Later.md and
-- later.md while neither existed, and the file then appears as Later.md: the next call is refused because the
-- host still sends later.md. Had the host stopped sending it, the call would have been answered.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb; v_result jsonb; v_outcome text;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
begin
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	v_result := public.qorpera_fence_native_context(v_environment,v_binding,array['Later.md','later.md'],pg_temp.fence_view('alias-1'));
	if v_result -> 'kept' is distinct from '["Later.md"]'::jsonb then
		raise exception 'One-call fence reported a second spelling kept: %', v_result -> 'kept'; end if;
	v_result := public.qorpera_fence_native_context(v_environment,v_binding,array['later.md'],pg_temp.fence_view('alias-2'));
	if v_result -> 'kept' is distinct from '[]'::jsonb then
		raise exception 'One-call fence reported a second spelling kept: %', v_result -> 'kept'; end if;
	perform pg_temp.path_commit(pg_temp.path_plan('create-later','Later.md',pg_temp.path_stage_file('Later.md','Later text')));
	v_outcome := pg_temp.fence_outcome(format('select public.qorpera_fence_native_context(%L::uuid,%L::jsonb,%L::text[],%L::jsonb)',
		v_environment, v_binding, array['later.md'], pg_temp.fence_view('alias-3')));
	if v_outcome is distinct from '42501' then
		raise exception 'The second spelling, sent again, was not refused: %', v_outcome; end if;
	-- The same call without it passes: the refusal came from the second spelling alone.
	v_outcome := pg_temp.fence_outcome(format('select public.qorpera_fence_native_context(%L::uuid,%L::jsonb,%L::text[],%L::jsonb)',
		v_environment, v_binding, '{}'::text[], pg_temp.fence_view('alias-4')));
	if v_outcome not like '{%' then raise exception 'The kept spelling alone was refused: %', v_outcome; end if;
	reset role;
	raise exception using errcode = 'QTF03';
exception when sqlstate 'QTF03' then reset role;
end
$$;

-- Races with a concurrent grant revocation. Row locks show only across connections, so the fixture is
-- committed here and removed again at the end (the harness of 602): the test refuses to run beside other
-- connections to this database, whose rows the cleanup could not tell from its own.
reset role;
select set_config(name, current_setting(name), false)
from unnest(array['qorpera_test.path_binding','qorpera_test.path_grant']) name;
select set_config('qorpera_test.fence_first_xid', xid(pg_current_xact_id())::text, false);
select dblink_connect('fence_holder', 'dbname=' || current_database());
select dblink_connect('fence_call', 'dbname=' || current_database());
select dblink_connect('fence_revoke', 'dbname=' || current_database());
select set_config('qorpera_test.fence_' || name || '_pid', pid::text, false)
from unnest(array['holder','call','revoke']) name, lateral dblink('fence_' || name, 'select pg_backend_pid()') as backend(pid integer);
create function pg_temp.fence_alone_in_database() returns void language plpgsql as $$
begin
	if exists (select 1 from pg_catalog.pg_stat_activity activity where activity.datname = current_database()
		and activity.backend_type = 'client backend' and activity.pid <> pg_backend_pid()
		and activity.pid::text not in (current_setting('qorpera_test.fence_holder_pid'),
			current_setting('qorpera_test.fence_call_pid'), current_setting('qorpera_test.fence_revoke_pid'))) then
		raise exception 'Fence race test needs the database to itself: another connection is open'; end if;
end
$$;
select pg_temp.fence_alone_in_database();
-- Every table's rows as other connections see them, before the fixture is committed.
create temporary table fence_counts as select * from dblink('fence_holder', $$
	select format('%I.%I', namespace.nspname, class.relname),
		(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', namespace.nspname, class.relname), false, true, '')))[1]::text::bigint
	from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
	where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)'
$$) as counted(table_name text, row_count bigint);
-- Where the fixture changed rows that were there before it, those rows as they were.
create temporary table fence_rows (table_name text, row_value jsonb);
do $$
declare v_table text; v_expected bigint; v_untouched bigint; v_first xid := current_setting('qorpera_test.fence_first_xid')::xid;
begin
	for v_table, v_expected in select table_name, row_count from pg_temp.fence_counts loop
		execute format('select count(*) from %s where age(xmin) > age(%L::xid)', v_table, v_first) into v_untouched;
		if v_untouched <> v_expected then
			insert into pg_temp.fence_rows select v_table, kept.row_value
			from dblink('fence_holder', format('select to_jsonb(kept) from %s kept', v_table)) as kept(row_value jsonb);
		end if;
	end loop;
end $$;
commit;

-- A call runs as the role PostgREST would use, with that role's claims.
create function pg_temp.fence_as(p_connection text, p_claims jsonb) returns void language plpgsql as $$
begin
	perform dblink_exec(p_connection, 'reset role');
	perform dblink_exec(p_connection, format('set request.jwt.claims = %L', p_claims));
	perform dblink_exec(p_connection, format('set role %I', p_claims ->> 'role'));
end
$$;
-- A sent call's result, or its error; the connection is ready again afterwards.
create function pg_temp.fence_collect(p_connection text) returns jsonb language plpgsql as $$
declare v_value jsonb; v_outcome jsonb;
begin
	begin
		select result into v_value from dblink_get_result(p_connection) as call(result jsonb);
		v_outcome := jsonb_build_object('result', v_value);
	exception when others then
		v_outcome := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
	end;
	perform * from dblink_get_result(p_connection, false) as call(result jsonb);
	return v_outcome;
end
$$;
-- Waits until the connection's backend waits for a lock held by one of p_by (any holder when null).
create function pg_temp.fence_waits(p_connection text, p_by integer[] default null) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.fence_' || p_connection || '_pid')::integer;
begin
	for attempt in 1..400 loop
		if cardinality(pg_blocking_pids(v_pid)) > 0 and (p_by is null or pg_blocking_pids(v_pid) && p_by) then return true; end if;
		exit when dblink_is_busy('fence_' || p_connection) = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end
$$;
create function pg_temp.fence_call_text(p_request text) returns text language sql as $$
	select format('select public.qorpera_fence_native_context(%L::uuid,%L::jsonb,%L::text[],%L::jsonb)',
		'29000000-0000-4000-8000-000000000020', current_setting('qorpera_test.path_binding'), '{}', pg_temp.fence_view(p_request))
$$;
create function pg_temp.fence_revoke_text() returns text language sql as $$
	select format('select jsonb_build_object(''revoked'', true) from (select public.qorpera_revoke_company_path(%L::uuid,%L::uuid,%L::uuid)) revoked',
		resource.id, resource.version, current_setting('qorpera_test.path_grant'))
	from public.qorpera_company_path_resources resource where resource.environment_id = '29000000-0000-4000-8000-000000000020' and resource.path = ''
$$;
create function pg_temp.fence_viewed(p_request text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_native_context_views
		where run_id = (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid and request_id = p_request)
$$;

-- At the end: remove what the test committed, as 602 does.
create function pg_temp.fence_cleanup() returns void language plpgsql as $$
declare v_table text; v_columns text; v_expected bigint; v_count bigint; v_wrong text[] := '{}'; v_first xid := current_setting('qorpera_test.fence_first_xid')::xid;
begin
	perform pg_temp.fence_alone_in_database();
	perform dblink_disconnect(name) from unnest(array['fence_holder','fence_call','fence_revoke']) name;
	perform set_config('session_replication_role', 'replica', true);
	for v_table in select format('%I.%I', namespace.nspname, class.relname)
		from pg_catalog.pg_class class join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
		where class.relkind = 'r' and namespace.nspname not in ('pg_catalog','information_schema') and namespace.nspname !~ '^pg_(temp|toast)' loop
		execute format('delete from %s where age(xmin) <= age(%L::xid)', v_table, v_first);
	end loop;
	for v_table in select distinct table_name from pg_temp.fence_rows loop
		select string_agg(quote_ident(attribute.attname), ',' order by attribute.attnum) into v_columns
		from pg_catalog.pg_attribute attribute where attribute.attrelid = v_table::regclass and attribute.attnum > 0
			and not attribute.attisdropped and attribute.attgenerated = '';
		execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s, kept.row_value)).*
			from pg_temp.fence_rows kept where kept.table_name = %3$L
				and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)) restored', v_table, v_columns, v_table);
		execute format('select count(*) from pg_temp.fence_rows kept where kept.table_name = %2$L
			and not exists (select 1 from %1$s present where to_jsonb(present) = kept.row_value)', v_table, v_table) into v_count;
		if v_count > 0 then v_wrong := v_wrong || format('%s: %s rows not restored as they were', v_table, v_count); end if;
	end loop;
	for v_table, v_expected in select table_name, row_count from pg_temp.fence_counts loop
		execute format('select count(*) from %s', v_table) into v_count;
		if v_count <> v_expected then
			v_wrong := v_wrong || format('%s %s/%s', v_table, v_count, v_expected); end if;
	end loop;
	if cardinality(v_wrong) > 0 then raise exception 'Fence race cleanup left other row counts: %', v_wrong; end if;
end $$;

-- 1. The one call first. A third connection holds the run's launch row, so the call stops at its view insert
--    after every check before it, holding the company's profile fence. A member revoking the agent's grant
--    starts and waits for the call; the holder lets go. The call records its view with the checks it made
--    under those locks, then the revocation lands, and the next model request is refused: the revocation
--    could not land between the call's checks and its view.
do $$
declare v_call jsonb; v_revoke jsonb;
begin
	perform dblink_exec('fence_holder', 'begin');
	perform * from dblink('fence_holder', format('select 1 from public.qorpera_native_execution_launches where run_id = %L for update',
		current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')) as held(held integer);
	perform pg_temp.fence_as('fence_call', '{"role":"service_role"}');
	perform dblink_send_query('fence_call', pg_temp.fence_call_text('race-first'));
	if not pg_temp.fence_waits('call', array[current_setting('qorpera_test.fence_holder_pid')::integer]) then
		perform dblink_exec('fence_holder', 'rollback');
		raise exception 'Fence race 1: the call did not wait at its view: %', pg_temp.fence_collect('fence_call'); end if;
	perform pg_temp.fence_as('fence_revoke', '{"role":"authenticated","sub":"29000000-0000-4000-8000-000000000001"}');
	perform dblink_send_query('fence_revoke', pg_temp.fence_revoke_text());
	if not pg_temp.fence_waits('revoke', array[current_setting('qorpera_test.fence_call_pid')::integer]) then
		perform dblink_exec('fence_holder', 'rollback');
		raise exception 'Fence race 1: the revocation did not wait for the call: %', pg_temp.fence_collect('fence_revoke'); end if;
	perform dblink_exec('fence_holder', 'rollback');
	v_call := pg_temp.fence_collect('fence_call');
	v_revoke := pg_temp.fence_collect('fence_revoke');
	if v_call ? 'error' or v_revoke ? 'error' or not pg_temp.fence_viewed('race-first')
		or not exists (select 1 from public.qorpera_company_path_grants where id = current_setting('qorpera_test.path_grant')::uuid
			and revoked_at is not null) then
		raise exception 'Fence race 1: call %, revocation %', v_call, v_revoke; end if;
	perform pg_temp.fence_as('fence_call', '{"role":"service_role"}');
	perform dblink_send_query('fence_call', pg_temp.fence_call_text('race-after'));
	v_call := pg_temp.fence_collect('fence_call');
	if v_call ->> 'state' is distinct from '42501' or pg_temp.fence_viewed('race-after') then
		raise exception 'Fence race 1: the next model request after the revocation: %', v_call; end if;
end $$;

-- The agent's grant again, for the second race.
do $$
begin
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	perform set_config('qorpera_test.path_grant', public.qorpera_grant_company_path(resource.id, resource.version,
		'staff_agent', '29000000-0000-4000-8000-000000000030', array['read','write'])::text, false)
	from public.qorpera_company_path_resources resource
	where resource.environment_id = '29000000-0000-4000-8000-000000000020' and resource.path = '';
end $$;

-- 2. The revocation first. It holds the company's profile fence, uncommitted; the one call waits for it at its
--    read-set check and, once it commits, is refused and records nothing.
do $$
declare v_call jsonb;
begin
	perform pg_temp.fence_as('fence_holder', '{"role":"authenticated","sub":"29000000-0000-4000-8000-000000000001"}');
	perform dblink_exec('fence_holder', 'begin');
	perform * from dblink('fence_holder', pg_temp.fence_revoke_text()) as revoked(result jsonb);
	perform pg_temp.fence_as('fence_call', '{"role":"service_role"}');
	perform dblink_send_query('fence_call', pg_temp.fence_call_text('race-second'));
	if not pg_temp.fence_waits('call', array[current_setting('qorpera_test.fence_holder_pid')::integer]) then
		perform dblink_exec('fence_holder', 'rollback');
		raise exception 'Fence race 2: the call did not wait for the revocation: %', pg_temp.fence_collect('fence_call'); end if;
	perform dblink_exec('fence_holder', 'commit');
	v_call := pg_temp.fence_collect('fence_call');
	if v_call ->> 'state' is distinct from '42501' or pg_temp.fence_viewed('race-second') then
		raise exception 'Fence race 2: the call after the revocation: %', v_call; end if;
	perform dblink_exec('fence_holder', 'reset role');
end $$;

select pg_temp.fence_cleanup();
