-- Canonical human room history commits with admission, including rooms with no
-- eligible agent. Speaker metadata is immutable server provenance outside the
-- existing hash-chain body. Public reads retain the session audience check.
create function public.qorpera_append_admitted_input_events(
	p_session_id uuid,
	p_input_ids uuid[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint;
	v_previous_hash text;
	v_parent_entry_id text;
	v_body jsonb;
	v_text text;
	v_images jsonb;
	v_event_hash text;
begin
	if p_session_id is null
		or coalesce(cardinality(p_input_ids), 0) not between 1 and 32
		or cardinality(p_input_ids) <> (select count(distinct input_id) from unnest(p_input_ids) as input_id) then
		raise exception 'execution input transcript authority is invalid' using errcode = '42501';
	end if;
	select session.* into strict v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if (
		select count(*)
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
	) <> cardinality(p_input_ids) then
		raise exception 'execution input transcript set changed' using errcode = '23505';
	end if;
	select event.sequence, event.event_hash, event.body #>> '{entry,id}'
	into v_sequence, v_previous_hash, v_parent_entry_id
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	for v_input in
		select input.*
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
		order by input.position
	loop
		if v_input.kind <> 'user_message'
			or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' then
			continue;
		end if;
		select event.* into v_existing
		from public.qorpera_session_events as event
		where event.event_id = v_input.id;
		if found then
			if v_existing.session_id <> p_session_id
				or v_existing.session_input_id is distinct from v_input.id
				or v_existing.actor_user_id <> v_input.author_user_id
				or v_existing.event_type <> 'message' then
				raise exception 'session input event id is already bound to other content' using errcode = '23505';
			end if;
			continue;
		end if;
		v_text := coalesce(v_input.body ->> 'displayText', v_input.body ->> 'text', '');
		v_images := case when jsonb_typeof(v_input.body -> 'images') = 'array'
			then v_input.body -> 'images' else '[]'::jsonb end;
		if v_text = '' then
			v_text := case jsonb_array_length(v_images)
				when 1 then '[Attached image]'
				else '[' || jsonb_array_length(v_images)::text || ' attached images]'
			end;
		end if;
		v_body := jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'message',
				'id', v_input.id,
				'parentId', v_parent_entry_id,
				'timestamp', to_char(v_input.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'message', jsonb_build_object(
					'role', 'user',
					'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text)),
					'timestamp', floor(extract(epoch from v_input.created_at) * 1000)::bigint
				),
				'qorperaAttachments', v_images
			)
		);
		v_sequence := v_sequence + 1;
		v_event_hash := encode(extensions.digest(convert_to(
			coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
				'session_id', p_session_id,
				'sequence', v_sequence,
				'event_id', v_input.id,
				'event_type', 'message',
				'actor_user_id', v_input.author_user_id,
				'body', v_body,
				'session_input_id', v_input.id,
				'created_at', v_input.created_at
			)::text,
			'utf8'
		), 'sha256'), 'hex');
		insert into public.qorpera_session_events (
			session_id, sequence, event_id, event_type, actor_user_id, body,
			previous_hash, event_hash, session_input_id, created_at
		) values (
			p_session_id, v_sequence, v_input.id, 'message', v_input.author_user_id, v_body,
			v_previous_hash, v_event_hash, v_input.id, v_input.created_at
		);
		v_previous_hash := v_event_hash;
		v_parent_entry_id := v_input.id::text;
	end loop;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return v_sequence;
end
$$;


revoke all on function public.qorpera_append_admitted_input_events(uuid,uuid[]) from public,anon,authenticated,service_role,qorpera_secret_broker;
create or replace function public.qorpera_append_execution_input_events(p_session_id uuid,p_input_ids uuid[])
returns bigint language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'execution input transcript authority is invalid' using errcode='42501';
 end if;
 perform 1 from public.qorpera_shared_sessions where id=p_session_id and status='open' for update;
 if not found then raise exception 'execution input conversation is unavailable' using errcode='42501'; end if;
 return public.qorpera_append_admitted_input_events(p_session_id,p_input_ids);
end $$;

