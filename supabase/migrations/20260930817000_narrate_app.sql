create function pg_temp.narrate_app_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930817000' in v_definition) > 0 then
		raise exception '20260930817000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930817000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.narrate_app_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930746000 */'make_picture',$old$,
	$new$/* 20260930746000 */'make_picture',/* 20260930817000 */'narrate_app',$new$);

drop function pg_temp.narrate_app_replace(regprocedure, text, text);
