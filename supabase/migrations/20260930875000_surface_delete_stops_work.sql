-- WHY: Deleting an interface (Jonas, 23 Nov 2026) only set status = 'archived': its sessions ran on, its scheduled agents
-- fired on the company's first other interface, and a stale page could still start work on it. One call now settles it.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_cancel_coding_workers(uuid[],text)') is null
		or to_regprocedure('public.qorpera_ask_surface_publish(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_automation_payer_problem(uuid,uuid,text)') is null then
		raise exception '20260930875000 requires 20260930857000, 20260930867000 and 20260930868000';
	end if;
	if to_regprocedure('public.qorpera_surface_remove(uuid,boolean)') is not null then
		raise exception '20260930875000 is already applied';
	end if;
end $$;

create function pg_temp.sds_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930875000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930875000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create function public.qorpera_surface_remove(p_surface_id uuid, p_keep_built_in boolean)
returns public.qorpera_surfaces
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;

	-- WHY: before the surface lock: qorpera_surface_claim_due_automations holds its rows while it starts their sessions.
	delete from public.qorpera_surface_automations
	where profile_id = v_surface.profile_id and target_surface_slug = v_surface.slug;

	perform public.qorpera_surface_cancel_coding_workers(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.surface_id = p_surface_id),
		'surface_discarded'
	);

	-- WHY: job, session, surface, then changes is the lock order of qorpera_surface_complete_merge and
	-- qorpera_approve_surface_change; another order can deadlock (40P01) with either.
	perform 1 from public.qorpera_surface_jobs j
	where j.surface_id = p_surface_id and j.status in ('queued', 'running')
	order by j.id
	for update;
	perform 1 from public.qorpera_surface_sessions s
	where s.surface_id = p_surface_id
	order by s.id
	for update;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	if p_keep_built_in and v_surface.archetype = 'ops' and v_surface.status = 'active' then
		raise exception 'A built-in interface cannot be deleted' using errcode = '55000';
	end if;

	update public.qorpera_surfaces
	set
		status = 'archived',
		publish_status = case when publish_status = 'publishing' then 'idle' else publish_status end,
		updated_at = v_now
	where id = p_surface_id
	returning * into v_surface;

	update public.qorpera_surface_jobs
	set
		status = 'failed',
		error_detail = 'The interface was deleted',
		lease_token = null,
		lease_expires_at = null,
		completed_at = v_now,
		updated_at = v_now
	where surface_id = p_surface_id and status in ('queued', 'running');

	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = v_now
	where surface_id = p_surface_id and status in ('staged', 'conflicted', 'merging');

	-- WHY: a session started between the session locks above and the surface lock is caught here too; no wake_id
	-- and no lease is what ends its run (qorpera_folder_wake_authorized, qorpera_surface_renew_lease).
	update public.qorpera_surface_sessions
	set
		state = 'discarded',
		has_active_chat = false,
		lease_token = null,
		lease_expires_at = null,
		wake_id = null,
		closed_at = v_now,
		updated_at = v_now
	where surface_id = p_surface_id and state not in ('completed', 'discarded');

	update public.qorpera_surface_explorations
	set status = 'discarded', resolved_at = v_now
	where surface_id = p_surface_id and status = 'open';

	update public.qorpera_member_surface_state
	set active_exploration_session_id = null, compare_session_ids = '{}'::uuid[]
	where surface_id = p_surface_id;

	delete from public.qorpera_surface_publish_asks where surface_id = p_surface_id;

	return v_surface;
end $$;

create or replace function public.qorpera_archive_surface(p_surface_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);

	v_surface := public.qorpera_surface_remove(p_surface_id, true);
	return public.qorpera_surface_summary_json(v_surface);
end $$;

create function public.qorpera_surface_refuse_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_status text;
begin
	-- WHY: FOR KEY SHARE waits for a delete's FOR UPDATE, so work that starts beside a delete is refused, not left running.
	select s.status into v_status from public.qorpera_surfaces s where s.id = new.surface_id for key share;
	if v_status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;
	return new;
