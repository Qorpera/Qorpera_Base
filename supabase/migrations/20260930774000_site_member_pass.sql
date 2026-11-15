-- 20260930774000: members see the company's own website inside Qorpera (company views step 4, slice V1; the lane's
-- DESIGN-4.md "V1"; Jonas, 15 November 2026: "ok, start step 4", "Yes, platform draws it"). The web shows a files site
-- in a frame on its own host, https://<slug>.qorpera.com/, opened without the site's password by a member's one-use pass;
-- the views a member's session makes are no visits and are not counted (20260930768000).
--
-- The rule of SITE-HOSTS.md D22 holds: no cookie is proof of who calls on a qorpera.com host but site-serve's own
-- __Host-qorpera_site. The member proves who they are to this database with their token (the API, a bearer token), and
-- carries the proof to the site's host as a pass in a form's body, never in a URL:
--
-- 1. qorpera_site_member_pass(p_site) (authenticated): any member of the site's company (viewers too) gets a pass for the
--    site's own host. 32 random bytes, base64url without padding (43 characters); only its SHA-256 is kept; good for
--    60 seconds and one use, bound to the site and to its own host. Answers, schema qorpera.site-member-pass/v1:
--      {"state":"open","host":"<slug>.qorpera.com","pass","expiresAt","action":"https://<slug>.qorpera.com/__qorpera/member"}
--      {"state":"off"} while hosts are off; {"state":"gone"} for a site Qorpera took down; {"state":"none"} for a site
--      with no live version; {"state":"limited","retryAfter":<seconds>} while the member holds 30 open passes.
--    42501 "Only the company's members open its site here" for anyone else (a site of another company, an app link, no
--    such site, a company being deleted: the same words), 22023 for no site named.
-- 2. qorpera_site_member_pass_redeem(p_host, p_pass) (service role: site-serve's POST /__qorpera/member): while hosts
--    are on, a pass of that own host's site, not expired, whose member is still one of the company's, of a files site
--    live and not taken down, its company not being deleted. The pass goes in the statement that takes it (one use);
--    then the site's expired passes go, its members' sessions that ended go and those past the newest 49, and a
--    session of 12 hours is made: the session a right password opens (scope site, the current password's), marked as
--    a member's (member_user_id). Answers {"state":"open","token":"<32 characters>","maxAge":43200}, or
--    {"state":"refused"}, which site-serve answers as a wrong password.
-- 3. The count (qorpera_site_count_view_at, 20260930768000) skips a member's session: members looking at their own site
--    are no visits.
--
-- Tables: qorpera_company_site_member_passes (new, closed to every API role) and qorpera_company_site_sessions'
-- member_user_id (a plain value, no foreign key, as the tickets' user_id; null for a visitor's session). Locks, each
-- waiting 3 s at most: ACCESS EXCLUSIVE on qorpera_company_site_sessions for the new column (no rewrite; its check
-- scans the table once), then SHARE ROW EXCLUSIVE on qorpera_company_sites for the passes' foreign key.
--
-- Every inserted text names this migration (20260930774000).

do $$
begin
	if to_regclass('public.qorpera_company_site_member_passes') is not null then
		raise exception '20260930774000 (site member pass) is already applied'; end if;
	if to_regprocedure('public.qorpera_site_count_view_at(text,text,text,timestamptz)') is null
		or to_regprocedure('public.qorpera_site_enter(text,text)') is null
		or to_regprocedure('public.qorpera_site_new_secret()') is null then
		raise exception '20260930774000 (site member pass) needs site hosts (20260930756000) and site counts (20260930768000)';
	end if;
end $$;

set local lock_timeout = '3s';

-- 1. Tables ------------------------------------------------------------------------------------------------------------

alter table public.qorpera_company_site_sessions
	-- 20260930774000: the member who opened this session with a pass (qorpera_site_member_pass_redeem), on the site's
	-- own host; null for a visitor's session (the password) and a next session (Look first). A plain value, no foreign
	-- key. A member's session is never counted as a view.
	add column member_user_id uuid,
	add constraint qorpera_company_site_sessions_member check (member_user_id is null or scope = 'site');
create index qorpera_company_site_sessions_member on public.qorpera_company_site_sessions(site_id, created_at)
	where member_user_id is not null;

create table public.qorpera_company_site_member_passes (
	pass_sha256 text primary key check (pass_sha256 ~ '^[0-9a-f]{64}$'),
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	-- A plain value, no foreign key: the member who asked.
	user_id uuid not null,
	-- The site's own host when the pass was made, <slug>.<hosts_domain>: the only host that takes it.
	host text not null check (char_length(host) between 1 and 253),
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null,
	check (expires_at > created_at)
);
create index qorpera_company_site_member_passes_user on public.qorpera_company_site_member_passes(user_id, expires_at);
create index qorpera_company_site_member_passes_site on public.qorpera_company_site_member_passes(site_id, expires_at);
alter table public.qorpera_company_site_member_passes enable row level security;
revoke all on public.qorpera_company_site_member_passes from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_company_site_member_passes is
	'20260930774000: a member''s one-use passes into the company''s own site inside the web: 60 seconds, one use, bound '
	'to the site''s own host (qorpera_site_member_pass, qorpera_site_member_pass_redeem). Kept by sha256. Its functions '
	'write it.';

-- 2. The member's call -------------------------------------------------------------------------------------------------

-- A pass for the files site p_site's own host, for any member of its company (see the head of this file for the
-- answers). At most 30 open passes a member: one member's asks are taken one at a time, and the member's expired passes
-- go first.
create function public.qorpera_site_member_pass(p_site uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- 20260930774000
declare v_user uuid := auth.uid(); v_profile uuid; v_site public.qorpera_company_sites%rowtype; v_pass text;
	v_host text; v_open integer; v_oldest timestamptz; v_now timestamptz; c_schema constant text := 'qorpera.site-member-pass/v1';
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Only the company''s members open its site here' using errcode = '42501'; end if;
	if p_site is null then raise exception 'A site is needed' using errcode = '22023'; end if;
	-- The same words for no such site, another company's, an app link and a company being deleted
	-- (qorpera_member_role is null while its deletion waits).
	select site.profile_id into v_profile from public.qorpera_company_sites as site
	where site.id = p_site and site.kind = 'files';
	if v_profile is null or public.qorpera_member_role(v_profile) is null then
		raise exception 'Only the company''s members open its site here' using errcode = '42501'; end if;
	if not public.qorpera_site_hosts_on() then return jsonb_build_object('schema', c_schema, 'state', 'off'); end if;
	-- Read shared (as Look first reads it): a takedown on its way is waited for, then read, and no pass outlives it.
	select site.* into v_site from public.qorpera_company_sites as site where site.id = p_site for share;
	if v_site.taken_down_at is not null then return jsonb_build_object('schema', c_schema, 'state', 'gone'); end if;
	if v_site.current_version_id is null then return jsonb_build_object('schema', c_schema, 'state', 'none'); end if;
	-- One member's asks one at a time, so the bound holds.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.site-member-pass:' || v_user::text, 0));
	v_now := clock_timestamp();
	delete from public.qorpera_company_site_member_passes as pass where pass.user_id = v_user and pass.expires_at <= v_now;
	select count(*), min(pass.expires_at) into v_open, v_oldest from public.qorpera_company_site_member_passes as pass
	where pass.user_id = v_user;
	if v_open >= 30 then
		return jsonb_build_object('schema', c_schema, 'state', 'limited',
			'retryAfter', greatest(1, ceil(extract(epoch from v_oldest - v_now)))::integer); end if;
	v_host := v_site.slug || '.' || (select settings.hosts_domain from public.qorpera_site_settings as settings);
	v_pass := public.qorpera_site_new_secret();
	insert into public.qorpera_company_site_member_passes (pass_sha256, site_id, user_id, host, created_at, expires_at)
	values (public.qorpera_site_sha256(v_pass), v_site.id, v_user, v_host, v_now, v_now + interval '60 seconds');
	return jsonb_build_object('schema', c_schema, 'state', 'open', 'host', v_host, 'pass', v_pass,
		'expiresAt', v_now + interval '60 seconds', 'action', 'https://' || v_host || '/__qorpera/member');
