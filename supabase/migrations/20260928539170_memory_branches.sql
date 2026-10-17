-- Summary trees M4, part 1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §3, §5.5): the branches.
--
-- 1. qorpera_memory_branch_list: the other conversations an agent takes part in (§3), as §5.5 chooses them: its own
--    thread and the group chats it is an active member of, and for the Co-Founder every agent's thread. Each comes with
--    its zoom ref, kind, name, session and message count, the most recently active first.
-- 2. qorpera_memory_branches, a native host call (scope binding): the run check, the run's branches, and the live trees
--    (qorpera_memory_tree_read) of the branches the request names. The runtime folds them into the view's branches
--    (memory-tree/branches.ts) and the composer releases the blocks it shows with the view's (M1b-4), so this call
--    stores no receipt: receipts are only for zoom (§8).
-- Branches are relevance, never a permission (§9): zoom reads every conversation of the company.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; M1b-3 comes first.
do $$ begin
	if to_regprocedure('public.qorpera_memory_branches(jsonb,jsonb)') is not null then
		raise exception 'M4a (20260930220000) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_tree_read(uuid,uuid)') is null then
		raise exception 'M4a (20260930220000) needs M1b-3 (20260930202000)'; end if;
end $$;

-- 1. The list ---------------------------------------------------------------------------------------------------------

-- The branches (§5.5) of an agent's run in the environment, from the live index rows (plain reads): the agent's thread
-- (the room bound to it), every agent's thread when the agent is the Co-Founder, and every group chat at
-- agents/groups/<group>/group.md with the agent an active member, each but the run's own conversation. An agent's
-- thread is live as zoom finds it (qorpera_memory_conversation): its folder not retired and its row not deleted.
-- Each is {ref, kind, name, sessionId, messages}, with the ref zoom opens it by (thread:<agent>, group:<group>) and the
-- count of its included events (§3). The most recently active first, by its newest included event; then by ref, and a
-- conversation with none last.
create function public.qorpera_memory_branch_list(p_environment_id uuid, p_staff_agent_id uuid, p_own_session_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	with candidates as (
		select 'thread:' || split_part(s.folder_path, '/', 2) as ref, 'thread' as kind, r.session_id, s.display_name as name
		from public.qorpera_profile_staff s
		join public.qorpera_company_rooms r on r.profile_id = s.profile_id and r.bound_staff_agent_id = s.staff_agent_id
		where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
			and public.qorpera_folder_key(s.folder_path) ~ '^agents/[^/]+/agent\.md$'
			and public.qorpera_folder_key(s.folder_path) !~ '^agents/(groups|\.\.?)/'
			and (s.staff_agent_id = p_staff_agent_id or exists (select 1 from public.qorpera_company_cofounders c
				where c.environment_id = p_environment_id and c.staff_agent_id = p_staff_agent_id))
		union all
		select 'group:' || split_part(r.folder_path, '/', 3), 'group', r.session_id, r.name
		from public.qorpera_company_rooms r
		where r.folder_environment_id = p_environment_id and r.folder_retired_at is null and r.bound_staff_agent_id is null
			and public.qorpera_folder_key(r.folder_path) ~ '^agents/groups/[^/]+/group\.md$'
			and public.qorpera_folder_key(r.folder_path) !~ '^agents/groups/\.\.?/'
			and exists (select 1 from public.qorpera_company_room_members m where m.room_id = r.id
				and m.principal_kind = 'staff_agent' and m.principal_id = p_staff_agent_id and m.status = 'active')
	)
	select coalesce(jsonb_agg(jsonb_build_object('ref', b.ref, 'kind', b.kind, 'name', b.name, 'sessionId', b.session_id,
			'messages', b.messages) order by b.last_at desc nulls last, b.ref collate "C"), '[]'::jsonb)
	from (select c.ref, c.kind, coalesce(c.name, s.title) as name, c.session_id,
			(select count(*) from public.qorpera_session_events e where e.session_id = s.id
				and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision'))
				as messages,
			(select e.created_at from public.qorpera_session_events e where e.session_id = s.id
				and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')
				order by e.sequence desc limit 1) as last_at
		from candidates c
		join public.qorpera_shared_sessions s on s.id = c.session_id and s.environment_id = p_environment_id
		where c.session_id is distinct from p_own_session_id) as b
$$;
revoke all on function public.qorpera_memory_branch_list(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- 2. The host call ----------------------------------------------------------------------------------------------------

-- branches (§5.5) for the binding's run. The request is {sessions}: the session ids, from an earlier answer's branches,
-- whose trees to read. Answers with schema qorpera.memory-branches/v1, the run's branches (qorpera_memory_branch_list)
-- and `trees`: the live tree (qorpera_memory_tree_read) of each named session that is still one of them, in the
-- branches' order. A named session that is not is left out. All of it is read in one statement, so the counts and the
-- trees agree. A malformed request refuses (22023).
create function public.qorpera_memory_branches(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_schema constant text := 'qorpera.memory-branches/v1';
	v_run public.qorpera_execution_runs%rowtype;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'sessions') is distinct from 'array' then
		raise exception 'branches request is malformed' using errcode = '22023'; end if;
	if exists (select 1 from jsonb_object_keys(p_request) as key(name) where key.name <> 'sessions')
		or exists (select 1 from jsonb_array_elements(p_request -> 'sessions') as x(v) where jsonb_typeof(x.v) <> 'string'
			or x.v #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
		or (select count(distinct x.v) <> count(*) from jsonb_array_elements(p_request -> 'sessions') as x(v)) then
		raise exception 'branches request is malformed' using errcode = '22023'; end if;
	return (select jsonb_build_object('schema', c_schema, 'branches', l.list,
			'trees', coalesce((select jsonb_agg(public.qorpera_memory_tree_read(v_run.environment_id, (b.value ->> 'sessionId')::uuid)
					order by b.n)
				from jsonb_array_elements(l.list) with ordinality as b(value, n)
				where (p_request -> 'sessions') ? (b.value ->> 'sessionId')), '[]'::jsonb))
		from (select public.qorpera_memory_branch_list(v_run.environment_id, v_run.staff_agent_id, v_run.session_id) as list) as l);
end $$;
revoke all on function public.qorpera_memory_branches(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_branches(jsonb, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_branches', 'binding');
