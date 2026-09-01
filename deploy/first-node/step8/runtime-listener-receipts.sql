-- External ingestion receipts are terminal delivery decisions, NOT an execution
-- queue. Successful admission must insert the existing Step 3 occurrence in the
-- SAME transaction. Missing Step 7 authority or Step 3 ingress fails closed.

create table public.qorpera_step8_external_events (
	routine_id uuid not null references public.qorpera_cloud_routines(id) on delete restrict,
	event_key text not null check(event_key ~ '^[0-9a-f]{64}$'),
	routine_version bigint not null,
	epoch bigint not null,
	outcome text not null check(outcome in ('admitted','ignored','denied')),
	occurrence_id uuid unique references public.qorpera_wake_occurrences(id) on delete restrict,
	primary key(routine_id,event_key),
	check((outcome = 'admitted') = (occurrence_id is not null)),
	foreign key(routine_id,routine_version) references public.qorpera_step8_routine_policies(routine_id,routine_version) on delete restrict
);
create table public.qorpera_step8_external_deliveries (
	routine_id uuid not null,
	delivery_id uuid not null,
	event_key text not null,
	body_sha256 text not null check(body_sha256 ~ '^[0-9a-f]{64}$'),
	primary key(routine_id,delivery_id),
	foreign key(routine_id,event_key) references public.qorpera_step8_external_events(routine_id,event_key) on delete restrict
);
create table public.qorpera_step8_external_watermarks (
	routine_id uuid not null,
	routine_version bigint not null,
	epoch bigint not null,
	resource_id text not null check(resource_id ~ '^[1-9][0-9]{0,19}$'),
	updated_at timestamptz not null,
	primary key(routine_id,routine_version,epoch,resource_id),
	foreign key(routine_id,routine_version) references public.qorpera_step8_routine_policies(routine_id,routine_version) on delete restrict
);

