-- Held delivery for agent-to-agent messages (contract 14.6, second cut).
-- A peer message sent with priority false is written into the pair transcript
-- and both agents' chips like any other, but wakes nobody: it waits in
-- qorpera_pending_peer_messages and is handed to the recipient at the start
-- of its next wake of any kind (payload.heldMessages), where it is data, not
-- a request. Thanks, status and FYIs therefore cost no run. Held messages do
-- not extend the causal chain (nothing runs), but they count toward the pair's
-- hourly budget so a flood of them is still refused with a receipt.

create table public.qorpera_pending_peer_messages (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	pair_session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	event_id uuid not null unique references public.qorpera_session_events(event_id) on delete cascade,
	sender_staff_id uuid not null,
	recipient_staff_id uuid not null,
	text text not null check (octet_length(text) between 1 and 4096),
	created_at timestamptz not null default clock_timestamp(),
	delivered_run_id uuid references public.qorpera_execution_runs(id) on delete set null,
	delivered_at timestamptz,
	check ((delivered_run_id is null) = (delivered_at is null))
);
create index qorpera_pending_peer_messages_waiting
	on public.qorpera_pending_peer_messages(profile_id,recipient_staff_id,created_at) where delivered_run_id is null;
create index qorpera_pending_peer_messages_pair_recent
	on public.qorpera_pending_peer_messages(profile_id,pair_session_id,created_at);
alter table public.qorpera_pending_peer_messages enable row level security;
revoke all on public.qorpera_pending_peer_messages from public,anon,authenticated,service_role;

-- What a waking agent finds left for it: the oldest twelve undelivered held
-- messages, claimed by this run; a re-read by the same run returns the same. A
-- claim by a run that then failed or was cancelled is offered again. Messages of
-- the pair whose transcript this wake already carries are claimed but not
-- repeated. Delivered rows older than a week are pruned along the way.
create function public.qorpera_drain_held_peer_messages(p_run public.qorpera_execution_runs,p_shown_pair uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_messages jsonb;
begin
	delete from public.qorpera_pending_peer_messages where id in (
		select id from public.qorpera_pending_peer_messages
		where profile_id = p_run.profile_id and delivered_at < clock_timestamp() - interval '7 days' limit 200);
	update public.qorpera_pending_peer_messages set delivered_run_id = p_run.id, delivered_at = clock_timestamp()
	where id in (select pending.id from public.qorpera_pending_peer_messages pending
		where pending.profile_id = p_run.profile_id and pending.recipient_staff_id = p_run.staff_agent_id
			and (pending.delivered_run_id is null or exists (
				select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
				where run.id = pending.delivered_run_id and job.status in ('failed','cancelled')))
		order by pending.created_at, pending.id limit 12 for update skip locked);
	select jsonb_agg(jsonb_build_object('eventId',pending.event_id,'staffAgentId',pending.sender_staff_id,
		'text',left(pending.text,400),'at',to_char(pending.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'pairSessionId',pending.pair_session_id) order by pending.created_at, pending.id)
	into v_messages
	from (select * from public.qorpera_pending_peer_messages where delivered_run_id = p_run.id
		and (p_shown_pair is null or pair_session_id <> p_shown_pair)
		order by created_at, id limit 12) pending;
	return case when v_messages is null then '{}'::jsonb else jsonb_build_object('heldMessages',v_messages) end;
end
$$;
revoke all on function public.qorpera_drain_held_peer_messages(public.qorpera_execution_runs,uuid)
	from public,anon,authenticated,service_role,qorpera_secret_broker;

-- (3) Every line the kernel hands a run is bounded by bytes as well as count:
-- twelve transcript lines and twelve held lines of at most 400 characters stay
-- well inside the 49152-byte envelope even in a four-byte script.
create or replace function public.qorpera_agent_pair_transcript_json(p_session_id uuid,p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('eventId',item.event_id,'staffAgentId',item.staff_agent_id,
		'text',left(item.text,400),'at',to_char(item.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
		order by item.sequence),'[]'::jsonb)
	from (
		select event.event_id,event.sequence,event.created_at,
			(event.body #>> '{entry,delivery,from}')::uuid as staff_agent_id,
			event.body #>> '{entry,message,content,0,text}' as text
		from public.qorpera_session_events event
		where event.session_id = p_session_id and event.event_type = 'message'
			and event.body #>> '{entry,delivery,schema}' = 'qorpera.peer-message/v1'
		order by event.sequence desc limit greatest(1,least(coalesce(p_limit,12),24))
	) item
$$;

create function pg_temp.held_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition,p_old,''))) / length(p_old) <> 1 then
		raise exception 'Held delivery integration differs: % near %',p_target,left(p_old,60); end if;
	execute replace(v_definition,p_old,p_new);
end
$$;

-- Every real wake of an agent (not a blank worker, not an office continuation)
-- carries what coworkers left for it since it last ran.
select pg_temp.held_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$			else '{}'::jsonb end,'parentRunId',v_wake.parent_run_id,$old$,
	$new$			else '{}'::jsonb end
			|| case when v_wake.source_kind in ('worker-dispatch','office-activation') then '{}'::jsonb
			else public.qorpera_drain_held_peer_messages(v_run,
				case when v_wake.source_kind = 'coworker' then (v_wake.payload ->> 'pairSessionId')::uuid end) end,'parentRunId',v_wake.parent_run_id,$new$);

