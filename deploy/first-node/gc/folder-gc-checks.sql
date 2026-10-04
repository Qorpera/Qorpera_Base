-- Folder GC's checks (deploy/first-node/RUNTIME-GC-SWITCH-ON.md, part 2). These statements only read, and print counts
-- and bytes, never an object name, a path or a company id. Run them one at a time (each is one statement), on production
-- through the Management API, before the switch, after the first worker run, and each hour for the first hours.

-- 1. The switch and its preconditions. folder_phase_on is what the worker asks (qorpera_folder_gc_enabled).
select (select enabled from public.qorpera_folder_gc_settings) as switch_on,
	public.qorpera_folder_gc_version1_refused() as version1_refused,
	(select enabled from public.qorpera_folder_gc_settings) and public.qorpera_folder_gc_version1_refused() as folder_phase_on,
	(select count(*) from public.qorpera_profiles p where public.qorpera_folder_gc_company(p.id)) as companies_served,
	(select count(*) from public.qorpera_profiles p
		where exists (select 1 from public.qorpera_company_files f where f.profile_id = p.id and f.core = 'folder-v2')
			and not public.qorpera_folder_gc_company(p.id)) as folder_companies_not_served;

-- 2. NOTHING LIVE IS MISSING (must be 0 in every column, every time). Each live file and each path version names a
-- manifest with a catalog row, and each chunk of those manifests has its own catalog row. A non-zero here before the
-- switch is a fault to understand first; after it, stop the phase (part 2, "Undo") and look.
with served as (
	select f.profile_id, f.environment_id from public.qorpera_company_files f
	where f.core = 'folder-v2' and public.qorpera_folder_gc_company(f.profile_id)
), manifests as (
	select s.profile_id, e.manifest_sha256 as sha256 from served s
	join public.qorpera_folder_entries e on e.environment_id = s.environment_id and e.kind = 'file'
	union
	select s.profile_id, v.manifest_sha256 from served s
	join public.qorpera_folder_path_versions v on v.environment_id = s.environment_id and v.manifest_sha256 is not null
)
select
	(select count(*) from manifests m where not exists (select 1 from public.qorpera_profile_objects o
		where o.profile_id = m.profile_id and o.sha256 = m.sha256)) as manifests_without_a_catalog_row,
	(select count(*) from manifests m join public.qorpera_folder_file_chunks c
		on c.profile_id = m.profile_id and c.manifest_sha256 = m.sha256
		where not exists (select 1 from public.qorpera_profile_objects o
			where o.profile_id = c.profile_id and o.sha256 = c.chunk_sha256)) as chunks_without_a_catalog_row,
	(select count(*) from manifests m join public.qorpera_folder_object_gc g
		on g.profile_id = m.profile_id and g.sha256 = m.sha256 and g.lease_expires_at > now()) as live_manifests_marked;

-- 3. The GC state of the companies folder GC serves: side rows (an object that lost its last root), by what the
-- next run does with them. 'due' rows are claimed (25 a run), NAS-backed ones only; a Storage-backed due row is kept.
select
	count(*) as side_rows,
	count(*) filter (where g.lease_expires_at > now()) as marked_now,
	count(*) filter (where (g.lease_id is null or g.lease_expires_at <= now())
		and g.unreferenced_since < now() - interval '24 hours' and o.backend = 'nas-object-gateway') as due,
	count(*) filter (where (g.lease_id is null or g.lease_expires_at <= now())
		and g.unreferenced_since < now() - interval '24 hours' and o.backend <> 'nas-object-gateway') as due_but_kept_storage_backed,
	count(*) filter (where g.unreferenced_since >= now() - interval '24 hours') as in_grace,
	coalesce(sum(o.bytes) filter (where g.unreferenced_since < now() - interval '24 hours'), 0) as due_bytes
from public.qorpera_folder_object_gc g
join public.qorpera_profile_objects o on o.profile_id = g.profile_id and o.sha256 = g.sha256;

-- 4. Due rows that something roots again (the claim re-checks and drops their side row instead of collecting them).
-- Small: it calls the root check once per due row.
select count(*) as due_but_rooted_again
from public.qorpera_folder_object_gc g
where (g.lease_id is null or g.lease_expires_at <= now()) and g.unreferenced_since < now() - interval '24 hours'
	and public.qorpera_folder_object_rooted(g.profile_id, g.sha256);

-- 5. Upload intents: the sweep takes those past expiry plus an hour, 25 a run; their objects that nothing else roots
-- get a side row and are due 24 hours after the intent's expiry.
select count(*) filter (where i.expires_at > now()) as open,
	count(*) filter (where i.expires_at <= now() and i.expires_at > now() - interval '1 hour') as expired_under_an_hour,
	count(*) filter (where i.expires_at <= now() - interval '1 hour') as waiting_for_the_sweep
from public.qorpera_folder_upload_intents i
where public.qorpera_folder_gc_company(i.profile_id);

-- 6. The served companies' catalog, by backend: the number that goes down only by what GC removed.
select o.backend, count(*) as objects, sum(o.bytes) as bytes
from public.qorpera_profile_objects o
where public.qorpera_folder_gc_company(o.profile_id)
group by o.backend
order by o.backend;
