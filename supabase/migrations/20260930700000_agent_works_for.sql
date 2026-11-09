-- 20260930700000: each agent works for one member of its company (Jonas, 9 Nov 2026).
--
-- In a two-founder test company the Co-Founder hired six agents and all six ran on the login of the founder who led the
-- creation, because the member whose message starts work pays for it and for everything that follows from it. The other
-- founder was a spectator. Jonas asked for a Members page that splits the agents between members "through simple and
-- big visuals", and said yes to the rule behind it: each agent works for one member, who answers its questions and whose
-- subscription carries the agent's own work. This migration is the record and the moves; 20260930701000 makes the
-- agent's own work run on that member's login.
--
-- * Who an agent works for (qorpera_agent_works_for_user): its row in qorpera_agent_works_for when it has one, which
--   may say nobody (its member left); else the member who hired it, while a member; else nobody (no hirer is known).
--   An agent that works for nobody waits in the page's open pile for a member to take it, and its hand-offs keep the
--   chain starter's login (20260930701000). The Co-Founder works for every founder and has no row.
-- * A move goes through an ask, answered by the side that did not ask: the member it would go to, or, when that member
--   asks to take it, the member it works for now. Taking an agent that works for nobody needs no one's yes. An owner or
--   admin may also ask on behalf of others; the member it would go to answers. Viewers neither ask nor receive. One
--   open ask per agent. A yes moves the agent only when it still works for the member it did when asked; otherwise the
--   ask is void. Nothing already running changes payer (20260930701000 decides only new work).
-- * The live read (qorpera_read_works_for) gives the page every agent with the member it works for, the open asks,
--   and each member's login state as co-founders already see it at the founding table: connected or not, a new sign-in
--   needed, how much of the login's usage window is used, and when a used-up login resets. Never an email or account.
-- * A member who leaves: the agents that worked for them work for nobody, and the asks that involve them are void.
-- Locks: two new tables; a trigger on qorpera_profile_members (after delete). Every body carries 20260930700000.

create table public.qorpera_agent_works_for (
	profile_id uuid not null,
	staff_agent_id uuid not null,
	-- null: the agent works for nobody (its member left, or nobody has taken it).
	user_id uuid references auth.users(id) on delete set null,
	since timestamptz not null default clock_timestamp(),
	primary key (profile_id, staff_agent_id),
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete cascade
);

create table public.qorpera_agent_works_for_asks (
	id uuid primary key default gen_random_uuid(),
	profile_id uuid not null,
	staff_agent_id uuid not null,
	-- Who the agent worked for when asked (null: nobody), and who it would go to.
	from_user_id uuid references auth.users(id) on delete set null,
	-- A deleted account leaves its asks with no name (they were void when the member left).
	to_user_id uuid references auth.users(id) on delete set null,
	-- Who asked: a member, or an agent (the Co-Founder dealing out a crew, 20260930701000 onwards).
	asked_by_user_id uuid references auth.users(id) on delete set null,
	asked_by_staff_agent_id uuid,
	-- Who says yes or no.
	answer_by_user_id uuid references auth.users(id) on delete set null,
	status text not null default 'open' check (status in ('open', 'yes', 'no', 'withdrawn', 'void')),
	created_at timestamptz not null default clock_timestamp(),
	answered_at timestamptz,
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete cascade,
	check ((status = 'open') = (answered_at is null)),
	check (asked_by_user_id is not null or asked_by_staff_agent_id is not null)
);
create unique index qorpera_agent_works_for_asks_one_open
	on public.qorpera_agent_works_for_asks(profile_id, staff_agent_id) where status = 'open';
create index qorpera_agent_works_for_asks_profile on public.qorpera_agent_works_for_asks(profile_id) where status = 'open';

alter table public.qorpera_agent_works_for enable row level security;
alter table public.qorpera_agent_works_for_asks enable row level security;
revoke all on table public.qorpera_agent_works_for, public.qorpera_agent_works_for_asks from public, anon, authenticated;

