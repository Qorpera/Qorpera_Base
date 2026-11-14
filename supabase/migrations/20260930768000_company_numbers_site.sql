-- 20260930768000: the platform's own numbers of a company, door `site` (company views step 3, slice S1; the lane's
-- DESIGN-3.md §C and §E; Jonas, 14 November 2026: "Yes, start step 3"). A company website's views are counted beside the
-- sites, in this database, by one call site-serve makes after it has answered a page; the site questions of the
-- dispatcher 20260930767000 made (`qorpera/sites`, `site-now`, `site-hours`, `site-days`, `site-pages`, which answered
-- "not counted yet") answer them now.
--
-- 1. What counts. A view is a GET answered 200 or 304 with a text/html file of a files site's live version, by a
--    visitor's valid password session (scope site), on the site's own host while hosts are on or on the old host while
--    they are off; site-serve decides the request's side (GET, no range, the status, Sec-Fetch-Dest document or absent,
--    no prefetch, never the next host, the password page or a refusal) and calls qorpera_site_count_view, which checks
--    again what serve checked (the host rule, sites on, the site live and not taken down, its company not being
--    deleted, the session, the path a text/html file of the live version) and counts. A visit is a view whose session
--    had no view of that site in the 30 minutes before; here now is the sessions with a view in the last 5 minutes. At
--    most 60 views a session (so a site) an hour are counted; later ones keep the session's last view time only. Each
--    call waits at most 100 ms for a lock: on contention the view is dropped, never waited for.
-- 2. Tables, closed to every API role (RLS on, no grants), each going with its site (on delete cascade):
--    * qorpera_site_counts: views and visits a site, UTC hour and path (the live version's file path, so at most 500 a
--      site): kept 35 days.
--    * qorpera_site_count_days: the same a site, the company's calendar day and path, rolled up from the hours by the
--      upkeep: kept as long as the site.
--    * qorpera_site_session_seen: a password session's last view (it goes with the session, too), the hour its views are
--      capped in and how many it has there: deleted by the upkeep once an hour has passed since the last view.
--    * qorpera_site_count_upkeep: one row, how far the hours are rolled into days, and the last run.
--    Nothing else is stored: never an IP address, a network, a user agent, a referrer, a query string, a country or any
--    header, and no cookie is added (the session's cookie is the one the password gave).
-- 3. The upkeep, qorpera_site_count_upkeep(), by pg_cron hourly at minute 9 as its owner (job qorpera-site-counts; where
--    pg_cron is absent or the role may not use it, nothing is scheduled and the migration still applies): adds every
--    hour that ended at least 5 minutes ago and was not added before to its day (in the company's zone at that run),
--    then deletes hour rows older than 35 days (never one not yet added) and seen rows whose last view is more than an
--    hour old. Until an hour is added, the day questions read it from the hours, so a day is whole at any time. Undo:
--    select cron.unschedule('qorpera-site-counts').
-- 4. The site questions (any member of the company, or any run of it, as the dispatcher's two doors resolve them; the
--    company's files sites only, app links never), in the data gateway's answer shape. `site` is a site's name (its
--    slug), optional: without it every files site of the company, in name order. Days are the company's own, in its
--    time zone (qorpera_profiles.time_zone), or Europe/Copenhagen's while it has none or one the database does not know,
--    the rule 20260930767000 holds. Hours are UTC hours.
--      sites       site, title, url (its own host while hosts are on), live (visitors can open it now).
--      site-now    site, here_now, views_today, visits_today: one row a site.
--      site-hours  site, hour (ISO, UTC), hour_local (YYYY-MM-DDTHH:MI, the company's), views, visits: every hour from
--                  `from` to `to`, zeros included; by default the 48 hours to this one; at most 7 days (168 hours).
--                  `from` and `to` are a time with its zone (2026-11-14T08:00Z) or a day of the company's (its first
--                  hour, or its last).
--      site-days   site, day, views, visits: every day from `from` to `to`, zeros included; by default the 30 days to
--                  today; at most 400 days.
--      site-pages  site, path, views, visits (the visits that began there), from `from` to `to` (as site-days) and the
--                  `limit` (10 by default, at most 50) most viewed paths a site.
--    An answer is at most 2000 rows (the data gateway's question limit); `more` is true when more were cut.
--
-- Every inserted text names this migration (20260930768000).

do $$
begin
	if to_regclass('public.qorpera_site_counts') is not null then
		raise exception '20260930768000 (site counts) is already applied'; end if;
	if to_regprocedure('public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)') is null
		or to_regprocedure('public.qorpera_site_host(text)') is null
		or to_regclass('public.qorpera_company_site_tickets') is null then
		raise exception '20260930768000 (site counts) needs the money door (20260930767000) and site hosts (20260930756000)';
	end if;
end $$;

set local lock_timeout = '3s';

-- 1. Tables ------------------------------------------------------------------------------------------------------------

create table public.qorpera_site_counts (
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	-- The UTC hour's start.
	hour timestamptz not null check (hour = date_trunc('hour', hour, 'UTC')),
	-- A file of the live version (qorpera_site_path_valid), as stored: index.html, about/index.html.
	path text not null check (char_length(path) between 1 and 512),
	views integer not null check (views >= 0),
	visits integer not null check (visits between 0 and views),
	primary key (site_id, hour, path)
);
create index qorpera_site_counts_hour on public.qorpera_site_counts(hour);

create table public.qorpera_site_count_days (
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	-- The company's calendar day, in its zone when the hours were added.
	day date not null,
	path text not null check (char_length(path) between 1 and 512),
	views bigint not null check (views >= 0),
	visits bigint not null check (visits between 0 and views),
	primary key (site_id, day, path)
);

create table public.qorpera_site_session_seen (
	-- The password session (qorpera_company_site_sessions, scope site): its row goes with the session.
	token_sha256 text primary key references public.qorpera_company_site_sessions(token_sha256) on delete cascade,
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	last_view_at timestamptz not null,
	-- The UTC hour its counted views are capped in, and how many it has there (at most 60).
	hour timestamptz not null check (hour = date_trunc('hour', hour, 'UTC')),
	views_in_hour integer not null check (views_in_hour between 0 and 60)
);
create index qorpera_site_session_seen_site on public.qorpera_site_session_seen(site_id, last_view_at);
create index qorpera_site_session_seen_age on public.qorpera_site_session_seen(last_view_at);

create table public.qorpera_site_count_upkeep (
	id boolean primary key default true check (id),
	-- Every hour before this one is added to its day.
	rolled_until timestamptz not null check (rolled_until = date_trunc('hour', rolled_until, 'UTC')),
	ran_at timestamptz,
	stopped text check (stopped is null or stopped in ('done', 'busy', 'lock_timeout'))
);
insert into public.qorpera_site_count_upkeep (rolled_until) values (date_trunc('hour', clock_timestamp(), 'UTC'));

alter table public.qorpera_site_counts enable row level security;
alter table public.qorpera_site_count_days enable row level security;
alter table public.qorpera_site_session_seen enable row level security;
alter table public.qorpera_site_count_upkeep enable row level security;
revoke all on public.qorpera_site_counts, public.qorpera_site_count_days, public.qorpera_site_session_seen,
	public.qorpera_site_count_upkeep from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_site_counts is
	'20260930768000: a files site''s views and visits by UTC hour and path, kept 35 days. Counted by '
	'qorpera_site_count_view (site-serve), read by the site questions; no visitor''s data.';
comment on table public.qorpera_site_count_days is
	'20260930768000: a files site''s views and visits by the company''s day and path, rolled up from the hours by '
	'qorpera_site_count_upkeep; kept as long as the site.';
comment on table public.qorpera_site_session_seen is
	'20260930768000: a site password session''s last view and its views this hour (the cap of 60), deleted an hour '
	'after the last view by qorpera_site_count_upkeep.';
comment on table public.qorpera_site_count_upkeep is
	'20260930768000: how far qorpera_site_count_upkeep has added the hours into days, and its last run.';

-- Helpers (no API role calls them) ---------------------------------------------------------------------------------------

-- The company's time zone, the rule 20260930767000 holds: qorpera_profiles.time_zone when the database knows it
-- (qorpera_runtime_time_zone_names) and can use it, else Europe/Copenhagen.
create function public.qorpera_company_numbers_zone(p_profile_id uuid) returns text
language plpgsql stable set search_path = '' as $$
-- 20260930768000
declare v_zone text;
begin
	select profile.time_zone into v_zone from public.qorpera_profiles as profile where profile.id = p_profile_id;
	if v_zone is null or not exists (select 1 from public.qorpera_runtime_time_zone_names as known
			where known.name = v_zone) then
		return 'Europe/Copenhagen'; end if;
	begin
		perform clock_timestamp() at time zone v_zone;
	exception when others then
		return 'Europe/Copenhagen';
	end;
	return v_zone;
end $$;

-- An hour parameter: a time with its zone (YYYY-MM-DDTHH:MM, then :SS and a fraction if given, then Z or an offset), or
-- a day of the company's, YYYY-MM-DD (its first hour, or, for p_last, its last); the UTC hour it falls in. Null when
-- it is not given.
create function public.qorpera_company_numbers_hour(p_params jsonb, p_name text, p_zone text, p_last boolean)
returns timestamptz language plpgsql stable set search_path = '' as $$
-- 20260930768000
declare v_text text; v_at timestamptz; v_day date;
begin
	if not p_params ? p_name or jsonb_typeof(p_params -> p_name) = 'null' then return null; end if;
	v_text := p_params ->> p_name;
	if jsonb_typeof(p_params -> p_name) = 'string' and v_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
		begin
			v_day := v_text::date;
		exception when others then
			raise exception ':% is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', p_name using errcode = '22023';
		end;
		if to_char(v_day, 'YYYY-MM-DD') <> v_text then
			raise exception ':% is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', p_name using errcode = '22023'; end if;
		if p_last then
			return date_trunc('hour', ((v_day + 1)::timestamp at time zone p_zone) - interval '1 hour', 'UTC'); end if;
		return date_trunc('hour', v_day::timestamp at time zone p_zone, 'UTC');
	end if;
	if jsonb_typeof(p_params -> p_name) <> 'string'
		or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
		raise exception ':% is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', p_name using errcode = '22023'; end if;
	begin
		v_at := v_text::timestamptz;
	exception when others then
		raise exception ':% is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', p_name using errcode = '22023';
	end;
	return date_trunc('hour', v_at, 'UTC');
end $$;

-- Views and visits of the sites p_sites by the company's day and path, from p_from to p_to: the days the upkeep made,
-- and the hours it has not added yet, by their day in p_zone.
create function public.qorpera_site_count_day_rows(p_sites uuid[], p_zone text, p_from date, p_to date)
returns table (site_id uuid, day date, path text, views bigint, visits bigint)
language sql stable set search_path = '' as $$
	-- 20260930768000
	select kept.site_id, kept.day, kept.path, kept.views, kept.visits from public.qorpera_site_count_days as kept
	where kept.site_id = any (p_sites) and kept.day between p_from and p_to
	union all
	select hour.site_id, (hour.hour at time zone p_zone)::date, hour.path, hour.views::bigint, hour.visits::bigint
	from public.qorpera_site_counts as hour
	where hour.site_id = any (p_sites)
		and hour.hour >= (select upkeep.rolled_until from public.qorpera_site_count_upkeep as upkeep)
		and (hour.hour at time zone p_zone)::date between p_from and p_to
$$;

revoke all on function public.qorpera_company_numbers_zone(uuid),
	public.qorpera_company_numbers_hour(jsonb, text, text, boolean),
	public.qorpera_site_count_day_rows(uuid[], text, date, date)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. Counting a view ---------------------------------------------------------------------------------------------------

-- A view at p_now (qorpera_site_count_view gives the clock): p_host as site-serve's x-forwarded-host, p_path the
-- answered file's path in the site (on the old host after the site's name: <slug>/<path>), p_token the session's token.
-- Answers {"state": "counted", "visit": <a new visit>}, "capped" (its 60 this hour are counted), "skipped" (no view
-- that counts) or "busy" (a lock was not had within 100 ms: dropped).
create function public.qorpera_site_count_view_at(p_host text, p_path text, p_token text, p_now timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '100ms' as $$
-- 20260930768000
declare
	v_settings public.qorpera_site_settings%rowtype; v_host text := lower(p_host); v_path text; v_slug text;
	v_host_of jsonb; v_site public.qorpera_company_sites%rowtype; v_sha text; v_hour timestamptz;
	v_last timestamptz; v_seen_hour timestamptz; v_in_hour integer; v_visit boolean; v_made integer := 0;
begin
	if p_host is null or p_path is null or p_now is null or p_token is null or p_token !~ '^[A-Za-z0-9_-]{32}$' then
		return '{"state":"skipped"}'::jsonb; end if;
	select settings.* into v_settings from public.qorpera_site_settings as settings;
	if not coalesce(v_settings.enabled, false) then return '{"state":"skipped"}'::jsonb; end if;
	v_path := ltrim(p_path, '/');
	-- The host rule, as qorpera_site_serve_host reads it: the old host serves a site's files only while hosts are off
	-- (on, its links move), the path's first part naming the site; a site's own host only while they are on; a next
	-- host (members' look first) and any other host never.
	if v_host = substring(v_settings.origin from '^https://(.+)$') then
		if v_settings.hosts_enabled then return '{"state":"skipped"}'::jsonb; end if;
		v_slug := split_part(v_path, '/', 1);
		v_path := substr(v_path, char_length(v_slug) + 2);
	elsif v_settings.hosts_enabled then
		v_host_of := public.qorpera_site_host(v_host);
		if v_host_of is null or v_host_of ->> 'scope' is distinct from 'site' then
			return '{"state":"skipped"}'::jsonb; end if;
		v_slug := v_host_of ->> 'slug';
	else
		return '{"state":"skipped"}'::jsonb;
	end if;
	if not public.qorpera_site_slug_valid(v_slug) then return '{"state":"skipped"}'::jsonb; end if;
	if v_path = '' or right(v_path, 1) = '/' then v_path := v_path || 'index.html'; end if;
	if not public.qorpera_site_path_valid(v_path) then return '{"state":"skipped"}'::jsonb; end if;
	-- A files site, live, not taken down, its company not being deleted; a visitor's session of its current password;
	-- the path a text/html file of its live version.
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = v_slug and site.kind = 'files' and site.current_version_id is not null and site.taken_down_at is null
		and not public.qorpera_company_deleting(site.profile_id);
	if not found then return '{"state":"skipped"}'::jsonb; end if;
	v_sha := public.qorpera_site_sha256(p_token);
	if not exists (select 1 from public.qorpera_company_site_sessions as session
			where session.token_sha256 = v_sha and session.site_id = v_site.id and session.scope = 'site'
				and session.password_version = v_site.password_version and session.expires_at > p_now)
		or not exists (select 1 from public.qorpera_company_site_files as file
			where file.version_id = v_site.current_version_id and file.path = v_path
				and file.content_type ~ '^text/html(;|$)') then
		return '{"state":"skipped"}'::jsonb; end if;
	v_hour := date_trunc('hour', p_now, 'UTC');
	begin
		-- The session's last view, locked: one view of a session at a time decides whether it begins a visit.
		select seen.last_view_at, seen.hour, seen.views_in_hour into v_last, v_seen_hour, v_in_hour
		from public.qorpera_site_session_seen as seen where seen.token_sha256 = v_sha for update;
		if not found then
			insert into public.qorpera_site_session_seen (token_sha256, site_id, last_view_at, hour, views_in_hour)
			values (v_sha, v_site.id, p_now, v_hour, 1)
			on conflict (token_sha256) do nothing;
			get diagnostics v_made = row_count;
			if v_made = 0 then
				-- Another view of the session made the row at the same time: read it as that view left it.
				select seen.last_view_at, seen.hour, seen.views_in_hour into v_last, v_seen_hour, v_in_hour
				from public.qorpera_site_session_seen as seen where seen.token_sha256 = v_sha for update;
				if not found then return '{"state":"skipped"}'::jsonb; end if;
			end if;
		end if;
		if v_made = 1 then
			v_visit := true;
		else
			-- At most 60 counted views a session an hour: later ones keep its last view time only (so a session that goes
			-- on viewing never begins a new visit), and count nothing.
			if v_hour <= v_seen_hour and v_in_hour >= 60 then
				update public.qorpera_site_session_seen as seen set last_view_at = greatest(seen.last_view_at, p_now)
				where seen.token_sha256 = v_sha;
				return '{"state":"capped"}'::jsonb;
			end if;
			v_visit := v_last <= p_now - interval '30 minutes';
			update public.qorpera_site_session_seen as seen set last_view_at = greatest(seen.last_view_at, p_now),
				hour = greatest(seen.hour, v_hour),
				views_in_hour = case when v_hour <= seen.hour then seen.views_in_hour + 1 else 1 end
			where seen.token_sha256 = v_sha;
		end if;
		insert into public.qorpera_site_counts as count (site_id, hour, path, views, visits)
		values (v_site.id, v_hour, v_path, 1, case when v_visit then 1 else 0 end)
		on conflict (site_id, hour, path) do update
			set views = count.views + 1, visits = count.visits + excluded.visits;
	exception
		when lock_not_available then return '{"state":"busy"}'::jsonb;
		-- The session or the site went meanwhile.
		when foreign_key_violation then return '{"state":"skipped"}'::jsonb;
	end;
	return jsonb_build_object('state', 'counted', 'visit', v_visit);
end $$;

-- site-serve's call (service role only): a view now.
create function public.qorpera_site_count_view(p_host text, p_path text, p_token text)
returns jsonb language sql volatile security definer set search_path = '' set lock_timeout = '100ms' as $$
	-- 20260930768000
	select public.qorpera_site_count_view_at(p_host, p_path, p_token, clock_timestamp())
$$;

revoke all on function public.qorpera_site_count_view_at(text, text, text, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_site_count_view(text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_site_count_view(text, text, text) to service_role;
comment on function public.qorpera_site_count_view(text, text, text) is
	'site-serve, after it answered a page: counts the view of a visitor''s session (20260930768000). Waits at most '
	'100 ms for a lock, then drops the view. Stores no visitor data.';

-- 3. The upkeep --------------------------------------------------------------------------------------------------------

-- Adds the hours that ended at least 5 minutes ago (and were not added before) to their days, in each company's zone
-- now; then deletes hour rows older than 35 days (never one not added yet) and seen rows whose last view is more than an
-- hour old. One run at a time; a lock not had within a second ends the run, undone, for the next one to do. p_now:
-- a test's clock (pg_cron passes none).
create function public.qorpera_site_count_upkeep(p_now timestamptz default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '1s' as $$
-- 20260930768000
declare
	v_now timestamptz := coalesce(p_now, clock_timestamp()); v_from timestamptz; v_until timestamptz;
	v_days bigint := 0; v_hours bigint := 0; v_seen bigint := 0; v_stopped text := 'done';
begin
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.site-count-upkeep', 0)) then
		return jsonb_build_object('schema', 'qorpera.site-count-upkeep/v1', 'stopped', 'busy'); end if;
	begin
		select upkeep.rolled_until into v_from from public.qorpera_site_count_upkeep as upkeep for update;
		v_until := greatest(v_from, date_trunc('hour', v_now - interval '5 minutes', 'UTC'));
		if v_until > v_from then
			with zones as (
				select site.id, public.qorpera_company_numbers_zone(site.profile_id) as zone
				from public.qorpera_company_sites as site
				where site.id in (select hour.site_id from public.qorpera_site_counts as hour
					where hour.hour >= v_from and hour.hour < v_until)
			)
			insert into public.qorpera_site_count_days as kept (site_id, day, path, views, visits)
			select hour.site_id, (hour.hour at time zone zones.zone)::date, hour.path, sum(hour.views), sum(hour.visits)
			from public.qorpera_site_counts as hour join zones on zones.id = hour.site_id
			where hour.hour >= v_from and hour.hour < v_until
			group by hour.site_id, (hour.hour at time zone zones.zone)::date, hour.path
			on conflict (site_id, day, path) do update
				set views = kept.views + excluded.views, visits = kept.visits + excluded.visits;
			get diagnostics v_days = row_count;
			update public.qorpera_site_count_upkeep set rolled_until = v_until;
		end if;
		delete from public.qorpera_site_counts as hour
		where hour.hour < least(v_until, v_now - interval '35 days');
		get diagnostics v_hours = row_count;
		delete from public.qorpera_site_session_seen as seen where seen.last_view_at < v_now - interval '1 hour';
		get diagnostics v_seen = row_count;
	exception when lock_not_available then
		v_stopped := 'lock_timeout'; v_days := 0; v_hours := 0; v_seen := 0; v_until := v_from;
	end;
	update public.qorpera_site_count_upkeep set ran_at = clock_timestamp(), stopped = v_stopped;
	return jsonb_build_object('schema', 'qorpera.site-count-upkeep/v1', 'stopped', v_stopped, 'days', v_days,
		'hoursDeleted', v_hours, 'seenDeleted', v_seen, 'rolledUntil', v_until);
end $$;
revoke all on function public.qorpera_site_count_upkeep(timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Where pg_cron is absent or the role may not use it, nothing is scheduled and the migration still applies. Scheduling
-- by the same name replaces that one job.
create function public.qorpera_schedule_site_count_upkeep() returns jsonb
language plpgsql set search_path = '' as $$
-- 20260930768000
declare v_job bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'Site counts upkeep was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.site-count-upkeep-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_job := cron.schedule('qorpera-site-counts', '9 * * * *', 'select public.qorpera_site_count_upkeep()');
	exception when others then
		raise warning 'Site counts upkeep was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.site-count-upkeep-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.site-count-upkeep-schedule/v1', 'scheduled', true, 'job', v_job);
end $$;
revoke all on function public.qorpera_schedule_site_count_upkeep()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
select public.qorpera_schedule_site_count_upkeep();

-- 4. The site questions ------------------------------------------------------------------------------------------------

-- A site question's {columns, rows, more} for the company p_profile_id at p_now. The caller's rights are the
-- dispatcher's doors' (a member of the company, or a run of it); p_params is an object.
create function public.qorpera_company_numbers_site(p_profile_id uuid, p_now timestamptz, p_question text,
	p_params jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930768000
declare
	c_rows constant integer := 2000;
	v_zone text := public.qorpera_company_numbers_zone(p_profile_id);
	v_today date;
	v_now_hour timestamptz := date_trunc('hour', p_now, 'UTC');
	v_takes text[];
	v_key text;
	v_sites uuid[];
	v_from date;
	v_to date;
	v_hour_from timestamptz;
	v_hour_to timestamptz;
	v_limit integer := 10;
	v_columns text[];
	v_rows jsonb;
	v_more boolean := false;
begin
	v_today := (p_now at time zone v_zone)::date;
	v_takes := case p_question
		when 'sites' then '{}'::text[]
		when 'site-now' then array['site']
		when 'site-hours' then array['site', 'from', 'to']
		when 'site-days' then array['site', 'from', 'to']
		when 'site-pages' then array['site', 'from', 'to', 'limit'] end;
	for v_key in select k from jsonb_object_keys(p_params) k order by k loop
		if not v_key = any (v_takes) then
			raise exception 'The question takes no :%', left(v_key, 60) using errcode = '22023'; end if;
	end loop;
	-- The company's files sites, or the one named.
	if p_params ? 'site' and jsonb_typeof(p_params -> 'site') <> 'null' then
		if jsonb_typeof(p_params -> 'site') <> 'string' then
			raise exception ':site is a site''s name' using errcode = '22023'; end if;
		select array_agg(site.id) into v_sites from public.qorpera_company_sites as site
		where site.profile_id = p_profile_id and site.kind = 'files' and site.slug = p_params ->> 'site';
		if v_sites is null then
			raise exception ':site is not one of the company''s sites' using errcode = '22023'; end if;
	else
		select coalesce(array_agg(site.id), '{}'::uuid[]) into v_sites from public.qorpera_company_sites as site
		where site.profile_id = p_profile_id and site.kind = 'files';
	end if;
	-- The day range of site-days and site-pages: by default the 30 days to today; from a :from, at most its 400 days
	-- and never past today, nor before it.
	if p_question in ('site-days', 'site-pages') then
		v_from := public.qorpera_company_numbers_day(p_params, 'from');
		v_to := coalesce(public.qorpera_company_numbers_day(p_params, 'to'),
			case when v_from is not null then greatest(v_from, least(v_from + 399, v_today)) else v_today end);
		v_from := coalesce(v_from, v_to - 29);
		if v_from > v_to then raise exception ':from is after :to' using errcode = '22023'; end if;
		if v_to - v_from + 1 > 400 then
			raise exception 'From :from to :to is at most 400 days' using errcode = '22023'; end if;
	end if;

	case p_question
	when 'sites' then
		v_columns := array['site', 'title', 'url', 'live'];
		select jsonb_agg(jsonb_build_array(site.slug, site.title, public.qorpera_site_url(site.slug),
			site.current_version_id is not null and site.taken_down_at is null
				and coalesce((select settings.enabled from public.qorpera_site_settings as settings), false))
			order by site.slug collate "C")
		into v_rows
		from public.qorpera_company_sites as site where site.id = any (v_sites);
	when 'site-now' then
		v_columns := array['site', 'here_now', 'views_today', 'visits_today'];
		select jsonb_agg(jsonb_build_array(site.slug,
			(select count(*) from public.qorpera_site_session_seen as seen
				where seen.site_id = site.id and seen.last_view_at > p_now - interval '5 minutes'),
			coalesce(today.views, 0), coalesce(today.visits, 0))
			order by site.slug collate "C")
		into v_rows
		from public.qorpera_company_sites as site
		left join lateral (select sum(hour.views)::bigint as views, sum(hour.visits)::bigint as visits
			from public.qorpera_site_counts as hour
			where hour.site_id = site.id
				and hour.hour >= (v_today::timestamp at time zone v_zone) - interval '1 hour'
				and hour.hour < ((v_today + 1)::timestamp at time zone v_zone) + interval '1 hour'
				and (hour.hour at time zone v_zone)::date = v_today) as today on true
		where site.id = any (v_sites);
	when 'site-hours' then
		-- By default the 48 hours to this one; from a :from, at most its 168 hours and never past this hour, nor before it.
		v_hour_from := public.qorpera_company_numbers_hour(p_params, 'from', v_zone, false);
		v_hour_to := coalesce(public.qorpera_company_numbers_hour(p_params, 'to', v_zone, true),
			case when v_hour_from is not null
				then greatest(v_hour_from, least(v_hour_from + interval '167 hours', v_now_hour)) else v_now_hour end);
		v_hour_from := coalesce(v_hour_from, v_hour_to - interval '47 hours');
		if v_hour_from > v_hour_to then raise exception ':from is after :to' using errcode = '22023'; end if;
		if v_hour_to - v_hour_from > interval '167 hours' then
			raise exception 'From :from to :to is at most 7 days' using errcode = '22023'; end if;
		v_columns := array['site', 'hour', 'hour_local', 'views', 'visits'];
		select jsonb_agg(jsonb_build_array(cell.slug, to_char(cell.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(cell.hour at time zone v_zone, 'YYYY-MM-DD"T"HH24:MI'), cell.views, cell.visits)
			order by cell.slug collate "C", cell.hour)
		into v_rows
		from (select site.slug, series.hour, coalesce(hour.views, 0) as views, coalesce(hour.visits, 0) as visits
			from public.qorpera_company_sites as site
			cross join generate_series(v_hour_from, v_hour_to, interval '1 hour') as series(hour)
			left join lateral (select sum(counted.views)::bigint as views, sum(counted.visits)::bigint as visits
				from public.qorpera_site_counts as counted
				where counted.site_id = site.id and counted.hour = series.hour) as hour on true
			where site.id = any (v_sites)
			order by site.slug collate "C", series.hour
			limit c_rows + 1) as cell;
	when 'site-days' then
		v_columns := array['site', 'day', 'views', 'visits'];
		select jsonb_agg(jsonb_build_array(cell.slug, to_char(cell.day, 'YYYY-MM-DD'), cell.views, cell.visits)
			order by cell.slug collate "C", cell.day)
		into v_rows
		from (select site.slug, series.day::date as day, coalesce(counted.views, 0) as views,
				coalesce(counted.visits, 0) as visits
			from public.qorpera_company_sites as site
			cross join generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as series(day)
			left join (select rows.site_id, rows.day, sum(rows.views)::bigint as views, sum(rows.visits)::bigint as visits
				from public.qorpera_site_count_day_rows(v_sites, v_zone, v_from, v_to) as rows
				group by rows.site_id, rows.day) as counted
				on counted.site_id = site.id and counted.day = series.day::date
			where site.id = any (v_sites)
			order by site.slug collate "C", series.day
			limit c_rows + 1) as cell;
	when 'site-pages' then
		if p_params ? 'limit' and jsonb_typeof(p_params -> 'limit') <> 'null' then
			if jsonb_typeof(p_params -> 'limit') not in ('number', 'string') or (p_params ->> 'limit') !~ '^[0-9]{1,3}$' then
				raise exception ':limit is a whole number from 1 to 50' using errcode = '22023'; end if;
			v_limit := (p_params ->> 'limit')::integer;
			if v_limit not between 1 and 50 then
				raise exception ':limit is a whole number from 1 to 50' using errcode = '22023'; end if;
		end if;
		v_columns := array['site', 'path', 'views', 'visits'];
		select jsonb_agg(jsonb_build_array(site.slug, page.path, page.views, page.visits)
			order by site.slug collate "C", page.place)
		into v_rows
		from (select rows.site_id, rows.path, sum(rows.views)::bigint as views, sum(rows.visits)::bigint as visits,
				row_number() over (partition by rows.site_id
					order by sum(rows.views) desc, sum(rows.visits) desc, rows.path collate "C") as place
			from public.qorpera_site_count_day_rows(v_sites, v_zone, v_from, v_to) as rows
			group by rows.site_id, rows.path) as page
		join public.qorpera_company_sites as site on site.id = page.site_id
		where page.place <= v_limit;
	end case;

	v_rows := coalesce(v_rows, '[]'::jsonb);
	if jsonb_array_length(v_rows) > c_rows then
		v_more := true;
		v_rows := (select jsonb_agg(item.value order by item.place) from jsonb_array_elements(v_rows)
			with ordinality as item(value, place) where item.place <= c_rows);
	end if;
	return jsonb_build_object('columns', to_jsonb(v_columns), 'rows', v_rows, 'more', v_more);
end $$;
revoke all on function public.qorpera_company_numbers_site(uuid, timestamptz, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The dispatcher answers the site questions (they were "not counted yet"), by an anchor on its definition as
-- 20260930767000 left it (an anchor not found exactly once fails the migration).
create function pg_temp.site_counts_patch(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930768000' in v_definition) > 0 then
		raise exception '20260930768000 is already in %', p_target; end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930768000 anchor is not found exactly once in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.site_counts_patch('public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_question in ('sites', 'site-now', 'site-hours', 'site-days', 'site-pages') then
		raise exception 'qorpera/% is not counted yet: the sites'' numbers come later', p_question
			using errcode = '0A000'; end if;$old$,
	$new$	-- 20260930768000: the site questions, for any member or run of the company (the two doors' own check), from the
	-- views site-serve counts (qorpera_company_numbers_site).
	if p_question in ('sites', 'site-now', 'site-hours', 'site-days', 'site-pages') then
		v_body := public.qorpera_company_numbers_site(p_profile_id, v_now, p_question, v_params);
		return v_body || jsonb_build_object(
			'asOf', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'etag', left(encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'), 32));
	end if;$new$);

drop function pg_temp.site_counts_patch(regprocedure, text, text);

-- The dispatcher keeps its grants (none) and its marker.
do $$
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure),
			'Company views step 3, slice M1 (20260930767000)') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure),
			'20260930768000') = 0 then
		raise exception '20260930768000: the dispatcher lost a marker'; end if;
end $$;
