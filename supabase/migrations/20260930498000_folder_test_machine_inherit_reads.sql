-- A test machine's output takes in its reads: F3 step 6, slice 6d-3b (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md,
-- "Reads", rules 3 and 5). Before what a command on a test machine printed, or how it ended, reaches a run, that run
-- takes in the reads of the machine's view (qorpera_folder_run_inherit_view_reads, C1b-3 §6), as an office command's
-- output does (20260930491000). The machine executor holds no run actor, so this wrapper builds it, for the run whose
-- authorized read or cancel (qorpera_authorize_machine_command) gets the output.
-- - The placement is a test machine's, neither retired nor removed, and on the boot the executor read the output on.
--   Otherwise "Folder inheritance read is not current" (42501).
-- - The view is the placement's newest: a test machine's open carries the read set of the placement's newest view
--   (20260930420000), so the newest holds every read the disk was served. A placement that never had a view has none
--   to take in, and answers so (viewId null, reads 0).
-- - The run is in the machine's environment and its job is leased: the actor is the run's (as a command view's live
--   run, 20260928539120). Otherwise "Run is unavailable" (42501).
-- - The take-in is inherit_view_reads' own, idempotent per inherit id (the executor's, one per read). Each take-in
--   checks the view's whole read set for the run, and copies only what the run has not taken in yet (part 2). It
--   refuses the pause (55000) and a run without the company-wide view (20260930480000). A read the run can no longer
--   read ("A released read is no longer readable", "A read is no longer readable") comes back with the detail
--   "qorpera.test-machine/unreadable": the executor holds the output back and retires the placement (rule 5).
-- The caller is the machine executor (service role) only.
--
-- 2. The take-in copies only what is new (on top of 20260928279470, 20260930446000 and 20260930480000; body marker
-- "20260930498000"). The executor takes in at every read of output, each with a new inherit id. Copying the view's
-- whole read set each time grew the run's records by (reads of output) × (size of the set), and the run's recheck scans
-- every copy (P24b). Now:
-- - The whole set is still checked for the run and its pairs written to the run's read set, as before: a read the run
--   can no longer read refuses the take-in, also when the run took it in earlier (rule 5).
-- - The run's records get only the view's records this run has not taken in. Each one taken in is marked per run and
--   view (qorpera_folder_run_inherited_records, with the inherit id that filed it). The marks come from the records
--   the check read, in one statement, so a release that lands meanwhile is neither marked nor filed: the next take-in
--   gets it. A new view (a reboot) carries the disk's reads as records of its own, so a run takes those in once per view.
-- - The result is unchanged: "reads" counts the whole set.
-- - Locks: the marks go in after the read-set writer (rank 10), in key order, "on conflict do nothing". Only take-ins
--   write them, so a take-in waits there only for another take-in of the same run and view, which marks in the same
--   order. Their environment key holds the clock row KEY SHARE, as the take-in's inheritance row already does.
-- This holds for every take-in, the office's (20260930491000) included.
set local lock_timeout = '3s';

-- 1. The wrapper ---------------------------------------------------------------------------------------------------

