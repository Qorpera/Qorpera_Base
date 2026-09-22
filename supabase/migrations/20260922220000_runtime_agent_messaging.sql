-- Agent-to-agent messaging in the Grok Bot shape (contract 14.6 and 8.1,
-- amended 2026-09-22). Until now a coworker message woke its recipient in a
-- run with no conversation and a forbidden mouth, and the causal fence refused
-- every reply to an agent already in the chain: delivered, invisible and
-- unanswerable. Now:
--
-- * Every pair of agents has one transcript: a company-audience session bound
--   to the unordered pair (execution_scope.agentPair), view-only for members.
--   A peer message is one event in that transcript, spoken by the sender.
-- * Both agents' own shared threads get a chip (session_info peer-link event):
--   "Messaged B" in the sender's thread, "Message from A" in the receiver's.
--   The chip carries no text; every surface involved is company audience.
-- * The receiver wakes in its OWN shared thread (the agent wake now carries
--   that session) under the pair policy: initial forbidden, final optional,
--   silence allowed, at most two public sends. It answers the coworker through
--   the same peer channel, which wakes the sender in the sender's thread.
-- * The visited-agent fence gives way, for coworker wakes only, to a hop
--   budget on the causal chain: at most 6 peer messages per exchange and 20
--   per pair per hour, on top of the company wake ceiling. A tripped budget
--   returns causal-fence to the tool and leaves one line in the transcript.
-- File-event and routine fences are unchanged. Workers (Order 5) keep their
-- own bus. Runtime bundle v70 reads the new envelope shape.

-- ---------------------------------------------------------------------------
-- 1. Pair transcripts
-- ---------------------------------------------------------------------------
create unique index qorpera_shared_sessions_agent_pair
	on public.qorpera_shared_sessions(profile_id,(execution_scope ->> 'agentPairKey'))
	where execution_scope ? 'agentPairKey';

create function public.qorpera_agent_pair_key(p_a uuid,p_b uuid)
returns text language sql immutable set search_path = '' as $$
	select least(p_a::text,p_b::text) || ':' || greatest(p_a::text,p_b::text)
$$;
revoke all on function public.qorpera_agent_pair_key(uuid,uuid) from public,anon,authenticated,service_role;

