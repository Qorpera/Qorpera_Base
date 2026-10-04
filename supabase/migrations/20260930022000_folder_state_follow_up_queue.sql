-- The follow-up queue, P15a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (P15)"; core §5 "After the
-- commit"). Folder-v2 only.
--
-- 1. Marks and work rows: apply marks an agent when a save hires, archives, reactivates, retires or restores it, and the
--    company on every vision.md write; a pg_cron step (every 2 seconds, one subject a transaction) converges each subject
--    to its current state, never replaying. Service-role writers kick a subject at once.
-- 2. Converging an agent: an active one gets its default grant (with one widening authority journal row, written at
--    the step's top level, never inside a savepoint), the shared connectors, and its first run (the kickoff for a hire,
--    the turn request for every agent once its grant exists); an archived or retired one has its active routines
--    paused (`agent_archived`), its expired flags cleared, its vault grants revoked, its execution authorities deleted
--    and its open sessions closed. Converging the company copies its name to qorpera_profiles (core §3's one named
--    exception: the company row FOR NO KEY UPDATE SKIP LOCKED, at the step's top level, alone in its own transaction).
-- 3. The commit's side: the default grant, connector, secret revocation and routines-stop triggers skip folder-v2
--    companies; the thread trigger leaves pair sessions to the converge; the hook names the thread session at rank 11.
-- 4. Routine firing defers for an archived agent; a routine landing under one is recorded paused (`agent_archived`);
--    a paid resume ends that pause once the agent is active.
-- 5. Creation: the Co-Founder's turn request moves to the converge, and `ready` waits for its subject.

create function pg_temp.p15_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P15 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The pause an agent's archive leaves on its routines (the index's record; the files stay as they are).
set local lock_timeout = '3s';
do $$
declare v_name text;
begin
	select con.conname into v_name from pg_catalog.pg_constraint con
	where con.conrelid = 'public.qorpera_cloud_routines'::regclass and con.contype = 'c'
		and pg_catalog.pg_get_constraintdef(con.oid) like '%pause_reason%authorization_failed%';
	if v_name is null then raise exception 'P15: the routine pause reason check is missing'; end if;
	execute format('alter table public.qorpera_cloud_routines drop constraint %I', v_name);
end $$;
alter table public.qorpera_cloud_routines add constraint qorpera_cloud_routines_pause_reason_check check (pause_reason is null
	or pause_reason in ('agent','member','needs_model_account','authorization_failed','agent_archived'));

-- 2. The queue.
-- A mark: insert-only, written with no lock at all. No foreign key: a cascade from the folder clock would put the deletion
-- purge (which locks each child row after taking the fence) in a cycle with a step that consumed marks before reaching the
-- fence; the step's sweep deletes the marks of environments that no longer exist. The commit's seq is still null during
-- apply, so readers order marks by the joined commit seq. `active`: whether the commit left the agent active. Routine
-- firing writes a mark with no commit when it defers for an archived agent.
create table public.qorpera_folder_follow_up_marks (
	id bigint generated always as identity primary key,
	environment_id uuid not null,
	subject_kind text not null check (subject_kind in ('agent','company')),
	subject_id uuid not null,
	by_user_id uuid,
	commit_id uuid,
	active boolean,
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_folder_follow_up_marks_subject on public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id);
alter table public.qorpera_folder_follow_up_marks enable row level security;
revoke all on public.qorpera_folder_follow_up_marks from public, anon, authenticated, service_role;

-- A work row: one per subject, kept. No foreign key, so nothing that holds the fence ever waits on it; the step deletes
-- the rows of environments that no longer exist.
create table public.qorpera_folder_follow_ups (
	environment_id uuid not null,
	subject_kind text not null check (subject_kind in ('agent','company')),
	subject_id uuid not null,
	profile_id uuid not null,
	dirty boolean not null default true,
	attempts integer not null default 0 check (attempts >= 0),
	not_before timestamptz,
	last_problem text check (last_problem is null or char_length(last_problem) between 1 and 300),
	last_attempt_at timestamptz,
	converged_at timestamptz,
	failing_since timestamptz,
	-- The member whose change made the agent active: the author and payer of its first run.
	hired_by_user_id uuid,
	-- A first run its owner authored because no member was named, or the one named had left: never queued on anyone's
	-- login by the queue, at any later converge either (its author starts it).
	first_run_manual boolean not null default false,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, subject_kind, subject_id)
);
create index qorpera_folder_follow_ups_due on public.qorpera_folder_follow_ups(not_before nulls first, updated_at) where dirty;
alter table public.qorpera_folder_follow_ups enable row level security;
revoke all on public.qorpera_folder_follow_ups from public, anon, authenticated, service_role;

-- 3. The commit's marks (apply): an agent hired, archived, reactivated or restored by a save, an agent retired by a
-- delete, and the company on every vision write (its name is copied by the queue).
select pg_temp.p15_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_h2_rows bigint; v_h2_moved bigint;
begin$old$,
	$new$	v_h2_rows bigint; v_h2_moved bigint;
	v_p15_found boolean; v_p15_status text; v_p15_retired boolean; v_p15_owner_active boolean;
begin$new$);
select pg_temp.p15_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				on conflict (environment_id) do update set name = excluded.name, vision_path_version = excluded.vision_path_version,
					vision_seeded = false, commit_id = excluded.commit_id, updated_at = clock_timestamp();
			elsif v_kind = 'agent' then
				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);$old$,
	$new$				on conflict (environment_id) do update set name = excluded.name, vision_path_version = excluded.vision_path_version,
					vision_seeded = false, commit_id = excluded.commit_id, updated_at = clock_timestamp();
				-- 20260930022000 (P15): the company's name reaches qorpera_profiles through the follow-up queue. Every vision
				-- write marks it: a comparison with the copied name could miss a rename back while a copy is in flight.
				insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id, by_user_id, commit_id)
				values (p_environment_id, 'company', v_profile, v_user, p_commit_id);
			elsif v_kind = 'agent' then
				-- 20260930022000 (P15): the agent's follow-up mark when the save hires, archives, reactivates or restores it.
				select s.employment_status, s.folder_retired_at is not null into v_p15_status, v_p15_retired
				from public.qorpera_profile_staff s where s.profile_id = v_profile and s.staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid;
				v_p15_found := found;
				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
				if not v_p15_found or v_p15_retired or v_p15_status is distinct from v_entry -> 'parse' ->> 'status' then
					insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id, by_user_id, commit_id, active)
					values (p_environment_id, 'agent', (v_entry -> 'parse' ->> 'id')::uuid, v_user, p_commit_id,
						v_entry -> 'parse' ->> 'status' = 'active');
				end if;$new$);
select pg_temp.p15_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			if v_staff.employment_status = 'active' then
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			end if;$old$,
	$new$			if v_staff.employment_status = 'active' then
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			end if;
			-- 20260930022000 (P15): the retired agent's follow-up mark.
			insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id, by_user_id, commit_id, active)
			values (p_environment_id, 'agent', v_staff.staff_agent_id, v_user, p_commit_id, false);$new$);