-- These are deliberately closed integration adapters. Replace their bodies
-- only after integrating the connector authorization and typed wake source.
-- A service JWT alone is not connector, audience, or source authority.
create function public.qorpera_step8_github_authorized(p_delivery jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin raise exception 'Step 7 GitHub eligibility adapter is unavailable' using errcode = '55000'; end $$;

create function public.qorpera_step8_admit_github_wake(p_delivery jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin raise exception 'Step 3 external wake admission adapter is unavailable' using errcode = '55000'; end $$;

create function public.qorpera_step8_ingest_github_at(p_delivery jsonb,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.qorpera_step8_routine_state%rowtype; p jsonb; t jsonb; event jsonb; prior public.qorpera_step8_external_events%rowtype;
	d public.qorpera_step8_external_deliveries%rowtype; status text; outcome text; occurrence uuid; updated timestamptz; highwater timestamptz;
	days text[] := array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Ingestion service authority required' using errcode = '42501'; end if;
	if jsonb_typeof(p_delivery) is distinct from 'object' or pg_column_size(p_delivery) > 8192
		or p_delivery ->> 'schema' is distinct from 'qorpera.github-delivery/v1'
		or not (p_delivery ?& array['schema','routineId','version','epoch','triggerId','connectionId','deliveryId','bodySha256','eventKey','receivedAt','event'])
		or p_delivery - array['schema','routineId','version','epoch','triggerId','connectionId','deliveryId','bodySha256','eventKey','receivedAt','event'] <> '{}'
		or jsonb_typeof(p_delivery -> 'bodySha256') is distinct from 'string'
		or jsonb_typeof(p_delivery -> 'eventKey') is distinct from 'string'
		or coalesce(p_delivery ->> 'bodySha256','') !~ '^[0-9a-f]{64}$' or coalesce(p_delivery ->> 'eventKey','') !~ '^[0-9a-f]{64}$'
		or coalesce(p_delivery ->> 'deliveryId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or p_now is null or not isfinite(p_now) then raise exception 'Invalid verified delivery' using errcode = '22023'; end if;
	event := p_delivery -> 'event';
	if jsonb_typeof(event) is distinct from 'object' or event ->> 'schema' is distinct from 'qorpera.github-event/v1'
		or event ->> 'source' is distinct from 'github' or event ->> 'trust' is distinct from 'external'
		or not (event ?& array['schema','source','trust','event','action','installationId','repositoryId','pullRequestId','number','senderId','updatedAt','headSha','reviewTarget'])
		or event - array['schema','source','trust','event','action','installationId','repositoryId','pullRequestId','number','senderId','updatedAt','headSha','reviewTarget'] <> '{}'
		or exists(select 1 from jsonb_each(event) where key in ('installationId','repositoryId','pullRequestId','senderId')
			and (jsonb_typeof(value) <> 'string' or value #>> '{}' !~ '^[1-9][0-9]{0,19}$'))
		or jsonb_typeof(event -> 'headSha') is distinct from 'string' or coalesce(event ->> 'headSha','') !~ '^[0-9a-f]{40}$'
		or jsonb_typeof(event -> 'action') is distinct from 'string'
		or event ->> 'action' not in ('opened','edited','reopened','synchronize','closed','review_requested')
		or jsonb_typeof(event -> 'event') is distinct from 'string'
		or event ->> 'event' not in ('pull_request.opened','pull_request.updated','pull_request.merged','pull_request.review_requested')
		or event ->> 'event' is distinct from (case event ->> 'action' when 'opened' then 'pull_request.opened'
			when 'edited' then 'pull_request.updated' when 'reopened' then 'pull_request.updated' when 'synchronize' then 'pull_request.updated'
			when 'closed' then 'pull_request.merged' when 'review_requested' then 'pull_request.review_requested' end)
		or jsonb_typeof(event -> 'number') is distinct from 'number' or event ->> 'number' !~ '^[1-9][0-9]*$'
		or (event ->> 'number')::numeric > 9007199254740991
		or (case when event ->> 'action' = 'review_requested' then
			jsonb_typeof(event -> 'reviewTarget') is distinct from 'string' or event ->> 'reviewTarget' !~ '^(user|team):[1-9][0-9]{0,19}$'
			else event -> 'reviewTarget' is distinct from 'null'::jsonb end)
		then raise exception 'Invalid normalized GitHub event' using errcode = '22023'; end if;
	s := public.qorpera_step8_locked_state((p_delivery ->> 'routineId')::uuid,(p_delivery ->> 'version')::bigint,(p_delivery ->> 'epoch')::bigint);
	select policy into strict p from public.qorpera_step8_routine_policies where routine_id = s.routine_id and routine_version = s.routine_version;
	select v.triggers -> 0,r.status into t,status from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id = v.routine_id
		where v.routine_id = s.routine_id and v.version = s.routine_version;
	if not public.qorpera_step8_trigger_valid(jsonb_build_array(t),p) or t ->> 'source' is distinct from 'github'
		or t ->> 'id' is distinct from p_delivery ->> 'triggerId' or t ->> 'connectionId' is distinct from p_delivery ->> 'connectionId'
		or t ->> 'installationId' is distinct from event ->> 'installationId' or t ->> 'repositoryId' is distinct from event ->> 'repositoryId'
		or (t #>> '{actors,mode}' = 'allowlist' and not (t #> '{actors,ids}' ? (event ->> 'senderId'))) then raise exception 'GitHub listener identity is unavailable' using errcode = '42501'; end if;
	select * into d from public.qorpera_step8_external_deliveries where routine_id = s.routine_id and delivery_id = (p_delivery ->> 'deliveryId')::uuid;
	if found and (d.body_sha256 <> p_delivery ->> 'bodySha256' or d.event_key <> p_delivery ->> 'eventKey') then raise exception 'Delivery id is bound to different content' using errcode = '23505'; end if;
	-- Use the same canonical instant domain as the compiler and schedule plans,
	-- including the Unix-epoch floor, before parsing or replaying a receipt.
	if not public.qorpera_step8_instant_valid(p_delivery -> 'receivedAt') then
		raise exception 'Invalid delivery clock' using errcode = '22023'; end if;
	updated := (event ->> 'updatedAt')::timestamptz;
	if updated is null or not isfinite(updated) or updated < '1970-01-01Z'::timestamptz
		or jsonb_typeof(event -> 'updatedAt') is distinct from 'string'
		or to_char(updated at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> event ->> 'updatedAt'
		or (p_delivery ->> 'receivedAt')::timestamptz > p_now
		then raise exception 'Invalid delivery clock' using errcode = '22023'; end if;
	-- Keep the trusted cloud clock in the same locked transaction as every
	-- terminal receipt, including ignored events and duplicates. Provider time
	-- cannot move this fence. Missing authority or any later error rolls it back.
	-- Retain the prior state in s to detect regression for new admissions below.
	update public.qorpera_step8_routine_state set observed_through = greatest(observed_through,date_trunc('milliseconds',p_now))
		where routine_id = s.routine_id;
	select * into prior from public.qorpera_step8_external_events where routine_id = s.routine_id and event_key = p_delivery ->> 'eventKey';
	-- Receipt replay is no new admission. It never requeues cancelled work.
	if found then
		insert into public.qorpera_step8_external_deliveries(routine_id,delivery_id,event_key,body_sha256)
		values(s.routine_id,(p_delivery ->> 'deliveryId')::uuid,prior.event_key,p_delivery ->> 'bodySha256') on conflict do nothing;
		return jsonb_build_object('schema','qorpera.github-delivery-receipt/v1','status','duplicate','occurrenceId',prior.occurrence_id);
	end if;
	select updated_at into highwater from public.qorpera_step8_external_watermarks where routine_id = s.routine_id
		and routine_version = s.routine_version and epoch = s.epoch and resource_id = event ->> 'pullRequestId';
	outcome := 'ignored';
	if status = 'active' and s.suspension is null and updated > s.active_since and p_now >= s.observed_through
		and (p_delivery ->> 'receivedAt')::timestamptz >= s.active_since
		and ((p ->> 'expiresAt')::timestamptz is null or greatest(updated,p_now) < (p ->> 'expiresAt')::timestamptz)
		and updated >= p_now - make_interval(secs => (t #>> '{delivery,maxAgeSeconds}')::integer)
		and updated <= p_now + make_interval(secs => (t #>> '{delivery,maxFutureSkewSeconds}')::integer)
		and t -> 'events' ? (event ->> 'event') and public.qorpera_step8_clock_allowed(p,p_now)
		and public.qorpera_step8_clock_allowed(p,(p_delivery ->> 'receivedAt')::timestamptz)
		and p -> 'defaultWeekdays' ? days[extract(dow from p_now at time zone (p ->> 'timeZone'))::integer+1]
		and p -> 'defaultWeekdays' ? days[extract(dow from (p_delivery ->> 'receivedAt')::timestamptz at time zone (p ->> 'timeZone'))::integer+1]
		and (t #>> '{delivery,reordered}' = 'accept' or highwater is null or updated >= highwater) then
		-- Missing adapters abort before any receipt/watermark can commit.
		if public.qorpera_step8_github_authorized(p_delivery) is distinct from true then outcome := 'denied';
		else
			occurrence := public.qorpera_step8_admit_github_wake(p_delivery);
			if occurrence is null or not exists(select 1 from public.qorpera_wake_occurrences where id = occurrence
				and routine_id = s.routine_id and routine_version = s.routine_version and trigger_id = t ->> 'id'
				and source_kind = 'github' and payload = event) then raise exception 'Typed external wake admission unavailable' using errcode = '55000'; end if;
			insert into public.qorpera_step8_occurrence_epochs(occurrence_id,routine_id,routine_version,epoch) values(occurrence,s.routine_id,s.routine_version,s.epoch);
			outcome := 'admitted';
		end if;
	end if;
	insert into public.qorpera_step8_external_events(routine_id,event_key,routine_version,epoch,outcome,occurrence_id)
	values(s.routine_id,p_delivery ->> 'eventKey',s.routine_version,s.epoch,outcome,occurrence);
	insert into public.qorpera_step8_external_deliveries(routine_id,delivery_id,event_key,body_sha256)
	values(s.routine_id,(p_delivery ->> 'deliveryId')::uuid,p_delivery ->> 'eventKey',p_delivery ->> 'bodySha256');
	-- Equal timestamps do NOT imply the same event. All equal-time distinct
	-- bodies are admitted; UUIDs never pretend to be a vendor ordering cursor.
	if outcome <> 'denied' and updated <= p_now then
		insert into public.qorpera_step8_external_watermarks(routine_id,routine_version,epoch,resource_id,updated_at)
		values(s.routine_id,s.routine_version,s.epoch,event ->> 'pullRequestId',updated)
		on conflict(routine_id,routine_version,epoch,resource_id) do update set updated_at = greatest(qorpera_step8_external_watermarks.updated_at,excluded.updated_at);
	end if;
	return jsonb_build_object('schema','qorpera.github-delivery-receipt/v1','status',outcome,'occurrenceId',occurrence);
end $$;

create function public.qorpera_step8_ingest_github(p_delivery jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Ingestion service authority required' using errcode = '42501'; end if;
	perform public.qorpera_step8_locked_state((p_delivery ->> 'routineId')::uuid,(p_delivery ->> 'version')::bigint,(p_delivery ->> 'epoch')::bigint);
	receipt := public.qorpera_step8_ingest_github_at(p_delivery,clock_timestamp());
	if receipt ->> 'status' = 'admitted' and not public.qorpera_step8_occurrence_allowed_at((receipt ->> 'occurrenceId')::uuid,clock_timestamp()) then
		raise exception 'External policy or authority changed during admission' using errcode = '55000'; end if;
	return receipt;
end
$$;

alter table public.qorpera_step8_external_events enable row level security;
alter table public.qorpera_step8_external_deliveries enable row level security;
alter table public.qorpera_step8_external_watermarks enable row level security;
revoke all on public.qorpera_step8_external_events,public.qorpera_step8_external_deliveries,public.qorpera_step8_external_watermarks from public,anon,authenticated,service_role;
revoke all on function public.qorpera_step8_github_authorized(jsonb),public.qorpera_step8_admit_github_wake(jsonb),public.qorpera_step8_ingest_github_at(jsonb,timestamptz),public.qorpera_step8_ingest_github(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_step8_ingest_github(jsonb) to service_role;
