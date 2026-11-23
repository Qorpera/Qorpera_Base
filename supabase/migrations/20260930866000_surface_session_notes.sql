-- WHY: Members work together in one surface session: they see whose turn runs and can leave each other quiet notes
-- ("@Jonas ...") that never reach the agent and never wake the session (founder, 23 November 2026).
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)') is null
		or to_regclass('public.qorpera_surface_message_images') is null then
		raise exception '20260930866000 requires 20260930862000 and 20260930865000';
	end if;
	if to_regclass('public.qorpera_surface_note_recipients') is not null then
		raise exception '20260930866000 is already applied';
	end if;
end $$;

create function pg_temp.ssn_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930866000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930866000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surface_session_messages
	drop constraint qorpera_surface_session_messages_author_kind_check,
	add constraint qorpera_surface_session_messages_author_kind_check
		check (author_kind in ('member', 'session', 'system', 'note'));

create table public.qorpera_surface_note_recipients (
	message_id uuid not null references public.qorpera_surface_session_messages(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	seen_at timestamptz,
	primary key (message_id, user_id)
);
create index qorpera_surface_note_recipients_unseen
	on public.qorpera_surface_note_recipients(user_id, profile_id, session_id) where seen_at is null;
alter table public.qorpera_surface_note_recipients enable row level security;
revoke all on public.qorpera_surface_note_recipients from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$ begin
	if to_regprocedure('public.qorpera_live_hint_internal()') is not null then
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_note_recipients
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
	end if;
end $$;

select pg_temp.ssn_patch('public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure, array[
$old$'createdByUserId', p_session.created_by_user_id,$old$,
$new$'createdByUserId', p_session.created_by_user_id,
		'turnRequestedByUserId', public.qorpera_surface_turn_requester(p_session),$new$,
$old$'changeId', m.change_id,$old$,
$new$'changeId', m.change_id,
				'noteTo', case when m.author_kind = 'note' then (
					select coalesce(jsonb_agg(r.user_id order by r.user_id), '[]'::jsonb)
					from public.qorpera_surface_note_recipients r
					where r.message_id = m.id
				) end,$new$
]);

create function public.qorpera_surface_session_note(p_session_id uuid, p_message text, p_to uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_user_id uuid;
	v_body text := btrim(coalesce(p_message, ''));
	v_to uuid[];
	v_message_id uuid;
begin
	if char_length(v_body) < 1 then
		raise exception 'Message cannot be empty' using errcode = '22023';
	end if;
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_session.profile_id, true);
	select coalesce(array_agg(distinct recipient), '{}'::uuid[]) into v_to
	from unnest(coalesce(p_to, '{}'::uuid[])) recipient
	where recipient is not null;
	if cardinality(v_to) not between 1 and 16 or v_user_id = any(v_to) then
		raise exception 'A note names one to sixteen teammates' using errcode = '22023';
	end if;
	if exists (
		select 1 from unnest(v_to) recipient
		where not exists (
			select 1 from public.qorpera_profile_members m
			where m.profile_id = v_session.profile_id and m.user_id = recipient
		)
	) then
		raise exception 'A note can only name members of this company' using errcode = '42501';
	end if;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_session.profile_id, v_session.id, 'note', v_user_id, v_body)
	returning id into v_message_id;
	insert into public.qorpera_surface_note_recipients(message_id, user_id, profile_id, surface_id, session_id)
	select v_message_id, recipient, v_session.profile_id, v_session.surface_id, v_session.id
	from unnest(v_to) recipient;

	return public.qorpera_surface_session_json(v_session);
end $$;

create function public.qorpera_surface_unseen_notes(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_user_id uuid := public.qorpera_assert_surface_member(p_profile_id, false);
begin
	return coalesce((
		select jsonb_agg(jsonb_build_object('surfaceId', unseen.surface_id, 'sessionId', unseen.session_id, 'count', unseen.n)
			order by unseen.surface_id, unseen.session_id)
		from (
			select r.surface_id, r.session_id, count(*)::integer as n
			from public.qorpera_surface_note_recipients r
			where r.user_id = v_user_id and r.profile_id = p_profile_id and r.seen_at is null
			group by r.surface_id, r.session_id
		) unseen
	), '[]'::jsonb);
end $$;

create function public.qorpera_surface_notes_seen(p_session_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid;
	v_user_id uuid;
	v_count integer;
begin
	select s.profile_id into v_profile_id from public.qorpera_surface_sessions s where s.id = p_session_id;
	if v_profile_id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_profile_id, false);
	update public.qorpera_surface_note_recipients
	set seen_at = clock_timestamp()
	where session_id = p_session_id and user_id = v_user_id and seen_at is null;
	get diagnostics v_count = row_count;
	return v_count;
end $$;

revoke all on function
	public.qorpera_surface_session_note(uuid, text, uuid[]),
	public.qorpera_surface_unseen_notes(uuid),
	public.qorpera_surface_notes_seen(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function
	public.qorpera_surface_session_note(uuid, text, uuid[]),
	public.qorpera_surface_unseen_notes(uuid),
	public.qorpera_surface_notes_seen(uuid)
	to authenticated;

do $$
declare
	v_owner name := (
		select pg_get_userbyid(proowner) from pg_proc
		where oid = 'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure
	);
begin
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'Surface session json has an API owner: %', v_owner;
	end if;
	execute format('grant execute on function public.qorpera_surface_turn_requester(public.qorpera_surface_sessions) to %I', v_owner);
end $$;

drop function pg_temp.ssn_patch(regprocedure, text[]);
