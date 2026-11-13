-- 20260930750000: company databases, slice 5 (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §3 and §6; the lead's
-- SLICE5-AGENTS.md, 13 November 2026). Agents make, change and ask the company's databases with three tools
-- (data_describe, data_apply, data_query), which call the data gateway's run door. The gateway holds no service key and
-- no login to this database, and a run's job lease must not travel to another service, so the platform hands the run a
-- data pass, as it hands a folder view its pass (20260928259230: 32 random bytes, only their sha256 kept).
--
-- 1. qorpera_data_passes: one row a pass. No API role reads it. `kind` is 'run' (the only kind so far).
-- 2. qorpera_run_data_pass(p_environment_id, p_actor, p_database default null): the run's tool calls it through
--    qorpera_native_host_call (scope folder: p_environment_id and p_actor must be that job's run). As the run's actor,
--    with the folder core's own reads and listings, it lists data/<database>/database.toml and the files directly in
--    data/<database>/tables/, queries/ and actions/ (with no name, every folder data/<name>/ whose name is a database's,
--    as the run may list data/), and keeps each file's path, fileSha256 and bytes as the run may read them now, with the
--    environment, the run, its job, its agent, its requester and the name asked. At most 1,000 files kept, else 54000;
--    with no name it looks through at most 5,000 folders under data/, else 54000 with its own words. A
--    database named whose database.toml the run may not read, or that is not there, gets no pass (P0002, the same for
--    both). It answers {schema, pass, expiresAt, files}. A pass lasts 60 s and is redeemed once.
-- 3. qorpera_data_pass_redeem(p_pass): the publishable key alone (anon) may call it, since only knowing the pass opens
--    it. It answers what was kept, once, and marks the pass redeemed. A redeemed, unknown or expired pass, and one whose
--    run's job is no longer leased, answers null: the same for all.
-- 4. The native host's list gains qorpera_run_data_pass (scope folder); qorpera_record_runtime_observation's tool names
--    gain the three tools; the hourly node receipt retention (20260930485000) also deletes passes older than a day.
--
-- Nothing here locks: the pass reads the folder as a read does (qorpera_folder_read_actor's plain checks, then the core's
-- read and list), and writes only its own new row. A redeem updates one row by its key.

set local lock_timeout = '3s';

-- 1. The passes ---------------------------------------------------------------------------------------------------------

create table public.qorpera_data_passes (
	pass_sha256 bytea primary key check (octet_length(pass_sha256) = 32),
	kind text not null default 'run' check (kind in ('run')),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	run_id uuid not null,
	job_id uuid not null,
	staff_agent_id uuid not null,
	requester_user_id uuid not null,
	-- The database the pass was asked for; null: every database the run may read.
	database text check (database ~ '^[a-z][a-z0-9_]{0,39}$'),
	-- [{path, sha256, bytes}] as the run could read them when the pass was made.
	files jsonb not null check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 1000),
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	redeemed_at timestamptz
);
create index qorpera_data_passes_created on public.qorpera_data_passes(created_at);
alter table public.qorpera_data_passes enable row level security;
revoke all on public.qorpera_data_passes from public, anon, authenticated, service_role;

-- 2. The run's pass -----------------------------------------------------------------------------------------------------

