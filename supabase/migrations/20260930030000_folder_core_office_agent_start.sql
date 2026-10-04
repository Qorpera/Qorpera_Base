-- Company folder core, C1c-3l part 1 (the coordinator's audit P06c): an agent starts the Company Computer of a folder-v2
-- company (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.13; plan outputs/company-accounts/p06-office-folder-v2-plan.md).
-- Builds on C1c-3j (20260930012000) and C1c-3k (20260930019000, 20260930019100).
--
-- Folder-v2 only (the founder's decision of 3 October): each patch is a folder-v2 branch, and the statement that was
-- there before stays untouched in its else. On a folder-v2 company:
-- * An agent's computer_start (qorpera_native_office_start) and its descriptor (qorpera_native_office_start_descriptor)
--   no longer refuse with 0A000.
-- * qorpera_folder_office_start_enter(binding): the start's prelude. The agent's tool run takes its members and agents
--   only KEY SHARE, but the start-source check shares the start's agent (or member) after the computer, and a start may
--   join another start of the same computer. So before the seat lock and the computers, the tool run takes FOR SHARE
--   the members (rank 1) and agents (rank 2) that any current start of the company's computers names, and the run's own
--   agent, plus every active agent KEY SHARE (a new computer's default access takes them). An agent's return (its row,
--   then the seat lock through the hire's walk, then the computers) then waits at the agent's row, never in a cycle.
-- * A start of the computer that appears after that read names someone the prelude did not lock: the start refuses with
--   55P03 ("try again"), which the runtime treats as no answer.
-- * The start takes no gc fence (its tool run holds the folder fence and the company row KEY SHARE); the descriptor's new
--   computer takes the company's agents KEY SHARE before the seat lock, as a member's new computer does (C1c-3k); the
--   descriptor's gate accepts a ready folder-v2 Company File.
--
-- Not here (C1c-3l part 2, 20260930030100): the office-activation wake (its drain, the waiter check, the pin, the folder
-- wake check and the run resolve), which is what wakes the agent once its computer is up. Each patched function and the
-- new helper name this migration (20260930030000) in their bodies, for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.c1c3l_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3l patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The start's prelude -----------------------------------------------------------------------------------------------

create function public.qorpera_folder_office_start_enter(p_binding jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_members uuid[] := '{}';
	v_staff uuid[] := '{}';
	v_targets jsonb;
begin
	-- C1c-3l (20260930030000): plain reads name the rows; the run's tool run then takes them in rank order, before the
	-- caller's seat lock and computers. A binding this cannot read is left to the tool run, which refuses it.
	select run.* into v_run from public.qorpera_execution_runs as run
	where run.id = case when coalesce(p_binding ->> 'runId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then (p_binding ->> 'runId')::uuid end;
	if v_run.id is null then return; end if;
	select coalesce(array_agg(distinct intent.requested_by_user_id) filter (where intent.requested_by_user_id is not null), '{}'),
		coalesce(array_agg(distinct intent.requested_by_staff_agent_id) filter (where intent.requested_by_staff_agent_id is not null), '{}')
	into v_members, v_staff
	from public.qorpera_runtime_offices as office
	join public.qorpera_runtime_office_start_intents as intent
		on intent.office_id = office.id and intent.computer_generation = office.generation
	where office.environment_id = v_run.environment_id and office.profile_id = v_run.profile_id;
	v_staff := array(select distinct staff from unnest(v_staff || v_run.staff_agent_id) as staff);
	v_targets := coalesce((select jsonb_agg(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_run.profile_id::text || ':' || member::text, 'mode', 'share')) from unnest(v_members) as member), '[]'::jsonb)
		|| coalesce((select jsonb_agg(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
			'key', v_run.profile_id::text || ':' || staff::text, 'mode', 'share')) from unnest(v_staff) as staff), '[]'::jsonb)
		|| coalesce((select jsonb_agg(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
			'key', staff.profile_id::text || ':' || staff.staff_agent_id::text, 'mode', 'keyshare'))
			from public.qorpera_profile_staff as staff
			where staff.profile_id = v_run.profile_id and staff.employment_status = 'active'), '[]'::jsonb);
	perform public.qorpera_folder_tool_run(p_binding, v_targets);
	-- The start checks its start of the computer against these (55P03 for one named after this read).
	perform set_config('qorpera.office_start_held',
		jsonb_build_object('members', to_jsonb(v_members), 'staff', to_jsonb(v_staff))::text, true);
end $$;
revoke all on function public.qorpera_folder_office_start_enter(jsonb) from public, anon, authenticated, service_role;

-- 2. The agent's start ---------------------------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start(jsonb,text,text,uuid,text)',
		E'\tif public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t-- C1c-3l (20260930030000): serves folder-v2; its tool run takes the start\'s members and agents first (below).\n', 1);
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start(jsonb,text,text,uuid,text)',
		E'\tv_authority:=public.qorpera_describe_native_tool_authority(p_binding);\n',
		E'\t-- C1c-3l (20260930030000): on folder-v2 the start\'s members and agents FOR SHARE, before the seat lock and computers.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\tperform public.qorpera_folder_office_start_enter(p_binding);\n'
		|| E'\tend if;\n'
		|| E'\tv_authority:=public.qorpera_describe_native_tool_authority(p_binding);\n', 1);
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start(jsonb,text,text,uuid,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence((v_authority#>>''{identity,companyId}'')::uuid);\n',
		E'\t-- C1c-3l (20260930030000): on folder-v2 the tool run holds the folder fence and the company row KEY SHARE.\n'
		|| E'\tif not public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence((v_authority#>>''{identity,companyId}'')::uuid);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start(jsonb,text,text,uuid,text)',
		E'\t\treturning * into v_intent;\n'
		|| E'\tend if;\n',
		E'\t\treturning * into v_intent;\n'
		|| E'\tend if;\n'
		|| E'\t-- C1c-3l (20260930030000): on folder-v2 a start of this computer that names someone the prelude did not lock\n'
		|| E'\t-- appeared after its read: try again.\n'
		|| E'\tif public.qorpera_binding_is_folder_v2(p_binding) and (\n'
		|| E'\t\t(v_intent.requested_by_user_id is not null and not coalesce(current_setting(''qorpera.office_start_held'', true)::jsonb\n'
		|| E'\t\t\t-> ''members'' ? v_intent.requested_by_user_id::text, false))\n'
		|| E'\t\tor (v_intent.requested_by_staff_agent_id is not null and not coalesce(current_setting(''qorpera.office_start_held'', true)::jsonb\n'
		|| E'\t\t\t-> ''staff'' ? v_intent.requested_by_staff_agent_id::text, false))) then\n'
		|| E'\t\traise exception ''The Company Computer''''s start changed while this one waited'' using errcode = ''55P03''; end if;\n', 1);
end $$;

-- 3. The descriptor ------------------------------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start_descriptor(jsonb,boolean)',
		E'\tif public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t-- C1c-3l (20260930030000): serves folder-v2 (the authority check below is the folder tool run).\n', 1);
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start_descriptor(jsonb,boolean)',
		E'\t\tperform public.qorpera_lock_profile_gc_fence(v_company);\n',
		E'\t\t-- C1c-3l (20260930030000): on folder-v2 the company\'s agents KEY SHARE before the seat lock (the new computer\n'
		|| E'\t\t-- takes them KEY SHARE again for its default access), as a member\'s new computer does.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(v_company) then\n'
		|| E'\t\t\tperform 1 from public.qorpera_profile_staff where profile_id=v_company order by staff_agent_id for key share;\n'
		|| E'\t\telse\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_company);\n'
		|| E'\t\tend if;\n', 1);
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start_descriptor(jsonb,boolean)',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3l 20260930030000 */))\n', 1);
end $$;

drop function pg_temp.c1c3l_replace(regprocedure, text, text, integer);
