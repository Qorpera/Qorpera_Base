-- Event wakes, build step W2a (Q1; founder decisions of 29 September 2026: agents wake on
-- defined events, the top priority; event wakes also come to today's routine rows before the
-- clean reset; contract section 19, 2026-09-29 amendment "events wake agents", items 1, 4, 5 and 7;
-- design deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Event wakes (W2)").
--
-- A routine version may carry one listener trigger on a hook:
--   {id, kind:'listener', source:'event', hookId, only?:[types], timeZone, replyPolicy?}
-- A cursor per listener records when it became active and how far its deliveries are taken. The
-- materializer's drain queues at most one event occurrence per routine trigger while verified
-- deliveries of a live hook wait; the wake reader takes up to 20 of them for the occurrence, once,
-- within the room the rest of the wake leaves, and shows them as outside content. The rest wake the
-- routine again. A wake that ends without taking its deliveries is tried again after 1, 4, 16 and
-- 64 minutes; after five tries its first delivery is left behind. Quiet hours, pauses, expiry and
-- the pinned sponsor apply as to every routine occurrence, through the existing insert triggers.
--
-- Lock order (drain): the event cursor (skip locked), the routine row (nowait), then the company's
-- wake admission fence (nowait) and the wake row (the pin trigger's own order). A routine save
-- locks the routine, the file cursors, then the event cursors; the drain never waits for either.

set local lock_timeout = '3s';

create function pg_temp.event_wake_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Event wake integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. A new wake source kind, keeping whatever kinds master already has
-- ---------------------------------------------------------------------------
do $$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check' and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	-- Every listed kind is read, in the constraint's own form, so the rebuilt one prints alike.
	if not ('schedule' = any (v_kinds) and 'company-file' = any (v_kinds)) or 'event' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format('alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
		check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality) from unnest(v_kinds || array['event'])
			with ordinality as listed(kind, ordinality)));
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Listener cursors and the deliveries each occurrence took
-- ---------------------------------------------------------------------------
create table public.qorpera_event_listener_cursors (
	routine_id uuid not null,
	routine_version bigint not null,
	trigger_id text not null,
	hook_id uuid not null references public.qorpera_event_hooks(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	-- Deliveries received before this instant never wake the listener: creation, an edit and a
	-- resume are future-only, as for file listeners.
	activated_at timestamptz not null default clock_timestamp(),
	active boolean not null default false,
	last_scanned_at timestamptz not null default '-infinity',
	-- Every matching verified delivery verified before this instant is taken or left behind, so the
	-- waiting query starts here. It trails the clock by a minute, past any receive still committing.
	taken_before timestamptz not null default '-infinity',
	primary key (routine_id, routine_version, trigger_id),
	foreign key (routine_id, routine_version) references public.qorpera_cloud_routine_versions(routine_id, version)
		on delete cascade
);
create index qorpera_event_listener_cursors_active on public.qorpera_event_listener_cursors (last_scanned_at)
	where active;
create index qorpera_event_listener_cursors_hook on public.qorpera_event_listener_cursors (hook_id);

create table public.qorpera_event_wake_deliveries (
	routine_id uuid not null,
	trigger_id text not null,
	delivery_id uuid not null references public.qorpera_event_deliveries(id) on delete cascade,
	-- The occurrence that took the delivery, or the last one that failed to before it was left behind.
	-- Rows go with the company through their occurrence and delivery.
	occurrence_id uuid not null references public.qorpera_wake_occurrences(id) on delete cascade,
	taken_at timestamptz not null default clock_timestamp(),
	primary key (routine_id, trigger_id, delivery_id)
);
create index qorpera_event_wake_deliveries_occurrence on public.qorpera_event_wake_deliveries (occurrence_id);
create index qorpera_event_wake_deliveries_delivery on public.qorpera_event_wake_deliveries (delivery_id);
-- A hook's verified deliveries in the order listeners take them.
create index qorpera_event_deliveries_hook_verified on public.qorpera_event_deliveries (hook_id, verified_at, id)
	where status = 'verified';
-- A routine trigger's open event wakes; a finished run moves its wake on, so these stay few.
create index qorpera_wake_occurrences_event_open on public.qorpera_wake_occurrences (routine_id, trigger_id)
	where source_kind = 'event' and status in ('queued','materialized');

-- The public origin of the intake, for the full address agents give senders; set at deploy.
alter table public.qorpera_event_intake_settings add column public_url text
	check (public_url is null or public_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$');

alter table public.qorpera_event_listener_cursors enable row level security;
alter table public.qorpera_event_wake_deliveries enable row level security;
revoke all on table public.qorpera_event_listener_cursors from public, anon, authenticated, service_role;
revoke all on table public.qorpera_event_wake_deliveries from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The trigger, its activation and its pause/resume
-- ---------------------------------------------------------------------------
select pg_temp.event_wake_patch('public.qorpera_cloud_routine_trigger_valid(jsonb)'::regprocedure,
	$old$	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'$old$,
	$new$	if p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'event' then
		return coalesce(p_trigger ?& array['id','kind','source','hookId','timeZone']
			and p_trigger - array['id','kind','source','hookId','only','timeZone','replyPolicy'] = '{}'::jsonb
			and jsonb_typeof(p_trigger -> 'id') = 'string'
			and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
			-- One spelling of the hook id, so every reader compares it as text.
			and jsonb_typeof(p_trigger -> 'hookId') = 'string'
			and p_trigger ->> 'hookId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			and (not p_trigger ? 'only' or (jsonb_typeof(p_trigger -> 'only') = 'array'
				and jsonb_array_length(p_trigger -> 'only') between 1 and 20
				and not exists (select 1 from jsonb_array_elements(p_trigger -> 'only') as only_type(value)
					where jsonb_typeof(only_type.value) <> 'string' or only_type.value #>> '{}' !~ '^[\x21-\x7e]{1,128}$')
				and (select count(distinct only_type.value) from jsonb_array_elements(p_trigger -> 'only') as only_type(value))
					= jsonb_array_length(p_trigger -> 'only')))
			and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
			and public.qorpera_runtime_time_zone_name_valid(p_trigger ->> 'timeZone'),false);
	end if;
	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'$new$);

-- A new version's event listener gets its cursor. It is active once its routine makes that
-- version current and is active (the routine's status trigger below).
select pg_temp.event_wake_patch('public.qorpera_activate_company_file_listener()'::regprocedure,
	$old$	v_trigger := new.triggers -> 0;$old$,
	$new$	v_trigger := new.triggers -> 0;
	if v_trigger ->> 'source' = 'event' then
		if not public.qorpera_cloud_routine_trigger_valid(v_trigger) or not exists (
			select 1 from public.qorpera_event_hooks as hook where hook.id = (v_trigger ->> 'hookId')::uuid
				and hook.profile_id = new.profile_id and hook.environment_id = new.environment_id
				and hook.status <> 'removed') then
			raise exception 'Event listener hook is unavailable' using errcode = '42501'; end if;
		insert into public.qorpera_event_listener_cursors(routine_id, routine_version, trigger_id, hook_id,
			profile_id, environment_id)
		values (new.routine_id, new.version, v_trigger ->> 'id', (v_trigger ->> 'hookId')::uuid,
			new.profile_id, new.environment_id);
		return new;
	end if;$new$);

select pg_temp.event_wake_patch('public.qorpera_sync_company_file_listener()'::regprocedure,
	$old$	update public.qorpera_company_file_wake_cursors set active = new.status = 'active' and routine_version = new.current_version
	where routine_id = new.id;$old$,
	$new$	update public.qorpera_company_file_wake_cursors set active = new.status = 'active' and routine_version = new.current_version
	where routine_id = new.id;
	-- Event listeners: a resume or a new current version starts from now, as a file listener does.
	perform 1 from public.qorpera_event_listener_cursors where routine_id = new.id for update;
	update public.qorpera_event_listener_cursors
	set activated_at = case when not active and new.status = 'active' and routine_version = new.current_version
			then clock_timestamp() else activated_at end,
		active = new.status = 'active' and routine_version = new.current_version
	where routine_id = new.id;$new$);

-- An agent's own routine may listen to any live hook of its company.
select pg_temp.event_wake_patch('public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure,
	$old$		-- A file listener may only watch what this agent and its requester may read.
		if v_trigger ->> 'kind' = 'listener' and not public.qorpera_wake_path_authorized($old$,
	$new$		-- An event listener may only listen to a live hook of this agent's company.
		if v_trigger ->> 'source' = 'event' and not exists (select 1 from public.qorpera_event_hooks as hook
			where hook.id = (v_trigger ->> 'hookId')::uuid and hook.profile_id = v_run.profile_id
				and hook.environment_id = v_run.environment_id and hook.status <> 'removed') then
			raise exception 'Routine listener hook is unavailable' using errcode = '42501'; end if;
		-- A file listener may only watch what this agent and its requester may read.
		if v_trigger ->> 'kind' = 'listener' and v_trigger ->> 'source' = 'company-file' and not public.qorpera_wake_path_authorized($new$);

-- ---------------------------------------------------------------------------
-- 4. Admission, authority and policy take the new source
-- ---------------------------------------------------------------------------
select pg_temp.event_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$			or new.source_kind not in ('schedule','company-file') then$old$,
	$new$			or (new.source_kind = 'event' and (v_trigger ->> 'kind' <> 'listener' or v_trigger ->> 'source' is distinct from 'event'
				or new.file_event_id is not null))
			or new.source_kind not in ('schedule','company-file','event') then$new$);
select pg_temp.event_wake_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$		new.source_id := coalesce(new.file_event_id,new.routine_id);$old$,
	$new$		new.source_id := case when new.source_kind = 'event' then (v_trigger ->> 'hookId')::uuid
			else coalesce(new.file_event_id,new.routine_id) end;$new$);

select pg_temp.event_wake_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$	elsif p_wake.wake_kind = 'agent' then
		if not (p_wake.source_kind = 'worker-dispatch'$old$,
	$new$	elsif p_wake.source_kind = 'event' then
		-- The hook still belongs to the company and was not removed.
		if not exists (select 1 from public.qorpera_event_hooks as hook where hook.id = p_wake.source_id
			and hook.profile_id = p_wake.profile_id and hook.environment_id = p_wake.environment_id
			and hook.status <> 'removed') then return false; end if;
	elsif p_wake.wake_kind = 'agent' then
		if not (p_wake.source_kind = 'worker-dispatch'$new$);

-- Folder companies take event wakes with routine files (F2-6), not before.
select pg_temp.event_wake_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$p_wake.source_kind in ('company-file','office-activation','machine-event')$old$,
	$new$p_wake.source_kind in ('company-file','office-activation','machine-event','event')$new$);

select pg_temp.event_wake_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file'))$old$,
	$new$			or (v_wake.source_kind = 'event' and v_wake.file_event_id is not null)
			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file','event'))$new$);
select pg_temp.event_wake_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> 'listener') then$old$,
	$new$			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> 'listener')
			or (v_wake.source_kind = 'event' and (v_trigger ->> 'kind' <> 'listener'
				or v_trigger ->> 'source' is distinct from 'event'
				or v_wake.source_id is distinct from (v_trigger ->> 'hookId')::uuid)) then$new$);

