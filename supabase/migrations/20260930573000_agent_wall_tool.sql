-- 20260930573000: an agent's wall (Jonas, 5 November 2026: "a poster or wall of updates kept within rules, instead of
-- many new messages"). The agent keeps QorperaOS/agents/<handle>/wall.md with update_wall, and the web pins it above its
-- thread. The tool writes through the folder core like company_write, so the only database change is the closed list of
-- tool operations a run's observations may name, after the interface app tools (20260930572000).

create function pg_temp.agent_wall_tool_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930573000' in v_definition) > 0 then
		raise exception '20260930573000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930573000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.agent_wall_tool_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930572000 */'save_app','post_app',$old$,
	$new$/* 20260930572000 */'save_app','post_app',/* 20260930573000 */'update_wall',$new$);

drop function pg_temp.agent_wall_tool_replace(regprocedure, text, text);
