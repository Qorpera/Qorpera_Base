-- Sign in with ChatGPT: a kernel guard for "work while you're away" on a ChatGPT plan (coordinator's ask after
-- #623; built switched off with plan logins).
--
-- The founder decided (2026-10-01) that a member's ChatGPT plan works while they are away only once they turn
-- that on themselves. The kernel never consents a plan for them (20260928359950), and the web does not either
-- (#623). But qorpera_consent_provider_connection_autonomous cannot tell the member's switch from an automatic
-- call, and a web build older than #623 consents every connection it binds, on every read of Settings. So:
-- 1. qorpera_consent_provider_connection_autonomous refuses to turn a ChatGPT plan on (55000) unless the call
--    comes through qorpera_set_chatgpt_plan_work_while_away. Turning a plan off, and every Codex login, are as
--    before. A plan already on reads as unchanged.
-- 2. qorpera_set_chatgpt_plan_work_while_away(profile, connection, on): the member's own choice for their plan
--    (the web's "Work while you're away" switch and the first-routine card's Turn on). It answers only for the
--    caller's own plan in that company (anything else reads as unavailable, so it never tells whether another
--    connection is a plan), marks the call for this transaction only (set_config, transaction-local; no API
--    role can set it) and makes the same consent, so the membership and current-version checks are the
--    consent call's own.
-- 3. qorpera_ensure_unattended_sponsor (an agent's routine save) reads the member's newest version again under
--    the connection lock. Its filter (20260929950000) could pass a plan its member was turning off at that
--    moment, and it then wrote a new "on" version in the member's name (#628 review).
--
-- Locks: none added. The marker is a transaction-local setting; the re-check runs under the lock ensure
-- already takes.

set local lock_timeout = '3s';

create function public.qorpera_set_chatgpt_plan_work_while_away(p_profile_id uuid, p_connection_id uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
	if auth.uid() is null or p_on is null or p_connection_id is null or p_profile_id is null
		or not exists (select 1 from public.qorpera_provider_connections as connection
			where connection.id = p_connection_id and connection.profile_id = p_profile_id
				and connection.owner_user_id = auth.uid())
		or not public.qorpera_connection_is_chatgpt_plan(p_connection_id) then
		raise exception 'ChatGPT plan login is unavailable' using errcode = '42501'; end if;
	perform set_config('qorpera.chatgpt_plan_member_choice', p_connection_id::text, true);
	v_result := public.qorpera_consent_provider_connection_autonomous(p_profile_id, p_connection_id, p_on);
	perform set_config('qorpera.chatgpt_plan_member_choice', '', true);
	return v_result;
end
$$;
revoke all on function public.qorpera_set_chatgpt_plan_work_while_away(uuid, uuid, boolean) from public, anon, service_role;
grant execute on function public.qorpera_set_chatgpt_plan_work_while_away(uuid, uuid, boolean) to authenticated;

create function pg_temp.qorpera_plan_guard_20260929980000_patch(p_function regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $patch$
declare
	v_definition text := pg_get_functiondef(p_function);
	v_count integer;
begin
	if position('20260929980000' in v_definition) > 0 then return; end if;
	v_count := (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor);
	if v_count <> 1 then
		raise exception '% source differs (anchor matches % times)', p_function, v_count; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$patch$;

select pg_temp.qorpera_plan_guard_20260929980000_patch(
	'public.qorpera_consent_provider_connection_autonomous(uuid,uuid,boolean)'::regprocedure,
	$a0$	v_next := v_version.version + 1;
$a0$, $r0$	-- A ChatGPT plan works while its member is away only by the member's own choice (20260929980000): turned on
	-- through qorpera_set_chatgpt_plan_work_while_away (their switch in Settings, or the first-routine card),
	-- never by this call alone. An older web build consents every connection it binds; for a plan that is
	-- refused here. Turning it off stays open.
	if p_allow_autonomous and public.qorpera_connection_is_chatgpt_plan(v_connection.id)
		and current_setting('qorpera.chatgpt_plan_member_choice', true) is distinct from v_connection.id::text then
		raise exception 'Turn on work while you''re away for this ChatGPT plan in Settings' using errcode = '55000';
	end if;
	v_next := v_version.version + 1;
$r0$);
select pg_temp.qorpera_plan_guard_20260929980000_patch(
	'public.qorpera_ensure_unattended_sponsor(public.qorpera_execution_runs)'::regprocedure,
	$a1$	if not found or v_version.authorization_state <> 'active' then return; end if;
	if not v_version.allow_autonomous then
$a1$, $r1$	if not found or v_version.authorization_state <> 'active' then return; end if;
	-- Read again under the lock (20260929980000): the filter above can pass a ChatGPT plan its member is turning off
	-- at this moment (it reads the row as it was before the lock wait). A plan that is off is never consented
	-- here; only its member turns it on.
	if not v_version.allow_autonomous and public.qorpera_connection_is_chatgpt_plan(v_connection.id) then return; end if;
	if not v_version.allow_autonomous then
$r1$);
