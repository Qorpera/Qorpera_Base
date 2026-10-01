-- Sign in with ChatGPT, switch-on gate 1: coding takes a login that may work while its member is away.
--
-- qorpera_coding_owner_sponsor picks the coding session's payer among the asking member's logins: a login other
-- than a ChatGPT plan first, then the newest (20260929950000). It then refuses (42501 "The session owner has not
-- allowed background work on their ... account") when that one login's newest version does not allow work while
-- away, without looking at the member's other logins. So:
-- * a run a member's ChatGPT plan pays for, whose member also has a Codex login that was never allowed to work
--   while away, had its coding refused although the plan could pay (Sign in with ChatGPT; switched off);
-- * live for Codex and Claude Code logins (a bug fix): a member whose newest login for that tool does not allow work
--   while away (never allowed, or turned off since), but who has another login that does, had their coding refused.
-- Now the logins whose newest version allows it come first. Everything else is as before: a plan still comes after
-- any other login that may work while away, pays only for work started on it (qorpera_manage_agent_worker's
-- 55000), and a member with no login that may work while away is refused as before.
--
-- Locks: none added. The order reads the versions without locks, as the chosen login's version was read before.

set local lock_timeout = '3s';

do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_coding_owner_sponsor(uuid,uuid,text)'::regprocedure);
	v_anchor text := $a0$	-- A login other than a ChatGPT plan first (20260929950000): a plan pays for coding only of work started on it.
	order by public.qorpera_connection_is_chatgpt_plan(connection.id), connection.created_at desc limit 1;
$a0$;
	v_count integer;
begin
	if position('20260929992000' in v_definition) > 0 then return; end if;
	v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
	if v_count <> 1 then
		raise exception 'The coding payer''s source differs (anchor matches % times)', v_count; end if;
	execute replace(v_definition, v_anchor, $r0$	-- A login that may work while its member is away first (20260929992000): one that may not is refused below, even
	-- when another of the member's logins could pay. Then a login other than a ChatGPT plan (20260929950000): a
	-- plan pays for coding only of work started on it. Then the newest.
	order by not coalesce((select v.allow_autonomous from public.qorpera_provider_connection_versions v
			where v.connection_id = connection.id and v.authorization_state = 'active' and v.native_harness = v_native
			order by v.version desc limit 1), false),
		public.qorpera_connection_is_chatgpt_plan(connection.id), connection.created_at desc limit 1;
$r0$);
end
$patch$;
