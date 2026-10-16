-- @fixture 883_folder_core_erasure.test.sql until "-- 1. Refusals before anything changes"
-- The GC runbook's read-only checks (deploy/first-node/RUNTIME-GC-SWITCH-ON.md; deploy/first-node/gc/*.sql) on a seeded
-- fixture. Each statement is copied here verbatim, as `create temp table <name> as <statement>`
-- (scripts/gc-runbook-sql.test.mjs keeps the copies equal to the files), and run twice: before the seeds and after
-- them. The test checks the differences, since the shared suite database may hold other tests' objects. The dry run
-- sees every kind of Storage object; the folder checks see a live file's chunk under a GC mark, a due row something
-- roots again, and a company folder GC does not serve. On 803's company; rolled back at the end.

create function pg_temp.eq(p_got anyelement, p_want anyelement, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- The numeric differences between two flat objects (after minus before), leaving out the keys that did not change.
create function pg_temp.delta(p_after jsonb, p_before jsonb) returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(k, d), '{}'::jsonb) from (
		select k, coalesce((p_after ->> k)::numeric, 0) - coalesce((p_before ->> k)::numeric, 0) as d
		from (select jsonb_object_keys(coalesce(p_after, '{}'::jsonb)) as k
			union select jsonb_object_keys(coalesce(p_before, '{}'::jsonb))) keys) x
	where d <> 0
$$;

-- The company is all folder-v2, so folder GC serves it.
select public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');

-- Every statement, before the seeds ---------------------------------------------------------------------------------------

create temp table gc_dry_1_0 as
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
create temp table gc_dry_2_0 as
select o.backend, count(distinct o.profile_id) as companies, count(*) as rows, sum(o.bytes) as bytes,
	ceil(max(per.rows)::numeric / 100) as runs_for_the_largest_company
from public.qorpera_profile_objects o
join (select profile_id, count(*) as rows from public.qorpera_profile_objects group by profile_id) per
	on per.profile_id = o.profile_id
where not exists (select 1 from public.qorpera_profiles p where p.id = o.profile_id)
group by o.backend
order by o.backend;
create temp table gc_dry_3_0 as
select bucket,
	count(*) filter (where removed_at is null and last_error is null) as waiting,
	count(*) filter (where removed_at is null and last_error is not null) as failing,
	count(*) filter (where removed_at is not null) as removed
from public.qorpera_company_storage_deletions
group by bucket
order by bucket;
create temp table gc_dry_4_0 as
select 'deletion authorizations outstanding (' || source_kind || ')' as queue, count(*) as rows
from public.qorpera_profile_object_deletion_authorizations group by source_kind
union all
select 'deleted-profile GC leases', count(*) from public.qorpera_deleted_profile_object_gc_leases
order by 1;
create temp table gc_dry_5_0 as
select count(*) as live_company_objects, coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0) as bytes
from storage.objects o
where o.bucket_id = 'qorpera-profile-objects'
	-- The cast only for a name that has the shape (a WHERE clause has no evaluation order; CASE has).
	and exists (select 1 from public.qorpera_profiles p where p.id = case
		when o.name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then split_part(o.name, '/', 1)::uuid end);
create temp table gc_chk_1_0 as
select (select enabled from public.qorpera_folder_gc_settings) as switch_on,
	public.qorpera_folder_gc_version1_refused() as version1_refused,
	(select enabled from public.qorpera_folder_gc_settings) and public.qorpera_folder_gc_version1_refused() as folder_phase_on,
	(select count(*) from public.qorpera_profiles p where public.qorpera_folder_gc_company(p.id)) as companies_served,
	(select count(*) from public.qorpera_profiles p
		where exists (select 1 from public.qorpera_company_files f where f.profile_id = p.id and f.core = 'folder-v2')
			and not public.qorpera_folder_gc_company(p.id)) as folder_companies_not_served;
