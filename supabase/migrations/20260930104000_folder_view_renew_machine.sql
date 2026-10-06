-- A view's renewal also says what the view is and which machine it belongs to (F3 step 4, slice 4a:
-- deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md). The node's folder service learns of a view only from a machine
-- that connects with its id and pass, and renews it before it serves anything. Up to now it took every such view as a
-- run box from a run box host and served it read-only. A computer desktop is served to its own office machine and
-- writes there, so the service has to know the view's kind and machine before it serves it.
--
-- qorpera_folder_view_renew's open answer gains two fields:
--   kind       the view's kind (run_box, computer_desktop, coding_session; the shell command views of C1b-3b later);
--   machineId  the view's machine_id, as view_open set it: a machine allocation, the one of the office's current
--              activation for a desktop and the coding machine's for a coding session; null for a run box (until a run
--              box has a machine of its own). The node names its machines after their allocation.
-- The closed answer is unchanged. Nothing else changes: who may renew, what it checks and what it sets.
--
-- Exact-text patch: it fails unless the function has the text given exactly once. Body marker "20260930104000".

create function pg_temp.folder_view_renew_machine_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

select pg_temp.folder_view_renew_machine_patch('public.qorpera_folder_view_renew(uuid,text,timestamptz)',
	$old$	return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','open','leaseUntil',v_view.lease_until);
$old$,
	$new$	-- 20260930104000: the open answer says what the view is and which machine it belongs to.
	return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','open','leaseUntil',v_view.lease_until,
		'kind',v_view.kind,'machineId',v_view.machine_id);
$new$);
