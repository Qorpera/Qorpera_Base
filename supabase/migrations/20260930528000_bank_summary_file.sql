-- The company bank connection, part 3 (Bank interface): the object gateway writes each company's bank summary to its
-- company folder as bank/summary.json, the file the Bank page draws (packages/web/src/app/bank-page.ts). The vault
-- records a summary in qorpera_bank_syncs (20260930523000) and never writes the folder; a summary whose generation the
-- folder does not have yet is due here. The gateway's writer claims one due company at a time (its own short lease),
-- makes bank/ when it is missing, writes the file as the platform under the claim's operation key at the version the
-- claim read, and finishes the claim: written, or a problem code after which the company backs off. A member may move
-- or change the file; the next summary writes it again where the page reads it.

alter table public.qorpera_bank_syncs
	add column written_generation bigint not null default 0 check (written_generation >= 0),
	add column write_lease_owner uuid,
	add column write_lease_until timestamptz,
	add column write_attempts integer not null default 0 check (write_attempts >= 0),
	add column write_not_before timestamptz,
	add column write_problem text check (write_problem is null or write_problem ~ '^[a-z][a-z0-9_]{0,63}$');
create index qorpera_bank_syncs_write_due on public.qorpera_bank_syncs (summary_at)
	where summary_generation > written_generation;

-- One due company's summary, leased to p_worker: the company's bank environment (folder-v2), whether bank/ exists, the
-- file's version now, and the summary. Null when nothing is due.
create function public.qorpera_claim_bank_summary_file(p_worker uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_sync public.qorpera_bank_syncs%rowtype;
	v_profile uuid;
	v_environment uuid;
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
		raise exception 'Bank summary claim is invalid' using errcode = '22023';
	end if;
	select sync.profile_id, secret.environment_id into v_profile, v_environment
	from public.qorpera_bank_syncs as sync
	join public.qorpera_cloud_secrets as secret on secret.id = sync.secret_id
	where sync.summary_generation > sync.written_generation
		and (sync.write_lease_until is null or sync.write_lease_until <= v_now)
		and (sync.write_not_before is null or sync.write_not_before <= v_now)
		and public.qorpera_environment_is_folder_v2(secret.environment_id)
		and not public.qorpera_company_deleting(sync.profile_id)
	order by sync.summary_at, sync.profile_id
	limit 1
	for update of sync skip locked;
	if v_profile is null then
		return null;
	end if;
	update public.qorpera_bank_syncs
	set write_lease_owner = p_worker, write_lease_until = v_now + make_interval(secs => p_lease_seconds),
		write_attempts = write_attempts + 1
	where profile_id = v_profile
	returning * into v_sync;
	return jsonb_build_object(
		'schema', 'qorpera.bank-summary-claim/v1',
		'profileId', v_sync.profile_id,
		'environmentId', v_environment,
		'generation', v_sync.summary_generation,
		'attempt', v_sync.write_attempts,
		'operationKey', 'bank-summary:' || v_sync.profile_id::text || ':' || v_sync.summary_generation::text
			|| ':' || v_sync.write_attempts::text,
		'folderPresent', exists (select 1 from public.qorpera_folder_entries as entry
			where entry.environment_id = v_environment and entry.kind = 'folder'
				and entry.key_sha256 = extensions.digest(public.qorpera_folder_key('bank'), 'sha256')),
		'currentVersion', (select entry.version from public.qorpera_folder_entries as entry
			where entry.environment_id = v_environment and entry.kind = 'file'
				and entry.key_sha256 = extensions.digest(public.qorpera_folder_key('bank/summary.json'), 'sha256')),
		'summary', v_sync.summary,
		'leaseUntil', v_sync.write_lease_until
	);
end
$$;

-- Ends p_worker's claim of a company's summary at p_generation: without a problem the folder has that generation;
-- with one, the company backs off (a minute, doubling to an hour) and a newer summary is still written in its turn.
-- A claim another worker took over since is answered finished false.
create function public.qorpera_finish_bank_summary_file(p_worker uuid, p_profile_id uuid, p_generation bigint,
	p_problem text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_sync public.qorpera_bank_syncs%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_worker is null or p_profile_id is null or p_generation is null
		or (p_problem is not null and p_problem !~ '^[a-z][a-z0-9_]{0,63}$') then
		raise exception 'Bank summary finish is invalid' using errcode = '22023';
	end if;
	select sync.* into v_sync from public.qorpera_bank_syncs as sync where sync.profile_id = p_profile_id for update;
	if v_sync.profile_id is null or v_sync.write_lease_owner is distinct from p_worker then
		return jsonb_build_object('schema', 'qorpera.bank-summary-finish/v1', 'finished', false);
	end if;
	update public.qorpera_bank_syncs
	set write_lease_owner = null, write_lease_until = null,
		written_generation = case when p_problem is null then greatest(written_generation, p_generation)
			else written_generation end,
		write_attempts = case when p_problem is null then 0 else write_attempts end,
		write_problem = p_problem,
		write_not_before = case when p_problem is null then null
			else clock_timestamp() + least(interval '1 minute' * power(2, least(greatest(write_attempts - 1, 0), 6)),
				interval '1 hour') end
	where profile_id = p_profile_id;
	return jsonb_build_object('schema', 'qorpera.bank-summary-finish/v1', 'finished', true);
end
$$;

revoke all on function public.qorpera_claim_bank_summary_file(uuid, integer),
	public.qorpera_finish_bank_summary_file(uuid, uuid, bigint, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_bank_summary_file(uuid, integer),
	public.qorpera_finish_bank_summary_file(uuid, uuid, bigint, text) to service_role;
