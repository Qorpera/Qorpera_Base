-- Perf T3 (8 Nov 2026): the web's change hints by push, with every access check where it was.
--
-- Today an open company tab learns that its sessions, agents, team, Company File or sidebar changed through Realtime
-- `postgres_changes` on five published tables. Realtime finds those changes by polling the WAL twice a second while any
-- such subscriber is connected (`realtime.list_changes`, about 10 % of all database time, 3-7 Nov), and a change
-- reaches the tab 246 ms after its commit on average, 488 ms at p95 (test VM, perf D3).
--
-- From here the database also pushes each hint itself, on the broadcast path Realtime already runs for folder hints,
-- presence and room drafts: a row in realtime.messages, read from the WAL by Realtime's own walsender at commit, no
-- polling. A hint says only which resource changed (event `sessions`, `staff`, `access`, `company-file` or `sidebar`,
-- payload {"schema":"qorpera.live-hint/v1"}): no row, no id. The tab then reads again through its RPCs, as before.
--
-- Where the checks are:
-- - Who receives a change: decided per change, as Realtime decided it per change for postgres_changes. Each topic
--   belongs to one member of one company (`qorpera-live-<profileId>-<userId>`), and a change is sent only to the
--   topics of the members who may read the changed row under that table's own read policy, at commit: the policy's
--   rule written for each member (qorpera_live_hint_*_topics below; test 1153 checks each against the real policy,
--   row by row and member by member). A member who leaves gets no hint about the company from that commit on. They
--   still get the hint about their own access row, which they may read (the access policy's `user_id = auth.uid()`),
--   as postgres_changes gave it to them.
-- - Who may join a topic: only its own member (the topic names them), and only while they may read a row the topic
--   carries hints about: a member of the company, or the subject of an access row in it (the union of the five
--   tables' rules). Checked by Realtime at join and again at each token refresh (RLS on realtime.messages, private
--   channel; a public channel of the same name is another Realtime topic and receives nothing).
-- - Nobody publishes on these topics but the database: no insert policy.
--
-- When: a deferred constraint trigger per row, so the audience is read at commit, against the committed membership,
-- as Realtime read it after commit. A change and a removal in one transaction send the removed member nothing but
-- their access hint. One hint per topic and resource per transaction, however many rows moved; a row whose readers
-- were already sent to in the transaction costs a string search.
--
-- Cost in the writing transaction: at commit, once per company, resource and readers' class, one primary-key read
-- where the rule reads mutable columns (sessions, agents), the company's members by primary key, and one insert per
-- new topic into realtime.messages.
-- Every failure is absorbed under a 20 ms lock budget, a missing Realtime included, as the folder hint does
-- (20260928469260): a hint never fails or holds up a commit. A missed hint is normal; the web keeps its slow poll.
--
-- The publication stays: web tabs from before this change keep postgres_changes until they close, and the new web falls
-- back to it when its join is refused (a database without this migration). Roll: this migration first, then the web.
-- Undo: the web first (it falls back by itself on a refused join), then drop the triggers, the policy and the functions.

-- The topic of one member's hints for one company. The web makes the same name.
create function public.qorpera_live_hint_topic(p_profile_id uuid, p_user_id uuid)
returns text language sql immutable set search_path = '' as $$
	select 'qorpera-live-' || p_profile_id::text || '-' || p_user_id::text
$$;
revoke all on function public.qorpera_live_hint_topic(uuid, uuid) from public, anon, authenticated, service_role;

-- The company of `p_user_id`'s own hint topic, or null for any other topic (another member's, another family's, a
-- malformed one).
create function public.qorpera_live_hint_topic_profile(p_topic text, p_user_id uuid)
returns uuid language sql immutable set search_path = '' as $$
	select case when p_topic ~ '^qorpera-live-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then case when substring(p_topic from 51) = p_user_id::text then substring(p_topic from 14 for 36)::uuid end
	end
$$;
revoke all on function public.qorpera_live_hint_topic_profile(text, uuid) from public, anon, authenticated, service_role;