create function public.qorpera_folder_test_machine_inherit_reads(p_placement_id uuid, p_boot_id uuid, p_run_id uuid,
	p_inherit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_view uuid; v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_placement_id is null or p_boot_id is null or p_run_id is null or p_inherit_id is null then
		raise exception 'Folder inheritance is invalid' using errcode = '22023'; end if;
	select * into v_placement from public.qorpera_company_machine_placements where id = p_placement_id;
	select * into v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	-- coalesce: a missing row must refuse, not compare to null.
	if not coalesce(v_machine.id is not null and v_placement.retired_at is null and v_placement.removed_at is null
			and v_placement.boot_id = p_boot_id, false) then
		raise exception 'Folder inheritance read is not current' using errcode = '42501'; end if;
	select v.id into v_view from public.qorpera_folder_views v
	where v.kind = 'test_machine' and v.placement_id = v_placement.id and v.environment_id = v_machine.environment_id
	order by v.created_at desc, v.id desc limit 1;
	select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
	into v_actor
	from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
	where r.id = p_run_id and r.environment_id = v_machine.environment_id and j.status = 'leased'
		and j.lease_expires_at > clock_timestamp();
	if v_actor is null then raise exception 'Run is unavailable' using errcode = '42501'; end if;
	if v_view is null then
		return jsonb_build_object('schema','qorpera.folder-inherit/v1','inheritId',p_inherit_id,'viewId',null,'reads',0,
			'replay',false);
	end if;
	begin
		return public.qorpera_folder_run_inherit_view_reads(v_machine.environment_id, v_actor, v_view, p_inherit_id);
	exception when insufficient_privilege then
		if sqlerrm in ('A released read is no longer readable', 'A read is no longer readable') then
			raise exception '%', sqlerrm using errcode = '42501', detail = 'qorpera.test-machine/unreadable'; end if;
		raise;
	end;
end $$;

revoke all on function public.qorpera_folder_test_machine_inherit_reads(uuid, uuid, uuid, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_test_machine_inherit_reads(uuid, uuid, uuid, uuid) to service_role;

-- Its owner (this migration's role) reaches what it reads and the take-in, which may have a private owner.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
	where oid = 'public.qorpera_folder_test_machine_inherit_reads(uuid,uuid,uuid,uuid)'::regprocedure;
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'Test machine inherit function has an API owner'; end if;
	if not has_function_privilege(v_owner, 'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)', 'execute')
		or exists (select 1 from unnest(array['public.qorpera_company_machine_placements',
			'public.qorpera_company_machines', 'public.qorpera_folder_views', 'public.qorpera_execution_runs',
			'public.qorpera_runner_jobs']) t(name)
			where not has_table_privilege(v_owner, t.name, 'select')) then
		raise exception 'Test machine inherit function owner cannot reach the take-in'; end if;
end $$;

-- 2. The take-in copies only what is new -----------------------------------------------------------------------------

do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure),
		'20260930498000') > 0 then
		raise exception 'The take-in''s new-only copy (20260930498000) is already applied'; end if;
end $$;

-- A view's read records a run has taken in: one row per record, with the inherit id that filed it.
create table public.qorpera_folder_run_inherited_records (
	run_id uuid not null,
	view_id uuid not null,
	release_id uuid not null,
	resource_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	inherit_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (run_id, view_id, release_id, resource_id)
);
alter table public.qorpera_folder_run_inherited_records enable row level security;
revoke all on public.qorpera_folder_run_inherited_records from public, anon, authenticated, service_role;

-- The patches edit the definition's text in order; the function is replaced once, after the last one.
create temporary table folder_inherit_new_defs (fn regprocedure not null, def text not null);
create function pg_temp.folder_inherit_new_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text;
begin
	select def into v_definition from pg_temp.folder_inherit_new_defs where fn = p_function;
	if v_definition is null then
		v_definition := pg_get_functiondef(p_function);
		insert into pg_temp.folder_inherit_new_defs(fn, def) values (p_function, v_definition);
	end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	update pg_temp.folder_inherit_new_defs set def = replace(v_definition, p_old, p_new) where fn = p_function;
end
$patch$;
create function pg_temp.folder_inherit_new_apply() returns void language plpgsql as $apply$
declare v_fn regprocedure; v_def text; v_context text;
begin
	for v_fn, v_def in select fn, def from pg_temp.folder_inherit_new_defs loop
		begin
			execute v_def;
		exception when others then
			-- A short message: the statement's own text would be the whole function.
			get stacked diagnostics v_context = pg_exception_context;
			raise exception '% does not compile after the patches: % (%)', v_fn, sqlerrm, split_part(v_context, E'\n', 1);
		end;
	end loop;
	drop table pg_temp.folder_inherit_new_defs;
end
$apply$;

select pg_temp.folder_inherit_new_patch('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_reads jsonb; v_pairs jsonb; v_result jsonb;
$old$,
	$new$	v_reads jsonb; v_pairs jsonb; v_result jsonb;
	-- 20260930498000: the view's records; how many of them, and which reads, are new to the run; what is filed.
	v_records jsonb; v_taken bigint; v_fresh jsonb; v_filed jsonb;
$new$);

select pg_temp.folder_inherit_new_patch('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure,
	$old$	select coalesce(jsonb_agg(x), '[]'::jsonb) into v_reads
	from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x where rec.view_id = p_view_id;
	v_pairs := public.qorpera_folder_release_pairs(p_environment_id, v_file.profile_id, v_resolved, v_reads);
	perform public.qorpera_folder_write_read_set(p_environment_id, v_run, v_pairs -> 'upserts', null, null);
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	select v_run, p_inherit_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
		jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), repeat('0', 64)
	from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
$old$,
	$new$	-- 20260930498000: the view's records in one statement, so what is marked below is what was checked.
	select coalesce(jsonb_agg(rec order by rec.release_id, rec.resource_id), '[]'::jsonb) into v_records
	from (select r.release_id, r.resource_id, r.reads from public.qorpera_folder_view_read_records r
		where r.view_id = p_view_id) rec;
	select coalesce(jsonb_agg(x), '[]'::jsonb) into v_reads
	from jsonb_array_elements(v_records) rec, jsonb_array_elements(rec -> 'reads') x;
	v_pairs := public.qorpera_folder_release_pairs(p_environment_id, v_file.profile_id, v_resolved, v_reads);
	perform public.qorpera_folder_write_read_set(p_environment_id, v_run, v_pairs -> 'upserts', null, null);
	-- 20260930498000: the whole set is checked and its pairs written; the records get only the view's records this run
	-- has not taken in. The marks go in key order: a take-in of the same run and view waits on another's marks.
	with taken as (
		insert into public.qorpera_folder_run_inherited_records(run_id, view_id, release_id, resource_id, environment_id,
			inherit_id)
		select v_run, p_view_id, (rec ->> 'release_id')::uuid, (rec ->> 'resource_id')::uuid, p_environment_id, p_inherit_id
		from jsonb_array_elements(v_records) rec order by 3, 4
		on conflict do nothing
		returning release_id, resource_id)
	select (select count(*) from taken), coalesce(jsonb_agg(x), '[]'::jsonb) into v_taken, v_fresh
	from taken t join jsonb_array_elements(v_records) rec
		on (rec ->> 'release_id')::uuid = t.release_id and (rec ->> 'resource_id')::uuid = t.resource_id,
		jsonb_array_elements(rec -> 'reads') x;
	-- The check's filed reads do not name their record: when only some records are new, their reads pass the check
	-- again on their own, so each is filed with its receipt.
	if v_taken = jsonb_array_length(v_records) then
		v_filed := v_pairs -> 'filed';
	elsif v_taken > 0 then
		v_filed := public.qorpera_folder_release_pairs(p_environment_id, v_file.profile_id, v_resolved, v_fresh) -> 'filed';
	else
		v_filed := '[]'::jsonb;
	end if;
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	select v_run, p_inherit_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
		jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), repeat('0', 64)
	from jsonb_array_elements(v_filed) f group by 4;
$new$);
select pg_temp.folder_inherit_new_apply();

-- The take-in may have a private owner in production: it reaches the marks.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
	where oid = 'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure;
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'The take-in has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select, insert on public.qorpera_folder_run_inherited_records to %I', v_owner); end if;
end $$;
