-- F1: a new coding session starts on its owner's login with the most room left. The body carries the marker
-- 20260930543000.
--
-- A coding session is paid by the login qorpera_coding_owner_login chooses among its owner's logins for the harness:
-- one whose newest version allows work while the member is away first (20260929992000), then one other than a ChatGPT
-- plan (20260929950000), then the newest. The worker rules read that choice and qorpera_coding_owner_sponsor pays
-- exactly it (20260930077000, C3a). The room left never counted: a member whose newest login had reached its usage
-- limit had each new coding session start on it, and stop there, while an older login of theirs had room. New
-- conversations and new work already start on the login with the most room left (qorpera_select_member_session_account
-- and qorpera_starter_sponsor, 20260930059000).
-- Now, after the consent and the plan, the login with the most room left comes first, in qorpera_starter_sponsor's
-- order for new work: a used-up login last, then the most room, unknown usage (-1) after measured room, then the newest
-- as before, then the connection's id. The room is qorpera_native_account_remaining of the login's newest active
-- version, the number the starter and the conversation choice read. So:
-- * only a new session's first choice changes. The index takes the payer once, at the dispatch
--   (qorpera_coding_owner_payer), and the worker keeps it: a follow-up, a member's answer and each turn's wake pay with
--   that pinned login, also at its usage limit, and nothing chooses again (the payer never changes without the member);
-- * which logins may pay, the refusals and the plan rule are unchanged. A used-up login still pays when the member has
--   no other (the work stops at its limit), and a member with no login that may work while away is refused as before.
-- The rules and the index read the choice in two statements, so a usage report between them can change it, as a
-- withdrawn consent could before: the sponsor and the payer hold the login that pays to the consent and plan rules, or
-- the commit fails whole.
--
-- Locks: none. The order reads the usage reports and signals without locks.

set local lock_timeout = '3s';

do $$
begin
	if position('20260930543000' in pg_get_functiondef('public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure)) = 0
		and position('order by not coalesce(version.allow_autonomous, false), public.qorpera_connection_is_chatgpt_plan(connection.id),
		connection.created_at desc' in pg_get_functiondef('public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure)) = 0 then
		raise exception 'The coding login changed after 20260930077000; rebase 20260930543000 on it'; end if;
	if position('qorpera_coding_owner_login(p_profile_id, p_owner_user_id, p_harness)'
		in pg_get_functiondef('public.qorpera_coding_owner_sponsor(uuid,uuid,text)'::regprocedure)) = 0 then
		raise exception 'The coding sponsor no longer pays qorpera_coding_owner_login''s choice'; end if;
end $$;

-- The login qorpera_coding_owner_sponsor pays a new coding session with: the owner's active connection for the harness
-- with an active version of its native harness; one allowed to work while its member is away first, then one that is not
-- a ChatGPT plan, then the one with the most room left (a used-up one last, unknown usage after measured room), then the
-- newest. With its newest active version.
create or replace function public.qorpera_coding_owner_login(p_profile_id uuid, p_owner_user_id uuid, p_harness text)
returns table(connection_id uuid, connection_version bigint, allow_autonomous boolean)
language sql stable security definer set search_path = '' as $$
	-- 20260930077000 (C3a). 20260930543000: by the room left, as qorpera_starter_sponsor orders new work.
	select connection.id, version.version, version.allow_autonomous
	from public.qorpera_provider_connections connection
	cross join lateral (select v.version, v.allow_autonomous from public.qorpera_provider_connection_versions v
		where v.connection_id = connection.id and v.authorization_state = 'active'
			and v.native_harness = case p_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end
		order by v.version desc limit 1) version
	cross join lateral (select public.qorpera_native_account_remaining(connection.id, version.version) as remaining) usage
	where connection.profile_id = p_profile_id and connection.owner_user_id = p_owner_user_id
		and connection.provider = case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end
		and connection.status = 'active'
	order by not coalesce(version.allow_autonomous, false), public.qorpera_connection_is_chatgpt_plan(connection.id),
		usage.remaining = 0, usage.remaining desc, connection.created_at desc, connection.id
	limit 1
$$;
revoke all on function public.qorpera_coding_owner_login(uuid, uuid, text) from public, anon, authenticated, service_role;
