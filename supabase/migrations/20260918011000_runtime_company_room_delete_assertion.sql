-- Canonical organization documents stay undeletable, with one exception: a team
-- room document. The commit-time assertion admits that delete only when the
-- room's projection is already gone in the same transaction (20260918010000
-- removes it); formation, responsibility and project documents are unchanged.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_assert_organization_projection()'::regprocedure);
	v_old := 'if new.entry is null then';
	v_new := $new$if new.entry is null and v_kind = 'room' and not exists (select 1 from public.qorpera_company_rooms room
		where room.environment_id = new.environment_id
			and public.qorpera_company_path_key(room.source_path) = public.qorpera_company_path_key(new.path)) then
		return new; end if;
	if new.entry is null then$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Organization assertion delete check differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
