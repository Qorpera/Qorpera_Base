-- The artifact GC worker's dry run (deploy/first-node/RUNTIME-GC-SWITCH-ON.md, part 1). The worker itself has no dry run:
-- its first call already removes. These statements only read, and print counts and bytes, never an object name, a path
-- or a company id. Run them one at a time (each is one statement), on production through the Management API, before
-- the worker is deployed and again after each run. Every statement reads only small tables (Storage's object list and
-- the catalog), with no join per object over a large table.

-- 1. Every Storage object, by bucket and by what the worker will do with it.
with o as (
	select bucket_id as bucket, name, greatest(created_at, updated_at) as touched_at,
		coalesce((metadata ->> 'size')::bigint, 0) as bytes
	from storage.objects
)
select o.bucket, k.kind, count(*) as objects, sum(o.bytes) as bytes
from o
cross join lateral (
	select case o.bucket
		-- Company File and folder objects: '<company>/<sha256>', one catalog row each.
		when 'qorpera-profile-objects' then (
			case when o.name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
				then 'kept: unexpected name'
			else (
				select case
					when c.profile_id is not null and p.id is null
						then 'REMOVED: catalogued, company purged (deleted-profile phase)'
					when c.profile_id is null and p.id is null then 'kept: no catalog row, company gone (no phase removes it)'
					when c.profile_id is null then 'kept: no catalog row, company live'
					when exists (select 1 from public.qorpera_company_files cf where cf.profile_id = p.id and cf.core <> 'folder-v2')
						then 'kept: catalogued, snapshot-v1 company (no phase removes it)'
					else 'kept: catalogued, folder-v2 company (folder GC once unreferenced 24 h and switched on)' end
				from (select split_part(o.name, '/', 1)::uuid as profile_id, lower(split_part(o.name, '/', 2)) as sha256) n
				left join public.qorpera_profile_objects c on c.profile_id = n.profile_id and c.sha256 = n.sha256
				left join public.qorpera_profiles p on p.id = n.profile_id)
			end)
		-- Node-held credential capsules: '<capsule id>.capsule', named by a capsule row as 'native-capsule/<id>'.
		when 'qorpera-native-compute-capsules' then (
			case when o.name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capsule$'
				then 'kept: unexpected name'
			when exists (select 1 from public.qorpera_company_storage_deletions d
					where d.bucket = o.bucket and d.object_path = lower(o.name) and d.removed_at is null)
				then 'REMOVED: recorded for a purged company (D5a phase)'
			when exists (select 1 from public.qorpera_company_storage_deletions d
					where d.bucket = o.bucket and d.object_path = lower(o.name))
				then 'kept: recorded as removed, but still here (look at it)'
			when exists (select 1 from public.qorpera_native_credential_capsules c
					where c.encrypted_capsule_reference = 'native-capsule/' || lower(split_part(o.name, '.', 1)))
				then 'kept: named by a capsule row'
			when o.touched_at < now() - interval '1 day'
				then 'kept: ORPHAN, no capsule row, over a day old (abandoned sign-in; no phase removes it)'
			else 'kept: no capsule row yet, under a day old (a sign-in under way)' end)
		-- Identity recovery backups: '<company>/<sha256>'.
		when 'qorpera-identity-recovery' then (
			case when o.name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
				then 'kept: unexpected name'
			when exists (select 1 from public.qorpera_company_storage_deletions d
					where d.bucket = o.bucket and d.object_path = lower(split_part(o.name, '/', 1)) || '/' and d.removed_at is null)
				then (case when split_part(o.name, '/', 2) ~ '^[0-9a-f]{64}$' and split_part(o.name, '/', 3) = ''
					then 'REMOVED: recorded for a purged company (D5a phase)'
					else 'kept, and HOLDS ITS PREFIX: not a recovery object under a recorded prefix (D5a stops there)' end)
			when exists (select 1 from public.qorpera_profiles p where p.id = split_part(o.name, '/', 1)::uuid)
				then 'kept: company live'
			else 'kept: company gone, nothing recorded (no phase removes it)' end)
		when 'qorpera-member-pictures' then 'kept: member pictures (they belong to accounts)'
		else 'kept: a bucket the worker never touches' end as kind) k
group by o.bucket, k.kind
order by o.bucket, k.kind;

-- 2. The catalog rows of purged companies, which the deleted-profile phase removes: one company per run, at most 100
-- rows a run. A 'nas-object-gateway' row is removed through the object gateway (QORPERA_OBJECT_GATEWAY_URL and
-- QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN on the function, and the mux passing DELETE /v1/profile-objects/...); without
-- them that company's batch fails on every run and nothing of it is removed. 'missing' rows have no bytes left: the
-- row only goes.
select o.backend, count(distinct o.profile_id) as companies, count(*) as rows, sum(o.bytes) as bytes,
	ceil(max(per.rows)::numeric / 100) as runs_for_the_largest_company
from public.qorpera_profile_objects o
join (select profile_id, count(*) as rows from public.qorpera_profile_objects group by profile_id) per
	on per.profile_id = o.profile_id
where not exists (select 1 from public.qorpera_profiles p where p.id = o.profile_id)
group by o.backend
order by o.backend;

-- 3. The D5a ledger (capsules and recovery prefixes of purged companies), 100 entries a run.
select bucket,
	count(*) filter (where removed_at is null and last_error is null) as waiting,
	count(*) filter (where removed_at is null and last_error is not null) as failing,
	count(*) filter (where removed_at is not null) as removed
from public.qorpera_company_storage_deletions
group by bucket
order by bucket;

-- 4. The worker's other queues: outstanding deletion authorizations and live deleted-profile leases. All zero is
-- expected after the wipe.
select 'deletion authorizations outstanding (' || source_kind || ')' as queue, count(*) as rows
from public.qorpera_profile_object_deletion_authorizations group by source_kind
union all
select 'deleted-profile GC leases', count(*) from public.qorpera_deleted_profile_object_gc_leases
order by 1;

-- 5. Live companies' objects in Storage: while the folder phase is off, this never goes down from one run to the next
-- (a live company may add files). The worker removes nothing in a live company's prefix then (statement 1 says what it
-- removes; this one says what it must not).
select count(*) as live_company_objects, coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0) as bytes
from storage.objects o
where o.bucket_id = 'qorpera-profile-objects'
	-- The cast only for a name that has the shape (a WHERE clause has no evaluation order; CASE has).
	and exists (select 1 from public.qorpera_profiles p where p.id = case
		when o.name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then split_part(o.name, '/', 1)::uuid end);
