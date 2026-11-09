-- Friends see when each other was last online, and a leaderboard compares friends
-- and their companies (Jonas, 9 Nov 2026).
--
-- Last online: the web app marks the account online when it opens and every few
-- minutes while a tab is in front (qorpera_mark_online). Only accepted friends see
-- the time; a pending request shows none either way.
--
-- The leaderboard has two categories, each for people and for companies: the
-- busiest, by tasks agents finished this week, a round from Monday 00:00 Danish
-- time (runs in qorpera_execution_runs whose result saved work), and the most revenue, by all sales the good will has
-- counted, without VAT (qorpera_good_will_months.net_ore). A person's figure is
-- the sum over the companies they are a member of. An account can leave its
-- friends' boards (qorpera_set_leaderboard_hidden); it still sees its own row.

create table public.qorpera_account_presence (
	user_id uuid primary key references auth.users(id) on delete cascade,
	last_seen_at timestamptz not null default clock_timestamp(),
	leaderboard_hidden boolean not null default false
);

alter table public.qorpera_account_presence enable row level security;
revoke all on table public.qorpera_account_presence from public, anon, authenticated;

-- Marks the caller online now. A mark within the last 30 seconds is kept as it is,
-- so several open tabs write at most twice a minute.
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

-- The week a moment falls in, Monday 00:00 to the next Monday 00:00 in
-- Copenhagen, with the week before it. The Mondays are counted on the local
-- calendar before they become moments, so a week holding a clock change is
-- 167 or 169 hours long and no hour falls between two weeks.
create function public.qorpera_leaderboard_week(p_at timestamptz)
returns table (last_since timestamptz, since timestamptz, until timestamptz, week integer)
language sql
immutable
set search_path = ''
as $$
	select (monday - interval '7 days') at time zone 'Europe/Copenhagen',
		monday at time zone 'Europe/Copenhagen',
		(monday + interval '7 days') at time zone 'Europe/Copenhagen',
		extract(week from monday)::integer
	from (select date_trunc('week', p_at at time zone 'Europe/Copenhagen') as monday) local_week
$$;

revoke all on function public.qorpera_leaderboard_week(timestamptz) from public, anon, authenticated, service_role;

-- The board: you and your accepted friends who stay on the boards, and the
-- companies any of you are a member of. Tasks count from this week's Monday
-- 00:00 in Copenhagen; revenue is every good will month so far, in øre without
-- VAT. Last week's tasks (the seven days before this Monday) let the page show
-- who moved up or down. Each person's main company (their busiest this week,
-- else the one they joined first) gives the page their figure.
create function public.qorpera_friends_leaderboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_week record;
	v_since timestamptz;
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select * into v_week from public.qorpera_leaderboard_week(statement_timestamp());
	v_since := v_week.since;
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
		select member.profile_id, member.user_id, member.joined_at
		from public.qorpera_profile_members member
		join board on board.user_id = member.user_id
	),
	companies as (
		select profile.id as profile_id, profile.name,
			(select count(*) from public.qorpera_execution_runs run
				join public.qorpera_execution_run_results result on result.run_id = run.id
				where run.profile_id = profile.id and run.created_at >= v_since
					and result.company_disposition <> 'unchanged') as tasks,
			(select count(*) from public.qorpera_execution_runs run
				join public.qorpera_execution_run_results result on result.run_id = run.id
				where run.profile_id = profile.id
					and run.created_at >= v_week.last_since and run.created_at < v_since
					and result.company_disposition <> 'unchanged') as last_week_tasks,
			(select coalesce(sum(month.net_ore), 0) from public.qorpera_good_will_months month
				where month.profile_id = profile.id) as revenue_ore
		from public.qorpera_profiles profile
		where profile.id in (select profile_id from memberships)
	),
	people as (
		select account.id as user_id,
			left(public.qorpera_account_display_name(account.raw_user_meta_data), 160) as display_name,
			coalesce(presence.last_seen_at, account.last_sign_in_at) as last_seen_at,
			(select count(*) from memberships m where m.user_id = account.id) as company_count,
			(select coalesce(sum(c.tasks), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as tasks,
			(select coalesce(sum(c.last_week_tasks), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as last_week_tasks,
			(select coalesce(sum(c.revenue_ore), 0) from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id) as revenue_ore,
			(select c.profile_id from companies c
				join memberships m on m.profile_id = c.profile_id and m.user_id = account.id
				order by c.tasks desc, m.joined_at, c.profile_id limit 1) as main_profile_id
		from board
		join auth.users account on account.id = board.user_id
		left join public.qorpera_account_presence presence on presence.user_id = account.id
	)
	select jsonb_build_object(
		'since', v_since,
		'until', v_week.until,
		'week', v_week.week,
		'hidden', coalesce((select presence.leaderboard_hidden from public.qorpera_account_presence presence
			where presence.user_id = v_actor), false),
		'people', coalesce((select jsonb_agg(jsonb_build_object(
			'user_id', p.user_id,
			'display_name', p.display_name,
			'me', p.user_id = v_actor,
			'last_seen_at', p.last_seen_at,
			'companies', p.company_count,
			'tasks', p.tasks,
			'last_week_tasks', p.last_week_tasks,
			'revenue_ore', p.revenue_ore,
			'main_profile_id', p.main_profile_id
		) order by p.tasks desc, p.display_name) from people p), '[]'::jsonb),
		'companies', coalesce((select jsonb_agg(jsonb_build_object(
			'profile_id', c.profile_id,
			'name', c.name,
			'members', (select jsonb_agg(m.user_id order by m.user_id) from memberships m
				where m.profile_id = c.profile_id),
			'tasks', c.tasks,
			'last_week_tasks', c.last_week_tasks,
			'revenue_ore', c.revenue_ore
		) order by c.tasks desc, c.name) from companies c), '[]'::jsonb)
	) into v_result;
	return v_result;
end
$$;

revoke all on function public.qorpera_friends_leaderboard() from public, anon;
grant execute on function public.qorpera_friends_leaderboard() to authenticated;
