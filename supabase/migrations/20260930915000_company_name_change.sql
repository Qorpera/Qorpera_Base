set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_company_renames') is not null then
		raise exception '20260930915000 is already applied';
	end if;
	if to_regprocedure('public.qorpera_native_list_company_interfaces(jsonb)') is null
		or to_regprocedure('public.qorpera_live_hint_internal()') is null
		or to_regprocedure('public.qorpera_light_ask_sponsor(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_folder_converge_company(uuid)') is null
		or to_regprocedure('public.qorpera_good_will_billing(text,text,jsonb)') is null
		or to_regprocedure('public.qorpera_good_will_tick(date)') is null
		or to_regprocedure('public.qorpera_surface_ensure_site(uuid)') is null
		or to_regprocedure('public.qorpera_begin_action_review(jsonb,jsonb)') is null then
		raise exception '20260930915000 prerequisites are missing';
	end if;
end $$;

create temporary table cnc_before as
select oid, prosecdef, proconfig, provolatile, proacl
from pg_proc
where oid in (
	'public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	'public.qorpera_update_company_founding(uuid,bigint,text,text)'::regprocedure,
	'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	'public.qorpera_surface_ensure_site(uuid)'::regprocedure,
	'public.qorpera_list_hosted_profiles()'::regprocedure,
	'public.qorpera_native_list_company_interfaces(jsonb)'::regprocedure,
	'public.qorpera_live_hint_internal()'::regprocedure,
	'public.qorpera_folder_converge_company(uuid)'::regprocedure,
	'public.qorpera_pin_wake_occurrence()'::regprocedure,
	'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	'public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	'public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	'public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure,
	'public.qorpera_good_will_billing(text,text,jsonb)'::regprocedure,
	'public.qorpera_good_will_tick(date)'::regprocedure
);

create function pg_temp.cnc_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930915000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		if p_pairs[v_i] is null or p_pairs[v_i] = '' then
			raise exception '20260930915000: empty anchor in %', p_target;
		end if;
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930915000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_profiles
	add column name_changed_at timestamptz;

-- WHY: environment_id has no FK to qorpera_folder_clocks so qorpera_folder_converge_company inserts
-- without taking folder-clock or fence locks; profile_id cascade handles company deletion.
create table public.qorpera_company_renames (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	old_name text not null check (char_length(old_name) between 1 and 120),
	new_name text not null check (char_length(new_name) between 1 and 120 and new_name <> old_name),
	commit_id uuid,
	vision_seq bigint,
	actor_kind text check (actor_kind is null or actor_kind in ('member', 'staff_agent', 'platform')),
	actor_id uuid,
	renamed_by_user_id uuid references auth.users(id) on delete set null,
	wake_state text not null default 'pending' check (wake_state in ('pending', 'woken', 'skipped', 'unpaid')),
	wake_id uuid unique,
	wake_problem text check (wake_problem is null or char_length(wake_problem) between 1 and 64),
	wake_attempts integer not null default 0 check (wake_attempts >= 0),
	wake_last_attempt_at timestamptz,
	stripe_sync_state text not null default 'none' check (stripe_sync_state in ('none', 'pending', 'synced')),
	stripe_synced_at timestamptz,
	audit_due_at timestamptz not null default (clock_timestamp() + interval '30 minutes'),
	audit_state text not null default 'pending' check (audit_state in ('pending', 'completed', 'superseded')),
	audit_completed_at timestamptz,
	audit_outcome text check (audit_outcome is null or audit_outcome in ('clean', 'needs_attention', 'failed')),
	audit_report jsonb check (audit_report is null or jsonb_typeof(audit_report) = 'object'),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check ((wake_state = 'woken') = (wake_id is not null)),
	check ((audit_state = 'completed') = (audit_completed_at is not null and audit_outcome is not null and audit_report is not null))
);

create index qorpera_company_renames_profile_created
	on public.qorpera_company_renames(profile_id, created_at desc, id desc);
create index qorpera_company_renames_pending_wake
	on public.qorpera_company_renames(environment_id, created_at, id)
	where wake_state = 'pending';
create index qorpera_company_renames_pending_audit
	on public.qorpera_company_renames(audit_due_at, id)
	where audit_state = 'pending';
create index qorpera_company_renames_pending_stripe
	on public.qorpera_company_renames(profile_id, created_at desc)
	where stripe_sync_state = 'pending';

alter table public.qorpera_company_renames enable row level security;
revoke all on public.qorpera_company_renames
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_kinds text[];
	v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition
	from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check'
		and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception '20260930915000: wake source kinds differ: %', v_definition;
	end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	if not ('human-task' = any (v_kinds) and 'light-ask' = any (v_kinds))
		or 'company-rename' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception '20260930915000: wake source kinds differ: %', v_definition;
	end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format(
		'alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality)
			from unnest(v_kinds || array['company-rename']) with ordinality as listed(kind, ordinality))
	);
end $$;

-- WHY: Gates company-rename wakes until the active runtime bundle includes the parser so live older runners never fail on unknown source.kind.
create function public.qorpera_company_rename_wake_ready()
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton
			and bundle.manifest -> 'implementation' ? 'packages/runtime/src/cloud-company-rename-wake.ts'
	)
$$;
revoke all on function public.qorpera_company_rename_wake_ready()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_company_rename_sponsor(
	p_profile_id uuid,
	p_renamed_by uuid,
	p_cofounder_id uuid
)
returns table(payer_user_id uuid, binding_id uuid, version bigint, member_initiated boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
	v_binding uuid;
	v_version bigint;
	v_creator uuid;
begin
	if p_profile_id is null or p_cofounder_id is null then
		return;
	end if;
	if p_renamed_by is not null and exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = p_profile_id and m.user_id = p_renamed_by
	) then
		select s.binding_id, s.version into v_binding, v_version
		from public.qorpera_light_ask_sponsor(p_profile_id, p_renamed_by) s;
		if v_binding is not null then
			return query select p_renamed_by, v_binding, v_version, true;
			return;
		end if;
		select s.binding_id, s.version into v_binding, v_version
		from public.qorpera_starter_sponsor(p_profile_id, p_renamed_by, p_cofounder_id, null) s;
		if v_binding is not null then
			return query select p_renamed_by, v_binding, v_version, true;
			return;
		end if;
	end if;
	select c.created_by_user_id into v_creator
	from public.qorpera_company_cofounders c
	where c.profile_id = p_profile_id
	limit 1;
	if v_creator is not null then
		select s.binding_id, s.version into v_binding, v_version
		from public.qorpera_starter_sponsor(p_profile_id, v_creator, p_cofounder_id, null) s
		where not public.qorpera_sponsor_version_is_chatgpt_plan(s.binding_id, s.version);
		if v_binding is not null then
			return query select v_creator, v_binding, v_version, false;
			return;
		end if;
	end if;