-- ---------------------------------------------------------------------------
-- 5. The drain: one event occurrence per routine trigger while deliveries wait
-- ---------------------------------------------------------------------------

-- The verified deliveries a listener has not taken yet, in the order it takes them. Planned with
-- the cursor's values each call (a one-shot plan), so the watermark, the activation and the 7-day
-- window (a delivery is verified once it is received) bound the index range. The bounds are passed
-- as values: a volatile expression in the query would only filter rows.
create function public.qorpera_event_listener_waiting(p_cursor public.qorpera_event_listener_cursors, p_only jsonb, p_limit integer)
returns setof public.qorpera_event_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare v_window timestamptz := clock_timestamp() - interval '7 days';
begin
	return query execute $query$
		select delivery.* from public.qorpera_event_deliveries as delivery
		where delivery.hook_id = $1 and delivery.status = 'verified'
			and delivery.verified_at >= $2
			and delivery.received_at >= $3
			and delivery.received_at > $8
			and ($4::jsonb is null or delivery.event_type in (select jsonb_array_elements_text($4::jsonb)))
			and not exists (select 1 from public.qorpera_event_wake_deliveries as taken
				where taken.routine_id = $5 and taken.trigger_id = $6 and taken.delivery_id = delivery.id)
		order by delivery.verified_at, delivery.id
		limit $7$query$
	using p_cursor.hook_id,
		greatest(p_cursor.taken_before, p_cursor.activated_at - interval '1 second', v_window - interval '1 second'),
		p_cursor.activated_at, p_only, p_cursor.routine_id, p_cursor.trigger_id, p_limit, v_window;
