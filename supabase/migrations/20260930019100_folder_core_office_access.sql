-- Company folder core, C1c-3k part 2 (the coordinator's audit P06b): the Company Computer's access, screens and viewers
-- in rank order on the folder fence (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.12; plan
-- outputs/company-accounts/p06-office-folder-v2-plan.md). Builds on C1c-3j (20260930012000) and part 1 (20260930019000).
--
-- Folder-v2 only (the founder's decision of 3 October): each patch is a folder-v2 branch, and the statement that was
-- there before stays untouched in its else. On a folder-v2 company:
-- * An agent's access to a computer (set_runtime_office_access, and configure through it) takes the machine fence, the
--   acting member (rank 1), the agent (rank 2), the seat lock, then every live computer of the company FOR UPDATE by id,
--   before the access row. The access triggers change the agent's access rows (and maybe the computers' revisions) on
--   every sibling computer; the gc fence used to serialize that, and the machine fence alone would let two changes of one
--   agent on two computers deadlock. The seat lock also orders it with a new computer for an agent.
-- * Access status is plain reads.
-- * A hire or an agent's return (the staff trigger's office walk) takes the company's seat lock before the computers,
--   and a new computer for an agent (member_agent_office 'new') and a first registration share the company's agents
--   KEY SHARE before theirs. So a computer added while an agent is hired or returns gets the agent's default access:
--   one of the two waits at the seat lock for the other.
-- * Opening a screen takes the machine fence and the member's row before the seat lock and the computer.
-- * The private screen heartbeat takes the privacy owner with the start's members (3j's prelude) before the computer.
-- * The viewers (create, redeem, the input check) and the screen's browser grant share the viewers' member rows before
--   the computer, without the fence on these hot paths.
--
-- Each patched function and each new helper names this migration (20260930019100) in its body, for the deploy guard;
-- earlier slices' markers stay.

set local lock_timeout = '3s';

create function pg_temp.c1c3k2_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3k part 2 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Helpers -------------------------------------------------------------------------------------------------------------

