-- Friends see when each other was last online, and a leaderboard compares friends,
-- their companies and their companies' agents (Jonas, 9 Nov 2026).
--
-- Last online: the web app marks the account online when it opens and every few
-- minutes while a tab is in front (qorpera_mark_online). The mark is kept per
-- account, with one row per day the account was online, which the leaderboard
-- counts as active days. Only accepted friends see the time; a pending request
-- shows none either way.
--
-- The leaderboard reads, for the caller and their accepted friends, figures the
-- database already holds: agent runs (qorpera_execution_runs) and their results,
-- the hours agents ran (qorpera_computer_hour_usage.run_seconds), active agents,
-- messages the person wrote, and the sales the good will counted. A company counts
-- for every board member who is a member of it. An account can leave its friends'
-- boards (qorpera_set_leaderboard_hidden); it still sees its own row.

create table public.qorpera_account_presence (
	user_id uuid primary key references auth.users(id) on delete cascade,
	last_seen_at timestamptz not null default clock_timestamp(),
	leaderboard_hidden boolean not null default false
);

alter table public.qorpera_account_presence enable row level security;
revoke all on table public.qorpera_account_presence from public, anon, authenticated;

create table public.qorpera_account_active_days (
	user_id uuid not null references auth.users(id) on delete cascade,
	day date not null,
	primary key (user_id, day)
);

alter table public.qorpera_account_active_days enable row level security;
revoke all on table public.qorpera_account_active_days from public, anon, authenticated;

-- Marks the caller online now. A mark within the last 30 seconds is kept as it is,
-- so several open tabs write at most twice a minute. The day is the UTC day.
create function public.qorpera_mark_online()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_now timestamptz := clock_timestamp();
	v_seen timestamptz;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	insert into public.qorpera_account_presence as presence (user_id, last_seen_at)
	values (v_actor, v_now)
	on conflict (user_id) do update
		set last_seen_at = excluded.last_seen_at
		where presence.last_seen_at < excluded.last_seen_at - interval '30 seconds'
	returning last_seen_at into v_seen;
	if v_seen is null then
		select presence.last_seen_at into v_seen
		from public.qorpera_account_presence as presence
		where presence.user_id = v_actor;
	end if;
	insert into public.qorpera_account_active_days (user_id, day)
	values (v_actor, (v_now at time zone 'UTC')::date)
	on conflict do nothing;
	return jsonb_build_object('last_seen_at', v_seen);
end
$$;

revoke all on function public.qorpera_mark_online() from public, anon;
grant execute on function public.qorpera_mark_online() to authenticated;

-- The friends list as before, with `last_seen_at` for accepted friends: the last
-- mark, or the last sign-in for an account that has not been marked yet.
create or replace function public.qorpera_list_friends()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'user_id', friend.id,
		'email', friend.email,
		'display_name', left(public.qorpera_account_display_name(friend.raw_user_meta_data), 160),
		'status', f.status,
		'direction', case when f.requested_by = v_actor then 'outgoing' else 'incoming' end,
		'since', coalesce(f.responded_at, f.created_at),
		'last_seen_at', case when f.status = 'accepted'
			then coalesce(presence.last_seen_at, friend.last_sign_in_at) end
	) order by f.status desc, coalesce(f.responded_at, f.created_at) desc), '[]'::jsonb)
	into v_result
	from public.qorpera_friendships f
	join auth.users friend on friend.id = case when f.user_low = v_actor then f.user_high else f.user_low end
	left join public.qorpera_account_presence presence on presence.user_id = friend.id
	where v_actor in (f.user_low, f.user_high);
	return v_result;
end
$$;

