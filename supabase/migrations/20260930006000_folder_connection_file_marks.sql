-- Company folder core C3, P22a: the vault marks a connection file due (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
-- §2 "connections/<name>.md" and §8 "Plan (A1-7)"; the coordinator's audit P22, approved 3 October 2026).
--
-- On a folder-v2 company every company-owned connection of a catalog connector (Gmail, Drive, GitHub …) and every
-- website account has a file connections/<name>.md whose settings only the platform writes. A hook's signing secret and
-- a secret card have none (the event intake describes hooks itself). The vault cannot write it in its own transaction (SQL makes no file bytes,
-- and a refused or retried commit would undo the vault change), so the vault only marks the connection due, and a
-- writer in the object gateway (P22b) brings the file to the vault's current state after the vault commits, as core
-- §3 "After the commit" converges other side effects. The vault stays the authority: every tool that acts reads the
-- vault, never the file; the file trails the vault by seconds.
--
-- * Marks: triggers on the vault's secrets, operation grants and company accounts insert one row into
--   qorpera_folder_connection_file_marks, only for a company-owned secret in a folder-v2 environment, and only when a
--   field the file shows changed. A plain insert with a generated key never waits on another transaction: a vault
--   change takes no lock it can wait on, so the marks add no cycle whatever order the triggers fire in. The only
--   foreign key is the company row's, which every vault change on folder-v2 already holds KEY SHARE (#660's rank 0).
-- * Work: qorpera_folder_connection_file_work, one row per secret ever due (kept, so each claim's generation and
--   operation key is new), touched only by the writers' two functions.
--   qorpera_claim_connection_file never waits for a vault change or a company being deleted: it creates the work rows
--   of marked secrets (in secret order, and only for companies whose row it can key-share at once, so a company held
--   for deletion is skipped; it can briefly wait for another claim's new work rows, in that one order, never in a
--   cycle), takes one due row and the marks it can see with SKIP LOCKED, and answers what the file should say. A writer makes one claim per
--   transaction (one RPC call). Marks committed later stay and make the secret due again, so a change is never lost to a mark that
--   commits out of order. qorpera_finish_connection_file closes the claim (or backs it off with a problem code) only for
--   the writer holding the current generation; a writer whose lease another took is told so.
-- * What the file says is built from an allow-list of fields (id, service, account, status, actions, connected_by,
--   connected_at, and for a website account site, two_step, opened_for): never a secret, an envelope, a key id, a
--   capability, a sign-in host or the vault's own purpose text. A revoked secret or a closed account says "no file".
--   `actions` lists the operations with an active, unexpired grant; a grant's expiry marks nothing, so the file shows
--   it until the connection's next change (the vault refuses the expired grant either way).
-- * qorpera_mark_connection_files(environment) marks every connection of an environment due at once: an operator step,
--   in its own transaction, for a company whose vault held connections before it became folder-v2, or for a connector
--   that gained catalog operations later (only later changes mark them otherwise). The folder core's reset deletes
--   companies, so nothing calls it yet.
--
-- Inert until P22b's writer runs: no folder-v2 company exists yet, and nothing claims.

set local lock_timeout = '3s';

-- 1. Marks ------------------------------------------------------------------------------------------------------------

