-- The 7-day prune of replaced tree versions (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10 GC, M3b). Versions are
-- kept for good, with this exception next to git's objects. A version of a path under a tree root is pruned when:
-- (1) its op is a write with a prior; (2) a later write of the same path took it as its prior; (3) that later write is
-- at least 7 days old; (4) no version and no conflict copy at a path outside every tree root, in any folder of the
-- company, holds the same manifest. So a path's current version, the start of each life, the last version before a
-- delete or a move, both rows of a move pair and the notebook keep their rows.
--
-- 1. qorpera_folder_object_release: the bytes step of P18's phase 5 (C1D §9.4), now shared. The erasure step calls it
--    at the same place; the prune calls it for the hashes of the versions it deletes. It first takes the upload intents
--    that root the hashes FOR KEY SHARE, which the intent sweeper's FOR UPDATE SKIP LOCKED passes over (C1D §9.5).
-- 2. qorpera_memory_tree_prune: one batch, driven by the later write (condition 3) through a partial index, in order
--    of its age from a cursor, so each later write is read once. A version that a holder keeps (condition 4) waits in
--    qorpera_memory_tree_prune_held and is checked again on later runs: once the copy is erased by its path, the next
--    prune takes it. A company being deleted is passed over; its own GC takes everything.
-- 3. pg_cron runs a batch every minute. The prune commits nothing and writes no folder history.
--
-- The erasure step's patched body carries the marker 20260930442000 (M3b) for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_memory_tree_prune(integer)') is not null then
		raise exception 'Memory tree prune (20260930442000) is already applied'; end if;
end $$;

create function pg_temp.m3b_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Memory tree prune anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The rows ----------------------------------------------------------------------------------------------------------

-- One row: the later write the prune read last, by (created_at, version).
create table public.qorpera_memory_tree_prune_cursor (
	id boolean primary key default true check (id),
	created_at timestamptz not null default '-infinity',
	version uuid not null default '00000000-0000-0000-0000-000000000000',
	updated_at timestamptz not null default clock_timestamp()
);
insert into public.qorpera_memory_tree_prune_cursor default values;

-- Versions the four conditions would prune but for a holder outside the trees. No foreign keys: a held version that P18
-- erases, or whose company is deleted, leaves its row to the next check.
create table public.qorpera_memory_tree_prune_held (
	version uuid primary key,
	environment_id uuid not null,
	profile_id uuid not null,
	held_at timestamptz not null default clock_timestamp(),
	checked_at timestamptz not null default clock_timestamp()
);
create index qorpera_memory_tree_prune_held_checked on public.qorpera_memory_tree_prune_held(checked_at, version);

alter table public.qorpera_memory_tree_prune_cursor enable row level security;
alter table public.qorpera_memory_tree_prune_held enable row level security;
revoke all on public.qorpera_memory_tree_prune_cursor, public.qorpera_memory_tree_prune_held
	from public, anon, authenticated, service_role;
comment on table public.qorpera_memory_tree_prune_cursor is
	'M3b: the later write of a tree path the 7-day prune read last (RUNTIME-AGENT-MEMORY-TREE.md §10 GC).';
comment on table public.qorpera_memory_tree_prune_held is
	'M3b: replaced tree versions a holder outside every tree root keeps; the prune checks them again on later runs.';

-- Condition 3's side: later writes under a tree root, by age. The predicate is the prune's, word for word.
create index qorpera_memory_tree_prune_due on public.qorpera_folder_path_versions(created_at, version)
	where op = 'write' and prior_version is not null
		and public.qorpera_memory_tree_root_key(public.qorpera_folder_key(path)) is not null;

-- 2. The bytes step ----------------------------------------------------------------------------------------------------