end $$;
revoke all on function public.qorpera_company_rename_sponsor(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.cnc_patch(
	'public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	array[
		$old$if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 120) then v_bad := array_append(v_bad, 'name'); end if;$old$,
		$new$if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 120)
			or (p_parse ->> 'name') ~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*$' then
			v_bad := array_append(v_bad, 'name');
		end if;$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_update_company_founding(uuid,bigint,text,text)'::regprocedure,
	array[
		$old$update public.qorpera_profiles set name = v_name where id = p_profile_id and name is distinct from v_name;$old$,
		$new$update public.qorpera_profiles set name = v_name where id = p_profile_id and name is distinct from v_name;
		update public.qorpera_company_environments set name = v_name where profile_id = p_profile_id and name is distinct from v_name;$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	array[
		$old$'name', (select profile.name from public.qorpera_profiles as profile where profile.id = v_run.profile_id)),$old$,
		$new$'name', coalesce(
			(select idx.name from public.qorpera_folder_company_index as idx where idx.environment_id = v_run.environment_id),
			(select profile.name from public.qorpera_profiles as profile where profile.id = v_run.profile_id)
		)),$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_surface_ensure_site(uuid)'::regprocedure,
	array[
		$old$	select name into v_company_name from public.qorpera_profiles where id = v_surface.profile_id;
	v_prefix := left(btrim(lower(regexp_replace(coalesce(v_company_name, ''), '[^a-zA-Z0-9]+', '-', 'g')), '-'), 20);$old$,
		$new$	select name into v_company_name from public.qorpera_profiles where id = v_surface.profile_id;
	if lower(btrim(coalesce(v_company_name, ''))) = 'no name yet' then
		v_company_name := '';
	end if;
	v_prefix := left(btrim(lower(regexp_replace(coalesce(v_company_name, ''), '[^a-zA-Z0-9]+', '-', 'g')), '-'), 20);$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_list_hosted_profiles()'::regprocedure,
	array[
		$old$'created_at',profile.created_at,'bootstrap_state','legacy'$old$,
		$new$'created_at',profile.created_at,'name_changed_at',profile.name_changed_at,'bootstrap_state','legacy'$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_native_list_company_interfaces(jsonb)'::regprocedure,
	array[
		$old$	return jsonb_build_object(
		'schema', 'qorpera.company-interfaces/v1',
		'interfaces',$old$,
		$new$	return jsonb_build_object(
		'schema', 'qorpera.company-interfaces/v1',
		'company', (
			select jsonb_build_object(
				'id', p.id,
				'name', coalesce(idx.name, p.name),
				'previousName', latest.old_name,
				'renamedAt', p.name_changed_at
			)
			from public.qorpera_profiles p
			left join public.qorpera_folder_company_index idx on idx.profile_id = p.id
			left join lateral (
				select r.old_name
				from public.qorpera_company_renames r
				where r.profile_id = p.id and r.wake_problem is distinct from 'reverted'
				order by r.created_at desc, r.id desc
				limit 1
			) latest on true
			where p.id = v_company_id
		),
		'interfaces',$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_live_hint_internal()'::regprocedure,
	array[
		$old$		elsif tg_table_name = 'qorpera_profile_access_state' then
			v_class := v_row.profile_id || ' access ' || v_row.user_id;
		else
			v_class := v_row.profile_id || ' ' || tg_argv[0];
		end if;$old$,
		$new$		elsif tg_table_name = 'qorpera_profile_access_state' then
			v_class := v_row.profile_id || ' access ' || v_row.user_id;
		elsif tg_table_name = 'qorpera_profiles' then
			v_class := v_row.id || ' ' || tg_argv[0];
		else
			v_class := v_row.profile_id || ' ' || tg_argv[0];
		end if;$new$,
		$old$		elsif tg_table_name = 'qorpera_profile_access_state' then
			perform public.qorpera_live_hint_send('access', public.qorpera_live_hint_access_topics(v_row.profile_id, v_row.user_id),
				v_class);
		else
			perform public.qorpera_live_hint_send(tg_argv[0], public.qorpera_live_hint_profile_topics(v_row.profile_id), v_class);
		end if;$old$,
		$new$		elsif tg_table_name = 'qorpera_profile_access_state' then
			perform public.qorpera_live_hint_send('access', public.qorpera_live_hint_access_topics(v_row.profile_id, v_row.user_id),
				v_class);
		elsif tg_table_name = 'qorpera_profiles' then
			perform public.qorpera_live_hint_send(tg_argv[0], public.qorpera_live_hint_profile_topics(v_row.id), v_class);
		else
			perform public.qorpera_live_hint_send(tg_argv[0], public.qorpera_live_hint_profile_topics(v_row.profile_id), v_class);
		end if;$new$
	]
);

create constraint trigger qorpera_live_hint_profile_name
	after update on public.qorpera_profiles
	deferrable initially deferred for each row
	when (old.name is distinct from new.name)
	execute function public.qorpera_live_hint_internal('company-profile');

create or replace function public.qorpera_folder_converge_company(p_environment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid;
	v_name text;
	v_commit_id uuid;
	v_old_name text;
	v_env_name text;
	v_now timestamptz := clock_timestamp();
	v_commit public.qorpera_folder_commits%rowtype;
	v_renamed_by uuid;
	v_needs_stripe boolean;
	v_open_renames integer;
	v_locked_renames integer;
	v_pending public.qorpera_company_renames%rowtype;
begin
	select f.profile_id, i.name, i.commit_id
	into v_profile, v_name, v_commit_id
	from public.qorpera_company_files f
	join public.qorpera_folder_company_index i on i.environment_id = f.environment_id
	where f.environment_id = p_environment_id and f.core = 'folder-v2';
	if v_profile is null or v_name is null
		or exists (select 1 from public.qorpera_company_deletions d where d.profile_id = v_profile) then
		return jsonb_build_object('result', 'done');
	end if;
	select p.name into v_old_name from public.qorpera_profiles p where p.id = v_profile;
	select e.name into v_env_name from public.qorpera_company_environments e where e.id = p_environment_id;
	if v_old_name is not distinct from v_name and v_env_name is not distinct from v_name then
		return jsonb_build_object('result', 'done');
	end if;
	if char_length(btrim(v_name)) not between 1 and 120 then
		return jsonb_build_object('result', 'done', 'problem', 'name_invalid');
	end if;
	perform 1 from public.qorpera_profiles where id = v_profile for no key update skip locked;
	if not found then
		return jsonb_build_object('result', 'dirty', 'problem', 'busy');
	end if;
	perform 1 from public.qorpera_company_environments where id = p_environment_id for no key update skip locked;
	if not found then
		return jsonb_build_object('result', 'dirty', 'problem', 'busy');
	end if;
	select p.name into v_old_name from public.qorpera_profiles p where p.id = v_profile;
	if v_old_name is not distinct from v_name then
		update public.qorpera_company_environments
		set name = v_name
		where id = p_environment_id and name is distinct from v_name;
		return jsonb_build_object('result', 'done');
	end if;
	select count(*)::integer into v_open_renames
	from public.qorpera_company_renames r
	where r.profile_id = v_profile and (r.wake_state = 'pending' or r.audit_state = 'pending');
	if v_open_renames > 0 then
		select count(*)::integer into v_locked_renames
		from (
			select r.id
			from public.qorpera_company_renames r
			where r.profile_id = v_profile and (r.wake_state = 'pending' or r.audit_state = 'pending')
			order by r.id
			for update skip locked
		) locked;
		if v_locked_renames < v_open_renames then
			return jsonb_build_object('result', 'dirty', 'problem', 'busy');
		end if;
	end if;
	update public.qorpera_company_environments
	set name = v_name
	where id = p_environment_id and name is distinct from v_name;
	update public.qorpera_profiles
	set name = v_name, name_changed_at = v_now
	where id = v_profile and name is distinct from v_name;
	if v_commit_id is not null then
		select * into v_commit
		from public.qorpera_folder_commits c
		where c.id = v_commit_id and c.environment_id = p_environment_id;
	end if;
	v_renamed_by := case
		when v_commit.actor_kind = 'member' then v_commit.actor_id
	end;
	v_needs_stripe := lower(btrim(v_name)) <> 'no name yet' and exists (
		select 1 from public.qorpera_good_will_customers c
		where c.profile_id = v_profile
			and c.livemode = (not public.qorpera_computer_hour_dry_run(v_now))
	);
	select * into v_pending
	from public.qorpera_company_renames r
	where r.profile_id = v_profile and r.wake_state = 'pending'
	order by r.created_at desc, r.id desc
	limit 1;
	if v_pending.id is not null and v_pending.old_name = v_name then
		update public.qorpera_company_renames
		set wake_state = 'skipped',
			wake_problem = 'reverted',
			audit_state = case when audit_state = 'pending' then 'superseded' else audit_state end,
			stripe_sync_state = case when v_needs_stripe then 'pending' else 'none' end,
			stripe_synced_at = case when v_needs_stripe then null else stripe_synced_at end,
			updated_at = v_now
		where id = v_pending.id;
	elsif v_pending.id is not null then
		update public.qorpera_company_renames
		set new_name = v_name,
			commit_id = v_commit_id,
			vision_seq = v_commit.seq,
			actor_kind = v_commit.actor_kind,
			actor_id = v_commit.actor_id,
			renamed_by_user_id = v_renamed_by,
			stripe_sync_state = case when v_needs_stripe then 'pending' else 'none' end,
			stripe_synced_at = null,
			audit_due_at = v_now + interval '30 minutes',
			created_at = v_now,
			updated_at = v_now
		where id = v_pending.id;
	else
		update public.qorpera_company_renames
		set audit_state = 'superseded', updated_at = v_now
		where profile_id = v_profile and audit_state = 'pending';
		insert into public.qorpera_company_renames(
			profile_id, environment_id, old_name, new_name, commit_id, vision_seq,
			actor_kind, actor_id, renamed_by_user_id, stripe_sync_state,
			audit_due_at, created_at, updated_at
		)
		values (
			v_profile, p_environment_id, v_old_name, v_name, v_commit_id, v_commit.seq,
			v_commit.actor_kind, v_commit.actor_id, v_renamed_by,
			case when v_needs_stripe then 'pending' else 'none' end,
			v_now + interval '30 minutes', v_now, v_now
		);
	end if;
	return jsonb_build_object('result', 'done');
end $$;

select pg_temp.cnc_patch(
	'public.qorpera_pin_wake_occurrence()'::regprocedure,
	array[
		$old$	v_la_ask public.qorpera_light_asks%rowtype;$old$,
		$new$	v_la_ask public.qorpera_light_asks%rowtype;
	v_cnc_rename public.qorpera_company_renames%rowtype;
	v_cnc_payer record;$new$,
		$old$	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$old$,
		$new$	elsif new.wake_kind = 'agent' and new.source_kind = 'company-rename' then
		select * into v_cnc_rename
		from public.qorpera_company_renames r
		where r.id = new.source_id and r.profile_id = new.profile_id
			and r.environment_id = new.environment_id and r.wake_state = 'pending' and r.wake_id is null;
		if not public.qorpera_company_is_folder_v2(new.profile_id) or v_cnc_rename.id is null
			or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null then
			raise exception 'Wake rename is unavailable' using errcode = '42501';
		end if;
		new.staff_agent_id := (select c.staff_agent_id from public.qorpera_company_cofounders c where c.profile_id = new.profile_id);
		if new.staff_agent_id is null then
			raise exception 'Wake rename has no Co-Founder' using errcode = '42501';
		end if;
		select payer.payer_user_id, payer.binding_id, payer.version, payer.member_initiated
		into v_cnc_payer
		from public.qorpera_company_rename_sponsor(
			new.profile_id,
			case when v_cnc_rename.actor_kind = 'member' then v_cnc_rename.renamed_by_user_id end,
			new.staff_agent_id
		) as payer;
		if v_cnc_payer.binding_id is null or v_cnc_payer.payer_user_id is null then
			raise exception 'No model account can pay for this work' using errcode = '42501';
		end if;
		new.requested_by_user_id := v_cnc_payer.payer_user_id;
		new.sponsor_binding_id := v_cnc_payer.binding_id;
		new.sponsor_version := v_cnc_payer.version;
		new.trigger_id := 'company-rename';
		new.occurrence_key := 'company-rename:' || v_cnc_rename.id::text;
		new.payload := jsonb_build_object(
			'schema', 'qorpera.company-rename-wake/v1',
			'renameId', v_cnc_rename.id,
			'oldName', v_cnc_rename.old_name,
			'newName', v_cnc_rename.new_name,
			'renamedAt', to_char(v_cnc_rename.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'commitId', v_cnc_rename.commit_id,
			'visionSeq', v_cnc_rename.vision_seq,
			'renamedByUserId', v_cnc_rename.renamed_by_user_id
		);
		select * into v_authority
		from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id;
		new.logical_computer_id := case when v_authority.sponsor_binding_id = new.sponsor_binding_id
			then v_authority.logical_computer_id end;
		new.session_id := public.qorpera_folder_wake_public_session(
			new.profile_id, new.environment_id, new.staff_agent_id, new.requested_by_user_id
		);
		v_actor := case when v_cnc_rename.actor_kind = 'staff_agent' then v_cnc_rename.actor_id end;
	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	array[
		$old$	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype;$old$,
		$new$	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype;
	v_cnc_rename public.qorpera_company_renames%rowtype;$new$,
		$old$		if p_wake.source_kind = 'human-task' then$old$,
		$new$		if p_wake.source_kind = 'company-rename' then
			select * into v_cnc_rename
			from public.qorpera_company_renames r
			where r.id = p_wake.source_id and r.profile_id = p_wake.profile_id
				and r.environment_id = p_wake.environment_id
				and ((r.wake_id is null and r.wake_state = 'pending')
					or (r.wake_id = p_wake.id and (p_wake.run_id is not null or r.wake_state = 'woken')));
			if p_wake.parent_run_id is not null or v_cnc_rename.id is null then
				return false;
			end if;
			v_ancestry := public.qorpera_wake_ancestry(
				null,
				case when v_cnc_rename.actor_kind = 'staff_agent' then v_cnc_rename.actor_id end,
				p_wake.staff_agent_id,
				p_wake.id
			);
			return coalesce(
				v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
					and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids),
				false
			);
		end if;
		if p_wake.source_kind = 'human-task' then$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	array[
		$old$			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$old$,
		$new$			or (v_wake.source_kind = 'company-rename' and (v_wake.parent_run_id is not null
				or not exists (select 1 from public.qorpera_company_renames r
					where r.id = v_wake.source_id and r.profile_id = v_wake.profile_id
						and r.wake_id = v_wake.id)))
			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$new$,
		$old$					'human-task','machine-checkin','light-ask','surface-session'))))) -- 20260930098000$old$,
		$new$					'human-task','machine-checkin','light-ask','surface-session','company-rename'))))) -- 20260930098000$new$,
		$old$	if v_wake.source_kind = 'human-task' and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$old$,
		$new$	if v_wake.source_kind in ('human-task','company-rename') and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	array[
		$old$	elsif v_wake.source_kind = 'human-task' then$old$,
		$new$	elsif v_wake.source_kind = 'company-rename' then
		select case when r.actor_kind = 'staff_agent' then r.actor_id end, r.renamed_by_user_id
		into v_sender, v_actor_user
		from public.qorpera_company_renames r
		where r.id = v_wake.source_id and r.profile_id = v_wake.profile_id;
	elsif v_wake.source_kind = 'human-task' then$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	array[
		$old$						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($old$,
		$new$						or (v_wake.source_kind = 'company-rename'
							and v_wake.requested_by_user_id is not null
							and exists (
								select 1 from public.qorpera_company_renames r
								where r.id = v_wake.source_id and r.profile_id = v_wake.profile_id
									and r.actor_kind = 'member'
									and r.renamed_by_user_id is not null
									and r.renamed_by_user_id = v_wake.requested_by_user_id
							))
						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure,
	array[
		$old$	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;$old$,
		$new$	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;
	if p_run.source_kind = 'wake' and exists (
		select 1 from public.qorpera_wake_occurrences w
		join public.qorpera_company_renames r on r.id = w.source_id and r.profile_id = w.profile_id
		where w.id = p_run.source_id and (w.run_id is null or w.run_id = p_run.id) and w.wake_kind = 'agent'
			and w.source_kind = 'company-rename' and w.profile_id = p_run.profile_id
			and r.actor_kind = 'member'
			and r.renamed_by_user_id is not null
			and r.renamed_by_user_id = p_run.requested_by_user_id
			and w.requested_by_user_id = p_run.requested_by_user_id
	) then return true; end if;$new$
	]
);

create function public.qorpera_company_rename_wake_step(
	p_environment_id uuid default null,
	p_limit integer default 16
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.company-rename-wakes/v1';
	v_env uuid;
	v_profile uuid;
	v_cofounder uuid;
	v_rename public.qorpera_company_renames%rowtype;
	v_payer record;
	v_recheck record;
	v_session uuid;
	v_targets jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_woken integer := 0;
	v_skipped integer := 0;
	v_unpaid integer := 0;
	v_busy integer := 0;
	v_expired integer := 0;
	v_now timestamptz := clock_timestamp();
begin
	if nullif(auth.role(), '') is not null and auth.role() is distinct from 'service_role' then
		raise exception 'Company rename wake step requires platform authority' using errcode = '42501';
	end if;
	if p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Company rename wake limit is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_company_rename_wake_ready() then
		return jsonb_build_object(
			'schema', c_schema, 'state', 'not_ready',
			'woken', 0, 'skipped', 0, 'unpaid', 0, 'busy', 0
		);
	end if;

	update public.qorpera_company_renames r
	set wake_state = 'skipped',
		wake_problem = 'expired',
		updated_at = v_now
	where r.wake_state = 'pending'
		and coalesce(r.wake_last_attempt_at, r.created_at) < v_now - interval '24 hours'
		and not public.qorpera_company_execution_paused(r.profile_id)
		and (p_environment_id is null or r.environment_id = p_environment_id);
	get diagnostics v_expired = row_count;
	v_skipped := v_skipped + v_expired;

	for v_env in
		select r.environment_id
		from public.qorpera_company_renames r
		where r.wake_state = 'pending'
			and (p_environment_id is null or r.environment_id = p_environment_id)
			and (r.wake_last_attempt_at is null or r.wake_last_attempt_at <= v_now - interval '15 seconds')
		group by r.environment_id
		order by min(coalesce(r.wake_last_attempt_at, '-infinity'::timestamptz)) asc, min(r.created_at) asc, r.environment_id asc
		limit p_limit
	loop
		v_rename := null;
		select * into v_rename
		from public.qorpera_company_renames r
		where r.environment_id = v_env and r.wake_state = 'pending'
			and (r.wake_last_attempt_at is null or r.wake_last_attempt_at <= v_now - interval '15 seconds')
		order by r.created_at asc, r.id asc
		limit 1;
		if v_rename.id is null then
			continue;
		end if;
		begin
			select f.profile_id into v_profile
			from public.qorpera_company_files f
			where f.environment_id = v_env and f.profile_id = v_rename.profile_id and f.core = 'folder-v2';
			if v_profile is null then
				update public.qorpera_company_renames
				set wake_state = 'skipped', wake_problem = 'not_folder_v2',
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_skipped := v_skipped + 1;
				continue;
			end if;
			if public.qorpera_company_deleting(v_profile) then
				update public.qorpera_company_renames
				set wake_state = 'skipped', wake_problem = 'deleting',
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_skipped := v_skipped + 1;
				continue;
			end if;
			if public.qorpera_company_execution_paused(v_profile) then
				update public.qorpera_company_renames
				set wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					wake_problem = 'paused', updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_busy := v_busy + 1;
				continue;
			end if;
			select c.staff_agent_id into v_cofounder
			from public.qorpera_company_cofounders c
			where c.profile_id = v_profile;
			if v_cofounder is null then
				update public.qorpera_company_renames
				set wake_state = 'skipped', wake_problem = 'no_cofounder',
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_skipped := v_skipped + 1;
				continue;
			end if;
			select payer.payer_user_id, payer.binding_id, payer.version, payer.member_initiated
			into v_payer
			from public.qorpera_company_rename_sponsor(
				v_profile,
				case when v_rename.actor_kind = 'member' then v_rename.renamed_by_user_id end,
				v_cofounder
			) as payer;
			if v_payer.binding_id is null or v_payer.payer_user_id is null then
				update public.qorpera_company_renames
				set wake_state = 'unpaid', wake_problem = 'no_payer',
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_unpaid := v_unpaid + 1;
				continue;
			end if;
			v_session := public.qorpera_folder_wake_public_session(v_profile, v_env, v_cofounder, v_payer.payer_user_id);
			v_targets := jsonb_build_array(
				jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
					'key', v_profile::text || ':' || v_payer.payer_user_id::text, 'mode', 'keyshare'),
				jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
					'key', v_profile::text || ':' || v_cofounder::text, 'mode', 'keyshare'),
				jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
					'key', v_profile::text || ':' || v_cofounder::text, 'mode', 'keyshare')
			);
			perform public.qorpera_folder_company_enter(v_env, v_profile, v_targets, false);
			if public.qorpera_company_deleting(v_profile) then
				update public.qorpera_company_renames
				set wake_state = 'skipped', wake_problem = 'deleting',
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_skipped := v_skipped + 1;
				continue;
			end if;
			if public.qorpera_company_execution_paused(v_profile) then
				update public.qorpera_company_renames
				set wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					wake_problem = 'paused', updated_at = clock_timestamp()
				where id = v_rename.id and wake_state = 'pending';
				v_busy := v_busy + 1;
				continue;
			end if;
			if v_session is not null then
				perform 1 from public.qorpera_shared_sessions s
				where s.profile_id = v_profile and s.id = v_session
				for key share;
			end if;
			perform public.qorpera_folder_admit_wakes(v_profile);
			select * into v_rename
			from public.qorpera_company_renames r
			where r.id = v_rename.id and r.wake_state = 'pending'
			for update skip locked;
			if v_rename.id is null then
				continue;
			end if;
			select payer.payer_user_id, payer.binding_id, payer.version, payer.member_initiated
			into v_recheck
			from public.qorpera_company_rename_sponsor(
				v_profile,
				case when v_rename.actor_kind = 'member' then v_rename.renamed_by_user_id end,
				v_cofounder
			) as payer;
			if v_recheck.binding_id is null or v_recheck.payer_user_id is null then
				update public.qorpera_company_renames
				set wake_state = 'unpaid', wake_problem = 'no_payer',
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id;
				v_unpaid := v_unpaid + 1;
				continue;
			end if;
			if v_recheck.payer_user_id is distinct from v_payer.payer_user_id
				or public.qorpera_folder_wake_public_session(v_profile, v_env, v_cofounder, v_recheck.payer_user_id) is distinct from v_session then
				update public.qorpera_company_renames
				set wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id;
				v_busy := v_busy + 1;
				continue;
			end if;
			insert into public.qorpera_wake_occurrences(
				id, profile_id, environment_id, wake_kind, source_kind, source_id,
				trigger_id, occurrence_key, scheduled_for, not_before
			)
			values (
				extensions.gen_random_uuid(), v_profile, v_env, 'agent', 'company-rename', v_rename.id,
				'company-rename', 'company-rename:' || v_rename.id::text, clock_timestamp(), clock_timestamp()
			)
			returning * into v_wake;
			if v_wake.status = 'queued' then
				update public.qorpera_company_renames
				set wake_state = 'woken', wake_id = v_wake.id, wake_problem = null,
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id;
				v_woken := v_woken + 1;
			else
				update public.qorpera_company_renames
				set wake_state = 'skipped', wake_problem = coalesce(v_wake.status, 'cancelled'),
					wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
					updated_at = clock_timestamp()
				where id = v_rename.id;
				v_skipped := v_skipped + 1;
			end if;
		exception
			when lock_not_available then
				begin
					update public.qorpera_company_renames
					set wake_last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
					where id = v_rename.id and wake_state = 'pending';
				exception when lock_not_available then
					null;
				end;
				v_busy := v_busy + 1;
			when insufficient_privilege then
				begin
					update public.qorpera_company_renames
					set wake_state = 'unpaid',
						wake_problem = case when sqlerrm = 'No model account can pay for this work' then 'no_payer' else 'unavailable' end,
						wake_attempts = wake_attempts + 1, wake_last_attempt_at = clock_timestamp(),
						updated_at = clock_timestamp()
					where id = v_rename.id and wake_state = 'pending';
					v_unpaid := v_unpaid + 1;
				exception when lock_not_available then
					v_busy := v_busy + 1;
				end;
			when others then
				begin
					update public.qorpera_company_renames
					set wake_attempts = wake_attempts + 1,
						wake_last_attempt_at = clock_timestamp(),
						wake_state = case when wake_attempts + 1 >= 5 then 'skipped' else wake_state end,
						wake_problem = coalesce(nullif(left(sqlstate || ':' || sqlerrm, 64), ''), 'error'),
						updated_at = clock_timestamp()
					where id = v_rename.id and wake_state = 'pending';
					if v_rename.wake_attempts + 1 >= 5 then
						v_skipped := v_skipped + 1;
					else
						v_busy := v_busy + 1;
					end if;
				exception when lock_not_available then
					v_busy := v_busy + 1;
				end;
		end;
	end loop;

	return jsonb_build_object(
		'schema', c_schema, 'state', 'done',
		'woken', v_woken, 'skipped', v_skipped, 'unpaid', v_unpaid, 'busy', v_busy
	);
