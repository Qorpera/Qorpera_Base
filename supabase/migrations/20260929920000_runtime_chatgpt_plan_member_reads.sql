-- Sign in with ChatGPT, slice 5a (founder decisions 2026-10-01; built switched off with the login kind,
-- 20260928329830): what the web client needs to keep a member's ChatGPT plan login apart from a Codex login.
--
-- 1. The member's connection list names each login's kind (`login_kind`: codex or chatgpt_plan; null for a
--    node login), whether its member turned on work while away (`allow_autonomous`, the version's consent),
--    and when the first-routine card was shown for it (`routine_offer_shown_at`). The client parser reads
--    named fields, so extra keys change nothing for an older client.
-- 2. The first-routine card is shown once per member and company (founder, 2026-10-01: when an agent first
--    sets up a routine the member's plan would pay for, a card helps them turn on work while away). The web
--    records the showing with qorpera_record_chatgpt_plan_routine_offer; "Not now" never brings it back, also
--    after the member signs in to their plan again (a new connection).
-- 3. The routine list names a paused routine's reason and the member its current version runs for
--    (`runs_for_user_id`), so the web can find the member's routine that waits for a payer
--    (`needs_model_account`).
-- The web keeps all of it out of sight while plan logins are switched off.
--
-- Locks: none added. A showing inserts one row; its foreign key takes a key-share lock on the plan login's
-- connection only (no link to the company row, which the purge locks before the connections).

set local lock_timeout = '3s';

-- A row per plan login whose member was shown the card. The connection names its member (no link to the account,
-- so an account deletion reaches nothing here, 20260928249180) and its company (the purge removes the row with
-- the connection).
create table public.qorpera_chatgpt_plan_routine_offers (
	connection_id uuid primary key references public.qorpera_provider_connections(id) on delete cascade,
	profile_id uuid not null,
	shown_at timestamptz not null default statement_timestamp()
);
create index qorpera_chatgpt_plan_routine_offers_profile on public.qorpera_chatgpt_plan_routine_offers(profile_id);
alter table public.qorpera_chatgpt_plan_routine_offers enable row level security;
revoke all on public.qorpera_chatgpt_plan_routine_offers from public, anon, authenticated, service_role;

-- When a member of a company was first shown the card, on any of their plan logins there.
create function public.qorpera_chatgpt_plan_routine_offer_shown(p_profile_id uuid, p_user_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select min(offer.shown_at) from public.qorpera_chatgpt_plan_routine_offers as offer
	join public.qorpera_provider_connections as connection on connection.id = offer.connection_id
	where offer.profile_id = p_profile_id and connection.profile_id = p_profile_id
		and connection.owner_user_id = p_user_id
$$;
revoke all on function public.qorpera_chatgpt_plan_routine_offer_shown(uuid, uuid) from public, anon, authenticated, service_role;

-- Records that the first-routine card was shown to the caller, for their own active ChatGPT plan login in a
-- company they are a member of (not one being deleted). Once per member: a repeat, also on a later plan login,
-- answers the first showing.
create function public.qorpera_record_chatgpt_plan_routine_offer(p_profile_id uuid, p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_shown timestamptz;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null
		or public.qorpera_member_role(p_profile_id) is null
		or not exists (select 1 from public.qorpera_provider_connections as connection
			where connection.id = p_connection_id and connection.profile_id = p_profile_id
				and connection.owner_user_id = v_user and connection.status = 'active') then
		raise exception 'ChatGPT plan login is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_provider_connection_versions as version
		join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
		where version.connection_id = p_connection_id and login.login_kind = 'chatgpt_plan'
			and version.version = (select max(newest.version) from public.qorpera_provider_connection_versions as newest
				where newest.connection_id = p_connection_id)) then
		raise exception 'Not a ChatGPT plan login' using errcode = '22023'; end if;
	v_shown := public.qorpera_chatgpt_plan_routine_offer_shown(p_profile_id, v_user);
	if v_shown is null then
		insert into public.qorpera_chatgpt_plan_routine_offers(connection_id, profile_id)
		values (p_connection_id, p_profile_id)
		on conflict (connection_id) do nothing;
		v_shown := public.qorpera_chatgpt_plan_routine_offer_shown(p_profile_id, v_user);
	end if;
	return jsonb_build_object('connection_id', p_connection_id, 'shown_at', v_shown);
end
$$;
revoke all on function public.qorpera_record_chatgpt_plan_routine_offer(uuid, uuid) from public, anon, service_role;
grant execute on function public.qorpera_record_chatgpt_plan_routine_offer(uuid, uuid) to authenticated;

create function pg_temp.qorpera_plan_reads_20260929920000_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target); v_count integer;
begin
	if position('20260929920000' in v_definition) > 0 then return; end if;
	for v_index in 1 .. array_length(p_pairs, 1) / 2 loop
		v_count := (length(v_definition) - length(replace(v_definition, p_pairs[2 * v_index - 1], '')))
			/ length(p_pairs[2 * v_index - 1]);
		if v_count <> 1 then
			raise exception '% source differs (anchor % matches % times)', p_target, v_index, v_count; end if;
		v_definition := replace(v_definition, p_pairs[2 * v_index - 1], p_pairs[2 * v_index]);
	end loop;
	execute v_definition;
end
$patch$;

select pg_temp.qorpera_plan_reads_20260929920000_patch('public.qorpera_list_member_native_execution_connections(uuid)'::regprocedure, array[
	$a0$				'billing_source', version.billing_source,
$a0$,
	$r0$				'billing_source', version.billing_source,
				-- Sign in with ChatGPT (20260929920000): the login's kind (null for a node login), whether its member
				-- turned on work while away for this version, and when the member's first-routine card was shown.
				'login_kind', (select login.login_kind from public.qorpera_model_logins as login
					where login.credential_capsule_id = version.credential_capsule_id),
				'allow_autonomous', version.allow_autonomous,
				'routine_offer_shown_at', public.qorpera_chatgpt_plan_routine_offer_shown(connection.profile_id,
					connection.owner_user_id),
$r0$]);

select pg_temp.qorpera_plan_reads_20260929920000_patch('public.qorpera_list_cloud_routines(uuid)'::regprocedure, array[
	$a0$			'status', routine.status,
$a0$,
	$r0$			'status', routine.status,
			-- Why a paused routine waits, and the member its current version runs for (20260929920000).
			'pause_reason', routine.pause_reason,
			'runs_for_user_id', version.created_by_user_id,
$r0$]);