create temp table gc_chk_2_0 as
with served as (
	select f.profile_id, f.environment_id from public.qorpera_company_files f
	where f.core = 'folder-v2' and public.qorpera_folder_gc_company(f.profile_id)
), manifests as (
	select s.profile_id, e.manifest_sha256 as sha256 from served s
	join public.qorpera_folder_entries e on e.environment_id = s.environment_id and e.kind = 'file'
	union
	select s.profile_id, v.manifest_sha256 from served s
	join public.qorpera_folder_path_versions v on v.environment_id = s.environment_id and v.manifest_sha256 is not null
), live_objects as (
	select m.profile_id, m.sha256 from manifests m
	union
	select c.profile_id, c.chunk_sha256 from manifests m
	join public.qorpera_folder_file_chunks c on c.profile_id = m.profile_id and c.manifest_sha256 = m.sha256
)
select
	(select count(*) from manifests m where not exists (select 1 from public.qorpera_profile_objects o
		where o.profile_id = m.profile_id and o.sha256 = m.sha256)) as manifests_without_a_catalog_row,
	(select count(*) from manifests m join public.qorpera_folder_file_chunks c
		on c.profile_id = m.profile_id and c.manifest_sha256 = m.sha256
		where not exists (select 1 from public.qorpera_profile_objects o
			where o.profile_id = c.profile_id and o.sha256 = c.chunk_sha256)) as chunks_without_a_catalog_row,
	(select count(*) from live_objects l join public.qorpera_folder_object_gc g
		on g.profile_id = l.profile_id and g.sha256 = l.sha256 and g.lease_expires_at > now()) as live_objects_marked;
create temp table gc_chk_3_0 as
select
	count(*) as side_rows,
	count(*) filter (where g.lease_expires_at > now()) as marked_now,
	count(*) filter (where (g.lease_id is null or g.lease_expires_at <= now())
		and g.unreferenced_since < now() - interval '24 hours' and o.backend = 'nas-object-gateway') as due,
	count(*) filter (where (g.lease_id is null or g.lease_expires_at <= now())
		and g.unreferenced_since < now() - interval '24 hours' and o.backend <> 'nas-object-gateway') as due_but_kept_storage_backed,
	count(*) filter (where g.unreferenced_since >= now() - interval '24 hours') as in_grace,
	coalesce(sum(o.bytes) filter (where g.unreferenced_since < now() - interval '24 hours'), 0) as due_bytes,
	(select count(*) from public.qorpera_folder_object_gc x where not public.qorpera_folder_gc_company(x.profile_id))
		as side_rows_of_companies_not_served
from public.qorpera_folder_object_gc g
join public.qorpera_profile_objects o on o.profile_id = g.profile_id and o.sha256 = g.sha256
where public.qorpera_folder_gc_company(g.profile_id);
create temp table gc_chk_4_0 as
select count(*) as due_but_rooted_again
from public.qorpera_folder_object_gc g
where (g.lease_id is null or g.lease_expires_at <= now()) and g.unreferenced_since < now() - interval '24 hours'
	and public.qorpera_folder_gc_company(g.profile_id)
	and public.qorpera_folder_object_rooted(g.profile_id, g.sha256);
create temp table gc_chk_5_0 as
select count(*) filter (where i.expires_at > now()) as open,
	count(*) filter (where i.expires_at <= now() and i.expires_at > now() - interval '1 hour') as expired_under_an_hour,
	count(*) filter (where i.expires_at <= now() - interval '1 hour') as waiting_for_the_sweep
from public.qorpera_folder_upload_intents i
where public.qorpera_folder_gc_company(i.profile_id);
create temp table gc_chk_6_0 as
select o.backend, count(*) as objects, sum(o.bytes) as bytes
from public.qorpera_profile_objects o
where public.qorpera_folder_gc_company(o.profile_id)
group by o.backend
order by o.backend;

-- The seeds (foreign keys and triggers off while they go in) -------------------------------------------------------------
-- Storage and the ledgers: a purged company (…9001) with a Storage-backed and a NAS-backed catalog row, an object with no
-- catalog row of a company gone (…9002) and one of the live company, an odd name; capsules recorded, recorded as
-- removed, named by a row, orphaned, and new; recovery objects under a recorded prefix (one with a stray name) and of a
-- company gone; a member picture.
set session_replication_role = replica;
insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend) values
	('99170000-0000-4000-8000-000000009001', repeat('a', 64), 10, 'supabase-storage'),
	('99170000-0000-4000-8000-000000009001', repeat('b', 64), 20, 'nas-object-gateway');