-- The one transcript of two agents: created on first use, retitled when a
-- name changes, reopened only while both agents are active.
create function public.qorpera_agent_pair_session_internal(
	p_profile_id uuid,p_environment_id uuid,p_a uuid,p_b uuid,p_actor_user_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_a public.qorpera_profile_staff%rowtype; v_b public.qorpera_profile_staff%rowtype;
	v_key text := public.qorpera_agent_pair_key(p_a,p_b); v_session public.qorpera_shared_sessions%rowtype;
	v_title text; v_active boolean;
begin
	if p_a is null or p_b is null or p_a = p_b then
		raise exception 'Agent pair is invalid' using errcode = '22023'; end if;
	select * into v_a from public.qorpera_profile_staff where profile_id = p_profile_id and staff_agent_id = p_a;
	select * into v_b from public.qorpera_profile_staff where profile_id = p_profile_id and staff_agent_id = p_b;
	if v_a.staff_agent_id is null or v_b.staff_agent_id is null then
		raise exception 'Agent pair is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_company_environments where id = p_environment_id and profile_id = p_profile_id) then
		raise exception 'Environment is unavailable' using errcode = '42501'; end if;
	v_active := v_a.employment_status = 'active' and v_a.deleted_at is null
		and v_b.employment_status = 'active' and v_b.deleted_at is null;
	v_title := least(v_a.display_name,v_b.display_name) || ' & ' || greatest(v_a.display_name,v_b.display_name);
	-- Two first messages between the same pair in the same instant create one transcript, not a unique violation.
	perform pg_advisory_xact_lock(hashtext('qorpera_agent_pair:' || p_profile_id::text || ':' || v_key));
	select * into v_session from public.qorpera_shared_sessions
	where profile_id = p_profile_id and execution_scope ->> 'agentPairKey' = v_key for update;
	if not found then
		if not v_active then raise exception 'Agent pair is unavailable' using errcode = '42501'; end if;
		insert into public.qorpera_shared_sessions(profile_id,environment_id,title,staff_agent_id,created_by_user_id,
			audience_kind,audience_user_id,execution_scope)
		values (p_profile_id,p_environment_id,v_title,null,p_actor_user_id,'company',null,
			jsonb_build_object('agentPair',jsonb_build_array(least(p_a::text,p_b::text),greatest(p_a::text,p_b::text)),
				'agentPairKey',v_key))
		returning * into v_session;
	else
		update public.qorpera_shared_sessions
		set status = case when v_active then 'open' else 'closed' end::public.qorpera_session_status,
			title = v_title, updated_at = statement_timestamp()
		where id = v_session.id and (status <> case when v_active then 'open' else 'closed' end::public.qorpera_session_status
			or title <> v_title);
	end if;
	return v_session.id;
end
$$;
revoke all on function public.qorpera_agent_pair_session_internal(uuid,uuid,uuid,uuid,uuid)
	from public,anon,authenticated,service_role;

-- What a woken agent reads of the exchange: the latest peer messages, oldest first.
create function public.qorpera_agent_pair_transcript_json(p_session_id uuid,p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('eventId',item.event_id,'staffAgentId',item.staff_agent_id,
		'text',left(item.text,1024),'at',to_char(item.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
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
revoke all on function public.qorpera_agent_pair_transcript_json(uuid,integer) from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 2. Kernel-authored session events (peer messages, chips, budget lines)
-- ---------------------------------------------------------------------------
-- The same hash chain as runner transcript events; with a run the event
-- carries that run's execution identity, without one it is plain metadata.
create function public.qorpera_append_kernel_session_event(
	p_session_id uuid,p_event_id uuid,p_event_type text,p_actor_user_id uuid,p_body jsonb,
	p_run_id uuid default null,p_assignment_id uuid default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_sequence bigint; v_previous_hash text; v_event_hash text;
	v_created_at timestamptz := clock_timestamp(); v_fields jsonb;
begin
	if p_session_id is null or p_event_id is null or p_event_type not in ('message','session_info') or p_actor_user_id is null
		or p_body is null or jsonb_typeof(p_body) <> 'object' or octet_length(convert_to(p_body::text,'utf8')) > 262144
		or (p_run_id is null) <> (p_assignment_id is null) then
		raise exception 'Kernel session event is invalid' using errcode = '22023'; end if;
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id for update;
	if not found or v_session.status <> 'open' then
		raise exception 'Kernel session event conversation is unavailable' using errcode = '42501'; end if;
	select event.sequence,event.event_hash into v_sequence,v_previous_hash
	from public.qorpera_session_events event where event.session_id = p_session_id order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence,0) + 1;
	v_fields := jsonb_build_object('session_id',p_session_id,'sequence',v_sequence,'event_id',p_event_id,
		'event_type',p_event_type,'actor_user_id',p_actor_user_id,'body',p_body);
	if p_run_id is not null then
		v_fields := v_fields || jsonb_build_object('execution_kind','run','execution_id',p_run_id,
			'execution_claimant_id',p_run_id,'runner_assignment_id',p_assignment_id);
	end if;
	v_fields := v_fields || jsonb_build_object('created_at',v_created_at);
	v_event_hash := encode(extensions.digest(convert_to(coalesce(v_previous_hash,'') || E'\n' || v_fields::text,'utf8'),'sha256'),'hex');
	insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,previous_hash,event_hash,
		execution_kind,execution_id,execution_claimant_id,runner_assignment_id,created_at)
	values (p_session_id,v_sequence,p_event_id,p_event_type,p_actor_user_id,p_body,v_previous_hash,v_event_hash,
		case when p_run_id is null then null else 'run' end,p_run_id,p_run_id,p_assignment_id,v_created_at);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = p_session_id;
	return v_sequence;
end
$$;
revoke all on function public.qorpera_append_kernel_session_event(uuid,uuid,text,uuid,jsonb,uuid,uuid)
	from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 3. Hop budget on the causal chain
-- ---------------------------------------------------------------------------
alter table public.qorpera_wake_occurrences
	add column causal_hop_count integer not null default 0 check (causal_hop_count between 0 and 64);
-- The per-pair hourly budget reads recent coworker occurrences by their transcript.
create index qorpera_wake_coworker_pair_recent
	on public.qorpera_wake_occurrences(profile_id,(payload ->> 'pairSessionId'),created_at)
	where source_kind = 'coworker';

-- The one rule for continuing a peer chain, used by the send (to refuse with a
-- receipt) and by admission (to refuse a wake): the recipient moves to the end
-- of the visited list; the chain ends at the hop budget or at sixteen agents.
create function public.qorpera_coworker_chain(p_agents uuid[],p_recipient uuid,p_hops integer)
returns uuid[] language plpgsql immutable set search_path = '' as $$
declare v_agents uuid[];
begin
	if p_recipient is null or p_hops is null or p_hops < 1 or p_hops > 6 then return null; end if;
	v_agents := array_remove(coalesce(p_agents,'{}'::uuid[]),p_recipient) || p_recipient;
	if cardinality(v_agents) > 16 then return null; end if;
	return v_agents;
end
$$;
revoke all on function public.qorpera_coworker_chain(uuid[],uuid,integer) from public,anon,authenticated,service_role;

-- An agent's own shared thread: the existing open one, else created.
create function public.qorpera_agent_thread_session_internal(
	p_profile_id uuid,p_environment_id uuid,p_staff_agent_id uuid,p_actor_user_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_session uuid;
begin
	select room.session_id into v_session from public.qorpera_company_rooms room
	join public.qorpera_shared_sessions session on session.id = room.session_id and session.status = 'open'
	where room.profile_id = p_profile_id and room.bound_staff_agent_id = p_staff_agent_id and room.status = 'active';
	if v_session is null then
		v_session := public.qorpera_ensure_agent_thread_internal(p_profile_id,p_environment_id,p_staff_agent_id,p_actor_user_id);
	end if;
	return v_session;
end
$$;
revoke all on function public.qorpera_agent_thread_session_internal(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- A coworker wake continues its parent's chain. The recipient may already be
-- in the chain (that is what a reply is); it moves to the end. The chain ends
-- at the hop budget, never at "seen before".
create function public.qorpera_coworker_wake_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_parent_run public.qorpera_execution_runs%rowtype; v_parent public.qorpera_wake_occurrences%rowtype;
	v_agents uuid[]; v_root uuid;
begin
	if p_wake.wake_kind <> 'agent' or p_wake.source_kind <> 'coworker' or p_wake.parent_run_id is null
		or p_wake.staff_agent_id is null then return null; end if;
	select * into v_parent_run from public.qorpera_execution_runs
	where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id;
	if v_parent_run.id is null or v_parent_run.staff_agent_id = p_wake.staff_agent_id then return null; end if;
	select w.* into v_parent from public.qorpera_wake_occurrences w
	where w.run_id = v_parent_run.id and w.staff_agent_id = v_parent_run.staff_agent_id;
	if v_parent.id is null then
		-- A run admitted before every run carried an occurrence starts a chain here.
		v_agents := array[v_parent_run.staff_agent_id]; v_root := p_wake.id;
		if p_wake.causal_hop_count > 1 then return null; end if;
	else
		if v_parent.wake_schema <> 'qorpera.wake-envelope/v1'
			or public.qorpera_runtime_wake_policy_internal(v_parent_run.id) ->> 'kind' is distinct from v_parent.wake_kind
			or v_parent.causal_root_id is null or cardinality(v_parent.causal_agent_ids) not between 1 and 16
			or (p_wake.causal_hop_count > 0 and p_wake.causal_hop_count <> v_parent.causal_hop_count + 1) then return null; end if;
		v_agents := v_parent.causal_agent_ids; v_root := v_parent.causal_root_id;
	end if;
	if p_wake.causal_hop_count = 0 then
		-- Admitted before v70: the chain was fenced at the first revisit and never counted hops.
		if p_wake.staff_agent_id = any(v_agents) then return null; end if;
		v_agents := v_agents || p_wake.staff_agent_id;
		if cardinality(v_agents) > 16 then return null; end if;
		return jsonb_build_object('rootId',v_root,'agentIds',to_jsonb(v_agents));
	end if;
	v_agents := public.qorpera_coworker_chain(v_agents,p_wake.staff_agent_id,p_wake.causal_hop_count);
	if v_agents is null then return null; end if;
	return jsonb_build_object('rootId',v_root,'agentIds',to_jsonb(v_agents));
end
$$;
revoke all on function public.qorpera_coworker_wake_ancestry(public.qorpera_wake_occurrences)
	from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 4. Admission, authorization and policy: patched in place, loudly
-- ---------------------------------------------------------------------------
create function pg_temp.messaging_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition,p_old,''))) / length(p_old) <> 1 then
		raise exception 'Agent messaging integration differs: % near %',p_target,left(p_old,60); end if;
	execute replace(v_definition,p_old,p_new);
end
$$;

-- The receiver wakes in its own shared thread, one hop further along the chain.
select pg_temp.messaging_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id end;$old$,
	$new$		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id
			when new.source_kind = 'coworker' then new.session_id end;
		if new.source_kind = 'coworker' then
			-- The send names the receiver's own shared thread; admission only checks it is that thread.
			if new.session_id is null or not exists (select 1 from public.qorpera_company_rooms room
				where room.profile_id = new.profile_id and room.bound_staff_agent_id = new.staff_agent_id
					and room.status = 'active' and room.session_id = new.session_id) then
				raise exception 'Coworker thread is unavailable' using errcode = '42501'; end if;
			select coalesce(parent.causal_hop_count,0) + 1 into new.causal_hop_count
			from public.qorpera_wake_occurrences parent where parent.run_id = new.parent_run_id;
			new.causal_hop_count := coalesce(new.causal_hop_count,1);
		end if;$new$);
select pg_temp.messaging_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$ else v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id)); end if;$old$,
	$new$ elsif new.source_kind = 'coworker' then v_ancestry := public.qorpera_coworker_wake_ancestry(new);
 else v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id)); end if;$new$);