create table public.qorpera_folder_connection_file_marks (
	id bigint generated always as identity primary key,
	secret_id uuid not null,
	-- The company row, which every vault change on folder-v2 already holds KEY SHARE: so its purge removes the marks.
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_folder_connection_file_marks_secret on public.qorpera_folder_connection_file_marks(secret_id, id);
alter table public.qorpera_folder_connection_file_marks enable row level security;
revoke all on public.qorpera_folder_connection_file_marks from public, anon, authenticated, service_role;

-- 2. The writers' work --------------------------------------------------------------------------------------------------

create table public.qorpera_folder_connection_file_work (
	secret_id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	-- One more per claim: a writer's operation key is connection-file:<secret>:<generation>.
	generation bigint not null default 0 check (generation >= 0),
	-- Marks were consumed by a claim whose file is not yet finished.
	dirty boolean not null default false,
	lease_owner uuid,
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	not_before timestamptz,
	-- A code only (the commit's reason, a writer's own), never a message: nothing from the vault or the file.
	last_problem text check (last_problem ~ '^[a-z][a-z0-9_]{0,63}$'),
	updated_at timestamptz not null default clock_timestamp(),
	check ((lease_owner is null) = (lease_until is null))
);
alter table public.qorpera_folder_connection_file_work enable row level security;
revoke all on public.qorpera_folder_connection_file_work from public, anon, authenticated, service_role;

-- 3. The triggers -------------------------------------------------------------------------------------------------------

-- The connections that have a file: the catalog's connectors (Gmail, Drive, GitHub …) and website accounts. A hook's
-- signing secret (event_hook) and a secret card (vault) are not connections here: the event intake describes its hooks
-- itself (RUNTIME-EVENT-INTAKE.md, connections/hook-<name>.md).
create function public.qorpera_folder_connection_has_file(p_connector_id text)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_connector_id = 'website' or exists (select 1 from public.qorpera_cloud_connector_operations as operation
		where operation.connector_id = p_connector_id)
$$;
revoke all on function public.qorpera_folder_connection_has_file(text) from public, anon, authenticated, service_role;

-- One mark for a company-owned secret in a folder-v2 environment. Plain reads only; never a row lock.
create function public.qorpera_folder_connection_file_mark()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_secret uuid; v_profile uuid; v_environment uuid;
begin
	-- 20260930006000 (P22a): the vault marks a connection file due; a writer converges the file later.
	if tg_table_name = 'qorpera_cloud_secrets' then
		if new.owner_kind <> 'company' or not public.qorpera_folder_connection_has_file(new.connector_id) then
			return null; end if;
		v_secret := new.id; v_profile := new.profile_id; v_environment := new.environment_id;
	else
		v_secret := new.secret_id; v_profile := new.profile_id; v_environment := new.environment_id;
		if not exists (select 1 from public.qorpera_cloud_secrets as secret
			where secret.id = new.secret_id and secret.owner_kind = 'company'
				and public.qorpera_folder_connection_has_file(secret.connector_id)) then return null; end if;
	end if;
	if not public.qorpera_environment_is_folder_v2(v_environment) then return null; end if;
	insert into public.qorpera_folder_connection_file_marks(secret_id, profile_id, environment_id)
	values (v_secret, v_profile, v_environment);
	return null;
end $$;
revoke all on function public.qorpera_folder_connection_file_mark() from public, anon, authenticated, service_role;

create trigger qorpera_folder_connection_file_mark_insert
	after insert on public.qorpera_cloud_secrets
	for each row execute function public.qorpera_folder_connection_file_mark();
create trigger qorpera_folder_connection_file_mark_update
	after update of status, account_label, connector_id, created_by_user_id, created_at on public.qorpera_cloud_secrets
	for each row when (old.status is distinct from new.status or old.account_label is distinct from new.account_label
		or old.connector_id is distinct from new.connector_id or old.created_by_user_id is distinct from new.created_by_user_id
		or old.created_at is distinct from new.created_at)
	execute function public.qorpera_folder_connection_file_mark();

create trigger qorpera_folder_connection_file_mark_insert
	after insert on public.qorpera_cloud_secret_operation_grants
	for each row execute function public.qorpera_folder_connection_file_mark();
create trigger qorpera_folder_connection_file_mark_update
	after update of status, operation_id, secret_id on public.qorpera_cloud_secret_operation_grants
	for each row when (old.status is distinct from new.status or old.operation_id is distinct from new.operation_id
		or old.secret_id is distinct from new.secret_id)
	execute function public.qorpera_folder_connection_file_mark();

create trigger qorpera_folder_connection_file_mark_insert
	after insert on public.qorpera_company_accounts
	for each row execute function public.qorpera_folder_connection_file_mark();
create trigger qorpera_folder_connection_file_mark_update
	after update of status, login, site, two_step, opened_for_todo_id, opened_by_staff_agent_id, opened_by_user_id,
		connected_at, created_at on public.qorpera_company_accounts
	for each row when (old.status is distinct from new.status or old.login is distinct from new.login
		or old.site is distinct from new.site or old.two_step is distinct from new.two_step
		or old.opened_for_todo_id is distinct from new.opened_for_todo_id
		or old.opened_by_staff_agent_id is distinct from new.opened_by_staff_agent_id
		or old.opened_by_user_id is distinct from new.opened_by_user_id
		or old.connected_at is distinct from new.connected_at or old.created_at is distinct from new.created_at)
	execute function public.qorpera_folder_connection_file_mark();

-- 4. What the file should say -------------------------------------------------------------------------------------------

-- An instant in the parser's one form: seconds always, a fraction only when it is not zero, without trailing zeros.
create function public.qorpera_company_state_instant_text(p_at timestamptz)
returns text language sql immutable set search_path = '' as $$
	select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
		|| coalesce('.' || nullif(rtrim(to_char(p_at at time zone 'UTC', 'US'), '0'), ''), '') || 'Z'
$$;
revoke all on function public.qorpera_company_state_instant_text(timestamptz) from public, anon, authenticated, service_role;

-- The file a connection should have, from the vault's current rows (plain reads): `present` false for a revoked secret,
-- a closed or missing website account, a member's own secret or one outside folder-v2; otherwise the settings, by an
-- allow-list, and `path`, the name a new file takes. `current` is the file the connection index points at, if any.
create function public.qorpera_folder_connection_file_state(p_secret_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	-- Row types, so a missing row (or a connection with no account row) reads as nulls.
	v_secret public.qorpera_cloud_secrets%rowtype; v_account public.qorpera_company_accounts%rowtype;
	v_settings jsonb; v_name text; v_path text; v_current jsonb; v_present boolean;
begin
	-- 20260930006000 (P22a): the allow-list of a connection file's settings; nothing else of the vault's rows leaves.
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret where secret.id = p_secret_id;
	if v_secret.id is not null and v_secret.connector_id = 'website' then
		select account.* into v_account from public.qorpera_company_accounts as account where account.secret_id = p_secret_id;
	end if;
	v_present := v_secret.id is not null and v_secret.owner_kind = 'company' and v_secret.status = 'active'
		and public.qorpera_folder_connection_has_file(v_secret.connector_id)
		and public.qorpera_environment_is_folder_v2(v_secret.environment_id)
		and (v_secret.connector_id <> 'website' or (v_account.site is not null and v_account.status <> 'closed'));
	if v_present then
		v_settings := jsonb_build_object(
			'id', v_secret.id,
			'service', v_secret.connector_id,
			'account', case when v_secret.connector_id = 'website' then v_account.login
				else coalesce(v_secret.account_label, v_secret.secret_name) end,
			'status', case when v_secret.connector_id = 'website' then v_account.status else 'connected' end,
			'actions', (select coalesce(jsonb_agg(op.operation_id order by op.operation_id collate "C"), '[]'::jsonb)
				from (select distinct grant_row.operation_id from public.qorpera_cloud_secret_operation_grants as grant_row
					where grant_row.secret_id = p_secret_id and grant_row.status = 'active'
						and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())) as op),
			'connectedBy', case when v_secret.connector_id = 'website'
				then coalesce(v_account.opened_by_staff_agent_id, v_account.opened_by_user_id) else v_secret.created_by_user_id end,
			'connectedAt', public.qorpera_company_state_instant_text(case when v_secret.connector_id = 'website'
				then coalesce(v_account.connected_at, v_account.created_at) else v_secret.created_at end))
			|| case when v_secret.connector_id = 'website' then jsonb_build_object('site', v_account.site,
				'twoStep', v_account.two_step, 'openedFor', v_account.opened_for_todo_id) else '{}'::jsonb end;
		-- A new file's name: the site, or the connector (and the vault's name unless it is primary), in the folder's name
		-- rule (lowercase letters, digits and single hyphens, at most 64 characters). The writer adds -2, -3 … when the
		-- commit answers that the name is taken.
		v_name := btrim(regexp_replace(case when v_secret.connector_id = 'website' then v_account.site
			when v_secret.secret_name = 'primary' then v_secret.connector_id
			else v_secret.connector_id || '-' || v_secret.secret_name end, '[^a-z0-9]+', '-', 'g'), '-');
		v_name := coalesce(nullif(rtrim(left(v_name, 64), '-'), ''), 'connection');
		v_path := 'connections/' || v_name || '.md';
	end if;
	select jsonb_build_object('path', entry.path, 'version', entry.version, 'manifestSha256', entry.manifest_sha256,
		'fileSha256', entry.file_sha256, 'bytes', entry.bytes, 'mediaType', entry.media_type)
	into v_current
	from public.qorpera_folder_connection_index as index_row
	join public.qorpera_folder_entries as entry on entry.environment_id = index_row.environment_id
		and entry.key_sha256 = extensions.digest(public.qorpera_folder_key(index_row.folder_path), 'sha256')
		and entry.kind = 'file'
	where index_row.secret_id = p_secret_id and index_row.retired_at is null;
	return jsonb_build_object('present', coalesce(v_present, false), 'settings', v_settings, 'path', v_path,
		'current', v_current);
