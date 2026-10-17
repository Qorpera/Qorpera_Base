-- 20260930515000: F3 step 5g-5, part 3, PR C (C2, deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md "Reads" rule 4,
-- "unreadable"). A coding turn's context (qorpera_read_coding_turn_context, qorpera.coding-turn-context/v2) says whether the
-- session's machine got a new disk since the previous turn began: a new top-level key machine: {newDisk}. A session
-- attached to the machine when it got the new disk has a MACHINE_NEW_DISK event naming it; one that was not attached
-- had no word of it, and found its home and cache folders and anything installed outside /company gone.
-- - The session's machine is its vm_allocation_id, which the rebuild's detach leaves as it is.
-- - The new disk is a 'replaced' record of that machine in qorpera_coding_machine_folder_restarts (20260930505000, the
--   rebuild's record), recorded at or after the previous turn's begin.
-- - The previous turn is the session's turn numbered just before this one, begun or not. A turn begins when its wake
--   occurrence is made (qorpera_begin_coding_turn); a turn never begun counts from when it opened. The executor
--   rebuilds a machine before it begins the turn that needed it, so that turn says it, and the next one does not again.
--   A rebuild while the previous turn ran is said too, even to a session attached then: twice rather than never.
-- - A first turn says false.
-- Read only: no new table and no write.
-- Rollout: the runtime first (until it knows machine, its strict parse refuses the context, and every coding turn
-- fails), then this migration. The runtime reads a context without machine as no new disk, so either order is safe
-- once it rolled.
-- Exact-text patches: each fails unless the function has the text given exactly once. The function names this migration
-- (20260930515000). CREATE OR REPLACE keeps its owner and grants (service_role only).

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_read_coding_turn_context(jsonb)'::regprocedure), '20260930515000') > 0 then
		raise exception 'The coding turn''s new disk (20260930515000) is already applied'; end if;
end $$;

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.coding_turn_new_disk_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '% does not have the text this migration expects (% times): %', p_target, v_found,
				left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.coding_turn_new_disk_patch('public.qorpera_read_coding_turn_context(jsonb)', array[
	$old$	v_session public.qorpera_coding_sessions%rowtype; v_running jsonb; v_stopped jsonb;$old$,
	$new$	v_session public.qorpera_coding_sessions%rowtype; v_running jsonb; v_stopped jsonb; v_new_disk boolean;$new$,
	$old$	return jsonb_build_object('schema','qorpera.coding-turn-context/v2','workerId',v_worker_id,'sequence',v_sequence,$old$,
	$new$	-- 20260930515000: whether the session's machine got a new disk (a rebuild's record) since the previous turn began;
	-- one never begun counts from when it opened. The rebuild's detach leaves vm_allocation_id.
	v_new_disk := exists (select 1 from public.qorpera_coding_session_turns turn
		left join public.qorpera_wake_occurrences occurrence on occurrence.id = turn.occurrence_id
		join public.qorpera_coding_machine_folder_restarts rebuild on rebuild.machine_id = v_session.vm_allocation_id
			and rebuild.state = 'replaced' and rebuild.recorded_at >= coalesce(occurrence.created_at, turn.created_at)
		where turn.worker_id = v_worker_id and turn.sequence = v_sequence - 1);
	return jsonb_build_object('schema','qorpera.coding-turn-context/v2','workerId',v_worker_id,'sequence',v_sequence,$new$,
	$old$			'omitted', greatest(jsonb_array_length(v_running) - 32, 0) + greatest(jsonb_array_length(v_stopped) - 32, 0)));$old$,
	$new$			'omitted', greatest(jsonb_array_length(v_running) - 32, 0) + greatest(jsonb_array_length(v_stopped) - 32, 0)),
		'machine', jsonb_build_object('newDisk', v_new_disk));$new$]);
