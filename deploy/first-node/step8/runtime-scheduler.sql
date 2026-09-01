-- Step 8 component module, deliberately NOT an automatically applied migration.
-- Requires the pinned Company File path gateway and Step 3 wake bus.
-- No shared function is replaced. Call private projection helpers from the
-- existing authorized Company File transaction, not from a second writer.

-- Matches routineInstant: canonical UTC text with exactly millisecond
-- precision. A different spelling must never be rounded into a CAS or identity.
create function public.qorpera_step8_instant_valid(p jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare at timestamptz;
begin
	if jsonb_typeof(p) is distinct from 'string'
		or p #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return false; end if;
	at := (p #>> '{}')::timestamptz;
	return isfinite(at) and at >= '1970-01-01Z'::timestamptz
		and to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = p #>> '{}';
exception when others then return false;
end $$;

create function public.qorpera_step8_policy_valid(p jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare w jsonb; days jsonb;
begin
	if jsonb_typeof(p) is distinct from 'object' or pg_column_size(p) > 8192
		or not (p ?& array['schema','timeZone','defaultWeekdays','expiresAt','quietWindows','quietMode','dst','catchUp','resume','authFailures'])
		or p - array['schema','timeZone','defaultWeekdays','expiresAt','quietWindows','quietMode','dst','catchUp','resume','authFailures'] <> '{}'
		or p ->> 'schema' is distinct from 'qorpera.routine-policy/v1'
		or p ->> 'quietMode' is distinct from 'skip' or p ->> 'resume' is distinct from 'future-only'
		or jsonb_typeof(p -> 'timeZone') is distinct from 'string'
		or p ->> 'timeZone' !~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+.-]+)+)$'
		or not exists(select 1 from pg_catalog.pg_timezone_names where name = p ->> 'timeZone')
		or jsonb_typeof(p -> 'dst') is distinct from 'object'
		or (p -> 'dst') - array['gap','fold'] <> '{}' or not (p -> 'dst' ?& array['gap','fold'])
		or p #>> '{dst,gap}' is distinct from 'skip' or coalesce(p #>> '{dst,fold}','') not in ('earlier','later','both')
		or jsonb_typeof(p -> 'catchUp') is distinct from 'object'
		or (p -> 'catchUp') - array['maxAgeSeconds','maxOccurrences'] <> '{}'
		or not (p -> 'catchUp' ?& array['maxAgeSeconds','maxOccurrences'])
		or jsonb_typeof(p #> '{catchUp,maxAgeSeconds}') is distinct from 'number'
		or p #>> '{catchUp,maxAgeSeconds}' !~ '^(0|[1-9][0-9]*)$'
		or (p #>> '{catchUp,maxAgeSeconds}')::integer not between 0 and 604800
		or jsonb_typeof(p #> '{catchUp,maxOccurrences}') is distinct from 'number'
		or p #>> '{catchUp,maxOccurrences}' !~ '^[1-9][0-9]*$'
		or (p #>> '{catchUp,maxOccurrences}')::integer not between 1 and 256
		or jsonb_typeof(p -> 'authFailures') is distinct from 'object'
		or (p -> 'authFailures') - array['threshold','resetOn','notifyMemberId','notificationSessionId'] <> '{}'
		or not (p -> 'authFailures' ?& array['threshold','resetOn','notifyMemberId','notificationSessionId'])
		or coalesce(p #>> '{authFailures,resetOn}','') not in ('success','non-authentication')
		or jsonb_typeof(p #> '{authFailures,threshold}') is distinct from 'number'
		or p #>> '{authFailures,threshold}' !~ '^[1-9][0-9]*$'
		or (p #>> '{authFailures,threshold}')::integer not between 1 and 100
		or coalesce(p #>> '{authFailures,notifyMemberId}','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or coalesce(p #>> '{authFailures,notificationSessionId}','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or jsonb_typeof(p -> 'quietWindows') is distinct from 'array' or jsonb_array_length(p -> 'quietWindows') > 14 then return false; end if;
	if p -> 'expiresAt' <> 'null'::jsonb and not public.qorpera_step8_instant_valid(p -> 'expiresAt') then return false; end if;
	for days in select p -> 'defaultWeekdays' union all select value -> 'weekdays' from jsonb_array_elements(p -> 'quietWindows') loop
		if jsonb_typeof(days) is distinct from 'array' or jsonb_array_length(days) not between 1 and 7
			or (select count(distinct value) from jsonb_array_elements(days)) <> jsonb_array_length(days)
			or exists(select 1 from jsonb_array_elements(days) where jsonb_typeof(value) <> 'string'
				or value #>> '{}' not in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday')) then return false; end if;
	end loop;
	for w in select value from jsonb_array_elements(p -> 'quietWindows') loop
		if jsonb_typeof(w) <> 'object' or not (w ?& array['weekdays','start','end']) or w - array['weekdays','start','end'] <> '{}'
			or jsonb_typeof(w -> 'start') <> 'string' or jsonb_typeof(w -> 'end') <> 'string'
			or w ->> 'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or w ->> 'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			or w ->> 'start' = w ->> 'end' then return false; end if;
	end loop;
	return true;
exception when others then return false;
end $$;

create function public.qorpera_step8_trigger_valid(p_triggers jsonb,p_policy jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare t jsonb; a jsonb; d jsonb;
begin
	if not public.qorpera_step8_policy_valid(p_policy) or jsonb_typeof(p_triggers) is distinct from 'array'
		or jsonb_array_length(p_triggers) <> 1 then return false; end if;
	t := p_triggers -> 0;
	if jsonb_typeof(t) is distinct from 'object' or jsonb_typeof(t -> 'id') is distinct from 'string'
		or t ->> 'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		or jsonb_typeof(t -> 'kind') is distinct from 'string'
		or (t ? 'replyPolicy' and (jsonb_typeof(t -> 'replyPolicy') is distinct from 'string' or t ->> 'replyPolicy' not in ('optional','required','silent')))
		or (t ? 'timeZone' and (jsonb_typeof(t -> 'timeZone') is distinct from 'string' or t ->> 'timeZone' is distinct from p_policy ->> 'timeZone')) then return false; end if;
	if t ->> 'kind' = 'schedule' and t ? 'startAt' and not public.qorpera_step8_instant_valid(t -> 'startAt') then return false; end if;
	if t ->> 'kind' = 'schedule' or (t ->> 'kind' = 'listener' and t ->> 'source' = 'company-file') then
		return public.qorpera_cloud_routine_trigger_valid(t);
	end if;
	if t ->> 'kind' is distinct from 'listener' or t ->> 'source' is distinct from 'github'
		or not (t ?& array['id','kind','source','timeZone','connectionId','installationId','repositoryId','events','actors','delivery'])
		or t - array['id','kind','source','timeZone','connectionId','installationId','repositoryId','events','actors','delivery','replyPolicy'] <> '{}'
		or jsonb_typeof(t -> 'source') is distinct from 'string' or jsonb_typeof(t -> 'connectionId') is distinct from 'string'
		or t ->> 'connectionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or jsonb_typeof(t -> 'installationId') <> 'string' or t ->> 'installationId' !~ '^[1-9][0-9]{0,19}$'
		or jsonb_typeof(t -> 'repositoryId') <> 'string' or t ->> 'repositoryId' !~ '^[1-9][0-9]{0,19}$'
		or jsonb_typeof(t -> 'events') <> 'array' or jsonb_array_length(t -> 'events') not between 1 and 4
		or (select count(distinct value) from jsonb_array_elements(t -> 'events')) <> jsonb_array_length(t -> 'events')
		or exists(select 1 from jsonb_array_elements(t -> 'events') where jsonb_typeof(value) is distinct from 'string'
			or value #>> '{}' not in ('pull_request.opened','pull_request.updated','pull_request.merged','pull_request.review_requested')) then return false; end if;
	a := t -> 'actors'; d := t -> 'delivery';
	if a ->> 'mode' = 'any' then
		if a <> '{"mode":"any"}' then return false; end if;
	else
		if jsonb_typeof(a) <> 'object' or a ->> 'mode' is distinct from 'allowlist' or a - array['mode','ids'] <> '{}'
			or jsonb_typeof(a -> 'ids') is distinct from 'array' or jsonb_array_length(a -> 'ids') not between 1 and 100
			or (select count(distinct value) from jsonb_array_elements(a -> 'ids')) <> jsonb_array_length(a -> 'ids')
			or exists(select 1 from jsonb_array_elements(a -> 'ids') where jsonb_typeof(value) <> 'string' or value #>> '{}' !~ '^[1-9][0-9]{0,19}$') then return false; end if;
	end if;
	return coalesce(jsonb_typeof(d) = 'object' and d ?& array['maxAgeSeconds','maxFutureSkewSeconds','reordered']
		and d - array['maxAgeSeconds','maxFutureSkewSeconds','reordered'] = '{}'
		and jsonb_typeof(d -> 'maxAgeSeconds') = 'number' and d ->> 'maxAgeSeconds' ~ '^[1-9][0-9]*$'
		and (d ->> 'maxAgeSeconds')::integer between 1 and 604800
		and jsonb_typeof(d -> 'maxFutureSkewSeconds') = 'number' and d ->> 'maxFutureSkewSeconds' ~ '^(0|[1-9][0-9]*)$'
		and (d ->> 'maxFutureSkewSeconds')::integer between 0 and 3600 and d ->> 'reordered' in ('accept','drop-older'),false);
exception when others then return false;
end $$;

create function public.qorpera_step8_clock_allowed(p jsonb,p_at timestamptz)
returns boolean language plpgsql stable set search_path = '' as $$
declare local_at timestamp := p_at at time zone (p ->> 'timeZone'); w jsonb;
	day integer := extract(dow from local_at)::integer; minute text := to_char(local_at,'HH24:MI');
	days text[] := array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
begin
	if p_at is null or not isfinite(p_at) or not public.qorpera_step8_policy_valid(p) then return false; end if;
	for w in select value from jsonb_array_elements(p -> 'quietWindows') loop
		if (case when w ->> 'start' < w ->> 'end' then
			w -> 'weekdays' ? days[day+1] and minute >= w ->> 'start' and minute < w ->> 'end'
		else (w -> 'weekdays' ? days[day+1] and minute >= w ->> 'start')
			or (w -> 'weekdays' ? days[((day+6)%7)+1] and minute < w ->> 'end') end) then return false; end if;
	end loop;
	return true;
end $$;

create function public.qorpera_step8_local_instants(p_local timestamp,p_zone text,p_fold text)
returns timestamptz[] language sql stable set search_path = '' as $$
	with offsets as (
		select distinct (probe at time zone p_zone) - (probe at time zone 'UTC') as value
		from generate_series(date_trunc('day',p_local) at time zone 'UTC' - interval '48 hours',
			date_trunc('day',p_local) at time zone 'UTC' + interval '48 hours',interval '6 hours') probe
	), candidates as (
		select p_local at time zone 'UTC' - value as instant from offsets
		where (p_local at time zone 'UTC' - value) at time zone p_zone = p_local
	) select coalesce(case p_fold when 'earlier' then array[min(instant)] when 'later' then array[max(instant)]
		when 'both' then array_agg(instant order by instant) end,'{}'::timestamptz[]) from candidates having count(*) > 0
$$;

create function public.qorpera_step8_scheduled(p_trigger jsonb,p_policy jsonb,p_at timestamptz)
returns boolean language plpgsql stable set search_path = '' as $$
declare local_at timestamp; days text[] := array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
	minutes integer; start_minutes integer; end_minutes integer; interval_minutes integer; anchor timestamptz;
begin
	if p_at is null or not isfinite(p_at) or not public.qorpera_step8_trigger_valid(jsonb_build_array(p_trigger),p_policy)
		or p_trigger ->> 'kind' <> 'schedule' then return false; end if;
	local_at := p_at at time zone (p_policy ->> 'timeZone');
	if not (coalesce(p_trigger -> 'weekdays',p_policy -> 'defaultWeekdays') ? days[extract(dow from local_at)::integer+1]) then return false; end if;
	interval_minutes := (p_trigger ->> 'intervalMinutes')::integer;
	anchor := coalesce((p_trigger ->> 'startAt')::timestamptz,'1970-01-01T00:00:00Z'::timestamptz);
	if p_at < anchor then return false; end if;
	if not (p_trigger ? 'localTime' or p_trigger ? 'windowStart') then
		return mod(extract(epoch from (p_at - anchor)) * 1000,interval_minutes::bigint * 60000) = 0;
	end if;
	if date_trunc('minute',local_at) <> local_at then return false; end if;
	if p_trigger ? 'months' and not (p_trigger -> 'months' @> to_jsonb(extract(month from local_at)::integer)) then return false; end if;
	if p_trigger ? 'localTime' then
		if to_char(local_at,'HH24:MI') <> p_trigger ->> 'localTime' then return false; end if;
	else
		minutes := extract(hour from local_at)::integer * 60 + extract(minute from local_at)::integer;
		start_minutes := split_part(p_trigger ->> 'windowStart',':',1)::integer * 60 + split_part(p_trigger ->> 'windowStart',':',2)::integer;
		end_minutes := split_part(p_trigger ->> 'windowEnd',':',1)::integer * 60 + split_part(p_trigger ->> 'windowEnd',':',2)::integer;
		if minutes not between start_minutes and end_minutes or mod(minutes-start_minutes,interval_minutes) <> 0 then return false; end if;
	end if;
	return coalesce(p_at = any(public.qorpera_step8_local_instants(local_at,p_policy ->> 'timeZone',p_policy #>> '{dst,fold}')),false);
end $$;

create table public.qorpera_step8_routine_policies (
	routine_id uuid not null,
	routine_version bigint not null,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
	path text not null check(public.qorpera_company_path_valid(path)),
	path_version uuid not null,
	revision_id uuid not null references public.qorpera_company_path_revisions(snapshot_id) on delete restrict,
	document_sha256 text not null check(document_sha256 ~ '^[0-9a-f]{64}$'),
	intent_status text not null check(intent_status in ('active','paused','retired')),
	policy jsonb not null check(public.qorpera_step8_policy_valid(policy)),
	primary key(routine_id,routine_version),
	foreign key(routine_id,routine_version) references public.qorpera_cloud_routine_versions(routine_id,version) on delete restrict
);
create index qorpera_step8_policy_path on public.qorpera_step8_routine_policies(environment_id,path);

create table public.qorpera_step8_routine_state (
	routine_id uuid primary key references public.qorpera_cloud_routines(id) on delete restrict,
	routine_version bigint not null,
	epoch bigint not null check(epoch > 0),
	active_since timestamptz not null,
	observed_through timestamptz not null,
	suspension text check(suspension in ('authentication','expired')),
	failure_count integer not null default 0 check(failure_count between 0 and 100),
	last_plan_sha256 text,
	foreign key(routine_id,routine_version) references public.qorpera_step8_routine_policies(routine_id,routine_version) on delete restrict,
	check(observed_through >= active_since),
	check(active_since = date_trunc('milliseconds',active_since)),
	check(observed_through = date_trunc('milliseconds',observed_through))
);

create table public.qorpera_step8_occurrence_epochs (
	occurrence_id uuid primary key references public.qorpera_wake_occurrences(id) on delete restrict,
	routine_id uuid not null,
	routine_version bigint not null,
	epoch bigint not null,
	admission_sequence bigint generated always as identity unique,
	foreign key(routine_id,routine_version) references public.qorpera_step8_routine_policies(routine_id,routine_version) on delete restrict
);
create index qorpera_step8_epoch_admissions on public.qorpera_step8_occurrence_epochs(routine_id,epoch,admission_sequence);

create table public.qorpera_step8_auth_observations (
	event_id bigint primary key references public.qorpera_execution_run_events(id) on delete restrict,
	run_id uuid not null unique references public.qorpera_execution_runs(id) on delete restrict,
	occurrence_id uuid not null unique references public.qorpera_step8_occurrence_epochs(occurrence_id) on delete restrict,
	outcome text not null check(outcome in ('authentication','success','other'))
);

create table public.qorpera_step8_notification_intents (
	id uuid primary key default extensions.gen_random_uuid(),
	routine_id uuid not null,
	routine_version bigint not null,
	epoch bigint not null,
	member_id uuid not null references auth.users(id) on delete restrict,
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete restrict,
	cause_event_id bigint not null references public.qorpera_execution_run_events(id) on delete restrict,
	message_id uuid unique references public.qorpera_agent_sends(event_id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	unique(routine_id,epoch),
	foreign key(routine_id,routine_version) references public.qorpera_step8_routine_policies(routine_id,routine_version) on delete restrict
);
create index qorpera_step8_pending_notifications on public.qorpera_step8_notification_intents(created_at,id) where message_id is null;

create function public.qorpera_step8_assert_projection(p_routine_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.qorpera_step8_routine_policies%rowtype; r public.qorpera_cloud_routines%rowtype;
begin
	select * into r from public.qorpera_cloud_routines where id = p_routine_id;
	select * into p from public.qorpera_step8_routine_policies where routine_id = r.id and routine_version = r.current_version;
	if not found or p.intent_status <> r.status or not exists(select 1 from public.qorpera_company_path_entries e where e.environment_id = p.environment_id
		and e.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p.path),'sha256')
		and e.version = p.path_version and e.entry #>> '{file,fileSha256}' = p.document_sha256)
		or not exists(select 1 from public.qorpera_step8_routine_state s where s.routine_id = r.id and s.routine_version = r.current_version)
		then raise exception 'Routine Company File projection is unavailable' using errcode = '55000'; end if;
end $$;

create function public.qorpera_step8_projection_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare id uuid;
begin
	if tg_table_name = 'qorpera_cloud_routines' then
		if exists(select 1 from public.qorpera_step8_routine_state where routine_id = new.id) then perform public.qorpera_step8_assert_projection(new.id); end if;
	else
		for id in select distinct p.routine_id from public.qorpera_step8_routine_policies p
			where p.environment_id = new.environment_id and public.qorpera_company_path_key(p.path) = public.qorpera_company_path_key(new.path)
		loop perform public.qorpera_step8_assert_projection(id); end loop;
	end if;
	return null;
end $$;
-- Only enrolled routines/paths participate. The existing publisher is unmodified.
create constraint trigger qorpera_step8_routine_projection_consistent after update on public.qorpera_cloud_routines
	deferrable initially deferred for each row execute function public.qorpera_step8_projection_guard();
create constraint trigger qorpera_step8_file_projection_consistent after insert or update on public.qorpera_company_path_entries
	deferrable initially deferred for each row execute function public.qorpera_step8_projection_guard();

-- The authorized File routine writer MUST take this lock before changing an
-- existing routine head/version, including status-only edits. File -> routine
-- -> enforcement state matches admission; taking the routine first deadlocks.
create function public.qorpera_step8_lock_intent(p_environment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare profile uuid;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'File projection authority required' using errcode = '42501'; end if;
	select profile_id into strict profile from public.qorpera_company_files where environment_id=p_environment_id;
	perform public.qorpera_lock_profile_gc_fence(profile);
	perform 1 from public.qorpera_company_files where environment_id=p_environment_id for update;
end $$;

create function public.qorpera_step8_project_routine_at(p_routine_id uuid,p_expected_version bigint,p_path text,p_result jsonb,p_document_text text,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.qorpera_cloud_routines%rowtype; v public.qorpera_cloud_routine_versions%rowtype;
	s public.qorpera_step8_routine_state%rowtype; p public.qorpera_step8_routine_policies%rowtype;
	doc jsonb; revision record; at timestamptz := date_trunc('milliseconds',p_now); digest text;
	current_xid numeric := pg_current_xact_id()::text::numeric; revision_xid numeric;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Projection authority required' using errcode = '42501'; end if;
	if p_now is null or not isfinite(p_now) then raise exception 'Invalid projection clock' using errcode = '22023'; end if;
	if p_document_text is null or octet_length(p_document_text) > 65536 then raise exception 'Routine document exceeds its bound' using errcode = '22023'; end if;
	doc := p_document_text::jsonb; digest := encode(extensions.digest(convert_to(p_document_text,'utf8'),'sha256'),'hex');
	select * into strict r from public.qorpera_cloud_routines where id = p_routine_id;
	perform public.qorpera_step8_lock_intent(r.environment_id);
	select * into strict r from public.qorpera_cloud_routines where id = p_routine_id for update;
	if r.current_version is distinct from p_expected_version then raise exception 'Routine version changed' using errcode = '40001'; end if;
	select * into strict v from public.qorpera_cloud_routine_versions where routine_id = r.id and version = r.current_version;
	if jsonb_typeof(doc) is distinct from 'object' or not (doc ?& array['schema','routineId','version','definition','status','policy'])
		or doc - array['schema','routineId','version','definition','status','policy'] <> '{}'
		or doc ->> 'schema' is distinct from 'qorpera.routine-intent/v1' or doc ->> 'routineId' is distinct from r.id::text
		or doc -> 'version' is distinct from to_jsonb(r.current_version) or doc ->> 'status' is distinct from r.status
		or encode(extensions.digest(convert_to((doc -> 'definition')::text,'utf8'),'sha256'),'hex') is distinct from v.content_sha256
		or doc #> '{definition,triggers}' is distinct from v.triggers
		or not public.qorpera_step8_trigger_valid(v.triggers,doc -> 'policy') then raise exception 'Routine document does not match its compiled version' using errcode = '22023'; end if;
	select * into p from public.qorpera_step8_routine_policies where routine_id = r.id and routine_version = r.current_version;
	if found and p.path_version::text = p_result ->> 'version' and p.document_sha256 = digest and p.path = p_path then
		perform public.qorpera_step8_assert_projection(r.id);
		return (select jsonb_build_object('routineId',r.id,'version',r.current_version,'epoch',epoch) from public.qorpera_step8_routine_state where routine_id = r.id);
	end if;
	select q.*,q.xmin::text::bigint as transaction_id into revision from public.qorpera_company_path_revisions q
		where q.snapshot_id = (p_result ->> 'snapshotId')::uuid and q.environment_id = r.environment_id;
	if not found then raise exception 'Admitted Company File revision unavailable' using errcode = '42501'; end if;
	-- xmin can be a subtransaction ID (savepoints/exception blocks), not the
	-- top-level xid. A visible, still-in-progress revision belongs to THIS
	-- transaction under PostgreSQL MVCC. Reconstruct its xid8 epoch at wrap.
	revision_xid := current_xid - mod(current_xid,4294967296) + revision.transaction_id;
	if revision_xid-current_xid > 2147483647 then revision_xid := revision_xid-4294967296;
	elsif current_xid-revision_xid > 2147483647 then revision_xid := revision_xid+4294967296; end if;
	if pg_xact_status(revision_xid::text::xid8) is distinct from 'in progress'
		or p_result ->> 'state' is distinct from 'applied' or p_result ->> 'path' is distinct from p_path
		or revision.change #>> '{plan,path}' is distinct from p_path or revision.change ->> 'version' is distinct from p_result ->> 'version'
		or revision.change #>> '{plan,entry,file,fileSha256}' is distinct from digest
		or revision.receipt_id is null or revision.receipt_id::text is distinct from p_result ->> 'receiptId'
		or not exists(select 1 from public.qorpera_run_operation_receipts where id = revision.receipt_id and status = 'completed' and result = p_result)
		then raise exception 'Projection must accompany the admitted Company File operation' using errcode = '42501'; end if;
	if not exists(select 1 from public.qorpera_profile_members where profile_id = r.profile_id
		and user_id = (doc #>> '{policy,authFailures,notifyMemberId}')::uuid and role in ('owner','admin'))
		or not exists(select 1 from public.qorpera_shared_sessions where id = (doc #>> '{policy,authFailures,notificationSessionId}')::uuid
			and profile_id = r.profile_id and environment_id = r.environment_id and staff_agent_id = v.staff_agent_id::text)
		or not coalesce(public.qorpera_wake_path_authorized(r.environment_id,(doc #>> '{policy,authFailures,notifyMemberId}')::uuid,v.staff_agent_id,p_path),false)
		then raise exception 'Routine notification audience is unavailable' using errcode = '42501'; end if;
	if p.routine_id is not null and (p.policy <> doc -> 'policy' or p.path <> p_path) then raise exception 'Routine policy edits require a new routine version' using errcode = '40001'; end if;
	select * into s from public.qorpera_step8_routine_state where routine_id = r.id for update;
	-- No content edit, ordinary resume or late success silently clears auth suspension.
	insert into public.qorpera_step8_routine_policies(routine_id,routine_version,environment_id,path,path_version,revision_id,document_sha256,intent_status,policy)
	values(r.id,r.current_version,r.environment_id,p_path,(p_result ->> 'version')::uuid,revision.snapshot_id,digest,r.status,doc -> 'policy')
	on conflict(routine_id,routine_version) do update set path_version = excluded.path_version,revision_id = excluded.revision_id,document_sha256 = excluded.document_sha256,intent_status = excluded.intent_status;
	insert into public.qorpera_step8_routine_state(routine_id,routine_version,epoch,active_since,observed_through,suspension,failure_count)
	values(r.id,r.current_version,coalesce(s.epoch,0)+1,greatest(at,s.observed_through),greatest(at,s.observed_through),
		case when s.suspension = 'authentication' then s.suspension
			when s.suspension = 'expired' and s.routine_version = r.current_version then 'expired'
			when (doc #>> '{policy,expiresAt}')::timestamptz <= at then 'expired' end,
		case when s.suspension = 'authentication' then s.failure_count else 0 end)
	on conflict(routine_id) do update set routine_version = excluded.routine_version,epoch = excluded.epoch,
		active_since = excluded.active_since,observed_through = excluded.observed_through,suspension = excluded.suspension,failure_count = excluded.failure_count,last_plan_sha256 = null;
	perform public.qorpera_step8_assert_projection(r.id);
	-- Skip rows already owned by materialization: the admission/effect guard
	-- below must also run in that lane. Never mutate an admitted identity/run.
	update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),blocked_reason = 'Routine projection changed'
	where id in (select id from public.qorpera_wake_occurrences where routine_id = r.id and status = 'queued' for update skip locked);
	return jsonb_build_object('routineId',r.id,'version',r.current_version,'epoch',coalesce(s.epoch,0)+1);
end $$;

create function public.qorpera_step8_project_routine(p_routine_id uuid,p_expected_version bigint,p_path text,p_result jsonb,p_document_text text)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_step8_project_routine_at(p_routine_id,p_expected_version,p_path,p_result,p_document_text,clock_timestamp())
$$;

create function public.qorpera_step8_locked_state(p_routine_id uuid,p_version bigint,p_epoch bigint)
returns public.qorpera_step8_routine_state language plpgsql security definer set search_path = '' as $$
declare r public.qorpera_cloud_routines%rowtype; s public.qorpera_step8_routine_state%rowtype;
	p public.qorpera_step8_routine_policies%rowtype; v public.qorpera_cloud_routine_versions%rowtype;
begin
	if p_routine_id is null or p_version is null or p_version < 1 or p_epoch is null or p_epoch < 1 then
		raise exception 'Invalid routine policy binding' using errcode = '22023'; end if;
	select * into r from public.qorpera_cloud_routines where id = p_routine_id;
	if not found then raise exception 'Routine unavailable' using errcode = '42501'; end if;
	perform public.qorpera_step8_lock_intent(r.environment_id);
	select * into strict r from public.qorpera_cloud_routines where id = p_routine_id for share;
	select * into s from public.qorpera_step8_routine_state where routine_id = r.id for update;
	if s.routine_id is null or s.routine_version is distinct from p_version or r.current_version is distinct from p_version
		or s.epoch is distinct from p_epoch then raise exception 'Routine policy version changed' using errcode = '40001'; end if;
	perform public.qorpera_step8_assert_projection(r.id);
	select * into strict p from public.qorpera_step8_routine_policies where routine_id = r.id and routine_version = r.current_version;
	select * into strict v from public.qorpera_cloud_routine_versions where routine_id = r.id and version = r.current_version;
	if not coalesce(public.qorpera_wake_path_authorized(r.environment_id,v.created_by_user_id,v.staff_agent_id,p.path),false) then
		raise exception 'Routine path authority unavailable' using errcode = '42501'; end if;
	return s;
end $$;

create function public.qorpera_step8_identity(p_routine_id uuid,p_version bigint,p_trigger text,p_at timestamptz)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare key text; digest text; variant text;
begin
	key := 'routine:' || p_routine_id::text || ':v' || p_version::text || ':' || p_trigger || ':' || to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
	digest := encode(extensions.digest(convert_to('qorpera.routine-occurrence/v1:' || key,'utf8'),'sha256'),'hex');
	variant := to_hex((get_byte(decode(digest,'hex'),8) >> 4 & 3) | 8);
	return jsonb_build_object('occurrenceKey',key,'occurrenceId',substring(digest,1,8) || '-' || substring(digest,9,4) || '-4' || substring(digest,14,3) || '-' || variant || substring(digest,18,3) || '-' || substring(digest,21,12));
end $$;

create function public.qorpera_step8_commit_schedule_at(p_plan jsonb,p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.qorpera_step8_routine_state%rowtype; p jsonb; t jsonb; status text; item jsonb; result jsonb := '[]';
	through timestamptz; next_due timestamptz; previous timestamptz; at timestamptz; digest text; id jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Scheduler authority required' using errcode = '42501'; end if;
	if jsonb_typeof(p_plan) is distinct from 'object' or pg_column_size(p_plan) > 131072
		or p_plan ->> 'schema' is distinct from 'qorpera.routine-schedule-plan/v1'
		or not (p_plan ?& array['schema','routineId','version','epoch','expectedObservedThrough','expectedLastScheduledFor','through','nextDueAt','truncatedBefore','occurrences'])
		or p_plan - array['schema','routineId','version','epoch','expectedObservedThrough','expectedLastScheduledFor','through','nextDueAt','truncatedBefore','occurrences'] <> '{}'
		or not public.qorpera_step8_instant_valid(p_plan -> 'expectedObservedThrough')
		or not public.qorpera_step8_instant_valid(p_plan -> 'through')
		or not public.qorpera_step8_instant_valid(p_plan -> 'nextDueAt')
		or (p_plan -> 'expectedLastScheduledFor' <> 'null'::jsonb and not public.qorpera_step8_instant_valid(p_plan -> 'expectedLastScheduledFor'))
		or (p_plan -> 'truncatedBefore' <> 'null'::jsonb and not public.qorpera_step8_instant_valid(p_plan -> 'truncatedBefore'))
		or jsonb_typeof(p_plan -> 'occurrences') is distinct from 'array' then raise exception 'Invalid schedule plan' using errcode = '22023'; end if;
	for item in select value from jsonb_array_elements(p_plan -> 'occurrences') loop
		if jsonb_typeof(item) is distinct from 'object' or not (item ?& array['scheduledFor','occurrenceKey','occurrenceId'])
			or item - array['scheduledFor','occurrenceKey','occurrenceId'] <> '{}'
			or not public.qorpera_step8_instant_valid(item -> 'scheduledFor') then
			raise exception 'Invalid scheduled occurrence' using errcode = '22023'; end if;
	end loop;
	s := public.qorpera_step8_locked_state((p_plan ->> 'routineId')::uuid,(p_plan ->> 'version')::bigint,(p_plan ->> 'epoch')::bigint);
	select policy into strict p from public.qorpera_step8_routine_policies where routine_id = s.routine_id and routine_version = s.routine_version;
	select v.triggers -> 0,r.status into t,status from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id = v.routine_id
		where v.routine_id = s.routine_id and v.version = s.routine_version;
	if t ->> 'kind' <> 'schedule' then raise exception 'Cannot schedule a listener' using errcode = '22023'; end if;
	digest := encode(extensions.digest(convert_to(p_plan::text,'utf8'),'sha256'),'hex');
	if digest = s.last_plan_sha256 then return jsonb_build_object('status','duplicate'); end if;
	through := (p_plan ->> 'through')::timestamptz; next_due := (p_plan ->> 'nextDueAt')::timestamptz;
	if through is null or next_due is null or p_now is null or not isfinite(through) or not isfinite(next_due) or not isfinite(p_now)
		or through > greatest(p_now,s.observed_through) or through < s.observed_through or next_due <= through
		or next_due > through + interval '370 days'
		or s.observed_through is distinct from (p_plan ->> 'expectedObservedThrough')::timestamptz
		then raise exception 'Scheduler watermark changed or clock is invalid' using errcode = '40001'; end if;
	select last_scheduled_for into previous from public.qorpera_cloud_routine_schedule_cursors
		where routine_id = s.routine_id and routine_version = s.routine_version and trigger_id = t ->> 'id' for update;
	if not found or previous is distinct from (p_plan ->> 'expectedLastScheduledFor')::timestamptz then raise exception 'Schedule cursor changed' using errcode = '40001'; end if;
	if p_now < s.observed_through then
		if through <> s.observed_through or jsonb_array_length(p_plan -> 'occurrences') <> 0 then
			raise exception 'Clock regression cannot admit occurrences' using errcode = '22023'; end if;
		return jsonb_build_object('status','clock-regressed');
	end if;
	if (p ->> 'expiresAt')::timestamptz <= p_now then
		update public.qorpera_step8_routine_state set suspension = coalesce(suspension,'expired') where routine_id = s.routine_id;
		s.suspension := coalesce(s.suspension,'expired');
		update public.qorpera_wake_occurrences w set status = 'cancelled',finished_at = clock_timestamp(),blocked_reason = 'Routine expired'
		where w.id in (select pending.id from public.qorpera_wake_occurrences pending where pending.routine_id = s.routine_id and pending.status = 'queued' for update skip locked);
	end if;
	if jsonb_array_length(p_plan -> 'occurrences') > (p #>> '{catchUp,maxOccurrences}')::integer
		or (jsonb_array_length(p_plan -> 'occurrences') > 0 and (status <> 'active' or s.suspension is not null or not public.qorpera_step8_clock_allowed(p,p_now))) then
		raise exception 'Routine is ineligible for schedule admission' using errcode = '55000'; end if;
	for item in select value from jsonb_array_elements(p_plan -> 'occurrences') loop
		at := (item ->> 'scheduledFor')::timestamptz;
		id := public.qorpera_step8_identity(s.routine_id,s.routine_version,t ->> 'id',at);
		if at is null or not isfinite(at) or at <= greatest(s.observed_through,s.active_since,previous) or at > through
			or at < p_now - make_interval(secs => (p #>> '{catchUp,maxAgeSeconds}')::integer)
			or item ->> 'occurrenceKey' is distinct from id ->> 'occurrenceKey' or item ->> 'occurrenceId' is distinct from id ->> 'occurrenceId'
			or not public.qorpera_step8_scheduled(t,p,at) or not public.qorpera_step8_clock_allowed(p,at) then
			raise exception 'Scheduled occurrence is outside its policy' using errcode = '22023'; end if;
		result := result || jsonb_build_array(public.qorpera_enqueue_routine_wake(s.routine_id,s.routine_version,
			(item ->> 'occurrenceId')::uuid,item ->> 'occurrenceKey',t ->> 'id',at,previous,next_due,
			'{"schema":"qorpera.routine-schedule-occurrence/v1","coalesced":0}'::jsonb));
		insert into public.qorpera_step8_occurrence_epochs(occurrence_id,routine_id,routine_version,epoch)
			values((item ->> 'occurrenceId')::uuid,s.routine_id,s.routine_version,s.epoch);
		previous := at;
	end loop;
	update public.qorpera_cloud_routine_schedule_cursors set next_due_at = next_due,updated_at = clock_timestamp()
		where routine_id = s.routine_id and routine_version = s.routine_version and trigger_id = t ->> 'id';
	update public.qorpera_step8_routine_state set observed_through = through,last_plan_sha256 = digest where routine_id = s.routine_id;
	return jsonb_build_object('status','committed','occurrences',result);
end $$;

create function public.qorpera_step8_commit_schedule(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; p jsonb; at timestamptz;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Scheduler authority required' using errcode = '42501'; end if;
	perform public.qorpera_step8_locked_state((p_plan ->> 'routineId')::uuid,(p_plan ->> 'version')::bigint,(p_plan ->> 'epoch')::bigint);
	result := public.qorpera_step8_commit_schedule_at(p_plan,clock_timestamp());
	-- Lock waits and enqueue work cannot carry a new batch across a quiet or
	-- expiry boundary. A duplicate receipt grants no new admission.
	if result ->> 'status' = 'committed' and jsonb_array_length(p_plan -> 'occurrences') > 0 then
		select policy into strict p from public.qorpera_step8_routine_policies where routine_id=(p_plan ->> 'routineId')::uuid and routine_version=(p_plan ->> 'version')::bigint;
		at := clock_timestamp();
		if not public.qorpera_step8_clock_allowed(p,at) or (p ->> 'expiresAt')::timestamptz <= at then
			raise exception 'Routine policy boundary changed during admission' using errcode = '55000'; end if;
	end if;
	return result;
end
$$;

create function public.qorpera_step8_occurrence_allowed_at(p_occurrence uuid,p_now timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare w public.qorpera_wake_occurrences%rowtype; s public.qorpera_step8_routine_state%rowtype; e public.qorpera_step8_occurrence_epochs%rowtype; p jsonb; intent_path text;
begin
	select * into w from public.qorpera_wake_occurrences where id = p_occurrence;
	select * into e from public.qorpera_step8_occurrence_epochs where occurrence_id = w.id;
	if e.occurrence_id is null then return false; end if;
	select * into s from public.qorpera_step8_routine_state where routine_id = w.routine_id;
	if s.routine_version <> w.routine_version or s.epoch <> e.epoch or s.suspension is not null
		or w.scheduled_for <= s.active_since or not isfinite(p_now) or w.scheduled_for > p_now
		or not exists(select 1 from public.qorpera_cloud_routines where id = w.routine_id and current_version = w.routine_version and status = 'active') then return false; end if;
	perform public.qorpera_step8_assert_projection(w.routine_id);
	select policy,path into strict p,intent_path from public.qorpera_step8_routine_policies where routine_id = w.routine_id and routine_version = w.routine_version;
	-- Projection consistency and generic wake authority do not establish the
	-- current intent-path ACL. The caller must already hold the common locks:
	-- profile GC fence -> File -> routine -> state -> occurrence.
	return ((p ->> 'expiresAt')::timestamptz is null or (p ->> 'expiresAt')::timestamptz > p_now)
		and public.qorpera_step8_clock_allowed(p,p_now) and public.qorpera_step8_clock_allowed(p,w.scheduled_for)
		and coalesce(public.qorpera_wake_path_authorized(w.environment_id,w.requested_by_user_id,w.staff_agent_id,intent_path),false)
		and public.qorpera_wake_authorized(w);
end $$;

create function public.qorpera_step8_record_auth_outcome(p_event_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare event public.qorpera_execution_run_events%rowtype; w public.qorpera_wake_occurrences%rowtype;
	e public.qorpera_step8_occurrence_epochs%rowtype; s public.qorpera_step8_routine_state%rowtype; p jsonb; outcome text; count integer; notification uuid;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Outcome authority required' using errcode = '42501'; end if;
	select * into strict event from public.qorpera_execution_run_events where id = p_event_id;
	select * into w from public.qorpera_wake_occurrences where run_id = event.run_id;
	select * into e from public.qorpera_step8_occurrence_epochs where occurrence_id = w.id;
	if e.occurrence_id is null or event.event_type not in ('completed','failed')
		or not exists(select 1 from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
			where r.id = event.run_id and j.run_id = r.id and j.status = event.event_type and j.finished_at is not null)
		or w.status <> event.event_type then raise exception 'Routine terminal evidence unavailable' using errcode = '42501'; end if;
	outcome := case when event.event_type = 'completed' then 'success' when event.payload ->> 'failureClass' = 'authentication' then 'authentication' else 'other' end;
	select * into s from public.qorpera_step8_routine_state where routine_id = e.routine_id for update;
	if exists(select 1 from public.qorpera_step8_auth_observations where event_id = event.id) then return jsonb_build_object('status','duplicate'); end if;
	if exists(select 1 from public.qorpera_step8_auth_observations where run_id = event.run_id) then raise exception 'Run terminal outcome is already recorded' using errcode = '23505'; end if;
	insert into public.qorpera_step8_auth_observations(event_id,run_id,occurrence_id,outcome) values(event.id,event.run_id,w.id,outcome);
	if s.routine_version <> e.routine_version or s.epoch <> e.epoch then return jsonb_build_object('status','stale'); end if;
	select policy into strict p from public.qorpera_step8_routine_policies where routine_id = s.routine_id and routine_version = s.routine_version;
	-- Admission order, not callback arrival or wall clock. The explicit File
	-- reset policy chooses success-only or any non-authentication outcome.
	select least(100,count(*))::integer into count from public.qorpera_step8_auth_observations a
		join public.qorpera_step8_occurrence_epochs o on o.occurrence_id = a.occurrence_id
		where o.routine_id = s.routine_id and o.epoch = s.epoch and a.outcome = 'authentication'
		and o.admission_sequence > coalesce((select max(o2.admission_sequence) from public.qorpera_step8_auth_observations a2
			join public.qorpera_step8_occurrence_epochs o2 on o2.occurrence_id = a2.occurrence_id
			where o2.routine_id = s.routine_id and o2.epoch = s.epoch
				and (a2.outcome = 'success' or (p #>> '{authFailures,resetOn}' = 'non-authentication' and a2.outcome = 'other'))),0);
	update public.qorpera_step8_routine_state set failure_count = count where routine_id = s.routine_id;
	if count >= (p #>> '{authFailures,threshold}')::integer and s.suspension is null then
		update public.qorpera_step8_routine_state set suspension = 'authentication' where routine_id = s.routine_id;
		insert into public.qorpera_step8_notification_intents(routine_id,routine_version,epoch,member_id,session_id,cause_event_id)
		values(s.routine_id,s.routine_version,s.epoch,(p #>> '{authFailures,notifyMemberId}')::uuid,(p #>> '{authFailures,notificationSessionId}')::uuid,event.id)
		on conflict(routine_id,epoch) do nothing returning id into notification;
		update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),blocked_reason = 'Routine suspended after authentication failures'
		where id in (select id from public.qorpera_wake_occurrences where routine_id = s.routine_id and status = 'queued' for update skip locked);
	end if;
	return jsonb_build_object('status','recorded','failureCount',count,'notificationId',notification);
end $$;

create function public.qorpera_step8_ack_notification(p_intent_id uuid,p_message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare n public.qorpera_step8_notification_intents%rowtype; v public.qorpera_cloud_routine_versions%rowtype; p public.qorpera_step8_routine_policies%rowtype; text text;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Notification authority required' using errcode = '42501'; end if;
	select * into strict n from public.qorpera_step8_notification_intents where id = p_intent_id for update;
	select * into strict v from public.qorpera_cloud_routine_versions where routine_id = n.routine_id and version = n.routine_version;
	select * into strict p from public.qorpera_step8_routine_policies where routine_id = n.routine_id and routine_version = n.routine_version;
	text := 'Routine ' || n.routine_id::text || ' was suspended after repeated authentication failures. Reauthorize its connection and resume the routine.';
	if not coalesce(public.qorpera_wake_path_authorized(v.environment_id,n.member_id,v.staff_agent_id,p.path),false)
		or not exists(select 1 from public.qorpera_profile_members where profile_id = v.profile_id and user_id = n.member_id and role in ('owner','admin'))
		or not exists(select 1 from public.qorpera_agent_sends a join public.qorpera_session_events e on e.event_id = a.event_id
			join public.qorpera_execution_runs r on r.id = a.run_id join public.qorpera_shared_sessions c on c.id = a.session_id
			where a.event_id = p_message_id and a.session_id = n.session_id and a.idempotency_key = 'routine-auth:' || n.id::text
				and a.text_sha256 = encode(extensions.digest(convert_to(text,'utf8'),'sha256'),'hex')
				and r.profile_id = v.profile_id and r.environment_id = v.environment_id and r.staff_agent_id = v.staff_agent_id
				and e.execution_id = r.id and c.profile_id = v.profile_id and c.environment_id = v.environment_id)
		then raise exception 'Authorized notification send receipt unavailable' using errcode = '42501'; end if;
	if n.message_id is not null and n.message_id <> p_message_id then raise exception 'Notification is already delivered' using errcode = '23505'; end if;
	update public.qorpera_step8_notification_intents set message_id = p_message_id where id = n.id;
end $$;

-- Recovery discovery for the existing authorized sender. The cursor is a
-- bounded scan cursor, not a competing notification execution queue/lease.
create function public.qorpera_step8_list_notification_intents(p_limit integer,p_after_created_at timestamptz default null,p_after_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare items jsonb; next_cursor jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Notification authority required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 64 or (p_after_created_at is null) <> (p_after_id is null)
		or (p_after_created_at is not null and not isfinite(p_after_created_at)) then raise exception 'Invalid notification page' using errcode = '22023'; end if;
	with candidates as (
		select * from public.qorpera_step8_notification_intents where message_id is null
			and (p_after_id is null or (created_at,id) > (p_after_created_at,p_after_id)) order by created_at,id limit p_limit+1
	), page as (select * from candidates order by created_at,id limit p_limit)
	select coalesce((select jsonb_agg(jsonb_build_object('id',id,'routineId',routine_id,'routineVersion',routine_version,
		'memberId',member_id,'sessionId',session_id) order by created_at,id) from page),'[]'),
		case when (select count(*) from candidates)>p_limit then (select jsonb_build_object('createdAt',created_at,'id',id) from page order by created_at desc,id desc limit 1) end
	into items,next_cursor;
	return jsonb_build_object('items',items,'nextCursor',next_cursor);
end $$;

create function public.qorpera_step8_read_schedule_context(p_routine_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.qorpera_step8_routine_state%rowtype; p jsonb; t jsonb; status text; last_at timestamptz;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Scheduler authority required' using errcode = '42501'; end if;
	select * into strict s from public.qorpera_step8_routine_state where routine_id = p_routine_id;
	s := public.qorpera_step8_locked_state(s.routine_id,s.routine_version,s.epoch);
	select policy into strict p from public.qorpera_step8_routine_policies where routine_id = s.routine_id and routine_version = s.routine_version;
	select v.triggers -> 0,r.status into t,status from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id = v.routine_id
		where v.routine_id = s.routine_id and v.version = s.routine_version;
	if t ->> 'kind' is distinct from 'schedule' then raise exception 'Routine is not a schedule' using errcode = '22023'; end if;
	select last_scheduled_for into strict last_at from public.qorpera_cloud_routine_schedule_cursors
		where routine_id = s.routine_id and routine_version = s.routine_version and trigger_id = t ->> 'id';
	return jsonb_build_object('routineId',s.routine_id,'version',s.routine_version,'epoch',s.epoch,'status',status,'suspended',s.suspension is not null,
		'activeSince',to_char(s.active_since at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'observedThrough',to_char(s.observed_through at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'lastScheduledFor',to_char(last_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'trigger',t,'policy',p);
end $$;

-- Invoked for each bounded discovery item by the EXISTING orchestrator. This
-- covers listeners too, without an independent timer/daemon or execution queue.
create function public.qorpera_step8_expire_at(p_routine_id uuid,p_version bigint,p_epoch bigint,p_now timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare s public.qorpera_step8_routine_state%rowtype; expires timestamptz;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Scheduler authority required' using errcode = '42501'; end if;
	if p_now is null or not isfinite(p_now) then raise exception 'Invalid expiry clock' using errcode = '22023'; end if;
	s := public.qorpera_step8_locked_state(p_routine_id,p_version,p_epoch);
	select (policy ->> 'expiresAt')::timestamptz into strict expires from public.qorpera_step8_routine_policies where routine_id = s.routine_id and routine_version = s.routine_version;
	if expires is null or expires > greatest(p_now,s.observed_through) then return false; end if;
	update public.qorpera_step8_routine_state set suspension = coalesce(suspension,'expired'),observed_through = greatest(observed_through,date_trunc('milliseconds',p_now)) where routine_id = s.routine_id;
	update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),blocked_reason = 'Routine expired'
	where id in (select id from public.qorpera_wake_occurrences where routine_id = s.routine_id and status = 'queued' for update skip locked);
	return true;
end $$;

create function public.qorpera_step8_expire(p_routine_id uuid,p_version bigint,p_epoch bigint)
returns boolean language sql security definer set search_path = '' as $$
	select public.qorpera_step8_expire_at(p_routine_id,p_version,p_epoch,clock_timestamp())
$$;

create table public.qorpera_step8_auth_recoveries (
	receipt_id uuid primary key,
	routine_id uuid not null,
	routine_version bigint not null,
	from_epoch bigint not null,
	to_epoch bigint not null check(to_epoch = from_epoch+1),
	foreign key(routine_id,routine_version) references public.qorpera_step8_routine_policies(routine_id,routine_version) on delete restrict
);

-- The owning native/Step 7 authority must verify and lock a durable recovery
-- receipt for this routine's failed credential, newer than the suspension cause. Never a boolean from
-- a client or an inferred success/error string. Missing adapter stays closed.
create function public.qorpera_step8_auth_recovered(p_routine_id uuid,p_version bigint,p_epoch bigint,p_receipt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin raise exception 'Authentication recovery authority adapter is unavailable' using errcode = '55000'; end $$;

create function public.qorpera_step8_resume_after_auth(p_routine_id uuid,p_version bigint,p_epoch bigint,p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.qorpera_step8_routine_state%rowtype; prior public.qorpera_step8_auth_recoveries%rowtype; at timestamptz := date_trunc('milliseconds',clock_timestamp());
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Recovery authority required' using errcode = '42501'; end if;
	select * into prior from public.qorpera_step8_auth_recoveries where receipt_id = p_receipt_id;
	if found then
		if prior.routine_id is distinct from p_routine_id or prior.routine_version is distinct from p_version
			or prior.from_epoch is distinct from p_epoch then raise exception 'Recovery receipt is already bound' using errcode = '23505'; end if;
		perform public.qorpera_step8_locked_state(p_routine_id,p_version,prior.to_epoch);
		return jsonb_build_object('status','duplicate','epoch',prior.to_epoch);
	end if;
	s := public.qorpera_step8_locked_state(p_routine_id,p_version,p_epoch);
	if s.suspension is distinct from 'authentication' then raise exception 'Routine is not suspended for authentication' using errcode = '55000'; end if;
	if p_receipt_id is null or public.qorpera_step8_auth_recovered(p_routine_id,p_version,p_epoch,p_receipt_id) is distinct from true then
		raise exception 'Authentication recovery is not authorized' using errcode = '42501'; end if;
	insert into public.qorpera_step8_auth_recoveries(receipt_id,routine_id,routine_version,from_epoch,to_epoch) values(p_receipt_id,p_routine_id,p_version,p_epoch,p_epoch+1);
	update public.qorpera_step8_routine_state set epoch = epoch+1,suspension = null,failure_count = 0,last_plan_sha256 = null,
		active_since = greatest(at,observed_through),observed_through = greatest(at,observed_through) where routine_id = s.routine_id;
	-- File status remains authoritative: recovering a paused routine does not
	-- enable it. A separately authorized File resume is still required.
	return jsonb_build_object('status','recovered','epoch',p_epoch+1);
end $$;

-- Private projections and time-injected test helpers are not client RPCs.
do $$ declare item record; begin
	for item in select tablename from pg_catalog.pg_tables where schemaname = 'public' and tablename like 'qorpera_step8_%' loop
		execute format('alter table public.%I enable row level security',item.tablename);
		execute format('revoke all on public.%I from public,anon,authenticated,service_role',item.tablename);
	end loop;
	for item in select oid::regprocedure as name from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname like 'qorpera_step8_%' loop
		execute format('revoke all on function %s from public,anon,authenticated,service_role',item.name);
	end loop;
end $$;
grant execute on function public.qorpera_step8_commit_schedule(jsonb),public.qorpera_step8_read_schedule_context(uuid),
	public.qorpera_step8_record_auth_outcome(bigint),public.qorpera_step8_ack_notification(uuid,uuid),
	public.qorpera_step8_list_notification_intents(integer,timestamptz,uuid),
	public.qorpera_step8_expire(uuid,bigint,bigint),public.qorpera_step8_resume_after_auth(uuid,bigint,bigint,uuid) to service_role;
