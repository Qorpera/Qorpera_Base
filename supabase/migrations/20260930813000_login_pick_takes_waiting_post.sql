do $$ begin
	if to_regclass('public.qorpera_wake_payer_moves') is not null then
		raise exception '20260930813000 is already applied'; end if;
	if to_regprocedure('public.qorpera_take_member_session_account(uuid,uuid,uuid,uuid,uuid,bigint,uuid)') is null
		or to_regprocedure('public.qorpera_member_session_waiting_turns(uuid,uuid,uuid)') is null then
		raise exception '20260930813000 needs the pick of all chats (20260930785000)'; end if;
	if strpos((select prosrc from pg_catalog.pg_proc where oid = 'public.qorpera_guard_wake_identity()'::regprocedure),
			'qorpera_execution_run_payer_moves') = 0 then
		raise exception '20260930813000 needs the recorded move of a waiting run (20260930703000)'; end if;
end $$;

set local lock_timeout = '3s';

create table public.qorpera_wake_payer_moves (
	id uuid primary key default extensions.gen_random_uuid(),
	wake_id uuid not null references public.qorpera_wake_occurrences(id) on delete cascade,
	profile_id uuid not null,
	session_id uuid not null,
	from_binding_id uuid not null,
	from_version bigint not null,
	from_connection_id uuid not null,
	to_binding_id uuid not null,
	to_version bigint not null,
	to_connection_id uuid not null,
	moved_by_user_id uuid not null,
	created_at timestamptz not null default now(),
	check (from_connection_id <> to_connection_id)
);
create index qorpera_wake_payer_moves_wake on public.qorpera_wake_payer_moves(wake_id, created_at);
alter table public.qorpera_wake_payer_moves enable row level security;
revoke all on public.qorpera_wake_payer_moves from public, anon, authenticated, service_role;
grant select on public.qorpera_wake_payer_moves to service_role;
comment on table public.qorpera_wake_payer_moves is
	'20260930813000: a member''s own post in a thread, waiting at their login''s usage limit, moved by their pick of another login.';

create function public.qorpera_member_session_waiting_posts(p_profile_id uuid, p_session_id uuid, p_user_id uuid)
returns table(wake_id uuid, binding_id uuid, sponsor_version bigint, connection_id uuid, allow_autonomous boolean)
language sql stable security definer set search_path = '' as $$
	select wake.id, wake.sponsor_binding_id, wake.sponsor_version, sponsor.provider_connection_id, sponsor.allow_autonomous
	from public.qorpera_wake_occurrences as wake
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = wake.sponsor_binding_id
		and sponsor.version = wake.sponsor_version
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
		and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id
	where wake.profile_id = p_profile_id and wake.status = 'queued' and wake.session_id = p_session_id
		and wake.run_id is null and wake.wake_kind = 'room' and wake.source_kind = 'room'
		and wake.requested_by_user_id = p_user_id and sponsor.sponsor_kind = 'member_connection'
		and public.qorpera_sponsor_waits_for_usage_limit(wake.sponsor_binding_id, wake.sponsor_version)
	order by wake.created_at, wake.id
$$;
revoke all on function public.qorpera_member_session_waiting_posts(uuid, uuid, uuid)
	from public, anon, authenticated, service_role;

create function pg_temp.wp813_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930813000 anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.wp813_patch('public.qorpera_guard_wake_identity()'::regprocedure,
	E'\t-- 20260930703000: the member''s own recorded move',
	E'\tif old.run_id is null and new.run_id is null and old.status = ''queued'' and new.status = ''queued''\n'
	|| E'\t\tand (new.sponsor_binding_id, new.sponsor_version) is distinct from (old.sponsor_binding_id, old.sponsor_version)\n'
	|| E'\t\tand (to_jsonb(new) - array[''sponsor_binding_id'', ''sponsor_version''])\n'
	|| E'\t\t\t= (to_jsonb(old) - array[''sponsor_binding_id'', ''sponsor_version''])\n'
	|| E'\t\tand exists (select 1 from public.qorpera_wake_payer_moves as move\n'
	|| E'\t\t\twhere move.wake_id = new.id and move.created_at = now()\n'
	|| E'\t\t\t\tand move.from_binding_id = old.sponsor_binding_id and move.from_version = old.sponsor_version\n'
	|| E'\t\t\t\tand move.to_binding_id = new.sponsor_binding_id and move.to_version = new.sponsor_version) then\n'
	|| E'\t\treturn new; end if;\n'
	|| E'\t-- 20260930703000: the member''s own recorded move');

