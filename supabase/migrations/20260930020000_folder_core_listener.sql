-- Company folder core, slice P29a: file-change wakes on the folder journal (deploy/first-node/RUNTIME-COMPANY-FOLDER-LISTENER.md;
-- core §6 "Wakes", §9). A routine file with `when: file-change` wakes its agent when a saved change touches the watched
-- path; every change set is also offered to a hook H2c (P31) fills in. Folder-v2 only.
--
-- * The drain (qorpera_folder_listen_company) is one company per transaction, outside the materializer: the plain reads
--   (journal, listeners, matches through a new (commit_id, folded key) index, read rights decided once per resource), the
--   fence and ranks 1 to 5 through qorpera_folder_company_enter, the cursor row FOR UPDATE SKIP LOCKED (its lease, after
--   the fence: the company purge deletes it by cascade after taking the fence), the checks under the locks, the sessions
--   KEY SHARE, admission, the wakes, the hook, the cursor. At most 32 new wakes and 46 writing subtransactions a step.
-- * A wake is a routine wake from source 'company-file' whose source_id is the change set (the commit) and whose payload
--   holds version ids; qorpera_folder_read_wake builds the paths when the run reads it, under the run's read rights, so
--   an erased change drops out by itself.
-- * The places that refused a folder-v2 file wake take one: the routine rules and trigger, the trigger check, the pin
--   trigger, qorpera_folder_wake_authorized (with the ChatGPT plan rule and a readable change before the run), the wake
--   policy, the run's resolve, the occurrence count. A coding session's save in a turn takes the turn's run as its
--   causal parent (coordinator, 4 October 2026; C1B amended).
-- * Erasure (P18) notes the runs of file wakes about erased changes, in phases 1 and 2.
-- No fence stronger than KEY SHARE, no profile row stronger than KEY SHARE, every wait at most 2 s, no 40001.
-- Every patched body carries the marker 20260930020000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.p29_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P29 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Tables ------------------------------------------------------------------------------------------------------------

-- One cursor per environment: every seq up to processed_seq is done for every listener and for the hook. The drain
-- creates it after the fence; only the drain locks it.
create table public.qorpera_folder_listener_cursors (
	environment_id uuid primary key references public.qorpera_folder_clocks(environment_id) on delete cascade,
	processed_seq bigint not null default 0 check (processed_seq >= 0),
	updated_at timestamptz not null default clock_timestamp()
);

-- A change set the hook failed on, called again by later steps until it succeeds (coordinator, 4 October 2026). The
-- SQLSTATE and constraint only: an error's text may quote a path.
create table public.qorpera_folder_listener_hook_failures (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	commit_id uuid not null,
	seq bigint not null check (seq > 0),
	sqlstate text not null check (sqlstate ~ '^[0-9A-Z]{5}$'),
	constraint_name text check (constraint_name is null or char_length(constraint_name) between 1 and 128),
	attempts integer not null default 1 check (attempts >= 1),
	last_attempt_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, commit_id)
);
create index qorpera_folder_listener_hook_failures_seq on public.qorpera_folder_listener_hook_failures(environment_id, seq);

alter table public.qorpera_folder_listener_cursors enable row level security;
alter table public.qorpera_folder_listener_hook_failures enable row level security;
revoke all on public.qorpera_folder_listener_cursors, public.qorpera_folder_listener_hook_failures
	from public, anon, authenticated, service_role;

-- 2. Indexes -----------------------------------------------------------------------------------------------------------

