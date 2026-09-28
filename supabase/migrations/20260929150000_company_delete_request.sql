-- Delete company, step D1 (Jonas, 28 Sep 2026: "yes" to option 2). Deleting a company no longer
-- deletes its rows in the member's request. It asks for the deletion:
-- * The company disappears at once: qorpera_member_role answers no role, so every check built on it
--   (row security, storage, presence, team info, leave, delete, invitations) treats it as gone, and the
--   company list leaves it out. Open clients learn it through the member's access state, which turns
--   'revoked'.
-- * All its work stops in the same transaction: the company is paused (and stays paused), its queued
--   and running jobs end as failed ("Company deleted"), company setup stops, coding sessions are
--   archived, coding executors are switched off and coding machines are asked to retire, pending
--   invitations are withdrawn. Its Company Computers power off at their provider's next idle check.
-- * qorpera_finish_company_deletions, run by an operator's pg_cron every minute, stops any work that
--   still appeared and runs qorpera_purge_company (20260929120000) once the nodes hold nothing of the
--   company: no machine that is not released, no sign-in identity, no update target. Coding machines
--   and run machines already drain by themselves; Company Computers and sign-in identities wait for
--   steps D3 and D4 and stay hidden and stopped until then.
-- The deletion record keeps only ids and times, with no link to the company, so it outlives the purge.
-- Lock order: the company row and its wake admission fence first, then jobs (skipping any a runtime call
-- holds: those lock the job before the fence), workers and machines.

set local lock_timeout = '3s';

create table public.qorpera_company_deletions (
	profile_id uuid primary key,
	requested_by_user_id uuid,
	requested_at timestamptz not null default clock_timestamp(),
	-- Set by the finisher: when it last looked, what still held the company, and when it was purged.
	checked_at timestamptz,
	holdings jsonb,
	last_error text check (last_error is null or char_length(last_error) between 1 and 2000),
	purged_at timestamptz
);
alter table public.qorpera_company_deletions enable row level security;
revoke all on public.qorpera_company_deletions from public, anon, authenticated, service_role;
create index qorpera_company_deletions_open on public.qorpera_company_deletions (requested_at) where purged_at is null;

create function public.qorpera_company_deleting(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id)
$$;
revoke all on function public.qorpera_company_deleting(uuid) from public, anon, authenticated, service_role;

do $guard$
declare
	v_expected constant jsonb := jsonb_build_object(
		'public.qorpera_member_role(uuid)', '51f216fc68716773268308963e644cb5719e73d737f77c758637354a5f5bff6d',
		'public.qorpera_company_execution_paused(uuid)', 'fd11298cef7b4e7be1b1954c32097babeb5d20491defbfb70e7d650fd286a9e5',
		'public.qorpera_list_hosted_profiles()', 'f748bb9e2c8733c1ceacf3217f00c0cc02e05ae5791d17bd167b3fcd92884737',
		'public.qorpera_set_company_execution_pause(uuid,boolean,text)', 'fc0f4af8e530b828ca3ee7f0af6b61dc4390ee4a0e1f84180584a885fc8e7a79',
		'public.qorpera_folder_resume(uuid)', '303b2c492eead0ae888ef36d28c96960bccbcfa067d1bab307872293e1f79eca',
		'public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)', 'd9fd6de273aad70a2db619286de64ba6c836f258e0c7e85eeaabf814594085d6',
		'public.qorpera_delete_hosted_profile(uuid)', 'f1a982b33c53ec6d977a5333060ee446a82a6074edd7155065272f6ce64fea15',
		'public.qorpera_company_founding_seated(uuid)', '5f8ed30298a4176e62d7a6c8f4d952d60cc216eeb58fda10acaf739774abb70d',
		'public.qorpera_list_company_foundings()', '748dbc6de276e167b77e1f9c7e472781adea183ff5d2132b2799546367d8c2aa',
		'public.qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text)', 'cde378dbe202bacf6e3b9830d801a0bbf14f72832cb80008fec453c06b00bcdd');
	v_function text;
begin
	for v_function in select jsonb_object_keys(v_expected) loop
		if encode(extensions.digest(pg_get_functiondef(v_function::regprocedure), 'sha256'), 'hex')
			<> v_expected ->> v_function then
			raise exception 'Reviewed function definition changed: %', v_function;
		end if;
	end loop;
end
$guard$;

-- A company being deleted has no members as far as access is concerned.
create or replace function public.qorpera_member_role(p_profile_id uuid)
returns public.qorpera_profile_role
language sql
stable
security definer
set search_path = ''
as $$
	select member.role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id
		and member.user_id = auth.uid()
		and not exists (select 1 from public.qorpera_company_deletions as deletion
			where deletion.profile_id = p_profile_id)
