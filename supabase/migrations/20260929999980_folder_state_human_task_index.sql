-- Company state files, H2b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (H2)"): human tasks and contacts
-- on the folder core, without their wakes (H2c, with C4's folder listener).
--
-- 1. Two index tables, keyed by (environment, id) in the connection index's style: no foreign key to the company, so
--    they need no lock at rank 0; written in apply; a move repoints, a delete retires, a restore revives; verify checks
--    each written row. `started_by_user_id` comes from the creating commit (the member who started the task, who pays
--    for its wakes in H2c), as a routine's origin does; everything else is what the files say.
-- 2. The person's change (§1): on a member's task, a commit by that member's own actor; on a contact's task, the
--    platform's (the link service, H5). One tick, done (with every listed kind of proof) or declined (with its reason),
--    from open or returned, and nothing else. The person never acts as the company's side on their own task.
-- 3. The company's side (§2): a new task is open with a future due; accepted and returned only from done; cancelled from
--    open, returned or done (from done with a reason); accepted, declined and cancelled are final. References are checked
--    when a save sets or changes them, never on the person's change (§3).
-- 4. A task's folder never outlives its file (§4): nothing lands at or under human-tasks/<t> without human-tasks/<t>.md;
--    a task file whose folder exists is neither moved nor deleted; the folder's rights follow the task's status.
-- 5. Row locks at rank 5 on the two new tables only (§6): no company-wide lock.
-- 6. human-tasks/ and contacts/ join the seeded folders that are never deleted or moved (Jonas, 2 October 2026).
-- Every patched body carries the marker 20260929999980 for the deploy guard.

create table public.qorpera_folder_human_task_index (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	id uuid not null,
	-- No foreign key to qorpera_profiles: its KEY SHARE would come in apply, after the paths (as the connection index).
	profile_id uuid not null,
	folder_path text collate "C" not null,
	folder_key text collate "C" not null,
	folder_path_version uuid not null,
	commit_id uuid not null,
	status text not null check (status in ('open','done','accepted','returned','declined','cancelled')),
	title text not null,
	member_user_id uuid,
	contact_id uuid,
	from_staff_agent_id uuid not null,
	todo_id uuid,
	connection_id uuid,
	due_at timestamptz not null,
	-- The member who started the task (the creating commit's requester), who pays for its wakes (H2c). Not in the file:
	-- a rebuild keeps it.
	started_by_user_id uuid,
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, id),
	check ((member_user_id is null) <> (contact_id is null))
);
-- Not unique, so apply's update of a row never needs more than its rank-5 lock.
create index qorpera_folder_human_task_index_key on public.qorpera_folder_human_task_index(environment_id, folder_key);
create index qorpera_folder_human_task_index_contact on public.qorpera_folder_human_task_index(environment_id, contact_id)
	where contact_id is not null and retired_at is null;
alter table public.qorpera_folder_human_task_index enable row level security;
revoke all on public.qorpera_folder_human_task_index from public, anon, authenticated, service_role;
grant select on public.qorpera_folder_human_task_index to service_role;
comment on table public.qorpera_folder_human_task_index is
	'H2: one row per human task file (human-tasks/<t>.md), an index of the company folder; rebuilt from the files.';

create table public.qorpera_folder_contact_index (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	id uuid not null,
	profile_id uuid not null,
	folder_path text collate "C" not null,
	folder_key text collate "C" not null,
	folder_path_version uuid not null,
	commit_id uuid not null,
	has_email boolean not null,
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, id)
);
create index qorpera_folder_contact_index_key on public.qorpera_folder_contact_index(environment_id, folder_key);
alter table public.qorpera_folder_contact_index enable row level security;
revoke all on public.qorpera_folder_contact_index from public, anon, authenticated, service_role;
grant select on public.qorpera_folder_contact_index to service_role;
comment on table public.qorpera_folder_contact_index is
	'H2: one row per contact file (contacts/<c>.md), an index of the company folder; rebuilt from the files.';