end
$$;
revoke all on function public.qorpera_event_listener_waiting(public.qorpera_event_listener_cursors, jsonb, integer)
	from public, anon, authenticated, service_role;

create function public.qorpera_drain_event_wakes(p_limit integer default 32)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_cursor public.qorpera_event_listener_cursors%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_trigger jsonb; v_first public.qorpera_event_deliveries%rowtype;
	v_prefix text; v_attempts bigint; v_tried_at timestamptz; v_scanned integer := 0; v_admitted integer := 0;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Event wake drain authority or bound is invalid' using errcode = '42501'; end if;
	for v_cursor in
		select cursor.* from public.qorpera_event_listener_cursors as cursor where cursor.active
		order by cursor.last_scanned_at, cursor.routine_id, cursor.routine_version, cursor.trigger_id
		for update of cursor skip locked limit p_limit
	loop
		v_scanned := v_scanned + 1;
		update public.qorpera_event_listener_cursors set last_scanned_at = clock_timestamp()
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version
			and trigger_id = v_cursor.trigger_id;
		begin
			-- A removed hook wakes nothing more; its routine keeps its other state.
			if not exists (select 1 from public.qorpera_event_hooks where id = v_cursor.hook_id and status <> 'removed')
				or public.qorpera_company_execution_paused(v_cursor.profile_id) then continue; end if;
			-- The routine row before the company fence, never waiting: a routine save takes it first.
			perform 1 from public.qorpera_cloud_routines where id = v_cursor.routine_id
				and current_version = v_cursor.routine_version and status = 'active' for update nowait;
			if not found then continue; end if;
			-- One pending occurrence at a time: queued, or materialized with its job not yet running and
			-- nothing read. Only the trigger's open wakes are looked at.
			if exists (select 1 from public.qorpera_wake_occurrences as pending
				where pending.routine_id = v_cursor.routine_id and pending.trigger_id = v_cursor.trigger_id
					and pending.source_kind = 'event' and pending.status in ('queued','materialized')
					and (pending.status = 'queued' or (
						not exists (select 1 from public.qorpera_event_wake_deliveries where occurrence_id = pending.id)
						and exists (select 1 from public.qorpera_execution_runs as run
							join public.qorpera_runner_jobs as job on job.id = run.job_id
							where run.id = pending.run_id and job.status in ('queued','leased'))))) then continue; end if;
			select * into strict v_version from public.qorpera_cloud_routine_versions
			where routine_id = v_cursor.routine_id and version = v_cursor.routine_version;
			select value into strict v_trigger from jsonb_array_elements(v_version.triggers) as t(value)
			where value ->> 'id' = v_cursor.trigger_id;
			select * into v_first from public.qorpera_event_listener_waiting(v_cursor, v_trigger -> 'only', 1);
			if v_first.id is null then
				-- Nothing matching waits: what this listener skips (other types) is behind it now.
				update public.qorpera_event_listener_cursors
				set taken_before = greatest(taken_before, clock_timestamp() - interval '1 minute')
				where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version
					and trigger_id = v_cursor.trigger_id;
				continue;
			end if;
			-- Earlier wakes for the same first delivery that ended without taking it: retried after 1,
			-- 4, 16 and 64 minutes, then the delivery is left behind with the last of them.
			v_prefix := 'event:' || v_cursor.routine_version::text || ':' || v_cursor.trigger_id || ':' || v_first.id::text;
			select count(*), max(created_at) into v_attempts, v_tried_at from public.qorpera_wake_occurrences
			where routine_id = v_cursor.routine_id
				and occurrence_key = any (array(select v_prefix || ':' || n from generate_series(1, 5) as n));
			if v_attempts >= 5 then
				insert into public.qorpera_event_wake_deliveries(routine_id, trigger_id, delivery_id, occurrence_id)
				select v_cursor.routine_id, v_cursor.trigger_id, v_first.id, id from public.qorpera_wake_occurrences
				where routine_id = v_cursor.routine_id and occurrence_key = v_prefix || ':5'
				on conflict do nothing;
				continue;
			end if;
			if v_attempts > 0 and clock_timestamp() < v_tried_at + interval '1 minute' * power(4, v_attempts - 1) then
				continue; end if;
			-- A routine that must report needs a public audience, as for file listeners.
			if coalesce(v_trigger ->> 'replyPolicy','required') not in ('optional','silent')
				and public.qorpera_wake_public_session(v_version.profile_id, v_cursor.environment_id,
					v_version.staff_agent_id, v_version.created_by_user_id) is null then continue; end if;
			perform public.qorpera_serialize_wake_admission(v_cursor.profile_id);
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version,
				wake_kind, source_kind, trigger_id, occurrence_key, scheduled_for, not_before, payload)
			values (extensions.gen_random_uuid(), v_version.profile_id, v_cursor.environment_id, v_cursor.routine_id,
				v_cursor.routine_version, 'routine', 'event', v_cursor.trigger_id, v_prefix || ':' || (v_attempts + 1)::text,
				v_first.received_at, clock_timestamp(),
				jsonb_build_object('hookId', v_cursor.hook_id, 'firstDeliveryId', v_first.id));
			v_admitted := v_admitted + 1;
		exception when lock_not_available or deadlock_detected then continue;
			when insufficient_privilege or no_data_found or object_not_in_prerequisite_state
				or check_violation or unique_violation or invalid_parameter_value then
				-- The agent, the requester or the audience is gone; the cursor is tried again later.
				continue;
		end;
	end loop;
	return jsonb_build_object('schema','qorpera.event-wake-drain/v1','scanned',v_scanned,'admitted',v_admitted);
