-- Workers use machines too (Jonas, 2026-09-28: "yes, go with the proposal").
--
-- A worker (an agent's background helper, source 'worker-dispatch') may start
-- and use the company's machines like its agent, with the same company-wide
-- authority, and its commands are attributed to it. A worker run has no
-- conversation to continue, so it is never woken by a machine: it waits inside
-- its run (while its machine starts, or until its command ends) by looking at
-- the machine's status here, and a machine that waits in line for room is
-- reported back to its parent, which can retry. So a worker run is never put
-- on a machine's list of runs to tell, and a worker's command never asks to be
-- notified. A worker run is the one `qorpera_run_worker` finds.

create function pg_temp.machine_worker_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Machine worker integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- machine_start: a worker's run is never told when the machine runs.
select pg_temp.machine_worker_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$			notify_run_ids = case when (public.qorpera_company_machine_placement(id)).running_at is null
				and not v_receipt.run_id = any(notify_run_ids) then notify_run_ids || v_receipt.run_id else notify_run_ids end,$old$,
	$new$			notify_run_ids = case when (public.qorpera_company_machine_placement(id)).running_at is null
				and not v_receipt.run_id = any(notify_run_ids) and (public.qorpera_run_worker(v_receipt.run_id)).id is null
				then notify_run_ids || v_receipt.run_id else notify_run_ids end,$new$);
select pg_temp.machine_worker_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$			'standard', v_args ->> 'lifetime', v_worker.id, array[v_receipt.run_id])$old$,
	$new$			'standard', v_args ->> 'lifetime', v_worker.id,
			case when (public.qorpera_run_worker(v_receipt.run_id)).id is not null then '{}'::uuid[] else array[v_receipt.run_id] end)$new$);

-- A command started by a worker never asks to wake it: it has no conversation to wake.
select pg_temp.machine_worker_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$	if p_action = 'start' then perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid); end if;$old$,
	$new$	if p_action = 'start' then perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid); end if;
	if p_action = 'start' and (p_detail ->> 'notify')::boolean and (public.qorpera_run_worker((p_binding ->> 'runId')::uuid)).id is not null then
		raise exception 'A worker waits for its own commands; it is not woken' using errcode = '42501'; end if;$new$);

-- status: one machine's state and, with commandId, how that command stands, as
-- the executor last recorded it (a pass every 10 s). A waiting worker looks
-- here instead of at the machine: a read, no lock, nothing written. A run that
-- may no longer work (its worker was cancelled, the company paused) is told
-- so, and stops waiting.
select pg_temp.machine_worker_patch('public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure,
	$old$		or v_action is null or v_action not in ('list','stop','delete')
		or (v_action = 'list' and p_request - 'action' <> '{}'::jsonb)
		or (v_action <> 'list' and (p_request - array['action','machine'] <> '{}'::jsonb
			or coalesce(p_request ->> 'machine','') !~ '^[a-z0-9][a-z0-9-]{0,39}$')) then$old$,
	$new$		or v_action is null or v_action not in ('list','stop','delete','status')
		or (v_action = 'list' and p_request - 'action' <> '{}'::jsonb)
		or (v_action <> 'list' and (p_request - array['action','machine'] - case when v_action = 'status' then 'commandId' else '' end <> '{}'::jsonb
			or coalesce(p_request ->> 'machine','') !~ '^[a-z0-9][a-z0-9-]{0,39}$'))
		or (p_request ? 'commandId' and coalesce(p_request ->> 'commandId','')
			!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then$new$);
select pg_temp.machine_worker_patch('public.qorpera_native_machine_manage(jsonb,jsonb)'::regprocedure,
	$old$			where machine.profile_id = (v_identity ->> 'companyId')::uuid and machine.removed_at is null), '[]'::jsonb));
	end if;$old$,
	$new$			where machine.profile_id = (v_identity ->> 'companyId')::uuid and machine.removed_at is null), '[]'::jsonb));
	end if;
	if v_action = 'status' then
		begin
			perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid);
		exception when sqlstate '55000' or sqlstate '42501' then
			return jsonb_build_object('schema','qorpera.machine-status/v1','workStopped',true);
		end;
		select * into v_machine from public.qorpera_company_machines machine
		where machine.profile_id = (v_identity ->> 'companyId')::uuid and machine.name = p_request ->> 'machine' and machine.removed_at is null;
		if not found then return jsonb_build_object('schema','qorpera.machine-status/v1','machine',null); end if;
		return jsonb_build_object('schema','qorpera.machine-status/v1','machine',public.qorpera_company_machine_view(v_machine))
			|| case when p_request ? 'commandId' then jsonb_build_object('command',(select jsonb_build_object('commandId',command.id,
				'state',coalesce(command.state,'running'),'endedAt',command.ended_at)
				from public.qorpera_company_machine_commands command
				where command.id = (p_request ->> 'commandId')::uuid and command.machine_id = v_machine.id)) else '{}'::jsonb end;
	end if;$new$);

-- A conversation's card also shows the machines its agent's workers started.
select pg_temp.machine_worker_patch('public.qorpera_list_session_machines(uuid)'::regprocedure,
	$old$		from public.qorpera_company_machines machine join public.qorpera_execution_runs run on run.id = machine.started_by_run_id
		where run.session_id = p_session_id
			and$old$,
	$new$		from public.qorpera_company_machines machine
		where machine.started_by_run_id in (select run.id from public.qorpera_execution_runs run where run.session_id = p_session_id
				union all
				select wake.run_id from public.qorpera_wake_occurrences wake join public.qorpera_execution_runs parent on parent.id = wake.parent_run_id
				where parent.session_id = p_session_id and wake.wake_kind = 'agent' and wake.source_kind = 'worker-dispatch' and wake.run_id is not null)
			and$new$);
