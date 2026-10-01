-- Company folder core, C1d-2a: garbage collection of folder-v2 objects, the SQL (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-C1D.md §9; core §8, G1–G4). The gateway lane and the worker's phase are C1d-2b.
--
-- * One side table holds the GC state: when an object lost its roots (G4), and the deleting mark with its lease (G2).
-- * One root check, per company across every folder-v2 environment, which C2 extends.
-- * The intent sweep records when objects lost their roots; the claim marks under FOR UPDATE SKIP LOCKED with no
--   company fence; the unlink's begin, finish and abandon, and the quarantine state, serve the gateway lane.
-- * Every place that takes a new reference refuses a marked object (G1), reading the mark in a statement after its lock.
-- * Version-1 proofs of folder-v2 companies get chunk rows, so the chunk side of the root check is complete.
--
-- Only folder-v2 companies whose every environment is folder-v2 and that are not being deleted are swept or claimed.
-- Every new function waits at most 2 s for any one lock (as 20260929780000), and the patched ones keep that budget.
-- Inert: no folder-v2 company exists before C1c-3, and nothing calls the GC functions until C1d-2b's worker phase.

set local lock_timeout = '3s';

-- 1. The GC state ------------------------------------------------------------------------------------------------------

-- A row per folder-v2 object that lost its roots: since when (G4), and, while GC holds it, the deleting mark (a lease;
-- an expired lease is no mark). It cascades from the catalog row and from the company (its purge, test 715).
create table public.qorpera_folder_object_gc (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	sha256 text not null,
	unreferenced_since timestamptz not null,
	lease_id uuid,
	lease_expires_at timestamptz,
	primary key (profile_id, sha256),
	foreign key (profile_id, sha256) references public.qorpera_profile_objects(profile_id, sha256) on delete cascade,
	check ((lease_id is null) = (lease_expires_at is null))
);
create index qorpera_folder_object_gc_due on public.qorpera_folder_object_gc(unreferenced_since);
alter table public.qorpera_folder_object_gc enable row level security;
revoke all on public.qorpera_folder_object_gc from anon, authenticated;

-- The sweep takes expired intents oldest first, across companies.
create index qorpera_folder_upload_intents_expires on public.qorpera_folder_upload_intents(expires_at);

-- 2. Helpers -------------------------------------------------------------------------------------------------------------

-- Whether folder GC serves a company: every environment of it is folder-v2 (a snapshot-v1 one's roots are invisible
-- here), and it is not being deleted (the deleted-company GC collects its objects).
create function public.qorpera_folder_gc_company(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_files where profile_id = p_profile_id and core = 'folder-v2')
		and not exists (select 1 from public.qorpera_company_files where profile_id = p_profile_id and core <> 'folder-v2')
		and not exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id)
$$;

-- Whether GC holds an object for deletion now: a live lease.
create function public.qorpera_folder_object_marked(p_profile_id uuid, p_sha256 text)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_folder_object_gc
		where profile_id = p_profile_id and sha256 = p_sha256 and lease_expires_at > clock_timestamp())
$$;