-- A routine moved under an archived or retired agent never runs: its status and schedule position as the index writer
-- records them.
select pg_temp.p15_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			v_owner := public.qorpera_company_state_routine_owner(p_environment_id, public.qorpera_folder_key(v_new_path));
			v_next := v_routine.current_version; v_waits := false; v_ends_wait := false;$old$,
	$new$			v_owner := public.qorpera_company_state_routine_owner(p_environment_id, public.qorpera_folder_key(v_new_path));
			v_next := v_routine.current_version; v_waits := false; v_ends_wait := false;
			-- 20260930022000 (P15): whether the routine's new agent is active.
			v_p15_owner_active := exists (select 1 from public.qorpera_profile_staff s where s.profile_id = v_profile
				and s.staff_agent_id = v_owner and s.employment_status = 'active' and s.folder_retired_at is null);$new$);
select pg_temp.p15_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$					v_created, v_routine.status = 'active', (v_routine.status = 'active' or v_ends_wait) and not v_waits) position$old$,
	$new$					v_created, v_routine.status = 'active', (v_routine.status = 'active' or v_ends_wait) and not v_waits
						and v_p15_owner_active) position$new$);
select pg_temp.p15_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				status = case when v_waits then 'paused' when v_ends_wait then 'active' else status end,
				pause_reason = case when v_waits then 'needs_model_account' when v_ends_wait then null else pause_reason end,$old$,
	$new$				status = case when v_waits then 'paused' when not v_p15_owner_active and (v_ends_wait or status = 'active') then 'paused'
					when v_ends_wait then 'active' else status end,
				pause_reason = case when v_waits then 'needs_model_account'
					when not v_p15_owner_active and (v_ends_wait or status = 'active') then 'agent_archived'
					when v_ends_wait then null else pause_reason end,$new$);

-- The thread session at rank 11, under the conditions the room is named at rank 4, so the thread trigger's update of it
-- is in order.
select pg_temp.p15_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$	v_member uuid; v_h2 record; v_f2 record; v_p16 record;$old$,
	$new$	v_member uuid; v_h2 record; v_f2 record; v_p16 record; v_p15_session uuid;$new$);
select pg_temp.p15_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$					for v_room in select r.id from public.qorpera_company_rooms r
						where r.profile_id = v_profile and r.bound_staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
						return next;
					end loop;$old$,
	$new$					for v_room in select r.id from public.qorpera_company_rooms r
						where r.profile_id = v_profile and r.bound_staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
						return next;
						-- 20260930022000 (P15): its thread session.
						select r.session_id into v_p15_session from public.qorpera_company_rooms r where r.id = v_room;
						if v_p15_session is not null then
							rank := 11; tbl := 'qorpera_shared_sessions'; key := v_p15_session::text; mode := 'update';
							return next;
						end if;
					end loop;$new$);
select pg_temp.p15_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$						for v_room in select r.id from public.qorpera_company_rooms r
							where r.profile_id = v_profile and r.bound_staff_agent_id = v_staff.staff_agent_id loop
							rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
							return next;
						end loop;$old$,
	$new$						for v_room in select r.id from public.qorpera_company_rooms r
							where r.profile_id = v_profile and r.bound_staff_agent_id = v_staff.staff_agent_id loop
							rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
							return next;
							-- 20260930022000 (P15): its thread session.
							select r.session_id into v_p15_session from public.qorpera_company_rooms r where r.id = v_room;
							if v_p15_session is not null then
								rank := 11; tbl := 'qorpera_shared_sessions'; key := v_p15_session::text; mode := 'update';
								return next;
							end if;
						end loop;$new$);

-- The staff triggers whose work is the converge's on folder-v2.
select pg_temp.p15_replace('public.qorpera_default_agent_read_on_staff()'::regprocedure,
	$old$begin
	if new.employment_status = 'active'$old$,
	$new$begin
	-- 20260930022000 (P15): a folder-v2 agent's default grant comes from the follow-up queue.
	if public.qorpera_company_is_folder_v2(new.profile_id) then return new; end if;
	if new.employment_status = 'active'$new$);
select pg_temp.p15_replace('public.qorpera_grant_shared_connectors_to_staff()'::regprocedure,
	$old$begin
	if new.employment_status <> 'active' or (tg_op = 'UPDATE' and old.employment_status = 'active') then$old$,
	$new$begin
	-- 20260930022000 (P15): a folder-v2 agent's connectors come from the follow-up queue.
	if public.qorpera_company_is_folder_v2(new.profile_id) then return new; end if;
	if new.employment_status <> 'active' or (tg_op = 'UPDATE' and old.employment_status = 'active') then$new$);
select pg_temp.p15_replace('public.qorpera_revoke_secret_grants_for_inactive_staff()'::regprocedure,
	$old$begin
	if new.employment_status <> 'active' and old.employment_status = 'active' then$old$,
	$new$begin
	-- 20260930022000 (P15): a folder-v2 agent's vault grants are revoked by the follow-up queue.
	if public.qorpera_company_is_folder_v2(new.profile_id) then return new; end if;
	if new.employment_status <> 'active' and old.employment_status = 'active' then$new$);
select pg_temp.p15_replace('public.qorpera_routine_stops_with_agent()'::regprocedure,
	$old$begin
	update public.qorpera_cloud_routines routine set expired_while_active = false$old$,
	$new$begin
	-- 20260930022000 (P15): a folder-v2 agent's routines are the follow-up queue's.
	if public.qorpera_company_is_folder_v2(new.profile_id) then return null; end if;
	update public.qorpera_cloud_routines routine set expired_while_active = false$new$);
select pg_temp.p15_replace('public.qorpera_agent_thread_on_staff()'::regprocedure,
	$old$	if not (new.employment_status = 'active' and new.deleted_at is null) then
		update public.qorpera_shared_sessions set status = 'closed'$old$,
	$new$	-- 20260930022000 (P15): a folder-v2 agent's pair sessions are closed by the follow-up queue, by id, in order.
	if not (new.employment_status = 'active' and new.deleted_at is null) and not public.qorpera_company_is_folder_v2(new.profile_id) then
		update public.qorpera_shared_sessions set status = 'closed'$new$);

-- 4. Routines and an archived agent.
-- A routine landing under an archived or retired agent (a new routine saved there, one moved there, a file set back to
-- active, a new version ending a wait for a login) is recorded paused: the platform's record, as the queue writes it at
-- the archive.
select pg_temp.p15_replace('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		v_status := 'expired'; v_reason := null; end if;
$old$,
	$new$		v_status := 'expired'; v_reason := null; end if;
	-- 20260930022000 (P15): a routine never runs under an archived or retired agent.
	if v_status = 'active' and not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = p_profile_id
		and s.staff_agent_id = v_owner and s.employment_status = 'active' and s.folder_retired_at is null) then
		v_status := 'paused'; v_reason := 'agent_archived'; end if;
