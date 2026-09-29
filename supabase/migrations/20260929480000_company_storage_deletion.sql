-- Company delete, step D5a (deploy/first-node/RUNTIME-COMPANY-DELETE.md): a deleted company's Supabase
-- Storage objects that its purge would orphan. Company File and folder objects need nothing new: their
-- catalog rows have no link to the company and outlive the purge, and the artifact GC worker removes
-- the objects of a company that no longer exists. Two kinds have no such record:
--   - credential capsules, `qorpera-native-compute-capsules/<capsule>.capsule`, named only by the
--     capsule, whose row goes with the company;
--   - identity recovery backups, `qorpera-identity-recovery/<company>/…`, written by the company's
--     recovery service.
-- The finisher records them right before the purge, in the same subtransaction, so a company is never
-- purged without its record. The ledger has no link to the company. The artifact GC worker claims
-- entries, removes the objects through the Storage API (SQL cannot delete Storage objects), and
-- completes them. A capsule of a vault sign-in (`model-login/…`) has no Storage object.
-- Lock order: the finisher holds the company fence (qorpera_lock_profile_gc_fence).

create table public.qorpera_company_storage_deletions (
	bucket text not null check (bucket in ('qorpera-native-compute-capsules', 'qorpera-identity-recovery')),
	-- A capsule object, or the company's recovery prefix ('<company>/').
	object_path text not null check (
		(bucket = 'qorpera-native-compute-capsules'
			and object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.capsule$')
		or (bucket = 'qorpera-identity-recovery'
			and object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/$')),
	-- The company it came from, as a plain id.
	profile_id uuid not null,
	requested_at timestamptz not null default clock_timestamp(),
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	last_error text check (last_error is null or char_length(last_error) between 1 and 500),
	removed_at timestamptz,
	primary key (bucket, object_path)
);
create index qorpera_company_storage_deletions_open on public.qorpera_company_storage_deletions (requested_at)
	where removed_at is null;
alter table public.qorpera_company_storage_deletions enable row level security;
revoke all on public.qorpera_company_storage_deletions from public, anon, authenticated, service_role;

-- What the company leaves in Storage that no other record names. Internal: the finisher calls it right
-- before the purge.
create function public.qorpera_capture_company_storage(p_profile_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_count integer;
begin
	insert into public.qorpera_company_storage_deletions (bucket, object_path, profile_id)
	select 'qorpera-native-compute-capsules', substring(capsule.encrypted_capsule_reference from 16) || '.capsule', p_profile_id
	from public.qorpera_native_credential_capsules as capsule
	-- Only a reference that names the capsule's own id (as its reader requires): a row can never
	-- point the worker at another company's capsule.
	where capsule.profile_id = p_profile_id
		and capsule.encrypted_capsule_reference = 'native-capsule/' || capsule.id::text
	union
	select 'qorpera-identity-recovery', p_profile_id::text || '/', p_profile_id
	where exists (select 1 from public.qorpera_identity_recovery_authorities where profile_id = p_profile_id)
		or exists (select 1 from public.qorpera_identity_key_backups where profile_id = p_profile_id)
	on conflict do nothing;
	get diagnostics v_count = row_count;
	return v_count;
end
$$;
revoke all on function public.qorpera_capture_company_storage(uuid) from public, anon, authenticated, service_role;

-- The worker takes up to p_limit entries for five minutes.
create function public.qorpera_claim_company_storage_deletions(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_claimed jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Storage cleanup requires the service role' using errcode = '42501';
	end if;
	if p_limit is null or p_limit not between 1 and 100 then
		raise exception 'Invalid storage cleanup limit' using errcode = '22023';
	end if;
	with claimed as (
		update public.qorpera_company_storage_deletions as deletion
		set lease_until = clock_timestamp() + interval '5 minutes', attempts = deletion.attempts + 1
		where (deletion.bucket, deletion.object_path) in (
			select bucket, object_path from public.qorpera_company_storage_deletions
			where removed_at is null and (lease_until is null or lease_until <= clock_timestamp())
			-- Entries that keep failing do not hold up newer ones.
			order by attempts, requested_at, bucket, object_path
			limit p_limit
			for update skip locked)
		returning deletion.bucket, deletion.object_path)
	select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'path', object_path) order by bucket, object_path),
		'[]'::jsonb)
	into v_claimed
	from claimed;
	return v_claimed;
end
$$;
revoke all on function public.qorpera_claim_company_storage_deletions(integer) from public, anon, authenticated;
grant execute on function public.qorpera_claim_company_storage_deletions(integer) to service_role;

-- The worker removed the object (or the prefix is empty), or reports why not. Idempotent.
create function public.qorpera_complete_company_storage_deletion(p_bucket text, p_path text, p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Storage cleanup requires the service role' using errcode = '42501';
	end if;
	if p_error is not null and char_length(p_error) not between 1 and 500 then
		raise exception 'Invalid storage cleanup error' using errcode = '22023';
	end if;
	-- A removed entry stays removed; a late error does not touch it.
	update public.qorpera_company_storage_deletions
	set removed_at = case when p_error is null then coalesce(removed_at, clock_timestamp()) else removed_at end,
		last_error = case when removed_at is not null then last_error when p_error is null then null else p_error end,
		lease_until = null
	where bucket = p_bucket and object_path = p_path;
	if not found then
		raise exception 'Unknown storage cleanup entry' using errcode = 'P0002';
	end if;
	return true;
end
$$;
revoke all on function public.qorpera_complete_company_storage_deletion(text, text, text) from public, anon, authenticated;
grant execute on function public.qorpera_complete_company_storage_deletion(text, text, text) to service_role;

-- The finisher records the company's Storage objects right before the purge, in its subtransaction.
do $guard$
begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_finish_company_deletion(uuid)'::regprocedure), 'sha256'), 'hex')
		<> '8370d365ad8cb35fca3a586beb19ccb5b0bcdbd6311e99b651a813c8ed042acd' then
		raise exception 'Reviewed function definition changed: public.qorpera_finish_company_deletion(uuid)';
	end if;
end
$guard$;
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_finish_company_deletion(uuid)'::regprocedure);
	v_old text := E'\t\t\t\tperform public.qorpera_purge_company(p_profile_id);\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Company deletion finisher differs';
	end if;
	execute replace(v_definition, v_old,
		E'\t\t\t\tperform public.qorpera_capture_company_storage(p_profile_id);\n' || v_old);
end
$$;
