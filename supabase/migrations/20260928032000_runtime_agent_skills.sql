-- Agent skills (contract 15.2): the runtime observes read_skill, search_skills and
-- update_skill under their own names. Skills are ordinary Company File objects in the
-- company library skills/<name>/SKILL.md and in each agent's own library
-- <agent folder>/skills/<name>/SKILL.md (5.6), both under the usual path authority: no
-- path rule of their own, so the agent folder can move to agents/<agent-name>/ without SQL.
-- Patched into the live definition, not re-stated, so names other migrations added stay.
-- CREATE OR REPLACE keeps the ACL. Record this migration BEFORE activating the bundle that
-- observes them, or their observations are rejected (22023) and dropped.
create function pg_temp.agent_skills_replace(p_definition text, p_old text, p_new text)
returns text language plpgsql as $$
begin
	if p_old = '' or (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Runtime observation vocabulary differs: %', left(p_old, 80); end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $migration$
declare
	v_definition text := pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.agent_skills_replace(v_definition,
		$old$'update_memory','recall_memory',$old$,
		$new$'update_memory','recall_memory','read_skill','search_skills','update_skill',$new$);
	execute v_definition;
end
$migration$;