$new$);
-- A paid save that changes nothing ends an archive's pause once the routine's agent is active again (W4c's resume).
select pg_temp.p15_replace('public.qorpera_company_state_routine_resumes(public.qorpera_cloud_routines,jsonb,jsonb,text)'::regprocedure,
	$old$		and p_row.pause_reason in ('member', 'authorization_failed', 'needs_model_account'), false)$old$,
	$new$		and (p_row.pause_reason in ('member', 'authorization_failed', 'needs_model_account')
			-- 20260930022000 (P15): an archive's pause, once the routine's agent is active again.
			or (p_row.pause_reason = 'agent_archived' and exists (select 1 from public.qorpera_profile_staff s
				where s.profile_id = p_row.profile_id and s.staff_agent_id = p_row.owner_staff_agent_id
					and s.employment_status = 'active' and s.folder_retired_at is null))), false)$new$);
-- Routine firing defers for an archived or retired agent until the queue pauses its routines (it holds the agent's row
-- KEY SHARE already). It marks the agent, so the queue pauses the routine even if the archive's converge already ran
-- (insert-only, no lock), but only while the agent has no mark pending and its work row is not dirty (plain reads): a
-- deferral repeats every scheduler pass, and a failing converge keeps its back-off.
create function public.qorpera_folder_follow_up_mark_firing(p_environment_id uuid, p_staff_agent_id uuid)
returns void language sql security definer set search_path = '' as $$
	insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id)
	select p_environment_id, 'agent', p_staff_agent_id
	where not exists (select 1 from public.qorpera_folder_follow_up_marks m where m.environment_id = p_environment_id
			and m.subject_kind = 'agent' and m.subject_id = p_staff_agent_id)
		and not exists (select 1 from public.qorpera_folder_follow_ups w where w.environment_id = p_environment_id
			and w.subject_kind = 'agent' and w.subject_id = p_staff_agent_id and w.dirty)
$$;
revoke all on function public.qorpera_folder_follow_up_mark_firing(uuid, uuid) from public, anon, authenticated, service_role;
select pg_temp.p15_replace('public.qorpera_folder_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb)'::regprocedure,
	$old$	-- A pause defers standing work (the fence is held, so a stop in its second phase waits for this).$old$,
	$new$	-- 20260930022000 (P15): an archived or retired agent's routine defers; the follow-up queue pauses it.
	if v_occurrence.id is null and not exists (select 1 from public.qorpera_profile_staff s
		where s.profile_id = v_routine.profile_id and s.staff_agent_id = v_version.staff_agent_id
			and s.employment_status = 'active' and s.folder_retired_at is null) then
		perform public.qorpera_folder_follow_up_mark_firing(v_routine.environment_id, v_version.staff_agent_id);
		return jsonb_build_object(
			'occurrence_id', null, 'status', 'deferred', 'run_id', null,
			'scheduled_for', p_scheduled_for, 'reason', 'The routine''s agent is archived'
		);
	end if;
	-- A pause defers standing work (the fence is held, so a stop in its second phase waits for this).$new$);
select pg_temp.p15_replace('public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'::regprocedure,
	$old$	-- Rank 5: the routine. A save or a decision holding it makes this pass skip it; the next pass comes back.$old$,
	$new$	-- 20260930022000 (P15): an archived or retired agent's routine waits (the orchestrator's 'paused'); the follow-up queue
	-- pauses it.
	if not exists (select 1 from public.qorpera_profile_staff s where s.profile_id = v_routine.profile_id
		and s.staff_agent_id = v_version.staff_agent_id and s.employment_status = 'active' and s.folder_retired_at is null) then
		perform public.qorpera_folder_follow_up_mark_firing(v_routine.environment_id, v_version.staff_agent_id);
		return jsonb_build_object('status', 'paused'); end if;
	-- Rank 5: the routine. A save or a decision holding it makes this pass skip it; the next pass comes back.$new$);

-- P29's listener sets aside a routine whose agent is not active (P29a, 20260930020000, which sorts before this): its
-- follow-up mark, as routine firing writes it. Patched only where the listener is installed; 879 checks the marker
-- wherever it is.
do $p15$
declare v_listener regprocedure;
begin
	select p.oid::regprocedure into v_listener from pg_proc p
	where p.pronamespace = 'public'::regnamespace and p.proname = 'qorpera_folder_listen_company';
	if v_listener is null then
		raise notice 'P29''s listener is not installed here: its follow-up mark comes with it'; return; end if;
	perform pg_temp.p15_replace(v_listener,
		$old$			-- The agents set aside (v_inactive, in step 1 and above): their routines would have heard a change set. P15
			-- (20260930022000) marks each one's follow-up here, as routine firing does.$old$,
		$new$			-- The agents set aside (v_inactive, in step 1 and above): their routines would have heard a change set.
			-- 20260930022000 (P15): each one's follow-up mark, as routine firing writes it.
			perform public.qorpera_folder_follow_up_mark_firing(p_environment_id, s) from unnest(v_inactive) s;$new$);
end $p15$;

-- 5. Creation: the commit keeps the Co-Founder's kickoff and first-run row; its turn request is queued by the follow-up
-- queue once its default grant exists.
select pg_temp.p15_replace('public.qorpera_folder_company_first_run(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$	-- The member who started the work pays, as Start checked; read again now. With no usable login the kickoff stays
	-- pending, and its author starts it (qorpera_start_agent_first_run).
	v_sponsor := public.qorpera_member_first_run_sponsor(v_creation.profile_id, v_creation.kickoff_user_id);
	if v_sponsor is not null and public.qorpera_sponsor_serves_requester(v_creation.profile_id,
		(v_sponsor ->> 'sponsorBindingId')::uuid, (v_sponsor ->> 'sponsorVersion')::bigint, v_creation.kickoff_user_id) then
		perform public.qorpera_queue_agent_first_run(v_creation.profile_id, p_staff_agent_id, v_sponsor);
	end if;
$old$,
	$new$	-- 20260930022000 (P15): the turn request, on the kickoff member's own login, is queued by the follow-up queue after the
	-- Co-Founder's default grant.
$new$);

-- The company is ready once its creation is completed and its Co-Founder's subject has converged (its default grant,
-- then its first-run turn); a Co-Founder subject failing for 10 minutes shows as failed.
create or replace function public.qorpera_folder_company_ready(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930010000 (P14a), 20260930022000 (P15).
	select exists (select 1 from public.qorpera_folder_company_creations as creation
		join public.qorpera_folder_follow_ups as work on work.environment_id = creation.environment_id
			and work.subject_kind = 'agent' and work.subject_id = creation.cofounder_id
		where creation.profile_id = p_profile_id and creation.state = 'completed'
			and not work.dirty and work.converged_at is not null
			and not exists (select 1 from public.qorpera_folder_follow_up_marks as mark
				where mark.environment_id = creation.environment_id and mark.subject_kind = 'agent'
					and mark.subject_id = creation.cofounder_id))
$$;
create or replace function public.qorpera_folder_company_setup(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select case when creation.state in ('failed', 'blocked') then 'failed'
		when public.qorpera_folder_company_ready(p_profile_id) then 'ready'
		when creation.state = 'completed' and exists (select 1 from public.qorpera_folder_follow_ups as work
			where work.environment_id = creation.environment_id and work.subject_kind = 'agent'
				and work.subject_id = creation.cofounder_id and work.failing_since < clock_timestamp() - interval '10 minutes')
			then 'failed'
		else 'pending' end
	from public.qorpera_folder_company_creations as creation where creation.profile_id = p_profile_id
$$;
select pg_temp.p15_replace('public.qorpera_list_hosted_profiles()'::regprocedure,
	$old$			or exists (select 1 from public.qorpera_folder_company_creations as creation where creation.profile_id = profile.id
				and creation.state = 'completed'))$old$,
	$new$			-- 20260930022000 (P15): and its Co-Founder's subject has converged.
			or public.qorpera_folder_company_ready(profile.id))$new$);

