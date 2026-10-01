-- Sign in with ChatGPT, slice 5a (founder decisions 2026-10-01; built switched off with the login kind,
-- 20260928329830): what the web client needs to keep a member's ChatGPT plan login apart from a Codex login.
--
-- 1. The member's connection list names each login's kind (`login_kind`: codex or chatgpt_plan; null for a
--    node login), whether its member turned on work while away (`allow_autonomous`, the version's consent),
--    and when the first-routine card was shown for it (`routine_offer_shown_at`). The client parser reads
--    named fields, so extra keys change nothing for an older client.
-- 2. The first-routine card is shown once per plan login (founder, 2026-10-01: when an agent first sets up
--    a routine the member's plan would pay for, a card helps them turn on work while away). The web records
--    the showing with qorpera_record_chatgpt_plan_routine_offer; "Not now" never brings it back.
-- 3. The routine list names a paused routine's reason and the member it runs for, so the web can find the
--    member's routine that waits for a payer (`needs_model_account`).
-- The web keeps all of it out of sight while plan logins are switched off.
--
-- Locks: none added. The offer insert touches one new row per plan login.

set local lock_timeout = '3s';

create table public.qorpera_chatgpt_plan_routine_offers (
	connection_id uuid primary key references public.qorpera_provider_connections(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	shown_at timestamptz not null default statement_timestamp()
);
alter table public.qorpera_chatgpt_plan_routine_offers enable row level security;
revoke all on public.qorpera_chatgpt_plan_routine_offers from public, anon, authenticated, service_role;

-- Records that the first-routine card was shown for the caller's own ChatGPT plan login. Once only: a repeat
-- answers the first showing.
create function public.qorpera_record_chatgpt_plan_routine_offer(p_profile_id uuid, p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_shown timestamptz;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null
		or not exists (select 1 from public.qorpera_provider_connections as connection
			where connection.id = p_connection_id and connection.profile_id = p_profile_id
				and connection.owner_user_id = v_user)
		or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = v_user) then
		raise exception 'ChatGPT plan login is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_provider_connection_versions as version
		join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
		where version.connection_id = p_connection_id and login.login_kind = 'chatgpt_plan') then
		raise exception 'Not a ChatGPT plan login' using errcode = '22023'; end if;
	insert into public.qorpera_chatgpt_plan_routine_offers(connection_id, profile_id, user_id)
	values (p_connection_id, p_profile_id, v_user)
	on conflict (connection_id) do nothing;
	select offer.shown_at into strict v_shown from public.qorpera_chatgpt_plan_routine_offers as offer
	where offer.connection_id = p_connection_id;
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
				-- turned on work while away for this version, and when the first-routine card was shown.
				'login_kind', (select login.login_kind from public.qorpera_model_logins as login
					where login.credential_capsule_id = version.credential_capsule_id),
				'allow_autonomous', version.allow_autonomous,
				'routine_offer_shown_at', (select offer.shown_at from public.qorpera_chatgpt_plan_routine_offers as offer
					where offer.connection_id = connection.id),
$r0$]);

select pg_temp.qorpera_plan_reads_20260929920000_patch('public.qorpera_list_cloud_routines(uuid)'::regprocedure, array[
	$a0$			'status', routine.status,
$a0$,
	$r0$			'status', routine.status,
			-- Why a paused routine waits, and the member it runs for (20260929920000).
			'pause_reason', routine.pause_reason,
			'created_by_user_id', routine.created_by_user_id,
$r0$]);
