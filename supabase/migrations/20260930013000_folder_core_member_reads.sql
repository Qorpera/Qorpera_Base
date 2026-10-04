-- Company folder core, C4 slice P27a: members read their company's folder (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §2; core §6 "Clients" and §11 C4). Built by the Interfaces session, which builds
-- the folder-v2 file page (P33) on it. Member writes stay held for P31.
--
-- Inert for today's companies: every function here serves folder-v2 environments only, which only an operator can
-- create until the reset (C5).
--
-- * The caller check. qorpera_folder_read, qorpera_folder_list, qorpera_folder_feed and
--   qorpera_folder_authorize_object_download refused every caller but service_role. They now also take an
--   authenticated member whose actor is exactly their own ({"kind":"member","userId":auth.uid()}). They stay closed
--   to authenticated (no grant), so only the member functions below reach that branch. One line of each is patched
--   by exact text, with this slice's body marker.
-- * The member functions (authenticated). Each first finds the member's own actor: a member of the company whose
--   environment is folder-v2, else 42501 as if there were no folder. Membership is read without a lock: these are
--   reads. Then:
--   - qorpera_member_folder_read(env, path) and qorpera_member_folder_list(env, parent, after, limit): the core's;
--   - qorpera_member_folder_changes(env, after_seq, limit, cursor): the feed, with each change set's `by` and `at`;
--   - qorpera_member_folder_path_history(env, path, before, limit): a path's versions, newest first;
--   - qorpera_member_folder_history(env, before, limit): the change sets, newest first, with their readable paths;
--   - qorpera_member_folder_object(env, sha256): the byte check, for the object gateway's member route (P27b).
--   A path the member may not read now looks absent everywhere; history checks read authority now, against the path's
--   current resource. A company being deleted refuses (55000, qorpera_folder_read_actor since 20260930001000).
-- * Attribution. `by` is {"kind":"member","userId"}, {"kind":"agent","staffAgentId"} or {"kind":"platform"}, from the
--   commit row (contract 4.2). Which member asked an agent is not shown: the conversation may be private to them.

create function pg_temp.folder_member_reads_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The caller check -------------------------------------------------------------------------------------------