insert into storage.objects(bucket_id, name, metadata) values
	('qorpera-profile-objects', '99170000-0000-4000-8000-000000009001/' || repeat('a', 64), '{"size":10}'),
	('qorpera-profile-objects', '99170000-0000-4000-8000-000000009002/' || repeat('c', 64), '{"size":5}'),
	('qorpera-profile-objects', '70700000-0000-4000-8000-000000000010/' || repeat('f', 64), '{"size":6}'),
	('qorpera-profile-objects', 'odd-name-917', '{"size":1}'),
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c1.capsule', '{"size":100}'),
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c2.capsule', '{"size":100}'),
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c3.capsule', '{"size":100}'),
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c4.capsule', '{"size":100}'),
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c5.capsule', '{"size":100}'),
	('qorpera-identity-recovery', '99170000-0000-4000-8000-000000009001/' || repeat('d', 64), '{"size":7}'),
	('qorpera-identity-recovery', '99170000-0000-4000-8000-000000009001/stray.txt', '{"size":7}'),
	('qorpera-identity-recovery', '99170000-0000-4000-8000-000000009003/' || repeat('e', 64), '{"size":7}'),
	('qorpera-member-pictures', '70700000-0000-4000-8000-000000000001/picture-917.webp', '{"size":3}');
update storage.objects set created_at = now() - interval '3 days', updated_at = now() - interval '3 days'
where bucket_id = 'qorpera-native-compute-capsules' and name = '99170000-0000-4000-8000-0000000000c4.capsule';
insert into public.qorpera_company_storage_deletions(bucket, object_path, profile_id, removed_at) values
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c1.capsule', '99170000-0000-4000-8000-000000009001', null),
	('qorpera-native-compute-capsules', '99170000-0000-4000-8000-0000000000c2.capsule', '99170000-0000-4000-8000-000000009001', now()),
	('qorpera-identity-recovery', '99170000-0000-4000-8000-000000009001/', '99170000-0000-4000-8000-000000009001', null);
insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, provider,
	native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
values ('99170000-0000-4000-8000-0000000000c3', '70700000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'company', 'openai',
	'codex-cli', 'native-capsule/99170000-0000-4000-8000-0000000000c3', repeat('e', 64), '70700000-0000-4000-8000-000000000001');
-- Side rows: an unreferenced NAS-backed object due (A), a Storage-backed one due (B), one in grace (C), a live file's
-- chunk under a live mark (D), a live manifest due again (E), and an object of a company folder GC does not serve (F, a
-- profile with no company file).
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('99170000-0000-4000-8000-00000000f001', 'Not served', '70700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend) values
	('70700000-0000-4000-8000-000000000010', repeat('1', 64), 100, 'nas-object-gateway'),
	('70700000-0000-4000-8000-000000000010', repeat('2', 64), 200, 'supabase-storage'),
	('70700000-0000-4000-8000-000000000010', repeat('3', 64), 300, 'nas-object-gateway'),
	('99170000-0000-4000-8000-00000000f001', repeat('4', 64), 400, 'nas-object-gateway');
insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since) values
	('70700000-0000-4000-8000-000000000010', repeat('1', 64), now() - interval '2 days'),
	('70700000-0000-4000-8000-000000000010', repeat('2', 64), now() - interval '2 days'),
	('70700000-0000-4000-8000-000000000010', repeat('3', 64), now()),
	('99170000-0000-4000-8000-00000000f001', repeat('4', 64), now() - interval '2 days');
create temp table gc_live (sha256 text, kind text);
insert into gc_live
select c.chunk_sha256, 'chunk' from public.qorpera_folder_file_chunks c
join public.qorpera_folder_entries e on e.manifest_sha256 = c.manifest_sha256 and e.kind = 'file'
	and e.environment_id = '70700000-0000-4000-8000-000000000020'
where c.profile_id = '70700000-0000-4000-8000-000000000010' and c.chunk_sha256 <> c.manifest_sha256
order by c.chunk_sha256 limit 1;
insert into gc_live
select e.manifest_sha256, 'manifest' from public.qorpera_folder_entries e
where e.environment_id = '70700000-0000-4000-8000-000000000020' and e.kind = 'file'
	and not exists (select 1 from public.qorpera_folder_file_chunks c join gc_live l on l.sha256 = c.chunk_sha256
		where c.profile_id = '70700000-0000-4000-8000-000000000010' and c.manifest_sha256 = e.manifest_sha256)
