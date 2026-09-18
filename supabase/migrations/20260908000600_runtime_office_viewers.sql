-- Durable member viewing and control. A view ticket is not a native/provider
-- credential; it is single-use, short-lived and bound to the exact desktop.
create table public.qorpera_runtime_office_viewers (
	id uuid primary key default extensions.gen_random_uuid(),
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	screen_id uuid not null references public.qorpera_runtime_office_screens(id) on delete restrict,
	member_id uuid not null references auth.users(id) on delete restrict,
	membership_version bigint not null check(membership_version between 0 and 9007199254740991),
	binding jsonb not null,
	screen_epoch bigint not null,
	privacy_version bigint not null,
	private_sign_in jsonb,
	mode text not null check(mode in ('watch','control')),
	control_lease_id uuid,
	capability_sha256 text not null unique check(capability_sha256 ~ '^[0-9a-f]{64}$'),
	state text not null default 'issued' check(state in ('issued','active','draining','ended')),
	issued_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	absolute_deadline timestamptz not null,
	redeemed_at timestamptz,
	ended_at timestamptz,
	last_sequence bigint not null default 0 check(last_sequence between 0 and 9007199254740991),
	check((mode='control')=(control_lease_id is not null)),
	check(private_sign_in is null or mode='control'),
	check((state='ended')=(ended_at is not null))
);
-- Expiry or a closed socket does not prove that held input was released.
create unique index qorpera_runtime_office_one_member_driver on public.qorpera_runtime_office_viewers(screen_id)
	where mode='control' and state<>'ended';
create index qorpera_runtime_office_live_viewers on public.qorpera_runtime_office_viewers(office_id,member_id) where state<>'ended';

create table public.qorpera_runtime_office_viewer_inputs (
	id uuid primary key default extensions.gen_random_uuid(),
	viewer_id uuid not null references public.qorpera_runtime_office_viewers(id) on delete restrict,
	sequence bigint not null check(sequence between 1 and 9007199254740991),
	-- A per-connection keyed commitment. Never store raw keys, their unhashed
	-- digest (individual key codes are enumerable), clipboard or private pixels.
	input_commitment text not null check(input_commitment ~ '^[0-9a-f]{64}$'),
	admitted_at timestamptz not null default clock_timestamp(),
	unique(viewer_id,sequence)
);

create function public.qorpera_runtime_office_viewer_grant(p_viewer public.qorpera_runtime_office_viewers)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_result jsonb; v_ms bigint:=least(30000,greatest(0,floor(extract(epoch from(p_viewer.expires_at-clock_timestamp()))*1000)::bigint));
begin
	v_result:=jsonb_build_object('binding',p_viewer.binding,'viewerSessionId',p_viewer.id,'memberId',p_viewer.member_id,
		'mode',p_viewer.mode,'screenEpoch',p_viewer.screen_epoch,'privacyVersion',p_viewer.privacy_version,'validForMs',v_ms);
	if p_viewer.mode='control' then
		v_result:=v_result||jsonb_build_object('lease',jsonb_build_object('binding',p_viewer.binding,'leaseId',p_viewer.control_lease_id,
			'epoch',p_viewer.screen_epoch,'driver',jsonb_build_object('kind','member','memberId',p_viewer.member_id,'sessionId',p_viewer.id),'validForMs',v_ms));
	end if;
	if p_viewer.private_sign_in is not null then v_result:=v_result||jsonb_build_object('privateSignIn',p_viewer.private_sign_in); end if;
	return v_result;