-- service_role, or an authenticated member whose actor is exactly their own. A member who is not in the company reads
-- nothing through it either: the member functions check membership first, and the core's own checks stay.
create function public.qorpera_folder_caller_allowed(p_actor jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	-- C4 P27a (20260930013000): a member's own actor too.
	select coalesce(auth.role() = 'service_role'
		or (auth.role() = 'authenticated' and auth.uid() is not null
			and p_actor = jsonb_build_object('kind', 'member', 'userId', auth.uid()::text)), false)
$$;
revoke all on function public.qorpera_folder_caller_allowed(jsonb) from public, anon, authenticated, service_role;

select pg_temp.folder_member_reads_patch(p, $old$if auth.role() is distinct from 'service_role' then$old$,
	$new$-- C4 P27a (20260930013000): service_role, or a member's own actor through the member functions.
	if not public.qorpera_folder_caller_allowed(p_actor) then$new$)
from unnest(array['public.qorpera_folder_read(uuid,jsonb,text)',
	'public.qorpera_folder_list(uuid,jsonb,text,text,integer,boolean)',
	'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)']::regprocedure[]) as p;
select pg_temp.folder_member_reads_patch('public.qorpera_folder_authorize_object_download(uuid,jsonb,text)',
	$old$if auth.role() is distinct from 'service_role' then raise exception$old$,
	$new$-- C4 P27a (20260930013000): service_role, or a member's own actor through the member functions.
	if not public.qorpera_folder_caller_allowed(p_actor) then raise exception$new$);

-- 2. The member's own actor ---------------------------------------------------------------------------------------

create function public.qorpera_member_folder_actor(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
	-- C4 P27a (20260930013000): a member of a folder-v2 company, else no folder at all.
	if auth.role() is distinct from 'authenticated' or v_user is null or not exists (
		select 1 from public.qorpera_company_files as file
		join public.qorpera_profile_members as member on member.profile_id = file.profile_id
		where file.environment_id = p_environment_id and file.core = 'folder-v2' and member.user_id = v_user) then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('kind', 'member', 'userId', v_user);
end $$;
revoke all on function public.qorpera_member_folder_actor(uuid) from public, anon, authenticated, service_role;

-- Who made a commit, as members see it.
create function public.qorpera_folder_commit_by(p_commit public.qorpera_folder_commits)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- C4 P27a (20260930013000): the commit's attribution, without the member who asked an agent.
	select case p_commit.actor_kind
		when 'member' then jsonb_build_object('kind', 'member', 'userId', p_commit.actor_id)
		when 'staff_agent' then jsonb_build_object('kind', 'agent', 'staffAgentId', p_commit.actor_id)
		else jsonb_build_object('kind', 'platform') end
$$;
revoke all on function public.qorpera_folder_commit_by(public.qorpera_folder_commits)
	from public, anon, authenticated, service_role;

-- 3. Read, list, changes and bytes ----------------------------------------------------------------------------------

create function public.qorpera_member_folder_read(p_environment_id uuid, p_path text)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- C4 P27a (20260930013000)
	select public.qorpera_folder_read(p_environment_id, public.qorpera_member_folder_actor(p_environment_id), p_path)
$$;

create function public.qorpera_member_folder_list(p_environment_id uuid, p_parent text, p_after text, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- C4 P27a (20260930013000)
	select public.qorpera_folder_list(p_environment_id, public.qorpera_member_folder_actor(p_environment_id), p_parent,
		p_after, p_limit, false)
$$;

-- The feed as the core gives it (positions included, core §6), with each change set's attribution.
create function public.qorpera_member_folder_changes(p_environment_id uuid, p_after_seq bigint, p_limit integer,
	p_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_feed jsonb;
begin
	-- C4 P27a (20260930013000)
	v_feed := public.qorpera_folder_feed(p_environment_id, public.qorpera_member_folder_actor(p_environment_id),
		p_after_seq, p_limit, p_cursor);
	return jsonb_set(v_feed, '{events}', coalesce((
		select jsonb_agg(case when event.value ->> 'kind' = 'change_set'
				then event.value || jsonb_build_object('by', public.qorpera_folder_commit_by(commit_row),
					'at', commit_row.created_at)
				else event.value end order by event.position)
		from jsonb_array_elements(v_feed -> 'events') with ordinality as event(value, position)
		left join public.qorpera_folder_commits as commit_row
			on commit_row.id = (event.value ->> 'commitId')::uuid and commit_row.environment_id = p_environment_id),
		'[]'::jsonb));
end $$;

create function public.qorpera_member_folder_object(p_environment_id uuid, p_sha256 text)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- C4 P27a (20260930013000)
	select public.qorpera_folder_authorize_object_download(p_environment_id,
		public.qorpera_member_folder_actor(p_environment_id), p_sha256)
$$;

-- 4. History ----------------------------------------------------------------------------------------------------

-- A path's versions, newest first, when the member may read the path now. p_before is the last version of the
-- previous page. A move names the other path only when the member may read it too, as the feed does. Versions are
-- ordered and paged by their time, which is seq order for one key: writers of a path hold its lock to the end of
-- their commit (core §3), so a later version of the same key is written after the earlier one committed.
create function public.qorpera_member_folder_path_history(p_environment_id uuid, p_path text, p_before uuid,
	p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid; v_last bigint;
	v_key bytea; v_before timestamptz; v_before_version uuid; v_items jsonb;
begin
	-- C4 P27a (20260930013000)
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	if p_path is null or not public.qorpera_company_path_valid(p_path) or p_limit is null or p_limit not between 1 and 100 then
		raise exception 'History request is invalid' using errcode = '22023'; end if;
	select file.profile_id, clock.last_seq into v_profile, v_last
	from public.qorpera_company_files as file join public.qorpera_folder_clocks as clock using (environment_id)
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	v_key := extensions.digest(public.qorpera_folder_key(p_path), 'sha256');
	if not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, p_path, 'read') then
		return jsonb_build_object('schema', 'qorpera.folder-path-history/v1', 'asOfSeq', v_last, 'items', '[]'::jsonb,
			'next', null);
	end if;
	if p_before is not null then
		select version.created_at, version.version into v_before, v_before_version
		from public.qorpera_folder_path_versions as version
		where version.version = p_before and version.environment_id = p_environment_id and version.key_sha256 = v_key;
		if not found then raise exception 'History request is invalid' using errcode = '22023'; end if;
	end if;
	with page as materialized (
		select version.*, commit_row.seq, commit_row.created_at as committed_at,
			public.qorpera_folder_commit_by(commit_row) as by_json
		from public.qorpera_folder_path_versions as version
		join public.qorpera_folder_commits as commit_row on commit_row.id = version.commit_id
		where version.environment_id = p_environment_id and version.key_sha256 = v_key
			and (v_before is null or (version.created_at, version.version) < (v_before, v_before_version))
		order by version.created_at desc, version.version desc
		limit p_limit
	)
	select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('version', page.version, 'seq', page.seq,
			'op', page.op, 'kind', page.kind, 'path', page.path, 'manifestSha256', page.manifest_sha256,
			'fileSha256', page.file_sha256, 'bytes', page.bytes, 'mediaType', page.media_type,
			'executable', page.executable, 'at', page.committed_at, 'by', page.by_json,
			'from', case when page.op = 'move_in' then (select other.path from public.qorpera_folder_path_versions as other
				where other.version = page.prior_version and other.environment_id = p_environment_id
					and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, other.path, 'read')) end,
			'to', case when page.op = 'move_out' then (select other.path from public.qorpera_folder_path_versions as other
				where other.commit_id = page.commit_id and other.op = 'move_in' and other.prior_version = page.prior_version
					and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, other.path, 'read')
				limit 1) end))
			order by page.created_at desc, page.version desc), '[]'::jsonb)
	into v_items from page;
	return jsonb_build_object('schema', 'qorpera.folder-path-history/v1', 'asOfSeq', v_last, 'items', v_items,
		'next', case when jsonb_array_length(v_items) = p_limit then v_items -> (p_limit - 1) -> 'version' end);