select pg_temp.messaging_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$ else v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
  coalesce(p_wake.file_event_id,p_wake.id)); end if;$old$,
	$new$ elsif p_wake.source_kind = 'coworker' then v_ancestry := public.qorpera_coworker_wake_ancestry(p_wake);
 else v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
  coalesce(p_wake.file_event_id,p_wake.id)); end if;$new$);

-- The pair policy: no opening acknowledgement, a final word when the member
-- should know, silence allowed, two sends at most.
select pg_temp.messaging_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$and p_reporting in ('optional','required','silent','continuation') then$old$,
	$new$and p_reporting in ('optional','required','silent','continuation','pair') then$new$);
select pg_temp.messaging_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$		elsif p_kind = 'agent' and p_reporting = 'continuation' then$old$,
	$new$		elsif p_kind = 'agent' and p_reporting = 'pair' then
			-- A coworker's message in the agent's own thread: answer the peer; tell the member only when it matters.
			v_initial := 'forbidden'; v_final := 'optional'; v_max := 2;
		elsif p_kind = 'agent' and p_reporting = 'continuation' then$new$);
select pg_temp.messaging_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$		v_reporting := 'continuation'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$old$,
	$new$		v_reporting := 'continuation'; end if;
	-- A coworker message delivered into the agent's own thread carries the pair policy.
	if v_wake.source_kind = 'coworker' and v_wake.session_id is not null then v_reporting := 'pair'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$new$);