-- Preserve all prior admission/lock-order fixes, including later hardening.
do $$ declare definition text; needle text; begin
 definition:=pg_get_functiondef('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure);
 needle:=E'\treturn jsonb_build_object(\'schema\',\'qorpera.company-room-post/v1\'';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
  raise exception 'Room post return differs'; end if;
 execute replace(definition,needle,$patch$
	if not exists (select 1 from public.qorpera_shared_sessions session
	 where session.id=v_room.session_id and session.profile_id=v_room.profile_id
	 and session.environment_id=v_room.environment_id and session.execution_scope->>'roomId'=v_room.id::text)
	 then raise exception 'Room transcript binding is unavailable' using errcode='42501'; end if;
	perform public.qorpera_append_admitted_input_events(v_room.session_id,array[v_input.id]);
$patch$||needle);
end $$;

-- Repair already accepted room inputs, even if all their wakes remained blocked
-- or the room has since closed. Appending never rewrites earlier hashes/events.
do $$ declare item record; begin
 for item in select input.session_id,input.id from public.qorpera_session_inputs input
 join public.qorpera_company_rooms room on room.session_id=input.session_id
 join public.qorpera_shared_sessions session on session.id=room.session_id
 and session.profile_id=room.profile_id and session.environment_id=room.environment_id
 and session.execution_scope->>'roomId'=room.id::text
 where input.kind='user_message' and input.completed_at is not null
 and not exists(select 1 from public.qorpera_session_events event where event.event_id=input.id)
 order by input.session_id,input.position
 loop perform public.qorpera_append_admitted_input_events(item.session_id,array[item.id]); end loop;
end $$;

create table public.qorpera_session_event_speakers (
 event_id uuid primary key references public.qorpera_session_events(event_id) on delete cascade,
 run_id uuid not null,
 staff_agent_id uuid not null,
 staff_version bigint not null check(staff_version>0),
 display_name text
);
alter table public.qorpera_session_event_speakers enable row level security;
revoke all on public.qorpera_session_event_speakers from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_capture_session_event_speaker()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.execution_kind='run' and new.session_input_id is null and new.event_type='message'
 and new.body #>> '{entry,message,role}'='assistant'
 and new.body #>> '{entry,delivery,schema}'='qorpera.agent-send/v1'
 and new.body #>> '{entry,delivery,phase}' in ('progress','final') then
  insert into public.qorpera_session_event_speakers(event_id,run_id,staff_agent_id,staff_version,display_name)
  select new.event_id,run.id,run.staff_agent_id,run.staff_version,
   case when staff.version=run.staff_version then staff.display_name end
  from public.qorpera_execution_runs run
  join public.qorpera_shared_sessions session on session.id=new.session_id
   and session.profile_id=run.profile_id and session.environment_id=run.environment_id
  left join public.qorpera_profile_staff staff on staff.profile_id=run.profile_id and staff.staff_agent_id=run.staff_agent_id
  where run.id=new.execution_id and run.session_id=new.session_id;
  if not found then raise exception 'Public send speaker provenance is unavailable' using errcode='42501'; end if;
 end if;
 return new;
end $$;
revoke all on function public.qorpera_capture_session_event_speaker() from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_capture_session_event_speaker after insert on public.qorpera_session_events
 for each row execute function public.qorpera_capture_session_event_speaker();

insert into public.qorpera_session_event_speakers(event_id,run_id,staff_agent_id,staff_version,display_name)
select event.event_id,run.id,run.staff_agent_id,run.staff_version,
 case when staff.version=run.staff_version then staff.display_name end
from public.qorpera_session_events event
join public.qorpera_execution_runs run on run.id=event.execution_id and run.session_id=event.session_id
join public.qorpera_shared_sessions session on session.id=event.session_id
 and session.profile_id=run.profile_id and session.environment_id=run.environment_id
left join public.qorpera_profile_staff staff on staff.profile_id=run.profile_id and staff.staff_agent_id=run.staff_agent_id
where event.execution_kind='run' and event.session_input_id is null and event.event_type='message'
 and event.body #>> '{entry,message,role}'='assistant'
 and event.body #>> '{entry,delivery,schema}'='qorpera.agent-send/v1'
 and event.body #>> '{entry,delivery,phase}' in ('progress','final');

create function public.qorpera_keep_session_event_speaker()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Session speaker provenance is immutable' using errcode='42501'; end $$;
revoke all on function public.qorpera_keep_session_event_speaker() from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_keep_session_event_speaker before update on public.qorpera_session_event_speakers
 for each row execute function public.qorpera_keep_session_event_speaker();

create or replace function public.qorpera_read_session_events(p_session_id uuid,p_after_sequence bigint default 0,p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare events jsonb;
begin
 if not public.qorpera_can_read_session(p_session_id) then
  raise exception 'session read access is required' using errcode='42501'; end if;
 events:=public.qorpera_read_session_events_profile_scope(p_session_id,p_after_sequence,p_limit);
 return coalesce((select jsonb_agg(item.value || case when speaker.event_id is null then '{}'::jsonb else
  jsonb_build_object('staff_speaker',jsonb_build_object('run_id',speaker.run_id,'staff_agent_id',speaker.staff_agent_id,
   'staff_version',speaker.staff_version,'display_name',speaker.display_name)) end order by item.ordinality)
  from jsonb_array_elements(events) with ordinality item(value,ordinality)
  left join public.qorpera_session_event_speakers speaker on speaker.event_id=(item.value->>'event_id')::uuid),'[]'::jsonb);
end $$;