-- Whether the caller may receive a topic: their own topic, for a company they are a member of or have an access row in.
create function public.qorpera_live_hint_member(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
	-- perf T3 (20260930653000)
	select coalesce((
		select exists (select 1 from public.qorpera_profile_members as member
				where member.profile_id = topic.profile_id and member.user_id = auth.uid())
			or exists (select 1 from public.qorpera_profile_access_state as access
				where access.profile_id = topic.profile_id and access.user_id = auth.uid())
		from (select public.qorpera_live_hint_topic_profile(p_topic, auth.uid()) as profile_id) as topic
		where topic.profile_id is not null), false)
$$;
revoke all on function public.qorpera_live_hint_member(text) from public, anon, service_role;
grant execute on function public.qorpera_live_hint_member(text) to authenticated;

create policy qorpera_live_hint_member_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_live_hint_member(realtime.topic())
	);

-- The members of a company who pass qorpera_can_read_profile: a member, while the company is not being deleted
-- (qorpera_member_role).
create function public.qorpera_live_hint_profile_topics(p_profile_id uuid)
returns text[] language sql stable set search_path = '' as $$
	select coalesce(array_agg(public.qorpera_live_hint_topic(member.profile_id, member.user_id)), '{}')
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id
		and not exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = p_profile_id)
$$;
-- qorpera_sessions_audience_read, qorpera_can_read_session: a member of the session's company, and for a member's own
-- session that member.
create function public.qorpera_live_hint_session_topics(p_profile_id uuid, p_audience_kind text, p_audience_user_id uuid)
returns text[] language sql stable set search_path = '' as $$
	select coalesce(array_agg(public.qorpera_live_hint_topic(member.profile_id, member.user_id)), '{}')
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id
		and (p_audience_kind = 'company' or (p_audience_kind = 'member_private' and member.user_id = p_audience_user_id))
$$;
-- qorpera_profile_staff_member_read: a member of the company, while the agent is not deleted.
create function public.qorpera_live_hint_staff_topics(p_profile_id uuid, p_deleted boolean)
returns text[] language sql stable set search_path = '' as $$
	select coalesce(array_agg(public.qorpera_live_hint_topic(member.profile_id, member.user_id)), '{}')
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and p_deleted is false
$$;
-- qorpera_profile_access_state_subject_or_member_read: the row's own account, or whoever passes qorpera_can_read_profile.
create function public.qorpera_live_hint_access_topics(p_profile_id uuid, p_user_id uuid)
returns text[] language sql stable set search_path = '' as $$
	select array(select distinct topic from unnest(array_append(public.qorpera_live_hint_profile_topics(p_profile_id),
		public.qorpera_live_hint_topic(p_profile_id, p_user_id))) as topic)
$$;

-- Sends `p_event` to each of `p_topics` not sent it yet in this transaction, and notes `p_class` (whose readers these
-- are) as sent. Only inside a trigger's guarded block.
create function public.qorpera_live_hint_send(p_event text, p_topics text[], p_class text)
returns void language plpgsql set search_path = '' as $$
declare
	v_sent text := coalesce(current_setting('qorpera.live_hints_sent', true), '');
	v_new text[];
begin
	-- perf T3 (20260930653000)
	select coalesce(array_agg(distinct topic), '{}') into v_new from unnest(p_topics) as topic
	where topic is not null and strpos(v_sent, '|' || topic || ' ' || p_event || '|') = 0;
	if cardinality(v_new) > 0 then
		insert into realtime.messages (id, topic, extension, event, payload, private)
		select pg_catalog.gen_random_uuid(), topic, 'broadcast', p_event, '{"schema":"qorpera.live-hint/v1"}'::jsonb, true
		from unnest(v_new) as topic;
	end if;
	perform set_config('qorpera.live_hints_sent', coalesce(nullif(v_sent, ''), '|')
		|| coalesce((select string_agg(topic || ' ' || p_event || '|', '') from unnest(v_new) as topic), '') || p_class || '|', true);
end
$$;

