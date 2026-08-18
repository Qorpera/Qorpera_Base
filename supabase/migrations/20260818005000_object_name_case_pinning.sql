-- Pins profile-object names to a single canonical spelling, and makes the
-- one-shot catalog backfill a callable, testable function.
--
-- The defect this closes was created by the cutover in 20260818004000, and
-- review caught it before that migration reached production.
--
-- The storage policies accept a mixed-case uuid segment
-- ([0-9a-fA-F] in 20260816010000 and 20260816018000) and authorize the write
-- through ((storage.foldername(name))[1])::uuid, a cast that is
-- case-insensitive. So a member with write access to their own profile can
-- legitimately upload at an upper-case prefix. Before the cutover that was
-- inert: every read compared name to profile_id::text || '/' || sha, and
-- postgres renders uuid lower-case, so an alias never matched anything.
--
-- The catalog changed that. qorpera_profile_object_identity accepted the same
-- mixed case and then lower()ed it, collapsing an alias onto the canonical
-- object's primary key, where the mirror's on-conflict clause overwrites
-- bytes. Two consequences, both reachable by an ordinary member:
--
--   * poisoning -- upload junk at UPPER/<sha of a real object> with a
--     different size, and every size-checked read (graph availability, entry
--     appends, runner input authorization) flips false for the real object;
--   * false existence -- upload junk at UPPER/<sha> with no canonical object,
--     and qorpera_object_exists answers true, so artifacts and reachability
--     graphs complete over content that every consumer, building the
--     canonical lower-case path, will fail to fetch.
--
-- Both halves are fixed here: the policies stop accepting aliases, and the
-- identity function stops folding them together. Either alone would do, and
-- neither alone is enough to be comfortable -- the policy stops creation, the
-- identity function refuses to collapse anything that predates it.

do $$
declare
	v_aliases bigint;
begin
	select count(*) into v_aliases
	from storage.objects as object
	where object.bucket_id = 'qorpera-profile-objects'
		and object.name <> lower(object.name);
	if v_aliases > 0 then
		-- Deliberately fatal. Tightening the identity function below would
		-- silently strand these rows outside the catalog, and the catalog is
		-- what the retention system now trusts to decide what may be deleted.
		raise exception 'refusing to pin object-name case while % non-canonical object name(s) exist; reconcile them first', v_aliases
			using errcode = '22023';
	end if;
end
$$;

alter policy qorpera_profile_objects_member_read on storage.objects
	using (
		bucket_id = 'qorpera-profile-objects'
		and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}$'
		and public.qorpera_can_read_profile(((storage.foldername(name))[1])::uuid)
	);

alter policy qorpera_profile_objects_member_insert on storage.objects
	with check (
		bucket_id = 'qorpera-profile-objects'
		and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}$'
		and public.qorpera_profile_object_writes_allowed(((storage.foldername(name))[1])::uuid)
	);

-- Canonical spelling only, and no normalisation: a name that is not already
-- canonical is not a profile object, so the mirror ignores it and the catalog
-- never gains a row that two different storage names could both claim.
create or replace function public.qorpera_profile_object_identity(
	p_bucket_id text,
	p_name text,
	p_metadata jsonb
)
returns table (profile_id uuid, sha256 text, bytes bigint)
language sql
immutable
security definer
set search_path = ''
as $$
	select
		case
			when p_bucket_id = 'qorpera-profile-objects'
				and split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				and split_part(p_name, '/', 2) ~ '^[0-9a-f]{64}$'
				and (p_metadata ->> 'size') ~ '^[0-9]+$'
			then split_part(p_name, '/', 1)::uuid
		end,
		case
			when p_bucket_id = 'qorpera-profile-objects'
				and split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				and split_part(p_name, '/', 2) ~ '^[0-9a-f]{64}$'
				and (p_metadata ->> 'size') ~ '^[0-9]+$'
			then split_part(p_name, '/', 2)
		end,
		case
			when p_bucket_id = 'qorpera-profile-objects'
				and split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				and split_part(p_name, '/', 2) ~ '^[0-9a-f]{64}$'
				and (p_metadata ->> 'size') ~ '^[0-9]+$'
			then (p_metadata ->> 'size')::bigint
		end
$$;

-- The backfill in 20260818003000 was inline, so it ran exactly once against
-- production and could never be exercised by a test: migrations run before
-- any fixture exists, so CI always backfilled an empty table and the suite's
-- "the catalog has rows" assertion was really observing the mirror trigger.
-- As a function it is callable, idempotent, and reports what it adopted.
create function public.qorpera_backfill_profile_object_catalog()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_adopted bigint;
begin
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes)
	select identity.profile_id, identity.sha256, identity.bytes
	from storage.objects as object
	cross join lateral
		public.qorpera_profile_object_identity(object.bucket_id, object.name, object.metadata) as identity
	where identity.profile_id is not null
		and identity.sha256 is not null
		and identity.bytes is not null
	on conflict (profile_id, sha256) do update set bytes = excluded.bytes;
	get diagnostics v_adopted = row_count;
	return v_adopted;
end
$$;

-- Belt and braces on the grant posture. Every internal function here relies on
-- "revoke from public", which is sufficient only while the database has no
-- default privileges granting execute to the client roles. Stock Supabase
-- ships such defaults, so a project restore or a future template change could
-- silently make these callable; naming the client roles explicitly means the
-- revoke survives that.
revoke all on function public.qorpera_profile_object_identity(text, text, jsonb) from anon, authenticated;
revoke all on function public.qorpera_mirror_profile_object() from anon, authenticated;
revoke all on function public.qorpera_object_catalog_drift() from anon, authenticated;
revoke all on function public.qorpera_object_exists(uuid, text, bigint) from anon, authenticated;
revoke all on function public.qorpera_backfill_profile_object_catalog() from public, anon, authenticated;
