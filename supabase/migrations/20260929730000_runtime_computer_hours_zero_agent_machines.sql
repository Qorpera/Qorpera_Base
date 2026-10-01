-- Computer hours, build step 6b part 3: agents' machines at zero (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero": no machine starts
-- or wakes; running work may finish for at most 1 hour, then its machines, always-on ones included,
-- are stopped with their disks kept). Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero").
-- The machines an agent starts (#419, 20260928259050), agreed with the machines session.
--
-- 1. The admit line (`qorpera_admit_executor_machines`) skips a company at zero in both of its
--    queries, as it skips a paused one: its machines take no place among the 64 a pass looks at,
--    and no other machine's disk is given up for one of them.
-- 2. `qorpera_admit_company_machine` (an agent's start or wake) answers COMPUTER_HOURS_EXHAUSTED for an
--    asleep machine at zero without trying to move it, so it keeps its node and disk. A new machine
--    is still offered to the nodes, which refuse it (6b part 1), and is still told when no node could
--    ever hold it. The machine waits, as when no node has room.
-- 3. `qorpera_company_machine_view` says waitingFor COMPUTER_HOURS_EXHAUSTED for a waiting machine of a
--    company at zero, with no place in line; places in line count no machine of a company at zero.
-- 4. Once the finishing window is over (`qorpera_computer_hour_finish_window_over`), every machine of
--    the company, always-on ones included, sleeps: the executor's list says sleepDue, the stop custody
--    allows it, and the suspension gives the room back. The machine stays wanted running and keeps
--    its disk, so the admit line wakes it on its own node once hours are added. Its open commands end
--    as lost, as when it sleeps; the runs that used them were ended by the finishing window.
--
-- While the rule is off `qorpera_company_at_zero` and the finishing window are false and nothing
-- changes. The executor needs no change: it already stops a machine whose entry says sleepDue.

set local lock_timeout = '3s';

do $patch$
declare
	v_definition text;
	v_old text;
	v_new text;
	v_target regprocedure;
	v_patches constant text[][] := array[
		array['public.qorpera_admit_executor_machines(text,text,integer)', $o$reserved(machine)
				and not public.qorpera_company_execution_paused(machine.profile_id)
$o$, $n$reserved(machine)
				and not public.qorpera_company_execution_paused(machine.profile_id)
				-- Computer hours (20260929730000): a company at zero starts or wakes no machine, so its machines
				-- take no place in line and no disk is given up for them.
				and not public.qorpera_company_at_zero(machine.profile_id, clock_timestamp())
$n$],
		array['public.qorpera_admit_executor_machines(text,text,integer)', $o$reserved(machine)
			and not public.qorpera_company_execution_paused(machine.profile_id)
$o$, $n$reserved(machine)
			and not public.qorpera_company_execution_paused(machine.profile_id)
			and not public.qorpera_company_at_zero(machine.profile_id, clock_timestamp())
$n$],
		array['public.qorpera_admit_company_machine(uuid,text)', $o$	if public.qorpera_company_execution_paused(v_machine.profile_id) then return '{"state":"refused","reason":"COMPANY_PAUSED"}'::jsonb; end if;
$o$, $n$	if public.qorpera_company_execution_paused(v_machine.profile_id) then return '{"state":"refused","reason":"COMPANY_PAUSED"}'::jsonb; end if;
	-- Computer hours (20260929730000): at zero an asleep machine keeps its node and disk, with no move
	-- tried. A new one is still offered to the nodes, which refuse it, and is told if none could ever hold it.
	if v_placement.id is not null and public.qorpera_company_at_zero(v_machine.profile_id, clock_timestamp()) then
		return '{"state":"refused","reason":"COMPUTER_HOURS_EXHAUSTED"}'::jsonb; end if;
$n$],
		array['public.qorpera_company_machine_view(public.qorpera_company_machines)', $o$		'queuePosition', case when v_state = 'waiting' then (select count(*) + 1$o$, $n$		'queuePosition', case when v_state = 'waiting' and not public.qorpera_company_at_zero(p_machine.profile_id, clock_timestamp())
			then (select count(*) + 1$n$],
		array['public.qorpera_company_machine_view(public.qorpera_company_machines)', $o$and not public.qorpera_company_machine_reserved(other)) end,$o$, $n$and not public.qorpera_company_machine_reserved(other)
				and not public.qorpera_company_at_zero(other.profile_id, clock_timestamp())) end,$n$],
		array['public.qorpera_company_machine_view(public.qorpera_company_machines)', $o$'waitingFor', case when v_state = 'waiting' then coalesce(v_refusal, 'NODE_CAPACITY_EXHAUSTED') end,$o$, $n$'waitingFor', case when v_state = 'waiting' then case when public.qorpera_company_at_zero(p_machine.profile_id, clock_timestamp())
			then 'COMPUTER_HOURS_EXHAUSTED' else coalesce(v_refusal, 'NODE_CAPACITY_EXHAUSTED') end end,$n$],
		array['public.qorpera_list_executor_machines(text,text)', $o$			'sleepDue',placement.retired_at is null and machine.lifetime = 'task' and machine.desired_state = 'running' and state.reserved
				and not exists (select 1 from public.qorpera_company_machine_commands where machine_id = machine.id and ended_at is null)
				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds),
$o$, $n$			'sleepDue',placement.retired_at is null and machine.desired_state = 'running' and state.reserved
				and ((machine.lifetime = 'task'
				and not exists (select 1 from public.qorpera_company_machine_commands where machine_id = machine.id and ended_at is null)
				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds))
				-- Computer hours (20260929730000): an hour after the company ran out every machine sleeps.
				or public.qorpera_computer_hour_finish_window_over(machine.profile_id, clock_timestamp())),
$n$],
		array['public.qorpera_authorize_executor_machine(uuid,text,text,text,text)', $o$			-- Only an idle task machine sleeps on its own (one that never came up too: it gives its room back).
			if v_machine.lifetime <> 'task'
$o$, $n$			-- Computer hours (20260929730000): an hour after the company ran out any machine sleeps, still
			-- wanted running, so it wakes by itself once hours are added.
			if public.qorpera_computer_hour_finish_window_over(v_machine.profile_id, clock_timestamp()) then
				null;
			-- Only an idle task machine sleeps on its own (one that never came up too: it gives its room back).
			elsif v_machine.lifetime <> 'task'
$n$],
		array['public.qorpera_authorize_executor_machine(uuid,text,text,text,text)', $o$				return '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb; end if;
			v_machine := public.qorpera_set_company_machine_desired(v_machine, 'stopped', 'kernel');
$o$, $n$				return '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb;
			else
				v_machine := public.qorpera_set_company_machine_desired(v_machine, 'stopped', 'kernel');
			end if;
$n$],
		array['public.qorpera_suspend_company_machine(uuid,text,text,text)', $o$	if (v_placement.retired_at is null and v_machine.desired_state = 'running') or v_placement.stop_authorized_at is null then
$o$, $n$	-- Computer hours (20260929730000): after the hour at zero a machine still wanted running sleeps too.
	if (v_placement.retired_at is null and v_machine.desired_state = 'running'
		and not public.qorpera_computer_hour_finish_window_over(v_machine.profile_id, clock_timestamp()))
		or v_placement.stop_authorized_at is null then
$n$]
];
	v_index integer;
begin
	for v_index in 1 .. array_length(v_patches, 1) loop
		v_target := v_patches[v_index][1]::regprocedure;
		v_old := v_patches[v_index][2];
		v_new := v_patches[v_index][3];
		v_definition := pg_get_functiondef(v_target);
		if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
			raise exception 'Computer hours: % differs (patch %)', v_target, v_index;
		end if;
		execute replace(v_definition, v_old, v_new);
	end loop;
end
$patch$;