-- The task a key belongs to: human-tasks/<t>.md, human-tasks/<t> and everything under it give <t>.
create function public.qorpera_company_state_task_stem(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	select case when p_key ~ '^human-tasks/[^/]+\.md$' then substring(p_key from '^human-tasks/([^/]+)\.md$')
		when p_key ~ '^human-tasks/[^/]+(/|$)' then substring(p_key from '^human-tasks/([^/]+)') end
$$;
revoke all on function public.qorpera_company_state_task_stem(text) from public, anon, authenticated, service_role;

-- The live index row of the task file human-tasks/<stem>.md, if any.
create function public.qorpera_company_state_task_at(p_environment_id uuid, p_stem text)
returns public.qorpera_folder_human_task_index language sql stable set search_path = '' as $$
	select * from public.qorpera_folder_human_task_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = 'human-tasks/' || p_stem || '.md'
$$;
revoke all on function public.qorpera_company_state_task_at(uuid, text) from public, anon, authenticated, service_role;

-- Whether a row was last written by a commit that landed after this commit read the folder: targets read it without a
-- lock, so a row changed in between is a conflict (§6). An earlier unit of this commit has no seq yet.
create function public.qorpera_company_state_changed_since(p_commit_id uuid, p_row_commit_id uuid)
returns boolean language sql stable set search_path = '' as $$
	select coalesce((select c.seq from public.qorpera_folder_commits c where c.id = p_row_commit_id)
		> (select c.as_of_seq from public.qorpera_folder_commits c where c.id = p_commit_id), false)
$$;
revoke all on function public.qorpera_company_state_changed_since(uuid, uuid) from public, anon, authenticated, service_role;

-- Whether the actor is the task's person: the member it names, or the platform on a contact's task (H5's link service).
create function public.qorpera_company_state_task_person(p_actor jsonb, p_member uuid, p_contact uuid)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce((p_actor ->> 'kind' = 'member' and p_member is not null and (p_actor ->> 'userId')::uuid = p_member)
		or (p_actor ->> 'kind' = 'platform' and p_contact is not null), false)
$$;
revoke all on function public.qorpera_company_state_task_person(jsonb, uuid, uuid) from public, anon, authenticated, service_role;

create function pg_temp.h2_human_task_index_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'H2 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 6. The seeded folders.
select pg_temp.h2_human_task_index_replace('public.qorpera_company_state_seeded(text)'::regprocedure,
	$old$'agents/groups','connections','skills','rules'])$old$,
	$new$'agents/groups','connections','human-tasks','contacts','skills','rules'])
	-- 20260929999980 (H2): human-tasks/ and contacts/ are fixed folders (Jonas, 2 October 2026).$new$);