-- Whether anything still names an object of a company (C1D §9.3), leaving out one intent (the sweep's own). Rooted:
-- * the manifest of a live entry or of any path version, in any folder-v2 environment of the company;
-- * an object of an upload intent still in the table that expired less than the grace window ago (24 hours), so an
--   intent the sweep has not reached yet protects its objects for as long as its sweep would;
-- * a chunk of a rooted manifest (qorpera_folder_file_chunks, complete for every proof version, §6 below).
-- C2 adds its roots here (proposals, review cards, conflict copies, holds). Plain reads, through the manifest indexes.
create function public.qorpera_folder_object_rooted(p_profile_id uuid, p_sha256 text, p_except_intent uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
			select 1 from (select p_sha256 as manifest
				union
				select c.manifest_sha256 from public.qorpera_folder_file_chunks c
				where c.profile_id = p_profile_id and c.chunk_sha256 = p_sha256) m
			join public.qorpera_company_files f on f.profile_id = p_profile_id and f.core = 'folder-v2'
			where exists (select 1 from public.qorpera_folder_entries e
					where e.environment_id = f.environment_id and e.kind = 'file' and e.manifest_sha256 = m.manifest)
				or exists (select 1 from public.qorpera_folder_path_versions v
					where v.environment_id = f.environment_id and v.manifest_sha256 = m.manifest))
		or exists (select 1 from public.qorpera_folder_upload_intent_objects o
			join public.qorpera_folder_upload_intents i on i.id = o.intent_id
			where o.profile_id = p_profile_id and o.sha256 = p_sha256
				and i.expires_at > clock_timestamp() - interval '24 hours'
				and i.id is distinct from p_except_intent)
$$;

-- 3. Step 1: sweep expired intents (C1D §9.5) ------------------------------------------------------------------------

-- Removes intents expired more than an hour ago, oldest first, skipping any another transaction holds. For each, its
-- objects that have a catalog row and that nothing else roots get a GC row, or theirs moves forward: unreferenced
-- since the intent's expiry (G4, `greatest`). Each intent in its own subtransaction, so a lock it cannot get within the
-- 2 s budget skips that intent only. Returns how many it removed.
create function public.qorpera_folder_sweep_upload_intents(p_limit integer)
returns integer language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_id uuid; v_intent public.qorpera_folder_upload_intents%rowtype; v_swept integer := 0;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 100 then raise exception 'Sweep limit is invalid' using errcode = '22023'; end if;
	for v_id in select id from public.qorpera_folder_upload_intents
		where expires_at < clock_timestamp() - interval '1 hour' order by expires_at, id limit p_limit
	loop
		begin
			select * into v_intent from public.qorpera_folder_upload_intents
			where id = v_id and expires_at < clock_timestamp() - interval '1 hour' for update skip locked;
			if not found then continue; end if;
			if public.qorpera_folder_gc_company(v_intent.profile_id) then
				insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
				select o.profile_id, o.sha256, v_intent.expires_at from public.qorpera_folder_upload_intent_objects o
				where o.intent_id = v_intent.id
					and exists (select 1 from public.qorpera_profile_objects c where c.profile_id = o.profile_id and c.sha256 = o.sha256)
					and not public.qorpera_folder_object_rooted(o.profile_id, o.sha256, v_intent.id)
				order by o.sha256 collate "C"
				on conflict (profile_id, sha256) do update
				set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
			end if;
			delete from public.qorpera_folder_upload_intents where id = v_intent.id;
			v_swept := v_swept + 1;
		exception when lock_not_available or deadlock_detected then
			null;
		end;
	end loop;
	return v_swept;
end $$;

-- 4. Step 2: claim and mark (C1D §9.6, G2) ---------------------------------------------------------------------------

-- Marks up to p_limit objects past grace (24 hours unreferenced), unmarked or with an expired mark, NAS-backed (a
-- Storage-backed row is kept: deleting its Storage file would delete the catalog row through the mirror trigger). Each
-- object's catalog row and GC row are locked FOR UPDATE SKIP LOCKED in one hash order, so a busy object waits for a
-- later run, two claims never take one object, and the claim never waits on the sweep. In a new statement after the
-- lock it re-checks the roots: a rooted object loses its GC row (it is in use again). The rest get this lease for 10
-- minutes, committed before any unlink. No profile row, fence, company_files, job or run is locked.
create function public.qorpera_folder_claim_object_gc(p_limit integer, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_row record; v_marked jsonb := '[]'::jsonb; v_expires timestamptz;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 100 or p_lease is null then
		raise exception 'GC claim is invalid' using errcode = '22023'; end if;
	for v_row in select o.profile_id, o.sha256, o.bytes, o.backend from public.qorpera_folder_object_gc g
		join public.qorpera_profile_objects o on o.profile_id = g.profile_id and o.sha256 = g.sha256
		where g.unreferenced_since <= clock_timestamp() - interval '24 hours'
			and (g.lease_id is null or g.lease_expires_at <= clock_timestamp())
			and o.backend = 'nas-object-gateway'
			and public.qorpera_folder_gc_company(g.profile_id)
		order by g.profile_id, g.sha256 collate "C"
		limit p_limit
		for update of o, g skip locked
	loop
		if public.qorpera_folder_object_rooted(v_row.profile_id, v_row.sha256) then
			delete from public.qorpera_folder_object_gc where profile_id = v_row.profile_id and sha256 = v_row.sha256;
			continue;
		end if;
		update public.qorpera_folder_object_gc set lease_id = p_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
		where profile_id = v_row.profile_id and sha256 = v_row.sha256
			and unreferenced_since <= clock_timestamp() - interval '24 hours'
			and (lease_id is null or lease_expires_at <= clock_timestamp())
		returning lease_expires_at into v_expires;
		if found then
			v_marked := v_marked || jsonb_build_array(jsonb_build_object('profileId', v_row.profile_id, 'sha256', v_row.sha256,
				'bytes', v_row.bytes, 'backend', v_row.backend, 'leaseId', p_lease, 'leaseExpiresAt', v_expires));
		end if;
	end loop;
	return jsonb_build_object('schema', 'qorpera.folder-object-gc-claim/v1', 'objects', v_marked);
end $$;

-- 5. Step 3: the unlink's SQL (C1D §9.8) -----------------------------------------------------------------------------

-- Begin: the mark is live and its lease is this one; its expiry moves to at least 10 minutes from now (a repeat begin
-- is the same). Returns the object's size and backend. 55000 when the lease is not current.
create function public.qorpera_folder_gc_unlink_begin(p_profile_id uuid, p_sha256 text, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_gc public.qorpera_folder_object_gc%rowtype; v_object public.qorpera_profile_objects%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_gc from public.qorpera_folder_object_gc where profile_id = p_profile_id and sha256 = p_sha256 for update;
	if not found or v_gc.lease_id is distinct from p_lease or v_gc.lease_expires_at <= clock_timestamp() then
		raise exception 'GC lease is not current' using errcode = '55000'; end if;
	update public.qorpera_folder_object_gc
	set lease_expires_at = greatest(lease_expires_at, clock_timestamp() + interval '10 minutes')
	where profile_id = p_profile_id and sha256 = p_sha256
	returning * into v_gc;
	select * into v_object from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256;
	return jsonb_build_object('schema', 'qorpera.folder-object-gc-unlink/v1', 'bytes', v_object.bytes,
		'backend', v_object.backend, 'leaseExpiresAt', v_gc.lease_expires_at);
end $$;

-- Finish: under the catalog row and the GC row FOR UPDATE, with the clock read after the wait, the lease must be this
-- one and live and the object still past grace; then, in a new statement, the roots are checked again.
-- * 'removed': the catalog row is deleted (proofs, the chunk index and the GC row cascade; the usage row is the last
--   lock, through the catalog trigger), or it was already gone.
-- * 'restore': the object is rooted (its GC row goes: it is in use again), grace moved (the mark is cleared), or a
--   reference from outside the folder core holds the row (23503; its GC row goes, so it is never claimed again, and the
--   broken invariant of C1D §9.3 is reported).
-- * 'stale': the lease is not current; the gateway asks the quarantine state.
create function public.qorpera_folder_gc_unlink_finish(p_profile_id uuid, p_sha256 text, p_lease uuid)
returns text language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_gc public.qorpera_folder_object_gc%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256 for update;
	if not found then return 'removed'; end if;
	select * into v_gc from public.qorpera_folder_object_gc where profile_id = p_profile_id and sha256 = p_sha256 for update;
	if not found or v_gc.lease_id is distinct from p_lease or v_gc.lease_expires_at <= clock_timestamp() then
		return 'stale'; end if;
	if public.qorpera_folder_object_rooted(p_profile_id, p_sha256) then
		delete from public.qorpera_folder_object_gc where profile_id = p_profile_id and sha256 = p_sha256;
		return 'restore';
	end if;
	if v_gc.unreferenced_since > clock_timestamp() - interval '24 hours' then
		update public.qorpera_folder_object_gc set lease_id = null, lease_expires_at = null
		where profile_id = p_profile_id and sha256 = p_sha256;
		return 'restore';
	end if;
	begin
		delete from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256;
	exception when foreign_key_violation then
		delete from public.qorpera_folder_object_gc where profile_id = p_profile_id and sha256 = p_sha256;
		raise warning 'Folder object % of company % is referenced outside the folder core (C1D §9.3)', p_sha256, p_profile_id;
		return 'restore';
	end;
	return 'removed';
end $$;

-- Abandon: the lane failed; its mark is cleared at once, so the file is restored now rather than when the lease
-- expires. True when this lease held the mark.
create function public.qorpera_folder_gc_unlink_abandon(p_profile_id uuid, p_sha256 text, p_lease uuid)
returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	update public.qorpera_folder_object_gc set lease_id = null, lease_expires_at = null
	where profile_id = p_profile_id and sha256 = p_sha256 and lease_id = p_lease;
	return found;
end $$;

-- What to do with a quarantined file (C1D §9.8): 'live' while this lease is current (a lane is in flight); 'remove'
-- when no catalog row is left or the company is being deleted (the deleted-company GC collects its row); else
-- 'restore'. Plain reads.
create function public.qorpera_folder_gc_quarantine_state(p_profile_id uuid, p_sha256 text, p_lease uuid)
returns text language plpgsql stable security definer set search_path = '' set lock_timeout = '2s' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_folder_object_gc where profile_id = p_profile_id and sha256 = p_sha256
		and lease_id = p_lease and lease_expires_at > clock_timestamp()) then return 'live'; end if;
	if not exists (select 1 from public.qorpera_profile_objects where profile_id = p_profile_id and sha256 = p_sha256)
		or exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id) then return 'remove'; end if;
	return 'restore';
end $$;

-- 6. Chunk rows for version-1 proofs (C1D §9.3) ------------------------------------------------------------------------

-- Seal writes a version-2 proof's chunk rows. A version-1 proof (qorpera_verify_company_path_file; accepted in
-- folder-v2 until C5, and the folder fixtures use it) gets them here, for a folder-v2 company: when the proof is
-- written or re-verified, and, for proofs a company already holds, when an environment of it becomes folder-v2.
create function public.qorpera_folder_proof_chunks()
returns trigger language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
	if new.verifier_version <> 1 or not public.qorpera_company_is_folder_v2(new.profile_id) then return null; end if;
	insert into public.qorpera_folder_file_chunks(profile_id, chunk_sha256, manifest_sha256)
	select distinct new.profile_id, o ->> 'sha256', new.manifest_sha256 from jsonb_array_elements(new.objects) o
	where o ->> 'sha256' is distinct from new.manifest_sha256
	on conflict do nothing;
	return null;
