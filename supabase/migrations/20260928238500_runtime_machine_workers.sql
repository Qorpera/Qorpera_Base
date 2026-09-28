-- Workers use machines too (Jonas, 2026-09-28: "yes, go with the proposal").
--
-- A worker (an agent's background helper, source 'worker-dispatch') may start
-- and use the company's machines like its agent, with the same company-wide
-- authority, and its commands are attributed to it. A worker run has no
-- conversation to continue, so it is never woken by a machine: it waits for
-- its own commands inside its run (machine_read with a wait), and a machine
-- that has to wait for room is reported back to its parent, which can retry.
-- So a worker run is never put on a machine's list of runs to tell, and a
-- worker's command never asks to be notified.

-- A run that is an agent's worker: its wake is a worker dispatch.
create function public.qorpera_machine_run_is_worker(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences wake
		where wake.run_id = p_run_id and wake.source_kind = 'worker-dispatch')
$$;
revoke all on function public.qorpera_machine_run_is_worker(uuid) from public, anon, authenticated, service_role;

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
				and not v_receipt.run_id = any(notify_run_ids) and not public.qorpera_machine_run_is_worker(v_receipt.run_id)
				then notify_run_ids || v_receipt.run_id else notify_run_ids end,$new$);
select pg_temp.machine_worker_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$			'standard', v_args ->> 'lifetime', v_worker.id, array[v_receipt.run_id])$old$,
	$new$			'standard', v_args ->> 'lifetime', v_worker.id,
			case when public.qorpera_machine_run_is_worker(v_receipt.run_id) then '{}'::uuid[] else array[v_receipt.run_id] end)$new$);

-- A command started by a worker never asks to wake it: it has no conversation to wake.
select pg_temp.machine_worker_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$	if p_action = 'start' then perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid); end if;$old$,
	$new$	if p_action = 'start' then perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid); end if;
	if p_action = 'start' and (p_detail ->> 'notify')::boolean and public.qorpera_machine_run_is_worker((p_binding ->> 'runId')::uuid) then
		raise exception 'A worker waits for its own commands; it is not woken' using errcode = '42501'; end if;$new$);