create function public.qorpera_set_leaderboard_hidden(p_hidden boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_hidden is null then
		raise exception 'hidden must be true or false' using errcode = '22023';
	end if;
	insert into public.qorpera_account_presence as presence (user_id, leaderboard_hidden)
	values (v_actor, p_hidden)
	on conflict (user_id) do update set leaderboard_hidden = excluded.leaderboard_hidden;
	return jsonb_build_object('hidden', p_hidden);
end
$$;

revoke all on function public.qorpera_set_leaderboard_hidden(boolean) from public, anon;
grant execute on function public.qorpera_set_leaderboard_hidden(boolean) to authenticated;

-- The board over the last `p_days` days (7 or 30): people, companies and agents.
-- Agents are the 30 with the most runs. Sales are the good will months that
-- overlap the period, in øre.
create function public.qorpera_friends_leaderboard(p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_since timestamptz;
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_days is null or p_days not in (7, 30) then
		raise exception 'days must be 7 or 30' using errcode = '22023';
	end if;
	v_since := statement_timestamp() - make_interval(days => p_days);
	with board as (
		select v_actor as user_id
		union
		select case when f.user_low = v_actor then f.user_high else f.user_low end
		from public.qorpera_friendships f
		left join public.qorpera_account_presence presence
			on presence.user_id = case when f.user_low = v_actor then f.user_high else f.user_low end
		where v_actor in (f.user_low, f.user_high)
			and f.status = 'accepted'
			and not coalesce(presence.leaderboard_hidden, false)
	),
	memberships as (
		select member.profile_id, member.user_id
		from public.qorpera_profile_members member
		join board on board.user_id = member.user_id
	),
	companies as (
		select profile.id as profile_id, profile.name,
			(select count(*) from public.qorpera_profile_staff staff
				where staff.profile_id = profile.id and staff.employment_status = 'active') as agents,
			(select count(*) from public.qorpera_execution_runs run
				where run.profile_id = profile.id and run.created_at >= v_since) as agent_runs,
			(select coalesce(sum(usage.run_seconds), 0) from public.qorpera_computer_hour_usage usage
				where usage.profile_id = profile.id and usage.metered_at >= v_since) as run_seconds,
			(select coalesce(sum(month.sales_ore), 0) from public.qorpera_good_will_months month
				where month.profile_id = profile.id
					and month.month >= date_trunc('month', v_since at time zone 'Europe/Copenhagen')::date) as sales_ore
		from public.qorpera_profiles profile
		where profile.id in (select profile_id from memberships)
	),
	people as (
		select account.id as user_id,
			left(public.qorpera_account_display_name(account.raw_user_meta_data), 160) as display_name,
			coalesce(presence.last_seen_at, account.last_sign_in_at) as last_seen_at,
			(select count(*) from public.qorpera_account_active_days active
				where active.user_id = account.id and active.day >= (v_since at time zone 'UTC')::date) as active_days,
			(select count(*) from public.qorpera_session_inputs input
				where input.author_user_id = account.id and input.kind = 'user_message'
					and input.created_at >= v_since) as messages,
			(select count(*) from memberships m where m.user_id = account.id) as company_count,
			(select coalesce(sum(c.agent_runs), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as agent_runs,
			(select coalesce(sum(c.run_seconds), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as run_seconds,
			(select coalesce(sum(c.agents), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as agents,
			(select coalesce(sum(c.sales_ore), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as sales_ore
		from board
		join auth.users account on account.id = board.user_id
		left join public.qorpera_account_presence presence on presence.user_id = account.id
	),
	agent_work as (
		select run.profile_id, run.staff_agent_id,
			count(*) as runs,
			count(result.run_id) as finished,
			count(result.run_id) filter (where result.company_disposition <> 'unchanged') as saved
		from public.qorpera_execution_runs run
		left join public.qorpera_execution_run_results result on result.run_id = run.id
		where run.profile_id in (select profile_id from companies)
			and run.created_at >= v_since
		group by run.profile_id, run.staff_agent_id
	),
	agents as (
		select work.*, staff.display_name, staff.role, staff.appearance_color, staff.appearance_shape,
			staff.template_id, companies.name as company_name
		from agent_work work
		join public.qorpera_profile_staff staff
			on staff.profile_id = work.profile_id and staff.staff_agent_id = work.staff_agent_id
		join companies on companies.profile_id = work.profile_id
		order by work.runs desc, work.saved desc, staff.display_name
		limit 30
	)
	select jsonb_build_object(
		'days', p_days,
		'since', v_since,
		'hidden', coalesce((select presence.leaderboard_hidden from public.qorpera_account_presence presence
			where presence.user_id = v_actor), false),
		'people', coalesce((select jsonb_agg(jsonb_build_object(
			'user_id', p.user_id,
			'display_name', p.display_name,
			'me', p.user_id = v_actor,
			'last_seen_at', p.last_seen_at,
			'active_days', p.active_days,
			'messages', p.messages,
			'companies', p.company_count,
			'agents', p.agents,
			'agent_runs', p.agent_runs,
			'agent_hours', round(p.run_seconds / 3600.0, 1),
			'sales_ore', p.sales_ore
		) order by p.agent_runs desc, p.display_name) from people p), '[]'::jsonb),
		'companies', coalesce((select jsonb_agg(jsonb_build_object(
			'profile_id', c.profile_id,
			'name', c.name,
			'members', (select jsonb_agg(m.user_id order by m.user_id) from memberships m
				where m.profile_id = c.profile_id),
			'agents', c.agents,
			'agent_runs', c.agent_runs,
			'agent_hours', round(c.run_seconds / 3600.0, 1),
			'sales_ore', c.sales_ore
		) order by c.agent_runs desc, c.name) from companies c), '[]'::jsonb),
		'agents', coalesce((select jsonb_agg(jsonb_build_object(
			'profile_id', a.profile_id,
			'staff_agent_id', a.staff_agent_id,
			'display_name', a.display_name,
			'role', left(a.role, 160),
			'appearance_color', a.appearance_color,
			'appearance_shape', a.appearance_shape,
			'template_id', a.template_id,
			'company_name', a.company_name,
			'runs', a.runs,
			'finished', a.finished,
			'saved', a.saved
		) order by a.runs desc, a.saved desc, a.display_name) from agents a), '[]'::jsonb)
	) into v_result;
	return v_result;
end
$$;

revoke all on function public.qorpera_friends_leaderboard(integer) from public, anon;
grant execute on function public.qorpera_friends_leaderboard(integer) to authenticated;
