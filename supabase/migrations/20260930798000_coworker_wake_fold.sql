do $$ begin
	if exists (select 1 from information_schema.columns where table_schema = 'public'
			and table_name = 'qorpera_pending_peer_messages' and column_name = 'wake_id') then
		raise exception '20260930798000 is already applied'; end if;
	if md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(
			'public.qorpera_drain_held_peer_messages(public.qorpera_execution_runs,uuid)')), '')) <> '367a70d02cc45766ff7349d39115bc1e'
		or md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.qorpera_folder_read_wake(jsonb)')), ''))
			<> 'ed2a1d46631413b9da5239bbcdcf0bbe'
		or md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(
			'public.qorpera_folder_materialize_company(uuid,integer)')), '')) <> '9b43bc2de980a49f1b510a29a8481a93' then
		raise exception '20260930798000: the wake read, the held message drain or the materializer differs from its pinned body';
	end if;
end $$;

set local lock_timeout = '3s';

alter table public.qorpera_pending_peer_messages add column wake_id uuid;
create unique index qorpera_pending_peer_messages_wake on public.qorpera_pending_peer_messages(wake_id)
	where wake_id is not null;

create function public.qorpera_peer_message_shown(p_text text, p_full boolean)
returns text language plpgsql immutable set search_path = '' as $$
declare
	v_marker constant text := ' … [cut: the full message is in your transcript with this coworker]';
	v_room constant integer := 1600 - octet_length(v_marker);
	v_cut text;
begin
	if p_full or octet_length(p_text) <= 1600 then return p_text; end if;
	v_cut := left(p_text, v_room);
	while octet_length(v_cut) > v_room loop
		v_cut := left(v_cut, char_length(v_cut) - (octet_length(v_cut) - v_room + 3) / 4);
	end loop;
	return v_cut || v_marker;
end $$;
revoke all on function public.qorpera_peer_message_shown(text, boolean) from public, anon, authenticated, service_role;