-- The company's active agents other than its Co-Founder.
create function public.qorpera_works_for_agents(p_profile_id uuid)
returns table(staff_agent_id uuid)
language sql stable security definer set search_path = '' as $$
	-- 20260930700000
	select staff.staff_agent_id
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id and staff.employment_status = 'active' and staff.deleted_at is null
		and staff.folder_retired_at is null
		and not exists (select 1 from public.qorpera_company_cofounders as cofounder
			where cofounder.profile_id = p_profile_id and cofounder.staff_agent_id = staff.staff_agent_id)
$$;

-- The member an agent works for, or null when it works for nobody (see the header).
create function public.qorpera_agent_works_for_user(p_profile_id uuid, p_staff_agent_id uuid)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_row public.qorpera_agent_works_for%rowtype; v_hirer uuid; v_known boolean;
begin
	-- 20260930700000
	select * into v_row from public.qorpera_agent_works_for
		where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	if found then
		return case when exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_row.user_id) then v_row.user_id end;
	end if;
	select follow.hired_by_user_id, true into v_hirer, v_known
	from public.qorpera_folder_follow_ups as follow
	where follow.profile_id = p_profile_id and follow.subject_kind = 'agent' and follow.subject_id = p_staff_agent_id
		and follow.hired_by_user_id is not null
	limit 1;
	if v_known then
		return case when exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_hirer) then v_hirer end;
	end if;
	return null;
end $$;

revoke all on function public.qorpera_works_for_agents(uuid), public.qorpera_agent_works_for_user(uuid, uuid)
	from public, anon, authenticated, service_role;