order by e.manifest_sha256 limit 1;
insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since, lease_id, lease_expires_at)
select '70700000-0000-4000-8000-000000000010', sha256, now(), extensions.gen_random_uuid(), now() + interval '10 minutes' from gc_live where kind = 'chunk';
insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
select '70700000-0000-4000-8000-000000000010', sha256, now() - interval '2 days' from gc_live where kind = 'manifest';
set session_replication_role = origin;

-- Every statement, after the seeds -----------------------------------------------------------------------------------------

create temp table gc_dry_1 as
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
create temp table gc_dry_2 as
select o.backend, count(distinct o.profile_id) as companies, count(*) as rows, sum(o.bytes) as bytes,
	ceil(max(per.rows)::numeric / 100) as runs_for_the_largest_company
from public.qorpera_profile_objects o
join (select profile_id, count(*) as rows from public.qorpera_profile_objects group by profile_id) per
	on per.profile_id = o.profile_id
where not exists (select 1 from public.qorpera_profiles p where p.id = o.profile_id)
group by o.backend
order by o.backend;
create temp table gc_dry_3 as
select bucket,
	count(*) filter (where removed_at is null and last_error is null) as waiting,
	count(*) filter (where removed_at is null and last_error is not null) as failing,
	count(*) filter (where removed_at is not null) as removed
from public.qorpera_company_storage_deletions
group by bucket
order by bucket;
create temp table gc_dry_4 as
select 'deletion authorizations outstanding (' || source_kind || ')' as queue, count(*) as rows
from public.qorpera_profile_object_deletion_authorizations group by source_kind
union all
select 'deleted-profile GC leases', count(*) from public.qorpera_deleted_profile_object_gc_leases
order by 1;
create temp table gc_dry_5 as
select count(*) as live_company_objects, coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0) as bytes
from storage.objects o
where o.bucket_id = 'qorpera-profile-objects'
	-- The cast only for a name that has the shape (a WHERE clause has no evaluation order; CASE has).
	and exists (select 1 from public.qorpera_profiles p where p.id = case
		when o.name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then split_part(o.name, '/', 1)::uuid end);
create temp table gc_chk_1 as
select (select enabled from public.qorpera_folder_gc_settings) as switch_on,
	public.qorpera_folder_gc_version1_refused() as version1_refused,
	(select enabled from public.qorpera_folder_gc_settings) and public.qorpera_folder_gc_version1_refused() as folder_phase_on,
	(select count(*) from public.qorpera_profiles p where public.qorpera_folder_gc_company(p.id)) as companies_served,
	(select count(*) from public.qorpera_profiles p
		where exists (select 1 from public.qorpera_company_files f where f.profile_id = p.id and f.core = 'folder-v2')
			and not public.qorpera_folder_gc_company(p.id)) as folder_companies_not_served;
create temp table gc_chk_2 as
with served as (
	select f.profile_id, f.environment_id from public.qorpera_company_files f
	where f.core = 'folder-v2' and public.qorpera_folder_gc_company(f.profile_id)
), manifests as (
	select s.profile_id, e.manifest_sha256 as sha256 from served s
	join public.qorpera_folder_entries e on e.environment_id = s.environment_id and e.kind = 'file'
	union
	select s.profile_id, v.manifest_sha256 from served s
	join public.qorpera_folder_path_versions v on v.environment_id = s.environment_id and v.manifest_sha256 is not null
), live_objects as (
	select m.profile_id, m.sha256 from manifests m
	union
	select c.profile_id, c.chunk_sha256 from manifests m
	join public.qorpera_folder_file_chunks c on c.profile_id = m.profile_id and c.manifest_sha256 = m.sha256
)
select
	(select count(*) from manifests m where not exists (select 1 from public.qorpera_profile_objects o
		where o.profile_id = m.profile_id and o.sha256 = m.sha256)) as manifests_without_a_catalog_row,
	(select count(*) from manifests m join public.qorpera_folder_file_chunks c
		on c.profile_id = m.profile_id and c.manifest_sha256 = m.sha256
		where not exists (select 1 from public.qorpera_profile_objects o
			where o.profile_id = c.profile_id and o.sha256 = c.chunk_sha256)) as chunks_without_a_catalog_row,
	(select count(*) from live_objects l join public.qorpera_folder_object_gc g
		on g.profile_id = l.profile_id and g.sha256 = l.sha256 and g.lease_expires_at > now()) as live_objects_marked;
