-- Company folder core, C1f: the feed and the clock (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §6 and §11,
-- slice C1f; built by the machine-side session F3 and reviewed by the storage core).
--
-- Inert for today's companies: everything here reads only folder-v2 companies' tables, which only an
-- operator can create until the reset (C5). It never changes qorpera_folder_commit. The journal and the clock
-- already exist (C1a); this slice lets a reader follow them:
-- * qorpera_folder_feed(env, actor, after_seq, limit, cursor): the journal after a position, in seq order,
--   with the paths each change set touched, filtered by the actor's read authority, and asOfSeq;
-- * the clock for polling: service_role may read qorpera_folder_clocks, so a node's folder service learns
--   that a company's folder changed and then asks the feed what.
--
-- Positions. A reader is at (after_seq, cursor): every seq up to after_seq is done, and cursor, when set,
-- names the last change examined inside seq after_seq + 1, as (unitNo, version). A change set can touch
-- 100,000 paths (a subtree move writes move_out and move_in per path), so a page may stop inside one; the
-- change set is whole in the reader's hands once next.afterSeq has reached its seq. Changes within a change
-- set are ordered by (unit_no, version): a total order over one commit's path versions, served by an index,
-- so a page never sorts the whole commit. The order within a unit has no meaning: a unit is one atomic path
-- set.
--
-- Consistency. The function is STABLE, so the statements it runs itself read the snapshot of the calling
-- query: asOfSeq and the journal rows come from one snapshot. A commit takes the clock row last and holds it
-- to its end (core §3 step 11), so a snapshot that sees last_seq = N sees every journal row up to N, and seqs
-- have no gaps (a change set that saves nothing takes no seq). A reader that continues from `next` never
-- skips a seq.
--
-- Authority. The actor is resolved exactly as qorpera_folder_read and qorpera_folder_list resolve it
-- (qorpera_folder_read_actor, C1b-1): the platform sees every change; a member or a run sees only paths it may
-- read now (qorpera_folder_actor_allowed), and a move's priorVersion only when it may read the source too. A
-- change set none of whose paths the actor may read is left out of its page, while the position still
-- advances. View actors join read, list and the feed with C1b-3. An authority row carries no paths.
--
-- Work per call is bounded by p_limit: at most p_limit changes and authority rows are examined, whether or
-- not the actor may read them, so a member's page may hold fewer events than p_limit, or none, and still
-- moves forward. The position a page returns can name a change the actor may not read (its unit number and
-- version, never its path); the feed is for service_role callers only. The journal is kept for good, so
-- `resync` is returned only for a position past the clock or a cursor that names no change of seq
-- after_seq + 1.

-- 1. Order within a change set -------------------------------------------------------------------------

-- Replaces the (commit_id) index: its prefix serves every lookup by commit, and the feed pages by the rest.
drop index public.qorpera_folder_path_versions_commit;
create index qorpera_folder_path_versions_commit on public.qorpera_folder_path_versions(commit_id, unit_no, version);

-- 2. The feed ------------------------------------------------------------------------------------------

