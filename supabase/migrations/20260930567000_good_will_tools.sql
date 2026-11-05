-- The runtime observes the finance agent's good will tools (20260930566000): good_will_list and good_will_mark join the
-- tool operations an observation may name, as the TypeScript vocabulary (cloud-runtime-observability.ts) lists them.

create function pg_temp.good_will_tools_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930567000' in v_definition) > 0 then
		raise exception '20260930567000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930567000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.good_will_tools_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930562000 */'share_app',$old$,
	$new$/* 20260930562000 */'share_app',/* 20260930567000 */'good_will_list','good_will_mark',$new$);

drop function pg_temp.good_will_tools_replace(regprocedure, text, text);