$$;

-- ...and all its work is stopped, including where the pause row is not read directly.
create or replace function public.qorpera_company_execution_paused(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id)
		or exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id)
$$;

-- The company list leaves out a company being deleted.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_list_hosted_profiles()'::regprocedure);
	v_old text := E'\t\tand not public.qorpera_company_founding_open(profile.id)\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Company list differs';
	end if;
	execute replace(v_definition, v_old, v_old
		|| E'\t\tand not exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = profile.id)\n');
end
$$;

-- A founding table being deleted is gone for its seats too (the lobby checks seats, not member_role),
-- and no identity recovery starts for a company being deleted (it would put state on a node).
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_company_founding_seated(uuid)'::regprocedure);
	v_old text := E'\tselect auth.uid() is not null and exists(';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Founding seat check differs';
	end if;
	execute replace(v_definition, v_old, E'\tselect auth.uid() is not null\n'
		|| E'\t\tand not exists(select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = p_profile_id)\n'
		|| E'\t\tand exists(');
	v_definition := pg_get_functiondef('public.qorpera_list_company_foundings()'::regprocedure);
	v_old := E'\twhere seat.user_id = auth.uid() and public.qorpera_current_email_verified()\n';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Founding list differs';
	end if;
	execute replace(v_definition, v_old, v_old
		|| E'\t\tand not exists(select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = founding.profile_id)\n');
	v_definition := pg_get_functiondef('public.qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text)'::regprocedure);
	v_old := E'\t\traise exception ''recovery requires a current company owner'' using errcode = ''42501''; end if;\n';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Identity recovery request differs';
	end if;
	execute replace(v_definition, v_old, v_old
		|| E'\tif public.qorpera_company_deleting(v_identity.profile_id) then\n'
		|| E'\t\traise exception ''The company is being deleted'' using errcode = ''55000''; end if;\n');
end
$$;

-- Nobody lifts the pause of a company being deleted: several readers check the pause row itself.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_set_company_execution_pause(uuid,boolean,text)'::regprocedure);
	v_old text := E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n\tv_was := public.qorpera_company_execution_paused(p_profile_id);\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Company stop differs';
	end if;
	execute replace(v_definition, v_old,
		E'\tperform public.qorpera_lock_profile_gc_fence(p_profile_id);\n'
		|| E'\tif not p_paused and public.qorpera_company_deleting(p_profile_id) then\n'
		|| E'\t\traise exception ''The company is being deleted'' using errcode = ''55000''; end if;\n'
		|| E'\tv_was := public.qorpera_company_execution_paused(p_profile_id);\n');
	v_definition := pg_get_functiondef('public.qorpera_folder_resume(uuid)'::regprocedure);
	v_old := E'\tif not found then raise exception ''Company folder is unavailable'' using errcode = ''42501''; end if;\n';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Folder resume differs';
	end if;
	execute replace(v_definition, v_old, v_old
		|| E'\tif public.qorpera_company_deleting(p_profile_id) then\n'
		|| E'\t\traise exception ''The company is being deleted'' using errcode = ''55000''; end if;\n');
end
$$;

-- A Company Computer of a company being deleted powers off at its provider's next idle check, whatever
-- its demand and the pause (which otherwise keep it awake). Providers already carry out power_off.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure);
	v_patches constant text[][] := array[
		array[E'\tif not v_provider.preparation_enabled or public.qorpera_company_execution_paused(o.profile_id)\n\t\tor public.qorpera_runtime_office_has_demand(o) then\n',
			E'\tif not v_provider.preparation_enabled or (not public.qorpera_company_deleting(o.profile_id)\n\t\tand (public.qorpera_company_execution_paused(o.profile_id) or public.qorpera_runtime_office_has_demand(o))) then\n'],
		array[E'\telsif p.idle_since is null then\n',
			E'\telsif p.idle_since is null and not public.qorpera_company_deleting(o.profile_id) then\n'],
		array[E'\telsif v_at>=p.idle_since+(case',
			E'\telsif public.qorpera_company_deleting(o.profile_id) or v_at>=p.idle_since+(case']];
	v_index integer;
begin
	for v_index in 1 .. array_length(v_patches, 1) loop
		if (length(v_definition) - length(replace(v_definition, v_patches[v_index][1], ''))) / length(v_patches[v_index][1]) <> 1 then
			raise exception 'Office idle policy differs (%)', v_index;
		end if;
		v_definition := replace(v_definition, v_patches[v_index][1], v_patches[v_index][2]);
	end loop;
	execute v_definition;
