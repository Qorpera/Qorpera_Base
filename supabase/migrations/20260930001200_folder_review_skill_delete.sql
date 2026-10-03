-- Folder core slice P20 (memory and skills on folder-v2; coordinator decision, 3 October 2026): a skill an agent deletes
-- from its own library with update_skill records its review exactly as company_delete does. The commit denies an
-- in-house agent's deletion without a qorpera_folder_reviews row (C1B §6), and the recorder (C2 R1, 20260928399890)
-- took only the five tools that write delegation or deletion change sets, so a folder-v2 skill deletion was always
-- denied.
--
-- The recorder now also takes an update_skill approval whose effect is destructive (the automatic review classifies an
-- update_skill delete so, as company_delete), and only when every unit of the change set is a deletion under the run
-- agent's own skills folder: the folder of its agent.md (the staff row's folder_path is that file's path), then
-- /skills/, compared by folder key (the folder core's case and Unicode folding). No other tool, no write, no company
-- library, no other agent's folder. A plain read of the run agent's staff row inside the existing approval check: no
-- new lock. The body carries the marker 20260930001200 for release guards.

set local lock_timeout = '3s';

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure);
	c_anchor constant text :=
		E'\t\tand v_action.tool_name in (''hire_agent'',''create_group_chat'',''manage_routine'',''decide_routine'',''company_delete'')\n';
	c_widened constant text :=
		E'\t\tand (v_action.tool_name in (''hire_agent'',''create_group_chat'',''manage_routine'',''decide_routine'',''company_delete'')\n'
		|| E'\t\t\t-- P20 (20260930001200): a skill the agent deletes from its own library, as company_delete: only deletions\n'
		|| E'\t\t\t-- under the run agent''s own skills folder.\n'
		|| E'\t\t\tor (v_action.tool_name = ''update_skill'' and v_action.effect = ''destructive''\n'
		|| E'\t\t\t\tand not exists (select 1 from jsonb_array_elements(v_units) u\n'
		|| E'\t\t\t\t\twhere u ->> ''op'' is distinct from ''delete'' or not exists (select 1 from public.qorpera_profile_staff s\n'
		|| E'\t\t\t\t\t\twhere s.profile_id = v_run.profile_id and s.staff_agent_id = v_run.staff_agent_id\n'
		|| E'\t\t\t\t\t\t\tand s.folder_environment_id = v_run.environment_id and s.folder_retired_at is null\n'
		|| E'\t\t\t\t\t\t\tand length(public.qorpera_folder_key(u ->> ''path''))\n'
		|| E'\t\t\t\t\t\t\t\t> length(public.qorpera_folder_key(public.qorpera_folder_parent_path(s.folder_path))) + length(''/skills/'')\n'
		|| E'\t\t\t\t\t\t\tand starts_with(public.qorpera_folder_key(u ->> ''path''),\n'
		|| E'\t\t\t\t\t\t\t\tpublic.qorpera_folder_key(public.qorpera_folder_parent_path(s.folder_path)) || ''/skills/'')))))\n';
begin
	if position('20260930001200' in v_definition) > 0 then raise exception 'P20 is already in the recorder'; end if;
	if (length(v_definition) - length(replace(v_definition, c_anchor, ''))) / length(c_anchor) <> 1 then
		raise exception 'P20 anchor not found once in the recorder'; end if;
	execute replace(v_definition, c_anchor, c_widened);
end $$;
