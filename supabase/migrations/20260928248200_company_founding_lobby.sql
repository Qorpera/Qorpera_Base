-- The founding lobby: a founding team starts one company together as equal owners.
--
-- The table is a real company row (so each founder can connect their own model login to it:
-- qorpera_eligible_member_accounts needs a member row on this profile), but nothing else exists
-- until Start: no Company File, no seed, no Co-Founder, no wake. No agent can run during the lobby.
--
-- Seats, invitations and Ready are member data and live here. The company itself does not:
-- at Start the vision draft and the founders' roles are moved into the seed input that C2's
-- folder-v2 creation commit writes as vision/vision.md and the Co-Founder's first todo (contract
-- 5.6). After Start this lobby keeps only who started it, when, and at which table revision.
--
-- No billing: no payment gate before Start (a company gets its first computer hours free).

-- C2's halves of folder-v2 creation. Inert until C2 replaces the bodies (create or replace), the
-- same way C1b left the structured-file hook for F2. Service-only.
-- open: a fresh company row, its environment and the creator as owner, on folder-v2, with no old
-- setup chain (no bootstrap job) and no seed; repeat-safe per (user, creation id), and it must not rely on
-- `insert ... on conflict do nothing` for the owner row of an open table (the member guard below
-- fires before conflict arbitration). seed: the one creation commit, from the seed input.
create function public.qorpera_folder_company_open(p_user_id uuid,p_client_creation_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	raise exception 'folder company creation is not available yet' using errcode = '0A000';
end $$;
create function public.qorpera_folder_company_seed(p_profile_id uuid,p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
	raise exception 'folder company creation is not available yet' using errcode = '0A000';
end $$;
-- A started table's company is ready to open once C2's creation commit and its follow-ups landed.
create function public.qorpera_folder_company_ready(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select false
$$;
-- Tables open, and start, only when this is true; C5's switch to folder-v2 creation turns it on.
create function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select false
$$;
revoke all on function public.qorpera_folder_company_open(uuid,uuid,text),
	public.qorpera_folder_company_seed(uuid,jsonb),public.qorpera_folder_company_ready(uuid)
	from public,anon,authenticated,service_role;
revoke all on function public.qorpera_company_founding_available() from public,anon;
grant execute on function public.qorpera_company_founding_available() to authenticated;

create table public.qorpera_company_foundings (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	created_by_user_id uuid not null references auth.users(id) on delete cascade,
	phase text not null default 'open' check (phase in ('open','started')),
	-- Every change a founder agreed to (name, vision, a role, who sits at the table) moves the
	-- revision. Ready is a seat's ready_revision equal to it, so any change clears every Ready.
	revision bigint not null default 1 check (revision > 0),
	-- A draft until Start moves it into the seed input; never company state after that.
	vision_draft text check (vision_draft is null or octet_length(vision_draft) <= 16384),
	created_at timestamptz not null default clock_timestamp(),
	started_at timestamptz,
	started_by_user_id uuid references auth.users(id) on delete set null,
	started_revision bigint,
	start_client_id uuid,
	check ((phase = 'open') = (started_at is null)),
	check (phase = 'open' or (vision_draft is null and started_revision is not null and start_client_id is not null)),
	check (phase = 'started' or vision_draft is not null)
);
create table public.qorpera_company_founder_seats (
	profile_id uuid not null references public.qorpera_company_foundings(profile_id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	invited_by_user_id uuid references auth.users(id) on delete set null,
	state text not null check (state in ('invited','joined')),
	-- Optional prose; moved into the seed input at Start.
	role_text text not null default '' check (char_length(role_text) <= 300),
	ready_revision bigint check (ready_revision > 0),
	invited_at timestamptz not null default clock_timestamp(),
	joined_at timestamptz,
	primary key (profile_id,user_id),
	check ((state = 'joined') = (joined_at is not null)),
	check (ready_revision is null or state = 'joined')
);
create index qorpera_company_founder_seats_user on public.qorpera_company_founder_seats(user_id,state);
alter table public.qorpera_company_foundings enable row level security;
alter table public.qorpera_company_founder_seats enable row level security;
revoke all on public.qorpera_company_foundings,public.qorpera_company_founder_seats
	from public,anon,authenticated,service_role;

create function public.qorpera_company_founding_open(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists(select 1 from public.qorpera_company_foundings where profile_id = p_profile_id and phase = 'open')
$$;
revoke all on function public.qorpera_company_founding_open(uuid) from public,anon,authenticated,service_role;

-- While the table is open, people join only by taking a seat (friends only), and roles change
-- only at Start. With the invitation guard below, this closes the email-invitation and role
-- routes around the lobby.
create function public.qorpera_founding_member_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if not public.qorpera_company_founding_open(new.profile_id) then return new; end if;
	if tg_op = 'INSERT' then
		if not exists(select 1 from public.qorpera_company_founder_seats where profile_id = new.profile_id
			and user_id = new.user_id and state = 'joined') or new.role <> 'contributor' then
			raise exception 'People join a company being founded by taking a seat at its table' using errcode = '42501';
		end if;
	elsif new.role is distinct from old.role then
		raise exception 'Roles change when the founders press Start' using errcode = '42501';
	end if;
	return new;
end $$;
create trigger qorpera_founding_member_guard before insert or update of role on public.qorpera_profile_members
	for each row execute function public.qorpera_founding_member_guard();

create function public.qorpera_founding_invitation_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if public.qorpera_company_founding_open(new.profile_id) then
		raise exception 'Invite co-founders from the founding table' using errcode = '42501'; end if;
	return new;
end $$;
create trigger qorpera_founding_invitation_guard before insert on public.qorpera_profile_invitations
	for each row execute function public.qorpera_founding_invitation_guard();

-- A founder who leaves or is removed gives up the seat, before or after Start. While the table is
-- open the table changes for everyone, and invitations they sent are withdrawn (invitees are
-- friends of the one who invited them).
create function public.qorpera_founding_member_left()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	delete from public.qorpera_company_founder_seats where profile_id = old.profile_id and user_id = old.user_id
		and state = 'joined';
	-- Only seat holders are members of an open table. When an account is deleted, its seat may be
	-- gone before this row; the table has changed all the same.
	if public.qorpera_company_founding_open(old.profile_id) then
		-- Pending invitations the leaver sent go with them (a deleted account's are already unsigned).
		delete from public.qorpera_company_founder_seats where profile_id = old.profile_id
			and state = 'invited' and (invited_by_user_id = old.user_id or invited_by_user_id is null);
		update public.qorpera_company_foundings set revision = revision+1 where profile_id = old.profile_id;
	end if;
	return old;
end $$;
create trigger qorpera_founding_member_left after delete on public.qorpera_profile_members
	for each row execute function public.qorpera_founding_member_left();
revoke all on function public.qorpera_founding_member_guard(),public.qorpera_founding_member_left(),
	public.qorpera_founding_invitation_guard() from public,anon,authenticated,service_role;

create function public.qorpera_company_founding_json(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype; v_seats jsonb; v_me public.qorpera_company_founder_seats%rowtype;
	v_waiting jsonb;
begin
	select * into strict v_f from public.qorpera_company_foundings where profile_id = p_profile_id;
	select * into v_me from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = auth.uid();
	select coalesce(jsonb_agg(jsonb_build_object('userId',seat.user_id,
		'displayName',left(public.qorpera_account_display_name(account.raw_user_meta_data),160),
		'state',seat.state,'role',seat.role_text,'invitedByUserId',seat.invited_by_user_id,
		'ready',seat.ready_revision is not distinct from v_f.revision and v_f.phase = 'open',
		'modelLoginReady',seat.state = 'joined' and exists(
			select 1 from public.qorpera_eligible_member_accounts(p_profile_id,seat.user_id)),
		'creator',seat.user_id = v_f.created_by_user_id)
		order by seat.joined_at nulls last,seat.invited_at,seat.user_id),'[]'::jsonb) into v_seats
	from public.qorpera_company_founder_seats seat join auth.users account on account.id = seat.user_id
	where seat.profile_id = p_profile_id;
	-- Joined founders Start still waits for: not Ready at this revision, or no usable login.
	select coalesce(jsonb_agg(seat -> 'userId' order by ordinality),'[]'::jsonb) into v_waiting
	from jsonb_array_elements(v_seats) with ordinality as entry(seat,ordinality)
	where seat ->> 'state' = 'joined' and not ((seat ->> 'ready')::boolean and (seat ->> 'modelLoginReady')::boolean);
	return jsonb_build_object('schema','qorpera.company-founding/v1','profileId',p_profile_id,
		'companyName',(select name from public.qorpera_profiles where id = p_profile_id),
		'vision',coalesce(v_f.vision_draft,''),'phase',v_f.phase,'revision',v_f.revision,
		'createdByUserId',v_f.created_by_user_id,'seats',v_seats,'waitingFor',v_waiting,
		'me',jsonb_build_object('userId',auth.uid(),'state',v_me.state,
			'canEdit',v_f.phase = 'open' and v_me.state = 'joined',
			'canManage',v_f.phase = 'open' and auth.uid() = v_f.created_by_user_id,
			'canStart',v_f.phase = 'open' and v_me.state = 'joined' and jsonb_array_length(v_waiting) = 0),
		'start',case when v_f.phase = 'started' then jsonb_build_object('startedAt',v_f.started_at,
			'startedByUserId',v_f.started_by_user_id,'revision',v_f.started_revision,
			'clientStartId',v_f.start_client_id,'companyReady',public.qorpera_folder_company_ready(p_profile_id)) end);
end $$;
revoke all on function public.qorpera_company_founding_json(uuid) from public,anon,authenticated,service_role;

-- Your seat, and after Start your membership too: a founder who left reads nothing any more.
create function public.qorpera_company_founding_seated(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select auth.uid() is not null and exists(select 1 from public.qorpera_company_founder_seats seat
		join public.qorpera_company_foundings founding using(profile_id)
		where seat.profile_id = p_profile_id and seat.user_id = auth.uid()
			and (founding.phase = 'open' or exists(select 1 from public.qorpera_profile_members member
				where member.profile_id = p_profile_id and member.user_id = auth.uid())))
$$;
revoke all on function public.qorpera_company_founding_seated(uuid) from public,anon,authenticated,service_role;

-- Locks in one order everywhere: the profile row (FOR UPDATE, as the membership guard takes it, so
-- no lock is upgraded part-way), then the founding row, then seats. Only someone with a seat
-- takes them.
create function public.qorpera_lock_company_founding(p_profile_id uuid)
returns public.qorpera_company_foundings language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype;
begin
	if not public.qorpera_company_founding_seated(p_profile_id) then
		raise exception 'This founding table is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	select * into v_f from public.qorpera_company_foundings where profile_id = p_profile_id for update;
	if not found or not public.qorpera_company_founding_seated(p_profile_id) then
		raise exception 'This founding table is unavailable' using errcode = '42501'; end if;
	return v_f;
end $$;
revoke all on function public.qorpera_lock_company_founding(uuid) from public,anon,authenticated,service_role;

create function public.qorpera_open_company_founding(p_client_creation_id uuid,p_company_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_created jsonb; v_profile uuid;
begin
	if v_user is null or not public.qorpera_current_email_verified() then
		raise exception 'A verified account is required' using errcode = '42501'; end if;
	if not public.qorpera_company_founding_available() then
		raise exception 'New companies do not start at a founding table yet' using errcode = '0A000'; end if;
	if p_client_creation_id is null or p_company_name is null or char_length(btrim(p_company_name)) not between 1 and 120 then
		raise exception 'Company details are invalid' using errcode = '22023'; end if;
	-- Repeat-safe on (creator, client creation id): C2's open returns the same company.
	v_created := public.qorpera_folder_company_open(v_user,p_client_creation_id,btrim(p_company_name));
	v_profile := (v_created ->> 'profile_id')::uuid;
	perform 1 from public.qorpera_profiles where id = v_profile for update;
	if not exists(select 1 from public.qorpera_company_foundings where profile_id = v_profile) then
		-- Only a company made just now becomes a table: the caller alone, as owner, with no setup
		-- queued (a company made the old way always has a bootstrap job).
		if exists(select 1 from public.qorpera_profile_members where profile_id = v_profile
				and (user_id <> v_user or role <> 'owner'))
			or not exists(select 1 from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user)
			or exists(select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_profile) then
			raise exception 'This company already exists' using errcode = '23505'; end if;
		insert into public.qorpera_company_foundings(profile_id,created_by_user_id,vision_draft)
			values(v_profile,v_user,'');
	elsif not exists(select 1 from public.qorpera_company_foundings
		where profile_id = v_profile and created_by_user_id = v_user) then
		raise exception 'This company is not a founding table' using errcode = '23505';
	end if;
	insert into public.qorpera_company_founder_seats(profile_id,user_id,invited_by_user_id,state,joined_at)
		values(v_profile,v_user,v_user,'joined',clock_timestamp()) on conflict do nothing;
	return public.qorpera_company_founding_json(v_profile);
end $$;

create function public.qorpera_read_company_founding(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.qorpera_company_founding_seated(p_profile_id) then
		raise exception 'This founding table is unavailable' using errcode = '42501'; end if;
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

-- The tables I sit at or am invited to, while they are open or their company is still starting.
create function public.qorpera_list_company_foundings()
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('profileId',founding.profile_id,'companyName',profile.name,
		'phase',founding.phase,'myState',seat.state,
		'invitedByDisplayName',left(public.qorpera_account_display_name(inviter.raw_user_meta_data),160),
		'joined',(select count(*) from public.qorpera_company_founder_seats other
			where other.profile_id = founding.profile_id and other.state = 'joined'))
		order by founding.created_at,founding.profile_id),'[]'::jsonb)
	from public.qorpera_company_founder_seats seat
	join public.qorpera_company_foundings founding on founding.profile_id = seat.profile_id
	join public.qorpera_profiles profile on profile.id = seat.profile_id
	left join auth.users inviter on inviter.id = seat.invited_by_user_id
	where seat.user_id = auth.uid() and public.qorpera_current_email_verified()
		and (founding.phase = 'open' or (seat.state = 'joined'
			and exists(select 1 from public.qorpera_profile_members member
				where member.profile_id = founding.profile_id and member.user_id = auth.uid())
			and not public.qorpera_folder_company_ready(founding.profile_id)))
$$;

create function public.qorpera_update_company_founding(
	p_profile_id uuid,p_expected_revision bigint,p_company_name text,p_vision text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype; v_name text := btrim(p_company_name);
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	if not exists(select 1 from public.qorpera_company_founder_seats where profile_id = p_profile_id
		and user_id = auth.uid() and state = 'joined') then
		raise exception 'Only founders at the table can change it' using errcode = '42501'; end if;
	if v_f.phase <> 'open' or p_expected_revision is distinct from v_f.revision then
		raise exception 'The table changed; refresh and try again' using errcode = 'PT412'; end if;
	if v_name is null or char_length(v_name) not between 1 and 120
		or p_vision is null or octet_length(p_vision) > 16384 then
		raise exception 'Company details are invalid' using errcode = '22023'; end if;
	if v_name is distinct from (select name from public.qorpera_profiles where id = p_profile_id)
		or p_vision is distinct from v_f.vision_draft then
		update public.qorpera_profiles set name = v_name where id = p_profile_id and name is distinct from v_name;
		update public.qorpera_company_foundings set vision_draft = p_vision,revision = revision+1
			where profile_id = p_profile_id;
	end if;
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

create function public.qorpera_invite_company_founder(p_profile_id uuid,p_friend_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype;
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	if v_f.phase <> 'open' or not exists(select 1 from public.qorpera_company_founder_seats
		where profile_id = p_profile_id and user_id = auth.uid() and state = 'joined') then
		raise exception 'Only founders at an open table can invite' using errcode = '42501'; end if;
	if p_friend_user_id is null or not exists(select 1 from public.qorpera_friendships
		where user_low = least(auth.uid(),p_friend_user_id) and user_high = greatest(auth.uid(),p_friend_user_id)
			and status = 'accepted') then
		raise exception 'Invite one of your friends' using errcode = '42501'; end if;
	if not exists(select 1 from public.qorpera_company_founder_seats
		where profile_id = p_profile_id and user_id = p_friend_user_id) then
		if (select count(*) from public.qorpera_company_founder_seats where profile_id = p_profile_id) >= 8 then
			raise exception 'A table has at most eight seats' using errcode = '54000'; end if;
		-- A pending invitation does not change who sits at the table, so nobody's Ready clears.
		insert into public.qorpera_company_founder_seats(profile_id,user_id,invited_by_user_id,state)
			values(p_profile_id,p_friend_user_id,auth.uid(),'invited');
	end if;
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

create function public.qorpera_respond_company_founding(p_profile_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype; v_seat public.qorpera_company_founder_seats%rowtype;
	v_account auth.users%rowtype;
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	if not public.qorpera_current_email_verified() or p_accept is null then
		raise exception 'A verified account is required' using errcode = '42501'; end if;
	select * into strict v_seat from public.qorpera_company_founder_seats
		where profile_id = p_profile_id and user_id = auth.uid() for update;
	if v_seat.state = 'joined' and p_accept then return public.qorpera_company_founding_json(p_profile_id); end if;
	if v_f.phase <> 'open' or v_seat.state <> 'invited' then
		raise exception 'This invitation is no longer open' using errcode = '42501'; end if;
	if not p_accept then
		delete from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = auth.uid();
		return jsonb_build_object('state','declined','profileId',p_profile_id);
	end if;
	select * into strict v_account from auth.users where id = auth.uid();
	update public.qorpera_company_founder_seats set state = 'joined',joined_at = clock_timestamp()
		where profile_id = p_profile_id and user_id = auth.uid();
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values(p_profile_id,auth.uid(),lower(v_account.email),
			left(public.qorpera_account_display_name(v_account.raw_user_meta_data),256),'contributor');
	update public.qorpera_company_foundings set revision = revision+1 where profile_id = p_profile_id;
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

create function public.qorpera_set_founder_role(p_profile_id uuid,p_expected_revision bigint,p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype; v_role text := btrim(p_role);
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	if not exists(select 1 from public.qorpera_company_founder_seats where profile_id = p_profile_id
		and user_id = auth.uid() and state = 'joined') then
		raise exception 'Only founders at the table can write a role' using errcode = '42501'; end if;
	if v_f.phase <> 'open' or p_expected_revision is distinct from v_f.revision then
		raise exception 'The table changed; refresh and try again' using errcode = 'PT412'; end if;
	if v_role is null or char_length(v_role) > 300 then
		raise exception 'A role is at most 300 characters' using errcode = '22023'; end if;
	update public.qorpera_company_founder_seats set role_text = v_role
		where profile_id = p_profile_id and user_id = auth.uid() and role_text is distinct from v_role;
	if found then
		update public.qorpera_company_foundings set revision = revision+1 where profile_id = p_profile_id;
	end if;
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

create function public.qorpera_set_founder_ready(p_profile_id uuid,p_expected_revision bigint,p_ready boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype;
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	if not exists(select 1 from public.qorpera_company_founder_seats where profile_id = p_profile_id
		and user_id = auth.uid() and state = 'joined') then
		raise exception 'Only founders at the table can be ready' using errcode = '42501'; end if;
	if p_ready is null then raise exception 'Ready is true or false' using errcode = '22023'; end if;
	if v_f.phase <> 'open' or p_expected_revision is distinct from v_f.revision then
		raise exception 'The table changed; refresh and try again' using errcode = 'PT412'; end if;
	if p_ready and not exists(select 1 from public.qorpera_eligible_member_accounts(p_profile_id,auth.uid())) then
		raise exception 'Connect your own ChatGPT account before you are ready' using errcode = '55000'; end if;
	update public.qorpera_company_founder_seats set ready_revision = case when p_ready then v_f.revision end
		where profile_id = p_profile_id and user_id = auth.uid();
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

-- Your own seat (leave, or withdraw from an invitation), an invitation you sent, or, for the
-- founder who opened the table, any other seat. The one who opened it cannot leave; they close
-- the table with qorpera_delete_hosted_profile, which the web offers once they sit there alone.
create function public.qorpera_remove_company_founder(p_profile_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype; v_seat public.qorpera_company_founder_seats%rowtype;
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	select * into v_seat from public.qorpera_company_founder_seats
		where profile_id = p_profile_id and user_id = p_user_id for update;
	if v_f.phase <> 'open' or not found or p_user_id = v_f.created_by_user_id
		or (p_user_id <> auth.uid() and auth.uid() <> v_f.created_by_user_id
			and not (v_seat.state = 'invited' and v_seat.invited_by_user_id = auth.uid())) then
		raise exception 'You cannot remove this seat' using errcode = '42501'; end if;
	if v_seat.state = 'invited' then
		delete from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = p_user_id;
	-- A joined founder is still a contributor, so the company's own leave and remove rules apply;
	-- qorpera_founding_member_left then drops the seat and moves the revision.
	elsif p_user_id = auth.uid() then
		perform public.qorpera_leave_hosted_profile(p_profile_id);
	else
		perform public.qorpera_remove_profile_member(p_profile_id,p_user_id);
	end if;
	if p_user_id = auth.uid() then return jsonb_build_object('state','left','profileId',p_profile_id); end if;
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

create function public.qorpera_start_company_founding(p_profile_id uuid,p_expected_revision bigint,p_client_start_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_foundings%rowtype; v_sponsor jsonb; v_founders jsonb;
begin
	v_f := public.qorpera_lock_company_founding(p_profile_id);
	if not public.qorpera_current_email_verified() or not exists(select 1 from public.qorpera_company_founder_seats
		where profile_id = p_profile_id and user_id = auth.uid() and state = 'joined') then
		raise exception 'Only founders at the table can start it' using errcode = '42501'; end if;
	-- Repeat-safe: a second press (any founder, any tab) sees the started table.
	if v_f.phase = 'started' then return public.qorpera_company_founding_json(p_profile_id); end if;
	if not public.qorpera_company_founding_available() then
		raise exception 'New companies do not start at a founding table yet' using errcode = '0A000'; end if;
	if p_expected_revision is distinct from v_f.revision or p_client_start_id is null then
		raise exception 'The table changed; refresh and try again' using errcode = 'PT412'; end if;
	perform 1 from public.qorpera_company_founder_seats where profile_id = p_profile_id for update;
	if exists(select 1 from public.qorpera_company_founder_seats seat
		left join public.qorpera_profile_members member using(profile_id,user_id)
		where seat.profile_id = p_profile_id and seat.state = 'joined'
			and (seat.ready_revision is distinct from v_f.revision or member.role is null
				or not exists(select 1 from public.qorpera_eligible_member_accounts(p_profile_id,seat.user_id)))) then
		raise exception 'Every founder must be ready with their own ChatGPT account' using errcode = '55000'; end if;
	-- The launcher's own login pays for the kickoff (the member who started the work pays).
	v_sponsor := public.qorpera_member_first_run_sponsor(p_profile_id,auth.uid());
	if v_sponsor is null or not public.qorpera_sponsor_serves_requester(p_profile_id,
		(v_sponsor ->> 'sponsorBindingId')::uuid,(v_sponsor ->> 'sponsorVersion')::bigint,auth.uid()) then
		raise exception 'Your ChatGPT account cannot pay for the first run' using errcode = '55000'; end if;
	select jsonb_agg(jsonb_build_object('userId',seat.user_id,'displayName',member.display_name,'role',seat.role_text)
		order by seat.joined_at,seat.user_id) into v_founders
	from public.qorpera_company_founder_seats seat join public.qorpera_profile_members member using(profile_id,user_id)
	where seat.profile_id = p_profile_id and seat.state = 'joined';
	-- Invitations nobody answered are withdrawn; only the people at the table found the company.
	delete from public.qorpera_company_founder_seats where profile_id = p_profile_id and state = 'invited';
	update public.qorpera_company_foundings set phase = 'started',started_at = clock_timestamp(),
		started_by_user_id = auth.uid(),started_revision = v_f.revision,start_client_id = p_client_start_id,
		vision_draft = null where profile_id = p_profile_id;
	update public.qorpera_company_founder_seats set role_text = '',ready_revision = null where profile_id = p_profile_id;
	-- Every founder at the table owns the company.
	update public.qorpera_profile_members member set role = 'owner' where member.profile_id = p_profile_id
		and member.role <> 'owner' and exists(select 1 from public.qorpera_company_founder_seats seat
			where seat.profile_id = member.profile_id and seat.user_id = member.user_id and seat.state = 'joined');
	-- C2 writes vision/vision.md and the Co-Founder's first todo from this, in the creation
	-- commit, with the first-run wake requested by the launcher.
	perform public.qorpera_folder_company_seed(p_profile_id,jsonb_build_object(
		'schema','qorpera.company-seed-input/v1',
		'companyName',(select name from public.qorpera_profiles where id = p_profile_id),
		'vision',v_f.vision_draft,'kickoffRequestedBy',auth.uid(),'founders',v_founders));
	return public.qorpera_company_founding_json(p_profile_id);
end $$;

revoke all on function public.qorpera_open_company_founding(uuid,text),public.qorpera_read_company_founding(uuid),
	public.qorpera_list_company_foundings(),public.qorpera_update_company_founding(uuid,bigint,text,text),
	public.qorpera_invite_company_founder(uuid,uuid),public.qorpera_respond_company_founding(uuid,boolean),
	public.qorpera_set_founder_role(uuid,bigint,text),public.qorpera_set_founder_ready(uuid,bigint,boolean),
	public.qorpera_remove_company_founder(uuid,uuid),public.qorpera_start_company_founding(uuid,bigint,uuid)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_open_company_founding(uuid,text),public.qorpera_read_company_founding(uuid),
	public.qorpera_list_company_foundings(),public.qorpera_update_company_founding(uuid,bigint,text,text),
	public.qorpera_invite_company_founder(uuid,uuid),public.qorpera_respond_company_founding(uuid,boolean),
	public.qorpera_set_founder_role(uuid,bigint,text),public.qorpera_set_founder_ready(uuid,bigint,boolean),
	public.qorpera_remove_company_founder(uuid,uuid),public.qorpera_start_company_founding(uuid,bigint,uuid)
	to authenticated;

-- An open table is not a company yet: the hub lists it as a table, not beside the companies.
do $$ declare v text; old text := E'where member.user_id = auth.uid() and not (coalesce(job.hidden_until_ready,false) and job.state <> ''completed'')'; begin
	v := pg_get_functiondef('public.qorpera_list_hosted_profiles()'::regprocedure);
	if (length(v)-length(replace(v,old,'')))/length(old) <> 1 then
		raise exception 'qorpera_list_hosted_profiles anchor differs'; end if;
	execute replace(v,old,old||E'\n\t\tand not public.qorpera_company_founding_open(profile.id)');
end $$;
