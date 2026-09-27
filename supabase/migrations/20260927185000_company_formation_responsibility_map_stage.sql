-- A company formation could never pass goals_ratified.
--
-- On 2026-09-02 (de3d6cd0f) the stage after goals_ratified was renamed from
-- organization_formation to responsibility_map. The table's state check, both
-- clients' parsers and the contract (14.2) took the new name, but the
-- organization/formation.json projection kept the old one in its transition
-- list, and 20260828022000 copied it from there. Since then the projection
-- refuses goals_ratified -> responsibility_map as an invalid transition, while
-- goals_ratified -> organization_formation passes it and then breaks the state
-- check, which surfaces as "Organization document is invalid".
--
-- The projection takes the table's name. The state check is unchanged: no row
-- can hold organization_formation (the check has always refused it), and
-- responsibility_map stays the stage the contract, the table and every client
-- name. The retired responsibility objects (20260920070000) did not retire the
-- stage: forming the company still includes working out who owns what.

create function pg_temp.edit(p_definition text, p_old text, p_new text) returns text language plpgsql as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Formation stage: the projection differs at "%"', left(p_old, 70); end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $patch$
declare v text := pg_get_functiondef('public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure);
begin
	v := pg_temp.edit(v, $old$						when 'goals_ratified' then v_document ->> 'state' = 'organization_formation'
						when 'organization_formation' then v_document ->> 'state' = 'operating'
$old$, $new$						when 'goals_ratified' then v_document ->> 'state' = 'responsibility_map'
						when 'responsibility_map' then v_document ->> 'state' = 'operating'
$new$);
	execute v;
end
$patch$;

-- Every stage the projection can move a formation into is one the table accepts.
do $$
declare v_definition text := pg_get_functiondef(
	'public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure);
	v_check text;
	v_stage text;
begin
	select pg_get_constraintdef(constraint_row.oid) into strict v_check from pg_constraint constraint_row
	where constraint_row.conrelid = 'public.qorpera_company_formations'::regclass
		and constraint_row.conname = 'qorpera_company_formations_state_check';
	for v_stage in select match[1] from regexp_matches(v_definition,
		$re$v_document ->> 'state' = '([a-z_]+)'$re$, 'g') as match loop
		if position(quote_literal(v_stage) || '::text' in v_check) = 0 then
			raise exception 'Formation stage % is not a state the table accepts', v_stage; end if;
	end loop;
	if position('organization_formation' in v_definition) > 0 then
		raise exception 'The projection still names organization_formation'; end if;
end
$$;
