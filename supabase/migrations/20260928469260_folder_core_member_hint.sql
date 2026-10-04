-- Company folder core, C4 slice P30: the members' and clients' hint (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §6
-- "Clients" and §11 C4; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §3). Built by the Interfaces session for
-- the folder-v2 file page (P33); shape agreed with Q1 (companySeq, the listener) and F3 (the feed, the node's folder
-- service) on 3 October 2026.
--
-- Inert for today's companies: only a folder-v2 company has a folder clock, and only an operator can create one until
-- the reset (C5).
--
-- When a company's folder clock moves forward (a change set or an authority change, core §3 step 11), the database
-- broadcasts {"schema":"qorpera.folder-hint/v1","seq":<last_seq>} as event 'folder' on the private Realtime topic
-- 'qorpera-folder-<environmentId>'. It says only that the folder changed and up to which seq: never paths or authors.
-- A client then asks the feed what changed (qorpera_member_folder_changes, P27a), and treats the hint as a nudge only:
-- a missed broadcast is normal on a reconnect, so a slow poll backs it up.
--
-- Who receives it: an authenticated member of that company may read broadcasts on that topic (the select policy on
-- realtime.messages, checked when a client joins); there is no insert policy, so only the database publishes. A
-- non-member never joins, so it gets no event per change. The folder clock itself stays out of the Realtime
-- publication (C1f: a published table makes Realtime send every subscriber who may not select it a refusal per change).
-- service_role (a node's folder service, which polls the clock today) may join any topic.
--
-- Cost in the commit: a plain AFTER UPDATE row trigger on the clock, with a WHEN clause so an update that does not
-- move the clock forward never runs it, and no lookup beyond the row. The commit takes the clock row last and holds
-- it to its end, so the send runs under it: one realtime.send, which only inserts a row into realtime.messages (read
-- from the WAL after commit; no foreign key into our tables). A rolled-back commit sends nothing. The send waits at
-- most 20 ms for a lock (Realtime's partition maintenance), and every failure is absorbed, a missing Realtime
-- included, as the orchestrator wake does (20260928319550): a hint never fails or holds up a commit.

create function public.qorpera_folder_hint_topic(p_environment_id uuid)
returns text language sql immutable set search_path = '' as $$
	select 'qorpera-folder-' || p_environment_id::text
$$;
revoke all on function public.qorpera_folder_hint_topic(uuid) from public, anon;
grant execute on function public.qorpera_folder_hint_topic(uuid) to authenticated, service_role;

-- A topic's environment, or null for any other topic.
create function public.qorpera_folder_hint_environment(p_topic text)
returns uuid language sql immutable set search_path = '' as $$
	select case when p_topic ~ '^qorpera-folder-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then substring(p_topic from 16)::uuid end
$$;
revoke all on function public.qorpera_folder_hint_environment(text) from public, anon;
grant execute on function public.qorpera_folder_hint_environment(text) to authenticated;

-- Whether the caller may receive a topic's hints: a member of the folder-v2 company with that environment, while the
-- company is not being deleted (a company being deleted serves its folder to no one, folder core P01).
create function public.qorpera_folder_hint_member(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
	-- C4 P30 (20260930013100)
	select auth.uid() is not null and exists (
		select 1 from public.qorpera_company_files as file
		join public.qorpera_profile_members as member on member.profile_id = file.profile_id
		where file.environment_id = public.qorpera_folder_hint_environment(p_topic) and file.core = 'folder-v2'
			and member.user_id = auth.uid()
			and not exists (select 1 from public.qorpera_company_deletions as deletion
				where deletion.profile_id = file.profile_id))
$$;
revoke all on function public.qorpera_folder_hint_member(text) from public, anon, service_role;
grant execute on function public.qorpera_folder_hint_member(text) to authenticated;

create policy qorpera_folder_hint_member_receive
	on realtime.messages
	for select
	to authenticated
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.messages.topic = (select realtime.topic())
		and public.qorpera_folder_hint_member(realtime.topic())
	);

create function public.qorpera_folder_hint_internal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_lock_timeout text := current_setting('lock_timeout');
begin
	-- C4 P30 (20260930013100): one subtransaction for the send, under a 20 ms lock budget. realtime.send turns its own
	-- failures into a warning; this block also absorbs a missing Realtime, and rolling it back restores lock_timeout.
	begin
		perform set_config('lock_timeout', '20ms', true);
		perform realtime.send(jsonb_build_object('schema', 'qorpera.folder-hint/v1', 'seq', new.last_seq), 'folder',
			public.qorpera_folder_hint_topic(new.environment_id), true);
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
	return null;
end
$$;
revoke all on function public.qorpera_folder_hint_internal() from public, anon, authenticated, service_role;

create trigger qorpera_folder_clocks_hint
	after update of last_seq on public.qorpera_folder_clocks
	for each row when (new.last_seq > old.last_seq)
	execute function public.qorpera_folder_hint_internal();