-- 4. The paths of human tasks, checked for every unit before anything else: a task's folder and its file, and the
-- contacts its tasks name. Returns a refusal (or a conflict) or null.
create function public.qorpera_company_state_task_paths(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_commit_id uuid, p_op text, p_key text, p_to_key text, p_unit jsonb, p_eff_path text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_landing record; v_stem text; v_row public.qorpera_folder_human_task_index; v_problem text; v_source_kind text;
	v_member_or_platform boolean := p_actor ->> 'kind' in ('member','platform');
	v_final constant text[] := array['accepted','declined','cancelled'];
	v_contact public.qorpera_folder_contact_index;
begin
	-- What leaves: a delete's or a move's source.
	if p_op in ('delete','move') then
		v_stem := public.qorpera_company_state_task_stem(p_key);
		if p_key ~ '^human-tasks/[^/]+\.md$' then
			-- A task file: its folder goes first, and only a final task (or one with no index, from before H2) is removed.
			if exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest('human-tasks/' || v_stem, 'sha256') and e.kind <> 'claim') then
				v_problem := 'the task''s folder human-tasks/' || left(v_stem, 64) || '/ goes first; a task with proof keeps its name';
			else
				v_row := public.qorpera_company_state_task_at(p_environment_id, v_stem);
				if v_row.id is not null and public.qorpera_company_state_changed_since(p_commit_id, v_row.commit_id) then
					return jsonb_build_object('ok', false, 'reason', 'version_changed'); end if;
				if p_op = 'delete' and v_row.id is null and not v_member_or_platform then
					v_problem := 'only a member removes a task saved before its index';
				elsif p_op = 'delete' and v_row.id is not null and not (v_row.status = any (v_final)) then
					v_problem := 'only a final task is removed; cancel it first';
				end if;
			end if;
		elsif p_key ~ '^contacts/[^/]*\.md$' and p_op = 'delete' then
			select * into v_contact from public.qorpera_folder_contact_index c
			where c.environment_id = p_environment_id and c.retired_at is null and c.folder_key = p_key;
			if v_contact.id is not null and public.qorpera_company_state_changed_since(p_commit_id, v_contact.commit_id) then
				return jsonb_build_object('ok', false, 'reason', 'version_changed'); end if;
			if v_contact.id is not null and exists (select 1 from public.qorpera_folder_human_task_index t
				where t.environment_id = p_environment_id and t.contact_id = v_contact.id and t.retired_at is null
					and not (t.status = any (v_final))) then
				v_problem := 'a contact named by a task that is not final stays; cancel its tasks first';
			end if;
		elsif v_stem is not null then
			-- At or under a task's folder.
			v_row := public.qorpera_company_state_task_at(p_environment_id, v_stem);
			if v_row.id is null or not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest('human-tasks/' || v_stem || '.md', 'sha256') and e.kind = 'file') then
				-- A folder without its task (from before H2, or an operator's): it may only be removed, by a member.
				if p_op = 'move' or not v_member_or_platform then
					v_problem := 'a folder without its task file is only removed, by a member';
				end if;
			elsif public.qorpera_company_state_changed_since(p_commit_id, v_row.commit_id) then
				return jsonb_build_object('ok', false, 'reason', 'version_changed');
			elsif v_row.status in ('open','returned') then
				if not public.qorpera_company_state_task_person(p_actor, v_row.member_user_id, v_row.contact_id) then
					v_problem := 'only the task''s person changes its folder while the task is ' || v_row.status;
				end if;
			elsif v_row.status = 'done' then
				v_problem := 'the task is done: its folder stays as it is while the agent checks the proof';
			elsif p_op = 'move' or not v_member_or_platform then
				v_problem := 'a ' || v_row.status || ' task''s folder is only removed, by a member';
			end if;
		end if;
		if v_problem is not null then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, v_problem))); end if;
	end if;

	-- What lands: a write's file, a new folder and its contents, a mkdir, a move's or copy's target.
	if p_op in ('move','copy') then
		select e.kind into v_source_kind from public.qorpera_folder_entries e
		where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(p_key, 'sha256') and e.kind <> 'claim';
	end if;
	for v_landing in
		select p_key as key, case when p_op = 'mkdir' then 'folder' when p_op = 'new_folder' then 'folder' else 'file' end as kind
		where p_op in ('write','mkdir','new_folder')
		union all
		select public.qorpera_folder_key(s.path), s.kind from public.qorpera_folder_spelled_contents(p_eff_path, p_unit -> 'contents') s
		where p_op = 'new_folder'
		union all
		select p_to_key, coalesce(v_source_kind, 'file') where p_op in ('move','copy') and p_to_key is not null
	loop
		if v_landing.key = 'human-tasks' and p_op in ('move','copy') then
			v_problem := 'human-tasks/ is made empty, with a new folder; nothing moves or copies onto it';
		elsif v_landing.key ~ '^human-tasks/[^/]+\.md$' then
			-- A task file landing on a name whose folder exists would inherit its proof.
			v_stem := public.qorpera_company_state_task_stem(v_landing.key);
			if not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(v_landing.key, 'sha256') and e.kind = 'file')
				and exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('human-tasks/' || v_stem, 'sha256') and e.kind <> 'claim') then
				v_problem := 'a folder named human-tasks/' || left(v_stem, 64) || '/ is still there; a new task needs a free name';
			end if;
		elsif v_landing.key ~ '^human-tasks/[^/]+$' and v_landing.kind = 'file' then
			v_problem := 'directly under human-tasks/ go only task files (.md) and task folders';
		elsif public.qorpera_company_state_task_stem(v_landing.key) is not null
			and jsonb_array_length(public.qorpera_company_state_path_problems(v_landing.key, v_landing.kind = 'folder')) = 0 then
			-- (A misnamed folder is left to the name check, which says what is wrong with it.)
			v_stem := public.qorpera_company_state_task_stem(v_landing.key);
			v_row := public.qorpera_company_state_task_at(p_environment_id, v_stem);
			if v_row.id is null or not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest('human-tasks/' || v_stem || '.md', 'sha256') and e.kind = 'file') then
				v_problem := 'human-tasks/' || left(v_stem, 64) || '/ belongs to the task human-tasks/' || left(v_stem, 64)
					|| '.md, which must be saved first';
			elsif public.qorpera_company_state_changed_since(p_commit_id, v_row.commit_id) then
				return jsonb_build_object('ok', false, 'reason', 'version_changed');
			elsif v_row.status in ('open','returned') then
				if not public.qorpera_company_state_task_person(p_actor, v_row.member_user_id, v_row.contact_id) then
					v_problem := 'only the task''s person adds to its folder while the task is ' || v_row.status;
				end if;
			elsif v_row.status = 'done' then
				v_problem := 'the task is done: its folder stays as it is while the agent checks the proof';
			else
				v_problem := 'a ' || v_row.status || ' task''s folder takes nothing new';
			end if;
		end if;
		if v_problem is not null then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, v_problem))); end if;
	end loop;
	return null;
end $$;
revoke all on function public.qorpera_company_state_task_paths(uuid, uuid, jsonb, uuid, text, text, text, jsonb, text)
	from public, anon, authenticated, service_role;

-- 3. References, checked when a save sets or changes them. Returns a problem's text or null.
create function public.qorpera_company_state_task_references(p_environment_id uuid, p_profile_id uuid, p_parse jsonb,
	p_prev jsonb)