create function public.qorpera_folder_feed(p_environment_id uuid, p_actor jsonb, p_after_seq bigint, p_limit integer,
	p_cursor jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_kind text := p_actor ->> 'kind'; v_auth jsonb; v_profile uuid; v_last bigint;
	v_cursor_unit integer; v_cursor_version uuid; v_from_unit integer; v_from_version uuid;
	v_journal record; v_changes jsonb; v_events jsonb[] := '{}';
	v_scanned integer := 0; v_fetched integer; v_last_unit integer; v_last_version uuid;
	v_next jsonb; v_done_seq bigint := p_after_seq;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	-- Null for the platform; a member as given; a run resolved with plain reads (a paused company refuses it).
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if p_after_seq is null or p_after_seq < 0 or p_limit is null or p_limit not between 1 and 1000 then
		raise exception 'Feed position is invalid' using errcode = '22023'; end if;
	if p_cursor is not null and p_cursor <> 'null'::jsonb then
		if jsonb_typeof(p_cursor) is distinct from 'object' or p_cursor - array['unitNo','version'] <> '{}'::jsonb
			or coalesce(p_cursor ->> 'unitNo', '') !~ '^[1-9][0-9]{0,8}$'
			or coalesce(p_cursor ->> 'version', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'Feed position is invalid' using errcode = '22023'; end if;
		v_cursor_unit := (p_cursor ->> 'unitNo')::integer;
		v_cursor_version := (p_cursor ->> 'version')::uuid;
	end if;

	select f.profile_id, k.last_seq into v_profile, v_last
	from public.qorpera_company_files f join public.qorpera_folder_clocks k on k.environment_id = f.environment_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if v_kind = 'member' and not exists (select 1 from public.qorpera_profile_members m
		where m.profile_id = v_profile and m.user_id = (v_auth ->> 'userId')::uuid) then
		raise exception 'Company membership is required' using errcode = '42501'; end if;

	-- A position past the clock, or a cursor that names no change of the next seq, cannot be continued.
	if p_after_seq > v_last or (v_cursor_unit is not null and (p_after_seq = v_last or not exists (
		select 1 from public.qorpera_folder_journal j join public.qorpera_folder_path_versions v on v.commit_id = j.commit_id
		where j.environment_id = p_environment_id and j.seq = p_after_seq + 1 and j.kind = 'change_set'
			and v.unit_no = v_cursor_unit and v.version = v_cursor_version))) then
		return jsonb_build_object('schema','qorpera.folder-feed/v1','asOfSeq',v_last,'resync',true,'events','[]'::jsonb,
			'next',null,'more',false);
	end if;

	for v_journal in select j.seq, j.kind, j.commit_id from public.qorpera_folder_journal j
		where j.environment_id = p_environment_id and j.seq > p_after_seq and j.seq <= v_last
		order by j.seq
	loop
		exit when v_scanned >= p_limit;
		if v_journal.kind = 'authority' then
			v_scanned := v_scanned + 1;
			v_events := v_events || jsonb_build_object('seq',v_journal.seq,'kind','authority');
			v_done_seq := v_journal.seq;
			continue;
		end if;
		-- Resume after the cursor inside the first seq; from the start (unit numbers begin at 1) elsewhere.
		if v_journal.seq = p_after_seq + 1 and v_cursor_unit is not null then
			v_from_unit := v_cursor_unit; v_from_version := v_cursor_version;
		else
			v_from_unit := 0; v_from_version := '00000000-0000-0000-0000-000000000000';
		end if;
		-- One statement per change set: this page's rows of it by index, the readable ones as one array, and the
		-- last position examined. A current version's updatedAt is its entry's, as read and list report it.
		with page as materialized (
			select v.unit_no, v.version, v.path, v.key_sha256, v.op, v.kind, v.prior_version, v.manifest_sha256,
				v.file_sha256, v.bytes, v.media_type, v.executable
			from public.qorpera_folder_path_versions v
			where v.commit_id = v_journal.commit_id and (v.unit_no, v.version) > (v_from_unit, v_from_version)
			order by v.unit_no, v.version
			limit p_limit - v_scanned
		), shown as materialized (
			select p.* from page p
			where v_kind = 'platform' or public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth, p.path, 'read')
		)
		select (select count(*) from page)::integer,
			(select p.unit_no from page p order by p.unit_no desc, p.version desc limit 1),
			(select p.version from page p order by p.unit_no desc, p.version desc limit 1),
			(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('unitNo', s.unit_no, 'op', s.op,
					'kind', s.kind, 'path', s.path, 'version', s.version,
					'priorVersion', case when s.op <> 'move_in' or v_kind = 'platform'
						or public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth,
							(select w.path from public.qorpera_folder_path_versions w where w.version = s.prior_version), 'read')
						then s.prior_version end,
					'manifestSha256', s.manifest_sha256, 'fileSha256', s.file_sha256, 'bytes', s.bytes,
					'mediaType', s.media_type, 'executable', s.executable, 'updatedAt', e.updated_at))
					order by s.unit_no, s.version), '[]'::jsonb)
				from shown s left join public.qorpera_folder_entries e on e.environment_id = p_environment_id
					and e.key_sha256 = s.key_sha256 and e.version = s.version)
		into v_fetched, v_last_unit, v_last_version, v_changes;
		v_scanned := v_scanned + v_fetched;
		if jsonb_array_length(v_changes) > 0 or (v_kind = 'platform' and v_fetched > 0) then
			v_events := v_events || jsonb_build_object('seq',v_journal.seq,'kind','change_set','commitId',v_journal.commit_id,
				'changes',v_changes);
		end if;
		-- The page filled up inside this change set: stop here if any of its changes are left.
		if v_scanned >= p_limit and exists (select 1 from public.qorpera_folder_path_versions v
			where v.commit_id = v_journal.commit_id and (v.unit_no, v.version) > (v_last_unit, v_last_version)) then
			v_next := jsonb_build_object('afterSeq',v_journal.seq - 1,
				'cursor',jsonb_build_object('unitNo',v_last_unit,'version',v_last_version));
			exit;
		end if;
		v_done_seq := v_journal.seq;
	end loop;

	-- The journal ran out below the limit: everything up to asOfSeq is done.
	if v_next is null and v_scanned < p_limit then v_done_seq := v_last; end if;
	if v_next is null then v_next := jsonb_build_object('afterSeq', v_done_seq, 'cursor', null); end if;
	return jsonb_build_object('schema','qorpera.folder-feed/v1','asOfSeq',v_last,'resync',false,
		'events',to_jsonb(v_events),'next',v_next,'more',(v_next ->> 'afterSeq')::bigint < v_last);
end $$;

-- 3. The clock, for polling ------------------------------------------------------------------------------

-- The node's folder service learns that something changed by reading last_seq for the companies it serves
-- (one indexed read per node and interval), then asks the feed what. service_role only; RLS stays on with no
-- policy, which service_role bypasses. The clock is not added to the Realtime publication: Realtime sends
-- every subscriber whose role may not select a published table an "unauthorized" event for each change
-- (realtime.apply_rls), which would show any client the timing of every folder-v2 commit. Members' and
-- clients' own hints arrive with C4.
grant select on public.qorpera_folder_clocks to service_role;

-- 4. Grants ---------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb) to service_role;