end
$$;
revoke all on function public.qorpera_drain_event_wakes(integer) from public, anon, authenticated;
grant execute on function public.qorpera_drain_event_wakes(integer) to service_role;

select pg_temp.event_wake_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$	perform public.qorpera_drain_company_file_wakes(p_limit);$old$,
	$new$	perform public.qorpera_drain_company_file_wakes(p_limit);
	perform public.qorpera_drain_event_wakes(p_limit);$new$);

-- ---------------------------------------------------------------------------
-- 6. What the run reads: the batch the occurrence took, as outside content
-- ---------------------------------------------------------------------------

-- The longest prefix of p_text whose JSON string (quotes and escapes included) fits p_bytes, as a
-- character count.
create function public.qorpera_event_json_prefix(p_text text, p_bytes integer)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare v_chars integer := least(char_length(p_text), greatest(p_bytes, 0)); v_size integer;
begin
	loop
		v_size := octet_length(to_jsonb(left(p_text, v_chars))::text);
		exit when v_size <= p_bytes or v_chars = 0;
		v_chars := greatest(0, least(v_chars - 1, (v_chars::bigint * p_bytes / v_size)::integer));
	end loop;
	return v_chars;
end
$$;
revoke all on function public.qorpera_event_json_prefix(text, integer) from public, anon, authenticated, service_role;