end $$;

revoke all on function public.qorpera_site_member_pass(uuid) from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_site_member_pass(uuid) to authenticated;
comment on function public.qorpera_site_member_pass(uuid) is
	'Any member of the site''s company: a one-use pass of 60 seconds into the files site''s own host, posted by the web '
	'to https://<host>/__qorpera/member; off while hosts are off, gone for a site taken down, none for a site not live, '
	'limited at 30 open passes a member (20260930774000).';

-- 3. site-serve's call -------------------------------------------------------------------------------------------------

-- An own host's member pass (p_pass: 43 characters of base64url) for a member's session (see the head of this file).
create function public.qorpera_site_member_pass_redeem(p_host text, p_pass text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 20260930774000
declare v_host text := lower(p_host); v_host_of jsonb; v_site public.qorpera_company_sites%rowtype;
	v_pass public.qorpera_company_site_member_passes%rowtype; v_token text; v_now timestamptz := clock_timestamp();
begin
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' or v_host is null or not public.qorpera_site_hosts_on() then
		return '{"state":"refused"}'::jsonb; end if;
	v_host_of := public.qorpera_site_host(v_host);
	if v_host_of is null or v_host_of ->> 'scope' <> 'site' then return '{"state":"refused"}'::jsonb; end if;
	select site.* into v_site from public.qorpera_company_sites as site
	where site.slug = v_host_of ->> 'slug' and site.kind = 'files' and site.current_version_id is not null
		and site.taken_down_at is null and not public.qorpera_company_deleting(site.profile_id);
	if not found then return '{"state":"refused"}'::jsonb; end if;
	-- One use: the pass goes in the statement that takes it, so two uses at once never both open a session.
	delete from public.qorpera_company_site_member_passes as pass
	where pass.pass_sha256 = public.qorpera_site_sha256(p_pass) and pass.site_id = v_site.id and pass.host = v_host
		and pass.expires_at > v_now
	returning pass.* into v_pass;
	if v_pass.pass_sha256 is null or not exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_site.profile_id and member.user_id = v_pass.user_id) then
		return '{"state":"refused"}'::jsonb; end if;
	delete from public.qorpera_company_site_member_passes as pass where pass.site_id = v_site.id and pass.expires_at <= v_now;
	-- At most 50 members' sessions a site, the newest; visitors' and next sessions are not touched.
	delete from public.qorpera_company_site_sessions as session
	where session.site_id = v_site.id and session.member_user_id is not null
		and (session.expires_at <= v_now or session.password_version <> v_site.password_version);
	delete from public.qorpera_company_site_sessions as session where session.token_sha256 in (
		select old.token_sha256 from public.qorpera_company_site_sessions as old
		where old.site_id = v_site.id and old.member_user_id is not null
		order by old.created_at desc offset 49);
	v_token := public.qorpera_site_new_token();
	insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at, scope,
		member_user_id)
	values (public.qorpera_site_sha256(v_token), v_site.id, v_site.password_version, v_now + interval '12 hours', 'site',
		v_pass.user_id);
	return jsonb_build_object('state', 'open', 'token', v_token, 'maxAge', 43200);
