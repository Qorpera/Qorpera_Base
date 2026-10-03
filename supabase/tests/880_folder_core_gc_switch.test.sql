-- Company folder core, C1d-2b (migration 20260930009000): the artifact GC worker's folder phase is switched off, and
-- cannot be switched on while qorpera_verify_company_path_file accepts folder-v2 (C1D §9.3, "C5 early"). The read asks
-- again, so a later definition of that function without P10's marker turns the phase off. Each state of the
-- function is made in a subtransaction that is rolled back.
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null

-- 1. Off, in one row; the guard follows the function as it is now.
do $$
declare v_body text := pg_get_functiondef('public.qorpera_verify_company_path_file(uuid,text)'::regprocedure);
begin
	if (select count(*) from public.qorpera_folder_gc_settings) <> 1 or (select enabled from public.qorpera_folder_gc_settings) then
		raise exception 'The folder phase starts off, in one row'; end if;
	if public.qorpera_folder_gc_enabled() then raise exception 'Off reads as off'; end if;
	if public.qorpera_folder_gc_version1_refused() is distinct from (strpos(v_body, 'folder-v2 refuses version 1') > 0) then
		raise exception 'The guard reads the verify function as it is'; end if;
	begin
		update public.qorpera_folder_gc_settings set enabled = true;
		if not public.qorpera_folder_gc_version1_refused() then
			raise exception 'Switched on while qorpera_verify_company_path_file accepts folder-v2'; end if;
		if not public.qorpera_folder_gc_enabled() then raise exception 'On reads as on'; end if;
		raise exception using errcode = 'P0880';
	exception
		when sqlstate '55000' then
			if public.qorpera_folder_gc_version1_refused() then raise exception 'Refused although version 1 is refused'; end if;
		when sqlstate 'P0880' then null;
	end;
	if (select enabled from public.qorpera_folder_gc_settings) then raise exception 'Left on'; end if;
end $$;

-- A stand-in for the verify function with the same arguments and result, whose body is the given text.
create function pg_temp.verify_as(p_body text) returns void language plpgsql as $$
declare v_fn regprocedure := 'public.qorpera_verify_company_path_file(uuid,text)';
begin
	execute format('create or replace function public.qorpera_verify_company_path_file(%s) returns %s language plpgsql '
		'as %L', pg_get_function_arguments(v_fn), pg_get_function_result(v_fn), p_body);
end $$;

-- 2. While version 1 is accepted (no marker, even with a folder-v2 branch of another kind): switching on is refused, and
-- a row set on behind the guard's back reads as off.
do $$
begin
	begin
		perform pg_temp.verify_as('begin if public.qorpera_company_is_folder_v2(p_profile_id) then '
			'raise notice ''folder-v2 chunk rows''; end if; end');
		begin
			update public.qorpera_folder_gc_settings set enabled = true;
			raise exception 'Switched on while version 1 is accepted';
		exception when sqlstate '55000' then null;
		end;
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_folder_gc_settings set enabled = true;
		perform set_config('session_replication_role', 'origin', true);
		if public.qorpera_folder_gc_enabled() then raise exception 'On reads as off while version 1 is accepted'; end if;
		raise exception using errcode = 'P0880';
	exception when sqlstate 'P0880' then null;
	end;
end $$;

-- 3. Once it refuses folder-v2 (P10), or is gone (C6): on and off as the coordinator sets it.
do $$
declare v_case text; v_updated timestamptz;
begin
	foreach v_case in array array['refuses', 'dropped'] loop
		begin
			if v_case = 'refuses' then
				perform pg_temp.verify_as('begin if public.qorpera_company_is_folder_v2(p_profile_id) then '
					'raise exception ''Company file proof: folder-v2 refuses version 1'' using errcode = ''42501''; end if; end');
			else
				drop function public.qorpera_verify_company_path_file(uuid, text);
			end if;
			update public.qorpera_folder_gc_settings set enabled = true, updated_at = '2000-01-01' returning updated_at into v_updated;
			if not public.qorpera_folder_gc_enabled() then raise exception 'On reads as on (%)', v_case; end if;
			if v_updated = '2000-01-01' then raise exception 'The guard stamps the change'; end if;
			update public.qorpera_folder_gc_settings set enabled = false;
			if public.qorpera_folder_gc_enabled() then raise exception 'Off reads as off (%)', v_case; end if;
			raise exception using errcode = 'P0880';
		exception when sqlstate 'P0880' then null;
		end;
	end loop;
	if (select enabled from public.qorpera_folder_gc_settings) then raise exception 'Left on'; end if;
end $$;

-- 4. A second row is refused; only the service role asks; only the worker's question is the service role's.
do $$
begin
	begin
		insert into public.qorpera_folder_gc_settings(singleton) values (false);
		raise exception 'A second settings row';
	exception when check_violation then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin
		perform public.qorpera_folder_gc_enabled();
		raise exception 'A member asked the folder GC switch';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if not has_function_privilege('service_role', 'public.qorpera_folder_gc_enabled()', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_gc_enabled()', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_gc_enabled()', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_gc_version1_refused()', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_gc_version1_refused()', 'execute')
		or has_table_privilege('service_role', 'public.qorpera_folder_gc_settings', 'select,update')
		or has_table_privilege('authenticated', 'public.qorpera_folder_gc_settings', 'select,update') then
		raise exception 'Only the worker''s question is the service role''s'; end if;
	if (select proconfig from pg_proc where oid = 'public.qorpera_folder_gc_enabled()'::regprocedure)::text ~* 'lock'
		or (select prosrc from pg_proc where oid = 'public.qorpera_folder_gc_enabled()'::regprocedure) ~* 'for (update|share|no key update|key share)' then
		raise exception 'The question takes no lock'; end if;
end $$;

-- 5. The gateway tells folder GC's conflict from snapshot-v1's cleanup fence by this exact message
-- (packages/object-gateway/src/supabase-authority.ts, FOLDER_OBJECT_COLLECTING): a reworded message would leave folder
-- replication entries blocked instead of pending.
do $$
declare v_state text; v_message text;
begin
	begin
		perform public.qorpera_folder_object_collecting();
		raise exception 'The collecting refusal raises';
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
	end;
	if v_state <> 'PGRST' or v_message::jsonb ->> 'code' <> 'QRC01'
		or v_message::jsonb ->> 'message' <> 'Company folder object is being collected; retry' then
		raise exception 'The collecting refusal keeps the message the gateway matches: % %', v_state, v_message; end if;
end $$;

rollback;
