-- Interfaces I8a (deploy/first-node/RUNTIME-INTERFACES.md §7, §10): a run's observations name the four tools agents use
-- on interfaces and tables. interface_read and table_read come with this step; table_write and save_interface with I8b.
-- Nothing else changes: the tools read and write through the company folder core's own calls.
-- No table, no lock.

set local lock_timeout = '3s';

create function pg_temp.i8a_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'I8a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- Observations name the four tools, after the proposals'.
select pg_temp.i8a_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'company_search','company_account','apply_proposal','discard_proposal',$old$,
	$new$'company_search','company_account','apply_proposal','discard_proposal',
		'interface_read','table_read','table_write','save_interface',$new$);

do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		'''save_interface''') = 0 then
		raise exception 'I8a did not reach the observation vocabulary'; end if;
end $guard$;