-- Side rows for the hashes nothing roots now, where a catalog row exists (C1D §9.4). The caller has checked that folder
-- GC serves the company (qorpera_folder_gc_company) and calls this at read committed, in a statement after its deletes.
create function public.qorpera_folder_object_release(p_profile_id uuid, p_hashes text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_rows integer;
begin
	-- The upload intents that root these bytes, first (C1D §9.5): the sweeper skips one held here, and one the sweeper
	-- holds is waited for and gone after. So the sweeper's check or this one reads the other's end, never neither.
	perform 1 from public.qorpera_folder_upload_intents i
	where i.id in (select o.intent_id from public.qorpera_folder_upload_intent_objects o
		where o.profile_id = p_profile_id and o.sha256 = any (p_hashes))
	order by i.id for key share;
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	select p_profile_id, h, clock_timestamp() from unnest(p_hashes) h
	where exists (select 1 from public.qorpera_profile_objects o where o.profile_id = p_profile_id and o.sha256 = h)
		and not public.qorpera_folder_object_rooted(p_profile_id, h)
	order by h collate "C"
	on conflict (profile_id, sha256) do update
	set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
	get diagnostics v_rows = row_count;
	return v_rows;
end $$;
comment on function public.qorpera_folder_object_release(uuid, text[]) is
	'M3b: the bytes step of P18''s phase 5, shared with the memory tree prune (RUNTIME-COMPANY-FOLDER-ERASURE.md §4 step 5).';

-- The erasure step's phase 5 calls it.
select pg_temp.m3b_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	E'\t\t\t\tinsert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)\n'
	'\t\t\t\tselect v_erasure.profile_id, h, clock_timestamp() from unnest(v_hashes) h\n'
	'\t\t\t\twhere exists (select 1 from public.qorpera_profile_objects o where o.profile_id = v_erasure.profile_id and o.sha256 = h)\n'
	'\t\t\t\t\tand not public.qorpera_folder_object_rooted(v_erasure.profile_id, h)\n'
	'\t\t\t\torder by h collate "C"\n'
	'\t\t\t\ton conflict (profile_id, sha256) do update\n'
	'\t\t\t\tset unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);\n',
	E'\t\t\t\t-- 20260930442000 (M3b): the bytes step, shared with the memory tree prune.\n'
	'\t\t\t\tperform public.qorpera_folder_object_release(v_erasure.profile_id, v_hashes);\n');

-- 3. The prune ---------------------------------------------------------------------------------------------------------

-- Condition 4: a version or a conflict copy at a path outside every tree root, in any folder of the company, holds the
-- manifest. These are the two holders P18's copy warning searches (§2.3 there), through the same manifest indexes. The
-- notebook lies outside the trees.
create function public.qorpera_memory_tree_version_held(p_profile_id uuid, p_manifest_sha256 text)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_manifest_sha256 is not null and exists (
		select 1 from public.qorpera_company_files f
		cross join lateral (
			select public.qorpera_folder_key(ov.path) as key from public.qorpera_folder_path_versions ov
			where ov.environment_id = f.environment_id and ov.manifest_sha256 = p_manifest_sha256
			union all
			select oc.key_text from public.qorpera_folder_conflict_copies oc
			where oc.environment_id = f.environment_id and oc.manifest_sha256 = p_manifest_sha256) o
		where f.profile_id = p_profile_id and f.core = 'folder-v2' and public.qorpera_memory_tree_root_key(o.key) is null)
$$;

