-- The web client no longer has a Rules tab (web PR #360, 2026-09-27): the rules
-- sit at the bottom of Settings → General. The refusal add_review_rule returns
-- when the member's rule list is full still sent them to "Settings, Rules".
--
-- Patched into the live definition, not re-stated, so later changes to the
-- function stay. CREATE OR REPLACE keeps the ACL. The runtime's add_review_rule
-- description says the same from the next bundle cut.

create function pg_temp.rules_place_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Review rule refusal text differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.rules_place_patch('public.qorpera_add_agent_review_rule(jsonb,jsonb)'::regprocedure,
	$old$they can remove some in Settings, Rules.'$old$,
	$new$they can remove some at the bottom of Settings → General.'$new$);