create function public.qorpera_run_data_pass(p_environment_id uuid, p_actor jsonb, p_database text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_auth jsonb; v_databases text[] := '{}'; v_database text; v_files jsonb := '[]'::jsonb; v_count integer := 0;
	v_read jsonb; v_page jsonb; v_after text; v_entry jsonb; v_part text; v_name text; v_pass text; v_expires timestamptz;
begin
	-- Company databases, slice 5 (20260930750000)
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

	if p_database is not null then
		v_databases := array[p_database];
	else
		-- Every folder data/<name>/ the run may list whose name is a database's.
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
		-- A database exists when its database.toml does; a folder without one the run may read keeps nothing.
		v_read := public.qorpera_folder_read(p_environment_id, p_actor, 'data/' || v_database || '/database.toml');
		continue when v_read ->> 'found' is distinct from 'true' or v_read #>> '{entry,kind}' is distinct from 'file';
		v_files := v_files || jsonb_build_array(jsonb_build_object('path', 'data/' || v_database || '/database.toml',
			'sha256', v_read #>> '{entry,fileSha256}', 'bytes', (v_read #>> '{entry,bytes}')::bigint));
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
					v_files := v_files || jsonb_build_array(jsonb_build_object(
						'path', 'data/' || v_database || '/' || v_part || '/' || regexp_replace(v_entry ->> 'path', '^.*/', ''),
						'sha256', v_entry ->> 'fileSha256', 'bytes', (v_entry ->> 'bytes')::bigint));
					v_count := v_count + 1;
				end loop;
				if v_count > 1000 then
					raise exception 'Data pass would keep more than 1,000 files' using errcode = '54000'; end if;
				v_after := v_page ->> 'next';
				exit when v_after is null;
			end loop;
		end loop;
	end loop;
	-- A database named that is not there, and one the run may not read: no pass, the same answer for both.
	if p_database is not null and v_count = 0 then
		raise exception 'Data pass has no such database' using errcode = 'P0002'; end if;

	v_pass := public.qorpera_folder_view_new_pass();
	insert into public.qorpera_data_passes(pass_sha256, kind, environment_id, run_id, job_id, staff_agent_id,
		requester_user_id, database, files, expires_at)
	values (extensions.digest(v_pass, 'sha256'), 'run', p_environment_id, (v_auth ->> 'runId')::uuid,
		(v_auth ->> 'jobId')::uuid, (v_auth ->> 'staffAgentId')::uuid, (v_auth ->> 'requesterUserId')::uuid, p_database,
		v_files, clock_timestamp() + interval '60 seconds')
	returning expires_at into v_expires;
	return jsonb_build_object('schema', 'qorpera.data-pass/v1', 'pass', v_pass, 'expiresAt', v_expires, 'files', v_count);
end $$;

-- 3. The gateway's redeem -----------------------------------------------------------------------------------------------

create function public.qorpera_data_pass_redeem(p_pass text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_data_passes%rowtype;
begin
	-- Company databases, slice 5 (20260930750000): once, within its 60 s, while its run's job is leased.
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
	update public.qorpera_data_passes set redeemed_at = clock_timestamp()
	where pass_sha256 = extensions.digest(p_pass, 'sha256') and redeemed_at is null and expires_at > clock_timestamp()
	returning * into v_row;
	if not found then return null; end if;
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = v_row.job_id and j.run_id = v_row.run_id
			and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) then
		return null; end if;
	return jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', v_row.kind,
		'environmentId', v_row.environment_id, 'runId', v_row.run_id, 'staffAgentId', v_row.staff_agent_id,
		'requesterUserId', v_row.requester_user_id, 'database', v_row.database, 'files', v_row.files);
end $$;

-- 4. Grants, the native host's list, the observations' tool names, the retention ----------------------------------------

revoke all on function public.qorpera_run_data_pass(uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_run_data_pass(uuid, jsonb, text) to service_role;
revoke all on function public.qorpera_data_pass_redeem(text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_data_pass_redeem(text) to anon;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_run_data_pass', 'folder');

create function pg_temp.data_pass_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930750000' in v_definition) > 0 then
		raise exception '20260930750000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930750000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.data_pass_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930726000 */'organize_apps',$old$,
	$new$/* 20260930726000 */'organize_apps',/* 20260930750000 */'data_describe','data_apply','data_query',$new$);

-- The passes are kept a day for the record, then deleted by the hourly node receipt retention. A failure here never
-- stops the receipts' retention, and its answer stays as it was.
select pg_temp.data_pass_replace('public.qorpera_run_runtime_node_receipt_retention()'::regprocedure,
	$old$	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-run/v1', 'stopped', v_stopped,$old$,
	$new$	-- Data passes a day old (20260930750000), at most 50,000 a run.
	begin
		delete from public.qorpera_data_passes where ctid = any (array(select p.ctid from public.qorpera_data_passes p
			where p.created_at < clock_timestamp() - interval '1 day' limit 50000));
	exception when others then
		raise warning 'Data passes were not deleted: % (%)', sqlerrm, sqlstate;
	end;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-run/v1', 'stopped', v_stopped,$new$);

drop function pg_temp.data_pass_replace(regprocedure, text, text);

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array['public.qorpera_record_runtime_observation(uuid,jsonb)',
		'public.qorpera_run_runtime_node_receipt_retention()']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930750000') = 0 then
			raise exception '20260930750000 is missing from %', v_function; end if;
	end loop;
end $guard$;