-- The send, with priority. The four-argument form goes; the runtime's older
-- bundles call with four arguments and land on the default (priority true).
drop function public.qorpera_send_coworker_message(jsonb,uuid,text,text);
create function public.qorpera_send_coworker_message(
	p_binding jsonb,p_recipient_staff_id uuid,p_operation_key text,p_text text,p_priority boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_digest text; v_receipt_id uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_occurrence uuid := extensions.gen_random_uuid(); v_path text; v_pair uuid; v_event uuid := extensions.gen_random_uuid();
	v_hops integer; v_hourly integer; v_parent_agents uuid[]; v_fence text; v_sender_thread uuid; v_recipient_thread uuid;
	v_parent_entry text; v_staff public.qorpera_profile_staff%rowtype; v_sequence bigint; v_thread record;
	v_priority boolean := coalesce(p_priority,true);
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if p_recipient_staff_id is null or p_operation_key is null or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or p_text is null or p_text !~ '[^[:space:]]' or octet_length(p_text) > 4096 then
		raise exception 'Coworker message is invalid' using errcode = '22023'; end if;
	if p_recipient_staff_id = v_run.staff_agent_id then
		raise exception 'Coworker recipient is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and staff_agent_id = p_recipient_staff_id and employment_status = 'active' for share;
	if not found then raise exception 'Coworker recipient is unavailable' using errcode = '42501'; end if;
	select * into v_authority from public.qorpera_staff_execution_authorities
	where profile_id = v_run.profile_id and staff_agent_id = p_recipient_staff_id for share;
	if not found or not exists(select 1 from public.qorpera_execution_sponsor_versions s
		join public.qorpera_execution_sponsor_bindings b on b.id = s.binding_id
		where s.binding_id = v_authority.sponsor_binding_id and s.version = v_authority.sponsor_version
			and b.profile_id = v_run.profile_id and b.status = 'active' and s.allow_autonomous) then
		raise exception 'Coworker execution authority is unavailable' using errcode = '42501'; end if;
	for v_path in select path from public.qorpera_company_run_read_paths where run_id = v_run.id loop
		if not coalesce(public.qorpera_wake_path_authorized(v_run.environment_id,v_run.requested_by_user_id,
			p_recipient_staff_id,v_path),false) then
			raise exception 'Coworker audience cannot receive this context' using errcode = '42501'; end if;
	end loop;
	-- The digest of a priority message is unchanged from v70, so a receipt from
	-- before this migration still replays; a held message digests differently.
	v_digest := encode(extensions.digest(convert_to((jsonb_build_object('schema','qorpera.coworker-message/v1',
		'runId',v_run.id,'companyId',v_run.profile_id,'senderStaffId',v_run.staff_agent_id,
		'requesterUserId',v_run.requested_by_user_id,'recipientStaffId',p_recipient_staff_id,
		'operationKey',p_operation_key,'text',p_text)
		|| case when v_priority then '{}'::jsonb else jsonb_build_object('priority',false) end)::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding,v_receipt_id,'coworker:' || p_operation_key,
		v_digest,encode(extensions.digest(convert_to(v_run.id::text || ':coworker:' || p_operation_key,'utf8'),'sha256'),'hex'),false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Coworker message requires reconciliation' using errcode = '55000'; end if;
	-- The budget first: hops along this chain (a held message extends no chain),
	-- messages between this pair this hour (held ones count: they are still writes).
	select id into v_pair from public.qorpera_shared_sessions where profile_id = v_run.profile_id
		and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key(v_run.staff_agent_id,p_recipient_staff_id);
	select coalesce(parent.causal_hop_count,0) + 1,parent.causal_agent_ids into v_hops,v_parent_agents
	from public.qorpera_wake_occurrences parent where parent.run_id = v_run.id;
	v_hops := coalesce(v_hops,1);
	select (select count(*) from public.qorpera_wake_occurrences
			where profile_id = v_run.profile_id and source_kind = 'coworker' and v_pair is not null
				and payload ->> 'pairSessionId' = v_pair::text and created_at > clock_timestamp() - interval '1 hour')
		+ (select count(*) from public.qorpera_pending_peer_messages
			where profile_id = v_run.profile_id and v_pair is not null and pair_session_id = v_pair
				and created_at > clock_timestamp() - interval '1 hour')
	into v_hourly;
	v_fence := case
		when v_priority and v_hops > 6 then 'This exchange paused after ' || (v_hops - 1)::text || ' messages. A member can continue it by writing to either agent.'
		when v_hourly >= 20 then 'These two agents have exchanged ' || v_hourly::text || ' messages this hour and are paused until it passes.'
		when v_priority and public.qorpera_coworker_chain(coalesce(v_parent_agents,array[v_run.staff_agent_id]),p_recipient_staff_id,v_hops) is null
			then 'This chain involves too many agents to continue.'
		end;
	if v_fence is null then
		v_pair := public.qorpera_agent_pair_session_internal(v_run.profile_id,v_run.environment_id,v_run.staff_agent_id,
			p_recipient_staff_id,v_run.requested_by_user_id);
		-- Threads are resolved, and their sessions written, in one global order (by
		-- agent id, then by session id), so simultaneous sends around a ring of
		-- agents never wait on each other in a cycle.
		if v_run.staff_agent_id::text < p_recipient_staff_id::text then
			v_sender_thread := public.qorpera_agent_thread_session_internal(v_run.profile_id,v_run.environment_id,v_run.staff_agent_id,
				v_run.requested_by_user_id);
			v_recipient_thread := public.qorpera_agent_thread_session_internal(v_run.profile_id,v_run.environment_id,p_recipient_staff_id,
				v_run.requested_by_user_id);
		else
			v_recipient_thread := public.qorpera_agent_thread_session_internal(v_run.profile_id,v_run.environment_id,p_recipient_staff_id,
				v_run.requested_by_user_id);
			v_sender_thread := public.qorpera_agent_thread_session_internal(v_run.profile_id,v_run.environment_id,v_run.staff_agent_id,
				v_run.requested_by_user_id);
		end if;
		select * into v_staff from public.qorpera_profile_staff where profile_id = v_run.profile_id and staff_agent_id = v_run.staff_agent_id;
		select event.body #>> '{entry,id}' into v_parent_entry from public.qorpera_session_events event
		where event.session_id = v_pair and event.body #>> '{entry,id}' is not null order by event.sequence desc limit 1;
		v_sequence := public.qorpera_append_kernel_session_event(v_pair,v_event,'message',v_run.requested_by_user_id,
			jsonb_build_object('schema','qorpera.runner-transcript-entry/v1','entry',jsonb_build_object(
				'type','message','id',v_event,'parentId',v_parent_entry,
				'timestamp',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
				'message',jsonb_build_object('role','assistant','content',jsonb_build_array(jsonb_build_object('type','text','text',p_text))),
				'delivery',jsonb_build_object('schema','qorpera.peer-message/v1','from',v_run.staff_agent_id,'to',p_recipient_staff_id,
					'runId',v_run.id,'staffVersion',v_run.staff_version,
					'displayName',case when v_staff.version = v_run.staff_version then v_staff.display_name end,
					'receiptId',v_receipt_id,'operationKey',p_operation_key,'held',not v_priority))));
		for v_thread in select * from (values
				(v_sender_thread,jsonb_build_object('schema','qorpera.peer-link/v1','direction','out','held',not v_priority,
					'counterpartStaffId',p_recipient_staff_id,'pairSessionId',v_pair,'eventId',v_event,'receiptId',v_receipt_id)),
				(v_recipient_thread,jsonb_build_object('schema','qorpera.peer-link/v1','direction','in','held',not v_priority,
					'counterpartStaffId',v_run.staff_agent_id,'pairSessionId',v_pair,'eventId',v_event,'receiptId',v_receipt_id))
			) chips(session_id,body) order by chips.session_id loop
			perform public.qorpera_append_kernel_session_event(v_thread.session_id,extensions.gen_random_uuid(),'session_info',
				v_run.requested_by_user_id,v_thread.body);
		end loop;
		if v_priority then
			insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
				parent_run_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
			values(v_occurrence,v_run.profile_id,v_run.environment_id,'agent','coworker',p_recipient_staff_id,
				v_run.id,v_authority.sponsor_binding_id,v_authority.sponsor_version,v_recipient_thread,'coworker',
				'coworker:' || v_run.id::text || ':' || p_operation_key,clock_timestamp(),clock_timestamp(),
				jsonb_build_object('text',p_text,'senderStaffId',v_run.staff_agent_id,'receiptId',v_receipt_id,
					'pairSessionId',v_pair,'pairEventId',v_event));
		else
			v_occurrence := null;
			insert into public.qorpera_pending_peer_messages(profile_id,environment_id,pair_session_id,event_id,
				sender_staff_id,recipient_staff_id,text)
			values (v_run.profile_id,v_run.environment_id,v_pair,v_event,v_run.staff_agent_id,p_recipient_staff_id,p_text);
		end if;
	else
		v_occurrence := null;
		if v_pair is null or not exists (select 1 from public.qorpera_shared_sessions where id = v_pair and status = 'open') then
			v_pair := public.qorpera_agent_thread_session_internal(v_run.profile_id,v_run.environment_id,v_run.staff_agent_id,
				v_run.requested_by_user_id);
		end if;
		perform public.qorpera_append_kernel_session_event(v_pair,extensions.gen_random_uuid(),'session_info',
			v_run.requested_by_user_id,jsonb_build_object('schema','qorpera.peer-budget/v1','text',v_fence,
				'staffAgentId',v_run.staff_agent_id,'recipientStaffId',p_recipient_staff_id,'receiptId',v_receipt_id));
	end if;
	v_result := jsonb_build_object('schema','qorpera.coworker-send/v1','runId',v_run.id,
		'receiptId',v_receipt_id,'occurrenceId',v_occurrence,'recipientStaffId',p_recipient_staff_id,
		'status',case when v_fence is not null then 'causal-fence' when v_priority then 'queued' else 'held' end);
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt_id,v_digest,v_result);
	return v_result;
end
$$;
-- The runtime calls the send through its service role; no one else, and never the broker.
revoke all on function public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean)
	from public,anon,authenticated,qorpera_secret_broker;
grant execute on function public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean) to service_role;