-- A change set's versions under a watch: one range, whatever the size of the change set or the history under the watch
-- (an expression index: no table rewrite; core §2's upgrade step reindexes it with the other folder keys).
create index qorpera_folder_path_versions_commit_key
	on public.qorpera_folder_path_versions(commit_id, (public.qorpera_folder_key(path)) collate "C");
-- The file wakes about a change set, for erasure.
create index qorpera_wake_occurrences_company_file on public.qorpera_wake_occurrences(source_id)
	where source_kind = 'company-file';

-- 3. The trigger kind --------------------------------------------------------------------------------------------------

select pg_temp.p29_replace('public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure,
	$old$	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'$old$,
	$new$	-- 20260930020000 (P29): a folder-v2 routine's file-change trigger; watch is a folded key.
	if p_trigger ->> 'kind' = 'file-change' then
		return coalesce(p_trigger ?& array['id','kind','watch','match','timeZone']
			and p_trigger - array['id','kind','watch','match','timeZone','replyPolicy'] = '{}'::jsonb
			and jsonb_typeof(p_trigger -> 'id') = 'string'
			and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
			and jsonb_typeof(p_trigger -> 'watch') = 'string' and p_trigger ->> 'watch' <> ''
			and p_trigger ->> 'watch' = public.qorpera_folder_key(p_trigger ->> 'watch')
			and jsonb_typeof(p_trigger -> 'match') = 'string' and p_trigger ->> 'match' in ('exact','subtree')
			and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
			and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'), false);
	end if;
	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'$new$);

select pg_temp.p29_replace('public.qorpera_company_state_routine_trigger(jsonb)'::regprocedure,
	$old$		when 'once' then jsonb_build_object('kind', 'once', 'at', v_when -> 'at', 'timeZone', p_parse -> 'timezone') end;$old$,
	$new$		when 'once' then jsonb_build_object('kind', 'once', 'at', v_when -> 'at', 'timeZone', p_parse -> 'timezone')
		-- 20260930020000 (P29): the watched path's folded key.
		when 'file-change' then jsonb_build_object('kind', 'file-change', 'watch', public.qorpera_folder_key(v_when ->> 'watch'),
			'match', v_when -> 'match', 'timeZone', p_parse -> 'timezone') end;$new$);

-- The rules: a file-change routine is saved, if its agent with its member may read the watched path (the old listener's
-- check) and no ChatGPT plan pays for it (a plan pays only for work its member starts, 20260928359950).
select pg_temp.p29_replace('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure,
	$old$	elsif v_when = 'file-change' then
		v_problem := 'a file-change routine waits for the folder''s file events, which come later; use every, weekly, window or once';$old$,
	$new$	-- 20260930020000 (P29): file-change routines run on the folder's journal.
	elsif v_when = 'file-change' and v_owner is not null and not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id,
		jsonb_build_object('kind', 'staff_agent', 'staffAgentId', v_owner,
			'requesterUserId', coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId'),
			'audience', jsonb_build_object('kind', 'company'), 'sessionKind', 'in_house'),
		p_parse -> 'trigger' ->> 'watch', 'read') then
		v_problem := 'this routine''s agent may not read ' || left(p_parse -> 'trigger' ->> 'watch', 100) || ', so it cannot watch it';
	elsif v_when = 'file-change' and (exists (select 1 from public.qorpera_company_state_routine_payer(p_profile_id,
			coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, v_version.sponsor_binding_id) payer
			where public.qorpera_sponsor_version_is_chatgpt_plan(payer.binding_id, payer.version))
		or exists (select 1 from public.qorpera_execution_runs run where p_actor ->> 'kind' = 'staff_agent'
			and run.id = (p_actor ->> 'runId')::uuid
			and public.qorpera_sponsor_version_is_chatgpt_plan(run.sponsor_binding_id, run.sponsor_version))) then
		v_problem := 'a ChatGPT plan pays only for work its member starts; a file-change routine needs another AI login';$new$);

-- 4. The pin trigger: a folder-v2 file wake names its change set --------------------------------------------------------

select pg_temp.p29_replace('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$			or (new.source_kind = 'company-file' and (v_trigger ->> 'kind' <> 'listener' or new.file_event_id is null))$old$,
	$new$			or (new.source_kind = 'company-file' and not public.qorpera_company_is_folder_v2(new.profile_id)
				and (v_trigger ->> 'kind' <> 'listener' or new.file_event_id is null))
			-- 20260930020000 (P29): a folder-v2 file wake names its change set, never a snapshot event.
			or (new.source_kind = 'company-file' and public.qorpera_company_is_folder_v2(new.profile_id)
				and (v_trigger ->> 'kind' <> 'file-change' or new.file_event_id is not null or new.source_id is null))$new$);
select pg_temp.p29_replace('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$			else coalesce(new.file_event_id,new.routine_id) end;$old$,
	$new$			when new.source_kind = 'company-file' and public.qorpera_company_is_folder_v2(new.profile_id) then new.source_id
			else coalesce(new.file_event_id,new.routine_id) end;$new$);
select pg_temp.p29_replace('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$		if new.source_kind = 'company-file' then
			select run_id,actor_staff_id into new.parent_run_id,v_actor from public.qorpera_company_path_revisions$old$,
	$new$		if new.source_kind = 'company-file' and public.qorpera_company_is_folder_v2(new.profile_id) then
			-- 20260930020000 (P29): the change set's run, or a coding session's turn run (C1B as amended), is the parent;
			-- its agent is the actor.
			select coalesce(c.run_id, c.turn_run_id), case when c.actor_kind = 'staff_agent' then c.actor_id end
			into new.parent_run_id, v_actor from public.qorpera_folder_commits c
			where c.id = new.source_id and c.environment_id = new.environment_id and c.seq is not null;
			if not found then raise exception 'Wake event is unavailable' using errcode = '42501'; end if;
		elsif new.source_kind = 'company-file' then
			select run_id,actor_staff_id into new.parent_run_id,v_actor from public.qorpera_company_path_revisions$new$);
select pg_temp.p29_replace('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$ else v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id)); end if;$old$,
	$new$ else v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,
	coalesce(new.file_event_id,case when new.source_kind = 'company-file' then new.source_id end,new.id)); end if; -- 20260930020000$new$);

-- 5. The wake policy and the run's resolve ------------------------------------------------------------------------------

select pg_temp.p29_replace('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$			or (v_wake.source_kind = 'company-file' and v_wake.source_id is distinct from v_wake.file_event_id)$old$,
	$new$			or (v_wake.source_kind = 'company-file' and v_wake.file_event_id is not null
				and v_wake.source_id is distinct from v_wake.file_event_id)
			-- 20260930020000 (P29): a folder-v2 file wake's source is a saved change set of its environment.
			or (v_wake.source_kind = 'company-file' and v_wake.file_event_id is null and not exists (select 1
				from public.qorpera_folder_commits c where c.id = v_wake.source_id and c.environment_id = v_wake.environment_id
					and c.seq is not null))$new$);
select pg_temp.p29_replace('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> 'listener')$old$,
	$new$			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> case when v_wake.file_event_id is null
				then 'file-change' else 'listener' end) -- 20260930020000$new$);
select pg_temp.p29_replace('public.qorpera_folder_run_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	if v_wake.source_kind in ('company-file','office-activation','machine-event') then$old$,
	$new$	if v_wake.source_kind in ('office-activation','machine-event') then -- 20260930020000 (P29): file wakes run$new$);

