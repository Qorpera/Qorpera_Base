-- Browser consent is owned by the member, independently of subscriptions.
-- Sign-in suspends the entire shared office, including shell and capture.
alter table public.qorpera_runtime_offices
	add column privacy_state text not null default 'shared' check(privacy_state in ('shared','entering','private','leaving')),
	add column privacy_version bigint not null default 0 check(privacy_version between 0 and 9007199254740991),
	add column privacy_owner_membership_version bigint,
	add column privacy_challenge jsonb;

-- Separate membership incarnation: leaving and rejoining cannot restore old
-- browser consent or an old private-input channel. This trigger locks no
-- office/profile/grant rows, preserving admission's office-before-grant order.
create table public.qorpera_runtime_browser_membership_revocations (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	version bigint not null check(version between 1 and 9007199254740991),
	primary key(profile_id,user_id)
);
create function public.qorpera_revoke_browser_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if not exists(select 1 from public.qorpera_profiles where id=old.profile_id)
		or not exists(select 1 from auth.users where id=old.user_id) then return old; end if;
	insert into public.qorpera_runtime_browser_membership_revocations(profile_id,user_id,version) values(old.profile_id,old.user_id,1)
	on conflict(profile_id,user_id) do update set version=qorpera_runtime_browser_membership_revocations.version+1;
	return old;
end
$$;
create trigger qorpera_browser_membership_removed after delete on public.qorpera_profile_members
for each row execute function public.qorpera_revoke_browser_membership();

create table public.qorpera_runtime_browser_profiles (
	id uuid primary key,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	owner_user_id uuid not null references auth.users(id) on delete restrict,
	version bigint not null default 1 check(version between 1 and 9007199254740991),
	prepared boolean not null default false,
	verified_version bigint check(verified_version between 1 and version),
	-- Existing disks must use the separate, journaled adoption procedure.
	origin text not null default 'empty' check(origin='empty'),
	created_at timestamptz not null default clock_timestamp(),
	check(not prepared or coalesce(verified_version=version,false)),
	unique(id,office_id)
);
create table public.qorpera_runtime_browser_grants (
	id uuid not null unique default extensions.gen_random_uuid(),
	profile_id uuid not null,
	office_id uuid not null,
	staff_agent_id uuid not null,
	version bigint not null default 1 check(version between 1 and 9007199254740991),
	profile_version bigint not null,
	owner_membership_version bigint not null check(owner_membership_version between 0 and 9007199254740991),
	state text not null check(state in ('active','revoked')),
	configured_at timestamptz not null default clock_timestamp(),
	primary key(profile_id,staff_agent_id),
	foreign key(profile_id,office_id) references public.qorpera_runtime_browser_profiles(id,office_id) on delete restrict,
	foreign key(office_id,staff_agent_id) references public.qorpera_runtime_office_access(office_id,staff_agent_id) on delete restrict
);
-- A persistent profile has one physical context, and a screen one profile.
create unique index qorpera_browser_one_driver on public.qorpera_runtime_browser_grants(profile_id) where state='active';
create unique index qorpera_browser_one_profile on public.qorpera_runtime_browser_grants(office_id,staff_agent_id) where state='active';
create table public.qorpera_runtime_office_privacy_events (
	id uuid primary key default extensions.gen_random_uuid(),
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	version bigint not null,
	state text not null check(state in ('entering','private','leaving','shared')),
	challenge jsonb not null,
	created_at timestamptz not null default clock_timestamp(),
	unique(office_id,version,state)
);

