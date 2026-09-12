-- Deliberate authority/version fences must not enter PostgREST's serialization
-- retry loop. Engine serialization failures remain a separate, genuine SQLSTATE.
do $$
declare v_body text; v_message text;
begin
	if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
		where n.nspname='public' and p.proname like 'qorpera_%' and p.prokind='f'
			and (p.prosrc ~ '40001' or p.prosrc ~ 'serialization_failure')) then
		raise exception 'An explicit runtime serialization fence or blanket handler remains';
	end if;
	if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
		where n.nspname='public' and p.proname like 'qorpera_%' and p.prokind='f'
			and p.prosrc like '%QRC01%' and p.prosrc not like '%"headers":{}%') then
		raise exception 'Runtime conflict envelope lacks required PostgREST headers';
	end if;
	-- A stale office provider version uses the structured conflict helper in its
	-- actual effective body; all security/function attributes remain in place.
	select pg_get_functiondef('public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean)'::regprocedure)
	into v_body;
	if position('QRC01' in v_body)=0 or position('SECURITY DEFINER' in v_body)=0 then
		raise exception 'Office provider conflict contract was lost';
	end if;
	if has_function_privilege('service_role','public.qorpera_claim_runner_job(uuid,text,uuid,text)','execute')
		or has_function_privilege('authenticated','public.qorpera_retire_stale_managed_runners()','execute') then
		raise exception 'Forward replacement reopened private/retired controls';
	end if;
	-- Preserve genuine PostgreSQL exception identity; no catch-all wrapper may
	-- relabel engine aborts as successful or application conflict results.
	begin
		raise serialization_failure using message='engine transaction retry';
	exception when serialization_failure then
		get stacked diagnostics v_message = message_text;
		if v_message <> 'engine transaction retry' then raise exception 'Engine conflict changed'; end if;
	end;
end $$;