-- 6. The occurrence count: a file wake counts by its key (they share the trigger, and a step's share a time) ----------

create or replace function public.qorpera_routine_occurrence_count(p_routine_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
	-- 20260930020000 (P29): a folder-v2 file wake counts by its occurrence key.
	select count(distinct (wake.trigger_id, coalesce(wake.file_event_id::text,
		case when wake.source_kind = 'company-file' then wake.occurrence_key end, ''), wake.scheduled_for))
	from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine_id
$$;

-- 7. Read rights -------------------------------------------------------------------------------------------------------

-- The actor a routine wake's run will have: its agent and member, the audience of the conversation the wake answers in
-- (company when it has none), in house (as qorpera_folder_run_resolve builds it).
create function public.qorpera_folder_listener_actor(p_profile_id uuid, p_staff_agent_id uuid, p_requester uuid,
	p_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('kind', 'staff_agent', 'staffAgentId', p_staff_agent_id, 'requesterUserId', p_requester,
		'audience', coalesce((select jsonb_build_object('kind', s.audience_kind, 'userId', s.audience_user_id)
			from public.qorpera_shared_sessions s where s.id = p_session_id and s.profile_id = p_profile_id),
			jsonb_build_object('kind', 'company')),
		'sessionKind', 'in_house')
$$;

-- A change set's versions under a watch that the actor may read (§5): at most 21 version ids, and how many more readable
-- ones there are (up to 1000). The watched range is cut at every resource boundary under it (and at the top-level
-- credentials/, secrets/ and members/), so one resource governs each piece. A piece is decided once, by the resolver on
-- its first changed path, and read through the commit-and-key index only when readable. A piece under members/ is
-- checked path by path, since a member's private folder is ruled by its owner (at most 2048 paths per change set).
create function public.qorpera_folder_listener_matches(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_commit_id uuid, p_watch text, p_match text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	c_versions constant integer := 21; c_count constant integer := 1021; c_member_paths constant integer := 2048;
	v_bounds text[]; v_lo text; v_hi text; v_first record; v_row record; v_versions uuid[] := '{}'; v_seen integer := 0;
	v_member_paths integer := 0;
begin
	if p_match = 'exact' then
		v_bounds := array[p_watch, p_watch || chr(1)];
	else
		select array_agg(x.b order by x.b collate "C") into v_bounds from (
			select distinct b from (
				select unnest(array[p_watch, p_watch || chr(1), p_watch || '/', p_watch || '0']) as b
				union all
				select unnest(array[rk.k, rk.k || chr(1), rk.k || '/', rk.k || '0']) from (
					select public.qorpera_folder_key(r.path) as k from public.qorpera_company_path_resources r
					where r.environment_id = p_environment_id) rk
				where rk.k collate "C" > (p_watch || '/') collate "C" and rk.k collate "C" < (p_watch || '0') collate "C"
				union all
				select unnest(array[s, s || chr(1), s || '/', s || '0']) from unnest(array['credentials','secrets','members']) s
			) y where y.b collate "C" >= p_watch collate "C" and y.b collate "C" <= (p_watch || '0') collate "C") x;
	end if;
	for i in 1 .. coalesce(array_length(v_bounds, 1), 0) - 1 loop
		v_lo := v_bounds[i]; v_hi := v_bounds[i + 1];
		exit when v_seen >= c_count;
		-- Between the watched path itself and its subtree lie its siblings (docs/f-x beside docs/f): not watched.
		continue when p_match = 'subtree' and v_lo collate "C" >= (p_watch || chr(1)) collate "C"
			and v_lo collate "C" < (p_watch || '/') collate "C";
		if v_lo collate "C" >= 'members/' collate "C" and v_lo collate "C" < 'members0' collate "C" then
			for v_row in select v.version, v.path from public.qorpera_folder_path_versions v
				where v.commit_id = p_commit_id
					and public.qorpera_folder_key(v.path) collate "C" >= v_lo collate "C"
					and public.qorpera_folder_key(v.path) collate "C" < v_hi collate "C"
				order by public.qorpera_folder_key(v.path) collate "C", v.version
				limit greatest(c_member_paths - v_member_paths, 0)
			loop
				v_member_paths := v_member_paths + 1;
				if public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_row.path, 'read') then
					v_seen := v_seen + 1;
					if cardinality(v_versions) < c_versions then v_versions := v_versions || v_row.version; end if;
					exit when v_seen >= c_count;
				end if;
			end loop;
		else
			select v.path into v_first from public.qorpera_folder_path_versions v
			where v.commit_id = p_commit_id
				and public.qorpera_folder_key(v.path) collate "C" >= v_lo collate "C"
				and public.qorpera_folder_key(v.path) collate "C" < v_hi collate "C"
			order by public.qorpera_folder_key(v.path) collate "C", v.version limit 1;
			continue when not found;
			continue when not public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_first.path, 'read');
			for v_row in select v.version from public.qorpera_folder_path_versions v
				where v.commit_id = p_commit_id
					and public.qorpera_folder_key(v.path) collate "C" >= v_lo collate "C"
					and public.qorpera_folder_key(v.path) collate "C" < v_hi collate "C"
				order by public.qorpera_folder_key(v.path) collate "C", v.version limit c_count - v_seen
			loop
				v_seen := v_seen + 1;
				if cardinality(v_versions) < c_versions then v_versions := v_versions || v_row.version; end if;
			end loop;
		end if;
	end loop;
	return jsonb_build_object('versions', to_jsonb(v_versions), 'more', greatest(v_seen - cardinality(v_versions), 0));
end $$;

-- Before a file wake runs (at materialization, through qorpera_folder_wake_authorized): one of its changes still exists
-- and its run may read it (WAKE-BUS: read rights hold at materialization as at delivery).
create function public.qorpera_folder_file_wake_readable(p_wake public.qorpera_wake_occurrences)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from jsonb_array_elements_text(coalesce(p_wake.payload -> 'versions', '[]'::jsonb)) x(version)
		join public.qorpera_folder_path_versions v on v.version = x.version::uuid and v.commit_id = p_wake.source_id
		where public.qorpera_folder_actor_allowed(p_wake.environment_id, p_wake.profile_id,
			public.qorpera_folder_listener_actor(p_wake.profile_id, p_wake.staff_agent_id, p_wake.requested_by_user_id,
				p_wake.session_id), v.path, 'read'))
$$;

-- The changes a file wake's run reads (§6), built when it reads them: the stored versions that still exist and the run
-- may still read, at most 8 KiB, a move's source and prior version only when the source is readable too. An erased
-- change has no version, so it drops out by itself; one past the budget counts in more.
create function public.qorpera_folder_file_wake_changes(p_wake public.qorpera_wake_occurrences, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_changes jsonb := '[]'::jsonb; v_change jsonb; v_row record; v_from text; v_bytes integer := 0;
	v_more integer := coalesce((p_wake.payload ->> 'more')::integer, 0);
begin
	for v_row in select v.version, v.path, v.op, v.prior_version, v.unit_no
		from jsonb_array_elements_text(coalesce(p_wake.payload -> 'versions', '[]'::jsonb)) with ordinality x(version, n)
		join public.qorpera_folder_path_versions v on v.version = x.version::uuid and v.commit_id = p_wake.source_id
		order by x.n
	loop
		continue when not public.qorpera_folder_actor_allowed(p_wake.environment_id, p_wake.profile_id, p_actor, v_row.path, 'read');
		v_change := jsonb_build_object('path', v_row.path, 'op', v_row.op, 'version', v_row.version);
		if v_row.op = 'move_in' then
			select o.path into v_from from public.qorpera_folder_path_versions o
			where o.commit_id = p_wake.source_id and o.unit_no = v_row.unit_no and o.prior_version = v_row.prior_version
				and o.op = 'move_out' limit 1;
			if v_from is not null
				and public.qorpera_folder_actor_allowed(p_wake.environment_id, p_wake.profile_id, p_actor, v_from, 'read') then
				v_change := v_change || jsonb_build_object('from', v_from, 'priorVersion', v_row.prior_version);
			end if;
			v_from := null;
		elsif v_row.prior_version is not null then
			v_change := v_change || jsonb_build_object('priorVersion', v_row.prior_version);
		end if;
		if v_bytes + octet_length(v_change::text) > 8192 then
			v_more := v_more + 1;
		else
			v_bytes := v_bytes + octet_length(v_change::text);
			v_changes := v_changes || jsonb_build_array(v_change);
		end if;
	end loop;
	return jsonb_build_object('schema', 'qorpera.folder-file-wake/v1', 'seq', (p_wake.payload ->> 'seq')::bigint,
		'commitId', p_wake.source_id, 'changes', v_changes, 'more', least(v_more, 1000));
end $$;

-- 8. The wake's authority and its read -----------------------------------------------------------------------------------

select pg_temp.p29_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$		or p_wake.source_kind in ('company-file','office-activation','machine-event','event') then return false; end if;$old$,
	$new$		or p_wake.source_kind in ('office-activation','machine-event','event') then return false; end if;
	-- 20260930020000 (P29): a ChatGPT plan pays for no file wake and for nothing that follows a listener (20260928359950).
	if public.qorpera_sponsor_version_is_chatgpt_plan(p_wake.sponsor_binding_id, p_wake.sponsor_version)
		and (public.qorpera_listener_source(p_wake.source_kind) or public.qorpera_run_follows_listener(p_wake.parent_run_id)) then
		return false; end if;
	-- A file wake names a saved change set of its environment; before it runs, one of its changes is still readable.
	if p_wake.source_kind = 'company-file' and (not exists (select 1 from public.qorpera_folder_commits c
			where c.id = p_wake.source_id and c.environment_id = p_wake.environment_id and c.seq is not null)
		or (p_wake.run_id is null and not public.qorpera_folder_file_wake_readable(p_wake))) then return false; end if;$new$);
select pg_temp.p29_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$		v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id, null, p_wake.staff_agent_id, coalesce(p_wake.file_event_id, p_wake.id));$old$,
	$new$		-- 20260930020000 (P29): a file wake's chain as the pin trigger made it, from its change set's agent and root.
		v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,
			case when p_wake.source_kind = 'company-file' then (select case when c.actor_kind = 'staff_agent' then c.actor_id end
				from public.qorpera_folder_commits c where c.id = p_wake.source_id) end,
			p_wake.staff_agent_id,
			coalesce(p_wake.file_event_id, case when p_wake.source_kind = 'company-file' then p_wake.source_id end, p_wake.id));$new$);