-- Caller holds the office lock. Invalidate old drivers immediately, but retain
-- physical occupancy until the trusted supervisor acknowledges each challenge.
create function public.qorpera_fence_runtime_office_screens(p_office public.qorpera_runtime_offices,p_staff uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_screen public.qorpera_runtime_office_screens%rowtype; v_challenges jsonb:='[]';
begin
	for v_screen in update public.qorpera_runtime_office_screens set epoch=epoch+1,
		lease_id=null,run_id=null,lease_expires_at=null,grant_version=null,native_binding=null,
		drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null,
		takeover_user_id=null,touched_at=clock_timestamp()
		where office_id=p_office.id and (p_staff is null or staff_agent_id=p_staff) returning * loop
		update public.qorpera_runtime_office_resources set state='draining' where screen_id=v_screen.id and state='active';
		v_challenges:=v_challenges||jsonb_build_array(jsonb_build_object('state','draining','drainId',v_screen.drain_id,
			'epoch',v_screen.epoch,'binding',public.qorpera_runtime_office_scope(p_office)||jsonb_build_object(
				'computerGeneration',p_office.generation,'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,
				'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id)));
	end loop;
	select coalesce(jsonb_agg(value order by (value#>>'{binding,screenOrdinal}')::integer),'[]') into v_challenges
		from jsonb_array_elements(v_challenges);
	return v_challenges;
end
$$;

create function public.qorpera_register_runtime_browser_profile(p_scope jsonb,p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_profile public.qorpera_runtime_browser_profiles%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_profile_id is null then
		raise exception 'Browser owner required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.state<>'active'
		or v_office.privacy_state<>'shared' then raise exception 'Browser registration unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	if not found then raise exception 'Browser owner membership required' using errcode='42501'; end if;
	insert into public.qorpera_runtime_browser_profiles(id,office_id,owner_user_id) values(p_profile_id,v_office.id,auth.uid())
		on conflict(id) do nothing;
	select * into strict v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id for update;
	if v_profile.office_id<>v_office.id or v_profile.owner_user_id<>auth.uid() then
		raise exception 'Browser profile already bound' using errcode='42501'; end if;
	return jsonb_build_object('profileId',v_profile.id,'version',v_profile.version,'prepared',v_profile.prepared);
end
$$;

create function public.qorpera_set_runtime_browser_grant(p_scope jsonb,p_profile_id uuid,p_staff_agent_id uuid,
	p_profile_version bigint,p_expected_version bigint,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_profile public.qorpera_runtime_browser_profiles%rowtype;
	v_grant public.qorpera_runtime_browser_grants%rowtype; v_drains jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_enabled is null then
		raise exception 'Browser owner required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Browser office differs' using errcode='42501'; end if;
	select * into v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id and office_id=v_office.id for update;
	if not found or v_profile.owner_user_id<>auth.uid() then raise exception 'Browser owner required' using errcode='42501'; end if;
	if v_profile.version is distinct from p_profile_version then raise exception 'Browser profile changed' using errcode='40001'; end if;
	select * into v_grant from public.qorpera_runtime_browser_grants where profile_id=p_profile_id and staff_agent_id=p_staff_agent_id for update;
	if coalesce(v_grant.version,0) is distinct from p_expected_version then raise exception 'Browser grant changed' using errcode='40001'; end if;
	if p_enabled then
		perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
		if not found or v_office.state<>'active' or v_office.privacy_state<>'shared' or not v_profile.prepared
			or exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and (drain_pending or takeover_user_id is not null))
			or not exists(select 1 from public.qorpera_runtime_office_access where office_id=v_office.id and staff_agent_id=p_staff_agent_id and state='active')
			or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id and staff_agent_id=p_staff_agent_id and employment_status='active') then
			raise exception 'Browser grant unavailable' using errcode='42501'; end if;
	end if;
	insert into public.qorpera_runtime_browser_grants(profile_id,office_id,staff_agent_id,profile_version,owner_membership_version,state)
	values(p_profile_id,v_office.id,p_staff_agent_id,v_profile.version,coalesce((select version from public.qorpera_runtime_browser_membership_revocations
		where profile_id=v_office.profile_id and user_id=auth.uid()),0),case when p_enabled then 'active' else 'revoked' end)
	on conflict(profile_id,staff_agent_id) do update set version=qorpera_runtime_browser_grants.version+1,
		profile_version=excluded.profile_version,owner_membership_version=excluded.owner_membership_version,state=excluded.state,configured_at=clock_timestamp() returning * into v_grant;
	-- Even idle browser channels must close before a replacement starts.
	-- A private office is already fenced; do not replace its pending challenge.
	v_drains:=case when v_office.privacy_state='shared' then public.qorpera_fence_runtime_office_screens(v_office,p_staff_agent_id) else '[]'::jsonb end;
	update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
	return jsonb_build_object('profileId',v_profile.id,'grantId',v_grant.id,'version',v_grant.version,'state',v_grant.state,'drains',v_drains);
end
$$;

create function public.qorpera_request_runtime_office_privacy(p_scope jsonb,p_profile_id uuid,p_screen_id uuid,
	p_expected_version bigint,p_private boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_profile public.qorpera_runtime_browser_profiles%rowtype;
	v_challenge jsonb; v_drains jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_private is null then
		raise exception 'Browser owner required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.state<>'active' then
		raise exception 'Office privacy unavailable' using errcode='42501'; end if;
	if v_office.privacy_version is distinct from p_expected_version then raise exception 'Office privacy changed' using errcode='40001'; end if;
	select * into v_profile from public.qorpera_runtime_browser_profiles where id=p_profile_id and office_id=v_office.id for update;
	if not found or v_profile.owner_user_id<>auth.uid() then raise exception 'Browser owner required' using errcode='42501'; end if;
	if p_private then
		perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
		if not found or v_office.privacy_state<>'shared'
			or not exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and id=p_screen_id)
			or exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and (drain_pending or takeover_user_id is not null)) then
			raise exception 'Private sign-in unavailable' using errcode='42501'; end if;
		-- A changed login never revives prior consent. Exit requires a new grant.
		update public.qorpera_runtime_browser_profiles set version=version+1,prepared=false,verified_version=null where id=p_profile_id returning * into v_profile;
		update public.qorpera_runtime_browser_grants set state='revoked',version=version+1,configured_at=clock_timestamp()
			where profile_id=p_profile_id and state='active';
	else
		-- Cancellation is also a fresh drain; loss of membership cannot strand cleanup.
		if v_office.privacy_state not in ('entering','private')
			or v_office.privacy_challenge->>'profileId' is distinct from p_profile_id::text
			or v_office.privacy_challenge->>'memberId' is distinct from auth.uid()::text
			or v_office.privacy_challenge->>'screenId' is distinct from p_screen_id::text then
			raise exception 'Private sign-in differs' using errcode='42501'; end if;
	end if;
	v_drains:=public.qorpera_fence_runtime_office_screens(v_office);
	v_challenge:=jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,
		'challengeId',extensions.gen_random_uuid(),'version',v_office.privacy_version+1,
		'state',case when p_private then 'entering' else 'leaving' end,'memberId',auth.uid(),
		'profileId',p_profile_id,'profileVersion',v_profile.version,'screenId',p_screen_id,'drains',v_drains);
	update public.qorpera_runtime_offices set privacy_state=v_challenge->>'state',privacy_version=privacy_version+1,
		privacy_challenge=v_challenge,privacy_owner_membership_version=case when p_private then coalesce((select version from public.qorpera_runtime_browser_membership_revocations
			where profile_id=v_office.profile_id and user_id=auth.uid()),0) else privacy_owner_membership_version end,revision=revision+1 where id=v_office.id;
	insert into public.qorpera_runtime_office_privacy_events(office_id,version,state,challenge)
		values(v_office.id,v_office.privacy_version+1,v_challenge->>'state',v_challenge);
	return v_challenge;
end
$$;

-- Service acknowledgement attests closed viewer/capture channels and drained
-- work on EVERY screen. On exit it also attests private browser shutdown,
-- cleared held input/clipboard, and replacement of secret-bearing framebuffers.
-- It is never callable by a member, model, or guest process.
create function public.qorpera_ack_runtime_office_privacy(p_challenge jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_drain jsonb; v_screen public.qorpera_runtime_office_screens%rowtype; v_state text;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Privacy supervisor required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_challenge#>>'{scope,companyComputerId}')::uuid for update;
	if not found or p_challenge is distinct from v_office.privacy_challenge
		or p_challenge->'scope' is distinct from public.qorpera_runtime_office_scope(v_office)
		or (p_challenge->>'computerGeneration')::bigint is distinct from v_office.generation
		or v_office.state<>'active' then raise exception 'Privacy acknowledgement differs' using errcode='42501'; end if;
	v_state:=case p_challenge->>'state' when 'entering' then 'private' when 'leaving' then 'shared' end;
	if v_state is null then raise exception 'Invalid privacy challenge' using errcode='42501'; end if;
	if v_office.privacy_state=v_state then return jsonb_build_object('state',v_state,'version',v_office.privacy_version,'challengeId',p_challenge->'challengeId'); end if;
	if (select count(*) from public.qorpera_runtime_office_screens where office_id=v_office.id)<>jsonb_array_length(p_challenge->'drains') then
		raise exception 'Privacy screen inventory changed' using errcode='42501'; end if;
	for v_drain in select value from jsonb_array_elements(p_challenge->'drains') loop
		select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=(v_drain#>>'{binding,screenId}')::uuid for update;
		if not found or v_screen.drain_pending or v_screen.drain_acknowledged_at is null
			or v_screen.drain_id::text is distinct from v_drain->>'drainId'
			or v_screen.epoch is distinct from (v_drain->>'epoch')::bigint
			or v_screen.generation is distinct from (v_drain#>>'{binding,screenGeneration}')::bigint then
			raise exception 'Privacy drain unconfirmed' using errcode='42501'; end if;
	end loop;
	if v_state='private' then
		update public.qorpera_runtime_browser_profiles set verified_version=version where id=(p_challenge->>'profileId')::uuid
			and office_id=v_office.id and version=(p_challenge->>'profileVersion')::bigint;
		if not found then raise exception 'Browser profile changed during sign-in' using errcode='42501'; end if;
	else
		-- Cancellation before entry was acknowledged must not turn unknown
		-- existing disk state into an adopted/prepared browser profile.
		update public.qorpera_runtime_browser_profiles set prepared=coalesce(verified_version=version,false) where id=(p_challenge->>'profileId')::uuid
			and office_id=v_office.id and version=(p_challenge->>'profileVersion')::bigint;
		if not found then raise exception 'Browser profile changed during sign-in' using errcode='42501'; end if;
	end if;
	update public.qorpera_runtime_offices set privacy_state=v_state,revision=revision+1 where id=v_office.id;
	insert into public.qorpera_runtime_office_privacy_events(office_id,version,state,challenge)
		values(v_office.id,v_office.privacy_version,v_state,p_challenge);
	return jsonb_build_object('state',v_state,'version',v_office.privacy_version,'challengeId',p_challenge->'challengeId');
end
$$;

-- All native actions (including shell, replay results and screenshots) pass
-- this interlock. No lower-level screen function remains externally callable.
alter function public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb) rename to qorpera_native_office_screen_v2;
revoke all on function public.qorpera_native_office_screen_v2(jsonb,jsonb,text,jsonb) from public,anon,authenticated,service_role;
create function public.qorpera_native_office_screen(p_binding jsonb,p_scope jsonb,p_action text,p_lease jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office runtime required' using errcode='42501'; end if;
	if p_action is distinct from 'release' then
		perform public.qorpera_describe_native_tool_authority(p_binding);
		select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
		if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.privacy_state<>'shared' then
			raise exception 'Office is private' using errcode='42501'; end if;
	end if;
	return public.qorpera_native_office_screen_v2(p_binding,p_scope,p_action,p_lease);
end
$$;

-- Ordinary takeover may not cancel or replace a private sign-in challenge.
alter function public.qorpera_request_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,boolean) rename to qorpera_request_runtime_office_drain_v1;
revoke all on function public.qorpera_request_runtime_office_drain_v1(jsonb,uuid,bigint,bigint,bigint,boolean) from public,anon,authenticated,service_role;
create function public.qorpera_request_runtime_office_drain(p_scope jsonb,p_screen_id uuid,p_computer_generation bigint,
	p_screen_generation bigint,p_epoch bigint,p_takeover boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	perform 1 from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid and privacy_state='shared' for update;
	if not found then raise exception 'Office is private' using errcode='42501'; end if;
	return public.qorpera_request_runtime_office_drain_v1(p_scope,p_screen_id,p_computer_generation,p_screen_generation,p_epoch,p_takeover);
end
$$;

create or replace function public.qorpera_native_office_descriptor(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
	v_grant public.qorpera_runtime_browser_grants%rowtype; v_resources jsonb; v_caps jsonb;
begin
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	if auth.role() is distinct from 'service_role' or v_authority#>>'{identity,audienceKind}' is distinct from 'company' then
		raise exception 'Shared office requires company authority' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and profile_id=(v_authority#>>'{identity,companyId}')::uuid and state='active' for share;
	if not found or v_office.privacy_state<>'shared' then return '{"state":"unavailable"}'::jsonb; end if;
	select * into v_access from public.qorpera_runtime_office_access where office_id=v_office.id
		and staff_agent_id=(v_authority#>>'{identity,staffAgentId}')::uuid and state='active' for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	v_resources:=jsonb_build_object('officeGrantId',v_access.grant_id,'officeGrantVersion',v_access.version,'officePrivacyVersion',v_office.privacy_version);
	v_caps:=v_access.capabilities;
	select g.* into v_grant from public.qorpera_runtime_browser_grants g
		join public.qorpera_runtime_browser_profiles p on p.id=g.profile_id and p.office_id=g.office_id
		join public.qorpera_profile_members m on m.profile_id=v_office.profile_id and m.user_id=p.owner_user_id
		where g.office_id=v_office.id and g.staff_agent_id=v_access.staff_agent_id and g.state='active'
		and p.prepared and g.profile_version=p.version
		and g.owner_membership_version=coalesce((select version from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id and user_id=p.owner_user_id),0)
		for share of g,p,m;
	if found then
		v_resources:=v_resources||jsonb_build_object('browserProfileId',v_grant.profile_id,'browserGrantId',v_grant.id,'browserGrantVersion',v_grant.version);
		v_caps:=v_caps||'["browser"]'::jsonb;
	end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','available','scope',public.qorpera_runtime_office_scope(v_office),'capabilities',v_caps,'resources',v_resources);
end
$$;

create function public.qorpera_native_office_browser_grant(p_binding jsonb,p_scope jsonb,p_lease jsonb,p_grant jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_descriptor jsonb;
begin
	perform public.qorpera_native_office_screen(p_binding,p_scope,'check',p_lease);
	v_descriptor:=public.qorpera_native_office_descriptor(p_binding);
	if v_descriptor->>'state' is distinct from 'available' or not (v_descriptor->'capabilities' ? 'browser')
		or v_descriptor->'scope' is distinct from p_scope or p_grant is distinct from jsonb_build_object(
			'profileId',v_descriptor#>'{resources,browserProfileId}','grantId',v_descriptor#>'{resources,browserGrantId}',
			'version',v_descriptor#>'{resources,browserGrantVersion}') then
		raise exception 'Browser grant unavailable' using errcode='42501'; end if;
	return '{"state":"authorized"}'::jsonb;
end
$$;

-- This is a current check, not a reusable viewer capability. The private
-- channel must bind to the authenticated owner and recheck before every input.
create function public.qorpera_check_runtime_office_private_access(p_challenge jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'Sign-in owner required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_challenge#>>'{scope,companyComputerId}')::uuid for share;
	if not found or v_office.state<>'active' or v_office.privacy_state<>'private'
		or p_challenge is distinct from v_office.privacy_challenge or p_challenge->>'memberId' is distinct from auth.uid()::text
		or p_challenge->'scope' is distinct from public.qorpera_runtime_office_scope(v_office)
		or (p_challenge->>'computerGeneration')::bigint is distinct from v_office.generation then
		raise exception 'Private input unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	if not found then raise exception 'Sign-in owner membership required' using errcode='42501'; end if;
	if v_office.privacy_owner_membership_version is distinct from coalesce((select version from public.qorpera_runtime_browser_membership_revocations
		where profile_id=v_office.profile_id and user_id=auth.uid()),0) then raise exception 'Sign-in owner membership changed' using errcode='42501'; end if;
	return jsonb_build_object('state','authorized','version',v_office.privacy_version,'validForMs',5000);
end
$$;

-- Recover a lost transition response without issuing another transition. The
-- owner can retrieve cleanup metadata after membership removal; nobody gains
-- private input or profile data from this read.
create function public.qorpera_runtime_office_privacy_status(p_scope jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_owner boolean;
begin
	if auth.role() is distinct from 'service_role' and (auth.role() is distinct from 'authenticated' or auth.uid() is null) then
		raise exception 'Office reader required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for share;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then raise exception 'Office scope differs' using errcode='42501'; end if;
	v_owner:=coalesce(v_office.privacy_challenge->>'memberId'=auth.uid()::text,false);
	if auth.role()<>'service_role' and not v_owner and not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()) then
		raise exception 'Office reader required' using errcode='42501'; end if;
	return jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,'state',v_office.privacy_state,
		'version',v_office.privacy_version,'challenge',case when v_owner or auth.role()='service_role' then v_office.privacy_challenge else null end);
end
$$;

alter table public.qorpera_runtime_browser_profiles enable row level security;
alter table public.qorpera_runtime_browser_membership_revocations enable row level security;
alter table public.qorpera_runtime_browser_grants enable row level security;
alter table public.qorpera_runtime_office_privacy_events enable row level security;
revoke all on public.qorpera_runtime_browser_profiles,public.qorpera_runtime_browser_membership_revocations,public.qorpera_runtime_browser_grants,public.qorpera_runtime_office_privacy_events from public,anon,authenticated,service_role;
revoke all on function public.qorpera_fence_runtime_office_screens(public.qorpera_runtime_offices,uuid),
	public.qorpera_revoke_browser_membership(),
	public.qorpera_register_runtime_browser_profile(jsonb,uuid),public.qorpera_set_runtime_browser_grant(jsonb,uuid,uuid,bigint,bigint,boolean),
	public.qorpera_request_runtime_office_privacy(jsonb,uuid,uuid,bigint,boolean),public.qorpera_ack_runtime_office_privacy(jsonb),
	public.qorpera_check_runtime_office_private_access(jsonb),
	public.qorpera_runtime_office_privacy_status(jsonb),
	public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb),public.qorpera_native_office_browser_grant(jsonb,jsonb,jsonb,jsonb),
	public.qorpera_request_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,boolean) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_register_runtime_browser_profile(jsonb,uuid),public.qorpera_set_runtime_browser_grant(jsonb,uuid,uuid,bigint,bigint,boolean),
	public.qorpera_request_runtime_office_privacy(jsonb,uuid,uuid,bigint,boolean),
	public.qorpera_check_runtime_office_private_access(jsonb),
	public.qorpera_runtime_office_privacy_status(jsonb),
	public.qorpera_request_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,boolean) to authenticated;
grant execute on function public.qorpera_runtime_office_privacy_status(jsonb),public.qorpera_ack_runtime_office_privacy(jsonb),public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb),
	public.qorpera_native_office_browser_grant(jsonb,jsonb,jsonb,jsonb) to service_role;
