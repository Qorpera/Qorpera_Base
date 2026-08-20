-- Presence hardening: the lossy lane goes private (SESSIONS.md, PR #59 note).
--
-- The presence topic `qorpera-presence-<profile id>` shipped as a PUBLIC
-- Realtime channel: anyone holding the project's anon key could join, watch
-- who has which staff thread open, and spoof typing events. Realtime
-- authorization closes that: the shell now joins the topic as a PRIVATE
-- channel, and Realtime authorizes the join by evaluating these policies on
-- realtime.messages as the connecting user — receive (select) and publish
-- (insert) both require profile membership.
--
-- Rollout: this migration is additive. Shells still on the public topic keep
-- working (the public channel is untouched); enforcement lands as each
-- machine updates to the private-channel client. Presence stays lossy and
-- unstored — these rows are Realtime's authorization surface, not durable
-- state.

create function public.qorpera_presence_topic_profile(p_topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
	select case
		when p_topic ~ '^qorpera-presence-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then substring(p_topic from 18)::uuid
	end
$$;

revoke all on function public.qorpera_presence_topic_profile(text) from public, anon;
grant execute on function public.qorpera_presence_topic_profile(text) to authenticated;

create policy qorpera_presence_member_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension in ('presence', 'broadcast')
		and public.qorpera_can_read_profile(public.qorpera_presence_topic_profile(realtime.topic()))
	);

-- Publishing (presence track + typing broadcast) is gated on membership, not
-- write role: read-only members legitimately appear as viewers, and typing
-- without send access is refused where it matters — the durable lane.
create policy qorpera_presence_member_publish
	on realtime.messages
	for insert
	to authenticated
	with check (
		realtime.messages.extension in ('presence', 'broadcast')
		and public.qorpera_can_read_profile(public.qorpera_presence_topic_profile(realtime.topic()))
	);