end $$;
revoke all on function public.qorpera_company_rename_wake_step(uuid, integer)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_company_rename_wake_step(uuid, integer) to service_role;

create function public.qorpera_company_rename_audit_step(
	p_limit integer default 5,
	p_force_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.company-rename-audits/v1';
	v_now timestamptz := clock_timestamp();
	v_rename public.qorpera_company_renames%rowtype;
	v_profile_name text;
	v_env_name text;
	v_vision_name text;
	v_db_converged boolean;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_job_status text;
	v_job_error text;
	v_job_finished_at timestamptz;
	v_cofounder_posts integer;
	v_commits_after integer;
	v_touched_paths jsonb;
	v_stale_canonical jsonb;
	v_wordmarks_total integer;
	v_wordmarks_refreshed integer;
	v_surfaces_total integer;
	v_surfaces_touched integer;
	v_site_slugs text[];
	v_mail_handles text[];
	v_mailboxes_active integer;
	v_accounts_active integer;
	v_old_slug text;
	v_findings text[];
	v_outcome text;
	v_report jsonb;
	v_audited integer := 0;
begin
	if nullif(auth.role(), '') is not null and auth.role() is distinct from 'service_role' then
		raise exception 'Company rename audit requires platform authority' using errcode = '42501';
	end if;
	if p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Company rename audit limit is invalid' using errcode = '22023';
	end if;

	for v_rename in
		select *
		from public.qorpera_company_renames r
		where r.audit_state = 'pending'
			and ((p_force_id is not null and r.id = p_force_id)
				or (p_force_id is null and r.audit_due_at <= v_now))
		order by r.audit_due_at asc, r.id asc
		limit p_limit
		for update skip locked
	loop
		v_findings := '{}'::text[];
		select p.name into v_profile_name from public.qorpera_profiles p where p.id = v_rename.profile_id;
		select e.name into v_env_name from public.qorpera_company_environments e where e.id = v_rename.environment_id;
		select i.name into v_vision_name from public.qorpera_folder_company_index i where i.environment_id = v_rename.environment_id;
		v_db_converged := v_profile_name is not distinct from v_rename.new_name
			and v_env_name is not distinct from v_rename.new_name
			and v_vision_name is not distinct from v_rename.new_name;
		if not v_db_converged then
			v_findings := array_append(v_findings, 'db_name_not_converged');
		end if;

		v_wake := null;
		v_job_status := null;
		v_job_error := null;
		v_job_finished_at := null;
		v_cofounder_posts := 0;
		if v_rename.wake_id is not null then
			select * into v_wake from public.qorpera_wake_occurrences w where w.id = v_rename.wake_id;
			if v_wake.run_id is not null then
				select j.status, j.last_error, j.finished_at
				into v_job_status, v_job_error, v_job_finished_at
				from public.qorpera_execution_runs r
				join public.qorpera_runner_jobs j on j.id = r.job_id
				where r.id = v_wake.run_id;
			end if;
			if v_wake.session_id is not null then
				select count(*)::integer into v_cofounder_posts
				from public.qorpera_session_events e
				where e.session_id = v_wake.session_id
					and e.event_type = 'message'
					and (e.execution_id = v_wake.run_id
						or (e.execution_id is not null and e.created_at >= v_rename.created_at));
			end if;
		end if;

		if v_rename.wake_state = 'pending' then
			v_findings := array_append(v_findings, 'wake_still_pending');
		elsif v_rename.wake_state <> 'woken' then
			v_findings := array_append(v_findings, 'wake_' || v_rename.wake_state);
		elsif v_wake.run_id is null then
			v_findings := array_append(v_findings, 'cofounder_run_not_started');
		elsif v_job_status in ('failed', 'cancelled') then
			v_findings := array_append(v_findings, 'cofounder_run_' || v_job_status);
		elsif v_job_status is distinct from 'completed' then
			v_findings := array_append(v_findings, 'cofounder_run_still_active');
		elsif v_wake.session_id is not null and v_cofounder_posts = 0 then
			v_findings := array_append(v_findings, 'cofounder_did_not_report');
		end if;

		select count(*)::integer into v_commits_after
		from public.qorpera_folder_commits c
		where c.environment_id = v_rename.environment_id
			and c.seq is not null
			and c.seq > coalesce(v_rename.vision_seq, 0);

		select coalesce(jsonb_agg(p.path order by p.path), '[]'::jsonb) into v_touched_paths
		from (
			select distinct pv.path
			from public.qorpera_folder_path_versions pv
			join public.qorpera_folder_commits c on c.id = pv.commit_id
			where c.environment_id = v_rename.environment_id
				and c.seq is not null
				and c.seq > coalesce(v_rename.vision_seq, 0)
			order by pv.path
			limit 50
		) p;

		select coalesce(jsonb_agg(e.path order by e.path), '[]'::jsonb) into v_stale_canonical
		from public.qorpera_folder_entries e
		left join public.qorpera_folder_commits c on c.id = e.commit_id
		where e.environment_id = v_rename.environment_id
			and e.kind = 'file'
			and lower(e.path) in ('identity/company.json', 'identity/tokens.json')
			and coalesce(c.seq, 0) < coalesce(v_rename.vision_seq, 0);
		if jsonb_array_length(v_stale_canonical) > 0 then
			v_findings := array_append(v_findings, 'canonical_identity_files_stale');
		end if;

		select
			count(*)::integer,
			count(*) filter (where coalesce(c.seq, 0) >= coalesce(v_rename.vision_seq, 0))::integer
		into v_wordmarks_total, v_wordmarks_refreshed
		from public.qorpera_folder_entries e
		left join public.qorpera_folder_commits c on c.id = e.commit_id
		where e.environment_id = v_rename.environment_id
			and e.kind = 'file'
			and lower(e.path) ~ '^identity/(?:.*/)?wordmark[^/]*\.(?:svg|png|webp|jpe?g)$';

		select
			count(*)::integer,
			count(*) filter (where exists (
				select 1 from public.qorpera_surface_sessions ss
				where ss.surface_id = s.id and ss.created_at >= v_rename.created_at
			))::integer
		into v_surfaces_total, v_surfaces_touched
		from public.qorpera_surfaces s
		where s.profile_id = v_rename.profile_id
			and s.status = 'active'
			and s.archetype in ('live_build', 'studio');

		if v_wordmarks_total > 0 and v_wordmarks_refreshed = 0 and not exists (
			select 1 from public.qorpera_surface_sessions ss
			join public.qorpera_surfaces s on s.id = ss.surface_id
			where s.profile_id = v_rename.profile_id and s.surface_kind = 'identity'
				and ss.created_at >= v_rename.created_at
		) then
			v_findings := array_append(v_findings, 'wordmark_not_refreshed');
		end if;

		select coalesce(array_agg(s.slug order by s.slug), '{}'::text[]) into v_site_slugs
		from public.qorpera_company_sites s
		where s.profile_id = v_rename.profile_id and s.taken_down_at is null;

		select coalesce(array_agg(h.handle order by h.handle), '{}'::text[]) into v_mail_handles
		from public.qorpera_company_mail_handles h
		where h.profile_id = v_rename.profile_id;

		select count(*)::integer into v_mailboxes_active
		from public.qorpera_company_mailboxes m
		where m.profile_id = v_rename.profile_id and m.removed_at is null;

		select count(*)::integer into v_accounts_active
		from public.qorpera_company_accounts a
		where a.profile_id = v_rename.profile_id and a.status <> 'closed';

		v_old_slug := btrim(lower(regexp_replace(v_rename.old_name, '[^a-zA-Z0-9]+', '-', 'g')), '-');
		if lower(btrim(v_rename.old_name)) <> 'no name yet' and char_length(v_old_slug) >= 3 then
			if exists (select 1 from unnest(v_site_slugs) sl where sl like '%' || v_old_slug || '%') then
				v_findings := array_append(v_findings, 'site_slug_references_old_name');
			end if;
			if exists (select 1 from unnest(v_mail_handles) mh where mh like '%' || v_old_slug || '%') then
				v_findings := array_append(v_findings, 'mail_handle_references_old_name');
			end if;
		end if;

		if v_rename.stripe_sync_state = 'pending' then
			v_findings := array_append(v_findings, 'stripe_customer_name_pending');
		end if;

		if not v_db_converged
			or v_rename.wake_state in ('pending', 'unpaid', 'skipped')
			or v_job_status in ('failed', 'cancelled') then
			v_outcome := 'failed';
		elsif cardinality(v_findings) > 0 then
			v_outcome := 'needs_attention';
		else
			v_outcome := 'clean';
		end if;

		v_report := jsonb_build_object(
			'schema', 'qorpera.company-rename-audit/v1',
			'auditedAt', v_now,
			'oldName', v_rename.old_name,
			'newName', v_rename.new_name,
			'outcome', v_outcome,
			'findings', to_jsonb(v_findings),
			'convergence', jsonb_build_object(
				'dbConverged', v_db_converged,
				'profileName', v_profile_name,
				'environmentName', v_env_name,
				'visionIndexName', v_vision_name,
				'staleCanonicalFiles', v_stale_canonical
			),
			'cofounder', jsonb_build_object(
				'wakeState', v_rename.wake_state,
				'wakeProblem', v_rename.wake_problem,
				'wakeId', v_rename.wake_id,
				'wakeStatus', v_wake.status,
				'runId', v_wake.run_id,
				'jobStatus', v_job_status,
				'jobError', v_job_error,
				'jobFinishedAt', v_job_finished_at,
				'postsAfterRename', v_cofounder_posts
			),
			'companyActivity', jsonb_build_object(
				'commitsAfterRename', v_commits_after,
				'touchedPaths', v_touched_paths,
				'wordmarksTotal', v_wordmarks_total,
				'wordmarksRefreshed', v_wordmarks_refreshed,
				'activeSurfaces', v_surfaces_total,
				'surfacesWithNewSession', v_surfaces_touched
			),
			'externalFootprint', jsonb_build_object(
				'siteSlugs', to_jsonb(v_site_slugs),
				'mailHandles', to_jsonb(v_mail_handles),
				'activeMailboxes', v_mailboxes_active,
				'activeAccounts', v_accounts_active,
				'stripeSyncState', v_rename.stripe_sync_state
			)
		);

		update public.qorpera_company_renames
		set audit_state = 'completed',
			audit_completed_at = v_now,
			audit_outcome = v_outcome,
			audit_report = v_report,
			updated_at = v_now
		where id = v_rename.id;
		v_audited := v_audited + 1;
	end loop;

	return jsonb_build_object('schema', c_schema, 'audited', v_audited);
end $$;
revoke all on function public.qorpera_company_rename_audit_step(integer, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_company_rename_audit_step(integer, uuid) to service_role;

create function public.qorpera_operator_company_rename_reviews(
	p_limit integer default 20,
	p_profile_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if nullif(auth.role(), '') is not null and auth.role() is distinct from 'service_role' then
		raise exception 'Operator rename reviews require service authority' using errcode = '42501';
	end if;
	if p_limit is null or p_limit not between 1 and 100 then
		raise exception 'Operator rename review limit is invalid' using errcode = '22023';
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.operator-company-rename-reviews/v1',
		'reviews', coalesce((
			select jsonb_agg(
				jsonb_build_object(
					'id', r.id,
					'profileId', r.profile_id,
					'environmentId', r.environment_id,
					'oldName', r.old_name,
					'newName', r.new_name,
					'actorKind', r.actor_kind,
					'renamedByUserId', r.renamed_by_user_id,
					'wakeState', r.wake_state,
					'wakeProblem', r.wake_problem,
					'stripeSyncState', r.stripe_sync_state,
					'auditState', r.audit_state,
					'auditDueAt', r.audit_due_at,
					'auditCompletedAt', r.audit_completed_at,
					'auditOutcome', r.audit_outcome,
					'auditReport', r.audit_report,
					'createdAt', r.created_at
				)
				order by r.created_at desc, r.id desc
			)
			from (
				select *
				from public.qorpera_company_renames r
				where p_profile_id is null or r.profile_id = p_profile_id
				order by r.created_at desc, r.id desc
				limit p_limit
			) r
		), '[]'::jsonb)
	);
end $$;
revoke all on function public.qorpera_operator_company_rename_reviews(integer, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_operator_company_rename_reviews(integer, uuid) to service_role;

create function public.qorpera_schedule_company_rename_jobs()
returns jsonb
language plpgsql set search_path = '' as $$
declare
	v_wake_job bigint;
	v_audit_job bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		return jsonb_build_object('schema', 'qorpera.company-rename-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_wake_job := cron.schedule('qorpera-company-rename-wakes', '* * * * *', 'select public.qorpera_company_rename_wake_step()');
		v_audit_job := cron.schedule('qorpera-company-rename-audits', '*/5 * * * *', 'select public.qorpera_company_rename_audit_step()');
	exception when others then
		raise warning 'Company rename jobs were not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.company-rename-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object(
		'schema', 'qorpera.company-rename-schedule/v1',
		'scheduled', true,
		'wakeJob', v_wake_job,
		'auditJob', v_audit_job
	);
end $$;
revoke all on function public.qorpera_schedule_company_rename_jobs()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
select public.qorpera_schedule_company_rename_jobs();

select pg_temp.cnc_patch(
	'public.qorpera_good_will_billing(text,text,jsonb)'::regprocedure,
	array[
		$old$		return jsonb_build_object('setupId', v_setup.id,
			'companyName', (select p.name from public.qorpera_profiles as p where p.id = v_profile),
			'customerId', (select customer.stripe_customer_id from public.qorpera_good_will_customers as customer
				where customer.profile_id = v_profile and customer.livemode = v_livemode));$old$,
		$new$		return jsonb_build_object('setupId', v_setup.id,
			'companyName', (select p.name from public.qorpera_profiles as p where p.id = v_profile),
			'customerId', (select customer.stripe_customer_id from public.qorpera_good_will_customers as customer
				where customer.profile_id = v_profile and customer.livemode = v_livemode),
			'nameSyncRenameId', case when v_livemode = (not public.qorpera_computer_hour_dry_run(clock_timestamp())) then (
				select r.id from public.qorpera_company_renames as r
				where r.profile_id = v_profile and r.stripe_sync_state = 'pending'
				order by r.created_at desc, r.id desc limit 1
			) end);$new$,
		$old$				and (v_livemode or public.qorpera_computer_billing_tester(payer.user_id))), '[]'::jsonb));$old$,
		$new$				and (v_livemode or public.qorpera_computer_billing_tester(payer.user_id))), '[]'::jsonb),
			'nameSyncs', case when v_livemode = (not public.qorpera_computer_hour_dry_run(clock_timestamp())) then coalesce((
				select jsonb_agg(jsonb_build_object(
					'renameId', pending.id, 'profileId', pending.profile_id,
					'customerId', customer.stripe_customer_id, 'companyName', profile.name)
					order by pending.created_at asc, pending.id asc)
				from (
					select distinct on (r.profile_id) r.id, r.profile_id, r.created_at
					from public.qorpera_company_renames r
					where r.stripe_sync_state = 'pending'
					order by r.profile_id, r.created_at desc, r.id desc
				) pending
				join public.qorpera_good_will_customers customer
					on customer.profile_id = pending.profile_id and customer.livemode = v_livemode
				join public.qorpera_profiles profile on profile.id = pending.profile_id
				where lower(btrim(profile.name)) <> 'no name yet'
				limit 20), '[]'::jsonb) else '[]'::jsonb end);$new$,
		$old$		return jsonb_build_object('outcome', 'applied', 'profileId', v_row.profile_id, 'status', v_row.status);
	end if;
	raise exception 'Billing: unknown good will method' using errcode = '22023';$old$,
		$new$		return jsonb_build_object('outcome', 'applied', 'profileId', v_row.profile_id, 'status', v_row.status);

	elsif p_method = 'name_sync_due' then
		if v_livemode <> (not public.qorpera_computer_hour_dry_run(clock_timestamp())) then
			return jsonb_build_object('customers', '[]'::jsonb);
		end if;
		return jsonb_build_object('customers', coalesce((
			select jsonb_agg(
				jsonb_build_object(
					'renameId', pending.id,
					'profileId', pending.profile_id,
					'customerId', customer.stripe_customer_id,
					'companyName', profile.name
				)
				order by pending.created_at asc, pending.id asc
			)
			from (
				select distinct on (r.profile_id) r.id, r.profile_id, r.created_at
				from public.qorpera_company_renames r
				where r.stripe_sync_state = 'pending'
				order by r.profile_id, r.created_at desc, r.id desc
			) pending
			join public.qorpera_good_will_customers customer
				on customer.profile_id = pending.profile_id and customer.livemode = v_livemode
			join public.qorpera_profiles profile on profile.id = pending.profile_id
			where lower(btrim(profile.name)) <> 'no name yet'
			limit 20
		), '[]'::jsonb));

	elsif p_method = 'name_synced' then
		if v_livemode <> (not public.qorpera_computer_hour_dry_run(clock_timestamp())) then
			return jsonb_build_object('synced', false);
		end if;
		v_profile := (p_args ->> 'profileId')::uuid;
		update public.qorpera_company_renames r
		set stripe_sync_state = 'synced',
			stripe_synced_at = clock_timestamp(),
			updated_at = clock_timestamp()
		where r.profile_id = v_profile
			and r.stripe_sync_state = 'pending'
			and exists (
				select 1 from public.qorpera_good_will_customers c
				where c.profile_id = v_profile and c.livemode = v_livemode
			)
			and (
				(p_args ->> 'renameId' is null
					and (p_args ->> 'companyName' is null
						or case when r.wake_problem = 'reverted' then r.old_name else r.new_name end = p_args ->> 'companyName'))
				or (r.id = (p_args ->> 'renameId')::uuid
					and (p_args ->> 'companyName' is null
						or case when r.wake_problem = 'reverted' then r.old_name else r.new_name end = p_args ->> 'companyName'))
				or (r.id <> (p_args ->> 'renameId')::uuid and exists (
					select 1
					from public.qorpera_company_renames target
					where target.id = (p_args ->> 'renameId')::uuid
						and target.profile_id = v_profile
						and r.created_at <= target.created_at
						and (p_args ->> 'companyName' is null
							or case when target.wake_problem = 'reverted' then target.old_name else target.new_name end = p_args ->> 'companyName')
				))
			);
		get diagnostics v_rows = row_count;
		return jsonb_build_object('synced', v_rows > 0);
	end if;
	raise exception 'Billing: unknown good will method' using errcode = '22023';$new$
	]
);

