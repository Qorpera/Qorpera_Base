-- 20260930746000: an agent makes a picture (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3c; Jonas, 13 November 2026:
-- "I would also turn on agents generating images of course"). make_picture has a side thread of the run's own Codex make
-- one PNG and saves it in the company folder through the folder core, as company_write writes a file, so the only
-- database change is the closed list of tool operations a run's observations may name, after organize_apps
-- (20260930726000).

create function pg_temp.make_picture_tool_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930746000' in v_definition) > 0 then
		raise exception '20260930746000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930746000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.make_picture_tool_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930726000 */'organize_apps',$old$,
	$new$/* 20260930726000 */'organize_apps',/* 20260930746000 */'make_picture',$new$);

drop function pg_temp.make_picture_tool_replace(regprocedure, text, text);