returns text language plpgsql stable set search_path = '' as $$
declare v_from uuid := (p_parse ->> 'from')::uuid;
begin
	if (p_prev is null or p_prev ->> 'from' is distinct from p_parse ->> 'from') and not exists (
		select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id and s.staff_agent_id = v_from
			and s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
			and s.employment_status = 'active') then
		return 'from is an active agent of this company';
	end if;
	if p_parse ->> 'member' is not null and (p_prev is null or p_prev ->> 'member' is distinct from p_parse ->> 'member')
		and not exists (select 1 from public.qorpera_profile_members m where m.profile_id = p_profile_id
			and m.user_id = (p_parse ->> 'member')::uuid and m.role::text in ('owner','admin','contributor')) then
		return 'member is a member of this company who can write its files (an owner, admin or contributor)';
	end if;
	if p_parse ->> 'contact' is not null and (p_prev is null or p_prev ->> 'contact' is distinct from p_parse ->> 'contact')
		and not exists (select 1 from public.qorpera_folder_contact_index c where c.environment_id = p_environment_id
			and c.id = (p_parse ->> 'contact')::uuid and c.retired_at is null and c.has_email) then
		return 'contact is a contact file of this company with an email';
	end if;
	if p_parse ->> 'connection' is not null
		and (p_prev is null or p_prev ->> 'connection' is distinct from p_parse ->> 'connection')
		and not exists (select 1 from public.qorpera_folder_connection_index c where c.environment_id = p_environment_id
			and c.secret_id = (p_parse ->> 'connection')::uuid and c.retired_at is null) then
		return 'connection is a connection file of this company';
	end if;
	if p_parse ->> 'todo' is not null and (p_prev is null or p_prev ->> 'todo' is distinct from p_parse ->> 'todo'
			or p_prev ->> 'from' is distinct from p_parse ->> 'from')
		and not exists (select 1 from public.qorpera_runtime_agent_todos t where t.id = (p_parse ->> 'todo')::uuid
			and t.profile_id = p_profile_id and t.folder_environment_id = p_environment_id and t.folder_retired_at is null
			and t.staff_agent_id = v_from and t.state in ('open','blocked')) then
		return 'todo is an open or blocked todo of the from agent';
	end if;
	return null;
end $$;
revoke all on function public.qorpera_company_state_task_references(uuid, uuid, jsonb, jsonb)
	from public, anon, authenticated, service_role;

-- 1-3. The database rules for one human task file. Returns a refusal or null.
create function public.qorpera_company_state_human_task_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_id uuid := (p_parse ->> 'id')::uuid; v_row public.qorpera_folder_human_task_index;
	v_at public.qorpera_folder_human_task_index; v_prev jsonb; v_problem text; v_kind text := p_actor ->> 'kind';
	v_was text; v_now text := p_parse ->> 'status'; v_stem text := public.qorpera_company_state_task_stem(p_key);
	v_missing text[]; v_final constant text[] := array['accepted','declined','cancelled'];
	v_later timestamptz := statement_timestamp();