end $$;
create trigger qorpera_folder_proof_chunks after insert or update on public.qorpera_verified_company_file_objects
	for each row execute function public.qorpera_folder_proof_chunks();

create function public.qorpera_folder_enabled_proof_chunks()
returns trigger language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
begin
	if new.core <> 'folder-v2' or (tg_op = 'UPDATE' and old.core = 'folder-v2') then return null; end if;
	insert into public.qorpera_folder_file_chunks(profile_id, chunk_sha256, manifest_sha256)
	select distinct v.profile_id, o ->> 'sha256', v.manifest_sha256 from public.qorpera_verified_company_file_objects v
	cross join jsonb_array_elements(v.objects) o
	where v.profile_id = new.profile_id and v.verifier_version = 1 and o ->> 'sha256' is distinct from v.manifest_sha256
	on conflict do nothing;
	return null;
end $$;
create trigger qorpera_folder_enabled_proof_chunks after insert or update of core on public.qorpera_company_files
	for each row execute function public.qorpera_folder_enabled_proof_chunks();

-- The folder-v2 companies of today.
insert into public.qorpera_folder_file_chunks(profile_id, chunk_sha256, manifest_sha256)
select distinct v.profile_id, o ->> 'sha256', v.manifest_sha256 from public.qorpera_verified_company_file_objects v
cross join jsonb_array_elements(v.objects) o
where v.verifier_version = 1 and o ->> 'sha256' is distinct from v.manifest_sha256
	and public.qorpera_company_is_folder_v2(v.profile_id)
