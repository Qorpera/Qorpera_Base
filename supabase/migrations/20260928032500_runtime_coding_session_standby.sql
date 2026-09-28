-- Coding sessions stand by between turns (Jonas, 2026-09-28).
--
-- Until now every turn ended with a full detach: the session's commands were
-- stopped, its user and boot-local state removed and its NAS folders
-- unplugged, and the next turn set all of it up again. From the agent's side
-- every turn was an archive. Now a session is like a Claude Code session:
--
--   * Working: a turn runs (the queue lease of Step 9, unchanged).
--   * Standing by: the turn has ended; the session stays attached to its
--     member's machine with its user, its folders and whatever it started. A
--     command keeps running after the turn that started it, and a later turn
--     can read or cancel it.
--   * Asleep: the machine is powered off. It sleeps after the environment's
--     sleep delay with no turn and no command using the processor; a program
--     that only waits (a dev server) does not keep it awake. Sleep stops every
--     program (LXD refuses stateful stop for a VM with shared folders, which
--     every session's NAS folders are); files stay. The next turn wakes it.
--   * Archived: the member, the agent or the executor after a long quiet
--     period closes the session. Its programs stop and it is taken off the
--     machine; its NAS folders stay. A follow-up or an answer reopens it.
--
-- The attachment is its own renewable authority, separate from the turn: an
-- attachment token and deadline on the session, taken by the turn that puts
-- the session on its machine and renewed by the machine's executor
-- (qorpera_keep_coding_attachments) while the session is open, its owner is a
-- member and its repository grant stands. The guest's watchdog lease follows
-- the attachment, so a lost executor still stops the session's programs
-- within a minute; an expired attachment is never renewed, and the next turn
-- takes a new one, which stops everything the old one left. A command still
-- starts only in a turn (qorpera_authorize_coding_command, unchanged for
-- start); reading and cancelling reach the session's commands of any turn.
--
-- A machine is removed once asleep with none of its member's sessions open in
-- the environment (after the removal delay, now counted from sleep with no
-- open session), not after a bare day asleep.

-- ---------------------------------------------------------------------------
-- 1. State
-- ---------------------------------------------------------------------------
alter table public.qorpera_coding_sessions
	add column archived_at timestamptz,
	add column archived_by text check (archived_by in ('member','agent','kernel')),
	-- The machine the session is attached to, the attachment's generation and its deadline.
	add column attached_machine_id uuid references public.qorpera_coding_machines(id) on delete restrict,
	add column attachment_token uuid,
	add column attachment_until timestamptz,
	-- The executor's last look inside the machine: the session's commands still running,
	-- each {commandId, turn, command} (the command's first 300 bytes), and when they last used the processor.
	add column running_commands jsonb not null default '[]'::jsonb
		check (jsonb_typeof(running_commands) = 'array' and pg_column_size(running_commands) <= 65536),
	add column observed_at timestamptz,
	add column busy_at timestamptz,
	add constraint qorpera_coding_sessions_archived check ((archived_at is null) = (archived_by is null)),
	add constraint qorpera_coding_sessions_attachment check ((attached_machine_id is null) = (attachment_token is null)
		and (attachment_token is null) = (attachment_until is null));
create index qorpera_coding_sessions_attached on public.qorpera_coding_sessions (attached_machine_id) where attached_machine_id is not null;
create index qorpera_coding_sessions_open on public.qorpera_coding_sessions (environment_id, updated_at) where archived_at is null;

-- The last time any command on the machine used the processor.
alter table public.qorpera_coding_machines add column busy_at timestamptz;

-- A session with no turn and no busy command for this long is archived by the executor (default 30 days).
alter table public.qorpera_coding_executors
	add column session_archive_after_seconds integer not null default 2592000
		check (session_archive_after_seconds between 3600 and 315360000),
	alter column machine_remove_after_seconds set default 600;
-- The removal delay now counts once no session of the member is open, so a day is no longer needed.
update public.qorpera_coding_executors set machine_remove_after_seconds = 600 where machine_remove_after_seconds = 86400;

-- ---------------------------------------------------------------------------
-- 2. Archive and reopen
-- ---------------------------------------------------------------------------
-- Internal: the caller holds the worker (qorpera_lock_coding_worker, or the
-- agent's todo and worker). A turn still working is cancelled first. The
-- attachment ends now, so the executor's next pass detaches the session.
create function public.qorpera_archive_coding_worker(p_worker public.qorpera_runtime_workers, p_by text, p_run_id uuid, p_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
	if p_worker.species <> 'coding' or p_by not in ('member','agent','kernel') then
		raise exception 'Only a coding session can be archived' using errcode = '22023'; end if;
	if p_worker.state = 'active' then perform public.qorpera_cancel_worker(p_worker, p_run_id, 'archived'); end if;
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = p_by,
		attachment_until = case when attachment_until is not null then least(attachment_until, clock_timestamp()) end
	where worker_id = p_worker.id and archived_at is null;
	if not found then return false; end if;
	perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, 'step', 'kernel',
		jsonb_build_object('text', 'Archived', 'archived', true, 'by', p_by, 'userId', p_user_id));
	return true;
end
$$;

-- The owner archives a session from its thread. Repeating it answers the same.
create function public.qorpera_archive_coding_session(p_worker_id uuid, p_client_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
begin
	if p_client_request_id is null then raise exception 'Coding session archive is invalid' using errcode = '22023'; end if;
	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	v_worker := public.qorpera_lock_coding_worker(v_worker.id);
	perform public.qorpera_archive_coding_worker(v_worker, 'member', null, auth.uid());
	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;

-- The executor archives its environments' sessions that have been quiet for the
-- configured time: no turn, no command using the processor. A few per call.
create function public.qorpera_archive_quiet_coding_sessions(p_owner text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_candidate record; v_worker public.qorpera_runtime_workers%rowtype; v_count integer := 0;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
		raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	for v_candidate in
		select session.worker_id from public.qorpera_coding_sessions session
		join public.qorpera_coding_executors executor on executor.environment_id = session.environment_id and executor.owner = p_owner
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id
		where session.archived_at is null and worker.state <> 'active'
			and greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))
				< clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds)
		order by session.updated_at limit 8
	loop
		-- The todo and worker first, as every other writer of a coding worker.
		v_worker := public.qorpera_lock_coding_worker(v_candidate.worker_id);
		if v_worker.state <> 'active' and public.qorpera_archive_coding_worker(v_worker, 'kernel', null, null) then
			v_count := v_count + 1; end if;
	end loop;
	return v_count;
end
$$;

create function pg_temp.standby_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding standby integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- A new turn reopens an archived session: the dispatch, the agent's follow-up and the owner's answer all open a turn.
select pg_temp.standby_patch('public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)',
	$old$	values (p_worker.id, p_worker.sequence, p_from, case when p_from <> 'dispatch' then p_text end, p_user_id, p_run_id);$old$,
	$new$	values (p_worker.id, p_worker.sequence, p_from, case when p_from <> 'dispatch' then p_text end, p_user_id, p_run_id);
	update public.qorpera_coding_sessions set archived_at = null, archived_by = null where worker_id = p_worker.id and archived_at is not null;
	if found then
		perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, 'step', 'kernel', jsonb_build_object('text', 'Reopened', 'reopened', true));
	end if;$new$);

-- The agent archives a coding session with manage_worker action "archive".
select pg_temp.standby_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)',
	$old$		or v_action not in ('status','dispatch','followup','cancel','decide') then$old$,
	$new$		or v_action not in ('status','dispatch','followup','cancel','decide','archive') then$new$);
