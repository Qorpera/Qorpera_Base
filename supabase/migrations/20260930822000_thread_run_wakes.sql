create function pg_temp.run_wakes_replace(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Thread run wakes patch anchor not found once in %', p_target;
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.run_wakes_replace('public.qorpera_read_session_events(uuid,bigint,integer)',
	E'   ''staff_version'',speaker.staff_version,''display_name'',speaker.display_name)) end order by item.ordinality)\n'
	|| E'  from jsonb_array_elements(events) with ordinality item(value,ordinality)\n'
	|| E'  left join public.qorpera_session_event_speakers speaker on speaker.event_id=(item.value->>''event_id'')::uuid),''[]''::jsonb);\n',
	E'   ''staff_version'',speaker.staff_version,''display_name'',speaker.display_name)) end\n'
	|| E'   || case when wake.wake_kind is null then ''{}''::jsonb else jsonb_build_object(''run_wake'',wake.wake_kind) end\n'
	|| E'   order by item.ordinality)\n'
	|| E'  from jsonb_array_elements(events) with ordinality item(value,ordinality)\n'
	|| E'  left join public.qorpera_session_event_speakers speaker on speaker.event_id=(item.value->>''event_id'')::uuid\n'
	|| E'  left join public.qorpera_wake_occurrences wake on item.value->>''execution_kind''=''run''\n'
	|| E'   and wake.run_id=(item.value->>''execution_id'')::uuid),''[]''::jsonb);\n');

drop function pg_temp.run_wakes_replace(regprocedure, text, text);

comment on function public.qorpera_read_session_events(uuid, bigint, integer) is
	'A conversation''s events after a sequence, oldest first, for a caller who may read the session; each public send '
	'carries its speaker (staff_speaker). Since 20260930822000 each event written by a run also carries run_wake, the '
	'kind of wake that started that run (room: a member''s post or card answer; first-run; agent: a coworker''s '
	'message, a worker''s report or a machine event; routine), when the run has a wake: the web shows what a member '
	'did not ask for as one quiet line. qorpera_read_session_events_tail reads through this function and carries the '
	'same field.';