-- A member's login state as their co-members see it.
create function public.qorpera_works_for_login_state(p_profile_id uuid, p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	-- 20260930700000: like the founding table's seats (20260930579000): connected, used up and when it resets, plus the
	-- most room any live login has (used = 100 - room, null when no fresh reading says) and a sign-in that is needed.
	with live as (select * from public.qorpera_member_live_accounts(p_profile_id, p_user_id)),
	used as (select * from public.qorpera_member_logins_used_up(p_profile_id, p_user_id))
	select jsonb_build_object(
		'user_id', p_user_id,
		'state', case
			when exists (select 1 from live) then case when (select used.used_up from used) then 'full' else 'ready' end
			when exists (select 1 from public.qorpera_model_logins as login
				where login.owner_user_id = p_user_id and login.status = 'needs_sign_in') then 'sign_in'
			else 'none' end,
		'used_percent', (select case when max(live.remaining) >= 0 then round(100 - least(100, max(live.remaining))) end
			from live),
		'resets_at', (select used.resets_at from used))
$$;
revoke all on function public.qorpera_works_for_login_state(uuid, uuid) from public, anon, authenticated, service_role;

-- The Members page's live read.
create function public.qorpera_read_works_for(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_role public.qorpera_profile_role;
begin
	-- 20260930700000
	v_role := public.qorpera_member_role(p_profile_id);
	if v_actor is null or v_role is null then
		raise exception 'Members unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.works-for/v1',
		'may_ask', v_role <> 'viewer',
		'may_ask_for_others', v_role in ('owner', 'admin'),
		'agents', coalesce((select jsonb_agg(jsonb_build_object(
				'staff_agent_id', agent.staff_agent_id,
				'user_id', public.qorpera_agent_works_for_user(p_profile_id, agent.staff_agent_id),
				'since', (select w.since from public.qorpera_agent_works_for as w
					where w.profile_id = p_profile_id and w.staff_agent_id = agent.staff_agent_id))
			order by agent.staff_agent_id)
			from public.qorpera_works_for_agents(p_profile_id) as agent), '[]'::jsonb),
		'logins', coalesce((select jsonb_agg(public.qorpera_works_for_login_state(p_profile_id, member.user_id)
				order by member.joined_at, member.user_id)
			from public.qorpera_profile_members as member where member.profile_id = p_profile_id), '[]'::jsonb),
		'asks', coalesce((select jsonb_agg(jsonb_build_object(
				'id', ask.id,
				'staff_agent_id', ask.staff_agent_id,
				'from_user_id', ask.from_user_id,
				'to_user_id', ask.to_user_id,
				'asked_by_user_id', ask.asked_by_user_id,
				'asked_by_staff_agent_id', ask.asked_by_staff_agent_id,
				'answer_by_user_id', ask.answer_by_user_id,
				'created_at', ask.created_at) order by ask.created_at, ask.id)
			from public.qorpera_agent_works_for_asks as ask
			where ask.profile_id = p_profile_id and ask.status = 'open'), '[]'::jsonb));
end $$;
revoke all on function public.qorpera_read_works_for(uuid) from public, anon;
grant execute on function public.qorpera_read_works_for(uuid) to authenticated;

-- Moves the agent to the member, recording when. Internal.
create function public.qorpera_works_for_move(p_profile_id uuid, p_staff_agent_id uuid, p_user_id uuid)
returns void
language sql security definer set search_path = '' as $$
	-- 20260930700000
	insert into public.qorpera_agent_works_for(profile_id, staff_agent_id, user_id, since)
	values (p_profile_id, p_staff_agent_id, p_user_id, clock_timestamp())
	on conflict (profile_id, staff_agent_id) do update set user_id = excluded.user_id, since = excluded.since;
$$;
revoke all on function public.qorpera_works_for_move(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- A member asks for an agent to work for another member, or for themselves. Answers {moved, ask_id}: moved when no
-- one else's yes is needed (taking an agent that works for nobody, or asking for the member it already works for).
create function public.qorpera_ask_works_for(p_profile_id uuid, p_staff_agent_id uuid, p_to_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_actor uuid := auth.uid();
	v_role public.qorpera_profile_role := public.qorpera_member_role(p_profile_id);
	v_to_role public.qorpera_profile_role;
	v_from uuid;
	v_answer uuid;
	v_id uuid;
begin
	-- 20260930700000
	if v_actor is null or v_role is null then
		raise exception 'Members unavailable' using errcode = '42501'; end if;
	if v_role = 'viewer' then
		raise exception 'A viewer cannot move agents' using errcode = '42501'; end if;
	if p_staff_agent_id is null or p_to_user_id is null then
		raise exception 'agent and member are required' using errcode = '22023'; end if;
	select member.role into v_to_role from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = p_to_user_id;
	if v_to_role is null or v_to_role = 'viewer' then
		raise exception 'That member cannot take agents' using errcode = '22023'; end if;
	if not exists (select 1 from public.qorpera_works_for_agents(p_profile_id) as agent
		where agent.staff_agent_id = p_staff_agent_id) then
		raise exception 'That agent cannot be moved' using errcode = '22023'; end if;
	-- One change at a time per agent.
	perform 1 from public.qorpera_profile_staff
		where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id for update;
	v_from := public.qorpera_agent_works_for_user(p_profile_id, p_staff_agent_id);
	if v_from is not distinct from p_to_user_id then
		return jsonb_build_object('moved', true, 'ask_id', null); end if;
	if exists (select 1 from public.qorpera_agent_works_for_asks
		where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id and status = 'open') then
		raise exception 'Someone has already asked about that agent' using errcode = '55P03'; end if;
	if v_actor = p_to_user_id then
		-- Taking it: from nobody at once, from a member with their yes.
		if v_from is null then
			perform public.qorpera_works_for_move(p_profile_id, p_staff_agent_id, v_actor);
			return jsonb_build_object('moved', true, 'ask_id', null);
		end if;
		v_answer := v_from;
	elsif v_actor = v_from or v_role in ('owner', 'admin') then
		v_answer := p_to_user_id;
	else
		raise exception 'Only the member it works for, or an owner or admin, can offer that agent' using errcode = '42501';
	end if;
	insert into public.qorpera_agent_works_for_asks(profile_id, staff_agent_id, from_user_id, to_user_id,
		asked_by_user_id, answer_by_user_id)
	values (p_profile_id, p_staff_agent_id, v_from, p_to_user_id, v_actor, v_answer)
	returning id into v_id;
	return jsonb_build_object('moved', false, 'ask_id', v_id);
end $$;
revoke all on function public.qorpera_ask_works_for(uuid, uuid, uuid) from public, anon;
grant execute on function public.qorpera_ask_works_for(uuid, uuid, uuid) to authenticated;

-- The member who answers says yes or no; the member who asked may withdraw (p_yes false). Answers {status, moved}.
create function public.qorpera_answer_works_for(p_ask_id uuid, p_yes boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_ask public.qorpera_agent_works_for_asks%rowtype; v_now uuid; v_status text;
begin
	-- 20260930700000
	if v_actor is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if p_ask_id is null or p_yes is null then raise exception 'ask and answer are required' using errcode = '22023'; end if;
	select * into v_ask from public.qorpera_agent_works_for_asks where id = p_ask_id for update;
	if not found or public.qorpera_member_role(v_ask.profile_id) is null then
		raise exception 'That ask is not here' using errcode = '42501'; end if;
	if v_ask.status <> 'open' then
		return jsonb_build_object('status', v_ask.status, 'moved', false); end if;
	if v_actor = v_ask.answer_by_user_id then
		v_status := case when p_yes then 'yes' else 'no' end;
	elsif v_actor = v_ask.asked_by_user_id and not p_yes then
		v_status := 'withdrawn';
	else
		raise exception 'Only the member asked can answer' using errcode = '42501';
	end if;
	if v_status = 'yes' then
		perform 1 from public.qorpera_profile_staff
			where profile_id = v_ask.profile_id and staff_agent_id = v_ask.staff_agent_id for update;
		v_now := public.qorpera_agent_works_for_user(v_ask.profile_id, v_ask.staff_agent_id);
		if v_now is distinct from v_ask.from_user_id
			or not exists (select 1 from public.qorpera_profile_members as member where member.profile_id = v_ask.profile_id
				and member.user_id = v_ask.to_user_id and member.role <> 'viewer') then
			v_status := 'void';
		else
			perform public.qorpera_works_for_move(v_ask.profile_id, v_ask.staff_agent_id, v_ask.to_user_id);
		end if;
	end if;
	update public.qorpera_agent_works_for_asks set status = v_status, answered_at = clock_timestamp() where id = p_ask_id;
	return jsonb_build_object('status', v_status, 'moved', v_status = 'yes');
end $$;
revoke all on function public.qorpera_answer_works_for(uuid, boolean) from public, anon;
grant execute on function public.qorpera_answer_works_for(uuid, boolean) to authenticated;

-- A member who leaves: their agents work for nobody, and the asks that involve them are void.
create function public.qorpera_works_for_member_left()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930700000: the agents resolved to them by hire get a row saying nobody, so they never fall to another
	-- member without that member's yes.
	insert into public.qorpera_agent_works_for(profile_id, staff_agent_id, user_id)
	select old.profile_id, agent.staff_agent_id, null
	from public.qorpera_works_for_agents(old.profile_id) as agent
	where not exists (select 1 from public.qorpera_agent_works_for as w
			where w.profile_id = old.profile_id and w.staff_agent_id = agent.staff_agent_id)
		and public.qorpera_agent_works_for_user(old.profile_id, agent.staff_agent_id) is null
	on conflict (profile_id, staff_agent_id) do nothing;
	update public.qorpera_agent_works_for set user_id = null, since = clock_timestamp()
		where profile_id = old.profile_id and user_id = old.user_id;
	update public.qorpera_agent_works_for_asks set status = 'void', answered_at = clock_timestamp()
		where profile_id = old.profile_id and status = 'open'
			and old.user_id in (from_user_id, to_user_id, answer_by_user_id, asked_by_user_id);
	return old;
end $$;
revoke all on function public.qorpera_works_for_member_left() from public, anon, authenticated, service_role;
create trigger qorpera_works_for_member_left after delete on public.qorpera_profile_members
	for each row execute function public.qorpera_works_for_member_left();