begin
	select * into v_row from public.qorpera_folder_human_task_index i where i.environment_id = p_environment_id and i.id = v_id;
	select * into v_at from public.qorpera_folder_human_task_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = p_key;
	-- The task's last file (a restore compares with it too), trusted only through the index.
	if v_row.id is not null then
		select v.structured -> 'parse' into v_prev from public.qorpera_folder_path_versions v where v.version = v_row.folder_path_version;
	end if;
	v_was := v_prev ->> 'status';
	if v_at.id is not null and v_at.id <> v_id then
		v_problem := 'id never changes; it is ' || v_at.id;
	elsif v_row.id is not null and v_row.retired_at is null and v_row.folder_key <> p_key then
		v_problem := 'this task already has the file ' || left(v_row.folder_path, 100);
	elsif v_kind = 'platform' then
		-- The platform never creates a task. On a member's task it only marks the secret saved; on a contact's task it may
		-- make the person's change (the link service, H5).
		if v_prev is null then
			v_problem := 'the platform never creates a task';
		elsif v_prev ->> 'member' is not null and p_parse is distinct from v_prev
			and not ((p_parse - 'secretState') = (v_prev - 'secretState') and v_prev ->> 'secretState' = 'asked'
				and p_parse ->> 'secretState' = 'saved') then
			v_problem := 'on a member''s task the platform only marks the secret saved';
		end if;
	end if;
	if v_problem is null and v_prev is not null and p_parse is distinct from v_prev
		and public.qorpera_company_state_task_person(p_actor, (v_prev ->> 'member')::uuid, (v_prev ->> 'contact')::uuid) then
		-- 1. The person's change: one tick, done or declined, from open or returned, and nothing else.
		if v_was not in ('open','returned') then
			v_problem := 'this task is ' || v_was || '; it is no longer yours to change';
		elsif v_now not in (v_was, 'done', 'declined') then
			v_problem := 'as the task''s person you may tick its steps, or mark it done or declined';
		elsif (p_parse - array['status','reason','steps','instructions']) <> (v_prev - array['status','reason','steps','instructions'])
			or (select coalesce(jsonb_agg(s.value -> 'text' order by s.ordinality), '[]'::jsonb)
					from jsonb_array_elements(p_parse -> 'steps') with ordinality s)
				<> (select coalesce(jsonb_agg(s.value -> 'text' order by s.ordinality), '[]'::jsonb)
					from jsonb_array_elements(v_prev -> 'steps') with ordinality s)
			or regexp_replace(p_parse ->> 'instructions', '^- \[[ xX]\] ', '- [ ] ', 'gn')
				<> regexp_replace(v_prev ->> 'instructions', '^- \[[ xX]\] ', '- [ ] ', 'gn')
			or (v_now = v_was and p_parse -> 'reason' is distinct from v_prev -> 'reason') then
			v_problem := 'as the task''s person you may only tick its steps, or mark it done or declined';
		elsif v_now = 'done' then
			-- Every kind of proof the task lists: a file proof/<kind>-* directly in its proof folder, and a note.md of
			-- more than 0 bytes.
			select array_agg(k.value #>> '{}') into v_missing from jsonb_array_elements(p_parse -> 'proof') k
			where case when k.value #>> '{}' = 'note' then not exists (select 1 from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest('human-tasks/' || v_stem || '/note.md', 'sha256')
						and e.kind = 'file' and e.bytes > 0)
				else not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.kind = 'file'
					and left(e.key_text, char_length('human-tasks/' || v_stem || '/proof/' || (k.value #>> '{}') || '-'))
						= 'human-tasks/' || v_stem || '/proof/' || (k.value #>> '{}') || '-'
					and strpos(substr(e.key_text, char_length('human-tasks/' || v_stem || '/proof/') + 1), '/') = 0) end;
			if v_missing is not null then
				v_problem := 'done needs the proof the task asks for: ' || array_to_string(v_missing, ', ');
			end if;
		end if;
	elsif v_problem is null and v_kind <> 'platform' and (v_prev is null or p_parse is distinct from v_prev) then
		-- 2. The company's side. 3. References, when set or changed.
		if v_prev is null then
			if v_now <> 'open' then
				v_problem := 'a new task is open';
			elsif (p_parse ->> 'due')::timestamptz <= v_later then
				v_problem := 'due is in the future';
			elsif v_kind = 'staff_agent' and p_parse ->> 'from' is distinct from p_actor ->> 'staffAgentId' then
				v_problem := 'a task you create is from you: from is your own id';
			end if;
		elsif v_was = any (v_final) then
			v_problem := 'a ' || v_was || ' task is final; it never changes';
		elsif v_now in ('done','declined') and v_now <> v_was then
			v_problem := v_now || ' is the task''s person''s to set';
		elsif not (v_now = v_was or (v_was in ('open','returned') and v_now = 'cancelled')
				or (v_was = 'done' and v_now in ('accepted','returned','cancelled'))) then
			v_problem := 'a ' || v_was || ' task cannot become ' || v_now;
		elsif v_was = 'done' and v_now = 'cancelled' and p_parse ->> 'reason' is null then
			v_problem := 'cancelling a done task needs a reason: the person''s work is set aside';
		elsif (v_now = 'returned' and v_was <> 'returned' or p_parse ->> 'due' is distinct from v_prev ->> 'due')
			and (p_parse ->> 'due')::timestamptz <= v_later then
			v_problem := 'due is in the future';
		elsif (p_parse ->> 'member' is distinct from v_prev ->> 'member' or p_parse ->> 'contact' is distinct from v_prev ->> 'contact')
			and v_was not in ('open','returned') then
			v_problem := 'a task is handed to someone else only while it is open or returned';
		elsif p_parse ->> 'from' is distinct from v_prev ->> 'from' and (exists (select 1 from public.qorpera_profile_staff s
				where s.profile_id = p_profile_id and s.staff_agent_id = (v_prev ->> 'from')::uuid
					and s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
					and s.employment_status = 'active')
			or not (v_kind = 'member' or exists (select 1 from public.qorpera_company_cofounders c
				where c.profile_id = p_profile_id and c.staff_agent_id = (p_actor ->> 'staffAgentId')::uuid))) then
			v_problem := 'from changes only when the asking agent is no longer active, by a member or the Co-Founder';
		end if;
		if v_problem is null then
			v_problem := public.qorpera_company_state_task_references(p_environment_id, p_profile_id, p_parse, v_prev);
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_company_state_human_task_rules(uuid, uuid, jsonb, text, jsonb)
	from public, anon, authenticated, service_role;

-- The database rules for one contact file: the id never changes and belongs to one file; a contact named by a task that
-- is not final keeps its email.
create function public.qorpera_company_state_contact_rules(p_environment_id uuid, p_profile_id uuid, p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_id uuid := (p_parse ->> 'id')::uuid; v_row public.qorpera_folder_contact_index; v_at public.qorpera_folder_contact_index;
	v_problem text;
begin
	select * into v_row from public.qorpera_folder_contact_index c where c.environment_id = p_environment_id and c.id = v_id;
	select * into v_at from public.qorpera_folder_contact_index c
	where c.environment_id = p_environment_id and c.retired_at is null and c.folder_key = p_key;
	if v_at.id is not null and v_at.id <> v_id then
		v_problem := 'id never changes; it is ' || v_at.id;
	elsif v_row.id is not null and v_row.retired_at is null and v_row.folder_key <> p_key then
		v_problem := 'this contact already has the file ' || left(v_row.folder_path, 100);
	elsif p_parse ->> 'email' is null and v_row.id is not null and v_row.retired_at is null and v_row.has_email
		and exists (select 1 from public.qorpera_folder_human_task_index t where t.environment_id = p_environment_id
			and t.contact_id = v_id and t.retired_at is null and t.status not in ('accepted','declined','cancelled')) then
		v_problem := 'a contact named by a task that is not final keeps its email';
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_company_state_contact_rules(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- The index writers. A row is free to move when it is retired (a restore) or already at this key.
create function public.qorpera_company_state_index_human_task(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count bigint; v_started uuid;
begin
	select c.requester_id into v_started from public.qorpera_folder_commits c where c.id = p_commit_id and c.requester_kind = 'member';
	insert into public.qorpera_folder_human_task_index as i(environment_id, id, profile_id, folder_path, folder_key,
		folder_path_version, commit_id, status, title, member_user_id, contact_id, from_staff_agent_id, todo_id, connection_id,
		due_at, started_by_user_id)
	values (p_environment_id, (p_parse ->> 'id')::uuid, p_profile_id, p_path, public.qorpera_folder_key(p_path), p_version,
		p_commit_id, p_parse ->> 'status', p_parse ->> 'title', (p_parse ->> 'member')::uuid, (p_parse ->> 'contact')::uuid,
		(p_parse ->> 'from')::uuid, (p_parse ->> 'todo')::uuid, (p_parse ->> 'connection')::uuid, (p_parse ->> 'due')::timestamptz,
		v_started)
	on conflict (environment_id, id) do update set folder_path = excluded.folder_path, folder_key = excluded.folder_key,
		folder_path_version = excluded.folder_path_version, commit_id = excluded.commit_id, status = excluded.status,
		title = excluded.title, member_user_id = excluded.member_user_id, contact_id = excluded.contact_id,
		from_staff_agent_id = excluded.from_staff_agent_id, todo_id = excluded.todo_id, connection_id = excluded.connection_id,
		due_at = excluded.due_at, retired_at = null, updated_at = clock_timestamp()
	where i.retired_at is not null or i.folder_key = excluded.folder_key;
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'A task id was taken by another change set' using errcode = '23505'; end if;
end $$;
revoke all on function public.qorpera_company_state_index_human_task(uuid, uuid, uuid, text, uuid, jsonb)
	from public, anon, authenticated, service_role;

create function public.qorpera_company_state_index_contact(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count bigint;
begin
	insert into public.qorpera_folder_contact_index as i(environment_id, id, profile_id, folder_path, folder_key, folder_path_version,
		commit_id, has_email)
	values (p_environment_id, (p_parse ->> 'id')::uuid, p_profile_id, p_path, public.qorpera_folder_key(p_path), p_version,
		p_commit_id, p_parse ->> 'email' is not null)
	on conflict (environment_id, id) do update set folder_path = excluded.folder_path, folder_key = excluded.folder_key,
		folder_path_version = excluded.folder_path_version, commit_id = excluded.commit_id, has_email = excluded.has_email,
		retired_at = null, updated_at = clock_timestamp()
	where i.retired_at is not null or i.folder_key = excluded.folder_key;
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'A contact id was taken by another change set' using errcode = '23505'; end if;
end $$;
revoke all on function public.qorpera_company_state_index_contact(uuid, uuid, uuid, text, uuid, jsonb)
	from public, anon, authenticated, service_role;

-- 5. The rank-5 rows a unit writes or relies on: a task's or contact's own row FOR NO KEY UPDATE when the unit writes it
-- (a save, move, delete or restore of its file); a task's row FOR SHARE for any unit at or under its folder, and a
-- contact's FOR SHARE when a task save sets or changes it.
create function public.qorpera_company_state_task_targets(p_environment_id uuid, p_unit jsonb)
returns table(tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_entry jsonb; v_key text; v_stem text; v_row record;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	if v_op in ('write','new_folder') then
		for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(p_unit -> 'structured') = 'array'
				then p_unit -> 'structured' else '[]'::jsonb end) e
			where e.value ->> 'kind' in ('human-task','contact') and coalesce(e.value -> 'parse' ->> 'id', '') ~ c_uuid
		loop
			tbl := case when v_entry ->> 'kind' = 'human-task' then 'qorpera_folder_human_task_index'
				else 'qorpera_folder_contact_index' end;
			key := p_environment_id::text || ':' || (v_entry -> 'parse' ->> 'id'); mode := 'nokeyupdate';
			return next;
			if v_entry ->> 'kind' = 'human-task' and coalesce(v_entry -> 'parse' ->> 'contact', '') ~ c_uuid
				and not exists (select 1 from public.qorpera_folder_human_task_index i where i.environment_id = p_environment_id
					and i.id = (v_entry -> 'parse' ->> 'id')::uuid and i.contact_id = (v_entry -> 'parse' ->> 'contact')::uuid) then
				tbl := 'qorpera_folder_contact_index'; key := p_environment_id::text || ':' || (v_entry -> 'parse' ->> 'contact');
				mode := 'share';
				return next;
			end if;
		end loop;
	end if;
	foreach v_key in array array_remove(array[
		public.qorpera_folder_key(coalesce(case when v_op in ('move','copy') then p_unit ->> 'from' else p_unit ->> 'path' end, '')),
		case when v_op in ('move','copy') then public.qorpera_folder_key(p_unit ->> 'to') end], null)
	loop
		v_stem := public.qorpera_company_state_task_stem(v_key);
		if v_key ~ '^human-tasks/[^/]+\.md$' then
			if v_op in ('delete','move') and v_key = public.qorpera_folder_key(coalesce(p_unit ->> 'from', p_unit ->> 'path')) then
				for v_row in select i.id from public.qorpera_folder_human_task_index i
					where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = v_key loop
					tbl := 'qorpera_folder_human_task_index'; key := p_environment_id::text || ':' || v_row.id; mode := 'nokeyupdate';
					return next;
				end loop;
			end if;
		elsif v_key ~ '^contacts/[^/]*\.md$' then
			if v_op in ('delete','move') and v_key = public.qorpera_folder_key(coalesce(p_unit ->> 'from', p_unit ->> 'path')) then
				for v_row in select c.id from public.qorpera_folder_contact_index c
					where c.environment_id = p_environment_id and c.retired_at is null and c.folder_key = v_key loop
					tbl := 'qorpera_folder_contact_index'; key := p_environment_id::text || ':' || v_row.id; mode := 'nokeyupdate';
					return next;
				end loop;
			end if;
		elsif v_stem is not null then
			for v_row in select i.id from public.qorpera_folder_human_task_index i
				where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = 'human-tasks/' || v_stem || '.md' loop
				tbl := 'qorpera_folder_human_task_index'; key := p_environment_id::text || ':' || v_row.id; mode := 'share';
				return next;
			end loop;
		end if;
	end loop;
end $$;
revoke all on function public.qorpera_company_state_task_targets(uuid, jsonb) from public, anon, authenticated, service_role;

-- The targets: H2's rows at rank 5, for every unit.
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$	v_member uuid;$old$,
	$new$	v_member uuid; v_h2 record;$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$		v_op := v_unit ->> 'op';$old$,
	$new$		v_op := v_unit ->> 'op';
		-- 20260929999980 (H2b): the task and contact rows a unit writes or relies on, at rank 5.
		for v_h2 in select * from public.qorpera_company_state_task_targets(p_environment_id, v_unit) loop
			rank := 5; tbl := v_h2.tbl; key := v_h2.key; mode := v_h2.mode;
			return next;
		end loop;$new$);

-- The lock: the two tables, after the routines, keyed 'environment_id:id'.
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$			'qorpera_company_room_members','qorpera_cloud_routines'], t ->> 'tbl'), lower(t ->> 'key') collate "C"$old$,
	$new$			'qorpera_company_room_members','qorpera_cloud_routines','qorpera_folder_human_task_index',
			'qorpera_folder_contact_index'], t ->> 'tbl'), lower(t ->> 'key') collate "C"$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$old$,
	$new$		elsif v_target.tbl in ('qorpera_folder_human_task_index', 'qorpera_folder_contact_index') then
			-- key: 'environment_id:id' (20260929999980, H2b).
			execute 'select 1 from public.' || v_target.tbl || ' where environment_id = $1 and id = $2' || v_clause
			using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2)::uuid;
		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$new$);

