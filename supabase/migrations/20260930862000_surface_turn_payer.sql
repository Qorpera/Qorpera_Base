-- WHY: A member's reply in a surface session is that member's own turn: their login pays for it and for what follows,
-- as for agent threads (contract 2026-09-28). Before this, every turn was paid by the session's creator.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)') is null
		or to_regprocedure('public.qorpera_surface_coding_member_initiated(public.qorpera_surface_sessions,uuid)') is null then
		raise exception '20260930862000 requires 20260930857000 and 20260930860000';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_surface_sessions' and column_name = 'turn_requested_by_user_id'
	) then
		raise exception '20260930862000 is already applied';
	end if;
end $$;

create function pg_temp.stp_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930862000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930862000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surface_sessions
	add column turn_requested_by_user_id uuid references auth.users(id) on delete set null;

create function public.qorpera_surface_turn_requester(p_session public.qorpera_surface_sessions)
returns uuid language sql immutable set search_path = '' as $$
	select coalesce(p_session.turn_requested_by_user_id, p_session.created_by_user_id)
$$;

create function public.qorpera_surface_turn_member_initiated(p_session public.qorpera_surface_sessions)
returns boolean language sql immutable set search_path = '' as $$
	select p_session.id is not null and (
		p_session.turn_requested_by_user_id is not null
		or (p_session.origin_kind in ('member', 'point_to_change', 'cross_surface') and p_session.created_by_user_id is not null)
	)
$$;

create or replace function public.qorpera_surface_coding_member_initiated(
	p_session public.qorpera_surface_sessions,
	p_requester_user_id uuid
)
returns boolean language sql immutable set search_path = '' as $$
	select p_requester_user_id is not null
		and public.qorpera_surface_turn_member_initiated(p_session)
		and public.qorpera_surface_turn_requester(p_session) = p_requester_user_id
$$;

select pg_temp.stp_patch('public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure, array[
$old$	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
$old$,
$new$	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	-- WHY: after the session lock, so the sponsor binding is locked in the same order as the enqueue takes it.
	if exists (
		select 1 from public.qorpera_surfaces surf
		where surf.id = v_session.surface_id and surf.source_kind = 'code_repo'
	) then
		case coalesce(public.qorpera_surface_resolve_coding_sponsor(
			v_session.profile_id,
			(select c.environment_id from public.qorpera_company_cofounders c where c.profile_id = v_session.profile_id limit 1),
			v_user_id,
			true,
			(select cs.harness from public.qorpera_coding_sessions cs where cs.worker_id = v_session.worker_id),
			v_session.worker_id is not null
		) ->> 'status', '')
			when 'ok', 'no_coding_executor' then null;
			else
				raise exception 'Connect a model account in Settings → AI subscriptions to reply' using errcode = '42501';
		end case;
	elsif nullif(public.qorpera_surface_resolve_sponsor(v_session.profile_id, v_user_id) ->> 'sponsorBindingId', '') is null then
		raise exception 'Connect a model account in Settings → AI subscriptions to reply' using errcode = '42501';
	end if;
$new$,
$old$		wake_id = case when worker_id is not null then null else wake_id end,
		retry_count = 0,$old$,
$new$		wake_id = case when worker_id is not null then null else wake_id end,
		turn_requested_by_user_id = v_user_id,
		retry_count = 0,$new$
]);

select pg_temp.stp_patch('public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure, array[
$old$	v_member_initiated := v_peek.origin_kind in ('member', 'point_to_change', 'cross_surface')
		and v_peek.created_by_user_id is not null;$old$,
$new$	v_member_initiated := public.qorpera_surface_turn_member_initiated(v_peek);$new$,
$old$		where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id;$old$,
$new$		where m.profile_id = v_peek.profile_id and m.user_id = public.qorpera_surface_turn_requester(v_peek);$new$,
$old$			coalesce(v_worker.owner_user_id, v_requester),$old$,
$new$			v_requester,$new$,
$old$				owner_sponsor_binding_id = (v_coding_sponsor ->> 'bindingId')::uuid,
				owner_sponsor_version = (v_coding_sponsor ->> 'version')::bigint,
				dispatch = jsonb_set(dispatch, '{followUp}', to_jsonb(v_followup)),$old$,
$new$				owner_user_id = v_requester,
				requested_by_user_id = v_requester,
				owner_sponsor_binding_id = (v_coding_sponsor ->> 'bindingId')::uuid,
				owner_sponsor_version = (v_coding_sponsor ->> 'version')::bigint,
				dispatch = jsonb_set(dispatch, '{followUp}', to_jsonb(v_followup)),$new$
]);

select pg_temp.stp_patch('public.qorpera_pin_wake_occurrence()'::regprocedure, array[
$old$		v_surf_member_initiated := v_surf_session.origin_kind in ('member', 'point_to_change', 'cross_surface')
			and v_surf_session.created_by_user_id is not null;$old$,
$new$		v_surf_member_initiated := public.qorpera_surface_turn_member_initiated(v_surf_session);$new$,
$old$			where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id;$old$,
$new$			where m.profile_id = new.profile_id and m.user_id = public.qorpera_surface_turn_requester(v_surf_session);$new$
]);

select pg_temp.stp_patch('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure, array[
$old$							and coalesce(v_wake.payload ->> 'originKind', '') in ('member', 'point_to_change', 'cross_surface')
							and coalesce((v_wake.payload ->> 'memberInitiated')::boolean, false)
							and exists (
								select 1 from public.qorpera_surface_sessions s
								where s.id = v_wake.source_id and s.profile_id = v_wake.profile_id
									and s.origin_kind in ('member', 'point_to_change', 'cross_surface')
									and s.created_by_user_id is not null
									and s.created_by_user_id = v_wake.requested_by_user_id
							))$old$,
$new$							and coalesce((v_wake.payload ->> 'memberInitiated')::boolean, false)
							and v_wake.requested_by_user_id is not null
							and exists (
								select 1 from public.qorpera_surface_sessions s
								where s.id = v_wake.source_id and s.profile_id = v_wake.profile_id
							))$new$
]);

select pg_temp.stp_patch('public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure, array[
$old$			and s.origin_kind in ('member', 'point_to_change', 'cross_surface')
			and s.created_by_user_id is not null
			and s.created_by_user_id = p_run.requested_by_user_id$old$,
$new$			and coalesce((w.payload ->> 'memberInitiated')::boolean, false)
			and w.requested_by_user_id is not null
			and w.requested_by_user_id = p_run.requested_by_user_id$new$
]);

select pg_temp.stp_patch('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure, array[
$old$'sponsor', public.qorpera_surface_resolve_sponsor(c.profile_id, c.created_by_user_id),$old$,
$new$'sponsor', public.qorpera_surface_resolve_sponsor(c.profile_id, coalesce(c.turn_requested_by_user_id, c.created_by_user_id)),$new$
]);

revoke all on function
	public.qorpera_surface_turn_requester(public.qorpera_surface_sessions),
	public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
			'public.qorpera_pin_wake_occurrence()'::regprocedure,
			'public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
			'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure,
			'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
			'public.qorpera_surface_coding_member_initiated(public.qorpera_surface_sessions,uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface turn payer function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_turn_requester(public.qorpera_surface_sessions), public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions) to %I', v_owner);
	end loop;
end $$;

drop function pg_temp.stp_patch(regprocedure, text[]);
