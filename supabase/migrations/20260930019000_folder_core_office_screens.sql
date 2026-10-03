-- Company folder core, C1c-3k part 1 (the coordinator's audit P06b): the Company Computer's screens, restarts and
-- power-off on the folder fence (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.9; plan
-- outputs/company-accounts/p06-office-folder-v2-plan.md). Builds on C1c-3j (20260930012000).
--
-- Folder-v2 only (the founder's decision of 3 October): each patch is a folder-v2 branch, and the statement that was
-- there before stays untouched in its else. On a folder-v2 company:
-- * Adopting a computer's screens (a non-empty adoption mapping) stays refused: the orchestrator builds mappings only
--   to adopt a legacy computer, which a folder-v2 company never has. Its message now says so instead of "comes later".
-- * qorpera_folder_office_enter_successor(request): a successor activation (a restart, a reset or a host reboot) takes
--   3j's prelude for its activation's start (the requester's member row, the agent's staff row) before its status call
--   takes the office. Before, the activation's own prelude ran after it.
-- * The restart-surface, shared-surface, screen v1 and disposal gates accept a ready folder-v2 Company File. So every
--   restart path, the screen heartbeats, the agent's screen tool and the operator's disposal serve folder-v2. The
--   restart gate opens only now that the successors are ordered.
-- * The screen event's cleanup, observation retention, the operator's disposal, a member's new computer for an agent
--   (member_agent_office) and the office power-off (suspend_runtime_node_machine) take 3f's machine fence (the folder
--   fence and the company row KEY SHARE) in place of the gc fence (the company row FOR UPDATE).
-- * A member's start status is plain reads: no fence and no row lock, so a poll never waits for a folder stop.
--
-- Not here (C1c-3k part 2, 20260930019100): access configuration and its status, opening a screen, the private screen
-- event and the viewers. An agent's own start and the wake drain are C1c-3l. Each patched function and each new helper
-- names this migration (20260930019000) in its body, for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.c1c3k_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3k patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A successor's prelude --------------------------------------------------------------------------------------------

create function public.qorpera_folder_office_enter_successor(p_request jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_office uuid;
	v_activation public.qorpera_runtime_office_activations%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- C1c-3k (20260930019000): a successor activation on folder-v2 takes 3j's prelude for its activation's start (the
	-- requester's member row, the agent's staff row) before its status call takes the office. A request this cannot
	-- read is left to the status call, which refuses it.
	if coalesce(p_request #>> '{predecessor,startup,scope,companyComputerId}', '') !~* v_uuid
		or coalesce(p_request #>> '{attestation,activationId}', '') !~* v_uuid then return; end if;
	v_office := (p_request #>> '{predecessor,startup,scope,companyComputerId}')::uuid;
	if not public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
		where office.id = v_office)) then return; end if;
	select activation.* into v_activation from public.qorpera_runtime_office_activations as activation
	where activation.activation_id = (p_request #>> '{attestation,activationId}')::uuid and activation.office_id = v_office;
	perform public.qorpera_folder_office_enter(v_office, null, v_activation.intent_id);
end $$;
revoke all on function public.qorpera_folder_office_enter_successor(jsonb) from public, anon, authenticated, service_role;

-- 2. The successors take the prelude before the office; the adoption's refusal says why it stays ---------------------

do $$
begin
	perform pg_temp.c1c3k_replace(
		'public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)',
		E'\t-- C1c-3j (20260930012000): adopting screens on folder-v2 comes with C1c-3k (its agents and members first); it\n'
		|| E'\t-- refuses before any lock.\n',
		E'\t-- C1c-3j (20260930012000), kept by C1c-3k (20260930019000): mappings come only from adopting a legacy computer,\n'
		|| E'\t-- which a folder-v2 company never has; it refuses before any lock.\n', 1);
	perform pg_temp.c1c3k_replace(
		'public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)',
		E'\t\traise exception ''Adopting a computer''''s screens comes later on this company'' using errcode=''0A000''; end if;\n',
		E'\t\traise exception ''Adopting a legacy computer''''s screens is not available on this company'' using errcode=''0A000''; end if;\n', 1);

	-- The successors: the prelude before the status call takes the office.
	perform pg_temp.c1c3k_replace('public.qorpera_activate_runtime_office_successor(jsonb,text)',
		E'\tperform public.qorpera_runtime_office_successor_status(p_request);\n'
		|| E'\tselect * into strict v_activation',
		E'\t-- C1c-3k (20260930019000): on folder-v2 the activation\'s start (its requester and agent) before the office.\n'
		|| E'\tperform public.qorpera_folder_office_enter_successor(p_request);\n'
		|| E'\tperform public.qorpera_runtime_office_successor_status(p_request);\n'
		|| E'\tselect * into strict v_activation', 1);
	perform pg_temp.c1c3k_replace('public.qorpera_activate_runtime_office_reset_successor(jsonb,text)',
		E'\tperform public.qorpera_runtime_office_reset_successor_status(p_request);\n'
		|| E'\tselect * into strict v_activation',
		E'\t-- C1c-3k (20260930019000): on folder-v2 the activation\'s start (its requester and agent) before the office.\n'
		|| E'\tperform public.qorpera_folder_office_enter_successor(p_request);\n'
		|| E'\tperform public.qorpera_runtime_office_reset_successor_status(p_request);\n'
		|| E'\tselect * into strict v_activation', 1);
	perform pg_temp.c1c3k_replace('public.qorpera_activate_runtime_office_boot_successor(jsonb,text)',
		E'\tperform public.qorpera_runtime_office_boot_successor_status(p_request);\n'
		|| E'\tselect * into strict v_activation',
		E'\t-- C1c-3k (20260930019000): on folder-v2 the activation\'s start (its requester and agent) before the office.\n'
		|| E'\tperform public.qorpera_folder_office_enter_successor(p_request);\n'
		|| E'\tperform public.qorpera_runtime_office_boot_successor_status(p_request);\n'
		|| E'\tselect * into strict v_activation', 1);
end $$;

-- 3. The gates --------------------------------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3k_replace('public.qorpera_check_runtime_office_shared_surface(jsonb)',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1) then\n',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3k 20260930019000 */)) then\n', 1);
	perform pg_temp.c1c3k_replace('public.qorpera_check_runtime_office_restart_surfaces(public.qorpera_runtime_office_activations)',
		E'and profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'and profile_id=v_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3k 20260930019000 */))\n', 1);
	perform pg_temp.c1c3k_replace('public.qorpera_native_office_screen_v1(jsonb,jsonb,text,jsonb)',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3k 20260930019000 */))\n', 1);
	perform pg_temp.c1c3k_replace('public.qorpera_administratively_dispose_office_reset_delete(text,bigint,bigint,bigint,bigint)',
		E'and profile_id=o.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'and profile_id=o.profile_id and state=''ready''\n'
		|| E'  and (path_gateway_version=1 or core=''folder-v2'' /* C1c-3k 20260930019000 */))\n', 1);
end $$;

-- 4. The machine fence in place of the gc fence -----------------------------------------------------------------------

do $$
begin
	-- The screen event's cleanup (two-space indent): the fence, then the office and the lifetime as before.
	perform pg_temp.c1c3k_replace('public.qorpera_record_runtime_screen_event(jsonb,jsonb,jsonb,jsonb)',
		E'  perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'  -- C1c-3k (20260930019000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'  if public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'   perform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
		|| E'  else\n'
		|| E'  perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'  end if;\n', 1);
	-- Observation retention (one-space indent).
	perform pg_temp.c1c3k_replace('public.qorpera_retain_runtime_screen_observation(text)',
		E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n',
		E' -- C1c-3k (20260930019000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E' if public.qorpera_company_is_folder_v2(o.profile_id) then\n'
		|| E'  perform public.qorpera_folder_machine_fence(o.profile_id);\n'
		|| E' else\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
		|| E' end if;\n', 1);
	-- The operator's disposal: the fence, then the owner or admin's member row as before (one-space indent).
	perform pg_temp.c1c3k_replace('public.qorpera_administratively_dispose_office_reset_delete(text,bigint,bigint,bigint,bigint)',
		E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n',
		E' -- C1c-3k (20260930019000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E' if public.qorpera_company_is_folder_v2(o.profile_id) then\n'
		|| E'  perform public.qorpera_folder_machine_fence(o.profile_id);\n'
		|| E' else\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
		|| E' end if;\n', 1);
	-- A member's new computer for an agent: the fence, then the member row and the seat lock as before.
	perform pg_temp.c1c3k_replace('public.qorpera_member_agent_office(uuid,uuid)',
		E'\t\tperform public.qorpera_lock_profile_gc_fence(v_company);\n',
		E'\t\t-- C1c-3k (20260930019000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(v_company) then\n'
		|| E'\t\t\tperform public.qorpera_folder_machine_fence(v_company);\n'
		|| E'\t\telse\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_company);\n'
		|| E'\t\tend if;\n', 1);
	-- The office power-off's node suspend: the fence, then the allocation, the node and the demand as before.
	perform pg_temp.c1c3k_replace('public.qorpera_suspend_runtime_node_machine(uuid,text,text,text,text,uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n',
		E'\t-- C1c-3k (20260930019000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
		|| E'\tend if;\n', 1);
end $$;

-- 5. A member's start status: plain reads on folder-v2 ----------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3k_replace('public.qorpera_runtime_office_start_status(jsonb)',
		E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n',
		E'\t\t-- C1c-3k (20260930019000): a status poll is plain reads on folder-v2 (no fence, no row lock), so it never\n'
		|| E'\t\t-- waits for a folder stop or a start in flight; the membership check above is the authority.\n'
		|| E'\t\tif p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then\n'
		|| E'\t\t\traise exception ''Office start scope differs'' using errcode=''42501''; end if;\n'
		|| E'\t\tselect * into v_intent from public.qorpera_runtime_office_start_intents\n'
		|| E'\t\t\twhere office_id=v_office.id and computer_generation=v_office.generation;\n'
		|| E'\t\treturn jsonb_build_object(''scope'',public.qorpera_runtime_office_scope(v_office),''computerGeneration'',v_office.generation,\n'
		|| E'\t\t\t''officeState'',v_office.state,''intent'',case when v_intent.id is not null then public.qorpera_runtime_office_start_result(v_intent) else null end,\n'
		|| E'\t\t\t''maintenance'',public.qorpera_runtime_office_maintenance(v_office));\n', 1);
end $$;

drop function pg_temp.c1c3k_replace(regprocedure, text, text, integer);