select pg_temp.standby_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)',
	$old$	elsif v_action = 'cancel' then
		perform public.qorpera_cancel_worker(v_worker, v_run.id, 'parent_cancelled');$old$,
	$new$	elsif v_action = 'archive' then
		if v_worker.species <> 'coding' then raise exception 'Only a coding session can be archived' using errcode = '22023'; end if;
		perform public.qorpera_archive_coding_worker(v_worker, 'agent', v_run.id, null);
		select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	elsif v_action = 'cancel' then
		perform public.qorpera_cancel_worker(v_worker, v_run.id, 'parent_cancelled');$new$);

-- ---------------------------------------------------------------------------
-- 3. The attachment
-- ---------------------------------------------------------------------------
-- The turn that has installed its session on the member's machine records the
-- attachment, under the same run authority as every other effect of the turn.
-- The same machine with a live attachment keeps its token (a new turn of a
-- session standing by); otherwise a new token starts a new generation, and the
-- guest stops whatever an earlier generation left before it takes it.
create function public.qorpera_attach_coding_session(p_worker_id uuid, p_lease_token uuid, p_binding_text text, p_storage jsonb,
	p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_admission jsonb; v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_machine_id uuid; v_token uuid;
begin
	v_admission := public.qorpera_authorize_coding_machine_run(p_worker_id, p_lease_token, p_binding_text, p_storage, p_machine_id_sha256);
	if v_admission ->> 'schema' is distinct from 'qorpera.coding-machine-admission/v1' then return v_admission; end if;
	v_machine_id := (v_admission ->> 'machineId')::uuid;
	-- Run authority holds the worker and the session.
	select * into strict v_worker from public.qorpera_runtime_workers where id = p_worker_id;
	select * into strict v_session from public.qorpera_coding_sessions where worker_id = p_worker_id for update;
	if v_session.archived_at is not null then raise exception 'Coding session is archived' using errcode = '55000'; end if;
	if v_session.attached_machine_id is distinct from v_machine_id and v_session.attachment_until > clock_timestamp() then
		raise exception 'Coding session is attached to another machine' using errcode = '42501'; end if;
	v_token := case when v_session.attached_machine_id = v_machine_id and v_session.attachment_until > clock_timestamp()
		then v_session.attachment_token else extensions.gen_random_uuid() end;
	update public.qorpera_coding_sessions set attached_machine_id = v_machine_id, attachment_token = v_token,
		attachment_until = clock_timestamp() + interval '60 seconds'
	where worker_id = v_worker.id returning * into v_session;
	return jsonb_build_object('schema','qorpera.coding-attachment/v1','state','attached','workerId',v_worker.id,'machineId',v_machine_id,
		'attachmentToken',v_token,'validForMs',59000,
		'turn',jsonb_build_object('sequence',v_worker.sequence,'turnId',public.qorpera_coding_turn_id(v_worker.id, v_worker.sequence),'open',true));
end
$$;

-- Internal: the machine this executor planned on this node, read without a lock.
-- The keeper and the detach record lock sessions before the machine, the
-- order of every other coding call.
create function public.qorpera_coding_machine_owned(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns public.qorpera_coding_machines language plpgsql stable security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_machine_id is null or octet_length(coalesce(p_binding_text,'')) not between 2 and 16384
		or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	select * into v_machine from public.qorpera_coding_machines where id = p_machine_id;
	if v_machine.id is null or v_machine.kind <> 'member' or v_machine.owner <> p_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256
		or v_machine.binding <> p_binding_text::jsonb or v_machine.removed_at is not null
		or v_machine.instance_sha256 is distinct from encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex') then
		raise exception 'Coding machine custody differs' using errcode = '42501'; end if;
	return v_machine;
end
$$;

-- Internal: why a session may not stay attached, or null. Archived, its
-- attachment expired, its owner no longer a member, its repository grant
-- withdrawn, or no enabled executor for its environment on this machine's owner.
create function public.qorpera_coding_attachment_refusal(p_session public.qorpera_coding_sessions, p_worker public.qorpera_runtime_workers,
	p_machine public.qorpera_coding_machines)
returns text language sql stable security definer set search_path = '' as $$
	select case
		when p_session.archived_at is not null then 'ARCHIVED'
		when p_session.attachment_until is null or p_session.attachment_until <= clock_timestamp() then 'EXPIRED'
		when not exists (select 1 from public.qorpera_profile_members member where member.profile_id = p_worker.profile_id
			and member.user_id = p_worker.owner_user_id) then 'OWNER_LEFT'
		when not exists (select 1 from public.qorpera_coding_repository_grants grant_row where grant_row.environment_id = p_session.environment_id
			and grant_row.staff_agent_id = p_worker.staff_agent_id and grant_row.repository = p_session.repository and grant_row.enabled) then 'REPOSITORY_WITHDRAWN'
		when not exists (select 1 from public.qorpera_coding_executors executor where executor.environment_id = p_machine.environment_id
			and executor.owner = p_machine.owner and executor.enabled) then 'EXECUTOR_DISABLED'
	end
$$;

-- The machine's executor keeps its sessions attached, every few seconds while
-- the machine is awake, and reports what it saw inside: which of each
-- session's commands still run and whether any used the processor. A session
-- that may stay gets its deadline renewed for a minute and its latest admitted
-- turn: the current one once claimed, else the one before (a follow-up waiting
-- in the queue has not been admitted, and the guest never reopens a turn it
-- was told is closed). The turn is open while it is preparing or running with
-- a live lease: only then may a command start. A session that may not stay has
-- its attachment ended now, and the executor detaches it. Nothing here waits
-- for the profile row: sessions, then the machine.
create function public.qorpera_keep_coding_attachments(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text,
	p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_seen jsonb; v_refusal text; v_entries jsonb := '[]'::jsonb; v_busy boolean;
	v_admitted integer;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_observation is not null and (jsonb_typeof(p_observation) <> 'object'
		or p_observation - array['schema','busy','sessions'] <> '{}'::jsonb
		or p_observation ->> 'schema' is distinct from 'qorpera.coding-machine-observation/v1'
		or jsonb_typeof(p_observation -> 'busy') <> 'boolean' or jsonb_typeof(p_observation -> 'sessions') <> 'array'
		or pg_column_size(p_observation) > 1048576
		or exists (select 1 from jsonb_array_elements(p_observation -> 'sessions') entry
			where jsonb_typeof(entry) <> 'object' or entry - array['workerId','busy','running'] <> '{}'::jsonb
				or coalesce(entry ->> 'workerId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				or jsonb_typeof(entry -> 'busy') <> 'boolean' or jsonb_typeof(entry -> 'running') <> 'array'
				or pg_column_size(entry -> 'running') > 65536
				or exists (select 1 from jsonb_array_elements(entry -> 'running') command
					where jsonb_typeof(command) <> 'object' or command - array['commandId','turn','command'] <> '{}'::jsonb
						or coalesce(command ->> 'commandId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
						or jsonb_typeof(command -> 'turn') <> 'number' or (command ->> 'turn')::numeric < 1
						or jsonb_typeof(command -> 'command') <> 'string' or octet_length(command ->> 'command') > 300))) then
		raise exception 'Coding machine observation invalid' using errcode = '22023'; end if;
	for v_session in select * from public.qorpera_coding_sessions where attached_machine_id = v_machine.id order by worker_id for update loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		v_refusal := public.qorpera_coding_attachment_refusal(v_session, v_worker, v_machine);
		select entry into v_seen from jsonb_array_elements(p_observation -> 'sessions') entry where entry ->> 'workerId' = v_session.worker_id::text limit 1;
		update public.qorpera_coding_sessions set
			attachment_until = case when v_refusal is null then clock_timestamp() + interval '60 seconds' else least(attachment_until, clock_timestamp()) end,
			running_commands = case when v_seen is null then running_commands else v_seen -> 'running' end,
			observed_at = case when v_seen is null then observed_at else clock_timestamp() end,
			busy_at = case when (v_seen ->> 'busy')::boolean then clock_timestamp() else busy_at end
		where worker_id = v_session.worker_id returning * into v_session;
		v_admitted := case when v_worker.state = 'active' and v_session.phase in ('queued','input_ready')
			then greatest(v_worker.sequence - 1, 1) else v_worker.sequence end;
		v_entries := v_entries || jsonb_build_array(case when v_refusal is null then jsonb_build_object('workerId',v_session.worker_id,'state','kept',
			'attachmentToken',v_session.attachment_token,'validForMs',59000,
			'turn',jsonb_build_object('sequence',v_admitted,'turnId',public.qorpera_coding_turn_id(v_worker.id, v_admitted),
				'open',v_admitted = v_worker.sequence and v_worker.state = 'active' and v_session.phase in ('preparing','running')
					and v_session.lease_until > clock_timestamp()))
			else jsonb_build_object('workerId',v_session.worker_id,'state','release','reason',v_refusal,'attachmentToken',v_session.attachment_token) end);
	end loop;
	v_busy := coalesce((p_observation ->> 'busy')::boolean, false);
	if v_busy then update public.qorpera_coding_machines set busy_at = clock_timestamp() where id = v_machine.id; end if;
	return jsonb_build_object('schema','qorpera.coding-attachments/v1','machineId',v_machine.id,'sessions',v_entries);
end
$$;

-- The executor has detached a session from the machine (its commands stopped,
-- its user and boot-local state removed, its folders unplugged): the attachment
-- of that generation ends, and what it stopped is written into the thread and
-- into the next turn's context. A token of another generation changes nothing.
create function public.qorpera_record_coding_session_detached(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text,
	p_worker_id uuid, p_attachment_token uuid, p_reason text, p_stopped jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_text text;
begin
	if p_reason is null or p_reason not in ('ARCHIVED','EXPIRED','OWNER_LEFT','REPOSITORY_WITHDRAWN','EXECUTOR_DISABLED','SLEEP','RETIRED')
		or jsonb_typeof(p_stopped) is distinct from 'array' or pg_column_size(p_stopped) > 65536
		or exists (select 1 from jsonb_array_elements(p_stopped) command
			where jsonb_typeof(command) <> 'object' or command - array['commandId','turn','command'] <> '{}'::jsonb
				or coalesce(command ->> 'commandId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				or jsonb_typeof(command -> 'turn') <> 'number' or jsonb_typeof(command -> 'command') <> 'string'
				or octet_length(command ->> 'command') > 300) then
		raise exception 'Coding session detach record invalid' using errcode = '22023'; end if;
	select * into v_session from public.qorpera_coding_sessions where worker_id = p_worker_id for update;
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if v_session.worker_id is null then raise exception 'Coding session is unavailable' using errcode = '42501'; end if;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	if v_session.attached_machine_id is distinct from v_machine.id or v_session.attachment_token is distinct from p_attachment_token then
		return jsonb_build_object('schema','qorpera.coding-detached/v1','workerId',v_session.worker_id,'state','unchanged'); end if;
	-- A live attachment of this generation that may stay is not detached for a keeper reason it does not have. Sleep and
	-- retirement end every attachment, and the executor may find the guest's own lease gone (it cannot be renewed).
	if p_reason not in ('SLEEP','RETIRED','EXPIRED') and public.qorpera_coding_attachment_refusal(v_session, v_worker, v_machine) is null then
		raise exception 'Coding session attachment is live' using errcode = '55000'; end if;
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		running_commands = '[]'::jsonb, observed_at = clock_timestamp()
	where worker_id = v_session.worker_id;
	if jsonb_array_length(p_stopped) > 0 or p_reason in ('SLEEP','RETIRED') then
		v_text := case p_reason when 'SLEEP' then 'The machine went to sleep'
			when 'RETIRED' then 'The machine was replaced by a newer one'
			when 'ARCHIVED' then 'Archived'
			when 'EXPIRED' then 'The coding service lost track of the session'
			when 'OWNER_LEFT' then 'The owner is no longer a member'
			when 'REPOSITORY_WITHDRAWN' then 'The agent no longer has the repository'
			else 'Coding is not enabled here any more' end
			|| case jsonb_array_length(p_stopped) when 0 then '' when 1 then '; 1 command was stopped'
				else '; ' || jsonb_array_length(p_stopped) || ' commands were stopped' end;
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'executor',
			jsonb_build_object('text', v_text, 'reason', p_reason, 'stopped', p_stopped));
	end if;
	return jsonb_build_object('schema','qorpera.coding-detached/v1','workerId',v_session.worker_id,'state','detached');
end
$$;

-- Internal: a session of the machine's member in its environment that is not archived.
create function public.qorpera_coding_member_has_open_session(p_machine public.qorpera_coding_machines)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_coding_sessions session
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id
		where session.environment_id = p_machine.environment_id and session.profile_id = p_machine.profile_id
			and worker.owner_user_id = p_machine.member_user_id and session.archived_at is null)
$$;

-- Detach custody for a session attached here is refused while its attachment
-- may stay: the executor's keeper ends it first (archive, revocation, expiry).
-- The turn's own lease no longer detaches its session at the end of the turn.
select pg_temp.standby_patch('public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)',
	$old$		if v_session.phase in ('preparing','running','publishing') and v_session.lease_until > clock_timestamp()
			and v_session.lease_token is distinct from p_lease_token then
			return '{"state":"refused","reason":"SESSION_IN_USE"}'::jsonb; end if;$old$,
	$new$		if v_session.phase in ('preparing','running','publishing') and v_session.lease_until > clock_timestamp()
			and v_session.lease_token is distinct from p_lease_token then
			return '{"state":"refused","reason":"SESSION_IN_USE"}'::jsonb; end if;
		if v_session.attached_machine_id = v_machine.id and public.qorpera_coding_attachment_refusal(v_session,
			(select worker from public.qorpera_runtime_workers worker where worker.id = v_session.worker_id), v_machine) is null then
			return '{"state":"refused","reason":"SESSION_ATTACHED"}'::jsonb; end if;$new$);

-- A machine is removed only once none of its member's sessions in the environment is open.
select pg_temp.standby_patch('public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)',
	$old$			and coalesce(v_demand.suspended_at, v_machine.last_used_at) > clock_timestamp() - make_interval(secs => v_executor.machine_remove_after_seconds) then$old$,
	$new$			and (coalesce(v_demand.suspended_at, v_machine.last_used_at) > clock_timestamp() - make_interval(secs => v_executor.machine_remove_after_seconds)
				or public.qorpera_coding_member_has_open_session(v_machine)) then$new$);

-- Sleep waits for the machine to be quiet: no turn and no command using the
-- processor for the sleep delay. Removal waits for no open session; the list
-- names the sessions attached, so a sleep can detach each one it stops.
select pg_temp.standby_patch('public.qorpera_list_coding_machines(text,text)',
	$old$				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.machine_sleep_after_seconds),$old$,
	$new$				and greatest(machine.last_used_at, coalesce(machine.busy_at, machine.last_used_at))
					<= clock_timestamp() - make_interval(secs => executor.machine_sleep_after_seconds),
			'attached',(select coalesce(jsonb_agg(jsonb_build_object('workerId',session.worker_id,'attachmentToken',session.attachment_token)
				order by session.worker_id), '[]'::jsonb) from public.qorpera_coding_sessions session where session.attached_machine_id = machine.id),$new$);
select pg_temp.standby_patch('public.qorpera_list_coding_machines(text,text)',
	$old$				or (demand.suspended_at is not null and demand.suspended_at <= clock_timestamp() - make_interval(secs => executor.machine_remove_after_seconds))$old$,
	$new$				or (demand.suspended_at is not null and demand.suspended_at <= clock_timestamp() - make_interval(secs => executor.machine_remove_after_seconds)
					and (machine.kind = 'session' or not public.qorpera_coding_member_has_open_session(machine)))$new$);

-- ---------------------------------------------------------------------------
-- 4. Commands of earlier turns
-- ---------------------------------------------------------------------------
-- A command still starts only in its own turn's run. Reading and cancelling
-- reach every command the session started, in any of its turns' runs.
select pg_temp.standby_patch('public.qorpera_authorize_coding_command(jsonb,jsonb,text,uuid,text)',
	$old$		or v_receipt.requires_company_revision or v_receipt.run_id <> (p_binding ->> 'runId')::uuid$old$,
	$new$		or v_receipt.requires_company_revision
		or (v_receipt.run_id <> (p_binding ->> 'runId')::uuid and (p_action = 'start' or not exists (
			select 1 from public.qorpera_wake_occurrences occurrence where occurrence.run_id = v_receipt.run_id
				and occurrence.source_kind = 'worker-dispatch' and occurrence.source_id = (v_authority #>> '{coding,workerId}')::uuid)))$new$);

-- ---------------------------------------------------------------------------
-- 5. What members and the next turn see
-- ---------------------------------------------------------------------------
-- The session view: archived, attached to an awake machine, how many commands
-- still run there, and when they last used the processor.
select pg_temp.standby_patch('public.qorpera_coding_session_view(public.qorpera_coding_sessions,public.qorpera_runtime_workers)',
	$old$		'sessionId',p_session.session_id,'createdAt',p_session.created_at)$old$,
	$new$		'sessionId',p_session.session_id,'createdAt',p_session.created_at,
		'archivedAt',p_session.archived_at,'archivedBy',p_session.archived_by,
		'attached',coalesce(p_session.attachment_until > clock_timestamp(), false),
		'runningCommands',case when p_session.attachment_until > clock_timestamp() then jsonb_array_length(p_session.running_commands) else 0 end,
		'busyAt',p_session.busy_at,
		'machineAsleep',p_session.vm_allocation_id is not null and not exists (select 1 from public.qorpera_runtime_node_demands demand
			where demand.allocation_id = p_session.vm_allocation_id and demand.released_at is null and demand.reserved_at is not null
				and demand.suspended_at is null))$new$);

-- The next turn's context names the commands earlier turns left running (at
-- the executor's last look) and the ones stopped since the previous turn (the
-- machine slept, the session was archived, the executor lost it). At most 32
-- of each; the rest are counted.
select pg_temp.standby_patch('public.qorpera_read_coding_turn_context(jsonb)',
	$old$	v_previous public.qorpera_coding_session_turns%rowtype; v_answers jsonb; v_earlier jsonb; v_omitted integer;$old$,
	$new$	v_previous public.qorpera_coding_session_turns%rowtype; v_answers jsonb; v_earlier jsonb; v_omitted integer;
	v_session public.qorpera_coding_sessions%rowtype; v_running jsonb; v_stopped jsonb;$new$);
select pg_temp.standby_patch('public.qorpera_read_coding_turn_context(jsonb)',
	$old$	return jsonb_build_object('schema','qorpera.coding-turn-context/v1','workerId',v_worker_id,'sequence',v_sequence,
		'input', jsonb_build_object('from', v_turn.input_from, 'text', v_turn.input_text, 'answers', v_answers),
		'earlierTurns', v_earlier, 'omittedEarlierTurns', v_omitted);$old$,
	$new$	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select coalesce(jsonb_agg(command order by (command ->> 'turn')::integer, command ->> 'commandId'), '[]'::jsonb) into v_running
	from jsonb_array_elements(case when v_session.attachment_until > clock_timestamp() then v_session.running_commands else '[]'::jsonb end) command;
	select coalesce(jsonb_agg(stopped.entry order by stopped.id, stopped.ordinal), '[]'::jsonb) into v_stopped
	from (select event.id, command.ordinal, command.value || jsonb_build_object('reason', event.body ->> 'reason') as entry
		from public.qorpera_coding_session_events event
		cross join lateral jsonb_array_elements(event.body -> 'stopped') with ordinality as command(value, ordinal)
		where event.worker_id = v_worker_id and event.sequence >= v_sequence - 1 and event.kind = 'step' and event.actor = 'executor'
			and jsonb_typeof(event.body -> 'stopped') = 'array') stopped;
	return jsonb_build_object('schema','qorpera.coding-turn-context/v2','workerId',v_worker_id,'sequence',v_sequence,
		'input', jsonb_build_object('from', v_turn.input_from, 'text', v_turn.input_text, 'answers', v_answers),
		'earlierTurns', v_earlier, 'omittedEarlierTurns', v_omitted,
		'commands', jsonb_build_object(
			'running', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements(v_running) with ordinality as item(value, ordinal) where ordinal <= 32), '[]'::jsonb),
			'stopped', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements(v_stopped) with ordinality as item(value, ordinal) where ordinal <= 32), '[]'::jsonb),
			'omitted', greatest(jsonb_array_length(v_running) - 32, 0) + greatest(jsonb_array_length(v_stopped) - 32, 0)));$new$);

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_archive_coding_worker(public.qorpera_runtime_workers, text, uuid, uuid),
	public.qorpera_archive_coding_session(uuid, uuid),
	public.qorpera_archive_quiet_coding_sessions(text),
	public.qorpera_attach_coding_session(uuid, uuid, text, jsonb, text),
	public.qorpera_coding_machine_owned(uuid, text, text, text),
	public.qorpera_coding_attachment_refusal(public.qorpera_coding_sessions, public.qorpera_runtime_workers, public.qorpera_coding_machines),
	public.qorpera_keep_coding_attachments(uuid, text, text, text, jsonb),
	public.qorpera_record_coding_session_detached(uuid, text, text, text, uuid, uuid, text, jsonb),
	public.qorpera_coding_member_has_open_session(public.qorpera_coding_machines)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_archive_coding_session(uuid, uuid) to authenticated;
grant execute on function public.qorpera_archive_quiet_coding_sessions(text),
	public.qorpera_attach_coding_session(uuid, uuid, text, jsonb, text),
	public.qorpera_keep_coding_attachments(uuid, text, text, text, jsonb),
	public.qorpera_record_coding_session_detached(uuid, text, text, text, uuid, uuid, text, jsonb)
	to service_role;