create temp table gc_chk_3 as
select
	count(*) as side_rows,
	count(*) filter (where g.lease_expires_at > now()) as marked_now,
	count(*) filter (where (g.lease_id is null or g.lease_expires_at <= now())
		and g.unreferenced_since < now() - interval '24 hours' and o.backend = 'nas-object-gateway') as due,
	count(*) filter (where (g.lease_id is null or g.lease_expires_at <= now())
		and g.unreferenced_since < now() - interval '24 hours' and o.backend <> 'nas-object-gateway') as due_but_kept_storage_backed,
	count(*) filter (where g.unreferenced_since >= now() - interval '24 hours') as in_grace,
	coalesce(sum(o.bytes) filter (where g.unreferenced_since < now() - interval '24 hours'), 0) as due_bytes,
	(select count(*) from public.qorpera_folder_object_gc x where not public.qorpera_folder_gc_company(x.profile_id))
		as side_rows_of_companies_not_served
from public.qorpera_folder_object_gc g
join public.qorpera_profile_objects o on o.profile_id = g.profile_id and o.sha256 = g.sha256
where public.qorpera_folder_gc_company(g.profile_id);
create temp table gc_chk_4 as
select count(*) as due_but_rooted_again
from public.qorpera_folder_object_gc g
where (g.lease_id is null or g.lease_expires_at <= now()) and g.unreferenced_since < now() - interval '24 hours'
	and public.qorpera_folder_gc_company(g.profile_id)
	and public.qorpera_folder_object_rooted(g.profile_id, g.sha256);
create temp table gc_chk_5 as
select count(*) filter (where i.expires_at > now()) as open,
	count(*) filter (where i.expires_at <= now() and i.expires_at > now() - interval '1 hour') as expired_under_an_hour,
	count(*) filter (where i.expires_at <= now() - interval '1 hour') as waiting_for_the_sweep
from public.qorpera_folder_upload_intents i
where public.qorpera_folder_gc_company(i.profile_id);
create temp table gc_chk_6 as
select o.backend, count(*) as objects, sum(o.bytes) as bytes
from public.qorpera_profile_objects o
where public.qorpera_folder_gc_company(o.profile_id)
group by o.backend
order by o.backend;