end
$$;

-- Stops everything the company still runs or asks for. Idempotent; the finisher repeats it on every
-- pass so work that raced the request stops too. Called with the company fence held.
create function public.qorpera_stop_company_work(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_jobs integer := 0;
	v_workers integer := 0;
	v_machines integer;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_worker_id uuid;
	v_job uuid;
begin
	-- The pause row too, for the readers that check it directly (turn requests, wake work, the folder).
	insert into public.qorpera_company_execution_pauses (profile_id, paused_by_user_id, reason)
	select p_profile_id, deletion.requested_by_user_id, 'Company deleted'
	from public.qorpera_company_deletions as deletion
	where deletion.profile_id = p_profile_id
		and exists (select 1 from auth.users where id = deletion.requested_by_user_id)
	on conflict (profile_id) do nothing;
	if found then
		update public.qorpera_company_wake_admission_fences set revision = revision + 1 where profile_id = p_profile_id;
	end if;

	-- Running and queued work ends. A member did not stop it, so it fails with the stated reason.
	-- Runtime calls lock a job before the company fence; a job one of them holds now is skipped (it
	-- waits for this fence and then sees the pause) and ended by the finisher's next pass.
	for v_job in
		select job.id from public.qorpera_runner_jobs as job
		where job.profile_id = p_profile_id and job.status in ('queued', 'leased')
		order by job.id
		for update skip locked
	loop
		perform public.qorpera_terminalize_runner_attempt(v_job, 'failed', 'Company deleted', false);
		v_jobs := v_jobs + 1;
	end loop;

	update public.qorpera_company_bootstrap_jobs
	set state = 'blocked', lease_owner = null, lease_expires_at = null, last_error = 'Company deleted',
		updated_at = clock_timestamp()
	where profile_id = p_profile_id and state in ('queued', 'leased');

	-- Coding: sessions archived, executors off, machines retired. The executors then sleep, delete
	-- and release each machine (qorpera_list_coding_machines treats a retiring machine as superseded).
	for v_worker_id in
		select worker.id from public.qorpera_runtime_workers as worker
		join public.qorpera_coding_sessions as session on session.worker_id = worker.id and session.archived_at is null
		where worker.profile_id = p_profile_id and worker.species = 'coding'
		order by worker.id
	loop
		-- The coding lock order: its todo, then the worker (qorpera_lock_coding_worker).
		v_worker := public.qorpera_lock_coding_worker(v_worker_id);
		if public.qorpera_archive_coding_worker(v_worker, 'kernel', null, null) then v_workers := v_workers + 1; end if;
	end loop;
	update public.qorpera_coding_executors as executor
	set enabled = false, updated_at = clock_timestamp()
	from public.qorpera_company_environments as environment
	where environment.id = executor.environment_id and environment.profile_id = p_profile_id and executor.enabled;
	update public.qorpera_coding_machines
	set retire_requested_at = clock_timestamp()
	where profile_id = p_profile_id and removed_at is null and retire_requested_at is null;
	get diagnostics v_machines = row_count;

	delete from public.qorpera_profile_invitations where profile_id = p_profile_id;
	delete from public.qorpera_company_founder_seats where profile_id = p_profile_id and state = 'invited';

	-- Open clients of the company drop it now.
	update public.qorpera_profile_access_state
	set status = 'revoked', role = null, version = version + 1, updated_at = statement_timestamp()
	where profile_id = p_profile_id and status = 'active';

	return jsonb_build_object('jobsEnded', v_jobs, 'codingSessionsArchived', v_workers, 'codingMachinesRetired', v_machines);
end
$$;
revoke all on function public.qorpera_stop_company_work(uuid) from public, anon, authenticated, service_role;

-- Records the request and stops the company's work. Callers decide who may ask.
create function public.qorpera_request_company_deletion(p_profile_id uuid, p_requested_by_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if p_profile_id is null then
		raise exception 'company id is required' using errcode = '22023';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	insert into public.qorpera_company_deletions (profile_id, requested_by_user_id)
	values (p_profile_id, p_requested_by_user_id)
	on conflict (profile_id) do nothing;
	if found then
		-- The company counts as paused from now on: admission and effects re-read it after this bump.
		update public.qorpera_company_wake_admission_fences set revision = revision + 1 where profile_id = p_profile_id;
	end if;
	return public.qorpera_stop_company_work(p_profile_id);
end
$$;
revoke all on function public.qorpera_request_company_deletion(uuid, uuid) from public, anon, authenticated, service_role;

-- One pass for one company: stop what still runs, then purge if the nodes hold nothing of it.
-- Returns what it found. Never raises for the company's state: each part runs in its own
-- subtransaction and its error is recorded on the request, so a failed purge keeps what the stop did.
create function public.qorpera_finish_company_deletion(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
	v_deletion public.qorpera_company_deletions%rowtype;
	v_holdings jsonb;
	v_error text;
begin
	select * into v_deletion from public.qorpera_company_deletions where profile_id = p_profile_id;
	if not found then
		raise exception 'No deletion was requested for this company' using errcode = 'P0002';
	end if;
	if v_deletion.purged_at is not null then
		return jsonb_build_object('profileId', p_profile_id, 'state', 'purged', 'purgedAt', v_deletion.purged_at);
	end if;
	if exists (select 1 from public.qorpera_profiles where id = p_profile_id) then
		begin
			perform public.qorpera_lock_profile_gc_fence(p_profile_id);
			perform public.qorpera_stop_company_work(p_profile_id);
			v_holdings := public.qorpera_company_node_holdings(p_profile_id);
		exception when others then
			v_error := left(sqlstate || ': ' || sqlerrm, 2000);
		end;
		if v_error is null and ((v_holdings ->> 'machines')::bigint > 0 or (v_holdings ->> 'identities')::bigint > 0
			or (v_holdings ->> 'node_updates')::bigint > 0) then
			update public.qorpera_company_deletions
			set checked_at = clock_timestamp(), holdings = v_holdings, last_error = null
			where profile_id = p_profile_id;
			return jsonb_build_object('profileId', p_profile_id, 'state', 'waiting', 'holdings', v_holdings);
		end if;
		if v_error is null then
			begin
				perform public.qorpera_purge_company(p_profile_id);
			exception when others then
				v_error := left(sqlstate || ': ' || sqlerrm, 2000);
			end;
		end if;
		if v_error is not null then
			update public.qorpera_company_deletions
			set checked_at = clock_timestamp(), holdings = v_holdings, last_error = v_error
			where profile_id = p_profile_id;
			return jsonb_build_object('profileId', p_profile_id, 'state', 'failed', 'error', v_error);
		end if;
	end if;
	update public.qorpera_company_deletions
	set checked_at = clock_timestamp(), holdings = null, last_error = null, purged_at = clock_timestamp()
	where profile_id = p_profile_id;
	return jsonb_build_object('profileId', p_profile_id, 'state', 'purged');
end
$$;
revoke all on function public.qorpera_finish_company_deletion(uuid) from public, anon, authenticated, service_role;

-- The operator's pg_cron runs this every minute: cron.schedule('qorpera-company-deletions', '* * * * *',
-- 'select public.qorpera_finish_company_deletions()'). One company per call by default, so one slow or
-- cancelled purge holds no other company's locks and rolls back nothing else; companies are taken in
-- random order, so one that keeps failing does not stall the rest. Serialised by an advisory lock.
create function public.qorpera_finish_company_deletions(p_limit integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile uuid;
	v_results jsonb := '[]'::jsonb;
begin
	if p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Invalid company deletion batch' using errcode = '22023';
	end if;
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.company-deletions', 0)) then
		return jsonb_build_object('schema', 'qorpera.company-deletions/v1', 'busy', true, 'companies', '[]'::jsonb);
	end if;
	for v_profile in
		select deletion.profile_id from public.qorpera_company_deletions as deletion
		where deletion.purged_at is null
		order by random()
		limit p_limit
	loop
		v_results := v_results || public.qorpera_finish_company_deletion(v_profile);
	end loop;
	return jsonb_build_object('schema', 'qorpera.company-deletions/v1', 'busy', false, 'companies', v_results);
end
$$;
revoke all on function public.qorpera_finish_company_deletions(integer) from public, anon, authenticated, service_role;

-- Only the last member deletes the company; nobody deletes it while others remain. The company
-- disappears at once and is purged once the nodes hold nothing of it.
create or replace function public.qorpera_delete_hosted_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'deleting a company requires membership' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id;
	if not found then
		raise exception 'deleting a company requires membership' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_profile_members as other
		where other.profile_id = p_profile_id and other.user_id <> v_actor_id) then
		raise exception 'Only the last member can delete the company; everyone else leaves' using errcode = '42501';
	end if;
	perform public.qorpera_request_company_deletion(p_profile_id, v_actor_id);
	return 'true'::jsonb;
end
$$;
