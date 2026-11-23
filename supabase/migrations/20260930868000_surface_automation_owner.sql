-- WHY: A surface automation is one member's own work (Jonas, 23 Nov 2026, multiplayer in place): its owner's login pays
-- for its runs, it is handed over by an offer the teammate answers, and one whose owner left runs on nobody's login.
-- Before this, every automation run fell back to the Co-Founder's creator, then to the oldest owner.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_trigger_automation(uuid)') is null
		or to_regprocedure('public.qorpera_surface_coding_member_initiated(public.qorpera_surface_sessions,uuid)') is null
		or to_regprocedure('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)') is null then
		raise exception '20260930868000 requires 20260930844000, 20260930857000 and 20260930859000';
	end if;
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_surface_automations' and column_name = 'owner_user_id'
	) then
		raise exception '20260930868000 is already applied';
	end if;
end $$;

create function pg_temp.sao_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930868000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930868000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surface_automations
	add column owner_user_id uuid references auth.users(id) on delete set null;

update public.qorpera_surface_automations a
set owner_user_id = (
	select m.user_id from public.qorpera_profile_members m
	where m.profile_id = a.profile_id and m.role <> 'viewer'
		and m.user_id = coalesce(a.created_by_user_id,
			(select c.created_by_user_id from public.qorpera_company_cofounders c where c.profile_id = a.profile_id limit 1))
);

create table public.qorpera_surface_automation_offers (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	automation_id uuid not null references public.qorpera_surface_automations(id) on delete cascade,
	from_user_id uuid references auth.users(id) on delete set null,
	to_user_id uuid references auth.users(id) on delete set null,
	offered_by_user_id uuid references auth.users(id) on delete set null,
	status text not null default 'open' check (status in ('open', 'yes', 'no', 'withdrawn', 'void')),
	created_at timestamptz not null default clock_timestamp(),
	answered_at timestamptz,
	check ((status = 'open') = (answered_at is null))
);
create unique index qorpera_surface_automation_offers_one_open
	on public.qorpera_surface_automation_offers(automation_id) where status = 'open';
create index qorpera_surface_automation_offers_latest
	on public.qorpera_surface_automation_offers(automation_id, created_at desc);
alter table public.qorpera_surface_automation_offers enable row level security;
revoke all on public.qorpera_surface_automation_offers
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_automation_json(p_row public.qorpera_surface_automations)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'id', p_row.id,
		'key', p_row.key,
		'title', p_row.title,
		'prompt', p_row.prompt,
		'scheduleSummary', p_row.schedule_summary,
		'targetSurfaceSlug', p_row.target_surface_slug,
		'outputMode', p_row.output_mode,
		'enabled', p_row.enabled,
		'status', case when p_row.enabled then p_row.status else 'paused' end,
		'lastRunAt', p_row.last_run_at,
		'lastOutcomeSummary', p_row.last_outcome_summary,
		'nextRunAt', p_row.next_run_at,
		'ownable', true,
		'ownerUserId', p_row.owner_user_id,
		'offer', (
			select jsonb_build_object(
				'id', o.id,
				'fromUserId', o.from_user_id,
				'toUserId', o.to_user_id,
				'offeredByUserId', o.offered_by_user_id,
				'status', o.status,
				'answeredAt', o.answered_at
			)
			from (
				select * from public.qorpera_surface_automation_offers latest
				where latest.automation_id = p_row.id
				order by latest.created_at desc
				limit 1
			) o
			where o.status = 'open' or (o.status = 'no' and o.answered_at > clock_timestamp() - interval '1 day')
		)
	)
$$;