end $$;

revoke all on function public.qorpera_site_member_pass_redeem(text, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_site_member_pass_redeem(text, text) to service_role;
comment on function public.qorpera_site_member_pass_redeem(text, text) is
	'site-serve''s POST /__qorpera/member on a site''s own host: a member''s one-use pass for a member''s session of 12 '
	'hours, never counted as a view; refused otherwise (20260930774000).';

-- 4. The count skips a member's session --------------------------------------------------------------------------------

do $patch$
declare v_target regprocedure := 'public.qorpera_site_count_view_at(text,text,text,timestamptz)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target); v_found integer;
	c_old constant text := $old$			where session.token_sha256 = v_sha and session.site_id = v_site.id and session.scope = 'site'$old$;
	c_new constant text := $new$			where session.token_sha256 = v_sha and session.site_id = v_site.id and session.scope = 'site'
				-- 20260930774000: a visitor's; a member's session (the web's look at the site) is no visit.
				and session.member_user_id is null$new$;
begin
	if position('20260930774000' in v_definition) > 0 then
		raise exception '20260930774000 is already in %', v_target; end if;
	v_found := (length(v_definition) - length(replace(v_definition, c_old, ''))) / length(c_old);
	if v_found <> 1 then
		raise exception '20260930774000 anchor found % time(s) in %, expected 1', v_found, v_target; end if;
	execute replace(v_definition, c_old, c_new);
	if strpos((select prosrc from pg_proc where oid = v_target), '20260930768000') = 0
		or strpos((select prosrc from pg_proc where oid = v_target), '20260930774000') = 0 then
		raise exception '% lost a marker', v_target; end if;
end $patch$;
