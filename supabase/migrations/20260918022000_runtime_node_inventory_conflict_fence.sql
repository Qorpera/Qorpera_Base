-- A stale previous digest on a node inventory replacement is a deliberate version
-- fence. It used SQLSTATE 40001, which PostgREST treats as an engine serialization
-- failure and retries; like every other runtime fence it now answers the structured
-- conflict (QRC01, HTTP 409) introduced by 20260913000200.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_replace_runtime_node_inventory(jsonb,text)'::regprocedure);
	v_old := $old$raise exception 'Node inventory policy changed' using errcode = '40001';$old$;
	v_new := $new$raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node inventory policy changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Node inventory fence differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
