-- The company computer keeps running between runs.
--
-- 1. The company browser stays open while nobody is present.
-- qorpera_office_screen_browser_grant answered a check with nobody entitled
-- present (no live agent lease, no live input viewer, no tolerated presence)
-- by raising 'Browser authority unavailable', and the guest closed the
-- browser: its tabs and page state were gone at the agent's next run. A CHECK
-- (p_opener null) on a company-owned profile with no member takeover now
-- answers state 'idle' with the same grant, when the grant itself is usable
-- and the shared-surface check passed. An 'idle' answer means the browser may
-- stay open on the desktop, but its egress relay must carry no traffic until
-- an 'authorized' answer. 'idle' records no presence and no open.
-- Unchanged: somebody entitled present answers 'authorized' and records the
-- presence; a tolerated recent presence answers 'authorized' to a check; an
-- open without presence, a member-prepared profile without presence, a
-- takeover, a missing grant and a shared-surface refusal raise as before.
--
-- 2. A screen lease that expired without a release is reaped.
-- Acquire refuses SCREEN_OCCUPIED while a lease is set, even after it expired
-- (expiry is not proof of a drained guest), and nothing cleared such a lease:
-- the agent could never use its screen again and the office never idled off
-- (qorpera_runtime_office_has_demand counts a set lease). The supervisor
-- status, under the office lock it already takes, now releases every screen
-- lease that expired at least 30 seconds ago exactly as the lease's own
-- release does: unresolved agent work first gets a drain challenge (returned
-- in the same answer's drains), then the lease is cleared under a new epoch
-- and the office revision is raised once. A reap with no unresolved work sets
-- no drain, so the shared-viewer fence does not end shared viewers, as for an
-- ordinary release.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_office_screen_browser_grant(jsonb,text)'::regprocedure), 'sha256'), 'hex') <> '6abd7bbdb4edc3b996db02f3bc04c8a171d0498c6b8d80fbd7acbdde33615b32' then
		raise exception 'Reviewed function definition changed: qorpera_office_screen_browser_grant';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_office_screen_browser_grant(p_binding jsonb, p_opener text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_profile_id uuid; v_grant_id uuid; v_grant_version bigint; v_company_owned boolean; v_leased boolean;
	v_viewer public.qorpera_runtime_office_viewers%rowtype; v_viewers uuid[]:='{}'; v_members uuid[]:='{}';
	v_versions bigint[]:='{}'; v_fence jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	if p_opener is not null and p_opener not in ('agent','desktop') then raise exception 'Browser opener unavailable' using errcode='42501'; end if;
	-- Office active and shared, screen open and not draining, exact binding,
	-- agent access and employment: the same authority that keeps the desktop up.
	perform public.qorpera_check_runtime_office_shared_surface(p_binding);
	select * into strict v_office from public.qorpera_runtime_offices where id=(p_binding->>'companyComputerId')::uuid for share;
	select * into strict v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id
		and id=(p_binding->>'screenId')::uuid for share;
	-- The descriptor's own rule for a usable grant (company browser amendment).
	select g.profile_id,g.id,g.version,p.company_owned into v_profile_id,v_grant_id,v_grant_version,v_company_owned
		from public.qorpera_runtime_browser_grants g
		join public.qorpera_runtime_browser_profiles p on p.id=g.profile_id and p.office_id=g.office_id
		left join public.qorpera_profile_members m on m.profile_id=v_office.profile_id and m.user_id=p.owner_user_id
		where g.office_id=v_office.id and g.staff_agent_id=v_screen.staff_agent_id and g.state='active'
		and p.prepared and g.profile_version=p.version
		and (p.company_owned or (m.user_id is not null and g.owner_membership_version=coalesce((select version
			from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id and user_id=p.owner_user_id),0)))
		for share of g,p;
	if not found then raise exception 'Browser grant unavailable' using errcode='42501'; end if;
	v_leased:=v_screen.lease_id is not null and v_screen.lease_expires_at>clock_timestamp() and v_screen.takeover_user_id is null;
	for v_viewer in select * from public.qorpera_runtime_office_viewers where screen_id=v_screen.id and office_id=v_office.id
		and state='active' and mode in ('shared','control') and private_sign_in is null and expires_at>clock_timestamp()
		order by redeemed_at,id
	loop
		begin
			-- Membership, role, privacy version, epoch and takeover ownership, exactly
			-- as the viewer gateway rechecks them before each input.
			perform public.qorpera_assert_runtime_office_viewer(v_viewer,v_office,v_screen);
			v_viewers:=v_viewers||v_viewer.id; v_members:=v_members||v_viewer.member_id;
			v_versions:=v_versions||v_viewer.membership_version;
		exception when insufficient_privilege then null;
		end;
	end loop;
	-- The dock is pressed by whoever shares the desktop. It never starts a profile
	-- a member prepared privately (legacy member-lent grants outlive the company
	-- browser amendment), not even while the agent it was lent to holds the lease:
	-- only that agent's own run opens such a profile.
	v_fence:=jsonb_build_object('computerGeneration',v_office.generation,'privacyVersion',v_office.privacy_version,
		'screenGeneration',v_screen.generation,'sharedViewerEpoch',v_screen.shared_viewer_epoch,'drainId',v_screen.drain_id,
		'profileId',v_profile_id,'grantId',v_grant_id,'grantVersion',v_grant_version);
	if v_leased or cardinality(v_viewers)>0 then
		if not (v_leased or v_company_owned) or (p_opener='agent' and not v_leased)
			or (p_opener='desktop' and not v_company_owned) then
			raise exception 'Browser authority unavailable' using errcode='42501'; end if;
		-- Somebody entitled is present now. Rewritten at most every five seconds
		-- unless the facts changed, so the per-second relay check stays cheap.
		insert into public.qorpera_runtime_office_browser_presence as presence
			(screen_id,office_id,fence,present_member_ids,membership_versions,present_at)
		values(v_screen.id,v_office.id,v_fence,v_members,v_versions,clock_timestamp())
		on conflict(screen_id) do update set office_id=excluded.office_id,fence=excluded.fence,
			present_member_ids=excluded.present_member_ids,membership_versions=excluded.membership_versions,
			present_at=excluded.present_at
		where presence.fence is distinct from excluded.fence
			or presence.present_member_ids is distinct from excluded.present_member_ids
			or presence.membership_versions is distinct from excluded.membership_versions
			or presence.present_at<excluded.present_at-interval '5 seconds';
	elsif p_opener is not null or not v_company_owned or v_screen.takeover_user_id is not null then
		-- Nobody present: nothing is opened, a privately prepared profile is not
		-- kept for anybody, and a member's takeover screen keeps no agent browser.
		raise exception 'Browser authority unavailable' using errcode='42501';
	elsif not exists(select 1 from public.qorpera_runtime_office_browser_presence presence
			where presence.screen_id=v_screen.id and presence.fence=v_fence
			and presence.present_at>clock_timestamp()-interval '60 seconds'
			and (cardinality(presence.present_member_ids)=0 or exists(
				select 1 from unnest(presence.present_member_ids,presence.membership_versions) as was(member_id,membership_version)
				join public.qorpera_profile_members member on member.profile_id=v_office.profile_id
					and member.user_id=was.member_id and member.role in ('owner','admin')
				where was.membership_version=coalesce((select revoked.version
					from public.qorpera_runtime_browser_membership_revocations revoked
					where revoked.profile_id=v_office.profile_id and revoked.user_id=was.member_id),0)))) then
		-- Nobody present, and no recent unfenced presence to tolerate: idle. The
		-- company browser may stay open on the desktop, but its egress relay must
		-- carry no traffic until an 'authorized' answer. Nothing is recorded.
		return jsonb_build_object('state','idle','grant',jsonb_build_object('profileId',v_profile_id,'grantId',v_grant_id,'version',v_grant_version),
			'validForMs',5000);
	end if;
	if p_opener is not null then
		-- A launcher pressed again and again adds nothing new to know. Serialize
		-- opens of one screen (nothing else takes this lock, and it is taken last)
		-- and keep at most one row per screen, present member and opener per 60 s.
		perform pg_advisory_xact_lock(hashtextextended('qorpera_runtime_office_browser_open:'||v_screen.id::text,0));
		insert into public.qorpera_runtime_office_browser_opens(office_id,screen_id,staff_agent_id,profile_id,grant_id,grant_version,opener,run_id,viewer_id,present_member_id)
		select v_office.id,v_screen.id,v_screen.staff_agent_id,v_profile_id,v_grant_id,v_grant_version,p_opener,
			case when v_leased then v_screen.run_id end,present.viewer_id,present.member_id
		from (select viewer.id as viewer_id,viewer.member_id from unnest(v_viewers,v_members) as viewer(id,member_id)
			union all select null::uuid,null::uuid where cardinality(v_viewers)=0) present
		where not exists(select 1 from public.qorpera_runtime_office_browser_opens recent
			where recent.screen_id=v_screen.id and recent.opener=p_opener
			and recent.present_member_id is not distinct from present.member_id
			and recent.opened_at>clock_timestamp()-interval '60 seconds');
	end if;
	return jsonb_build_object('state','authorized','grant',jsonb_build_object('profileId',v_profile_id,'grantId',v_grant_id,'version',v_grant_version),
		'validForMs',5000);
end
$function$
;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_runtime_office_supervisor_status(jsonb,bigint)'::regprocedure), 'sha256'), 'hex') <> '7b306659b6af54a24542f081c3688058c8733a6d9a2d13ea4de85e0b8a7ed8dd' then
		raise exception 'Reviewed function definition changed: qorpera_runtime_office_supervisor_status';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_runtime_office_supervisor_status(p_scope jsonb, p_computer_generation bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_office public.qorpera_runtime_offices%rowtype; v_viewer public.qorpera_runtime_office_viewers%rowtype;
	v_screen public.qorpera_runtime_office_screens%rowtype; v_reaped boolean:=false; v_drains jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation then
		raise exception 'Office supervisor binding differs' using errcode='42501'; end if;
	-- Bounded under the same office lock used by viewer admission. Draining
	-- controls are already fenced and remain until an exact physical ack.
	for v_viewer in select * from public.qorpera_runtime_office_viewers where office_id=v_office.id
		and state in ('issued','active') and (expires_at<=clock_timestamp() or absolute_deadline<=clock_timestamp())
		order by (mode='control') desc,issued_at,id limit 64 loop
		perform public.qorpera_release_runtime_office_viewer(public.qorpera_runtime_office_viewer_grant(v_viewer));
	end loop;
	-- A screen lease whose run never released it (the run or its broker died)
	-- would occupy the screen for good. Once expired for 30 seconds it is
	-- released here exactly as its own release would: unresolved agent work
	-- first gets a drain challenge, returned below, then the lease is cleared
	-- under a new epoch. Office row, then screen rows, then resources, as there.
	for v_screen in select * from public.qorpera_runtime_office_screens where office_id=v_office.id
		and lease_id is not null and lease_expires_at<=clock_timestamp()-interval '30 seconds'
		order by ordinal for update loop
		if exists(select 1 from public.qorpera_runtime_office_resources where screen_id=v_screen.id and state<>'drained') then
			update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),
				drain_acknowledged_at=null where id=v_screen.id;
			update public.qorpera_runtime_office_resources set state='draining' where screen_id=v_screen.id and state='active';
		end if;
		update public.qorpera_runtime_office_screens set lease_id=null,run_id=null,lease_expires_at=null,
			grant_version=null,native_binding=null,epoch=epoch+1,touched_at=clock_timestamp() where id=v_screen.id;
		v_reaped:=true;
	end loop;
	if v_reaped then update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id;
	select coalesce(jsonb_agg(jsonb_build_object('state','draining','drainId',s.drain_id,'epoch',s.epoch,
		'binding',p_scope||jsonb_build_object('computerGeneration',v_office.generation,'screenId',s.id,
			'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id)) order by s.ordinal),'[]'::jsonb)
	into v_drains from public.qorpera_runtime_office_screens s where s.office_id=v_office.id and s.drain_pending;
	return jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,'revision',v_office.revision,'state',v_office.state,
		'privacyState',v_office.privacy_state,'privacyVersion',v_office.privacy_version,'privacyChallenge',v_office.privacy_challenge,'drains',v_drains);
end
$function$
;
