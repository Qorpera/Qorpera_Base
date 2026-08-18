-- Step 1 of the self-owned object backend (see supabase/OBJECT-BACKEND.md).
--
-- Twelve sites across six migrations join storage.objects to ask one
-- question: does an object exist for this profile, at this sha256, with these
-- bytes? That question is the trust root of reachability closure, restore
-- proofs, GC exclusivity, and lease-scoped runner reads — and it is only
-- answerable today because Supabase Storage happens to write its bookkeeping
-- into the same database.
--
-- This migration introduces the catalog those sites will read instead. It is
-- deliberately inert: nothing queries it yet, storage.objects stays
-- authoritative, and a trigger mirrors every profile-object write so the two
-- cannot silently diverge. A drift function makes equivalence assertable in
-- CI before anything is cut over.
--
-- The catalog is not client-writable, by design. The review that preceded
-- this work found that client-asserted reachability graphs could under-cover
-- a root and drive the cleanup worker into deleting live objects; a catalog
-- any client could write would reintroduce exactly that defect one layer
-- lower. Rows arrive only from the mirror trigger today, and only from a
-- server-side-hashing gateway later.

create table public.qorpera_profile_objects (
	-- No foreign key to qorpera_profiles: storage.objects carries none either,
	-- so adding one here would make an unrelated upload fail where today it
	-- merely orphans. Orphan reclamation belongs to the gateway slice.
	profile_id uuid not null,
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes >= 0),
	backend text not null default 'supabase-storage'
		check (backend in ('supabase-storage')),
	created_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, sha256)
);

alter table public.qorpera_profile_objects enable row level security;
revoke all on public.qorpera_profile_objects from anon, authenticated;

-- Decompose a bucket object name into its profile and content address, or
-- return nulls when the name is not a profile object. Kept in one place so
-- the mirror, the backfill, and the drift check cannot disagree.
create function public.qorpera_profile_object_identity(
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
				and split_part(p_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
				and split_part(p_name, '/', 2) ~ '^[0-9a-f]{64}$'
				and (p_metadata ->> 'size') ~ '^[0-9]+$'
			then lower(split_part(p_name, '/', 1))::uuid
		end,
		case
			when p_bucket_id = 'qorpera-profile-objects'
				and split_part(p_name, '/', 2) ~ '^[0-9a-f]{64}$'
				and (p_metadata ->> 'size') ~ '^[0-9]+$'
			then split_part(p_name, '/', 2)
		end,
		case
			when p_bucket_id = 'qorpera-profile-objects'
				and (p_metadata ->> 'size') ~ '^[0-9]+$'
			then (p_metadata ->> 'size')::bigint
		end
$$;

revoke all on function public.qorpera_profile_object_identity(text, text, jsonb) from public;

create function public.qorpera_mirror_profile_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_identity record;
begin
	if tg_op = 'DELETE' then
		select * into v_identity
		from public.qorpera_profile_object_identity(old.bucket_id, old.name, old.metadata);
		if v_identity.profile_id is not null then
			delete from public.qorpera_profile_objects
			where profile_id = v_identity.profile_id and sha256 = v_identity.sha256;
		end if;
		return old;
	end if;

	select * into v_identity
	from public.qorpera_profile_object_identity(new.bucket_id, new.name, new.metadata);
	-- Anything that is not a well-formed profile object is ignored rather than
	-- rejected: this trigger must never be able to fail an upload that the
	-- storage policies already accepted.
	if v_identity.profile_id is null or v_identity.sha256 is null or v_identity.bytes is null then
		return new;
	end if;
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes)
	values (v_identity.profile_id, v_identity.sha256, v_identity.bytes)
	on conflict (profile_id, sha256) do update set bytes = excluded.bytes;
	return new;
end
$$;

revoke all on function public.qorpera_mirror_profile_object() from public;

create trigger qorpera_mirror_profile_object
after insert or update or delete on storage.objects
for each row execute function public.qorpera_mirror_profile_object();

-- Adopt whatever already exists so the catalog starts complete.
insert into public.qorpera_profile_objects (profile_id, sha256, bytes)
select identity.profile_id, identity.sha256, identity.bytes
from storage.objects as object
cross join lateral public.qorpera_profile_object_identity(object.bucket_id, object.name, object.metadata) as identity
where identity.profile_id is not null
	and identity.sha256 is not null
	and identity.bytes is not null
on conflict (profile_id, sha256) do update set bytes = excluded.bytes;

-- Equivalence, assertable in CI: rows present on one side only, or disagreeing
-- on size, in either direction. Must be zero for as long as storage.objects
-- remains authoritative.
create function public.qorpera_object_catalog_drift()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
	with live as (
		select identity.profile_id, identity.sha256, identity.bytes
		from storage.objects as object
		cross join lateral
			public.qorpera_profile_object_identity(object.bucket_id, object.name, object.metadata) as identity
		where identity.profile_id is not null
			and identity.sha256 is not null
			and identity.bytes is not null
	)
	select count(*)
	from (
		select profile_id, sha256, bytes from live
		except
		select profile_id, sha256, bytes from public.qorpera_profile_objects
		union all
		select profile_id, sha256, bytes from public.qorpera_profile_objects
		except
		select profile_id, sha256, bytes from live
	) as divergence
$$;

revoke all on function public.qorpera_object_catalog_drift() from public;
