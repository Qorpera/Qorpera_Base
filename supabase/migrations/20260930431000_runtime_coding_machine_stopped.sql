-- 20260930431000: F3 step 5g-1b (deploy/coding-worker/README.md, "Machines stopped from outside"). A member's coding
-- machine that LXD shows stopped after its settled start (the host watchdog's forced stop, a poweroff inside it, a node
-- restart) is stopped, not waiting for an operator: the executor's next turn starts it again, and a sleep or a removal
-- goes on. Every session attached to it then lost its boot: its user, its guest lease and whatever its commands ran.
-- 1. qorpera_record_coding_machine_stopped: the executor, which found the machine stopped from outside before it does
--    anything else to it, ends every attachment on the machine and writes into each session's thread, and into its next
--    turn's context, the commands last seen running there, stopped for the reason MACHINE_STOPPED. Each stop is kept
--    once in qorpera_coding_machine_outside_stops, named by the start it ended (the LXD operation the executor's
--    journal holds): a retry, or an abandoned try's request that reaches SQL only after the machine started again and
--    sessions attached anew, gets the first record's answer and changes nothing. Only the executor starts the machine
--    (it never starts by itself), and only once the stop is recorded.
-- 2. qorpera_coding_stopped_event names that reason: "The machine stopped".
-- Each new or replaced function names this migration (20260930431000).

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regclass('public.qorpera_coding_machine_outside_stops') is not null
		or to_regprocedure('public.qorpera_record_coding_machine_stopped(uuid,uuid,text,text,text)') is not null then
		raise exception '5g-1b (20260930431000) is already applied'; end if;
end $$;

-- 1. Each recorded stop, by the start it ended, with the attachments its record ended. Internal.
create table public.qorpera_coding_machine_outside_stops (
	machine_id uuid not null references public.qorpera_coding_machines(id) on delete cascade,
	start_operation_id uuid not null,
	detached jsonb not null default '[]'::jsonb check (jsonb_typeof(detached) = 'array'),
	recorded_at timestamptz not null default clock_timestamp(),
	primary key (machine_id, start_operation_id)
);
alter table public.qorpera_coding_machine_outside_stops enable row level security;
revoke all on public.qorpera_coding_machine_outside_stops from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Internal: the thread's and the next turn's record of commands an attachment's end stopped. At most 32 are named;
-- the rest are counted.
create or replace function public.qorpera_coding_stopped_event(p_reason text, p_stopped jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	-- 20260930431000: MACHINE_STOPPED, the machine stopped from outside.
	select jsonb_build_object('text', case p_reason when 'SLEEP' then 'The machine went to sleep'
			when 'RETIRED' then 'The machine was replaced by a newer one'
			when 'ARCHIVED' then 'Archived'
			when 'EXPIRED' then 'The session lost its machine'
			when 'OWNER_LEFT' then 'The owner is no longer a member'
			when 'REPOSITORY_WITHDRAWN' then 'The agent no longer has the repository'
			when 'MACHINE_STOPPED' then 'The machine stopped'
			else 'Coding is not enabled here any more' end
			|| case jsonb_array_length(p_stopped) when 0 then '' when 1 then '; 1 command was stopped'
				else '; ' || jsonb_array_length(p_stopped) || ' commands were stopped' end,
		'reason', p_reason,
		'stopped', coalesce((select jsonb_agg(value order by ordinal) from jsonb_array_elements(p_stopped) with ordinality as item(value, ordinal)
			where ordinal <= 32), '[]'::jsonb),
		'moreStopped', greatest(jsonb_array_length(p_stopped) - 32, 0))
$$;

-- 1. The machine this executor planned on this node stopped from outside after the start p_start_operation_id: every
-- session attached to it is detached, each with the commands last seen running there, and each gets one MACHINE_STOPPED
-- event, commands or not. The guest kept nothing of the sessions across the stop, so there is nothing for the executor
-- to take off first. The stop's own row is taken first: a second record of the same stop (at once, waiting for the
-- first, or long after) answers what the first did and touches no session. The machine is read without a lock and only
-- its sessions are locked after that row, which no other call takes, so no coding call's lock order changes. Answers the
-- sessions the stop detached, with the attachment each had.
create function public.qorpera_record_coding_machine_stopped(p_machine_id uuid, p_start_operation_id uuid, p_owner text,
	p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930431000
declare v_machine public.qorpera_coding_machines%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_detached jsonb := '[]'::jsonb; v_first boolean;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_start_operation_id is null then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	insert into public.qorpera_coding_machine_outside_stops(machine_id, start_operation_id)
	values (v_machine.id, p_start_operation_id) on conflict do nothing returning true into v_first;
	if v_first is null then
		select s.detached into strict v_detached from public.qorpera_coding_machine_outside_stops s
		where s.machine_id = v_machine.id and s.start_operation_id = p_start_operation_id;
		return jsonb_build_object('schema','qorpera.coding-machine-stopped/v1','machineId',v_machine.id,'detached',v_detached);
	end if;
	for v_session in select * from public.qorpera_coding_sessions where attached_machine_id = v_machine.id order by worker_id for update loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
			attachment_turn = null, attached_at = null, running_commands = '[]'::jsonb, observed_at = clock_timestamp()
		where worker_id = v_session.worker_id;
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'executor',
			public.qorpera_coding_stopped_event('MACHINE_STOPPED', v_session.running_commands));
		v_detached := v_detached || jsonb_build_array(jsonb_build_object('workerId', v_session.worker_id,
			'attachmentToken', v_session.attachment_token));
	end loop;
	update public.qorpera_coding_machine_outside_stops set detached = v_detached
	where machine_id = v_machine.id and start_operation_id = p_start_operation_id;
	return jsonb_build_object('schema','qorpera.coding-machine-stopped/v1','machineId',v_machine.id,'detached',v_detached);
end
$$;

-- Grants: the executor (service_role) records the stop; the event text stays internal.
revoke all on function public.qorpera_coding_stopped_event(text, jsonb),
	public.qorpera_record_coding_machine_stopped(uuid, uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_coding_machine_stopped(uuid, uuid, text, text, text) to service_role;
