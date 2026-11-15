-- 20260930775000: a company machine's data pass (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §9a, slice 8a part 1;
-- Jonas, 14 November 2026: "Yes, build them"). A program on an agent's machine reaches the company's databases with
-- the command `data`, through the machine's one folder view: the node's folder service, which serves that view to
-- that machine only, asks for a data pass as the view and sends the call to the data gateway's run door. No database
-- login and no new secret is in the machine. This migration is the platform's half:
--
-- 1. qorpera_data_passes.kind gains `machine`. Such a pass names its view and the view's machine (the placement), no
--    run and no job.
-- 2. qorpera_data_pass_listing(p_environment_id, p_actor, p_database): what a pass keeps, as the actor may read it
--    now: database.toml and the files directly in tables/, queries/ and actions/ of the database named (or of every
--    database, for null), each with its hash and size, and with the version and authority it was read under. It is
--    qorpera_run_data_pass's own listing (20260930750000), moved here so that a run's pass and a machine's keep the
--    same files; qorpera_run_data_pass answers exactly what it did.
-- 3. qorpera_machine_data_pass(p_environment_id, p_actor, p_database): for the service role (the folder service).
--    p_actor is {"kind":"view", viewId, pass}; the view must be an open, valid test_machine view, which the folder
--    core's own resolution checks (its pass, its placement and boot, the starter's agent and member still reading the
--    root) and refuses while the company's execution is paused (55000), as a run is. It answers the pass and
--    `entries`, each kept file's {path, version, authority}: what the folder service records as the view's reads
--    before an answer that shows rows leaves it (RUNTIME-FOLDER-TEST-MACHINES.md, "Reads").
-- 4. qorpera_data_pass_redeem answers a machine's pass once, within its 60 s, while its view is open and valid and
--    the company's execution is not paused (a machine that keeps running through a pause reads and writes no rows,
--    also with a pass made just before it), with kind `machine`, the view and the machine. A run's pass is answered
--    byte for byte as before (SQL tests 1244, 1262).
--
-- Locks: the table's constraints change under a short lock; the functions read as a folder read does and write only
-- their own new row.

set local lock_timeout = '3s';

-- 1. The passes --------------------------------------------------------------------------------------------------------

do $$
declare v_name text;
begin
	select con.conname into strict v_name from pg_constraint as con
	where con.conrelid = 'public.qorpera_data_passes'::regclass and con.contype = 'c'
		and pg_get_constraintdef(con.oid) ~ 'kind' and pg_get_constraintdef(con.oid) ~ '''run'''
		and pg_get_constraintdef(con.oid) !~ 'machine';
	execute format('alter table public.qorpera_data_passes drop constraint %I', v_name);
end $$;
alter table public.qorpera_data_passes
	alter column run_id drop not null,
	alter column job_id drop not null,
	add column view_id uuid,
	add column machine_id uuid,
	add constraint qorpera_data_passes_kind_check check (kind in ('run', 'machine')),
	add constraint qorpera_data_passes_kind_columns check (
		(kind = 'run' and run_id is not null and job_id is not null and view_id is null and machine_id is null)
		or (kind = 'machine' and run_id is null and job_id is null and view_id is not null and machine_id is not null));

-- 2. What a pass keeps -------------------------------------------------------------------------------------------------