select pg_temp.cnc_patch(
	'public.qorpera_good_will_tick(date)'::regprocedure,
	array[
		$old$	if exists (select 1 from public.qorpera_good_will_months as m
			join public.qorpera_good_will_payers as payer on payer.profile_id = m.profile_id
			where m.status = 'closed' and m.invoice_url is null)$old$,
		$new$	update public.qorpera_company_renames as r
	set stripe_sync_state = 'none', updated_at = clock_timestamp()
	where r.stripe_sync_state = 'pending'
		and (
			not exists (
				select 1 from public.qorpera_good_will_customers as c
				where c.profile_id = r.profile_id
					and c.livemode = (not public.qorpera_computer_hour_dry_run(clock_timestamp()))
			)
			or exists (
				select 1 from public.qorpera_profiles as p
				where p.id = r.profile_id and lower(btrim(p.name)) = 'no name yet'
			)
		);
	if (exists (select 1 from public.qorpera_good_will_months as m
				join public.qorpera_good_will_payers as payer on payer.profile_id = m.profile_id
				where m.status = 'closed' and m.invoice_url is null)
			or exists (
				select 1 from public.qorpera_company_renames as r
				join public.qorpera_good_will_customers as c
					on c.profile_id = r.profile_id
					and c.livemode = (not public.qorpera_computer_hour_dry_run(clock_timestamp()))
				join public.qorpera_profiles as p on p.id = r.profile_id
				where r.stripe_sync_state = 'pending'
					and lower(btrim(p.name)) <> 'no name yet'
			))$new$
	]
);

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid in (select oid from cnc_before)
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930915000: patched function has API owner %', v_owner;
		end if;
		if v_owner is distinct from current_user then
			execute format('grant select, insert, update on public.qorpera_company_renames to %I', v_owner);
			execute format('grant execute on function public.qorpera_company_rename_sponsor(uuid,uuid,uuid) to %I', v_owner);
			execute format('grant execute on function public.qorpera_company_rename_wake_ready() to %I', v_owner);
		end if;
	end loop;