-- WHY: Null means it may run; 'nobody' when no member who may pay owns it, 'no_login' when the owner has no login that pays.
-- Volatile: a code_repo target asks the coding resolver, which records the owner's coding sponsor as an enqueue would.
create function public.qorpera_surface_automation_payer_problem(
	p_profile_id uuid,
	p_owner_user_id uuid,
	p_target_surface_slug text
)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_sponsor jsonb;
begin
	if p_owner_user_id is null or not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = p_profile_id and m.user_id = p_owner_user_id and m.role <> 'viewer'
	) then
		return 'nobody';
	end if;
	if exists (
		select 1 from public.qorpera_surfaces s
		where s.profile_id = p_profile_id and s.slug = p_target_surface_slug and s.status = 'active'
			and s.source_kind = 'code_repo'
	) then
		v_sponsor := public.qorpera_surface_resolve_coding_sponsor(
			p_profile_id,
			(select c.environment_id from public.qorpera_company_cofounders c where c.profile_id = p_profile_id limit 1),
			p_owner_user_id,
			false
		);
		return case when v_sponsor ->> 'status' in ('ok', 'no_coding_executor') then null else 'no_login' end;
	end if;
	v_sponsor := public.qorpera_surface_resolve_sponsor(p_profile_id, p_owner_user_id);
	if nullif(v_sponsor ->> 'sponsorBindingId', '') is null or nullif(v_sponsor ->> 'sponsorVersion', '') is null then
		return 'no_login';
	end if;
	return null;
end $$;

create function public.qorpera_surface_automation_default_owner()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if new.owner_user_id is null then
		select m.user_id into new.owner_user_id
		from public.qorpera_profile_members m
		where m.profile_id = new.profile_id and m.role <> 'viewer'
			and m.user_id = coalesce(new.created_by_user_id,
				(select c.created_by_user_id from public.qorpera_company_cofounders c where c.profile_id = new.profile_id limit 1));
	end if;
	return new;
end $$;
create trigger qorpera_surface_automation_default_owner
	before insert on public.qorpera_surface_automations
	for each row execute function public.qorpera_surface_automation_default_owner();

create function public.qorpera_surface_automation_owner_left()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'UPDATE' and new.role <> 'viewer' then
		return null;
	end if;
	update public.qorpera_surface_automations
	set owner_user_id = null, updated_at = clock_timestamp()
	where profile_id = old.profile_id and owner_user_id = old.user_id;
	update public.qorpera_surface_automation_offers
	set status = 'void', answered_at = clock_timestamp()
	where profile_id = old.profile_id and status = 'open'
		and old.user_id in (from_user_id, to_user_id, offered_by_user_id);
	return null;
end $$;
create trigger qorpera_surface_automation_owner_left
	after delete or update of role on public.qorpera_profile_members
	for each row execute function public.qorpera_surface_automation_owner_left();

create function public.qorpera_surface_automation_offer_lost_member()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	if new.status = 'open' and ((old.to_user_id is not null and new.to_user_id is null)
		or (old.from_user_id is not null and new.from_user_id is null)
		or (old.offered_by_user_id is not null and new.offered_by_user_id is null)) then
		new.status := 'void';
		new.answered_at := clock_timestamp();
	end if;
	return new;
end $$;
create trigger qorpera_surface_automation_offer_lost_member
	before update of to_user_id, from_user_id, offered_by_user_id on public.qorpera_surface_automation_offers
	for each row execute function public.qorpera_surface_automation_offer_lost_member();

create function public.qorpera_offer_surface_automation(p_automation_id uuid, p_to_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_actor uuid;
	v_row public.qorpera_surface_automations%rowtype;
	v_role public.qorpera_profile_role;
	v_offer_id uuid;
begin
	if p_automation_id is null or p_to_user_id is null then
		raise exception 'Automation and member are required' using errcode = '22023';
	end if;
	select * into v_row from public.qorpera_surface_automations where id = p_automation_id;
	if v_row.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
	v_actor := public.qorpera_assert_surface_member(v_row.profile_id, true);
	perform 1 from public.qorpera_profile_members
		where profile_id = v_row.profile_id and user_id in (v_actor, p_to_user_id)
		order by user_id for share;
	select * into v_row from public.qorpera_surface_automations where id = p_automation_id for update;
	if v_row.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
	select m.role into v_role from public.qorpera_profile_members m
		where m.profile_id = v_row.profile_id and m.user_id = v_actor;
	if v_role is null or v_role = 'viewer' then
		raise exception 'Editor membership required' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_row.profile_id and m.user_id = p_to_user_id and m.role <> 'viewer'
	) then
		raise exception 'That member cannot own automations' using errcode = '22023';
	end if;
	if v_row.owner_user_id is not distinct from p_to_user_id then
		return jsonb_build_object('moved', true, 'automation', public.qorpera_surface_automation_json(v_row));
	end if;
	if exists (
		select 1 from public.qorpera_surface_automation_offers
		where automation_id = v_row.id and status = 'open'
	) then
		raise exception 'It is already offered to someone' using errcode = '55P03';
	end if;
	if v_row.owner_user_id is null and p_to_user_id = v_actor then
		update public.qorpera_surface_automations
		set owner_user_id = v_actor, status = case
				when status not in ('idle', 'needs_attention') then status
				when public.qorpera_surface_automation_payer_problem(profile_id, v_actor, target_surface_slug) is null then 'idle'
				else 'needs_attention'
			end,
			updated_at = clock_timestamp()
		where id = v_row.id
		returning * into v_row;
		return jsonb_build_object('moved', true, 'automation', public.qorpera_surface_automation_json(v_row));
	end if;
	if p_to_user_id = v_actor or not (v_actor = v_row.owner_user_id or v_role in ('owner', 'admin')) then
		raise exception 'Only its owner, or an owner or admin, can hand it over' using errcode = '42501';
	end if;
	insert into public.qorpera_surface_automation_offers(profile_id, automation_id, from_user_id, to_user_id, offered_by_user_id)
	values (v_row.profile_id, v_row.id, v_row.owner_user_id, p_to_user_id, v_actor)
	returning id into v_offer_id;
	update public.qorpera_surface_automations set updated_at = clock_timestamp() where id = v_row.id
	returning * into v_row;
	return jsonb_build_object('moved', false, 'automation', public.qorpera_surface_automation_json(v_row));
