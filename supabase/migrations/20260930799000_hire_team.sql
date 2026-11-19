create function pg_temp.hire_team_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930799000' in v_definition) > 0 then
		raise exception '20260930799000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930799000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.hire_team_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'computer_transfer','hire_agent',$old$,
	$new$'computer_transfer','hire_agent',/* 20260930799000 */'hire_team',$new$);

select pg_temp.hire_team_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$'end_role' /* 20260930766000 */)$old$,
	$new$'end_role' /* 20260930766000 */, 'hire_team' /* 20260930799000 */)$new$);

create function pg_temp.hire_team_replace_again(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930799000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.hire_team_replace_again('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$if (v_action.tool_name = 'hire_agent'$old$,
	$new$if (v_action.tool_name in ('hire_agent', 'hire_team' /* 20260930799000 */)$new$);

select pg_temp.hire_team_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$if (p_review ->> 'tool' = 'hire_agent' or$old$,
	$new$if (p_review ->> 'tool' in ('hire_agent', 'hire_team' /* 20260930799000 */) or$new$);

drop function pg_temp.hire_team_replace(regprocedure, text, text);
drop function pg_temp.hire_team_replace_again(regprocedure, text, text);