end $$;

-- The change sets, newest first, each with the paths in it the member may read: the first 20 in unit order, and
-- `more` when it has others they may read, or more versions than one call examines. A change set's versions are
-- examined in unit order until a 21st readable one, and at most 1,000 of them: a change set none of whose first 1,000
-- versions the member may read is left out, like one with no readable path at all (the feed and a path's history still
-- show its changes). Authority rows are left out. Work per call is bounded: at most p_limit change sets, and 10,000
-- versions in all; a change set the remaining budget can't examine whole is left for the next page. p_before is a
-- seq: change sets before it.
create function public.qorpera_member_folder_history(p_environment_id uuid, p_before bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid; v_last bigint;
	v_journal record; v_version record; v_items jsonb[] := '{}'; v_paths jsonb;
	v_seen integer; v_found integer; v_cap integer; v_budget integer := 10000; v_oldest bigint;
begin
	-- C4 P27a (20260930013000)
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	if p_limit is null or p_limit not between 1 and 50 or (p_before is not null and p_before < 1) then
		raise exception 'History request is invalid' using errcode = '22023'; end if;
	select file.profile_id, clock.last_seq into v_profile, v_last
	from public.qorpera_company_files as file join public.qorpera_folder_clocks as clock using (environment_id)
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	<<change_sets>>
	for v_journal in select journal.seq, commit_row as commit_row
		from public.qorpera_folder_journal as journal
		join public.qorpera_folder_commits as commit_row on commit_row.id = journal.commit_id
		where journal.environment_id = p_environment_id and journal.kind = 'change_set'
			and journal.seq <= v_last and (p_before is null or journal.seq < p_before)
		order by journal.seq desc
		limit p_limit
	loop
		v_cap := least(1000, v_budget);
		v_seen := 0; v_found := 0; v_paths := '[]';
		-- One version at a time, in unit order, so the scan stops at the 21st readable one or the cap.
		for v_version in select version.path, version.op, version.kind, version.version
			from public.qorpera_folder_path_versions as version
			where version.commit_id = (v_journal.commit_row).id
			order by version.unit_no, version.version
		loop
			v_seen := v_seen + 1;
			exit when v_seen > v_cap;
			if public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, v_version.path, 'read') then
				v_found := v_found + 1;
				exit when v_found > 20;
				v_paths := v_paths || jsonb_build_array(jsonb_build_object('path', v_version.path, 'op', v_version.op,
					'kind', v_version.kind, 'version', v_version.version));
			end if;
		end loop;
		-- The budget ran out inside this change set: it goes whole to the next page.
		exit change_sets when v_seen > v_cap and v_cap < 1000 and v_found <= 20;
		v_budget := v_budget - least(v_seen, v_cap);
		v_oldest := v_journal.seq;
		if v_found > 0 then
			v_items := v_items || jsonb_build_object('seq', v_journal.seq, 'at', (v_journal.commit_row).created_at,
				'by', public.qorpera_folder_commit_by(v_journal.commit_row), 'paths', v_paths,
				'more', v_found > 20 or v_seen > v_cap);
		end if;
	end loop;
	-- Whatever stopped the page, an older change set is the next page's.
	return jsonb_build_object('schema', 'qorpera.folder-history/v1', 'asOfSeq', v_last, 'items', to_jsonb(v_items),
		'next', case when v_oldest is not null and exists (select 1 from public.qorpera_folder_journal as journal
			where journal.environment_id = p_environment_id and journal.kind = 'change_set' and journal.seq < v_oldest)
			then v_oldest end);
end $$;

-- 5. Privileges ---------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_member_folder_read(uuid, text) from public, anon;
revoke all on function public.qorpera_member_folder_list(uuid, text, text, integer) from public, anon;
revoke all on function public.qorpera_member_folder_changes(uuid, bigint, integer, jsonb) from public, anon;
revoke all on function public.qorpera_member_folder_object(uuid, text) from public, anon;
revoke all on function public.qorpera_member_folder_path_history(uuid, text, uuid, integer) from public, anon;
revoke all on function public.qorpera_member_folder_history(uuid, bigint, integer) from public, anon;
grant execute on function public.qorpera_member_folder_read(uuid, text) to authenticated;
grant execute on function public.qorpera_member_folder_list(uuid, text, text, integer) to authenticated;
grant execute on function public.qorpera_member_folder_changes(uuid, bigint, integer, jsonb) to authenticated;
grant execute on function public.qorpera_member_folder_object(uuid, text) to authenticated;
grant execute on function public.qorpera_member_folder_path_history(uuid, text, uuid, integer) to authenticated;
grant execute on function public.qorpera_member_folder_history(uuid, bigint, integer) to authenticated;
