-- Company folder core, C1c-2c part 1: wake admission and coworker messages on the folder fence
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.7, §5.9).
--
-- Changes only folder-v2 behaviour; no real folder-v2 run exists yet (C1C §5.8). Snapshot-v1 keeps every path.
-- * Wake admission (core §3 step 10): qorpera_folder_admit_wakes takes the company's folder admission row FOR NO KEY
--   UPDATE, last before the folder clock, and marks the transaction. It takes no fence: every folder-v2 inserter has
--   taken the fence at step 3 already.
-- * The pin trigger, on folder-v2, takes no lock: it requires the admission mark (55000 without it), reads the
--   recipient's staff row without FOR SHARE and a routine's public session without FOR SHARE NOWAIT (the inserter holds
--   those rows at their ranks and the session at the sessions rank). The stop rule is today's. The legacy admission
--   fence and the profile row FOR UPDATE NOWAIT are never touched on folder-v2, so legacy inserters fail closed there
--   until C1c-3 gives them folder modes.
-- * The routine lifecycle trigger takes the routine FOR NO KEY UPDATE on folder-v2 (rank 5, where the inserter holds it).
-- * send_coworker_message and read_native_wake get folder bodies (below).
-- * The legacy multi-company loops skip folder-v2 companies in their scans' WHERE clauses, before their first lock:
--   the wake materializer, the office, worker, machine and Company File drains (with the dynamic-routine tick), and
--   the session materializer. The turn materializer already skips folder-v2 (its scan requires a head snapshot, which a
--   folder-v2 company never has). The routine expiry sweep is left as F2-6 designed it: it inserts no wake and takes no
--   company row.

-- 1. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ------------------------

create function pg_temp.c1c2c1_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1c-2c guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1c-2c guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1c-2c guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;
create function pg_temp.c1c2c1_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-2c patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. Wake admission ------------------------------------------------------------------------------------------------