select pg_temp.p29_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$	elsif v_wake.source_kind in ('input','room') then v_actor_user := v_run.requested_by_user_id;$old$,
	$new$	elsif v_wake.source_kind in ('input','room') then v_actor_user := v_run.requested_by_user_id;
	elsif v_wake.source_kind = 'company-file' then
		-- 20260930020000 (P29): the member whose change set woke the run.
		select case when c.actor_kind = 'member' then c.actor_id end into v_actor_user
		from public.qorpera_folder_commits c where c.id = v_wake.source_id;$new$);
select pg_temp.p29_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$		'routine',v_routine,'payload',v_wake.payload || case when v_wake.source_kind = 'coworker'$old$,
	$new$		'routine',v_routine,'payload',(case when v_wake.source_kind = 'company-file' -- 20260930020000 (P29)
			then public.qorpera_folder_file_wake_changes(v_wake, v_tool -> 'resolved') else v_wake.payload end)
			|| case when v_wake.source_kind = 'coworker'$new$);

-- 9. Erasure: the runs a file wake about an erased change started --------------------------------------------------------

select pg_temp.p29_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
			on conflict do nothing;$old$,
	$new$			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
			on conflict do nothing;
			-- 20260930020000 (P29): the runs a file wake about these change sets started.
			insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
			select distinct v_erasure.id, w.run_id from jsonb_array_elements(v_batch) b
			join public.qorpera_wake_occurrences w on w.source_kind = 'company-file' and w.source_id = (b ->> 'commitId')::uuid
			where w.run_id is not null
			on conflict do nothing;$new$);