end $$;
revoke all on function public.qorpera_offer_surface_automation(uuid, uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_offer_surface_automation(uuid, uuid) to authenticated;

create function public.qorpera_answer_surface_automation_offer(p_offer_id uuid, p_yes boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_actor uuid;
	v_offer public.qorpera_surface_automation_offers%rowtype;
	v_row public.qorpera_surface_automations%rowtype;
	v_status text;
begin
	if p_offer_id is null or p_yes is null then
		raise exception 'Offer and answer are required' using errcode = '22023';
	end if;
	select * into v_offer from public.qorpera_surface_automation_offers where id = p_offer_id;
	if v_offer.id is null then raise exception 'That offer is not here' using errcode = '42501'; end if;
	v_actor := public.qorpera_assert_surface_member(v_offer.profile_id, false);
	perform 1 from public.qorpera_profile_members
		where profile_id = v_offer.profile_id and user_id in (v_actor, v_offer.to_user_id)
		order by user_id for share;
	select * into v_row from public.qorpera_surface_automations where id = v_offer.automation_id for update;
	select * into v_offer from public.qorpera_surface_automation_offers where id = p_offer_id for update;
	if v_offer.id is null then raise exception 'That offer is not here' using errcode = '42501'; end if;
	if v_offer.status <> 'open' then
		return jsonb_build_object('status', v_offer.status, 'moved', false,
			'automation', public.qorpera_surface_automation_json(v_row));
	end if;
	if v_actor = v_offer.to_user_id then
		v_status := case when p_yes then 'yes' else 'no' end;
	elsif not p_yes and v_actor in (v_offer.offered_by_user_id, v_offer.from_user_id) then
		v_status := 'withdrawn';
	else
		raise exception 'Only the member it is offered to can answer' using errcode = '42501';
	end if;
	if v_status = 'yes' then
		if v_row.owner_user_id is distinct from v_offer.from_user_id or not exists (
			select 1 from public.qorpera_profile_members m
			where m.profile_id = v_offer.profile_id and m.user_id = v_offer.to_user_id and m.role <> 'viewer'
		) then
			v_status := 'void';
		else
			update public.qorpera_surface_automations
			set owner_user_id = v_offer.to_user_id,
				status = case
					when status not in ('idle', 'needs_attention') then status
					when public.qorpera_surface_automation_payer_problem(profile_id, v_offer.to_user_id, target_surface_slug) is null
						then 'idle'
					else 'needs_attention'
				end
			where id = v_row.id;
		end if;
	end if;
	update public.qorpera_surface_automation_offers set status = v_status, answered_at = clock_timestamp() where id = p_offer_id;
	update public.qorpera_surface_automations set updated_at = clock_timestamp() where id = v_row.id
	returning * into v_row;
	return jsonb_build_object('status', v_status, 'moved', v_status = 'yes',
		'automation', public.qorpera_surface_automation_json(v_row));
end $$;
revoke all on function public.qorpera_answer_surface_automation_offer(uuid, boolean) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_answer_surface_automation_offer(uuid, boolean) to authenticated;

select pg_temp.sao_patch('public.qorpera_list_automations(uuid)'::regprocedure, array[
$old$				select
					jsonb_build_object(
						'id', a.id,
						'key', a.key,
						'title', a.title,
						'prompt', a.prompt,
						'scheduleSummary', a.schedule_summary,
						'targetSurfaceSlug', a.target_surface_slug,
						'outputMode', a.output_mode,
						'enabled', a.enabled,
						'status', case when a.enabled then a.status else 'paused' end,
						'lastRunAt', a.last_run_at,
						'lastOutcomeSummary', a.last_outcome_summary,
						'nextRunAt', a.next_run_at
					) as item,$old$,
$new$				select
					public.qorpera_surface_automation_json(a) as item,$new$,
$old$						'nextRunAt', null
					) as item,$old$,
$new$						'nextRunAt', null,
						'ownable', false,
						'ownerUserId', null,
						'offer', null
					) as item,$new$
]);

