-- A deleted company's agent machines are deleted too (2026-09-29), as agreed
-- between company deletion (20260928249150) and machines (20260929050000):
-- whichever landed second adds this. qorpera_stop_company_work runs with the
-- company's fence held, on the request and on every finisher pass until the
-- purge, so this follows the machines' one lock order from there: the
-- company's machines lock, then each machine row, by id. A company being
-- deleted wakes no run about its machines: the row is handed on with an empty
-- notify list, and qorpera_set_company_machine_desired writes no stopped event
-- and clears the column. Cleared in memory, a placed machine's row is updated
-- once, so no foreign key is checked again against its starting run (outside
-- that order); one with nothing on any node is updated again when it is
-- closed, as every deletion of such a machine is. Each node's machine executor then deletes and releases its
-- placements; the purge waits for their allocations like any other.

create function pg_temp.machines_company_delete_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company delete machines integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.machines_company_delete_patch('public.qorpera_stop_company_work(uuid)'::regprocedure,
	$old$	v_machines integer;
$old$,
	$new$	v_machines integer;
	v_agent_machines integer := 0;
	v_machine public.qorpera_company_machines%rowtype;
$new$);
select pg_temp.machines_company_delete_patch('public.qorpera_stop_company_work(uuid)'::regprocedure,
	$old$	delete from public.qorpera_profile_invitations where profile_id = p_profile_id;$old$,
	$new$	-- Agent machines: deleted under the machines' lock order (fence already held); the node's
	-- machine executor deletes and releases each placement. Idempotent: a deleted one is skipped.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || p_profile_id::text, 0));
	for v_machine in
		select * from public.qorpera_company_machines
		where profile_id = p_profile_id and removed_at is null and desired_state <> 'deleted'
		order by id
		for update
	loop
		v_machine.notify_run_ids := '{}';
		perform public.qorpera_set_company_machine_desired(v_machine, 'deleted', 'kernel');
		v_agent_machines := v_agent_machines + 1;
	end loop;

	delete from public.qorpera_profile_invitations where profile_id = p_profile_id;$new$);
select pg_temp.machines_company_delete_patch('public.qorpera_stop_company_work(uuid)'::regprocedure,
	$old$'codingMachinesRetired', v_machines);$old$,
	$new$'codingMachinesRetired', v_machines, 'agentMachinesDeleted', v_agent_machines);$new$);
