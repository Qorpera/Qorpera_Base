-- Company folder core, C1c-3j (the coordinator's audit P06a): the Company Computer's company lock, creation and start on
-- the folder fence (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.7; plan outputs/company-accounts/p06).
--
-- Changes only folder-v2 behaviour; snapshot-v1 keeps every path (each patch keeps the old statement in its else, or only
-- widens a gate that a snapshot-v1 company already passes). On a folder-v2 company no office path patched here takes the
-- company row FOR UPDATE any more (core §9):
-- * The office lock is C1c-3f's qorpera_folder_machine_fence: the folder fence KEY SHARE, then the company row KEY SHARE
--   (rank 0). It reads no pause: stop and reset must run while the company is paused; a start reads the pause again in
--   its start-source check, as today. qorpera_assert_runtime_office_provider takes it in place of the gc fence, which
--   covers its 33 callers (start, activation, screen heartbeats, lifecycle, reset, software, package, delete); so do
--   the provider set, the fleet offer and placement, the office reservation (reserve_runtime_machine's office branch and
--   reserve_runtime_node_machine's office kind) and registration.
-- * qorpera_folder_office_enter(office, member, intent): an office start's prelude on folder-v2. After the machine
--   fence it takes the rows the start-source check shares, in rank order and before any office row: the acting member
--   and the start's requesting member (rank 1), then the requesting agent's staff row (rank 2). A hire (or an agent's
--   return) takes that staff row and then, through its default office access (the browser grant's office revision), the
--   offices; a start that took the office first and the agent's row after could deadlock with it once the gc fence
--   stopped serializing them. The member's start, cancel, withdrawal and status, the provider's reserve and check (and
--   their wrappers, before qorpera_assert_runtime_office_provider), the fleet offer and placement, the office's
--   activation and its startup lock (both before the assertion) take it.
-- * The default access trigger of a hire walks the company's offices by id, the order every path that takes several
--   offices uses.
-- * member_office_catalog, a member's first call to the Company Computer, takes the machine fence on folder-v2, then the
--   member's row as before: never the company row FOR UPDATE (the coordinator's condition, 3 October).
-- * Registering a folder-v2 company's first computer (qorpera_register_runtime_office, the coordinator's decision of
--   3 October): the machine fence, the owner or admin's member row FOR SHARE, the seat lock (so a second first
--   registration waits and returns the same computer), then the office rows as before. The coordinator registers it
--   as the company's owner the first time the company needs its computer.
-- * The gates of registration, the start-source check, the guest binding and the office reservation accept a ready
--   folder-v2 company's Company File (core = 'folder-v2') as well as a version-1 path gateway. The interlock trigger
--   returns before its gc fence on folder-v2: it serializes the version-1 cutover, which a folder-v2 company never has.
--
-- * Adopting a replaced computer's screens (a non-empty adoption mapping, whose agents and members it shares after the
--   office) refuses on folder-v2 with 0A000 before any lock, until C1c-3k orders it.
--
-- Not in 3j: screens, the shared surface, access configuration, the adoption mapping and the other member-facing calls
-- (C1c-3k); an agent's start and the activation-wake drain (C1c-3l). Each patched function names this migration
-- (20260930012000) in its body, for the deploy guard; test 893 J pins every snapshot-v1 body by its digest.

set local lock_timeout = '3s';

create function pg_temp.c1c3j_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3j patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. An office start's prelude on folder-v2 -------------------------------------------------------------------------------