end $$;

do $guard$
begin
	if exists (
		select 1 from cnc_before b
		join pg_proc p on p.oid = b.oid
		where p.prosecdef is distinct from b.prosecdef
			or p.proconfig is distinct from b.proconfig
			or p.provolatile is distinct from b.provolatile
			or p.proacl is distinct from b.proacl
	) then
		raise exception '20260930915000: patched function attributes or ACL changed';
	end if;
	if has_table_privilege('anon', 'public.qorpera_company_renames', 'select')
		or has_table_privilege('authenticated', 'public.qorpera_company_renames', 'select')
		or has_table_privilege('service_role', 'public.qorpera_company_renames', 'select') then
		raise exception '20260930915000: qorpera_company_renames privileges are too broad';
	end if;
	if has_function_privilege('anon', 'public.qorpera_company_rename_audit_step(integer,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_company_rename_audit_step(integer,uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_operator_company_rename_reviews(integer,uuid)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_operator_company_rename_reviews(integer,uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_company_rename_wake_step(uuid,integer)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_company_rename_wake_step(uuid,integer)', 'execute') then
		raise exception '20260930915000: operator or platform rename functions must not be callable by anon or authenticated';
	end if;
end $guard$;

drop table pg_temp.cnc_before;
drop function pg_temp.cnc_patch(regprocedure, text[]);
