-- Two places still assumed the private one-to-one conversations that
-- 20260917050000 replaced with shared agent threads:
-- 1. Company bootstrap looked up the owner's private Co-Founder conversation, so
--    creating a new company failed. It now names the Co-Founder's shared thread.
-- 2. The public conversation of an agent (where routine, listener and agent wakes
--    report) skipped every session scoped to a room, which includes the agent's
--    own thread. The thread is now the first choice; an older plain company
--    conversation remains the fallback. 3. The routine wake authorisation carried
--    the same exclusion and now admits the agent's own thread.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_enqueue_company_bootstrap(uuid,boolean)'::regprocedure);
	v_old := E'select id into strict v_session from public.qorpera_shared_sessions where profile_id = p_profile_id\n\t\tand staff_agent_id = v_cofounder.staff_agent_id::text and audience_kind = \'member_private\'\n\t\tand audience_user_id = v_owner and status = \'open\';';
	v_new := E'select room.session_id into strict v_session from public.qorpera_company_rooms room\n\t\twhere room.profile_id = p_profile_id and room.bound_staff_agent_id = v_cofounder.staff_agent_id\n\t\t\tand room.status = \'active\' and room.session_id is not null;';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Company bootstrap session lookup differs'; end if;
	execute replace(v_definition, v_old, v_new);

	v_definition := pg_get_functiondef('public.qorpera_wake_public_session(uuid,uuid,uuid,uuid)'::regprocedure);
	v_old := $old$and not (s.execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	order by case when s.audience_kind = 'company' then 0 else 1 end, s.created_at, s.id$old$;
	v_new := $new$and (coalesce(s.execution_scope ->> 'agentThread','') = 'true'
			or not (s.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))
	order by case when coalesce(s.execution_scope ->> 'agentThread','') = 'true' then 0 else 1 end,
		case when s.audience_kind = 'company' then 0 else 1 end, s.created_at, s.id$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Wake public session selection differs'; end if;
	execute replace(v_definition, v_old, v_new);

	-- 3. A routine wake is authorised into the agent's own thread (other room, group and
	--    autonomous sessions stay excluded).
	v_definition := pg_get_functiondef('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure);
	v_old := $old$(execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])$old$;
	v_new := $new$(coalesce(execution_scope ->> 'agentThread','') <> 'true'
						and execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Wake authorisation session rule differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