-- The trigger: at commit, for one changed row, the topics of whoever may read it then, and the send. A row that changed
-- again later in the transaction is read as it is now; a deleted row as it was.
-- Its readers' class (the company and the columns the policy reads: the session's audience, whether the agent is
-- deleted, the access row's account) is sent once per transaction: a later row of a class already sent costs a string
-- search and nothing else, so a statement over many rows of one company (a purge, a bulk update) sends once. Otherwise
-- one subtransaction under a 20 ms lock budget; rolling it back restores lock_timeout and absorbs every failure.
create function public.qorpera_live_hint_internal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_row record;
	v_class text;
	v_topics text[];
	v_profile uuid;
	v_kind text;
	v_audience uuid;
	v_deleted boolean;
begin
	-- perf T3 (20260930653000)
	if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
	if tg_table_name = 'qorpera_shared_sessions' then
		v_class := v_row.profile_id || ' sessions ' || v_row.audience_kind || ' ' || coalesce(v_row.audience_user_id::text, '');
	elsif tg_table_name = 'qorpera_profile_staff' then
		v_class := v_row.profile_id || ' staff ' || (v_row.deleted_at is not null)::text;
	elsif tg_table_name = 'qorpera_profile_access_state' then
		v_class := v_row.profile_id || ' access ' || v_row.user_id;
	else
		v_class := v_row.profile_id || ' ' || tg_argv[0];
	end if;
	if strpos(coalesce(current_setting('qorpera.live_hints_sent', true), ''), '|' || v_class || '|') > 0 then return null; end if;
	begin
		perform set_config('lock_timeout', '20ms', true);
		if tg_table_name = 'qorpera_shared_sessions' then
			if tg_op = 'DELETE' then
				v_profile := v_row.profile_id; v_kind := v_row.audience_kind; v_audience := v_row.audience_user_id;
			else
				select session.profile_id, session.audience_kind, session.audience_user_id into v_profile, v_kind, v_audience
				from public.qorpera_shared_sessions as session where session.id = v_row.id;
			end if;
			if v_profile is not null then
				perform public.qorpera_live_hint_send('sessions', public.qorpera_live_hint_session_topics(v_profile, v_kind, v_audience),
					v_profile || ' sessions ' || v_kind || ' ' || coalesce(v_audience::text, ''));
			end if;
		elsif tg_table_name = 'qorpera_profile_staff' then
			if tg_op = 'DELETE' then
				v_profile := v_row.profile_id; v_deleted := v_row.deleted_at is not null;
			else
				select agent.profile_id, agent.deleted_at is not null into v_profile, v_deleted from public.qorpera_profile_staff as agent
				where agent.profile_id = v_row.profile_id and agent.staff_agent_id = v_row.staff_agent_id;
			end if;
			if v_profile is not null then
				perform public.qorpera_live_hint_send('staff', public.qorpera_live_hint_staff_topics(v_profile, v_deleted),
					v_profile || ' staff ' || v_deleted::text);
			end if;
		elsif tg_table_name = 'qorpera_profile_access_state' then
			perform public.qorpera_live_hint_send('access', public.qorpera_live_hint_access_topics(v_row.profile_id, v_row.user_id),
				v_class);
		else
			perform public.qorpera_live_hint_send(tg_argv[0], public.qorpera_live_hint_profile_topics(v_row.profile_id), v_class);
		end if;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
	return null;
end
$$;

revoke all on function public.qorpera_live_hint_profile_topics(uuid), public.qorpera_live_hint_session_topics(uuid, text, uuid),
	public.qorpera_live_hint_staff_topics(uuid, boolean), public.qorpera_live_hint_access_topics(uuid, uuid),
	public.qorpera_live_hint_send(text, text[], text), public.qorpera_live_hint_internal()
	from public, anon, authenticated, service_role;

create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_shared_sessions
	deferrable initially deferred for each row execute function public.qorpera_live_hint_internal();
create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_profile_staff
	deferrable initially deferred for each row execute function public.qorpera_live_hint_internal();
create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_profile_access_state
	deferrable initially deferred for each row execute function public.qorpera_live_hint_internal();
create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_company_files
	deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('company-file');
create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_company_sidebar_revisions
	deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('sidebar');