select pg_temp.sao_patch('public.qorpera_create_surface_automation(uuid,text,text,text,text)'::regprocedure, array[
$old$	return jsonb_build_object(
		'id', v_row.id,
		'key', v_row.key,
		'title', v_row.title,
		'prompt', v_row.prompt,
		'scheduleSummary', v_row.schedule_summary,
		'targetSurfaceSlug', v_row.target_surface_slug,
		'outputMode', v_row.output_mode,
		'enabled', v_row.enabled,
		'status', v_row.status,
		'lastRunAt', v_row.last_run_at,
		'lastOutcomeSummary', v_row.last_outcome_summary,
		'nextRunAt', v_row.next_run_at
	);$old$,
$new$	return public.qorpera_surface_automation_json(v_row);$new$
]);

select pg_temp.sao_patch('public.qorpera_update_surface_automation(uuid,text,text,text,text,boolean)'::regprocedure, array[
$old$	return jsonb_build_object(
		'id', v_row.id,
		'key', v_row.key,
		'title', v_row.title,
		'prompt', v_row.prompt,
		'scheduleSummary', v_row.schedule_summary,
		'targetSurfaceSlug', v_row.target_surface_slug,
		'outputMode', v_row.output_mode,
		'enabled', v_row.enabled,
		'status', case when v_row.enabled then v_row.status else 'paused' end,
		'lastRunAt', v_row.last_run_at,
		'lastOutcomeSummary', v_row.last_outcome_summary,
		'nextRunAt', v_row.next_run_at
	);$old$,
$new$	return public.qorpera_surface_automation_json(v_row);$new$
]);

select pg_temp.sao_patch('public.qorpera_toggle_automation(uuid,boolean)'::regprocedure, array[
$old$		return jsonb_build_object(
			'id', v_auto.id,
			'key', v_auto.key,
			'title', v_auto.title,
			'prompt', v_auto.prompt,
			'scheduleSummary', v_auto.schedule_summary,
			'targetSurfaceSlug', v_auto.target_surface_slug,
			'outputMode', v_auto.output_mode,
			'enabled', v_auto.enabled,
			'status', v_auto.status,
			'lastRunAt', v_auto.last_run_at,
			'lastOutcomeSummary', v_auto.last_outcome_summary,
			'nextRunAt', v_auto.next_run_at
		);$old$,
$new$		return public.qorpera_surface_automation_json(v_auto);$new$
]);

