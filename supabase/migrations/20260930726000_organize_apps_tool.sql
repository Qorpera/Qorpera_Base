-- 20260930726000: the apps drawer's groups (APP-GROUPS-SPEC §3; Jonas, 11 November 2026: "the agents should be able to
-- organize the interfaces for you natively and help group interfaces to products and work"). Agents keep the company's
-- layout of the drawer in apps/groups.md with organize_apps, which writes through the folder core like organize_sidebar,
-- so the only database change is the closed list of tool operations a run's observations may name, after manage_code
-- (20260930720000).

create function pg_temp.organize_apps_tool_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930726000' in v_definition) > 0 then
		raise exception '20260930726000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930726000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.organize_apps_tool_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930720000 */'manage_code',$old$,
	$new$/* 20260930720000 */'manage_code',/* 20260930726000 */'organize_apps',$new$);

drop function pg_temp.organize_apps_tool_replace(regprocedure, text, text);