-- The company's folder admission row, FOR NO KEY UPDATE (the update), as the last lock before the folder clock; it
-- counts admissions. The mark lets the pin trigger check that this transaction holds the row for this company.
create function public.qorpera_folder_admit_wakes(p_profile_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_folder_admissions set admitted = admitted + 1 where profile_id = p_profile_id;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	perform set_config('qorpera.folder_wake_admission', p_profile_id::text, true);
end $$;

-- A routine wake's public session, as qorpera_wake_public_session chooses it, without its FOR SHARE NOWAIT: on
-- folder-v2 the inserter holds the recipient's staff row at rank 2 and the session at the sessions rank, and a commit
-- that changes the agent holds the staff row FOR NO KEY UPDATE, which FOR SHARE would wait for (or, NOWAIT, 55P03).
create function public.qorpera_folder_wake_public_session(p_profile uuid, p_environment uuid, p_staff uuid, p_requester uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select s.id from public.qorpera_shared_sessions s
	join public.qorpera_profile_staff a on a.profile_id = s.profile_id
		and a.staff_agent_id = p_staff and a.version >= s.staff_version and a.employment_status = 'active'
	where s.profile_id = p_profile and s.environment_id = p_environment
		and s.staff_agent_id = p_staff::text and s.status = 'open'
		and (s.audience_kind = 'company' or (p_requester is not null and s.audience_kind = 'member_private'
			and s.audience_user_id = p_requester))
		and (coalesce(s.execution_scope ->> 'agentThread','') = 'true'
			or not (s.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))
	order by case when coalesce(s.execution_scope ->> 'agentThread','') = 'true' then 0 else 1 end,
		case when s.audience_kind = 'company' then 0 else 1 end, s.created_at, s.id
	limit 1
$$;

-- 3. The folder coworker message -----------------------------------------------------------------------------------

-- The legacy message's rules (arguments, the paying login, the audience, the digest and receipt, the chain budget, the
-- pair transcript, the peer chips, a held message) in C1C §5.6's order:
--   1. the run check with the recipient's rows as targets: staff (rank 2) and execution authority (rank 3) KEY SHARE,
--      and both agents' thread rooms (rank 4), KEY SHARE, or FOR UPDATE for a thread that must be created or reopened
--      (qorpera_ensure_agent_thread_internal locks its room that way, and a lock is never strengthened later). The
--      targets come from an unlocked read; if a thread changed before the locks, the send refuses as a retryable
--      conflict (QRC01, 409);
--   2. the receipt (run-owned);
--   3. the recheck at rank 10, and the recipient reads everything the run has read (C1B-2 §4, the parent's reads);
--   4. the pair lock;
--   5. the pair session and both threads that exist, FOR UPDATE in id order; then any that must be created;
--   6. the events; then admission and the wake (a priority message), or the held message.
create function public.qorpera_folder_send_coworker_message(p_binding jsonb, p_recipient_staff_id uuid, p_operation_key text,
	p_text text, p_priority boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_priority boolean := coalesce(p_priority, true); v_profile uuid; v_sender uuid; v_targets jsonb := '[]'::jsonb;
	v_room record; v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_sponsor uuid; v_sponsor_version bigint;
	v_audience public.qorpera_wake_occurrences%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_occurrence uuid := extensions.gen_random_uuid(); v_key text; v_pair uuid;
	v_event uuid := extensions.gen_random_uuid(); v_hops integer; v_parent_agents uuid[]; v_fence text;
	v_sender_thread uuid; v_recipient_thread uuid; v_parent_entry text; v_staff public.qorpera_profile_staff%rowtype;
	v_thread record;
begin
	-- The targets, from an unlocked read of the run and both agents' thread rooms.
	if coalesce(p_binding ->> 'runId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		and coalesce(p_binding ->> 'jobId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		select file.profile_id, run.staff_agent_id into v_profile, v_sender
		from public.qorpera_runner_jobs job
		join public.qorpera_company_files file on file.environment_id = job.environment_id and file.core = 'folder-v2'
		join public.qorpera_execution_runs run on run.id = job.run_id
		where job.id = (p_binding ->> 'jobId')::uuid and job.run_id = (p_binding ->> 'runId')::uuid;
	end if;
	if v_profile is not null and p_recipient_staff_id is not null and p_recipient_staff_id <> v_sender then
		v_targets := jsonb_build_array(
			jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || p_recipient_staff_id::text,
				'mode', 'keyshare', 'required', false),
			jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_profile::text || ':' || p_recipient_staff_id::text, 'mode', 'keyshare', 'required', false));
		for v_room in select room.id, coalesce(room.status = 'active' and session.status = 'open', false) as open_thread
			from public.qorpera_company_rooms room
			left join public.qorpera_shared_sessions session on session.id = room.session_id
			where room.profile_id = v_profile and room.bound_staff_agent_id in (v_sender, p_recipient_staff_id)
		loop
			v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms',
				'key', v_room.id::text, 'mode', case when v_room.open_thread then 'keyshare' else 'update' end, 'required', true));
		end loop;
	end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, v_targets);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if p_recipient_staff_id is null or p_operation_key is null or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or p_text is null or p_text !~ '[^[:space:]]' or octet_length(p_text) > 4096 then
		raise exception 'Coworker message is invalid' using errcode = '22023'; end if;
	if p_recipient_staff_id = v_run.staff_agent_id or not exists (select 1 from public.qorpera_profile_staff
		where profile_id = v_run.profile_id and staff_agent_id = p_recipient_staff_id and employment_status = 'active') then
		raise exception 'Coworker recipient is unavailable' using errcode = '42501'; end if;
	-- Every thread room that exists now is locked, and in FOR UPDATE if its thread must be created or reopened.
	if exists (select 1 from public.qorpera_company_rooms room
		left join public.qorpera_shared_sessions session on session.id = room.session_id
		where room.profile_id = v_run.profile_id and room.bound_staff_agent_id in (v_run.staff_agent_id, p_recipient_staff_id)
			and not exists (select 1 from jsonb_array_elements(v_targets) t
				where t ->> 'tbl' = 'qorpera_company_rooms' and t ->> 'key' = room.id::text
					and (t ->> 'mode' = 'update' or coalesce(room.status = 'active' and session.status = 'open', false)))) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Coworker thread changed while the message waited', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	-- The member who started this chain pays for the recipient's run (20260928230000).
	select payer.binding_id, payer.version into v_sponsor, v_sponsor_version
	from public.qorpera_starter_sponsor(v_run.profile_id, v_run.requested_by_user_id, p_recipient_staff_id,
		v_run.sponsor_binding_id) as payer;
	if v_priority and v_sponsor is null then
		raise exception 'Coworker execution authority is unavailable' using errcode = '42501'; end if;
	-- The legacy digest, so a message's key means the same on both cores.
	v_digest := encode(extensions.digest(convert_to((jsonb_build_object('schema','qorpera.coworker-message/v1',
		'runId',v_run.id,'companyId',v_run.profile_id,'senderStaffId',v_run.staff_agent_id,
		'requesterUserId',v_run.requested_by_user_id,'recipientStaffId',p_recipient_staff_id,
		'operationKey',p_operation_key,'text',p_text)
		|| case when v_priority then '{}'::jsonb else jsonb_build_object('priority',false) end)::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'coworker:' || p_operation_key, v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':coworker:' || p_operation_key,'utf8'),'sha256'),'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Coworker message requires reconciliation' using errcode = '55000'; end if;
	-- Rank 10: the run's released reads still hold, and the recipient may read every one of them (C1B-2 §4).
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	v_audience.profile_id := v_run.profile_id; v_audience.environment_id := v_run.environment_id;
	v_audience.parent_run_id := v_run.id; v_audience.staff_agent_id := p_recipient_staff_id;
	v_audience.requested_by_user_id := v_run.requested_by_user_id;
	if not public.qorpera_folder_parent_reads_allowed(v_audience) then
		raise exception 'Coworker audience cannot receive this context' using errcode = '42501'; end if;
	-- The pair lock, then every existing session the message may write, FOR UPDATE in id order (C1C §5.6).
	v_key := public.qorpera_agent_pair_key(v_run.staff_agent_id, p_recipient_staff_id);
	perform pg_advisory_xact_lock(hashtext('qorpera_agent_pair:' || v_run.profile_id::text || ':' || v_key));
	select id into v_pair from public.qorpera_shared_sessions where profile_id = v_run.profile_id
		and execution_scope ->> 'agentPairKey' = v_key;
	perform public.qorpera_folder_lock_sessions(v_run.environment_id, coalesce((select jsonb_agg(jsonb_build_object(
			'rank', 11, 'tbl', 'qorpera_shared_sessions', 'key', s.id::text, 'mode', 'update', 'required', false))
		from (select v_pair as id union select room.session_id from public.qorpera_company_rooms room
			where room.profile_id = v_run.profile_id and room.bound_staff_agent_id in (v_run.staff_agent_id, p_recipient_staff_id)) s
		where s.id is not null), '[]'::jsonb));
	-- The budget: hops along this chain (a held message extends no chain).
	select coalesce(parent.causal_hop_count,0) + 1,parent.causal_agent_ids into v_hops,v_parent_agents
	from public.qorpera_wake_occurrences parent where parent.run_id = v_run.id;
	v_hops := coalesce(v_hops,1);
	v_fence := case
		when v_priority and public.qorpera_coworker_chain(coalesce(v_parent_agents,array[v_run.staff_agent_id]),p_recipient_staff_id,v_hops) is null
			then 'This chain involves too many agents to continue.'
		end;
	if v_fence is null then
		v_pair := public.qorpera_agent_pair_session_internal(v_run.profile_id,v_run.environment_id,v_run.staff_agent_id,
			p_recipient_staff_id,v_run.requested_by_user_id);
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
		perform public.qorpera_append_kernel_session_event(v_pair,v_event,'message',v_run.requested_by_user_id,
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
			-- Admission: the last lock before the folder clock (core §3 step 10), then the wake.
			perform public.qorpera_folder_admit_wakes(v_run.profile_id);
			insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
				parent_run_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
			values(v_occurrence,v_run.profile_id,v_run.environment_id,'agent','coworker',p_recipient_staff_id,
				v_run.id,v_sponsor,v_sponsor_version,v_recipient_thread,'coworker',
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
	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

-- 4. The folder wake read ------------------------------------------------------------------------------------------

-- The legacy envelope. The wake check is the run check's (qorpera_folder_run_resolve: the folder wake authorization and
-- the policy kind); a Company File wake refuses there (0A000, C4). An agent wake (not a worker's dispatch) inherits the
-- parent run's folder reads into this run, re-resolved under this run's own authority, as of the first call that finds
-- any: they are filed under the wake's id, and a later call adds nothing. Then the recheck at rank 10. No company
-- snapshot pin: a folder-v2 run has none, and companySeq has no column yet (C4).
create function public.qorpera_folder_read_wake(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_reads jsonb; v_pairs jsonb; v_payload jsonb; v_routine jsonb := null; v_sender uuid; v_actor_user uuid;
begin
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if v_wake.wake_kind = 'agent' and v_wake.source_kind <> 'worker-dispatch' and v_wake.parent_run_id is not null
		and not exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_run.id and release_id = v_wake.id) then
		-- One read per path: the parent's latest record of it.
		select coalesce(jsonb_agg(latest.x order by public.qorpera_folder_key(latest.x ->> 'path')), '[]'::jsonb) into v_reads
		from (select distinct on (x ->> 'path') x from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.run_id = v_wake.parent_run_id order by x ->> 'path', rec.created_at desc, rec.release_id) latest;
		if jsonb_array_length(v_reads) > 0 then
			v_pairs := public.qorpera_folder_release_pairs(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved', v_reads);
			perform public.qorpera_folder_write_read_set(v_run.environment_id, v_run.id, v_pairs -> 'upserts', null, null);
			insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
			select v_run.id, v_wake.id, v_run.environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
				jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), repeat('0', 64)
			from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
		end if;
	end if;
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	if v_wake.wake_kind = 'routine' then
		select jsonb_build_object('id',routine_id,'version',version,'intent',prompt)
			|| case when triggers -> 0 ->> 'kind' = 'once' and jsonb_array_length(triggers) = 1 and exists (select 1
			from public.qorpera_cloud_routines r where r.id = routine_id and r.origin = 'agent')
			then jsonb_build_object('dynamic',true,'routineKey',(select r.routine_key from public.qorpera_cloud_routines r where r.id = routine_id))
			else '{}'::jsonb end into v_routine
		from public.qorpera_cloud_routine_versions where routine_id = v_wake.routine_id and version = v_wake.routine_version;
	end if;
	if v_wake.parent_run_id is not null then
		select staff_agent_id,requested_by_user_id into v_sender,v_actor_user
		from public.qorpera_execution_runs where id = v_wake.parent_run_id;
	elsif v_wake.source_kind in ('input','room') then v_actor_user := v_run.requested_by_user_id;
	end if;
	if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event') then
		v_sender := null; v_actor_user := null; end if;
	v_payload := jsonb_build_object('schema','qorpera.wake-envelope/v1','id',v_wake.id,'runId',v_run.id,
		'kind',v_wake.wake_kind,'companyId',v_run.profile_id,'environmentId',v_run.environment_id,
		'staffAgentId',v_run.staff_agent_id,'requesterUserId',v_run.requested_by_user_id,
		'actorStaffId',v_sender,'actorUserId',v_actor_user,
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id,'sessionId',v_run.session_id),
		'source',jsonb_build_object('kind',v_wake.source_kind,'id',v_wake.source_id,'occurrenceKey',v_wake.occurrence_key),
		'policy',public.qorpera_runtime_wake_policy(v_run.id),
		'time',jsonb_build_object('utc',to_char(v_wake.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'local',to_char(v_wake.scheduled_for at time zone v_wake.time_zone,'YYYY-MM-DD"T"HH24:MI:SS.US'),'timeZone',v_wake.time_zone),
		'pins',jsonb_build_object('companySnapshotId',v_run.company_snapshot_id,'staffVersion',v_run.staff_version,
			'wakeSchema','qorpera.wake-envelope/v1','runtimeBundleVersion',null),
		'routine',v_routine,'payload',v_wake.payload || case when v_wake.source_kind = 'coworker' and v_wake.payload ? 'pairSessionId'
			then jsonb_build_object('transcript',public.qorpera_agent_pair_transcript_json((v_wake.payload ->> 'pairSessionId')::uuid,12))
			else '{}'::jsonb end
			|| case when v_wake.source_kind in ('worker-dispatch','office-activation') then '{}'::jsonb
			else public.qorpera_drain_held_peer_messages(v_run,
				case when v_wake.source_kind = 'coworker' then (v_wake.payload ->> 'pairSessionId')::uuid end) end,'parentRunId',v_wake.parent_run_id,
		'causal',jsonb_build_object('rootId',v_wake.causal_root_id,'agentIds',to_jsonb(v_wake.causal_agent_ids)));
	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;
	return v_payload;
end $$;

-- 5. Dispatch, the triggers' folder modes and the loops' skips ------------------------------------------------------

do $$
begin
	perform pg_temp.c1c2c1_guard('public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean)',
		'if public.qorpera_binding_is_folder_v2(p_binding) then return public.qorpera_folder_send_coworker_message('
		|| 'p_binding, p_recipient_staff_id, p_operation_key, p_text, p_priority); end if;');
	perform pg_temp.c1c2c1_guard('public.qorpera_read_native_wake(jsonb)',
		'if public.qorpera_binding_is_folder_v2(p_binding) then return public.qorpera_folder_read_wake(p_binding); end if;');

	-- The pin trigger. On folder-v2 it locks nothing: the admission mark instead of the legacy fence and the profile row
	-- FOR UPDATE NOWAIT; the recipient's staff row without FOR SHARE; a routine's public session without FOR SHARE NOWAIT.
	perform pg_temp.c1c2c1_replace('public.qorpera_pin_wake_occurrence()',
		E' perform public.qorpera_serialize_wake_admission(new.profile_id);\n',
		E' if public.qorpera_company_is_folder_v2(new.profile_id) then\n'
		|| E'\t\tif current_setting(''qorpera.folder_wake_admission'', true) is distinct from new.profile_id::text then\n'
		|| E'\t\t\traise exception ''Folder wake admission is required'' using errcode = ''55000''; end if;\n'
		|| E'\telse\n'
		|| E' perform public.qorpera_serialize_wake_admission(new.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_pin_wake_occurrence()',
		E'\tselect * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id\n'
		|| E'\t\tand staff_agent_id = new.staff_agent_id and employment_status = ''active'' for share;\n',
		E'\tif public.qorpera_company_is_folder_v2(new.profile_id) then\n'
		|| E'\t\tselect * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id\n'
		|| E'\t\t\tand staff_agent_id = new.staff_agent_id and employment_status = ''active'';\n'
		|| E'\telse\n'
		|| E'\tselect * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id\n'
		|| E'\t\tand staff_agent_id = new.staff_agent_id and employment_status = ''active'' for share;\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_pin_wake_occurrence()',
		E'\t\tnew.session_id := public.qorpera_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,new.requested_by_user_id);\n',
		E'\t\tnew.session_id := case when public.qorpera_company_is_folder_v2(new.profile_id)\n'
		|| E'\t\t\tthen public.qorpera_folder_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,new.requested_by_user_id)\n'
		|| E'\t\t\telse public.qorpera_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,new.requested_by_user_id) end;\n', 1);

	-- The routine lifecycle: FOR NO KEY UPDATE on folder-v2, where the inserter holds the routine at rank 5.
	perform pg_temp.c1c2c1_replace('public.qorpera_routine_occurrence_lifecycle()',
		E'\tselect * into v_routine from public.qorpera_cloud_routines where id = new.routine_id for update;\n',
		E'\tif public.qorpera_company_is_folder_v2(new.profile_id) then\n'
		|| E'\t\tselect * into v_routine from public.qorpera_cloud_routines where id = new.routine_id for no key update;\n'
		|| E'\telse\n'
		|| E'\tselect * into v_routine from public.qorpera_cloud_routines where id = new.routine_id for update;\n'
		|| E'\tend if;\n', 1);

	-- The legacy multi-company loops skip folder-v2 in their scans, before their first lock (C1C §5.6).
	perform pg_temp.c1c2c1_replace('public.qorpera_materialize_wake_execution_runs(integer)',
		E'\t\twhere status = ''queued'' and not_before <= v_now\n',
		E'\t\twhere status = ''queued'' and not_before <= v_now\n'
		|| E'\t\t\tand not public.qorpera_company_is_folder_v2(profile_id)\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_drain_office_activation_wakes(integer)',
		E' for v_waiter in select * from public.qorpera_runtime_office_start_waiters where state=''waiting''\n',
		E' for v_waiter in select * from public.qorpera_runtime_office_start_waiters where state=''waiting''\n'
		|| E'  and not exists (select 1 from public.qorpera_execution_runs parent\n'
		|| E'   where parent.id = qorpera_runtime_office_start_waiters.parent_run_id and public.qorpera_company_is_folder_v2(parent.profile_id))\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_drain_worker_wakes(integer)',
		E'\tfor v_worker in select * from public.qorpera_runtime_workers where state = ''active'' or completion_state = ''waiting''\n',
		E'\tfor v_worker in select * from public.qorpera_runtime_workers where (state = ''active'' or completion_state = ''waiting'')\n'
		|| E'\t\tand not public.qorpera_company_is_folder_v2(profile_id)\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_drain_machine_wakes(integer)',
		E'\tfor v_event in select * from public.qorpera_company_machine_events where delivery = ''waiting''\n',
		E'\tfor v_event in select * from public.qorpera_company_machine_events where delivery = ''waiting''\n'
		|| E'\t\tand not public.qorpera_company_is_folder_v2(profile_id)\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_drain_company_file_wakes_before_lifecycle(integer)',
		E'\t\tselect c.* from public.qorpera_company_file_wake_cursors c where c.active\n',
		E'\t\tselect c.* from public.qorpera_company_file_wake_cursors c where c.active\n'
		|| E'\t\t\tand not public.qorpera_environment_is_folder_v2(c.environment_id)\n', 1);
	-- The dynamic-routine tick runs inside the Company File drain; routine firing gets its folder mode in C1c-3.
	perform pg_temp.c1c2c1_replace('public.qorpera_restore_dynamic_routine_runs()',
		E'\t\t\tand not public.qorpera_company_execution_paused(routine.profile_id)\n',
		E'\t\t\tand not public.qorpera_company_execution_paused(routine.profile_id)\n'
		|| E'\t\t\tand not public.qorpera_company_is_folder_v2(routine.profile_id)\n', 1);
	perform pg_temp.c1c2c1_replace('public.qorpera_materialize_session_execution_runs(integer)',
		E'\t\t\tand not public.qorpera_company_execution_paused(session.profile_id)\n',
		E'\t\t\tand not public.qorpera_company_execution_paused(session.profile_id)\n'
		|| E'\t\t\tand not public.qorpera_company_is_folder_v2(session.profile_id)\n', 1);
	-- The turn materializer needs no skip: its scan requires the company's head snapshot, which a folder-v2 company never
	-- has (qorpera_company_files_core_head).
end $$;

-- 6. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through the dispatchers and the folder paths.
revoke all on function public.qorpera_folder_admit_wakes(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_wake_public_session(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_send_coworker_message(jsonb, uuid, text, text, boolean)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_read_wake(jsonb) from public, anon, authenticated, service_role;
