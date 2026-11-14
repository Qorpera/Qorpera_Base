-- 20260930762000: an agent reads how a part of an interface app is made (deploy/first-node/RUNTIME-INTERFACE-APPS.md
-- §3d). Until 14 November 2026 the guides (what a kit's file holds, a page's base style, its live data) were the
-- descriptions of save_app's fields, which the patched Codex never sent: it drops every field description of a schema of
-- 5,000 bytes or more. app_guide answers one guide's text from the runtime's bundle. It reads nothing of the company and
-- writes nothing, so the only database change is the closed list of tool operations a run's observations may name,
-- after make_picture (20260930746000).

create function pg_temp.app_guide_tool_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930762000' in v_definition) > 0 then
		raise exception '20260930762000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930762000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.app_guide_tool_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930746000 */'make_picture',$old$,
	$new$/* 20260930746000 */'make_picture',/* 20260930762000 */'app_guide',$new$);

drop function pg_temp.app_guide_tool_replace(regprocedure, text, text);