create function public.qorpera_folder_office_members_first(p_office_id uuid, p_user_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
	-- C1c-3k (20260930019100): on folder-v2, these members' rows (rank 1) FOR SHARE by user id before the caller locks
	-- the computer. No fence: the viewer paths are hot, and taking rank 1 alone never goes backwards.
	select office.profile_id into v_profile from public.qorpera_runtime_offices as office where office.id = p_office_id;
	if not public.qorpera_company_is_folder_v2(v_profile) then return; end if;
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = v_profile and member.user_id = any (p_user_ids)
	order by member.user_id for share;
end $$;
revoke all on function public.qorpera_folder_office_members_first(uuid, uuid[]) from public, anon, authenticated, service_role;

create function public.qorpera_folder_office_enter_startup(p_startup jsonb, p_member_user_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_office uuid;
	v_activation public.qorpera_runtime_office_activations%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- C1c-3k (20260930019100): a private screen heartbeat on folder-v2 takes 3j's prelude with the privacy owner as its
	-- member: the fence, the owner and the start's requester (rank 1), the start's agent (rank 2), before the startup
	-- lock takes the computer. A startup this cannot read is left to the startup lock, which refuses it.
	if coalesce(p_startup #>> '{scope,companyComputerId}', '') !~* v_uuid
		or coalesce(p_startup ->> 'allocationId', '') !~* v_uuid
		or coalesce(p_member_user_id, '') !~* v_uuid then return; end if;
	v_office := (p_startup #>> '{scope,companyComputerId}')::uuid;
	if not public.qorpera_company_is_folder_v2((select office.profile_id from public.qorpera_runtime_offices as office
		where office.id = v_office)) then return; end if;
	select activation.* into v_activation from public.qorpera_runtime_office_activations as activation
	where activation.allocation_id = (p_startup ->> 'allocationId')::uuid and activation.superseded_at is null;
	perform public.qorpera_folder_office_enter(v_office, p_member_user_id::uuid, v_activation.intent_id);
end $$;
revoke all on function public.qorpera_folder_office_enter_startup(jsonb, text) from public, anon, authenticated, service_role;

-- 2. Access: the serializer, plain status ----------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3k2_replace('public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E'\t-- C1c-3k (20260930019100): on folder-v2 the machine fence, the acting member, the agent, the seat lock, then every\n'
		|| E'\t-- live computer of the company by id: the access triggers change this agent\'s rows on all of them.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;\n'
		|| E'\t\tperform 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id for share;\n'
		|| E'\t\tperform public.qorpera_lock_runtime_office_seats(v_office.environment_id);\n'
		|| E'\t\tperform 1 from public.qorpera_runtime_offices where environment_id=v_office.environment_id and state<>''retired''\n'
		|| E'\t\t\torder by id for update;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3k2_replace('public.qorpera_runtime_office_access_status(jsonb,uuid)',
		E' perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n',
		E' -- C1c-3k (20260930019100): plain reads on folder-v2 (the setter checks again under its locks).\n'
		|| E' if not public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);\n'
		|| E' end if;\n', 1);
end $$;

-- 3. A computer added while an agent is hired or returns ------------------------------------------------------------------

do $$
begin
	-- The hire's office walk: the seat lock of the company's environments before the computers.
	perform pg_temp.c1c3k2_replace('public.qorpera_runtime_office_default_access_for_staff()',
		E'\t\tfor v_office in select id from public.qorpera_runtime_offices where profile_id = new.profile_id and state <> ''retired''\n',
		E'\t\t-- C1c-3k (20260930019100): on folder-v2 the company\'s seat locks first, so a computer added meanwhile (which\n'
		|| E'\t\t-- takes the seat lock) is either seen here or sees this agent active.\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(new.profile_id) then\n'
		|| E'\t\t\tperform public.qorpera_lock_runtime_office_seats(environment.id) from public.qorpera_company_environments as environment\n'
		|| E'\t\t\twhere environment.profile_id = new.profile_id order by environment.id;\n'
		|| E'\t\tend if;\n'
		|| E'\t\tfor v_office in select id from public.qorpera_runtime_offices where profile_id = new.profile_id and state <> ''retired''\n', 1);
	-- A new computer for an agent: the company's agents KEY SHARE (rank 2) before the seat lock.
	perform pg_temp.c1c3k2_replace('public.qorpera_member_agent_office(uuid,uuid)',
		E'\t\tperform public.qorpera_lock_runtime_office_seats(p_environment_id);\n',
		E'\t\t-- C1c-3k (20260930019100): on folder-v2 the company\'s agents KEY SHARE before the seat lock (the new computer\n'
		|| E'\t\t-- takes them KEY SHARE again for its default access).\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(v_company) then\n'
		|| E'\t\t\tperform 1 from public.qorpera_profile_staff where profile_id=v_company order by staff_agent_id for key share;\n'
		|| E'\t\tend if;\n'
		|| E'\t\tperform public.qorpera_lock_runtime_office_seats(p_environment_id);\n', 1);
	-- A first registration (3j's folder mode): the same, before its seat lock.
	perform pg_temp.c1c3k2_replace('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)',
		E'\t\tperform public.qorpera_lock_runtime_office_seats(p_environment_id);\n',
		E'\t\t-- C1c-3k (20260930019100): the company\'s agents KEY SHARE before the seat lock.\n'
		|| E'\t\tperform 1 from public.qorpera_profile_staff where profile_id=v_profile order by staff_agent_id for key share;\n'
		|| E'\t\tperform public.qorpera_lock_runtime_office_seats(p_environment_id);\n', 1);
end $$;

-- 4. Opening a screen and the private heartbeat --------------------------------------------------------------------------

do $$
begin
	perform pg_temp.c1c3k2_replace('public.qorpera_open_runtime_office_screen(jsonb,uuid)',
		E'\tperform public.qorpera_lock_runtime_office_seats(v_office.environment_id);\n',
		E'\t-- C1c-3k (20260930019100): on folder-v2 the machine fence and the member\'s row before the seat lock and the computer.\n'
		|| E'\tif public.qorpera_company_is_folder_v2(v_office.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_machine_fence(v_office.profile_id);\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;\n'
		|| E'\tend if;\n'
		|| E'\tperform public.qorpera_lock_runtime_office_seats(v_office.environment_id);\n', 1);
	perform pg_temp.c1c3k2_replace('public.qorpera_record_runtime_screen_event(jsonb,jsonb,jsonb,jsonb)',
		E'  v_activation:=public.qorpera_lock_runtime_office_startup(p_startup);\n',
		E'  -- C1c-3k (20260930019100): a private heartbeat on folder-v2 takes the privacy owner with the start\'s members first.\n'
		|| E'  if jsonb_typeof(p_privacy)=''object'' then\n'
		|| E'   perform public.qorpera_folder_office_enter_startup(p_startup, p_privacy->>''memberId'');\n'
		|| E'  end if;\n'
		|| E'  v_activation:=public.qorpera_lock_runtime_office_startup(p_startup);\n', 1);
end $$;

-- 5. The viewers and the screen's browser grant: the members before the computer ----------------------------------------

do $$
begin
	perform pg_temp.c1c3k2_replace('public.qorpera_create_runtime_office_viewer(jsonb,bigint,text,jsonb)',
		E'\tselect * into v_office from public.qorpera_runtime_offices where id=(p_binding->>''companyComputerId'')::uuid for update;\n',
		E'\t-- C1c-3k (20260930019100): on folder-v2 the member\'s row before the computer.\n'
		|| E'\tperform public.qorpera_folder_office_members_first((p_binding->>''companyComputerId'')::uuid, array[auth.uid()]);\n'
		|| E'\tselect * into v_office from public.qorpera_runtime_offices where id=(p_binding->>''companyComputerId'')::uuid for update;\n', 1);
	perform pg_temp.c1c3k2_replace('public.qorpera_redeem_runtime_office_viewer(jsonb,text)',
		E'\tselect * into strict v_office from public.qorpera_runtime_offices where id=v_viewer.office_id for update;\n',
		E'\t-- C1c-3k (20260930019100): on folder-v2 the viewer\'s member row before the computer.\n'
		|| E'\tperform public.qorpera_folder_office_members_first(v_viewer.office_id, array[v_viewer.member_id]);\n'
		|| E'\tselect * into strict v_office from public.qorpera_runtime_offices where id=v_viewer.office_id for update;\n', 1);
	perform pg_temp.c1c3k2_replace('public.qorpera_check_runtime_office_viewer(jsonb)',
		E'\tselect * into v_office from public.qorpera_runtime_offices where id=(p_grant#>>''{binding,companyComputerId}'')::uuid for update;\n',
		E'\t-- C1c-3k (20260930019100): on folder-v2 the viewer\'s member row before the computer.\n'
		|| E'\tperform public.qorpera_folder_office_members_first((p_grant#>>''{binding,companyComputerId}'')::uuid,\n'
		|| E'\t\tarray(select viewer.member_id from public.qorpera_runtime_office_viewers as viewer\n'
		|| E'\t\t\twhere viewer.id=case when p_grant->>''viewerSessionId'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''\n'
		|| E'\t\t\t\tthen (p_grant->>''viewerSessionId'')::uuid end));\n'
		|| E'\tselect * into v_office from public.qorpera_runtime_offices where id=(p_grant#>>''{binding,companyComputerId}'')::uuid for update;\n', 1);
	perform pg_temp.c1c3k2_replace('public.qorpera_office_screen_browser_grant(jsonb,text)',
		E'\tperform public.qorpera_check_runtime_office_shared_surface(p_binding);\n',
		E'\t-- C1c-3k (20260930019100): on folder-v2 the screen\'s active viewers\' member rows before the computer.\n'
		|| E'\tperform public.qorpera_folder_office_members_first((p_binding->>''companyComputerId'')::uuid,\n'
		|| E'\t\tarray(select viewer.member_id from public.qorpera_runtime_office_viewers as viewer\n'
		|| E'\t\t\twhere viewer.screen_id=case when p_binding->>''screenId'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''\n'
		|| E'\t\t\t\tthen (p_binding->>''screenId'')::uuid end and viewer.state=''active''));\n'
		|| E'\tperform public.qorpera_check_runtime_office_shared_surface(p_binding);\n', 1);
end $$;

drop function pg_temp.c1c3k2_replace(regprocedure, text, text, integer);