end $$;
revoke all on function public.qorpera_folder_connection_file_state(uuid) from public, anon, authenticated, service_role;

-- 5. Claim and finish (service_role: the object gateway's writer) ------------------------------------------------------

-- Takes one due connection for p_lease_seconds: a secret with marks, or one whose last claim was not finished and whose
-- lease and back-off have passed. Null when nothing is due.
create function public.qorpera_claim_connection_file(p_worker uuid, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_work public.qorpera_folder_connection_file_work%rowtype; v_consumed bigint;
begin
	-- 20260930006000 (P22a): a claim never waits for a vault change or a company being deleted. It locks only work rows,
	-- the marks it consumes and the key share of the companies it creates work rows for, each SKIP LOCKED (only another
	-- claim's new work rows can make it wait, briefly, in secret order); the vault is read plainly.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
		raise exception 'Connection file claim is invalid' using errcode = '22023'; end if;
	-- A marked secret with no work row yet gets one, in secret order (two claims may wait for each other's new rows only
	-- in that one order, never in a cycle), and only when its company's row can be key-shared at once: the insert's key
	-- check needs it, and a company held for deletion is skipped until its purge ends, so no claim waits behind one. An
	-- existing work row is left alone (an insert that met it would wait for a writer holding it).
	insert into public.qorpera_folder_connection_file_work(secret_id, profile_id, environment_id)
	select distinct on (mark.secret_id) mark.secret_id, mark.profile_id, mark.environment_id
	from public.qorpera_folder_connection_file_marks as mark
	where not exists (select 1 from public.qorpera_folder_connection_file_work as work where work.secret_id = mark.secret_id)
		and mark.profile_id in (select company.id from public.qorpera_profiles as company
			where company.id in (select pending.profile_id from public.qorpera_folder_connection_file_marks as pending
				where not exists (select 1 from public.qorpera_folder_connection_file_work as work
					where work.secret_id = pending.secret_id))
			for key share skip locked)
	order by mark.secret_id
	on conflict (secret_id) do nothing;
	select work.* into v_work from public.qorpera_folder_connection_file_work as work
	where (work.dirty or exists (select 1 from public.qorpera_folder_connection_file_marks as mark
			where mark.secret_id = work.secret_id))
		and (work.lease_until is null or work.lease_until < clock_timestamp())
		and (work.not_before is null or work.not_before <= clock_timestamp())
	order by coalesce((select min(mark.created_at) from public.qorpera_folder_connection_file_marks as mark
		where mark.secret_id = work.secret_id), work.updated_at), work.secret_id
	limit 1
	for update skip locked;
	if v_work.secret_id is null then return null; end if;
	-- The marks this statement sees are covered by the state read below (their transactions committed); a mark that
	-- commits later stays and makes the secret due again. A mark another transaction holds (a purge) is skipped.
	delete from public.qorpera_folder_connection_file_marks where id in (
		select mark.id from public.qorpera_folder_connection_file_marks as mark where mark.secret_id = v_work.secret_id
		for update skip locked);
	get diagnostics v_consumed = row_count;
	update public.qorpera_folder_connection_file_work
	set generation = generation + 1, dirty = true, lease_owner = p_worker,
		lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), attempts = attempts + 1,
		updated_at = clock_timestamp()
	where secret_id = v_work.secret_id
	returning * into v_work;
	return jsonb_build_object('schema', 'qorpera.connection-file-claim/v1', 'secretId', v_work.secret_id,
		'environmentId', v_work.environment_id, 'generation', v_work.generation, 'attempt', v_work.attempts,
		'operationKey', 'connection-file:' || v_work.secret_id || ':' || v_work.generation,
		'leaseUntil', v_work.lease_until, 'marks', v_consumed)
		|| public.qorpera_folder_connection_file_state(v_work.secret_id);
end $$;
revoke all on function public.qorpera_claim_connection_file(uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_claim_connection_file(uuid, integer) to service_role;

-- Closes a claim: p_problem null means the file now matches the claim's state (written, deleted, or already so).
-- Otherwise p_problem is a code and the claim backs off (2^attempts seconds, at most ten minutes). Only the writer of
-- the current generation finishes; `finished` false tells a writer whose lease another took.
create function public.qorpera_finish_connection_file(p_worker uuid, p_secret_id uuid, p_generation bigint,
	p_problem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_work public.qorpera_folder_connection_file_work%rowtype;
begin
	-- 20260930006000 (P22a): only the work row is locked.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_secret_id is null or p_generation is null
		or (p_problem is not null and p_problem !~ '^[a-z][a-z0-9_]{0,63}$') then
		raise exception 'Connection file finish is invalid' using errcode = '22023'; end if;
	select work.* into v_work from public.qorpera_folder_connection_file_work as work
	where work.secret_id = p_secret_id for update;
	if v_work.secret_id is null or v_work.lease_owner is distinct from p_worker or v_work.generation <> p_generation then
		return jsonb_build_object('schema', 'qorpera.connection-file-finish/v1', 'finished', false);
	end if;
	if p_problem is not null then
		update public.qorpera_folder_connection_file_work
		set lease_owner = null, lease_until = null, last_problem = p_problem,
			not_before = clock_timestamp() + least(make_interval(secs => power(2, least(attempts, 10))::integer),
				interval '10 minutes'),
			updated_at = clock_timestamp()
		where secret_id = p_secret_id;
	else
		-- The row stays, so the next claim's generation (its operation key) is new: a reused key would replay.
		update public.qorpera_folder_connection_file_work
		set dirty = false, lease_owner = null, lease_until = null, attempts = 0, not_before = null, last_problem = null,
			updated_at = clock_timestamp()
		where secret_id = p_secret_id;
	end if;
	return jsonb_build_object('schema', 'qorpera.connection-file-finish/v1', 'finished', true);
end $$;
revoke all on function public.qorpera_finish_connection_file(uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.qorpera_finish_connection_file(uuid, uuid, bigint, text) to service_role;

-- 6. Every connection due at once ----------------------------------------------------------------------------------------

-- Marks every connection of a folder-v2 environment that has a file: an operator step, in its own transaction (its
-- inserts can wait behind a company being deleted), for a company whose vault held connections before it became
-- folder-v2, or a connector that gained catalog operations later. Service role; returns the count.
create function public.qorpera_mark_connection_files(p_environment_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
	-- 20260930006000 (P22a): plain inserts, as the triggers'.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_environment_id is null or not public.qorpera_environment_is_folder_v2(p_environment_id) then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_folder_connection_file_marks(secret_id, profile_id, environment_id)
	select secret.id, secret.profile_id, secret.environment_id from public.qorpera_cloud_secrets as secret
	where secret.environment_id = p_environment_id and secret.owner_kind = 'company' and secret.status = 'active'
		and public.qorpera_folder_connection_has_file(secret.connector_id)
	order by secret.id;
	get diagnostics v_count = row_count;
	return v_count;
end $$;
revoke all on function public.qorpera_mark_connection_files(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_mark_connection_files(uuid) to service_role;
