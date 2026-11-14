-- 20260930745000: the live picture of an agent's desktop (POINTER-BRIEF.md, step 2; POINTER-PROGRESS.md 05:15Z, the lead's
-- B1). In the large view a member who may act gets the desktop's changed areas as they change, over one held-open stream
-- from the machine's node, instead of a picture every 450 ms. The stream only SHOWS: nothing on it can reach the desktop.
-- Every picture today passes three checks before it leaves the machine's node (the take-over fence, the company folder's
-- boundary, the member's own read check); the stream keeps all three, run together as a RELEASE CYCLE: what changed on the
-- screen at a time t leaves only after a cycle that began after t passed.
--
-- * qorpera_member_machine_stream_release(placement, boot, user, generation, epoch), the machine's node's read for one
--   release cycle (service_role; read only, it writes and locks nothing): the placement's machine, not removed, running on
--   exactly that boot; the member still an owner, admin or contributor of a company not being deleted; the disk's root-read
--   rule as a look's (MACHINE_NEEDS_COMPANY_VIEW); then the stream's own hold, as the pointer pass's (20260930744000):
--   shared (no epoch) only while no one holds the desktop privately (DESKTOP_MEMBER_IN_CONTROL) and the lease generation
--   is still `generation` (DESKTOP_HELD_SINCE); private (an epoch) only while the member's own hold is live under that
--   epoch and in that seat (`generation`; else DESKTOP_CONTROL_ENDED). Last, the member's read check of what the machine
--   read (qorpera_folder_member_machine_reads, unchanged: every read of the machine's newest view must be the member's to
--   read now, else it raises 42501 with detail qorpera.test-machine/member-unreadable, and the stream shows nothing more).
--   A member who is no longer one who may act, or no member: STREAM_NOT_ALLOWED. Not running, or another boot:
--   MACHINE_NOT_RUNNING.
-- * Not changed: every take-over, generation, epoch and seat fence; the looks, the actions and the pointer pass; the
--   machine's last use (the pointer pass's renewals stamp it while the member is at the desktop); every grant.
-- Every new body names this migration (20260930745000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)') is not null then
		raise exception '20260930745000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_pointer_authority(uuid,text,text)') is null then
		raise exception '20260930745000 needs the member''s pointer (20260930744000)'; end if;
	if to_regprocedure('public.qorpera_folder_member_machine_reads(uuid,uuid,uuid)') is null then
		raise exception '20260930745000 needs the member''s read check (20260930712000)'; end if;
end $$;

-- A new function only: it locks nothing anyone else waits on.
set local lock_timeout = '3s';

create function public.qorpera_member_machine_stream_release(p_placement_id uuid, p_boot_id uuid, p_user_id uuid,
	p_generation bigint, p_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_root public.qorpera_company_path_resources%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	-- 20260930745000
	if auth.role() is distinct from 'service_role' or p_placement_id is null or p_boot_id is null or p_user_id is null
		or not coalesce(p_generation >= 0 and (p_epoch is null or p_epoch >= 0), false) then
		raise exception 'Machine desktop stream request is malformed' using errcode = '22023'; end if;
	select placement.* into v_placement from public.qorpera_company_machine_placements as placement
	where placement.id = p_placement_id;
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = v_placement.machine_id and machine.removed_at is null;
	if not found then
		raise exception 'Machine desktop stream is unavailable' using errcode = '42501'; end if;
	-- The member, as one who may act on the desktop, of a company not being deleted.
	if not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_machine.profile_id and member.user_id = p_user_id
				and member.role::text in ('owner', 'admin', 'contributor'))
		or public.qorpera_company_deleting(v_machine.profile_id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
			'reason', 'STREAM_NOT_ALLOWED'); end if;
	-- Running, and on exactly the boot the stream shows.
	if v_machine.desired_state <> 'running' or v_placement.retired_at is not null or v_placement.removed_at is not null
		or v_placement.running_at is null or v_placement.boot_id is distinct from p_boot_id
		or v_placement.id is distinct from (public.qorpera_company_machine_placement(v_machine.id)).id
		or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'); end if;
	select * into v_root from public.qorpera_company_path_resources where environment_id = v_machine.environment_id and path = '';
	if not coalesce(public.qorpera_folder_principal_allowed(v_machine.profile_id, v_root, 'member', p_user_id, 'read'), false)
		and exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id) then
		return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
			'reason', 'MACHINE_NEEDS_COMPANY_VIEW'); end if;
	if p_epoch is null then
		-- Shared: no one holds the desktop privately, and no one did since the stream's generation.
		if coalesce(v_machine.desktop_member_until > v_now, false) then
			return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
				'reason', 'DESKTOP_MEMBER_IN_CONTROL'); end if;
		if v_machine.desktop_member_generation is distinct from p_generation then
			return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
				'reason', 'DESKTOP_HELD_SINCE'); end if;
	elsif not coalesce(v_machine.desktop_member_until > v_now, false)
		or v_machine.desktop_member_user_id is distinct from p_user_id
		or v_machine.desktop_member_epoch is distinct from p_epoch
		or v_machine.desktop_member_generation is distinct from p_generation then
		-- Private: the member's own live hold, under that epoch and in that seat.
		return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'refused',
			'reason', 'DESKTOP_CONTROL_ENDED'); end if;
	-- What the machine read is the member's to read now (raises 42501, detail qorpera.test-machine/member-unreadable).
	perform public.qorpera_folder_member_machine_reads(p_placement_id, p_boot_id, p_user_id);
	return jsonb_build_object('schema', 'qorpera.member-machine-stream-release/v1', 'state', 'ok');
end
$$;
revoke all on function public.qorpera_member_machine_stream_release(uuid, uuid, uuid, bigint, bigint)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_member_machine_stream_release(uuid, uuid, uuid, bigint, bigint) to service_role;

-- The deploy guard: the new body carries the marker.
do $guard$
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_member_machine_stream_release(uuid,uuid,uuid,bigint,bigint)'::regprocedure),
			'20260930745000') = 0 then
		raise exception '20260930745000 marker is missing'; end if;
end $guard$;