create or replace function public.qorpera_drain_held_peer_messages(p_run public.qorpera_execution_runs,
	p_shown_pair uuid default null::uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_messages jsonb; v_count integer; v_bytes integer; v_note record;
begin
	delete from public.qorpera_pending_peer_messages where id in (
		select id from public.qorpera_pending_peer_messages
		where profile_id = p_run.profile_id and delivered_at < clock_timestamp() - interval '7 days' limit 200);
	select count(*), coalesce(sum(octet_length(public.qorpera_peer_message_shown(pending.text, pending.wake_id is not null))), 0)
	into v_count, v_bytes
	from public.qorpera_pending_peer_messages as pending where pending.delivered_run_id = p_run.id;
	for v_note in select pending.id,
			octet_length(public.qorpera_peer_message_shown(pending.text, pending.wake_id is not null)) as bytes
		from public.qorpera_pending_peer_messages as pending
		where pending.profile_id = p_run.profile_id and pending.recipient_staff_id = p_run.staff_agent_id
			and pending.wake_id is null and (pending.delivered_run_id is null or exists (
				select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
				where run.id = pending.delivered_run_id and job.status in ('failed','cancelled')))
		order by pending.created_at, pending.id limit 12 for update skip locked
	loop
		exit when v_count >= 12 or v_bytes + v_note.bytes > 19200;
		update public.qorpera_pending_peer_messages set delivered_run_id = p_run.id, delivered_at = clock_timestamp()
		where id = v_note.id;
		v_count := v_count + 1;
		v_bytes := v_bytes + v_note.bytes;
	end loop;
	select jsonb_agg(jsonb_build_object('eventId',pending.event_id,'staffAgentId',pending.sender_staff_id,
		'text',public.qorpera_peer_message_shown(pending.text, pending.wake_id is not null),
		'at',to_char(pending.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'pairSessionId',pending.pair_session_id) order by pending.created_at, pending.id)
	into v_messages
	from (select * from public.qorpera_pending_peer_messages where delivered_run_id = p_run.id
		and (wake_id is not null or char_length(text) > 400 or p_shown_pair is null or pair_session_id <> p_shown_pair
			or event_id not in (
			select event.event_id from public.qorpera_session_events event
			where event.session_id = p_shown_pair and event.event_type = 'message'
				and event.body #>> '{entry,delivery,schema}' = 'qorpera.peer-message/v1'
			order by event.sequence desc limit 12))
		order by created_at, id limit 12) pending;
	return case when v_messages is null then '{}'::jsonb else jsonb_build_object('heldMessages',v_messages) end;
end $$;

create function public.qorpera_coworker_take_waiting(p_run public.qorpera_execution_runs,
	p_wake public.qorpera_wake_occurrences, p_resolved jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_waiting public.qorpera_wake_occurrences%rowtype; v_count integer; v_bytes integer; v_text text; v_pair uuid;
	v_event uuid; v_reads jsonb; v_pairs jsonb;
begin
	if p_wake.wake_kind <> 'agent' or p_wake.source_kind <> 'coworker' or p_wake.session_id is null then return; end if;
	select count(*), coalesce(sum(octet_length(public.qorpera_peer_message_shown(pending.text, pending.wake_id is not null))), 0)
	into v_count, v_bytes
	from public.qorpera_pending_peer_messages as pending where pending.delivered_run_id = p_run.id;
	for v_waiting in select waiting.* from public.qorpera_wake_occurrences as waiting
		where waiting.profile_id = p_wake.profile_id and waiting.staff_agent_id = p_wake.staff_agent_id
			and waiting.session_id = p_wake.session_id and waiting.status = 'queued' and waiting.wake_kind = 'agent'
			and waiting.source_kind = 'coworker' and waiting.id <> p_wake.id and waiting.created_at <= p_run.created_at
			and waiting.requested_by_user_id = p_wake.requested_by_user_id
			and waiting.sponsor_binding_id = p_wake.sponsor_binding_id and waiting.sponsor_version = p_wake.sponsor_version
			and waiting.logical_computer_id is not distinct from p_wake.logical_computer_id
			and not exists (select 1 from public.qorpera_pending_peer_messages as taken
				join public.qorpera_execution_runs as carrier on carrier.id = taken.delivered_run_id
				join public.qorpera_runner_jobs as job on job.id = carrier.job_id
				where taken.wake_id = waiting.id and job.status not in ('failed', 'cancelled'))
		order by waiting.created_at, waiting.id
		for update skip locked
	loop
		v_text := v_waiting.payload ->> 'text';
		continue when v_text is null or v_waiting.parent_run_id is null or v_waiting.payload ->> 'senderStaffId' is null
			or v_waiting.payload ->> 'pairSessionId' is null or v_waiting.payload ->> 'pairEventId' is null;
		exit when v_count >= 12 or v_bytes + octet_length(v_text) > 19200;
		v_pair := (v_waiting.payload ->> 'pairSessionId')::uuid;
		v_event := (v_waiting.payload ->> 'pairEventId')::uuid;
		begin
			continue when v_waiting.causal_root_id is not null and (not pg_try_advisory_xact_lock_shared(
					public.qorpera_causal_chain_key(v_waiting.profile_id, v_waiting.causal_root_id))
				or public.qorpera_causal_chain_stopped(v_waiting.profile_id, v_waiting.causal_root_id));
			continue when not public.qorpera_wake_authorized(v_waiting);
			continue when not exists (select 1 from public.qorpera_session_events as event
				where event.event_id = v_event and event.session_id = v_pair);
			perform 1 from public.qorpera_shared_sessions as pair where pair.id = v_pair for key share skip locked;
			continue when not found;
			insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
			select p_run.id, v_waiting.id, p_run.environment_id, '00000000-0000-0000-0000-000000000000'::uuid,
				jsonb_agg(latest.x order by public.qorpera_folder_key(latest.x ->> 'path')), repeat('0', 64)
			from (select distinct on (x ->> 'path') x from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
				where rec.resource_id = '00000000-0000-0000-0000-000000000000'::uuid and rec.run_id = v_waiting.parent_run_id
				order by x ->> 'path', rec.created_at desc, rec.release_id) latest
			having count(*) > 0;
			select coalesce(jsonb_agg(latest.x order by public.qorpera_folder_key(latest.x ->> 'path')), '[]'::jsonb) into v_reads
			from (select distinct on (x ->> 'path') x from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
				where rec.run_id = v_waiting.parent_run_id and rec.resource_id <> '00000000-0000-0000-0000-000000000000'::uuid
				order by x ->> 'path', rec.created_at desc, rec.release_id) latest;
			if jsonb_array_length(v_reads) > 0 then
				v_pairs := public.qorpera_folder_release_pairs(p_run.environment_id, p_run.profile_id, p_resolved, v_reads);
				perform public.qorpera_folder_write_read_set(p_run.environment_id, p_run.id, v_pairs -> 'upserts', null, null);
				insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
				select p_run.id, v_waiting.id, p_run.environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
					jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), repeat('0', 64)
				from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
			end if;
			delete from public.qorpera_pending_peer_messages where wake_id = v_waiting.id;
			insert into public.qorpera_pending_peer_messages(profile_id, environment_id, pair_session_id, event_id, sender_staff_id,
				recipient_staff_id, text, created_at, delivered_run_id, delivered_at, wake_id)
			values (p_run.profile_id, p_run.environment_id, v_pair, v_event, (v_waiting.payload ->> 'senderStaffId')::uuid,
				p_run.staff_agent_id, v_text, v_waiting.created_at, p_run.id, clock_timestamp(), v_waiting.id);
			v_count := v_count + 1;
			v_bytes := v_bytes + octet_length(v_text);
		exception when others then
			-- WHY: a waiting message this run cannot take (a read it may no longer place, a row that moved) keeps its own
			-- wake and runs alone, as every message did before.
			null;
		end;
	end loop;
end $$;
revoke all on function public.qorpera_coworker_take_waiting(public.qorpera_execution_runs, public.qorpera_wake_occurrences, jsonb)
	from public, anon, authenticated, service_role;

create function pg_temp.cwf_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930798000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.cwf_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure,
	$old$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
$old$,
	$new$	perform public.qorpera_coworker_take_waiting(v_run, v_wake, v_tool -> 'resolved');
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
$new$);

select pg_temp.cwf_replace('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	$old$			if v_wake.wake_kind not in ('routine', 'agent', 'room') or not public.qorpera_wake_authorized(v_wake) then
$old$,
	$new$			if v_wake.source_kind = 'coworker' and exists (select 1 from public.qorpera_pending_peer_messages as taken
					join public.qorpera_execution_runs as carrier on carrier.id = taken.delivered_run_id
					join public.qorpera_runner_jobs as job on job.id = carrier.job_id
					where taken.wake_id = v_wake.id and job.status in ('queued', 'leased')) then
				v_skipped := v_skipped + 1;
				continue;
			end if;
			if v_wake.source_kind = 'coworker' and exists (select 1 from public.qorpera_pending_peer_messages as taken
					join public.qorpera_execution_runs as carrier on carrier.id = taken.delivered_run_id
					join public.qorpera_runner_jobs as job on job.id = carrier.job_id
					where taken.wake_id = v_wake.id and job.status = 'completed') then
				update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
					blocked_reason = 'Delivered with another coworker message in run ' || (select taken.delivered_run_id::text
						from public.qorpera_pending_peer_messages as taken where taken.wake_id = v_wake.id)
				where id = v_wake.id;
				v_cancelled := v_cancelled + 1;
				continue;
			end if;
			if v_wake.source_kind = 'coworker' then
				delete from public.qorpera_pending_peer_messages where id in (select taken.id
					from public.qorpera_pending_peer_messages as taken where taken.wake_id = v_wake.id for update skip locked);
			end if;
			if v_wake.wake_kind not in ('routine', 'agent', 'room') or not public.qorpera_wake_authorized(v_wake) then
$new$);

drop function pg_temp.cwf_replace(regprocedure, text, text);