on conflict do nothing;

-- 7. References refuse a marked object (C1D §9.7, G1) ---------------------------------------------------------------

-- Each check runs in a statement after the place's own lock, so it sees a mark committed while it waited.
create function pg_temp.c1d2_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C1d-2 patch anchor not found exactly once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
declare v_commit regprocedure;
begin
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit') <> 1 then
		raise exception 'C1d-2 expects exactly one qorpera_folder_commit'; end if;
	select oid::regprocedure into v_commit from pg_proc
	where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit';

	-- open: a present object GC holds is refused (the writer redoes its call, `contended`).
	perform pg_temp.c1d2_replace('public.qorpera_folder_open_upload(uuid,jsonb,text)',
		E'\t\torder by o.sha256 collate "C" for key share of o) p;\n',
		E'\t\torder by o.sha256 collate "C" for key share of o) p;\n'
		|| E'\tif exists (select 1 from jsonb_array_elements_text(v_present) s where public.qorpera_folder_object_marked(v_profile, s)) then\n'
		|| E'\t\traise exception ''Company folder object is being collected; retry'' using errcode = ''55P03''; end if;\n');
	-- confirm: a row that vanished between the insert and the lock, or one GC holds.
	perform pg_temp.c1d2_replace('public.qorpera_folder_confirm_object(uuid,jsonb,uuid,text,bigint)',
		E'\tif v_bytes is distinct from p_bytes then\n',
		E'\tif v_bytes is null or public.qorpera_folder_object_marked(v_intent.profile_id, p_sha256) then\n'
		|| E'\t\traise exception ''Company folder object is being collected; retry'' using errcode = ''55P03''; end if;\n'
		|| E'\tif v_bytes is distinct from p_bytes then\n');
	-- seal: any of the intent's objects GC holds.
	perform pg_temp.c1d2_replace('public.qorpera_folder_seal_upload(uuid,jsonb,uuid)',
		E'\twhere o.profile_id = v_intent.profile_id order by o.sha256 collate "C" for key share of o;\n',
		E'\twhere o.profile_id = v_intent.profile_id order by o.sha256 collate "C" for key share of o;\n'
		|| E'\tif exists (select 1 from public.qorpera_folder_upload_intent_objects i where i.intent_id = v_intent.id\n'
		|| E'\t\tand public.qorpera_folder_object_marked(v_intent.profile_id, i.sha256)) then\n'
		|| E'\t\traise exception ''Company folder object is being collected; retry'' using errcode = ''55P03''; end if;\n');
	-- authorize upload, before the NAS write (plain reads; safe by the intent's root, C1D §9.7).
	perform pg_temp.c1d2_replace('public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)',
		E'\tif not exists (select 1 from public.qorpera_profile_objects where profile_id = v_intent.profile_id and sha256 = p_sha256) then\n',
		E'\tif public.qorpera_folder_object_marked(v_intent.profile_id, p_sha256) then\n'
		|| E'\t\traise exception ''Company folder object is being collected; retry'' using errcode = ''55P03''; end if;\n'
		|| E'\tif not exists (select 1 from public.qorpera_profile_objects where profile_id = v_intent.profile_id and sha256 = p_sha256) then\n');
	-- replication, after its NO KEY UPDATE (and the Storage replica-insert guard, which calls it).
	perform pg_temp.c1d2_replace('public.qorpera_folder_authorize_replication(uuid,text,bigint)',
		E'\tif not found then raise exception ''replication object is unavailable'' using errcode = ''42501''; end if;\n',
		E'\tif not found then raise exception ''replication object is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\tif public.qorpera_folder_object_marked(p_profile_id, p_sha256) then\n'
		|| E'\t\traise exception ''Company folder object is being collected; retry'' using errcode = ''55P03''; end if;\n');
	-- download: a marked object is answered as missing (safe by roots: only an entry or path version makes it readable).
	perform pg_temp.c1d2_replace('public.qorpera_folder_authorize_object_download(uuid,jsonb,text)',
		E'\tif v_bytes is null then raise exception ''Object is unavailable'' using errcode = ''42501''; end if;\n',
		E'\tif v_bytes is null or public.qorpera_folder_object_marked(v_profile, p_sha256) then\n'
		|| E'\t\traise exception ''Object is unavailable'' using errcode = ''42501''; end if;\n');
	-- commit step 6: a marked object counts as not locked, so a unit referencing it is refused bytes_unverified.
	perform pg_temp.c1d2_replace(v_commit,
		E'\t\torder by o.sha256 collate "C" for key share) s;\n\n',
		E'\t\torder by o.sha256 collate "C" for key share) s;\n'
		|| E'\t-- C1d-2 (G1): an object GC holds for deletion counts as not locked, read after the lock.\n'
		|| E'\tselect coalesce(array_agg(s.sha256), ''{}'') into v_objects from unnest(v_objects) s(sha256)\n'
		|| E'\twhere not public.qorpera_folder_object_marked(v_file.profile_id, s.sha256);\n\n');
end $$;

-- 8. Grants ------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_gc_company(uuid), public.qorpera_folder_object_marked(uuid, text),
	public.qorpera_folder_object_rooted(uuid, text, uuid), public.qorpera_folder_proof_chunks(),
	public.qorpera_folder_enabled_proof_chunks()
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_sweep_upload_intents(integer), public.qorpera_folder_claim_object_gc(integer, uuid),
	public.qorpera_folder_gc_unlink_begin(uuid, text, uuid), public.qorpera_folder_gc_unlink_finish(uuid, text, uuid),
	public.qorpera_folder_gc_unlink_abandon(uuid, text, uuid), public.qorpera_folder_gc_quarantine_state(uuid, text, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_sweep_upload_intents(integer), public.qorpera_folder_claim_object_gc(integer, uuid),
	public.qorpera_folder_gc_unlink_begin(uuid, text, uuid), public.qorpera_folder_gc_unlink_finish(uuid, text, uuid),
	public.qorpera_folder_gc_unlink_abandon(uuid, text, uuid), public.qorpera_folder_gc_quarantine_state(uuid, text, uuid)
	to service_role;