-- Decide: the paths for every unit first; then each task and contact file's rules; one file per id within a unit.
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_own uuid; v_carried record; v_dest text; v_dest_owner uuid;$old$,
	$new$	v_own uuid; v_carried record; v_dest text; v_dest_owner uuid; v_tasks text[] := '{}'; v_contacts text[] := '{}';$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_key := public.qorpera_folder_key(p_eff_path);$old$,
	$new$	v_key := public.qorpera_folder_key(p_eff_path);
	-- 20260929999980 (H2b): human tasks' folders and files, and the contacts they name, for every unit.
	v_rule := public.qorpera_company_state_task_paths(p_environment_id, v_profile, p_actor, p_commit_id, v_op, v_key,
		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path);
	if v_rule is not null then return v_rule; end if;$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			-- 20260929999000 (H1): only the platform marks a secret saved.
$old$,
	$new$			if (v_checked -> 'parse' ->> 'id') = any (v_tasks) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two task files in one change carry the same id'))); end if;
			v_tasks := array_append(v_tasks, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_human_task_rules(p_environment_id, v_profile, p_actor, v_file.key,
				v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
			-- 20260929999000 (H1): only the platform marks a secret saved.
$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		end if;
	end loop;
	return jsonb_build_object('ok', true);
end$old$,
	$new$		elsif v_checked ->> 'kind' = 'contact' then
			if (v_checked -> 'parse' ->> 'id') = any (v_contacts) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two contact files in one change carry the same id'))); end if;
			v_contacts := array_append(v_contacts, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_contact_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end$new$);

-- Apply: write the rows; a move repoints them; a delete retires them.
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				perform public.qorpera_company_state_index_routine(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');$old$,
	$new$				perform public.qorpera_company_state_index_routine(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			-- 20260929999980 (H2b): human tasks and contacts.
			elsif v_kind = 'human-task' then
				perform public.qorpera_company_state_index_human_task(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'contact' then
				perform public.qorpera_company_state_index_contact(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- Todo files follow their path: a new name is the new key, and a new agent folder the new owner (read after the$old$,
	$new$		-- Task and contact files follow their path, and keep their id (20260929999980, H2b).
		update public.qorpera_folder_human_task_index i set folder_path = e.path, folder_key = e.key_text, folder_path_version = e.version,
			commit_id = p_commit_id, updated_at = clock_timestamp()
		from public.qorpera_folder_entries e
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key))
			and e.environment_id = p_environment_id
			and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(i.folder_path, char_length(p_eff_path) + 1)), 'sha256');
		update public.qorpera_folder_contact_index i set folder_path = e.path, folder_key = e.key_text, folder_path_version = e.version,
			commit_id = p_commit_id, updated_at = clock_timestamp()
		from public.qorpera_folder_entries e
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key))
			and e.environment_id = p_environment_id
			and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(i.folder_path, char_length(p_eff_path) + 1)), 'sha256');
		-- Todo files follow their path: a new name is the new key, and a new agent folder the new owner (read after the$new$);
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A connection's file removed (after its account was disconnected): its index row retires.$old$,
	$new$		-- A task's or a contact's file removed: its row retires; a restore revives it (20260929999980, H2b).
		update public.qorpera_folder_human_task_index i set retired_at = clock_timestamp(), commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key));
		update public.qorpera_folder_contact_index i set retired_at = clock_timestamp(), commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key));
		-- A connection's file removed (after its account was disconnected): its index row retires.$new$);

-- Verify: every task and contact row this commit wrote points at its file's current version.
select pg_temp.h2_human_task_index_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		or exists (select 1 from public.qorpera_folder_company_index i$old$,
	$new$		-- 20260929999980 (H2b): task and contact rows.
		or exists (select 1 from public.qorpera_folder_human_task_index t
			where t.environment_id = p_environment_id and t.commit_id = p_commit_id and t.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(t.folder_key, 'sha256') and e.version = t.folder_path_version
					and e.path = t.folder_path))
		or exists (select 1 from public.qorpera_folder_contact_index c
			where c.environment_id = p_environment_id and c.commit_id = p_commit_id and c.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(c.folder_key, 'sha256') and e.version = c.folder_path_version
					and e.path = c.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i$new$);
