-- F3, the server-side folder search (founder decision "Light threads", 2 October 2026): `company_search` is a runtime
-- tool observed under its own name. Inert until a folder-v2 run's native host has the node's folder search
-- (QORPERA_SHARED_EXECUTION_FOLDER_SEARCH=on on the shared execution host). No table, no lock target.

create function pg_temp.folder_company_search_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Folder search integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.folder_company_search_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'send_mail','find_mail',$old$,
	$new$'send_mail','find_mail','company_search',$new$);
