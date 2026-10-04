-- Realtime policies match the row's topic to the joined topic (follow-up to the review of #742, folder core P30,
-- finding 2).
--
-- Realtime checks a private channel join by reading (or writing) realtime.messages as the joining user, with
-- realtime.topic() set to the topic being joined. Postgres joins all of a table's policies with OR. So a policy that
-- only asks whether the user may join realtime.topic(), and not whether the row is on that topic, lets a user who may
-- join one topic see the rows of every other topic through it.
--
-- The presence policies (20260819011000) and the room drafts policy (20260928000500) were written that way: a member
-- joined to their company's presence topic could read the broadcasts of any other topic (a folder hint, a room's
-- drafts, another company's presence), and could write a broadcast onto another topic, such as a room's drafts topic
-- where only the database may publish. A member joined to a room's drafts topic could read the broadcasts of every
-- other topic too. Realtime's own join check only uses rows of the joined topic, so no client is known to have reached
-- them, but the rule belongs in the policies. The newer policies (orchestrator wake 20260928319550, folder hint
-- 20260930013100) already have it.
--
-- Each policy is dropped and created again with the same roles and membership checks plus
-- `realtime.messages.topic = (select realtime.topic())`, inside this migration's transaction, so there is no moment
-- without a policy.
set local lock_timeout = '3s';

drop policy qorpera_presence_member_receive on realtime.messages;
create policy qorpera_presence_member_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension in ('presence', 'broadcast')
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_can_read_profile(public.qorpera_presence_topic_profile(realtime.topic()))
	);

-- Publishing (presence track + typing broadcast) is gated on membership, not write role: read-only members
-- legitimately appear as viewers. A member publishes only on the presence topic they joined.
drop policy qorpera_presence_member_publish on realtime.messages;
create policy qorpera_presence_member_publish
	on realtime.messages
	for insert
	to authenticated
	with check (
		realtime.messages.extension in ('presence', 'broadcast')
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_can_read_profile(public.qorpera_presence_topic_profile(realtime.topic()))
	);

-- Members receive a room's draft changes. There is still no insert policy for this topic: only the cloud
-- (qorpera_put_room_draft, through realtime.send) publishes.
drop policy qorpera_room_drafts_member_receive on realtime.messages;
create policy qorpera_room_drafts_member_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_can_share_room_draft(public.qorpera_room_drafts_topic_room(realtime.topic()))
	);
