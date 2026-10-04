-- Company folder core, C1c-3l part 1 (the coordinator's audit P06c): an agent starts the Company Computer of a folder-v2
-- company (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.16; plan outputs/company-accounts/p06-office-folder-v2-plan.md).
-- Builds on C1c-3j and C1c-3k (their body markers 20260930012000, 20260930019000 and 20260930019100).
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
-- * A start of the computer that appears after that read names someone the prelude did not lock. The start-source check
--   then shares that member as before (a member's writers never take a seat lock or a computer, so the wait is safe),
--   and that agent without waiting (FOR SHARE NOWAIT): an agent's return holds its row and wants the seat lock, so a wait
--   could deadlock. The start therefore joins a start that appeared meanwhile, and refuses (55P03) only when that agent's
--   row is being written at that very moment. The same check covers a member's start (C1c-3j) against an agent's start.
-- * 3j's prelude (qorpera_folder_office_enter) runs again inside calls that already hold the computer (a member's start
--   calls its before-idle body, a provider's wrapper its unbound body). Nested, it takes a start's agent without waiting:
--   the outer prelude took the same agent unless a start appeared in between, and then a wait could deadlock with that
--   agent's return.
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
end $$;

-- 2b. The start-source check: on folder-v2 the start's agent without waiting ----------------------------------------------

do $$
begin
	perform pg_temp.c1c3l_replace(
		'public.qorpera_assert_runtime_office_start_source(public.qorpera_runtime_offices,public.qorpera_runtime_office_start_intents)',
		E'\t\tperform 1 from public.qorpera_runtime_office_access access\n'
		|| E'\t\t\tjoin public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id\n'
		|| E'\t\t\twhere access.office_id=p_office.id and access.profile_id=p_office.profile_id\n'
		|| E'\t\t\tand access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id\n'
		|| E'\t\t\tand access.version=p_intent.grant_version and access.state=''active'' and staff.employment_status=''active''\n'
		|| E'\t\t\tfor share of access,staff;\n',
		E'\t\t-- C1c-3l (20260930030000): on folder-v2 every caller shared this agent before the computer, unless its start\n'
		|| E'\t\t-- appeared after the caller\'s read; then without waiting, since a return holds the row and wants the seat lock.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(p_office.profile_id) then\n'
		|| E'\t\t\tperform 1 from public.qorpera_runtime_office_access access\n'
		|| E'\t\t\t\tjoin public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id\n'
		|| E'\t\t\t\twhere access.office_id=p_office.id and access.profile_id=p_office.profile_id\n'
		|| E'\t\t\t\tand access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id\n'
		|| E'\t\t\t\tand access.version=p_intent.grant_version and access.state=''active'' and staff.employment_status=''active''\n'
		|| E'\t\t\t\tfor share of access for share of staff nowait;\n'
		|| E'\t\telse\n'
		|| E'\t\tperform 1 from public.qorpera_runtime_office_access access\n'
		|| E'\t\t\tjoin public.qorpera_profile_staff staff on staff.profile_id=access.profile_id and staff.staff_agent_id=access.staff_agent_id\n'
		|| E'\t\t\twhere access.office_id=p_office.id and access.profile_id=p_office.profile_id\n'
		|| E'\t\t\tand access.staff_agent_id=p_intent.requested_by_staff_agent_id and access.grant_id=p_intent.grant_id\n'
		|| E'\t\t\tand access.version=p_intent.grant_version and access.state=''active'' and staff.employment_status=''active''\n'
		|| E'\t\t\tfor share of access,staff;\n'
		|| E'\t\tend if;\n', 1);
end $$;

-- 2c. 3j's prelude, nested: the start's agent without waiting -------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3l_replace('public.qorpera_folder_office_enter(uuid,uuid,uuid)',
		E'\tif v_intent.requested_by_staff_agent_id is not null then\n'
		|| E'\t\tperform 1 from public.qorpera_profile_staff as staff\n'
		|| E'\t\twhere staff.profile_id = v_office.profile_id and staff.staff_agent_id = v_intent.requested_by_staff_agent_id\n'
		|| E'\t\tfor share;\n'
		|| E'\tend if;\n',
		E'\t-- C1c-3l (20260930030000): run again inside a call that already holds the computer, the prelude takes the agent of\n'
		|| E'\t-- a start that appeared since the first run without waiting (a wait could deadlock with that agent\'s return).\n'
		|| E'\tif v_intent.requested_by_staff_agent_id is not null\n'
		|| E'\t\tand position(v_office.id::text in coalesce(current_setting(''qorpera.folder_office_entered'', true), '''')) > 0 then\n'
		|| E'\t\tperform 1 from public.qorpera_profile_staff as staff\n'
		|| E'\t\twhere staff.profile_id = v_office.profile_id and staff.staff_agent_id = v_intent.requested_by_staff_agent_id\n'
		|| E'\t\tfor share nowait;\n'
		|| E'\telsif v_intent.requested_by_staff_agent_id is not null then\n'
		|| E'\t\tperform 1 from public.qorpera_profile_staff as staff\n'
		|| E'\t\twhere staff.profile_id = v_office.profile_id and staff.staff_agent_id = v_intent.requested_by_staff_agent_id\n'
		|| E'\t\tfor share;\n'
		|| E'\tend if;\n'
		|| E'\t-- Every computer this transaction entered, so a later prelude for any of them counts as nested.\n'
		|| E'\tif position(v_office.id::text in coalesce(current_setting(''qorpera.folder_office_entered'', true), '''')) = 0 then\n'
		|| E'\t\tperform set_config(''qorpera.folder_office_entered'',\n'
		|| E'\t\t\tcoalesce(current_setting(''qorpera.folder_office_entered'', true), '''') || v_office.id::text || '','', true);\n'
		|| E'\tend if;\n', 1);
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
		|| E'\t\t\tperform 1 from public.qorpera_profile_staff where profile_id=v_company and employment_status=''active''\n'
		|| E'\t\t\t\torder by staff_agent_id for key share;\n'
		|| E'\t\telse\n'
		|| E'\t\tperform public.qorpera_lock_profile_gc_fence(v_company);\n'
		|| E'\t\tend if;\n', 1);
	perform pg_temp.c1c3l_replace('public.qorpera_native_office_start_descriptor(jsonb,boolean)',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready'' and path_gateway_version=1)\n',
		E'\t\t\tand profile_id=v_office.profile_id and state=''ready''\n'
		|| E'\t\t\tand (path_gateway_version=1 or core=''folder-v2'' /* C1c-3l 20260930030000 */))\n', 1);
end $$;

drop function pg_temp.c1c3l_replace(regprocedure, text, text, integer);