do $$
declare v_e_bytes bigint;
begin
	if (select count(*) from gc_live) <> 2 then raise exception 'The fixture has a live chunk and another live manifest'; end if;
	select o.bytes into v_e_bytes from gc_live l join public.qorpera_profile_objects o on o.profile_id = '70700000-0000-4000-8000-000000000010' and o.sha256 = l.sha256
	where l.kind = 'manifest';

	-- The dry run: one object of every kind more, in its bucket and kind.
	perform pg_temp.eq(pg_temp.delta(
		(select jsonb_object_agg(bucket || ' | ' || kind, objects) from gc_dry_1),
		(select jsonb_object_agg(bucket || ' | ' || kind, objects) from gc_dry_1_0)), jsonb_build_object(
		'qorpera-identity-recovery | REMOVED: recorded for a purged company (D5a phase)', 1,
		'qorpera-identity-recovery | kept, and HOLDS ITS PREFIX: not a recovery object under a recorded prefix (D5a stops there)', 1,
		'qorpera-identity-recovery | kept: company gone, nothing recorded (no phase removes it)', 1,
		'qorpera-member-pictures | kept: member pictures (they belong to accounts)', 1,
		'qorpera-native-compute-capsules | REMOVED: recorded for a purged company (D5a phase)', 1,
		'qorpera-native-compute-capsules | kept: ORPHAN, no capsule row, over a day old (abandoned sign-in; no phase removes it)', 1,
		'qorpera-native-compute-capsules | kept: named by a capsule row', 1,
		'qorpera-native-compute-capsules | kept: no capsule row yet, under a day old (a sign-in under way)', 1,
		'qorpera-native-compute-capsules | kept: recorded as removed, but still here (look at it)', 1,
		'qorpera-profile-objects | REMOVED: catalogued, company purged (deleted-profile phase)', 1,
		'qorpera-profile-objects | kept: no catalog row, company gone (no phase removes it)', 1,
		'qorpera-profile-objects | kept: no catalog row, company live', 1,
		'qorpera-profile-objects | kept: unexpected name', 1), 'every Storage object, by bucket and kind');
	perform pg_temp.eq(pg_temp.delta(
		(select jsonb_object_agg(backend || ' ' || f.key, f.value) from gc_dry_2 d,
			lateral jsonb_each(jsonb_build_object('companies', d.companies, 'rows', d.rows, 'bytes', d.bytes)) f),
		(select jsonb_object_agg(backend || ' ' || f.key, f.value) from gc_dry_2_0 d,
			lateral jsonb_each(jsonb_build_object('companies', d.companies, 'rows', d.rows, 'bytes', d.bytes)) f)),
		'{"nas-object-gateway companies": 1, "nas-object-gateway rows": 1, "nas-object-gateway bytes": 20,
			"supabase-storage companies": 1, "supabase-storage rows": 1, "supabase-storage bytes": 10}'::jsonb,
		'the purged companies'' catalog rows');
	perform pg_temp.eq(pg_temp.delta(
		(select jsonb_object_agg(bucket || ' ' || f.key, f.value) from gc_dry_3 d,
			lateral jsonb_each(jsonb_build_object('waiting', d.waiting, 'failing', d.failing, 'removed', d.removed)) f),
		(select jsonb_object_agg(bucket || ' ' || f.key, f.value) from gc_dry_3_0 d,
			lateral jsonb_each(jsonb_build_object('waiting', d.waiting, 'failing', d.failing, 'removed', d.removed)) f)),
		'{"qorpera-identity-recovery waiting": 1, "qorpera-native-compute-capsules waiting": 1,
			"qorpera-native-compute-capsules removed": 1}'::jsonb, 'the D5a ledger');
	perform pg_temp.eq(pg_temp.delta((select jsonb_object_agg(queue, rows) from gc_dry_4),
		(select jsonb_object_agg(queue, rows) from gc_dry_4_0)), '{}'::jsonb, 'the other queues');
	perform pg_temp.eq((select live_company_objects from gc_dry_5) - (select live_company_objects from gc_dry_5_0), 1::bigint,
		'the live company''s objects in Storage');

	-- The folder checks.
	perform pg_temp.eq((select to_jsonb(c) - 'companies_served' from gc_chk_1 c),
		'{"switch_on": false, "folder_phase_on": false, "version1_refused": true, "folder_companies_not_served": 0}'::jsonb,
		'the switch and its preconditions');
	perform pg_temp.eq((select companies_served >= 1 from gc_chk_1), true, 'the company is served');
	-- A live file's chunk under a live mark is caught, though no manifest is marked.
	perform pg_temp.eq(pg_temp.delta((select to_jsonb(c) from gc_chk_2 c), (select to_jsonb(c) from gc_chk_2_0 c)),
		'{"live_objects_marked": 1}'::jsonb, 'a marked live chunk');
	-- A, B, C, D and E are the served company's; F is counted apart, never due.
	perform pg_temp.eq(pg_temp.delta((select to_jsonb(c) from gc_chk_3 c), (select to_jsonb(c) from gc_chk_3_0 c)),
		jsonb_build_object('side_rows', 5, 'marked_now', 1, 'due', 2, 'due_but_kept_storage_backed', 1, 'in_grace', 2,
			'due_bytes', 300 + v_e_bytes, 'side_rows_of_companies_not_served', 1), 'the side rows');
	perform pg_temp.eq((select due_but_rooted_again from gc_chk_4) - (select due_but_rooted_again from gc_chk_4_0), 1::bigint,
		'a due row rooted again (E)');
	perform pg_temp.eq((select count(*) from gc_chk_5), 1::bigint, 'the intents, one row');
	perform pg_temp.eq(pg_temp.delta((select jsonb_object_agg(backend, objects) from gc_chk_6),
		(select jsonb_object_agg(backend, objects) from gc_chk_6_0)),
		'{"nas-object-gateway": 2, "supabase-storage": 1}'::jsonb, 'the served company''s catalog');
end $$;

rollback;