select pg_temp.sao_patch('public.qorpera_surface_claim_due_automations(integer)'::regprocedure, array[
$old$			select a.id
			from public.qorpera_surface_automations a
			where a.enabled = true$old$,
$new$			select a.id, public.qorpera_surface_automation_payer_problem(a.profile_id, a.owner_user_id, a.target_surface_slug) as problem
			from public.qorpera_surface_automations a
			where a.enabled = true$new$,
$old$			last_run_at = v_now,
			next_run_at = public.qorpera_compute_next_automation_run(a.schedule_summary, v_now),
			status = 'idle',$old$,
$new$			last_run_at = case when picked.problem is null then v_now else a.last_run_at end,
			next_run_at = public.qorpera_compute_next_automation_run(a.schedule_summary, v_now),
			status = case when picked.problem is null then 'idle' else 'needs_attention' end,$new$,
$old$	loop
		v_session_id := null;$old$,
$new$	loop
		continue when v_auto.status = 'needs_attention';
		v_session_id := null;$new$,
$old$					origin_kind, origin_label, state, base_sha
				)
				values (
					v_auto.profile_id, v_surface.id, v_machine_id, left(v_auto.title, 160), v_auto.prompt,
					'automation', v_auto.title, 'queued', v_surface.live_head_sha
				)$old$,
$new$					origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
				)
				values (
					v_auto.profile_id, v_surface.id, v_machine_id, left(v_auto.title, 160), v_auto.prompt,
					'automation', v_auto.title, jsonb_build_object('automationId', v_auto.id), v_auto.owner_user_id,
					'queued', v_surface.live_head_sha
				)$new$
]);

select pg_temp.sao_patch('public.qorpera_surface_trigger_automation(uuid)'::regprocedure, array[
$old$	v_session jsonb;
begin$old$,
$new$	v_session jsonb;
	v_problem text;
begin$new$,
$old$	if public.qorpera_surface_company_paused(v_auto.profile_id) then
		return jsonb_build_object('status', 'skipped', 'reason', 'paused');
	end if;$old$,
$new$	if public.qorpera_surface_company_paused(v_auto.profile_id) then
		return jsonb_build_object('status', 'skipped', 'reason', 'paused');
	end if;
	v_problem := public.qorpera_surface_automation_payer_problem(v_auto.profile_id, v_auto.owner_user_id, v_auto.target_surface_slug);
	if v_problem is not null then
		return jsonb_build_object('status', 'skipped', 'reason', v_problem);
	end if;$new$,
$old$	return jsonb_build_object('status', 'started', 'session', v_session);$old$,
$new$	update public.qorpera_surface_sessions
	set created_by_user_id = v_auto.owner_user_id, origin_ref = jsonb_build_object('automationId', v_auto.id)
	where id = (v_session ->> 'sessionId')::uuid;
	return jsonb_build_object('status', 'started', 'session', v_session);$new$
]);

select pg_temp.sao_patch('public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure, array[
$old$	else
		v_requester := coalesce($old$,
$new$	elsif v_peek.origin_ref ? 'automationId' then
		select m.user_id into v_requester
		from public.qorpera_profile_members m
		where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id and m.role <> 'viewer';
	else
		v_requester := coalesce($new$
]);

select pg_temp.sao_patch('public.qorpera_pin_wake_occurrence()'::regprocedure, array[
$old$		else
			new.requested_by_user_id := coalesce(
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id),$old$,
$new$		elsif v_surf_session.origin_ref ? 'automationId' then
			select m.user_id into new.requested_by_user_id
			from public.qorpera_profile_members m
			where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id and m.role <> 'viewer';
		else
			new.requested_by_user_id := coalesce(
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id),$new$
]);

revoke all on function
	public.qorpera_surface_automation_json(public.qorpera_surface_automations),
	public.qorpera_surface_automation_payer_problem(uuid, uuid, text),
	public.qorpera_surface_automation_default_owner(),
	public.qorpera_surface_automation_owner_left(),
	public.qorpera_surface_automation_offer_lost_member()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_list_automations(uuid)'::regprocedure,
			'public.qorpera_create_surface_automation(uuid,text,text,text,text)'::regprocedure,
			'public.qorpera_update_surface_automation(uuid,text,text,text,text,boolean)'::regprocedure,
			'public.qorpera_toggle_automation(uuid,boolean)'::regprocedure,
			'public.qorpera_surface_claim_due_automations(integer)'::regprocedure,
			'public.qorpera_surface_trigger_automation(uuid)'::regprocedure,
			'public.qorpera_offer_surface_automation(uuid,uuid)'::regprocedure,
			'public.qorpera_answer_surface_automation_offer(uuid,boolean)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface automation owner function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_automation_json(public.qorpera_surface_automations), public.qorpera_surface_automation_payer_problem(uuid, uuid, text) to %I', v_owner);
	end loop;
end $$;

drop function pg_temp.sao_patch(regprocedure, text[]);