create function public.qorpera_folder_office_enter(p_office_id uuid, p_member_user_id uuid, p_intent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_office public.qorpera_runtime_offices%rowtype;
	v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	-- C1c-3j (20260930012000): the machine fence, then the members (rank 1) and the agent (rank 2) the start-source check
	-- shares, before any office row. Plain reads find them; the caller locks the office next.
	select office.* into v_office from public.qorpera_runtime_offices as office where office.id = p_office_id;
	if v_office.id is null then return; end if;
	perform public.qorpera_folder_machine_fence(v_office.profile_id);
	select intent.* into v_intent from public.qorpera_runtime_office_start_intents as intent
	where (p_intent_id is not null and intent.id = p_intent_id)
		or (p_intent_id is null and intent.office_id = v_office.id and intent.computer_generation = v_office.generation)
	limit 1;
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = v_office.profile_id and member.user_id in (p_member_user_id, v_intent.requested_by_user_id)
	order by member.user_id for share;
	if v_intent.requested_by_staff_agent_id is not null then
		perform 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = v_office.profile_id and staff.staff_agent_id = v_intent.requested_by_staff_agent_id
		for share;
	end if;
end $$;
revoke all on function public.qorpera_folder_office_enter(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- 2. The office lock: the provider's assertion, the provider set, registration and the office reservation --------------

do $$
begin
	perform pg_temp.c1c3j_replace('public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);

	perform pg_temp.c1c3j_replace('public.qorpera_set_runtime_office_provider(jsonb,bigint,uuid,text,bigint,boolean)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence and the company row KEY SHARE.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);

	-- Registration: the machine fence and the owner or admin's member row, then the office rows; a ready folder-v2
	-- Company File passes the gate.
	perform pg_temp.c1c3j_replace('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, the company row KEY SHARE, the member (rank 1) and the\n'
		|| E'\t-- seat lock, so a second first registration waits and finds the computer.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id=v_profile and user_id=auth.uid() for share;\n'
		|| E'\t\tperform public.qorpera_lock_runtime_office_seats(p_environment_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)',
		E'\t\t\tand profile_id=v_profile and state=''ready'' and path_gateway_version=1) then\n',
		E'\t\t\tand profile_id=v_profile and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */)) then\n', 1);

	-- The office reservation: its office branch on the machine fence (a run's own reservation stays for C3); the gate.
	perform pg_temp.c1c3j_replace('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n',
		E'\t-- C1c-3j (20260930012000): a folder-v2 office takes the folder fence and the company row KEY SHARE.\n'
		|| E'\tif p_run_id is null and public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_profile);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)',
		E'profile_id=v_profile and state=''ready'' and path_gateway_version=1)\n',
		E'profile_id=v_profile and state=''ready''\n'
		|| E'\t\t\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */))\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
		E' -- every caller. C1c-3h (20260930002300): the coding kind takes it too; office (C1c-3j) reservations still come\n'
		|| E' -- with the gc fence.\n'
		|| E' if p_provider_kind in (''machine'', ''coding'') and public.qorpera_company_is_folder_v2(v_profile) then\n',
		E' -- every caller. C1c-3h (20260930002300): the coding kind takes it too, and C1c-3j (20260930012000) the\n'
		|| E' -- office kind.\n'
		|| E' if p_provider_kind in (''machine'', ''coding'', ''office'') and public.qorpera_company_is_folder_v2(v_profile) then\n', 1);
end $$;

-- 3. The start family: the member's calls and the provider's, each with the prelude --------------------------------------

do $$
begin
	perform pg_temp.c1c3j_replace('public.qorpera_request_runtime_office_start(jsonb,bigint,uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(o.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(o.id, auth.uid(), null);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_request_runtime_office_start_before_idle(jsonb,bigint,uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_cancel_runtime_office_start(jsonb,bigint,uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_runtime_office_start_status(jsonb)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, auth.uid(), null);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)',
		E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(o.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(o.id, auth.uid(), null);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_reserve_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text,text,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_check_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the folder fence, rank 0, then the members and the agent the\n'
		|| E'\t-- start-source check shares, before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter(v_office.id, null, p_intent_id);\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);

	-- The fleet offer and placement (one-space indent).
	perform pg_temp.c1c3j_replace('public.qorpera_offer_runtime_office_fleet(jsonb)',
		E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n',
		E' -- C1c-3j (20260930012000): on folder-v2 the prelude (the start\'s agent before the office).\n'
		|| E' if public.qorpera_company_is_folder_v2(o.profile_id) then\n'
		|| E'  perform public.qorpera_folder_office_enter(o.id, null, (p_offer->>''intentId'')::uuid);\n'
		|| E' else\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
		|| E' end if;\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_place_runtime_office_fleet(jsonb,bigint)',
		E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n',
		E' -- C1c-3j (20260930012000): on folder-v2 the prelude (the start\'s agent before the office).\n'
		|| E' if public.qorpera_company_is_folder_v2(o.profile_id) then\n'
		|| E'  perform public.qorpera_folder_office_enter(o.id, null, null);\n'
		|| E' else\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(o.profile_id);\n'
		|| E' end if;\n', 1);

	-- The provider's wrappers: the prelude before the provider's assertion takes the office.
	perform pg_temp.c1c3j_replace(
		'public.qorpera_reserve_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,text,text,uuid,text)',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the start\'s members and agent before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
		|| E'\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter((p_scope->>''companyComputerId'')::uuid, null, p_intent_id);\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n', 1);
	perform pg_temp.c1c3j_replace(
		'public.qorpera_check_runtime_office_start(jsonb,bigint,uuid,uuid,text,text,uuid,text)',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the start\'s members and agent before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
		|| E'\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter((p_scope->>''companyComputerId'')::uuid, null, p_intent_id);\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,true);\n', 1);

	-- The start-source check's gate.
	perform pg_temp.c1c3j_replace(
		'public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)',
		E'\t\t\tand profile_id=p_office.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'\t\t\tand profile_id=p_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */))\n', 1);
	-- The guest binding's gate (the office's startup lock checks it).
	perform pg_temp.c1c3j_replace('public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3j 20260930012000 */))\n', 1);
end $$;

-- 3b. An office's activation (review round 1): its start's members and agent before the provider's assertion takes the
--     office, in the activation and in the startup lock (report-ready and the screen events go through it). Adopting a
--     replaced computer's screens (non-empty mappings) is refused on folder-v2 until C1c-3k orders its agents and members.

do $$
begin
	perform pg_temp.c1c3j_replace(
		'public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the start\'s members and agent before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
		|| E'\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter((p_scope->>''companyComputerId'')::uuid, null, p_intent_id);\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);\n', 1);
	perform pg_temp.c1c3j_replace('public.qorpera_lock_runtime_office_startup(jsonb)',
		E'\tperform public.qorpera_assert_runtime_office_provider(p_startup->''scope'',(p_startup->>''computerGeneration'')::bigint,\n',
		E'\t-- C1c-3j (20260930012000): on folder-v2 the activation\'s start members and agent before the office.\n'
		|| E'\tif public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
		|| E'\t\twhere office.id=(p_startup#>>''{scope,companyComputerId}'')::uuid)) then\n'
		|| E'\t\tperform public.qorpera_folder_office_enter((p_startup#>>''{scope,companyComputerId}'')::uuid, null, v_activation.intent_id);\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_assert_runtime_office_provider(p_startup->''scope'',(p_startup->>''computerGeneration'')::bigint,\n', 1);
	perform pg_temp.c1c3j_replace(
		'public.qorpera_check_runtime_office_adoption(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb)',
		E'\tv_result:=public.qorpera_check_runtime_office_start(p_scope,p_computer_generation,p_intent_id,p_allocation_id,\n',
		E'\t-- C1c-3j (20260930012000): adopting screens on folder-v2 comes with C1c-3k (its agents and members first); it\n'
		|| E'\t-- refuses before any lock.\n'
		|| E'\tif jsonb_typeof(p_mappings)=''array'' and jsonb_array_length(p_mappings)>0\n'
		|| E'\t\tand public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office\n'
		|| E'\t\t\twhere office.id=(p_scope->>''companyComputerId'')::uuid)) then\n'
		|| E'\t\traise exception ''Adopting a computer''''s screens comes later on this company'' using errcode=''0A000''; end if;\n'
		|| E'\tv_result:=public.qorpera_check_runtime_office_start(p_scope,p_computer_generation,p_intent_id,p_allocation_id,\n', 1);
end $$;

-- 4. The member's catalog, the hire's office walk and the interlock --------------------------------------------------------

do $$
begin
	-- The catalog: on folder-v2 the machine fence, then the member's row as before (one-space indent).
	perform pg_temp.c1c3j_replace('public.qorpera_member_office_catalog(uuid,uuid)',
		E' perform public.qorpera_lock_profile_gc_fence(v_company);\n',
		E' -- C1c-3j (20260930012000): on folder-v2 the folder fence and the company row KEY SHARE, never the gc fence.\n'
		|| E' if public.qorpera_company_is_folder_v2(v_company) then\n'
		|| E'  perform public.qorpera_folder_machine_fence(v_company);\n'
		|| E' else\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(v_company);\n'
		|| E' end if;\n', 1);

	-- A hire's default access walks the company's offices by id (on both cores: an order only).
	perform pg_temp.c1c3j_replace('public.qorpera_runtime_office_default_access_for_staff()',
		E'where profile_id = new.profile_id and state <> ''retired'' loop\n',
		E'where profile_id = new.profile_id and state <> ''retired''\n'
		|| E'\t\t\torder by id /* C1c-3j 20260930012000: offices in id order, as every office path takes them */ loop\n', 1);

	-- The interlock serializes the version-1 cutover: a folder-v2 company has none.
	perform pg_temp.c1c3j_replace('public.qorpera_enforce_company_path_computer_interlock()',
		E'\t\tif new.computer_class <> ''company_computer'' then return new; end if;\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(new.profile_id);\n',
		E'\t\tif new.computer_class <> ''company_computer'' then return new; end if;\n'
		|| E'\t\t-- C1c-3j (20260930012000): a folder-v2 company has no version-1 cutover to serialize.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(new.profile_id) then return new; end if;\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(new.profile_id);\n', 1);
end $$;

drop function pg_temp.c1c3j_replace(regprocedure, text, text, integer);