-- The woken agent reads the exchange so far, not only the latest text.
select pg_temp.messaging_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$		'routine',v_routine,'payload',v_wake.payload,'parentRunId',v_wake.parent_run_id,$old$,
	$new$		'routine',v_routine,'payload',v_wake.payload || case when v_wake.source_kind = 'coworker' and v_wake.payload ? 'pairSessionId'
			then jsonb_build_object('transcript',public.qorpera_agent_pair_transcript_json((v_wake.payload ->> 'pairSessionId')::uuid,12))
			else '{}'::jsonb end,'parentRunId',v_wake.parent_run_id,$new$);

-- An agent that leaves the company closes its pair transcripts with it.
create or replace function public.qorpera_agent_thread_on_staff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_environment uuid := public.qorpera_profile_environment(new.profile_id);
begin
	if v_environment is null then return new; end if;
	if tg_op = 'INSERT' and not (new.employment_status = 'active' and new.deleted_at is null) then return new; end if;
	perform public.qorpera_ensure_agent_thread_internal(new.profile_id,v_environment,new.staff_agent_id,new.updated_by_user_id);
	if not (new.employment_status = 'active' and new.deleted_at is null) then
		update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
		where profile_id = new.profile_id and status = 'open' and execution_scope -> 'agentPair' ? new.staff_agent_id::text;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_agent_thread_on_staff() from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 5. The send: transcript event, two chips, one wake
