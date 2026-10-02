-- Company state files, A1-7b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "connections/<name>.md", §8 "Plan
-- (A1-7)"): a website account's connection file. With `service: website` the parse carries `site` (the vault's host
-- rule, qorpera_company_account_host_valid), `twoStep` and `openedFor`, and its status may also be pending or
-- needs_person. Any other service keeps its exact shape and connected or broken. Inert until A1's vault writer writes
-- such a file: only the platform writes a connection file's settings, and its save still needs the vault row active
-- with the connector `website`.

create function pg_temp.a17_website_accounts_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'A1-7 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.a17_website_accounts_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			array['account','actions','connectedAt','connectedBy','id','kind','purpose','service','status'] then$old$,
	$new$			-- 20260929999950 (A1-7): a website account has its own three keys.
			(case when p_parse ->> 'service' = 'website'
				then array['account','actions','connectedAt','connectedBy','id','kind','openedFor','purpose','service','site','status',
					'twoStep']
				else array['account','actions','connectedAt','connectedBy','id','kind','purpose','service','status'] end) then$new$);

select pg_temp.a17_website_accounts_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$		if coalesce(p_parse ->> 'status', '') not in ('connected','broken') then v_bad := array_append(v_bad, 'status'); end if;$old$,
	$new$		-- A website account may also be pending (opened, not yet verified) or wait for a person (A1-7).
		if coalesce(p_parse ->> 'status', '') not in ('connected','broken')
			and (p_parse ->> 'service' is distinct from 'website'
				or coalesce(p_parse ->> 'status', '') not in ('pending','needs_person')) then
			v_bad := array_append(v_bad, 'status'); end if;
		-- The site by the vault's host rule, the two-step method, and the todo it was opened for.
		if p_parse ->> 'service' = 'website' and (jsonb_typeof(p_parse -> 'site') is distinct from 'string'
				or char_length(p_parse ->> 'site') > 253
				or (p_parse ->> 'site') !~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$') then
			v_bad := array_append(v_bad, 'site'); end if;
		if p_parse ->> 'service' = 'website' and coalesce(p_parse ->> 'twoStep', '') not in ('none','authenticator','email','sms') then
			v_bad := array_append(v_bad, 'twoStep'); end if;
		if p_parse ->> 'service' = 'website' and jsonb_typeof(p_parse -> 'openedFor') is distinct from 'null'
				and coalesce(p_parse ->> 'openedFor', '') !~ c_uuid then
			v_bad := array_append(v_bad, 'openedFor'); end if;$new$);
