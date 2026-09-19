-- The company browser belongs to the screen, not to one agent run. A member who
-- shares the agent's desktop opens it from the dock; the agent's next run uses
-- the same window. This broker-only function is the screen's browser authority:
-- the screen agent's current browser grant, usable while an agent holds the
-- screen lease or a member with input permission is live on this screen.
--
-- It mints nothing. Member input still passes the viewer input admission,
-- agent effects still need their receipts and the run's own browser grant
-- check, and the egress relay asks again for every connection. A profile a
-- member prepared privately is never opened for another member: without an
-- agent lease only a company-owned profile qualifies, and the dock ('desktop')
-- opens only a company-owned profile whether or not a lease exists.
create table public.qorpera_runtime_office_browser_opens (
	id uuid primary key default extensions.gen_random_uuid(),
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete restrict,
	staff_agent_id uuid not null,
	profile_id uuid not null,
	grant_id uuid not null,
	grant_version bigint not null check(grant_version between 1 and 9007199254740991),
	opener text not null check(opener in ('agent','desktop')),
	-- The run holding the screen lease at that moment, if any.
	run_id uuid,
	-- One row per member who could have pressed the launcher: the desktop is
	-- shared, so a click cannot be attributed more precisely than the live
	-- input viewers. Null for an open with no member present.
	viewer_id uuid references public.qorpera_runtime_office_viewers(id) on delete restrict,
	member_id uuid,
	opened_at timestamptz not null default clock_timestamp(),
	check((viewer_id is null)=(member_id is null)),
	check(opener<>'agent' or run_id is not null)
);
create index qorpera_runtime_office_browser_opens_screen on public.qorpera_runtime_office_browser_opens(screen_id,opened_at desc);
alter table public.qorpera_runtime_office_browser_opens enable row level security;
revoke all on public.qorpera_runtime_office_browser_opens from public,anon,authenticated,service_role;

-- p_opener null: a current check (egress relay, agent action). 'agent' or
-- 'desktop': the service is about to start the browser process; recorded.
create function public.qorpera_office_screen_browser_grant(p_binding jsonb,p_opener text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_profile_id uuid; v_grant_id uuid; v_grant_version bigint; v_company_owned boolean; v_leased boolean;
	v_viewer public.qorpera_runtime_office_viewers%rowtype; v_viewers uuid[]:='{}'; v_members uuid[]:='{}';
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
		exception when insufficient_privilege then null;
		end;
	end loop;
	-- The dock is pressed by whoever shares the desktop. It never starts a profile
	-- a member prepared privately (legacy member-lent grants outlive the company
	-- browser amendment), not even while the agent it was lent to holds the lease:
	-- only that agent's own run opens such a profile.
	if not (v_leased or (v_company_owned and cardinality(v_viewers)>0)) or (p_opener='agent' and not v_leased)
		or (p_opener='desktop' and not v_company_owned) then
		raise exception 'Browser authority unavailable' using errcode='42501'; end if;
	if p_opener is not null then
		if cardinality(v_viewers)=0 then
			insert into public.qorpera_runtime_office_browser_opens(office_id,screen_id,staff_agent_id,profile_id,grant_id,grant_version,opener,run_id)
			values(v_office.id,v_screen.id,v_screen.staff_agent_id,v_profile_id,v_grant_id,v_grant_version,p_opener,
				case when v_leased then v_screen.run_id end);
		else
			insert into public.qorpera_runtime_office_browser_opens(office_id,screen_id,staff_agent_id,profile_id,grant_id,grant_version,opener,run_id,viewer_id,member_id)
			select v_office.id,v_screen.id,v_screen.staff_agent_id,v_profile_id,v_grant_id,v_grant_version,p_opener,
				case when v_leased then v_screen.run_id end,viewer.id,viewer.member_id
			from unnest(v_viewers,v_members) as viewer(id,member_id);
		end if;
	end if;
	return jsonb_build_object('state','authorized','grant',jsonb_build_object('profileId',v_profile_id,'grantId',v_grant_id,'version',v_grant_version),
		'validForMs',5000);
end
$$;
revoke all on function public.qorpera_office_screen_browser_grant(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_office_screen_browser_grant(jsonb,text) to service_role;