-- A body as the agent first sees it, within p_bytes of JSON: text when it is UTF-8, else base64.
create function public.qorpera_event_body_view(p_body bytea, p_bytes integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare v_text text; v_chars integer; v_raw integer;
begin
	if p_body is null then return jsonb_build_object('bodyCleared', true); end if;
	if p_bytes < 64 then return jsonb_build_object('truncated', octet_length(p_body) > 0); end if;
	begin
		v_text := convert_from(p_body, 'UTF8');
	exception when others then
		v_raw := (p_bytes - 48) / 4 * 3;
		return jsonb_build_object('encoding', 'base64',
			'data', translate(encode(substring(p_body from 1 for v_raw), 'base64'), E'\n', ''),
			'truncated', octet_length(p_body) > v_raw);
	end;
	v_chars := public.qorpera_event_json_prefix(v_text, p_bytes - 48);
	return jsonb_build_object('encoding', 'utf8', 'text', left(v_text, v_chars), 'truncated', char_length(v_text) > v_chars);
end
$$;
revoke all on function public.qorpera_event_body_view(bytea, integer) from public, anon, authenticated, service_role;

-- One event's description in a wake, without its body.
create function public.qorpera_event_wake_item(p_delivery public.qorpera_event_deliveries)
returns jsonb
language sql
stable
set search_path = ''
as $$
	select jsonb_build_object('deliveryId', p_delivery.id, 'type', p_delivery.event_type,
		'receivedAt', to_char(p_delivery.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'contentType', p_delivery.content_type, 'bytes', p_delivery.body_bytes)
$$;
revoke all on function public.qorpera_event_wake_item(public.qorpera_event_deliveries) from public, anon, authenticated, service_role;

-- The occurrence's batch within p_room bytes of JSON: the first read takes up to 20 deliveries (fewer
-- when their descriptions alone would not fit), a retried run reads the same ones, and bodies share
-- what room is left, at most 8 KiB each.
create function public.qorpera_event_wake_payload(p_wake public.qorpera_wake_occurrences, p_room integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_cursor public.qorpera_event_listener_cursors%rowtype; v_trigger jsonb; v_hook jsonb;
	v_item public.qorpera_event_deliveries%rowtype;
	v_room integer; v_described integer := 0; v_meta jsonb; v_view jsonb; v_events jsonb := '[]'::jsonb;
	v_more bigint; v_next timestamptz;
begin
	if p_wake.source_kind is distinct from 'event' then return '{}'::jsonb; end if;
	select * into strict v_cursor from public.qorpera_event_listener_cursors
	where routine_id = p_wake.routine_id and routine_version = p_wake.routine_version and trigger_id = p_wake.trigger_id;
	select value into strict v_trigger from public.qorpera_cloud_routine_versions as version,
		jsonb_array_elements(version.triggers) as t(value)
	where version.routine_id = p_wake.routine_id and version.version = p_wake.routine_version
		and value ->> 'id' = p_wake.trigger_id;
	select jsonb_build_object('id', hook.id, 'name', hook.name, 'purpose', hook.purpose) into strict v_hook
	from public.qorpera_event_hooks as hook where hook.id = v_cursor.hook_id;
	-- The hook, the event list and the count of those waiting.
	v_room := p_room - octet_length(v_hook::text) - 64;
	if not exists (select 1 from public.qorpera_event_wake_deliveries where occurrence_id = p_wake.id) then
		for v_item in select * from public.qorpera_event_listener_waiting(v_cursor, v_trigger -> 'only', 20) loop
			v_meta := public.qorpera_event_wake_item(v_item);
			exit when v_described > 0 and v_described + octet_length(v_meta::text) + 64 > v_room;
			insert into public.qorpera_event_wake_deliveries(routine_id, trigger_id, delivery_id, occurrence_id)
			values (p_wake.routine_id, p_wake.trigger_id, v_item.id, p_wake.id) on conflict do nothing;
			v_described := v_described + octet_length(v_meta::text) + 64;
		end loop;
		-- Everything before the first delivery still waiting is taken; a minute behind the clock, so a
		-- receive still committing is never passed.
		select verified_at into v_next from public.qorpera_event_listener_waiting(v_cursor, v_trigger -> 'only', 1);
		update public.qorpera_event_listener_cursors
		set taken_before = least(coalesce(v_next, 'infinity'), clock_timestamp() - interval '1 minute')
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version
			and trigger_id = v_cursor.trigger_id
			and taken_before < least(coalesce(v_next, 'infinity'), clock_timestamp() - interval '1 minute')
			and ctid = (select ctid from public.qorpera_event_listener_cursors
				where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version
					and trigger_id = v_cursor.trigger_id for update skip locked);
	end if;
	select coalesce(sum(octet_length(public.qorpera_event_wake_item(delivery)::text) + 64), 0) into v_described
	from public.qorpera_event_wake_deliveries as taken
	join public.qorpera_event_deliveries as delivery on delivery.id = taken.delivery_id
	where taken.occurrence_id = p_wake.id;
	v_room := v_room - v_described;
	for v_item in
		select delivery.* from public.qorpera_event_wake_deliveries as taken
		join public.qorpera_event_deliveries as delivery on delivery.id = taken.delivery_id
		where taken.occurrence_id = p_wake.id
		order by delivery.verified_at, delivery.id
	loop
		v_view := public.qorpera_event_body_view(v_item.body, least(8192, v_room));
		v_room := v_room - octet_length(v_view::text);
		v_events := v_events || jsonb_build_array(public.qorpera_event_wake_item(v_item) || v_view);
	end loop;
	select count(*) into v_more from (
		select 1 from public.qorpera_event_listener_waiting(v_cursor, v_trigger -> 'only', 1000)) as rest;
	return jsonb_build_object('hook', v_hook, 'events', v_events, 'more', v_more);
end
$$;
revoke all on function public.qorpera_event_wake_payload(public.qorpera_wake_occurrences, integer)
	from public, anon, authenticated, service_role;

-- The batch takes the room the rest of the wake leaves, measured both as the kernel bounds the
-- envelope and as the runtime bounds the payload's JSON, with a margin for the batch's own layout.
select pg_temp.event_wake_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;$old$,
	$new$	if v_wake.source_kind = 'event' then
		v_payload := jsonb_set(v_payload, '{payload}', (v_payload -> 'payload') || public.qorpera_event_wake_payload(v_wake,
			least(49152 - pg_column_size(v_payload), 49152 - octet_length((v_payload -> 'payload')::text)) - 4096));
	end if;
	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;$new$);

-- ---------------------------------------------------------------------------
-- 7. Agents read a whole event, and list their company's hooks
-- ---------------------------------------------------------------------------

-- read_event: one verified delivery of the agent's company, in pieces of at most 16,000 characters
-- and 32 KiB of JSON (UTF-8), or 24 KiB of raw bytes as base64 (anything else); next is the offset
-- of the following piece, in characters or bytes.
create function public.qorpera_read_agent_event(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_delivery public.qorpera_event_deliveries%rowtype;
	v_hook public.qorpera_event_hooks%rowtype; v_offset integer; v_text text; v_chars integer; v_piece jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['deliveryId','offset'] <> '{}'::jsonb or jsonb_typeof(p_request -> 'deliveryId') is distinct from 'string'
		or (p_request ? 'offset' and (jsonb_typeof(p_request -> 'offset') <> 'number'
			or (p_request ->> 'offset')::numeric <> floor((p_request ->> 'offset')::numeric)
			or (p_request ->> 'offset')::numeric not between 0 and 1048576)) then
		raise exception 'Event request is invalid' using errcode = '22023'; end if;
	v_offset := coalesce((p_request ->> 'offset')::integer, 0);
	begin
		select * into v_delivery from public.qorpera_event_deliveries where id = (p_request ->> 'deliveryId')::uuid;
	exception when invalid_text_representation then
		raise exception 'Event request is invalid' using errcode = '22023';
	end;
	select * into v_hook from public.qorpera_event_hooks where id = v_delivery.hook_id;
	if v_delivery.id is null or v_delivery.status <> 'verified' or v_hook.profile_id is distinct from v_run.profile_id
		or v_hook.environment_id is distinct from v_run.environment_id then
		raise exception 'Event is unavailable' using errcode = '42501'; end if;
	if v_delivery.body is null then
		v_piece := jsonb_build_object('bodyCleared', true, 'done', true);
	else
		begin
			v_text := convert_from(v_delivery.body, 'UTF8');
		exception when others then
			v_text := null;
		end;
		if v_text is not null then
			v_text := substring(v_text from v_offset + 1);
			v_chars := public.qorpera_event_json_prefix(left(v_text, 16000), 32768);
			v_piece := jsonb_build_object('encoding', 'utf8', 'offset', v_offset, 'text', left(v_text, v_chars),
				'total', v_offset + char_length(v_text), 'done', v_chars >= char_length(v_text))
				|| case when v_chars < char_length(v_text) then jsonb_build_object('next', v_offset + v_chars) else '{}'::jsonb end;
		else
			v_piece := jsonb_build_object('encoding', 'base64', 'offset', v_offset,
				'data', translate(encode(substring(v_delivery.body from v_offset + 1 for 24576), 'base64'), E'\n', ''),
				'total', octet_length(v_delivery.body), 'done', v_offset + 24576 >= octet_length(v_delivery.body))
				|| case when v_offset + 24576 < octet_length(v_delivery.body)
					then jsonb_build_object('next', v_offset + 24576) else '{}'::jsonb end;
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.agent-event/v1', 'runId', v_run.id, 'deliveryId', v_delivery.id,
		'hook', jsonb_build_object('id', v_hook.id, 'name', v_hook.name), 'type', v_delivery.event_type,
		'receivedAt', v_delivery.received_at, 'contentType', v_delivery.content_type,
		'headers', v_delivery.headers, 'bytes', v_delivery.body_bytes) || v_piece;
end
$$;
revoke all on function public.qorpera_read_agent_event(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_read_agent_event(jsonb, jsonb) to service_role;

-- The company's live hooks as an agent sees them. Addresses, which let anyone post into a hook, only
-- for a run an owner or admin requested (members see them on the same terms), with the full URL once
-- operators set the intake's public origin.
create function public.qorpera_list_agent_event_hooks(p_binding jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run public.qorpera_execution_runs%rowtype; v_addresses boolean; v_url text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_addresses := exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin'));
	select settings.public_url into v_url from public.qorpera_event_intake_settings as settings;
	return jsonb_build_object('schema', 'qorpera.agent-event-hooks/v1', 'runId', v_run.id, 'hooks', coalesce((
		select jsonb_agg(public.qorpera_event_hook_descriptor(hook, v_addresses)
			|| case when v_addresses and v_url is not null
				then jsonb_build_object('url', v_url || '/functions/v1/event-intake/' || hook.address) else '{}'::jsonb end
			order by hook.name)
		from public.qorpera_event_hooks as hook
		where hook.profile_id = v_run.profile_id and hook.environment_id = v_run.environment_id
			and hook.status <> 'removed'), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_list_agent_event_hooks(jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_list_agent_event_hooks(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Observations name the new tools
-- ---------------------------------------------------------------------------
select pg_temp.event_wake_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'organize_sidebar','add_review_rule',$old$,
	$new$'organize_sidebar','add_review_rule','list_hooks','read_event',$new$);
