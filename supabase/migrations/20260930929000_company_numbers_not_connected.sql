set local lock_timeout = '3s';

do $migration$
declare
	v_target constant regprocedure := 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure;
	v_pairs constant text[] := array[
		$old$		v_body := public.qorpera_company_numbers_orders(p_environment_id, p_profile_id, v_now, p_question, v_params);$old$,
		$new$		v_body := public.qorpera_company_numbers_orders(p_environment_id, p_profile_id, v_now, p_question, v_params);
		if not exists (select 1 from public.qorpera_event_hooks as hook
				where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id and hook.proof = 'stripe'
					and hook.status <> 'removed')
			and not exists (select 1 from public.qorpera_orders as o
				where o.profile_id = p_profile_id and o.environment_id = p_environment_id) then
			raise exception 'Not connected: orders count once card payments are connected or an order is added by hand'
				using errcode = '55000'; end if;$new$,
		$old$		v_body := public.qorpera_company_numbers_site(p_profile_id, v_now, p_question, v_params);$old$,
		$new$		v_body := public.qorpera_company_numbers_site(p_profile_id, v_now, p_question, v_params);
		if p_question <> 'sites' and not exists (select 1 from public.qorpera_company_sites as site
				where site.profile_id = p_profile_id and site.kind = 'files'
					and (site.current_version_id is not null or site.live_deployment_id is not null)) then
			raise exception 'Not connected: visits count once the company publishes a website'
				using errcode = '55000'; end if;$new$,
		$old$	v_body := jsonb_build_object('columns', to_jsonb(v_columns), 'rows', coalesce(v_rows, '[]'::jsonb), 'more', false);$old$,
		$new$	if v_state = 'none' then
		raise exception 'Not connected: the bank''s numbers come once the company connects its bank'
			using errcode = '55000'; end if;
	v_body := jsonb_build_object('columns', to_jsonb(v_columns), 'rows', coalesce(v_rows, '[]'::jsonb), 'more', false);$new$
	];
	v_def text;
	v_hits integer;
	v_index integer;
begin
	if to_regprocedure('public.qorpera_company_numbers_orders(uuid,uuid,timestamptz,text,jsonb)') is null
		or to_regprocedure('public.qorpera_company_numbers_site(uuid,timestamptz,text,jsonb)') is null
		or strpos((select prosrc from pg_proc where oid = v_target), '20260930777000') = 0 then
		raise exception '20260930929000 requires 20260930767000, 20260930768000, 20260930776000 and 20260930777000';
	end if;
	if strpos((select prosrc from pg_proc where oid = v_target), 'Not connected:') > 0 then
		raise exception '20260930929000 is already applied';
	end if;

	v_def := pg_get_functiondef(v_target);
	for v_index in 1 .. array_length(v_pairs, 1) by 2 loop
		v_hits := (length(v_def) - length(replace(v_def, v_pairs[v_index], ''))) / length(v_pairs[v_index]);
		if v_hits <> 1 then
			raise exception '20260930929000: anchor matched % time(s) in %: %', v_hits, v_target, left(v_pairs[v_index], 120);
		end if;
		v_def := replace(v_def, v_pairs[v_index], v_pairs[v_index + 1]);
	end loop;
	execute v_def;

	if (length((select prosrc from pg_proc where oid = v_target))
			- length(replace((select prosrc from pg_proc where oid = v_target), 'Not connected:', ''))) / 14 <> 3
		or strpos((select prosrc from pg_proc where oid = v_target), 'Company views step 3, slice M1 (20260930767000)') = 0
		or strpos((select prosrc from pg_proc where oid = v_target), '20260930768000') = 0
		or strpos((select prosrc from pg_proc where oid = v_target), '20260930776000') = 0
		or strpos((select prosrc from pg_proc where oid = v_target), '20260930777000') = 0 then
		raise exception '20260930929000: the dispatcher lost a marker';
	end if;
	if has_function_privilege('anon', v_target, 'EXECUTE') or has_function_privilege('authenticated', v_target, 'EXECUTE')
		or has_function_privilege('service_role', v_target, 'EXECUTE') then
		raise exception '20260930929000: the dispatcher is open to an API role';
	end if;
end $migration$;
