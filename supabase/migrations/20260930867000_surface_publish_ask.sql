-- WHY: A member can ask a teammate to publish a surface instead of publishing it now (founder, 23 November 2026, "yes to
-- all five, build it"). The teammate's yes is her own publish; an ask closes when anyone publishes or nothing is left.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_publish_surface(uuid)') is null
		or to_regprocedure('public.qorpera_surface_summary_json(public.qorpera_surfaces)') is null
		or to_regprocedure('public.qorpera_live_hint_internal()') is null then
		raise exception '20260930867000 requires 20260930843000 and 20260930860000';
	end if;
	if to_regclass('public.qorpera_surface_publish_asks') is not null then
		raise exception '20260930867000 is already applied';
	end if;
end $$;

create function pg_temp.spa_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930867000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930867000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create table public.qorpera_surface_publish_asks (
	surface_id uuid primary key references public.qorpera_surfaces(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	asked_by_user_id uuid not null references auth.users(id) on delete cascade,
	asked_user_id uuid not null references auth.users(id) on delete cascade,
	asked_at timestamptz not null default clock_timestamp(),
	change_count integer not null check (change_count >= 0),
	head_sha text check (head_sha is null or char_length(head_sha) <= 64),
	status text not null default 'open' check (status in ('open', 'declined')),
	answered_at timestamptz,
	check (asked_by_user_id <> asked_user_id),
	check ((status = 'open') = (answered_at is null))
);
alter table public.qorpera_surface_publish_asks enable row level security;
revoke all on public.qorpera_surface_publish_asks from public, anon, authenticated, service_role, qorpera_secret_broker;

create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_publish_asks
	deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');

create function public.qorpera_surface_member_may_publish(p_profile_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = p_profile_id and member.user_id = p_user_id and member.role <> 'viewer'
	)
$$;
revoke all on function public.qorpera_surface_member_may_publish(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_close_publish_asks()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	delete from public.qorpera_surface_publish_asks where surface_id = new.id;
	return null;
end $$;
revoke all on function public.qorpera_surface_close_publish_asks()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create trigger qorpera_surfaces_close_publish_asks
	after update of publish_status, unpublished_change_count, live_head_sha, published_head_sha on public.qorpera_surfaces
	for each row when (
		new.publish_status = 'publishing'
		or (new.unpublished_change_count = 0
			and (new.live_head_sha is null or new.live_head_sha is not distinct from new.published_head_sha))
	)
	execute function public.qorpera_surface_close_publish_asks();

select pg_temp.spa_patch('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure, array[
$old$		'needsAttentionCount', coalesce(stats.attention_sessions, 0) + coalesce(change_stats.conflicted_changes, 0),$old$,
$new$		'needsAttentionCount', coalesce(stats.attention_sessions, 0) + coalesce(change_stats.conflicted_changes, 0),
		'publishAsk', (
			select jsonb_build_object(
				'askedByUserId', ask.asked_by_user_id,
				'askedUserId', ask.asked_user_id,
				'askedAt', ask.asked_at,
				'changeCount', ask.change_count,
				'status', ask.status,
				'answeredAt', ask.answered_at
			)
			from public.qorpera_surface_publish_asks ask
			where ask.surface_id = p_surface.id
		),$new$
]);

create function public.qorpera_ask_surface_publish(p_surface_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);
	if p_user_id is null or p_user_id = v_user_id then
		raise exception 'Ask a teammate other than yourself' using errcode = '22023';
	end if;
	if not public.qorpera_surface_member_may_publish(v_surface.profile_id, p_user_id) then
		raise exception 'That teammate cannot publish' using errcode = '42501';
	end if;
	if v_surface.auto_publish then
		raise exception 'This surface publishes on Approve' using errcode = '55000';
	end if;
	if v_surface.publish_status = 'publishing' then
		raise exception 'A publish is already running' using errcode = '55000';
	end if;
	if not (
		v_surface.unpublished_change_count > 0
		or (v_surface.live_head_sha is not null and v_surface.live_head_sha is distinct from v_surface.published_head_sha)
	) then
		raise exception 'Nothing to publish' using errcode = '55000';
	end if;

	insert into public.qorpera_surface_publish_asks(
		surface_id, profile_id, asked_by_user_id, asked_user_id, change_count, head_sha
	)
	values (
		v_surface.id, v_surface.profile_id, v_user_id, p_user_id, v_surface.unpublished_change_count, v_surface.live_head_sha
	)
	on conflict (surface_id) do update set
		asked_by_user_id = excluded.asked_by_user_id,
		asked_user_id = excluded.asked_user_id,
		asked_at = clock_timestamp(),
		change_count = excluded.change_count,
		head_sha = excluded.head_sha,
		status = 'open',
		answered_at = null;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_ask_surface_publish(uuid, uuid) from public, anon;
grant execute on function public.qorpera_ask_surface_publish(uuid, uuid) to authenticated;

create function public.qorpera_decline_surface_publish_ask(p_surface_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);
	update public.qorpera_surface_publish_asks
	set status = 'declined', answered_at = clock_timestamp()
	where surface_id = p_surface_id and asked_user_id = v_user_id and status = 'open';
	if not found then raise exception 'No ask to answer' using errcode = 'P0002'; end if;
	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_decline_surface_publish_ask(uuid) from public, anon;
grant execute on function public.qorpera_decline_surface_publish_ask(uuid) to authenticated;

create function public.qorpera_withdraw_surface_publish_ask(p_surface_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);
	delete from public.qorpera_surface_publish_asks
	where surface_id = p_surface_id and asked_by_user_id = v_user_id;
	if not found then raise exception 'No ask to take back' using errcode = 'P0002'; end if;
	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_withdraw_surface_publish_ask(uuid) from public, anon;
grant execute on function public.qorpera_withdraw_surface_publish_ask(uuid) to authenticated;