drop function pg_temp.wp813_patch(regprocedure, text, text);

create or replace function public.qorpera_take_member_session_account(p_profile_id uuid, p_session_id uuid, p_user_id uuid,
	p_connection_id uuid, p_binding_id uuid, p_sponsor_version bigint, p_compute_identity_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_away boolean; v_post record;
begin
	insert into public.qorpera_member_session_accounts(profile_id, session_id, user_id, connection_id, sponsor_binding_id)
		values (p_profile_id, p_session_id, p_user_id, p_connection_id, p_binding_id)
		on conflict (profile_id, session_id, user_id) do update set
			connection_id = excluded.connection_id, sponsor_binding_id = excluded.sponsor_binding_id,
			selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
				then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
	if public.qorpera_connection_is_chatgpt_plan(p_connection_id) then return; end if;
	v_away := coalesce((select sponsor.allow_autonomous from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_binding_id and sponsor.version = p_sponsor_version), false);
	update public.qorpera_session_turn_requests as request
		set sponsor_binding_id = p_binding_id, sponsor_version = p_sponsor_version
		where request.id in (select locked.id from public.qorpera_session_turn_requests as locked
				where locked.id in (select waiting.request_id
					from public.qorpera_member_session_waiting_turns(p_profile_id, p_session_id, p_user_id) as waiting
					where waiting.connection_id <> p_connection_id
						and not public.qorpera_connection_is_chatgpt_plan(waiting.connection_id)
						and (not waiting.allow_autonomous or v_away))
				for update skip locked)
			and request.compute_identity_id = p_compute_identity_id;
	if not public.qorpera_sponsor_serves_requester(p_profile_id, p_binding_id, p_sponsor_version, p_user_id) then return; end if;
	for v_post in
		select waiting.wake_id, waiting.binding_id, waiting.sponsor_version, waiting.connection_id
		from public.qorpera_member_session_waiting_posts(p_profile_id, p_session_id, p_user_id) as waiting
		where waiting.connection_id <> p_connection_id
			and not public.qorpera_connection_is_chatgpt_plan(waiting.connection_id)
			and (not waiting.allow_autonomous or v_away)
	loop
		perform 1 from public.qorpera_wake_occurrences as wake
			where wake.id = v_post.wake_id and wake.status = 'queued' and wake.run_id is null
				and wake.sponsor_binding_id = v_post.binding_id and wake.sponsor_version = v_post.sponsor_version
			for update skip locked;
		continue when not found;
		insert into public.qorpera_wake_payer_moves(wake_id, profile_id, session_id, from_binding_id, from_version,
			from_connection_id, to_binding_id, to_version, to_connection_id, moved_by_user_id)
		values (v_post.wake_id, p_profile_id, p_session_id, v_post.binding_id, v_post.sponsor_version, v_post.connection_id,
			p_binding_id, p_sponsor_version, p_connection_id, p_user_id);
		update public.qorpera_wake_occurrences set sponsor_binding_id = p_binding_id, sponsor_version = p_sponsor_version
			where id = v_post.wake_id;
	end loop;
end $$;
revoke all on function public.qorpera_take_member_session_account(uuid, uuid, uuid, uuid, uuid, bigint, uuid)
	from public, anon, authenticated, service_role;

create trigger qorpera_wake_occurrences_sponsor_wake_orchestrators
	after update of sponsor_binding_id, sponsor_version on public.qorpera_wake_occurrences
	for each row when (new.status = 'queued'
		and (new.sponsor_binding_id, new.sponsor_version) is distinct from (old.sponsor_binding_id, old.sponsor_version))
	execute function public.qorpera_wake_runner_orchestrators_internal();
