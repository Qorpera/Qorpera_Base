-- 20260930572000: interface apps (deploy/first-node/RUNTIME-INTERFACE-APPS.md; Jonas, 5 November 2026). An agent makes
-- a small web page in apps/<name>/ of the Company File (save_app) and posts it for every member (post_app, reviewed as
-- delegation). Both write through the folder core like company_write, so the only database change is the closed list
-- of tool operations a run's observations may name, after the good will tools (20260930567000).

create function pg_temp.interface_app_tools_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930572000' in v_definition) > 0 then
		raise exception '20260930572000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930572000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.interface_app_tools_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930567000 */'good_will_list','good_will_mark',$old$,
	$new$/* 20260930567000 */'good_will_list','good_will_mark',/* 20260930572000 */'save_app','post_app',$new$);

drop function pg_temp.interface_app_tools_replace(regprocedure, text, text);