-- ---------------------------------------------------------------------------
create or replace function public.qorpera_send_coworker_message(
	p_binding jsonb,p_recipient_staff_id uuid,p_operation_key text,p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_digest text; v_receipt_id uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_occurrence uuid := extensions.gen_random_uuid(); v_path text; v_pair uuid; v_event uuid := extensions.gen_random_uuid();
	v_hops integer; v_hourly integer; v_parent_agents uuid[]; v_fence text; v_sender_thread uuid; v_recipient_thread uuid;
	v_parent_entry text; v_staff public.qorpera_profile_staff%rowtype; v_sequence bigint; v_thread record;
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
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema','qorpera.coworker-message/v1',
		'runId',v_run.id,'companyId',v_run.profile_id,'senderStaffId',v_run.staff_agent_id,
		'requesterUserId',v_run.requested_by_user_id,'recipientStaffId',p_recipient_staff_id,
		'operationKey',p_operation_key,'text',p_text)::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding,v_receipt_id,'coworker:' || p_operation_key,
		v_digest,encode(extensions.digest(convert_to(v_run.id::text || ':coworker:' || p_operation_key,'utf8'),'sha256'),'hex'),false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Coworker message requires reconciliation' using errcode = '55000'; end if;
	-- The budget first: hops along this chain, messages between this pair this hour.
	-- A refused send creates and touches nothing beyond the receipt and, when the
	-- pair already has a transcript, one line in it.
	select id into v_pair from public.qorpera_shared_sessions where profile_id = v_run.profile_id
		and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key(v_run.staff_agent_id,p_recipient_staff_id);
	select coalesce(parent.causal_hop_count,0) + 1,parent.causal_agent_ids into v_hops,v_parent_agents
	from public.qorpera_wake_occurrences parent where parent.run_id = v_run.id;
	v_hops := coalesce(v_hops,1);
	select count(*) into v_hourly from public.qorpera_wake_occurrences
	where profile_id = v_run.profile_id and source_kind = 'coworker' and v_pair is not null
		and payload ->> 'pairSessionId' = v_pair::text and created_at > clock_timestamp() - interval '1 hour';
	v_fence := case
		when v_hops > 6 then 'This exchange paused after ' || (v_hops - 1)::text || ' messages. A member can continue it by writing to either agent.'
		when v_hourly >= 20 then 'These two agents have exchanged ' || v_hourly::text || ' messages this hour and are paused until it passes.'
		when public.qorpera_coworker_chain(coalesce(v_parent_agents,array[v_run.staff_agent_id]),p_recipient_staff_id,v_hops) is null
			then 'This chain involves too many agents to continue.'
		end;
	if v_fence is null then
		-- The pair's transcript and both agents' own threads exist before anything is written.
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
		-- The transcript event is kernel-authored metadata of the sender's run, not a
		-- public send of it: it carries no run execution identity, so the one-mouth
		-- rule (an assistant message needs an explicit send) and the sender's own
		-- reply policy are untouched. The web reads the speaker from the entry.
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
					'receiptId',v_receipt_id,'operationKey',p_operation_key))));
		for v_thread in select * from (values
				(v_sender_thread,jsonb_build_object('schema','qorpera.peer-link/v1','direction','out',
					'counterpartStaffId',p_recipient_staff_id,'pairSessionId',v_pair,'eventId',v_event,'receiptId',v_receipt_id)),
				(v_recipient_thread,jsonb_build_object('schema','qorpera.peer-link/v1','direction','in',
					'counterpartStaffId',v_run.staff_agent_id,'pairSessionId',v_pair,'eventId',v_event,'receiptId',v_receipt_id))
			) chips(session_id,body) order by chips.session_id loop
			perform public.qorpera_append_kernel_session_event(v_thread.session_id,extensions.gen_random_uuid(),'session_info',
				v_run.requested_by_user_id,v_thread.body);
		end loop;
		insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
			parent_run_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
		values(v_occurrence,v_run.profile_id,v_run.environment_id,'agent','coworker',p_recipient_staff_id,
			v_run.id,v_authority.sponsor_binding_id,v_authority.sponsor_version,v_recipient_thread,'coworker',
			'coworker:' || v_run.id::text || ':' || p_operation_key,clock_timestamp(),clock_timestamp(),
			jsonb_build_object('text',p_text,'senderStaffId',v_run.staff_agent_id,'receiptId',v_receipt_id,
				'pairSessionId',v_pair,'pairEventId',v_event));
	else
		v_occurrence := null;
		-- One line says why the exchange stopped; the text itself is not delivered. It
		-- goes into the pair's transcript when there is one, otherwise (a chain that
		-- ran out between two agents who never talked) into the sender's own thread.
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
		'status',case when v_occurrence is null then 'causal-fence' else 'queued' end);
	-- Receipt, transcript event, chips and occurrence commit together. A lost RPC
	-- response is replayed by the existing ledger, never by re-sending text.
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt_id,v_digest,v_result);
	return v_result;
end
$$;
