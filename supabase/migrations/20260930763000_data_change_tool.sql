-- 20260930763000: an agent runs a named change of a company database (deploy/first-node/RUNTIME-COMPANY-DATABASES.md
-- §8, slice 7 part (a); Jonas, 14 November 2026, asked whether agents have the database tools they would have
-- elsewhere and shown that they could not write rows: "Yes, build them"). data_change calls the data gateway's run door
-- with a data pass, as data_query does (20260930750000): the pass already keeps the files in a database's actions/, and
-- the rows live in the company data store, not here. So the only database change is the closed list of tool
-- operations a run's observations may name, after the three data tools.

create function pg_temp.data_change_tool_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930763000' in v_definition) > 0 then
		raise exception '20260930763000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930763000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.data_change_tool_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930750000 */'data_describe','data_apply','data_query',$old$,
	$new$/* 20260930750000 */'data_describe','data_apply','data_query',/* 20260930763000 */'data_change',$new$);

drop function pg_temp.data_change_tool_replace(regprocedure, text, text);