create function public.qorpera_data_pass_listing(p_environment_id uuid, p_actor jsonb, p_database text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_databases text[] := '{}'; v_database text; v_entries jsonb := '[]'::jsonb; v_count integer := 0;
	v_read jsonb; v_page jsonb; v_after text; v_entry jsonb; v_part text; v_name text;
begin
	-- Company databases, slice 8a (20260930775000): what was qorpera_run_data_pass's own listing, for a run's pass and
	-- a machine's alike.
	if p_database is not null then
		v_databases := array[p_database];
	else
		-- Every folder data/<name>/ the actor may list whose name is a database's.
		loop
			v_page := public.qorpera_folder_list(p_environment_id, p_actor, 'data', v_after, 1000, false);
			for v_entry in select e.value from jsonb_array_elements(v_page -> 'entries') e loop
				v_name := regexp_replace(v_entry ->> 'path', '^.*/', '');
				if v_entry ->> 'kind' = 'folder' and v_name ~ '^[a-z][a-z0-9_]{0,39}$' and v_name <> 'qorpera'
						and v_name !~ '^(pg_|qorpera_)' then
					v_databases := v_databases || v_name; end if;
			end loop;
			-- A bound on the looking alone: a folder without a database.toml keeps nothing, so the cap on files kept is
			-- checked as files are kept, below.
			if cardinality(v_databases) > 5000 then
				raise exception 'Data pass would look through more than 5,000 folders under data/' using errcode = '54000'; end if;
			v_after := v_page ->> 'next';
			exit when v_after is null;
		end loop;
	end if;

	foreach v_database in array v_databases loop
		-- A database exists when its database.toml does; a folder without one the actor may read keeps nothing.
		v_read := public.qorpera_folder_read(p_environment_id, p_actor, 'data/' || v_database || '/database.toml');
		continue when v_read ->> 'found' is distinct from 'true' or v_read #>> '{entry,kind}' is distinct from 'file';
		v_entries := v_entries || jsonb_build_array(jsonb_build_object('path', 'data/' || v_database || '/database.toml',
			'sha256', v_read #>> '{entry,fileSha256}', 'bytes', (v_read #>> '{entry,bytes}')::bigint,
			'version', v_read #> '{entry,version}', 'authority', v_read #> '{entry,authority}'));
		v_count := v_count + 1;
		-- Checked as each file is kept, so the listings below always ask for at least one.
		if v_count > 1000 then
			raise exception 'Data pass would keep more than 1,000 files' using errcode = '54000'; end if;
		foreach v_part in array array['tables', 'queries', 'actions'] loop
			v_after := null;
			loop
				v_page := public.qorpera_folder_list(p_environment_id, p_actor, 'data/' || v_database || '/' || v_part,
					v_after, least(1000, 1001 - v_count), false);
				for v_entry in select e.value from jsonb_array_elements(v_page -> 'entries') e
					where e.value ->> 'kind' = 'file' loop
					v_entries := v_entries || jsonb_build_array(jsonb_build_object(
						'path', 'data/' || v_database || '/' || v_part || '/' || regexp_replace(v_entry ->> 'path', '^.*/', ''),
						'sha256', v_entry ->> 'fileSha256', 'bytes', (v_entry ->> 'bytes')::bigint,
						'version', v_entry -> 'version', 'authority', v_entry -> 'authority'));
					v_count := v_count + 1;
				end loop;
				if v_count > 1000 then
					raise exception 'Data pass would keep more than 1,000 files' using errcode = '54000'; end if;
				v_after := v_page ->> 'next';
				exit when v_after is null;
			end loop;
		end loop;
	end loop;
	-- A database named that is not there, and one the actor may not read: no pass, the same answer for both.
	if p_database is not null and v_count = 0 then
		raise exception 'Data pass has no such database' using errcode = 'P0002'; end if;
	return v_entries;
end $$;

-- The files a pass row keeps: each entry's path, hash and size, in the listing's order.
create function public.qorpera_data_pass_files(p_entries jsonb) returns jsonb language sql immutable
set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('path', e.value ->> 'path', 'sha256', e.value ->> 'sha256',
		'bytes', (e.value ->> 'bytes')::bigint) order by e.ordinality), '[]'::jsonb)
	from jsonb_array_elements(p_entries) with ordinality as e
$$;

-- 3. A run's pass, on the shared listing; a machine's pass -------------------------------------------------------------

create or replace function public.qorpera_run_data_pass(p_environment_id uuid, p_actor jsonb, p_database text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_auth jsonb; v_entries jsonb; v_pass text; v_expires timestamptz;
begin
	-- Company databases, slice 5 (20260930750000); its listing is qorpera_data_pass_listing since 20260930775000.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'A data pass is for a run' using errcode = '22023'; end if;
	if p_database is not null and (p_database !~ '^[a-z][a-z0-9_]{0,39}$' or p_database = 'qorpera'
			or p_database ~ '^(pg_|qorpera_)') then
		raise exception 'Database name is invalid' using errcode = '22023'; end if;
	-- The run as a read resolves it, with plain reads: its job leased to it, its requester a member, its agent active.
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth ->> 'runId' is null or v_auth ->> 'jobId' is null then
		raise exception 'A data pass is for a run' using errcode = '22023'; end if;
	v_entries := public.qorpera_data_pass_listing(p_environment_id, p_actor, p_database);
	v_pass := public.qorpera_folder_view_new_pass();
	insert into public.qorpera_data_passes(pass_sha256, kind, environment_id, run_id, job_id, staff_agent_id,
		requester_user_id, database, files, expires_at)
	values (extensions.digest(v_pass, 'sha256'), 'run', p_environment_id, (v_auth ->> 'runId')::uuid,
		(v_auth ->> 'jobId')::uuid, (v_auth ->> 'staffAgentId')::uuid, (v_auth ->> 'requesterUserId')::uuid, p_database,
		public.qorpera_data_pass_files(v_entries), clock_timestamp() + interval '60 seconds')
	returning expires_at into v_expires;
	return jsonb_build_object('schema', 'qorpera.data-pass/v1', 'pass', v_pass, 'expiresAt', v_expires,
		'files', jsonb_array_length(v_entries));
end $$;

create function public.qorpera_machine_data_pass(p_environment_id uuid, p_actor jsonb, p_database text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_auth jsonb; v_view public.qorpera_folder_views%rowtype; v_entries jsonb; v_pass text; v_expires timestamptz;
begin
	-- Company databases, slice 8a (20260930775000)
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'view' then
		raise exception 'A machine''s data pass is for a view' using errcode = '22023'; end if;
	if p_database is not null and (p_database !~ '^[a-z][a-z0-9_]{0,39}$' or p_database = 'qorpera'
			or p_database ~ '^(pg_|qorpera_)') then
		raise exception 'Database name is invalid' using errcode = '22023'; end if;
	-- The view as a read resolves it: its pass, its placement and boot, the starter's agent and member still reading
	-- the root; refused while the company's execution is paused, as a run is.
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth #>> '{view,kind}' is distinct from 'test_machine' or v_auth ->> 'kind' is distinct from 'staff_agent' then
		raise exception 'A machine''s data pass is for a company machine''s view' using errcode = '22023'; end if;
	select view.* into strict v_view from public.qorpera_folder_views as view where view.id = (v_auth #>> '{view,id}')::uuid;
	if v_view.state <> 'open' or v_view.machine_id is null then
		raise exception 'Folder view has ended' using errcode = '42501'; end if;
	v_entries := public.qorpera_data_pass_listing(p_environment_id, p_actor, p_database);
	v_pass := public.qorpera_folder_view_new_pass();
	insert into public.qorpera_data_passes(pass_sha256, kind, environment_id, view_id, machine_id, staff_agent_id,
		requester_user_id, database, files, expires_at)
	values (extensions.digest(v_pass, 'sha256'), 'machine', p_environment_id, v_view.id, v_view.machine_id,
		(v_auth ->> 'staffAgentId')::uuid, (v_auth ->> 'requesterUserId')::uuid, p_database,
		public.qorpera_data_pass_files(v_entries), clock_timestamp() + interval '60 seconds')
	returning expires_at into v_expires;
	return jsonb_build_object('schema', 'qorpera.machine-data-pass/v1', 'pass', v_pass, 'expiresAt', v_expires,
		'files', jsonb_array_length(v_entries),
		'entries', coalesce((select jsonb_agg(jsonb_build_object('path', e.value ->> 'path', 'version', e.value -> 'version',
			'authority', e.value -> 'authority') order by e.ordinality)
			from jsonb_array_elements(v_entries) with ordinality as e), '[]'::jsonb));
end $$;

-- 4. The gateway's redeem ----------------------------------------------------------------------------------------------

create or replace function public.qorpera_data_pass_redeem(p_pass text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_data_passes%rowtype;
begin
	-- Company databases, slice 5 (20260930750000): once, within its 60 s, while its run's job is leased. Slice 7
	-- (20260930764000): with the held step a member said yes to, when the pass was made for one. Slice 8a
	-- (20260930775000): a machine's pass, while its view is open and valid and the company's execution is not paused.
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
	update public.qorpera_data_passes set redeemed_at = clock_timestamp()
	where pass_sha256 = extensions.digest(p_pass, 'sha256') and redeemed_at is null and expires_at > clock_timestamp()
	returning * into v_row;
	if not found then return null; end if;
	if v_row.kind = 'machine' then
		if not exists (select 1 from public.qorpera_folder_views as view where view.id = v_row.view_id
				and view.state = 'open' and view.machine_id = v_row.machine_id and public.qorpera_folder_view_valid(view)
				and not exists (select 1 from public.qorpera_company_execution_pauses as pause
					where pause.profile_id = view.profile_id)) then
			return null; end if;
		return jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', 'machine',
			'environmentId', v_row.environment_id, 'viewId', v_row.view_id, 'machineId', v_row.machine_id,
			'staffAgentId', v_row.staff_agent_id, 'requesterUserId', v_row.requester_user_id, 'database', v_row.database,
			'files', v_row.files);
	end if;
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = v_row.job_id and j.run_id = v_row.run_id
			and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) then
		return null; end if;
	return jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', v_row.kind,
		'environmentId', v_row.environment_id, 'runId', v_row.run_id, 'staffAgentId', v_row.staff_agent_id,
		'requesterUserId', v_row.requester_user_id, 'database', v_row.database, 'files', v_row.files)
		|| case when v_row.allow is null then '{}'::jsonb else jsonb_build_object('allow', v_row.allow) end;
end $$;

-- 5. Grants ------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_data_pass_listing(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_data_pass_files(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_machine_data_pass(uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_machine_data_pass(uuid, jsonb, text) to service_role;
