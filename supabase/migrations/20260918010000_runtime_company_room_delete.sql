-- A team room is removed by deleting its canonical document
-- (organization/rooms/<roomId>.json) through the ordinary governed edit. Until
-- now the projection refused that delete, so a room could only be archived.
-- The delete removes the room and its memberships and closes the room's
-- conversation; the conversation's history stays in the ledger. A room bound to
-- an agent (its shared thread) has no room document and is never reached here.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure);
	v_old := $old$	if p_plan #>> '{entry,kind}' is distinct from 'file' or p_document_text is null$old$;
	v_new := $new$	if v_kind = 'room' and p_document_text is null and coalesce(jsonb_typeof(p_plan -> 'entry'),'null') = 'null' then
		v_id := substring(public.qorpera_company_path_key(p_plan ->> 'path') from 'organization/rooms/(.{36})[.]json$')::uuid;
		select * into v_room from public.qorpera_company_rooms room
		where room.id = v_id and room.profile_id = v_profile_id and room.environment_id = v_environment_id for update;
		if found then
			if v_room.bound_staff_agent_id is not null then
				raise exception 'An agent thread is removed with its agent' using errcode = '42501'; end if;
			delete from public.qorpera_company_rooms where id = v_room.id;
			if v_room.session_id is not null then
				update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
				where id = v_room.session_id and status = 'open';
			end if;
		end if;
		return;
	end if;
	if p_plan #>> '{entry,kind}' is distinct from 'file' or p_document_text is null$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Organization projection entry check differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