-- 6. Converging an agent to its current staff row (STATE-FILES §8 "Plan (P15)", "Converging an agent"). It reads plainly to
-- choose its targets, enters the company (the pause, the fence KEY SHARE, rank 0, ranks 1-5), takes ranks 6-11 itself,
-- and compares the row under its lock with what it read: a change since ends as a retry, which counts no attempt. It never
-- takes the folder clock: it returns the default grant's journal changes, which the caller writes at its top level.
-- Answers {result: done | retry | dirty, changes, problem}.
create function public.qorpera_folder_converge_agent(p_environment_id uuid, p_staff_agent_id uuid, p_hired_by uuid,
	p_first_run_manual boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid; v_staff public.qorpera_profile_staff%rowtype; v_locked public.qorpera_profile_staff%rowtype;
	v_live boolean; v_first public.qorpera_agent_first_runs%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_room public.qorpera_company_rooms%rowtype; v_targets jsonb := '[]'::jsonb; v_changes jsonb := '[]'::jsonb;
	v_kickoff boolean := false; v_turn boolean := false; v_author uuid; v_owner uuid; v_problem text; v_root record;
	v_grant uuid; v_secret public.qorpera_cloud_secrets%rowtype; v_issuer uuid; v_sessions uuid[]; v_closed uuid[];
	v_session uuid; v_todo uuid; v_body jsonb; v_input_id uuid; v_sponsor jsonb; v_skipped boolean := false;
	v_routines uuid[] := '{}'; v_grants uuid[]; v_author_member boolean := false;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('result', 'done'); end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = p_staff_agent_id;
	-- An agent erased (or tombstoned) is the erasure's.
	if not found or v_staff.deleted_at is not null or v_staff.folder_erased_at is not null then
		return jsonb_build_object('result', 'done'); end if;
	v_live := v_staff.employment_status = 'active' and v_staff.folder_retired_at is null;
	v_owner := public.qorpera_company_owner_user_id(v_profile);
	select * into v_room from public.qorpera_company_rooms where profile_id = v_profile and bound_staff_agent_id = p_staff_agent_id;
	if v_live then
		select * into v_first from public.qorpera_agent_first_runs where profile_id = v_profile and staff_agent_id = p_staff_agent_id;
		if v_first.input_id is null then
			-- A hire's kickoff, once ever; the Co-Founder's comes with its creation.
			v_kickoff := not exists (select 1 from public.qorpera_company_cofounders c where c.profile_id = v_profile
				and c.staff_agent_id = p_staff_agent_id) and v_room.session_id is not null;
			v_author := p_hired_by;
			if v_kickoff and (v_author is null or not exists (select 1 from public.qorpera_profile_members m
				where m.profile_id = v_profile and m.user_id = v_author and m.role::text <> 'viewer')) then
				-- The member who made the agent active has left: the owner authors it, and nobody's login is queued.
				v_problem := case when v_author is null then 'no_hirer' else 'hirer_left' end; v_author := v_owner; end if;
		else
			select * into v_input from public.qorpera_session_inputs where id = v_first.input_id;
			-- (Never for a first run its owner authored in place of a member: no login was chosen for it.)
			v_turn := not coalesce(p_first_run_manual, false) and v_input.kind = 'kickoff' and v_input.completed_at is null
				and v_input.failed_at is null
				and v_input.execution_run_id is null and v_input.turn_id is null
				and not exists (select 1 from public.qorpera_session_turn_requests r where r.input_id = v_input.id);
			v_author := v_input.author_user_id;
		end if;
		-- Whether the first run's author is a member now (plain read; checked again under the lock).
		v_author_member := v_author is not null and exists (select 1 from public.qorpera_profile_members m
			where m.profile_id = v_profile and m.user_id = v_author and m.role::text <> 'viewer');
		if (v_kickoff or v_turn) and v_author is not null then
			v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', v_profile::text || ':' || v_author::text, 'mode', 'keyshare'));
		end if;
		if v_room.id is not null then
			v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms',
				'key', v_room.id::text, 'mode', 'keyshare'));
		end if;
	else
		-- FOR UPDATE: the rows it updates exclude the key shares that would make them multixacts inside the savepoint. Only
		-- these routines are changed; one that turns active after this read is firing's to mark.
		select coalesce(array_agg(r.id order by r.id), '{}') into v_routines from public.qorpera_cloud_routines r
		where r.profile_id = v_profile and r.owner_staff_agent_id = p_staff_agent_id
			and (r.status = 'active' or (r.status = 'expired' and r.expired_while_active));
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_profile::text || ':' || p_staff_agent_id::text, 'mode', 'update'))
			|| coalesce((select jsonb_agg(jsonb_build_object('rank', 5, 'tbl', 'qorpera_cloud_routines', 'key', r::text,
				'mode', 'update')) from unnest(v_routines) r), '[]'::jsonb);
	end if;
	v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
		'key', v_profile::text || ':' || p_staff_agent_id::text, 'mode', 'nokeyupdate', 'required', true));
	-- The login a turn request will name, chosen by a plain read (the member who started the work pays).
	if v_live and ((v_kickoff and v_problem is null) or v_turn) and v_author_member then
		v_sponsor := public.qorpera_member_first_run_sponsor(v_profile, v_author);
		if v_sponsor is not null and not public.qorpera_sponsor_serves_requester(v_profile, (v_sponsor ->> 'sponsorBindingId')::uuid,
			(v_sponsor ->> 'sponsorVersion')::bigint, v_author) then v_sponsor := null; end if;
	end if;
	-- The pause, the fence KEY SHARE and ranks 0-2; after rank 2 the background side yields (200 ms a lock), so a commit
	-- never waits long behind a converge; then ranks 3-5.
	perform public.qorpera_folder_company_enter(p_environment_id, v_profile,
		(select coalesce(jsonb_agg(t), '[]'::jsonb) from jsonb_array_elements(v_targets) t where (t ->> 'rank')::integer <= 2), true);
	perform set_config('lock_timeout', '200ms', true);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	-- The end of rank 5, as C1B §8 places logins and identities: the sponsor version and the compute identity the turn
	-- request will key-share, NOWAIT (a recovering identity holds its row FOR UPDATE: 55P03 ends this attempt).
	if v_sponsor is not null then
		perform 1 from public.qorpera_execution_sponsor_versions where binding_id = (v_sponsor ->> 'sponsorBindingId')::uuid
			and version = (v_sponsor ->> 'sponsorVersion')::bigint for key share nowait;
		perform 1 from public.qorpera_member_compute_identities where id = (v_sponsor ->> 'computeIdentityId')::uuid
			for key share nowait;
	end if;
	select * into v_locked from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = p_staff_agent_id;
	if v_locked.employment_status is distinct from v_staff.employment_status
		or v_locked.folder_retired_at is distinct from v_staff.folder_retired_at
		or v_locked.folder_erased_at is not null or v_locked.deleted_at is not null
		or (v_live and exists (select 1 from public.qorpera_agent_first_runs f where f.profile_id = v_profile
			and f.staff_agent_id = p_staff_agent_id) is distinct from (v_first.input_id is not null))
		-- The first run's author, a member when read: still one under its rank-1 lock (one who left since is the next
		-- attempt's to see, as a hirer gone).
		or (v_live and v_author_member and (v_kickoff or v_turn)
			and not exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_profile and m.user_id = v_author
				and m.role::text <> 'viewer')) then
		return jsonb_build_object('result', 'retry'); end if;

	if v_live then
		-- Ranks 6-7: the default grant on each live shared root where the agent has no grant row of any kind (never widening
		-- an explicit grant, never reviving a revoked or expired default), read and write, attributed to the owner.
		for v_root in select r.id, r.version, r.path from public.qorpera_company_path_resources r
			where r.environment_id = p_environment_id and r.path = '' and r.path_match = 'subtree' and r.scope = 'company_shared'
				and r.revoked_at is null
				and not exists (select 1 from public.qorpera_company_path_grants g where g.resource_id = r.id
					and g.principal_kind = 'staff_agent' and g.principal_id = p_staff_agent_id)
			order by r.id
		loop
			perform public.qorpera_folder_lock_commit_rank(p_environment_id, jsonb_build_array(jsonb_build_object('rank', 6,
				'tbl', 'qorpera_company_path_resources', 'key', v_root.id::text, 'mode', 'nokeyupdate', 'required', true)), 6::smallint);
			if exists (select 1 from public.qorpera_company_path_grants g where g.resource_id = v_root.id
				and g.principal_kind = 'staff_agent' and g.principal_id = p_staff_agent_id) then continue; end if;
			insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
				permissions, expires_at, created_by_user_id, origin)
			values (v_root.id, v_root.version, 'staff_agent', p_staff_agent_id, array['read','write']::text[], null,
				coalesce(v_owner, v_locked.updated_by_user_id), 'default_agent_read')
			returning id into v_grant;
			v_changes := v_changes || jsonb_build_array(jsonb_build_object('grantId', v_grant, 'revision', 1,
				'prefix', public.qorpera_folder_key(v_root.path)));
		end loop;
		-- Rank 8, in the vault's order: the agent's active grants by id, then each shared secret KEY SHARE NOWAIT (a share,
		-- a seal or a Disconnect holding one ends this attempt with 55P03, never waiting on it), then the grants.
		perform 1 from public.qorpera_cloud_secret_operation_grants g where g.profile_id = v_profile
			and g.staff_agent_id = p_staff_agent_id and g.status = 'active' order by g.id for update;
		for v_secret in select s.* from public.qorpera_cloud_secrets s where s.profile_id = v_profile and s.status = 'active'
			and s.available_to_all_agents and s.owner_kind = 'company' order by s.id
		loop
			perform 1 from public.qorpera_cloud_secrets where id = v_secret.id for key share nowait;
			-- The issuer, as the staff trigger chose it: the author of the change when an owner or admin, else the member who
			-- connected the account, else a current owner.
			select m.user_id into v_issuer from public.qorpera_profile_members m
			where m.profile_id = v_profile and m.role in ('owner','admin')
			order by m.user_id = coalesce(p_hired_by, v_locked.updated_by_user_id) desc, m.user_id = v_secret.created_by_user_id desc,
				m.role = 'owner' desc, m.user_id
			limit 1;
			if v_issuer is not null then
				perform public.qorpera_grant_cloud_connector_operations(v_secret.profile_id, v_secret.environment_id, v_secret.id,
					v_issuer, array[p_staff_agent_id]);
			end if;
		end loop;
		-- Rank 11 and the first run: a hire's kickoff in its thread (the session FOR UPDATE), then, for every agent, the turn
		-- request once the grant exists (the kickoff input FOR UPDATE, the session KEY SHARE through its foreign key).
		if v_kickoff then
			perform public.qorpera_folder_lock_sessions(p_environment_id, jsonb_build_array(jsonb_build_object('rank', 11,
				'tbl', 'qorpera_shared_sessions', 'key', v_room.session_id::text, 'mode', 'update', 'required', true)));
			select t.id into v_todo from public.qorpera_runtime_agent_todos t where t.profile_id = v_profile
				and t.staff_agent_id = p_staff_agent_id and t.todo_key = 'first-assignment' and t.folder_retired_at is null;
			v_body := jsonb_build_object('schema', 'qorpera.agent-first-run/v1', 'assignment', jsonb_build_object(
				'kind', 'staff_startup', 'companyId', v_profile, 'staffAgentId', p_staff_agent_id, 'firstTodoId', v_todo));
			insert into public.qorpera_session_inputs(session_id, client_input_id, kind, author_user_id, body)
			values (v_room.session_id, md5('qorpera.folder-agent-first-run:' || p_staff_agent_id::text)::uuid, 'kickoff', v_author,
				v_body)
			returning id into v_input_id;
			insert into public.qorpera_agent_first_runs(profile_id, environment_id, staff_agent_id, session_id, input_id,
				source_path_version, startup_assignment)
			values (v_profile, p_environment_id, p_staff_agent_id, v_room.session_id, v_input_id, v_locked.folder_path_version, v_body);
			v_turn := v_problem is null;
		end if;
		if v_turn and v_sponsor is not null then
			-- Sessions before inputs: the thread session KEY SHARE (taken FOR UPDATE above for a new kickoff), then the kickoff
			-- input FOR UPDATE inside the queue. With no usable login the kickoff stays pending, and its author starts it.
			if not v_kickoff then
				perform 1 from public.qorpera_shared_sessions where id = v_first.session_id for key share; end if;
			perform public.qorpera_queue_agent_first_run(v_profile, p_staff_agent_id, v_sponsor);
		end if;
	else
		-- Rank 5: its active routines paused for the archive (never resumed by the queue), and the expired ones' flags.
		update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'agent_archived', updated_at = statement_timestamp()
		where id = any (v_routines) and owner_staff_agent_id = p_staff_agent_id and status = 'active';
		update public.qorpera_cloud_routines set expired_while_active = false
		where id = any (v_routines) and owner_staff_agent_id = p_staff_agent_id and status = 'expired' and expired_while_active;
		-- Rank 8: its vault grants revoked, in id order, those it locked.
		select coalesce(array_agg(g.id), '{}') into v_grants from (select g.id from public.qorpera_cloud_secret_operation_grants g
			where g.profile_id = v_profile and g.staff_agent_id = p_staff_agent_id and g.status = 'active' order by g.id for update) g;
		update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = statement_timestamp(),
			revoked_by_user_id = v_locked.updated_by_user_id
		where id = any (v_grants) and status = 'active';
		-- Rank 3 (held since the entry): its execution authorities.
		delete from public.qorpera_staff_execution_authorities where profile_id = v_profile and staff_agent_id = p_staff_agent_id;
		-- Rank 11: its pair sessions and other open sessions closed, by id, SKIP LOCKED (one held leaves the subject dirty),
		-- then the execution bindings of those and of its own sessions already closed (its thread, which the commit closed).
		select coalesce(array_agg(s.id order by s.id), '{}') into v_sessions from public.qorpera_shared_sessions s
		where s.profile_id = v_profile and s.status = 'open'
			and (s.staff_agent_id = p_staff_agent_id::text or s.execution_scope -> 'agentPair' ? p_staff_agent_id::text);
		select coalesce(array_agg(s.id), '{}') into v_closed from (select s.id from public.qorpera_shared_sessions s
			where s.id = any (v_sessions) and s.status = 'open' order by s.id for update skip locked) s;
		v_skipped := cardinality(v_closed) < cardinality(v_sessions);
		update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp() where id = any (v_closed);
		delete from public.qorpera_session_execution_bindings b where b.profile_id = v_profile
			and (b.session_id = any (v_closed) or b.session_id in (select s.id from public.qorpera_shared_sessions s
				where s.profile_id = v_profile and s.staff_agent_id = p_staff_agent_id::text and s.status = 'closed'));
	end if;
	return jsonb_build_object('result', case when v_skipped then 'dirty' else 'done' end, 'changes', v_changes,
		'problem', v_problem, 'firstRunManual', v_kickoff and v_problem is not null);