end
$$;
create function public.qorpera_runtime_office_viewer_identity(p_grant jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select (p_grant-'validForMs')||case when p_grant ? 'lease' then jsonb_build_object('lease',(p_grant->'lease')-'validForMs') else '{}'::jsonb end
$$;

-- Caller holds office, then screen/viewer locks. Membership SHARE prevents
-- removal from racing a grant. Its incarnation also rejects removal/rejoin.
create function public.qorpera_assert_runtime_office_viewer(p_viewer public.qorpera_runtime_office_viewers,
	p_office public.qorpera_runtime_offices,p_screen public.qorpera_runtime_office_screens)
returns void language plpgsql security definer set search_path = '' as $$
declare v_member_role public.qorpera_profile_role;
begin
	select role into v_member_role from public.qorpera_profile_members where profile_id=p_office.profile_id and user_id=p_viewer.member_id for share;
	if not found or p_viewer.membership_version<>coalesce((select version from public.qorpera_runtime_browser_membership_revocations
		where profile_id=p_office.profile_id and user_id=p_viewer.member_id),0)
		or p_office.state<>'active' or p_viewer.office_id<>p_office.id or p_screen.office_id is distinct from p_office.id
		or p_screen.id is distinct from p_viewer.screen_id or p_screen.power<>'open' or p_screen.drain_pending
		or p_viewer.privacy_version<>p_office.privacy_version or p_viewer.state not in ('issued','active')
		or p_viewer.expires_at<=clock_timestamp() or p_viewer.absolute_deadline<=clock_timestamp()
		or p_viewer.binding is distinct from public.qorpera_runtime_office_scope(p_office)||jsonb_build_object(
			'computerGeneration',p_office.generation,'screenId',p_screen.id,'screenOrdinal',p_screen.ordinal,
			'screenGeneration',p_screen.generation,'staffAgentId',p_screen.staff_agent_id)
		or not exists(select 1 from public.qorpera_logical_computers c where c.id=p_office.logical_computer_id
			and c.status='active' and public.qorpera_runtime_office_matches(c)) then
		raise exception 'Office viewer authority unavailable' using errcode='42501'; end if;
	if p_viewer.private_sign_in is not null then
		if p_office.privacy_state<>'private' or p_viewer.mode<>'control'
			or p_office.privacy_challenge->>'memberId' is distinct from p_viewer.member_id::text
			or p_office.privacy_challenge->>'screenId' is distinct from p_screen.id::text
			or p_office.privacy_owner_membership_version is distinct from p_viewer.membership_version
			or p_viewer.private_sign_in is distinct from jsonb_build_object('challengeId',p_office.privacy_challenge->'challengeId',
				'profileId',p_office.privacy_challenge->'profileId','profileVersion',p_office.privacy_challenge->'profileVersion') then
			raise exception 'Private viewer authority unavailable' using errcode='42501'; end if;
	elsif p_office.privacy_state<>'shared' or (p_viewer.mode='control' and
		(v_member_role not in ('owner','admin') or p_screen.takeover_user_id is distinct from p_viewer.member_id)) then
		raise exception 'Office viewer mode unavailable' using errcode='42501';
	end if;
	if p_viewer.mode='control' and (p_screen.epoch<>p_viewer.screen_epoch or p_screen.lease_id is not null) then
		raise exception 'Office member driver changed' using errcode='42501'; end if;
end
$$;

create function public.qorpera_create_runtime_office_viewer(p_binding jsonb,p_epoch bigint,p_mode text default 'watch',p_private_challenge jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_viewer public.qorpera_runtime_office_viewers%rowtype; v_token text:=translate(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+/','-_');
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_mode is null or p_mode not in ('watch','control') then
		raise exception 'Member viewer authority required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_binding->>'companyComputerId')::uuid for update;
	if not found then raise exception 'Office unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=(p_binding->>'screenId')::uuid for update;
	if not found or v_screen.epoch is distinct from p_epoch then raise exception 'Office screen changed' using errcode='40001'; end if;
	if p_private_challenge is not null then
		perform public.qorpera_check_runtime_office_private_access(p_private_challenge);
		if p_mode<>'control' or p_private_challenge->>'screenId' is distinct from v_screen.id::text then
			raise exception 'Private screen differs' using errcode='42501'; end if;
	end if;
	v_viewer.id:=extensions.gen_random_uuid(); v_viewer.office_id:=v_office.id; v_viewer.screen_id:=v_screen.id;
	v_viewer.member_id:=auth.uid(); v_viewer.binding:=p_binding; v_viewer.mode:=p_mode;
	v_viewer.membership_version:=coalesce((select version from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id and user_id=auth.uid()),0);
	v_viewer.screen_epoch:=v_screen.epoch; v_viewer.privacy_version:=v_office.privacy_version; v_viewer.state:='issued';
	v_viewer.expires_at:=clock_timestamp()+interval '30 seconds'; v_viewer.absolute_deadline:=clock_timestamp()+interval '1 hour';
	v_viewer.capability_sha256:=encode(extensions.digest(v_token,'sha256'),'hex');
	v_viewer.control_lease_id:=case when p_mode='control' then extensions.gen_random_uuid() else null end;
	v_viewer.private_sign_in:=case when p_private_challenge is not null then jsonb_build_object('challengeId',p_private_challenge->'challengeId',
		'profileId',p_private_challenge->'profileId','profileVersion',p_private_challenge->'profileVersion') else null end;
	perform public.qorpera_assert_runtime_office_viewer(v_viewer,v_office,v_screen);
	if (select count(*) from public.qorpera_runtime_office_viewers where office_id=v_office.id and state in ('issued','active') and expires_at>clock_timestamp())>=32
		or (select count(*) from public.qorpera_runtime_office_viewers where office_id=v_office.id and member_id=auth.uid() and issued_at>clock_timestamp()-interval '1 minute')>=60 then
		return '{"state":"refused","reason":"VIEWER_CAPACITY_EXHAUSTED"}'::jsonb; end if;
	if p_mode='control' and exists(select 1 from public.qorpera_runtime_office_viewers where screen_id=v_screen.id and mode='control' and state<>'ended') then
		return '{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb; end if;
	insert into public.qorpera_runtime_office_viewers(id,office_id,screen_id,member_id,membership_version,binding,screen_epoch,
		privacy_version,private_sign_in,mode,control_lease_id,capability_sha256,expires_at,absolute_deadline)
	values(v_viewer.id,v_viewer.office_id,v_viewer.screen_id,v_viewer.member_id,v_viewer.membership_version,v_viewer.binding,v_viewer.screen_epoch,
		v_viewer.privacy_version,v_viewer.private_sign_in,v_viewer.mode,v_viewer.control_lease_id,v_viewer.capability_sha256,v_viewer.expires_at,v_viewer.absolute_deadline)
	returning * into v_viewer;
	return jsonb_build_object('state','issued','capability',v_token,'grant',public.qorpera_runtime_office_viewer_grant(v_viewer));
end
$$;

create function public.qorpera_redeem_runtime_office_viewer(p_scope jsonb,p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype; v_viewer public.qorpera_runtime_office_viewers%rowtype;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Viewer gateway required' using errcode='42501'; end if;
	select * into v_viewer from public.qorpera_runtime_office_viewers where capability_sha256=p_capability_sha256;
	if not found then raise exception 'Viewer ticket unavailable' using errcode='42501'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_viewer.office_id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then raise exception 'Viewer office differs' using errcode='42501'; end if;
	select * into strict v_screen from public.qorpera_runtime_office_screens where id=v_viewer.screen_id for update;
	select * into strict v_viewer from public.qorpera_runtime_office_viewers where id=v_viewer.id for update;
	if v_viewer.state<>'issued' or v_viewer.redeemed_at is not null then raise exception 'Viewer ticket consumed' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_viewer(v_viewer,v_office,v_screen);
	update public.qorpera_runtime_office_viewers set state='active',redeemed_at=clock_timestamp(),
		expires_at=least(absolute_deadline,clock_timestamp()+interval '30 seconds') where id=v_viewer.id returning * into v_viewer;
	return public.qorpera_runtime_office_viewer_grant(v_viewer);
end
$$;

create function public.qorpera_check_runtime_office_viewer(p_grant jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype; v_viewer public.qorpera_runtime_office_viewers%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Viewer gateway required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_grant#>>'{binding,companyComputerId}')::uuid for update;
	if not found then raise exception 'Office unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=(p_grant#>>'{binding,screenId}')::uuid for update;
	select * into v_viewer from public.qorpera_runtime_office_viewers where id=(p_grant->>'viewerSessionId')::uuid and office_id=v_office.id for update;
	if not found or v_viewer.state<>'active' or public.qorpera_runtime_office_viewer_identity(p_grant) is distinct from
		public.qorpera_runtime_office_viewer_identity(public.qorpera_runtime_office_viewer_grant(v_viewer)) then
		raise exception 'Viewer identity differs' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_viewer(v_viewer,v_office,v_screen);
	update public.qorpera_runtime_office_viewers set expires_at=least(absolute_deadline,clock_timestamp()+interval '30 seconds') where id=v_viewer.id returning * into v_viewer;
	return public.qorpera_runtime_office_viewer_grant(v_viewer);
end
$$;

create function public.qorpera_admit_runtime_office_viewer_input(p_grant jsonb,p_sequence bigint,p_input_commitment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_grant jsonb; v_viewer public.qorpera_runtime_office_viewers%rowtype; v_id uuid;
begin
	v_grant:=public.qorpera_check_runtime_office_viewer(p_grant);
	if p_grant->>'mode' is distinct from 'control' or p_sequence is null or p_sequence<1 or coalesce(p_input_commitment,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Member input unavailable' using errcode='42501'; end if;
	select * into strict v_viewer from public.qorpera_runtime_office_viewers where id=(p_grant->>'viewerSessionId')::uuid for update;
	if p_sequence<>v_viewer.last_sequence+1 then raise exception 'Viewer input already consumed or out of order' using errcode='55000'; end if;
	insert into public.qorpera_runtime_office_viewer_inputs(viewer_id,sequence,input_commitment) values(v_viewer.id,p_sequence,p_input_commitment) returning id into v_id;
	update public.qorpera_runtime_office_viewers set last_sequence=p_sequence where id=v_viewer.id;
	return jsonb_build_object('state','admitted','inputId',v_id,'validForMs',least(5000,(v_grant->>'validForMs')::bigint));
end
$$;

create function public.qorpera_release_runtime_office_viewer(p_grant jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screen public.qorpera_runtime_office_screens%rowtype;
	v_viewer public.qorpera_runtime_office_viewers%rowtype; v_drains jsonb;
begin
	-- Authenticated callers can reach this only through the exact-owner cancel
	-- wrapper. This entrypoint remains executable only by the service role.
	if auth.role() not in ('service_role','authenticated') or auth.role() is null then
		raise exception 'Viewer cleanup authority required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_grant#>>'{binding,companyComputerId}')::uuid for update;
	if not found then raise exception 'Office unavailable' using errcode='42501'; end if;
	select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id and id=(p_grant#>>'{binding,screenId}')::uuid for update;
	select * into v_viewer from public.qorpera_runtime_office_viewers where id=(p_grant->>'viewerSessionId')::uuid and office_id=v_office.id for update;
	if not found or (auth.role()='authenticated' and (auth.uid() is null or auth.uid()<>v_viewer.member_id))
		or public.qorpera_runtime_office_viewer_identity(p_grant) is distinct from
		public.qorpera_runtime_office_viewer_identity(public.qorpera_runtime_office_viewer_grant(v_viewer)) then
		raise exception 'Viewer cleanup differs' using errcode='42501'; end if;
	if v_viewer.state='ended' then return '{"state":"released"}'::jsonb; end if;
	if v_viewer.mode='watch' then
		update public.qorpera_runtime_office_viewers set state='ended',ended_at=clock_timestamp() where id=v_viewer.id;
	else
		update public.qorpera_runtime_office_viewers set state='draining' where id=v_viewer.id;
		-- Never replace a newer privacy/takeover challenge or a new driver.
		if v_screen.epoch=v_viewer.screen_epoch and v_office.privacy_version=v_viewer.privacy_version
			and not v_screen.drain_pending and v_screen.generation=(v_viewer.binding->>'screenGeneration')::bigint
			and v_office.generation=(v_viewer.binding->>'computerGeneration')::bigint then
			v_drains:=public.qorpera_fence_runtime_office_screens(v_office,v_screen.staff_agent_id);
			update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
		end if;
	end if;
	return '{"state":"released"}'::jsonb;
end
$$;

-- Only the physical drain acknowledgement reaps member control occupancy.
alter function public.qorpera_ack_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,uuid) rename to qorpera_ack_runtime_office_drain_v1;
revoke all on function public.qorpera_ack_runtime_office_drain_v1(jsonb,uuid,bigint,bigint,bigint,uuid) from public,anon,authenticated,service_role;
create function public.qorpera_ack_runtime_office_drain(p_scope jsonb,p_screen_id uuid,p_computer_generation bigint,
	p_screen_generation bigint,p_epoch bigint,p_drain_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
	v_result:=public.qorpera_ack_runtime_office_drain_v1(p_scope,p_screen_id,p_computer_generation,p_screen_generation,p_epoch,p_drain_id);
	update public.qorpera_runtime_office_viewers set state='ended',ended_at=clock_timestamp()
		where office_id=(p_scope->>'companyComputerId')::uuid and screen_id=p_screen_id and state<>'ended'
		and ((binding->>'computerGeneration')::bigint<p_computer_generation
			or ((binding->>'computerGeneration')::bigint=p_computer_generation and ((binding->>'screenGeneration')::bigint<p_screen_generation
				or ((binding->>'screenGeneration')::bigint=p_screen_generation and screen_epoch<p_epoch))));
	return v_result;
end
$$;

alter table public.qorpera_runtime_office_viewers enable row level security;
alter table public.qorpera_runtime_office_viewer_inputs enable row level security;
revoke all on public.qorpera_runtime_office_viewers,public.qorpera_runtime_office_viewer_inputs from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_office_viewer_grant(public.qorpera_runtime_office_viewers),public.qorpera_runtime_office_viewer_identity(jsonb),
	public.qorpera_assert_runtime_office_viewer(public.qorpera_runtime_office_viewers,public.qorpera_runtime_offices,public.qorpera_runtime_office_screens),
	public.qorpera_create_runtime_office_viewer(jsonb,bigint,text,jsonb),public.qorpera_redeem_runtime_office_viewer(jsonb,text),
	public.qorpera_check_runtime_office_viewer(jsonb),public.qorpera_admit_runtime_office_viewer_input(jsonb,bigint,text),
	public.qorpera_release_runtime_office_viewer(jsonb),public.qorpera_ack_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,uuid)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_create_runtime_office_viewer(jsonb,bigint,text,jsonb) to authenticated;
grant execute on function public.qorpera_redeem_runtime_office_viewer(jsonb,text),public.qorpera_check_runtime_office_viewer(jsonb),
	public.qorpera_admit_runtime_office_viewer_input(jsonb,bigint,text),public.qorpera_release_runtime_office_viewer(jsonb),
	public.qorpera_ack_runtime_office_drain(jsonb,uuid,bigint,bigint,bigint,uuid) to service_role;