select pg_temp.p29_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$					v_units := public.qorpera_folder_erasure_units(v_commit.units, v_commit.seq, v_commit.created_at,
						v_erasure.roots, v_needles);
					if v_units is not null then
						update public.qorpera_folder_commits set units = v_units where id = v_commit.id;$old$,
	$new$					v_units := public.qorpera_folder_erasure_units(v_commit.units, v_commit.seq, v_commit.created_at,
						v_erasure.roots, v_needles);
					if v_units is not null then
						update public.qorpera_folder_commits set units = v_units where id = v_commit.id;
						-- 20260930020000 (P29): again, the runs a file wake about this change set started (one that read its
						-- wake before phase 1 deleted the versions is materialized by now).
						insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
						select distinct v_erasure.id, w.run_id from public.qorpera_wake_occurrences w
						where w.source_kind = 'company-file' and w.source_id = v_commit.id and w.run_id is not null
						on conflict do nothing;$new$);

-- 10. The hook for H2c (P31) -----------------------------------------------------------------------------------------------

-- Both are no-ops until P31 replaces them (create or replace, its own body marker; §8). The targets: {targets, sessions,
-- admit}, called once a step before the ranks with the step's change sets and the failures it calls again. The commit:
-- called per change set in seq order after admission, with {commitId, seq, actor: {kind, id}, runId, paused}.
create function public.qorpera_folder_listener_targets(p_environment_id uuid, p_commits jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930020000 (P29): nothing to lock until H2c (P31).
	return '{"targets":[],"sessions":[],"admit":false}'::jsonb;
end $$;
create function public.qorpera_folder_listener_commit(p_environment_id uuid, p_commit jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930020000 (P29): nothing to do until H2c (P31).
	return;
end $$;

-- 11. The due list ---------------------------------------------------------------------------------------------------------

-- The folder-v2 environments whose clock is ahead of their cursor (an absent cursor counts as behind), or with a hook
-- failure to call again, in environment order after p_after_environment, leaving out companies being deleted. A plain
-- read.
create function public.qorpera_folder_listen_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_environments uuid[];
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder listen limit is invalid' using errcode = '22023'; end if;
	select coalesce(array_agg(x.environment_id order by x.environment_id), '{}') into v_environments from (
		select f.environment_id from public.qorpera_company_files f
		join public.qorpera_folder_clocks k on k.environment_id = f.environment_id
		left join public.qorpera_folder_listener_cursors c on c.environment_id = f.environment_id
		where f.core = 'folder-v2' and (k.last_seq > coalesce(c.processed_seq, 0)
				or exists (select 1 from public.qorpera_folder_listener_hook_failures h where h.environment_id = f.environment_id))
			and (p_after_environment is null or f.environment_id > p_after_environment)
			and not public.qorpera_company_deleting(f.profile_id)
		order by f.environment_id limit p_limit) x;
	return jsonb_build_object('schema', 'qorpera.folder-listen-due/v1', 'environments', to_jsonb(v_environments),
		'next', case when cardinality(v_environments) = p_limit then v_environments[cardinality(v_environments)] end);
end $$;

-- 12. The drain -----------------------------------------------------------------------------------------------------------

-- One step of one company's listeners (§4), in its own transaction, never inside the materializer's. Answers
-- {state: done | idle | paused | busy | deleting | not_folder, processedSeq, wakes, skipped, hookFailures, more}.
create function public.qorpera_folder_listen_company(p_environment_id uuid, p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-listen/v1';
	-- New wakes a step; writing subtransactions a step besides the step's own (core §3 step 7: under 64); listeners × seqs
	-- a step reads; failed change sets a step calls again.
	c_wakes constant integer := 32; c_blocks constant integer := 46; c_pairs constant integer := 512; c_retries constant integer := 4;
	v_profile uuid; v_start bigint; v_last bigint; v_until bigint; v_window integer; v_cursor bigint; v_paused boolean;
	v_listeners jsonb; v_commits jsonb; v_retries jsonb; v_hook jsonb; v_targets jsonb; v_matches jsonb := '[]'::jsonb;
	v_kept jsonb := '[]'::jsonb; v_listener record; v_commit record; v_match record; v_retry record; v_found jsonb;
	v_actor jsonb; v_session uuid; v_sessions uuid[]; v_routine public.qorpera_cloud_routines%rowtype; v_activation bigint;
	v_wake public.qorpera_wake_occurrences%rowtype; v_inserted jsonb := '{}'::jsonb; v_wakes integer := 0; v_blocks integer := 0;
	v_skipped integer := 0; v_failures integer := 0; v_done bigint; v_stop boolean := false; v_state text; v_message text;
	v_constraint text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder listening runs at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 256 then
		raise exception 'Folder listen limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;

	-- 1. Plain reads: the cursor and the clock, the listeners, the window's change sets, their matches, the hook's targets.
	v_start := coalesce((select processed_seq from public.qorpera_folder_listener_cursors where environment_id = p_environment_id), 0);
	select last_seq into v_last from public.qorpera_folder_clocks where environment_id = p_environment_id;
	-- Nothing new and no hook failure to call again: idle.
	if coalesce(v_last, 0) <= v_start and not exists (select 1 from public.qorpera_folder_listener_hook_failures
			where environment_id = p_environment_id) then
		return jsonb_build_object('schema', c_schema, 'state', 'idle', 'processedSeq', v_start); end if;
	-- A listener: an active folder-v2 routine whose current version listens for file changes, with the seq of the change
	-- set that last saved it (activation: it hears only later ones). A routine whose activation cannot be read is none.
	select coalesce(jsonb_agg(jsonb_build_object('routineId', r.id, 'version', v.version, 'staff', v.staff_agent_id,
			'requester', v.created_by_user_id, 'trigger', t.value, 'activation', c.seq) order by r.id), '[]'::jsonb)
	into v_listeners
	from public.qorpera_cloud_routines r
	join public.qorpera_cloud_routine_versions v on v.routine_id = r.id and v.version = r.current_version
	join lateral (select x.value from jsonb_array_elements(v.triggers) x(value) where x.value ->> 'kind' = 'file-change'
		limit 1) t on true
	join public.qorpera_folder_commits c on c.id = r.folder_commit_id and c.seq is not null
	where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.status = 'active'
		and r.profile_id = v_profile;
	-- Listeners × seqs within the step's budget: a company with many listeners reads a smaller window.
	v_window := least(p_limit, greatest(1, c_pairs / greatest(jsonb_array_length(v_listeners), 1)));
	v_until := least(v_last, v_start + v_window);
	select coalesce(jsonb_agg(jsonb_build_object('commitId', c.id, 'seq', c.seq, 'createdAt', c.created_at,
			'actor', jsonb_build_object('kind', c.actor_kind, 'id', c.actor_id), 'runId', c.run_id, 'turnRunId', c.turn_run_id)
			order by c.seq), '[]'::jsonb)
	into v_commits
	from public.qorpera_folder_journal j join public.qorpera_folder_commits c on c.id = j.commit_id
	where j.environment_id = p_environment_id and j.seq > v_start and j.seq <= v_until and j.kind = 'change_set';
	for v_listener in select x.value as l from jsonb_array_elements(v_listeners) x loop
		v_session := public.qorpera_folder_wake_public_session(v_profile, p_environment_id, (v_listener.l ->> 'staff')::uuid,
			(v_listener.l ->> 'requester')::uuid);
		v_actor := public.qorpera_folder_listener_actor(v_profile, (v_listener.l ->> 'staff')::uuid,
			(v_listener.l ->> 'requester')::uuid, v_session);
		for v_commit in select x.value as c from jsonb_array_elements(v_commits) x
			where (x.value ->> 'seq')::bigint > (v_listener.l ->> 'activation')::bigint
		loop
			v_found := public.qorpera_folder_listener_matches(p_environment_id, v_profile, v_actor, (v_commit.c ->> 'commitId')::uuid,
				v_listener.l -> 'trigger' ->> 'watch', v_listener.l -> 'trigger' ->> 'match');
			if jsonb_array_length(v_found -> 'versions') > 0 then
				v_matches := v_matches || jsonb_build_array(v_listener.l || v_commit.c || jsonb_build_object('session', v_session,
					'versions', v_found -> 'versions', 'more', v_found -> 'more'));
			end if;
		end loop;
	end loop;
	select coalesce(jsonb_agg(c.value || jsonb_build_object('retry', true) order by (c.value ->> 'seq')::bigint), '[]'::jsonb)
	into v_retries from (
		select jsonb_build_object('commitId', f.commit_id, 'seq', f.seq,
			'actor', jsonb_build_object('kind', c.actor_kind, 'id', c.actor_id), 'runId', c.run_id) as value
		from public.qorpera_folder_listener_hook_failures f join public.qorpera_folder_commits c on c.id = f.commit_id
		where f.environment_id = p_environment_id order by f.seq limit c_retries) c;
	v_hook := public.qorpera_folder_listener_targets(p_environment_id, v_retries || v_commits);
	if jsonb_typeof(v_hook) is distinct from 'object' then v_hook := '{"targets":[],"sessions":[],"admit":false}'::jsonb; end if;
	select coalesce(jsonb_agg(y.t), '[]'::jsonb) into v_targets from (
		select distinct x.t from jsonb_array_elements(v_matches) m, lateral (values
			(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || (m.value ->> 'requester'),
				'mode', 'keyshare')),
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || (m.value ->> 'staff'),
				'mode', 'keyshare')),
			(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
				'key', v_profile::text || ':' || (m.value ->> 'staff'), 'mode', 'keyshare')),
			(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', m.value ->> 'routineId', 'mode', 'nokeyupdate'))) x(t)) y;
	v_targets := v_targets || coalesce(v_hook -> 'targets', '[]'::jsonb);

	begin
		-- 2. The fence KEY SHARE, rank 0, ranks 1 to 5 (routine firing's and the materializer's prefix).
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
		-- 3. The lease: the cursor row, made after the fence, FOR UPDATE SKIP LOCKED; moved since the read: another step's.
		-- Made only when absent: an insert that meets a row another drain holds waits for it, where the lease must skip.
		if not exists (select 1 from public.qorpera_folder_listener_cursors where environment_id = p_environment_id) then
			insert into public.qorpera_folder_listener_cursors(environment_id) values (p_environment_id) on conflict do nothing;
		end if;
		select processed_seq into v_cursor from public.qorpera_folder_listener_cursors
		where environment_id = p_environment_id for update skip locked;
		if not found or v_cursor <> v_start then return jsonb_build_object('schema', c_schema, 'state', 'busy'); end if;
		v_paused := public.qorpera_company_execution_paused(v_profile);

		-- 4. The checks under the locks: everything the wake's triggers refuse, so an insert does not raise. A failed check
		-- is final, as a denied claim is today; a wake that exists already is passed over (a step that stopped inside a seq).
		if not v_paused then
			for v_match in select x.value as m from jsonb_array_elements(v_matches) x
				order by (x.value ->> 'seq')::bigint, x.value ->> 'routineId'
			loop
				select * into v_routine from public.qorpera_cloud_routines where id = (v_match.m ->> 'routineId')::uuid;
				select c.seq into v_activation from public.qorpera_folder_commits c where c.id = v_routine.folder_commit_id;
				v_session := public.qorpera_folder_wake_public_session(v_profile, p_environment_id, (v_match.m ->> 'staff')::uuid,
					(v_match.m ->> 'requester')::uuid);
				if exists (select 1 from public.qorpera_wake_occurrences w where w.routine_id = v_routine.id
						and w.occurrence_key = 'file:' || (v_match.m ->> 'seq') || ':' || (v_match.m ->> 'version')) then
					continue; end if;
				if v_routine.status is distinct from 'active' or v_routine.current_version is distinct from (v_match.m ->> 'version')::bigint
					or v_routine.folder_path is null or v_activation is null or v_activation >= (v_match.m ->> 'seq')::bigint
					or (v_routine.expires_at is not null and (v_match.m ->> 'createdAt')::timestamptz >= v_routine.expires_at)
					or (v_routine.max_occurrences is not null and public.qorpera_routine_occurrence_count(v_routine.id)
						+ coalesce((v_inserted ->> v_routine.id::text)::integer, 0) >= v_routine.max_occurrences)
					or not exists (select 1 from public.qorpera_profile_members where profile_id = v_profile
						and user_id = (v_match.m ->> 'requester')::uuid)
					or not exists (select 1 from public.qorpera_profile_staff where profile_id = v_profile
						and staff_agent_id = (v_match.m ->> 'staff')::uuid and employment_status = 'active')
					or (coalesce(v_match.m -> 'trigger' ->> 'replyPolicy', 'required') = 'required' and v_session is null)
					or public.qorpera_wake_ancestry(coalesce((v_match.m ->> 'runId')::uuid, (v_match.m ->> 'turnRunId')::uuid),
						case when v_match.m -> 'actor' ->> 'kind' = 'staff_agent' then (v_match.m -> 'actor' ->> 'id')::uuid end,
						(v_match.m ->> 'staff')::uuid, (v_match.m ->> 'commitId')::uuid) is null then
					v_skipped := v_skipped + 1;
					continue;
				end if;
				v_kept := v_kept || jsonb_build_array(v_match.m || jsonb_build_object('session', v_session));
				v_inserted := v_inserted || jsonb_build_object(v_routine.id::text,
					coalesce((v_inserted ->> v_routine.id::text)::integer, 0) + 1);
			end loop;
		end if;

		-- 5. The conversations the wakes answer in and the hook's, KEY SHARE in id order, before admission.
		select coalesce(array_agg(distinct s.id), '{}') into v_sessions from (
			select (x.value ->> 'session')::uuid as id from jsonb_array_elements(v_kept) x where x.value ->> 'session' is not null
			union all
			select h.value::uuid from jsonb_array_elements_text(coalesce(v_hook -> 'sessions', '[]'::jsonb)) h) s;
		perform 1 from public.qorpera_shared_sessions where id = any(v_sessions) order by id for key share;
		-- 6. Admission, only when a wake will be written.
		if (not v_paused and jsonb_array_length(v_kept) > 0) or coalesce((v_hook ->> 'admit')::boolean, false) then
			perform public.qorpera_folder_admit_wakes(v_profile); end if;

		-- 7. The hook's recorded failures again, oldest first.
		for v_retry in select x.value as c from jsonb_array_elements(v_retries) x loop
			exit when v_blocks >= c_blocks;
			v_blocks := v_blocks + 1;
			begin
				perform public.qorpera_folder_listener_commit(p_environment_id,
					(v_retry.c - 'retry') || jsonb_build_object('paused', v_paused));
				delete from public.qorpera_folder_listener_hook_failures
				where environment_id = p_environment_id and commit_id = (v_retry.c ->> 'commitId')::uuid;
			exception
				when lock_not_available or deadlock_detected then raise;
				when others then
					get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
					update public.qorpera_folder_listener_hook_failures set sqlstate = v_state,
						constraint_name = nullif(left(v_constraint, 128), ''), attempts = attempts + 1, last_attempt_at = clock_timestamp()
					where environment_id = p_environment_id and commit_id = (v_retry.c ->> 'commitId')::uuid;
					v_failures := v_failures + 1;
			end;
		end loop;

		-- 8. Each change set in seq order: its wakes, then the hook. A bound stops the step before the first seq not done.
		v_done := v_start;
		for v_commit in select x.value as c from jsonb_array_elements(v_commits) x order by (x.value ->> 'seq')::bigint loop
			for v_match in select x.value as m from jsonb_array_elements(v_kept) x
				where (x.value ->> 'seq')::bigint = (v_commit.c ->> 'seq')::bigint order by x.value ->> 'routineId'
			loop
				if v_wakes >= c_wakes or v_blocks >= c_blocks then v_stop := true; exit; end if;
				v_blocks := v_blocks + 1;
				begin
					insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, wake_kind,
						source_kind, source_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
					values (extensions.gen_random_uuid(), v_profile, p_environment_id, (v_match.m ->> 'routineId')::uuid,
						(v_match.m ->> 'version')::bigint, 'routine', 'company-file', (v_match.m ->> 'commitId')::uuid,
						v_match.m -> 'trigger' ->> 'id', 'file:' || (v_match.m ->> 'seq') || ':' || (v_match.m ->> 'version'),
						(v_match.m ->> 'createdAt')::timestamptz, clock_timestamp(),
						jsonb_build_object('schema', 'qorpera.folder-file-wake/v1', 'seq', (v_match.m ->> 'seq')::bigint,
							'commitId', v_match.m ->> 'commitId', 'versions', v_match.m -> 'versions', 'more', v_match.m -> 'more'))
					returning * into v_wake;
					-- The trigger chose the conversation without a lock: it must be the one this step locked.
					if v_wake.session_id is distinct from (v_match.m ->> 'session')::uuid then
						raise exception 'Wake routine audience changed' using errcode = 'QP29S'; end if;
					v_wakes := v_wakes + 1;
				exception
					when sqlstate '55000' or sqlstate '42501' then
						get stacked diagnostics v_message = message_text;
						if v_message not in ('Routine has expired', 'Routine occurrence limit reached', 'Wake causal ancestry is fenced',
							'Wake recipient authority is unavailable', 'Wake public audience is unavailable') then raise; end if;
						v_skipped := v_skipped + 1;
				end;
			end loop;
			exit when v_stop or v_blocks >= c_blocks;
			v_blocks := v_blocks + 1;
			begin
				perform public.qorpera_folder_listener_commit(p_environment_id,
					(v_commit.c - 'createdAt' - 'turnRunId') || jsonb_build_object('paused', v_paused));
			exception
				when lock_not_available or deadlock_detected then raise;
				when others then
					get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
					insert into public.qorpera_folder_listener_hook_failures(environment_id, commit_id, seq, sqlstate, constraint_name)
					values (p_environment_id, (v_commit.c ->> 'commitId')::uuid, (v_commit.c ->> 'seq')::bigint, v_state,
						nullif(left(v_constraint, 128), ''))
					on conflict (environment_id, commit_id) do update set sqlstate = excluded.sqlstate,
						constraint_name = excluded.constraint_name, attempts = public.qorpera_folder_listener_hook_failures.attempts + 1,
						last_attempt_at = clock_timestamp();
					v_failures := v_failures + 1;
			end;
			v_done := (v_commit.c ->> 'seq')::bigint;
		end loop;
		-- Every change set done: the authority rows up to the window's end are done too.
		if not v_stop and v_done = coalesce((select max((x.value ->> 'seq')::bigint) from jsonb_array_elements(v_commits) x), v_start) then
			v_done := v_until; end if;

		-- 9. The cursor.
		update public.qorpera_folder_listener_cursors set processed_seq = v_done, updated_at = clock_timestamp()
		where environment_id = p_environment_id;
	exception
		-- A row someone holds, or the conversation chosen at insert moved: nothing of this step stays; the next tick goes on.
		when lock_not_available or deadlock_detected or sqlstate 'QP29S' then
			return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', case when v_paused then 'paused' else 'done' end,
		'processedSeq', v_done, 'wakes', v_wakes, 'skipped', v_skipped, 'hookFailures', v_failures, 'more', v_done < v_last);
end $$;

-- 13. Grants ---------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_listener_actor(uuid, uuid, uuid, uuid),
	public.qorpera_folder_listener_matches(uuid, uuid, jsonb, uuid, text, text),
	public.qorpera_folder_file_wake_readable(public.qorpera_wake_occurrences),
	public.qorpera_folder_file_wake_changes(public.qorpera_wake_occurrences, jsonb),
	public.qorpera_folder_listener_targets(uuid, jsonb), public.qorpera_folder_listener_commit(uuid, jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_listen_due(uuid, integer), public.qorpera_folder_listen_company(uuid, integer)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_listen_due(uuid, integer), public.qorpera_folder_listen_company(uuid, integer)
	to service_role;