end $$;
revoke all on function public.qorpera_folder_converge_agent(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- Converging the company's name: a plain compare first; only when they differ, the company row FOR NO KEY UPDATE SKIP
-- LOCKED (core §3's one named exception), the compare again and the update. Called at the step's top level, never inside
-- a savepoint or a transaction that holds the fence; a busy row is a back-off with no error raised.
create function public.qorpera_folder_converge_company(p_environment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_name text;
begin
	select f.profile_id, i.name into v_profile, v_name from public.qorpera_company_files f
	join public.qorpera_folder_company_index i on i.environment_id = f.environment_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	-- (The company row's own rule, so the update below cannot fail.)
	if v_profile is null or v_name is null
		or exists (select 1 from public.qorpera_company_deletions d where d.profile_id = v_profile)
		or (select p.name from public.qorpera_profiles p where p.id = v_profile) is not distinct from v_name then
		return jsonb_build_object('result', 'done'); end if;
	if char_length(btrim(v_name)) not between 1 and 120 then
		return jsonb_build_object('result', 'done', 'problem', 'name_invalid'); end if;
	perform 1 from public.qorpera_profiles where id = v_profile for no key update skip locked;
	if not found then return jsonb_build_object('result', 'dirty', 'problem', 'busy'); end if;
	update public.qorpera_profiles set name = v_name where id = v_profile and name is distinct from v_name;
	return jsonb_build_object('result', 'done');
end $$;
revoke all on function public.qorpera_folder_converge_company(uuid) from public, anon, authenticated, service_role;

-- 7. Taking a subject: its marks become its work row's (dirty; due now when a mark came with a commit), and the author of a first run is the member whose
-- commit made the agent active. A work row another transaction holds is left alone with its marks, so taking never waits
-- behind a kick (only a new row inserted by another taker, briefly, in subject order). Answers the held row or null.
create function public.qorpera_folder_follow_up_take(p_environment_id uuid, p_kind text, p_subject uuid)
returns public.qorpera_folder_follow_ups language plpgsql security definer set search_path = '' as $$
declare v_work public.qorpera_folder_follow_ups%rowtype; v_by uuid; v_taken bigint; v_committed bigint;
begin
	-- (A new row is clean: only a mark makes it dirty.)
	insert into public.qorpera_folder_follow_ups(environment_id, subject_kind, subject_id, profile_id, dirty)
	select p_environment_id, p_kind, p_subject, f.profile_id, false from public.qorpera_company_files f
	where f.environment_id = p_environment_id
	on conflict do nothing;
	select * into v_work from public.qorpera_folder_follow_ups
	where environment_id = p_environment_id and subject_kind = p_kind and subject_id = p_subject for update skip locked;
	if not found then return null; end if;
	with taken as (
		delete from public.qorpera_folder_follow_up_marks where id in (select m.id from public.qorpera_folder_follow_up_marks m
			where m.environment_id = p_environment_id and m.subject_kind = p_kind and m.subject_id = p_subject
			for update skip locked)
		returning by_user_id, commit_id, active, id)
	select count(*), count(*) filter (where taken.commit_id is not null),
		(array_agg(taken.by_user_id order by c.seq nulls last, taken.id) filter (where taken.active))[1]
	into v_taken, v_committed, v_by from taken left join public.qorpera_folder_commits c on c.id = taken.commit_id;
	-- A commit's mark makes the subject due now; a mark with no commit (routine firing's) keeps a back-off.
	update public.qorpera_folder_follow_ups set dirty = dirty or v_taken > 0,
		not_before = case when v_committed > 0 then null else not_before end,
		hired_by_user_id = coalesce(hired_by_user_id, v_by), updated_at = clock_timestamp()
	where environment_id = p_environment_id and subject_kind = p_kind and subject_id = p_subject
	returning * into v_work;
	return v_work;
end $$;
revoke all on function public.qorpera_folder_follow_up_take(uuid, text, uuid) from public, anon, authenticated, service_role;

-- 8. Converging a held work row. An agent's converge runs inside one exception block, then, at the top level, the
-- default grant's widening authority journal row. Inside the block nothing writes a row that references the folder clock,
-- and the rows it updates are taken FOR UPDATE, so no savepoint ever updates a row that key sharers point at; the clock is
-- taken once, here, last, outside every savepoint. The journal's changes are checked inside the block, so the top level
-- can fail only on the clock wait (which aborts the step; the next pass retries). The company subject has no block: its
-- name copy never raises (SKIP LOCKED). A pause, or a retry after the row changed, counts no attempt.
create function public.qorpera_folder_follow_up_converge(p_work public.qorpera_folder_follow_ups)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; v_state text; v_message text; v_result text; v_timeout text := current_setting('lock_timeout');
begin
	if p_work.subject_kind = 'company' then
		v_out := public.qorpera_folder_converge_company(p_work.environment_id);
	else
		begin
			v_out := public.qorpera_folder_converge_agent(p_work.environment_id, p_work.subject_id, p_work.hired_by_user_id,
				p_work.first_run_manual);
			-- (An answer that changed nothing, a retry included, lists no changes.)
			v_out := v_out || jsonb_build_object('changes', coalesce(v_out -> 'changes', '[]'::jsonb));
			if jsonb_typeof(v_out -> 'changes') is distinct from 'array'
				or exists (select 1 from jsonb_array_elements(v_out -> 'changes') c
					where jsonb_typeof(c) <> 'object' or (select array_agg(k order by k) from jsonb_object_keys(c) k)
							is distinct from array['grantId','prefix','revision']
						or c -> 'revision' <> '1'::jsonb or jsonb_typeof(c -> 'prefix') <> 'string'
						or not exists (select 1 from public.qorpera_company_path_grants g where g.id::text = c ->> 'grantId'))
				or (jsonb_array_length(v_out -> 'changes') > 0
					and not exists (select 1 from public.qorpera_folder_clocks k where k.environment_id = p_work.environment_id)) then
				raise exception 'A follow-up''s journal changes are malformed' using errcode = 'XX000'; end if;
		exception when others then
			get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
			-- A pause (read again here) is no attempt; any other 55000 is a failure like the rest.
			v_out := jsonb_build_object('result', case when v_state = '55000'
					and public.qorpera_company_execution_paused(p_work.profile_id) then 'paused' else 'failed' end,
				'problem', left(v_state || ' ' || v_message, 300));
		end;
		-- The block's 200 ms survives a released subtransaction: the step's own timeout again.
		perform set_config('lock_timeout', v_timeout, true);
	end if;
	v_result := v_out ->> 'result';
	if v_result = 'done' and jsonb_array_length(coalesce(v_out -> 'changes', '[]'::jsonb)) > 0 then
		perform public.qorpera_folder_authority_journal(p_work.environment_id, '{"kind":"platform"}'::jsonb, false, v_out -> 'changes');
	end if;
	update public.qorpera_folder_follow_ups set
		dirty = v_result <> 'done',
		attempts = case when v_result = 'failed' then attempts + 1 when v_result = 'done' then 0 else attempts end,
		not_before = case v_result when 'failed' then clock_timestamp() + make_interval(secs => least(power(2, least(attempts + 1, 10)), 600))
			when 'dirty' then clock_timestamp() + interval '5 seconds' when 'paused' then clock_timestamp() + interval '5 seconds'
			else null end,
		last_problem = case when v_result in ('done', 'failed') then v_out ->> 'problem' else last_problem end,
		last_attempt_at = clock_timestamp(),
		converged_at = case when v_result = 'done' then clock_timestamp() else converged_at end,
		first_run_manual = first_run_manual or (v_result = 'done' and coalesce((v_out ->> 'firstRunManual')::boolean, false)),
		failing_since = case when v_result = 'failed' then coalesce(failing_since, clock_timestamp())
			when v_result = 'done' then null else failing_since end,
		updated_at = clock_timestamp()
	where environment_id = p_work.environment_id and subject_kind = p_work.subject_kind and subject_id = p_work.subject_id;
	return jsonb_build_object('subjectKind', p_work.subject_kind, 'subjectId', p_work.subject_id, 'result', v_result,
		'problem', v_out -> 'problem');
end $$;
revoke all on function public.qorpera_folder_follow_up_converge(public.qorpera_folder_follow_ups)
	from public, anon, authenticated, service_role;

-- Whether a company's follow-ups may run now: not being deleted, not paused (plain reads).
create function public.qorpera_folder_follow_up_open(p_environment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_files f where f.environment_id = p_environment_id and f.core = 'folder-v2'
		and not exists (select 1 from public.qorpera_company_deletions d where d.profile_id = f.profile_id)
		and not public.qorpera_company_execution_paused(f.profile_id))
$$;
revoke all on function public.qorpera_folder_follow_up_open(uuid) from public, anon, authenticated, service_role;

-- 9. The step, every 2 seconds: one transaction, one work row (P22a's model). About once a minute it sweeps the work rows
-- and marks of environments that no longer exist. It takes the oldest marked subject of an open company whose row it can
-- hold, or else the oldest due dirty row of an open company, and converges it.
create function public.qorpera_folder_follow_up_sweep()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_swept bigint; v_orphans bigint;
begin
	delete from public.qorpera_folder_follow_ups where (environment_id, subject_kind, subject_id) in (
		select w.environment_id, w.subject_kind, w.subject_id from public.qorpera_folder_follow_ups w
		where not exists (select 1 from public.qorpera_folder_clocks c where c.environment_id = w.environment_id)
		limit 32 for update skip locked);
	get diagnostics v_swept = row_count;
	delete from public.qorpera_folder_follow_up_marks where id in (select m.id from public.qorpera_folder_follow_up_marks m
		where not exists (select 1 from public.qorpera_folder_clocks c where c.environment_id = m.environment_id)
		limit 256 for update skip locked);
	get diagnostics v_orphans = row_count;
	return v_swept + v_orphans;
end $$;
revoke all on function public.qorpera_folder_follow_up_sweep() from public, anon, authenticated, service_role;

create function public.qorpera_folder_follow_up_step()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_subject record; v_work public.qorpera_folder_follow_ups%rowtype; v_swept bigint := 0;
begin
	perform set_config('lock_timeout', '2s', true);
	-- The sweep scans every row, so it runs about once a minute (one step in each minute's first 2 seconds).
	if extract(epoch from clock_timestamp())::bigint % 60 < 2 then v_swept := public.qorpera_folder_follow_up_sweep(); end if;
	for v_subject in select m.environment_id, m.subject_kind, m.subject_id from public.qorpera_folder_follow_up_marks m
		where public.qorpera_folder_follow_up_open(m.environment_id)
		group by m.environment_id, m.subject_kind, m.subject_id order by min(m.id) limit 8
	loop
		v_work := public.qorpera_folder_follow_up_take(v_subject.environment_id, v_subject.subject_kind, v_subject.subject_id);
		-- (A subject whose only marks came with no commit keeps its back-off.)
		exit when v_work.subject_id is not null and v_work.dirty
			and (v_work.not_before is null or v_work.not_before <= clock_timestamp());
		v_work := null;
	end loop;
	if v_work.subject_id is null then
		select w.* into v_work from public.qorpera_folder_follow_ups w
		where w.dirty and (w.not_before is null or w.not_before <= clock_timestamp())
			and public.qorpera_folder_follow_up_open(w.environment_id)
		order by w.not_before nulls first, w.updated_at
		limit 1 for update skip locked;
		-- Its marks too, so the member a pending mark names authors its first run.
		if v_work.subject_id is not null then
			v_work := public.qorpera_folder_follow_up_take(v_work.environment_id, v_work.subject_kind, v_work.subject_id); end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-follow-up-step/v1', 'swept', v_swept,
		'converged', case when v_work.subject_id is not null and v_work.dirty
			then public.qorpera_folder_follow_up_converge(v_work) end);
end $$;
revoke all on function public.qorpera_folder_follow_up_step() from public, anon, authenticated, service_role;

-- 10. Kicks: a service-role writer that just committed marks converges them at once, one subject per call, each call its
-- own transaction: a subject (the creation worker after a creation), or the next subject one commit marked, the company's
-- first, answering whether more remain (the object gateway's member commit route calls again while they do). A company
-- being deleted or paused is skipped by a plain read; a subject another transaction holds, or whose new row another taker
-- is inserting (a 200 ms wait), answers busy. The step is the safety net.
create function public.qorpera_folder_follow_up_kick(p_environment_id uuid, p_subject_kind text, p_subject_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_work public.qorpera_folder_follow_ups%rowtype; v_timeout text := current_setting('lock_timeout');
begin
	begin
		perform set_config('lock_timeout', '200ms', true);
		v_work := public.qorpera_folder_follow_up_take(p_environment_id, p_subject_kind, p_subject_id);
	exception when lock_not_available then v_work := null;
	end;
	perform set_config('lock_timeout', v_timeout, true);
	if v_work.subject_id is null then return jsonb_build_object('result', 'busy'); end if;
	if not v_work.dirty then return jsonb_build_object('result', 'clean'); end if;
	return public.qorpera_folder_follow_up_converge(v_work);
end $$;
revoke all on function public.qorpera_folder_follow_up_kick(uuid, text, uuid) from public, anon, authenticated, service_role;

create function public.qorpera_folder_follow_up_now(p_environment_id uuid, p_subject_kind text, p_subject_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_environment_id is null or p_subject_id is null or p_subject_kind is null or p_subject_kind not in ('agent', 'company') then
		raise exception 'Folder follow-up is invalid' using errcode = '22023'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder follow-ups run at read committed' using errcode = '25000'; end if;
	if not public.qorpera_folder_follow_up_open(p_environment_id) then
		return jsonb_build_object('schema', 'qorpera.folder-follow-up/v1', 'result', 'closed'); end if;
	perform set_config('lock_timeout', '2s', true);
	return jsonb_build_object('schema', 'qorpera.folder-follow-up/v1')
		|| public.qorpera_folder_follow_up_kick(p_environment_id, p_subject_kind, p_subject_id);
end $$;
revoke all on function public.qorpera_folder_follow_up_now(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_follow_up_now(uuid, text, uuid) to service_role;

create function public.qorpera_folder_follow_up_commit(p_environment_id uuid, p_commit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_subject uuid; v_out jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_environment_id is null or p_commit_id is null then
		raise exception 'Folder follow-up is invalid' using errcode = '22023'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder follow-ups run at read committed' using errcode = '25000'; end if;
	if not public.qorpera_folder_follow_up_open(p_environment_id) then
		return jsonb_build_object('schema', 'qorpera.folder-follow-up/v1', 'result', 'closed', 'more', false); end if;
	-- One subject per call: a second agent's converge would take its ranks after the first one's clocks, and the company's
	-- name copy must never run in a transaction holding the fence. The company's first, then the agents in id order.
	select m.subject_kind, m.subject_id into v_kind, v_subject from public.qorpera_folder_follow_up_marks m
	where m.environment_id = p_environment_id and m.commit_id = p_commit_id
	order by m.subject_kind = 'agent', m.subject_id limit 1;
	if v_subject is null then
		return jsonb_build_object('schema', 'qorpera.folder-follow-up/v1', 'result', 'none', 'more', false); end if;
	perform set_config('lock_timeout', '2s', true);
	v_out := public.qorpera_folder_follow_up_kick(p_environment_id, v_kind, v_subject);
	-- A converged (or failed) subject's marks are consumed, so the next call takes the next subject; a busy one is left to
	-- the step.
	return jsonb_build_object('schema', 'qorpera.folder-follow-up/v1', 'subjectKind', v_kind, 'subjectId', v_subject) || v_out
		|| jsonb_build_object('more', v_out ->> 'result' <> 'busy' and exists (select 1 from public.qorpera_folder_follow_up_marks m
			where m.environment_id = p_environment_id and m.commit_id = p_commit_id));
end $$;
revoke all on function public.qorpera_folder_follow_up_commit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_follow_up_commit(uuid, uuid) to service_role;

-- For operators and the drift check: a company's subjects not converged (or none past a back-off), with marks not taken.
create function public.qorpera_folder_follow_up_status(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-follow-up-status/v1',
		'marks', (select count(*) from public.qorpera_folder_follow_up_marks where environment_id = p_environment_id),
		'dirty', coalesce((select jsonb_agg(jsonb_build_object('subjectKind', w.subject_kind, 'subjectId', w.subject_id,
				'attempts', w.attempts, 'notBefore', w.not_before, 'lastProblem', w.last_problem, 'failingSince', w.failing_since)
				order by w.updated_at)
			from public.qorpera_folder_follow_ups w where w.environment_id = p_environment_id and w.dirty), '[]'::jsonb));
end $$;
revoke all on function public.qorpera_folder_follow_up_status(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_follow_up_status(uuid) to service_role;

-- Every agent of a company and the company itself marked, with no commit: the rebuild's, and this migration's for the
-- companies made before it (their agents never went through the queue, and a Co-Founder must converge before its company
-- shows as ready). Insert-only, no lock. With no member named, an agent with no first run yet gets one its owner authors
-- and nobody's login pays for ('no_hirer').
create function public.qorpera_folder_follow_up_mark_all(p_environment_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_agents bigint; v_company bigint;
begin
	insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id, active)
	select p_environment_id, 'agent', s.staff_agent_id, s.employment_status = 'active' and s.folder_retired_at is null
	from public.qorpera_company_files f join public.qorpera_profile_staff s on s.profile_id = f.profile_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2' and s.folder_environment_id = p_environment_id
		and s.deleted_at is null and s.folder_erased_at is null;
	get diagnostics v_agents = row_count;
	insert into public.qorpera_folder_follow_up_marks(environment_id, subject_kind, subject_id)
	select p_environment_id, 'company', f.profile_id from public.qorpera_company_files f
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	get diagnostics v_company = row_count;
	return v_agents + v_company;
end $$;
revoke all on function public.qorpera_folder_follow_up_mark_all(uuid) from public, anon, authenticated, service_role;
select public.qorpera_folder_follow_up_mark_all(f.environment_id) from public.qorpera_company_files f where f.core = 'folder-v2';

-- 11. The step every 2 seconds (pg_cron 1.5 or later), and a daily cleanup of its run log (about 43,200 rows a day; the
-- log is cluster-wide). Where pg_cron is absent or the role may not use it, nothing is scheduled and the migration still
-- applies; run select public.qorpera_schedule_folder_follow_ups() as the role that should own the jobs after enabling it.
create function public.qorpera_schedule_folder_follow_ups()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The folder follow-up queue was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.folder-follow-up-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-folder-follow-ups', '2 seconds', 'select public.qorpera_folder_follow_up_step()');
		v_clean := cron.schedule('qorpera-folder-follow-ups-log', '23 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-folder-follow-ups')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The folder follow-up queue was not scheduled (%): % may not use pg_cron, or pg_cron is older than 1.5',
			sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.folder-follow-up-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.folder-follow-up-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;
revoke all on function public.qorpera_schedule_folder_follow_ups() from public, anon, authenticated, service_role;
select public.qorpera_schedule_folder_follow_ups();
