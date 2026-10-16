-- Test machine retirement: F3 step 6, slice 6d, part 2 (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md "Views",
-- "Access" and "Reads" rule 5). The machine executor moves a test machine to a new disk when its disk may no longer get
-- a view, or its view's reads can no longer be proven.
-- 1. The retirement, under the executor's custody (the fence briefly, the machine, the placement), for the placement's
--    current boot. The executor asks with what it saw: the open refused the disk ("new-disk", the open's
--    "qorpera.test-machine/new-disk"), or the guest's reads on its view are unreadable ("unreadable"). The cause is
--    checked again here, as the open checks it: a command ran on the disk without the folder check ("unchecked"), or the
--    disk had a view and the starter's agent and member no longer read the root ("starter"), or the disk has had a view
--    whose reads are unreadable ("unreadable"). A disk that may still get a view is kept. A retired placement keeps its
--    cause (folder_retire_reason, for the report), its open view (for the final publish, which closes it) and its boot;
--    the machine's open commands end lost, and the runs that asked are told. The machine still wants to run, so
--    admission starts it on a new disk, and the old placement is stopped and deleted as any retired one. Repeating it
--    answers the same; a placement retired otherwise, removed, or on another boot answers "stale".
-- 2. The authorize/open race: a run woken when its machine runs may start a command before the executor has opened the
--    boot's view. Such a start no longer marks the disk when the caller's agent and member read the root: what it may
--    leave there is no more than such a caller may leave on a disk that has a view. A caller without the root read still
--    marks it, and the executor then retires it (1).
--
-- Exact-text patch: it fails unless the function has the text given exactly once. Body marker "20260930424000".

set local lock_timeout = '3s';

do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_company_machine_placements'::regclass
		and attname = 'folder_retire_reason' and not attisdropped) then
		raise exception 'Test machine retirement (20260930424000) is already applied'; end if;
end $$;

create function pg_temp.folder_test_machine_retire_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The retirement --------------------------------------------------------------------------------------------------

-- Why the executor moved the machine off this disk: set only with the retirement.
alter table public.qorpera_company_machine_placements add column folder_retire_reason text,
	add constraint qorpera_company_machine_placements_folder_retire_reason check (folder_retire_reason is null
		or (folder_retire_reason in ('unchecked','starter','unreadable') and retired_at is not null));

create function public.qorpera_retire_company_machine(p_placement_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text, p_boot_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_had_view boolean; v_cause text;
begin
	-- 20260930424000.
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_boot_id is null or p_reason is null or p_reason not in ('new-disk','unreadable') then
		raise exception 'Machine retirement invalid' using errcode = '22023'; end if;
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	if v_placement.removed_at is null and v_placement.folder_retire_reason is not null then
		return jsonb_build_object('state','retired','machineId',v_machine.id,'placementId',v_placement.id,
			'reason',v_placement.folder_retire_reason,'retiredAt',v_placement.retired_at); end if;
	if v_placement.removed_at is not null or v_placement.retired_at is not null or v_placement.boot_id is distinct from p_boot_id then
		return '{"state":"stale"}'::jsonb; end if;
	-- The open's own causes, under the machine and the placement (FOR UPDATE), which the open waits for (FOR SHARE).
	v_had_view := exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
	v_cause := case
		when p_reason = 'unreadable' then case when v_had_view then 'unreadable' end
		when v_placement.folder_unchecked_at is not null then 'unchecked'
		when v_had_view and not (exists (select 1 from public.qorpera_profile_staff where profile_id = v_machine.profile_id
					and staff_agent_id = v_machine.started_by_staff_agent_id and employment_status = 'active')
				and exists (select 1 from public.qorpera_profile_members where profile_id = v_machine.profile_id
					and user_id = v_machine.requested_by_user_id)
				and public.qorpera_folder_reads_root(v_machine.environment_id, v_machine.profile_id,
					v_machine.started_by_staff_agent_id, v_machine.requested_by_user_id)) then 'starter' end;
	if v_cause is null then return '{"state":"kept","reason":"FOLDER_DISK_USABLE"}'::jsonb; end if;
	-- Its programs stop with it; the runs that asked are told.
	perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
	update public.qorpera_company_machine_placements set retired_at = clock_timestamp(), folder_retire_reason = v_cause
	where id = v_placement.id returning * into v_placement;
	return jsonb_build_object('state','retired','machineId',v_machine.id,'placementId',v_placement.id,'reason',v_cause,
		'retiredAt',v_placement.retired_at);
end
$$;
revoke all on function public.qorpera_retire_company_machine(uuid, text, text, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_retire_company_machine(uuid, text, text, text, uuid, text) to service_role;

-- 2. The authorize/open race -----------------------------------------------------------------------------------------

-- Only a start by a caller without the root read marks a disk that never had a view.
select pg_temp.folder_test_machine_retire_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$			-- 20260930420000: the open refuses this disk from now on.
			update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
			where id = v_placement.id and folder_unchecked_at is null
				and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
$old$,
	$new$			-- 20260930420000: the open refuses this disk from now on. 20260930424000: unless the caller reads the root,
			-- as on a disk that has a view (a start before the boot's open).
			update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
			where id = v_placement.id and folder_unchecked_at is null
				and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id)
				and not public.qorpera_folder_reads_root(v_machine.environment_id, v_machine.profile_id,
					(v_identity ->> 'staffAgentId')::uuid, (v_identity ->> 'requesterUserId')::uuid);
$new$);

-- The patched function may have a private owner in production: it reaches the root check (20260930420000 granted it;
-- granted again so this migration stands on its own).
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
		'public.qorpera_retire_company_machine(uuid,text,text,text,uuid,text)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Test machine retirement function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_folder_reads_root(uuid, uuid, uuid, uuid) to %I', v_owner);
		end if;
	end loop;
end $$;