end $$;

create trigger qorpera_surface_sessions_refuse_removed
	before insert on public.qorpera_surface_sessions
	for each row execute function public.qorpera_surface_refuse_removed();

create trigger qorpera_surface_sessions_refuse_removed_reopen
	before update of state on public.qorpera_surface_sessions
	for each row when (old.state in ('completed', 'discarded') and new.state not in ('completed', 'discarded'))
	execute function public.qorpera_surface_refuse_removed();

create trigger qorpera_surface_jobs_refuse_removed
	before insert on public.qorpera_surface_jobs
	for each row execute function public.qorpera_surface_refuse_removed();

select pg_temp.sds_patch('public.qorpera_surface_trigger_automation(uuid)'::regprocedure, array[
$old$	if v_surface.id is null then
		select * into v_surface
		from public.qorpera_surfaces s
		where s.profile_id = v_auto.profile_id and s.status = 'active'
		order by s.sort_order asc, s.created_at asc
		limit 1;
	end if;$old$,
$new$	-- WHY: 20260930875000: a scheduled agent whose own interface is gone does not run on another one.
	if v_surface.id is null and v_auto.target_surface_slug is null then
		select * into v_surface
		from public.qorpera_surfaces s
		where s.profile_id = v_auto.profile_id and s.status = 'active'
		order by s.sort_order asc, s.created_at asc
		limit 1;
	end if;$new$
]);

-- WHY: delete is final: its scheduled agents and open work are gone, so nothing may approve, publish or ask on the shell.
select pg_temp.sds_patch('public.qorpera_approve_proposed_surface(uuid)'::regprocedure, array[
$old$	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);
$old$,
$new$	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);
	if v_surface.status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;
$new$
]);

select pg_temp.sds_patch('public.qorpera_ask_surface_publish(uuid,uuid)'::regprocedure, array[
$old$	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);
	if p_user_id is null or p_user_id = v_user_id then$old$,
$new$	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);
	if v_surface.status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;
	if p_user_id is null or p_user_id = v_user_id then$new$
]);

select pg_temp.sds_patch('public.qorpera_publish_surface(uuid)'::regprocedure, array[
$old$	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);

	if v_surface.source_kind = 'code_repo' and v_surface.repository_key is not null then$old$,
$new$	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);
	if v_surface.status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;

	if v_surface.source_kind = 'code_repo' and v_surface.repository_key is not null then$new$
]);

revoke all on function
	public.qorpera_surface_remove(uuid, boolean),
	public.qorpera_surface_refuse_removed()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_archive_surface(uuid)'::regprocedure,
			'public.qorpera_surface_remove(uuid,boolean)'::regprocedure,
			'public.qorpera_surface_refuse_removed()'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface delete function has an API owner: %', v_owner;
		end if;
		execute format('grant select, update on public.qorpera_surfaces, public.qorpera_surface_sessions, public.qorpera_surface_jobs, public.qorpera_surface_changes, public.qorpera_surface_explorations, public.qorpera_member_surface_state to %I', v_owner);
		execute format('grant select, delete on public.qorpera_surface_automations, public.qorpera_surface_publish_asks to %I', v_owner);
		execute format('grant execute on function public.qorpera_surface_remove(uuid, boolean), public.qorpera_surface_cancel_coding_workers(uuid[], text) to %I', v_owner);
	end loop;
end $$;

-- WHY: surfaces archived before this migration (the web's Delete since 23 Nov, dismissed proposals, the Members page)
-- get the same settling, so no archived surface keeps a working session, a waiting job or a scheduled agent.
do $$
declare
	v_id uuid;
begin
	for v_id in
		select s.id from public.qorpera_surfaces s where s.status = 'archived' order by s.profile_id, s.id
	loop
		perform public.qorpera_surface_remove(v_id, false);
	end loop;
end $$;

drop function pg_temp.sds_patch(regprocedure, text[]);