-- One batch: the held versions checked longest ago, then the later writes after the cursor. A company is taken once per
-- batch, its row KEY SHARE (a purge holds it FOR UPDATE) and only while folder GC serves it; a company being deleted is
-- passed over, and one whose row is busy ends the batch, with the cursor before its write.
create function public.qorpera_memory_tree_prune(p_versions integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_before constant timestamptz := clock_timestamp() - interval '7 days';
	v_cursor public.qorpera_memory_tree_prune_cursor%rowtype;
	v_row record; v_profile uuid; v_hashes text[]; v_state text;
	v_open uuid[] := '{}'; v_shut uuid[] := '{}'; v_profiles uuid[] := '{}'; v_manifests text[] := '{}';
	v_last_at timestamptz; v_last uuid; v_more boolean := false;
	v_checked integer := 0; v_read integer := 0; v_pruned integer := 0; v_held integer := 0; v_released integer := 0;
begin
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'The memory tree prune runs at read committed' using errcode = '25000'; end if;
	select * into v_cursor from public.qorpera_memory_tree_prune_cursor where id for update skip locked;
	if not found then
		return jsonb_build_object('schema', 'qorpera.memory-tree-prune/v1', 'busy', true); end if;

	-- The held versions: gone (erased, or the company deleted), the row goes; no holder now, pruned; else checked again.
	for v_row in select h.version, h.profile_id, v.manifest_sha256, v.version is not null as present
		from public.qorpera_memory_tree_prune_held h
		left join public.qorpera_folder_path_versions v on v.version = h.version
		order by h.checked_at, h.version limit p_versions
	loop
		v_checked := v_checked + 1;
		v_state := case when v_row.profile_id = any (v_open) then 'open' when v_row.profile_id = any (v_shut) then 'shut' end;
		if v_state is null then
			perform 1 from public.qorpera_profiles where id = v_row.profile_id for key share skip locked;
			v_state := case when found and public.qorpera_folder_gc_company(v_row.profile_id) then 'open'
				when found or not exists (select 1 from public.qorpera_profiles where id = v_row.profile_id) then 'shut' end;
			if v_state = 'open' then v_open := v_open || v_row.profile_id;
			elsif v_state = 'shut' then v_shut := v_shut || v_row.profile_id; end if;
		end if;
		if v_state is null then continue;
		elsif not v_row.present or v_state = 'shut' then
			delete from public.qorpera_memory_tree_prune_held where version = v_row.version;
		elsif public.qorpera_memory_tree_version_held(v_row.profile_id, v_row.manifest_sha256) then
			update public.qorpera_memory_tree_prune_held set checked_at = clock_timestamp() where version = v_row.version;
		else
			delete from public.qorpera_folder_path_versions where version = v_row.version;
			delete from public.qorpera_memory_tree_prune_held where version = v_row.version;
			v_profiles := v_profiles || v_row.profile_id; v_manifests := v_manifests || v_row.manifest_sha256;
			v_pruned := v_pruned + 1;
		end if;
	end loop;

	-- The later writes at least 7 days old, by age from the cursor (conditions 2 and 3); the version each took as its prior,
	-- where that is a write with a prior of the same path (condition 1).
	for v_row in select n.created_at, n.version as later, v.version, v.environment_id, f.profile_id, v.manifest_sha256
		from public.qorpera_folder_path_versions n
		left join public.qorpera_folder_path_versions v on v.version = n.prior_version and v.op = 'write'
			and v.prior_version is not null and v.environment_id = n.environment_id and v.key_sha256 = n.key_sha256
		left join public.qorpera_company_files f on f.environment_id = n.environment_id
		where n.op = 'write' and n.prior_version is not null
			and public.qorpera_memory_tree_root_key(public.qorpera_folder_key(n.path)) is not null
			and n.created_at <= v_before and (n.created_at, n.version) > (v_cursor.created_at, v_cursor.version)
		order by n.created_at, n.version limit p_versions
	loop
		if v_row.version is not null and v_row.profile_id is not null then
			v_state := case when v_row.profile_id = any (v_open) then 'open' when v_row.profile_id = any (v_shut) then 'shut' end;
			if v_state is null then
				perform 1 from public.qorpera_profiles where id = v_row.profile_id for key share skip locked;
				v_state := case when found and public.qorpera_folder_gc_company(v_row.profile_id) then 'open'
					when found or not exists (select 1 from public.qorpera_profiles where id = v_row.profile_id) then 'shut' end;
				if v_state = 'open' then v_open := v_open || v_row.profile_id;
				elsif v_state = 'shut' then v_shut := v_shut || v_row.profile_id; end if;
			end if;
			if v_state is null then v_more := true; exit; end if;
			if v_state = 'open' then
				if public.qorpera_memory_tree_version_held(v_row.profile_id, v_row.manifest_sha256) then
					insert into public.qorpera_memory_tree_prune_held(version, environment_id, profile_id)
					values (v_row.version, v_row.environment_id, v_row.profile_id) on conflict (version) do nothing;
					v_held := v_held + 1;
				else
					delete from public.qorpera_folder_path_versions where version = v_row.version;
					v_profiles := v_profiles || v_row.profile_id; v_manifests := v_manifests || v_row.manifest_sha256;
					v_pruned := v_pruned + 1;
				end if;
			end if;
		end if;
		v_read := v_read + 1; v_last_at := v_row.created_at; v_last := v_row.later;
	end loop;
	v_more := v_more or v_read = p_versions;
	if v_last is not null then
		update public.qorpera_memory_tree_prune_cursor set created_at = v_last_at, version = v_last, updated_at = clock_timestamp()
		where id;
	end if;

	-- The upload intents that root any of those bytes, in one statement before any release: the sweeper holds intents of
	-- many companies at once, and each release takes GC rows, so no release waits on an intent while holding them.
	perform 1 from public.qorpera_folder_upload_intents i
	where i.id in (select o.intent_id from unnest(v_profiles, v_manifests) x(p, m)
		join public.qorpera_folder_upload_intent_objects o on o.profile_id = x.p
		where x.m is not null and (o.sha256 = x.m or o.sha256 in (select ch.chunk_sha256 from public.qorpera_folder_file_chunks ch
			where ch.profile_id = x.p and ch.manifest_sha256 = x.m)))
	order by i.id for key share;
	-- The bytes, in a statement after the deletes: each pruned manifest and its chunks, where nothing roots them now.
	for v_profile in select distinct p from unnest(v_profiles) p loop
		select coalesce(array_agg(h.sha256 order by h.sha256 collate "C"), '{}') into v_hashes from (
			select x.m as sha256 from unnest(v_profiles, v_manifests) x(p, m) where x.p = v_profile and x.m is not null
			union
			select ch.chunk_sha256 from unnest(v_profiles, v_manifests) x(p, m)
			join public.qorpera_folder_file_chunks ch on ch.profile_id = v_profile and ch.manifest_sha256 = x.m
			where x.p = v_profile) h;
		v_released := v_released + public.qorpera_folder_object_release(v_profile, v_hashes);
	end loop;

	return jsonb_build_object('schema', 'qorpera.memory-tree-prune/v1', 'checked', v_checked, 'read', v_read,
		'pruned', v_pruned, 'held', v_held, 'released', v_released, 'more', v_more);
end $$;

-- 4. The schedule and privileges ---------------------------------------------------------------------------------------

-- A batch every minute (pg_cron), and a daily cleanup of its run log. Where pg_cron is absent or the role may not use
-- it, nothing is scheduled and the migration still applies; run select public.qorpera_schedule_memory_tree_prune() as
-- the role that should own the jobs after enabling it (as qorpera_schedule_folder_erasure, 20260928469190).
create function public.qorpera_schedule_memory_tree_prune()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The memory tree prune was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.memory-tree-prune-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-memory-tree-prune', '* * * * *', 'select public.qorpera_memory_tree_prune()');
		v_clean := cron.schedule('qorpera-memory-tree-prune-log', '23 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-memory-tree-prune')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The memory tree prune was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.memory-tree-prune-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.memory-tree-prune-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

revoke all on function public.qorpera_folder_object_release(uuid, text[]),
	public.qorpera_memory_tree_version_held(uuid, text),
	public.qorpera_memory_tree_prune(integer),
	public.qorpera_schedule_memory_tree_prune()
	from public, anon, authenticated, service_role;
comment on function public.qorpera_memory_tree_prune(integer) is
	'M3b: one batch of the 7-day prune of replaced tree versions (RUNTIME-AGENT-MEMORY-TREE.md §10 GC); pg_cron runs it.';

select public.qorpera_schedule_memory_tree_prune();

drop function pg_temp.m3b_replace(regprocedure, text, text);
