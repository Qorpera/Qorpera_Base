do $$ begin
	if to_regclass('public.qorpera_company_mail_handles') is not null then
		raise exception '20260930796000 is already applied'; end if;
	if current_setting('server_encoding') <> 'UTF8' then
		raise exception '20260930796000 needs a UTF8 database, not %', current_setting('server_encoding'); end if;
	if to_regprocedure('public.qorpera_send_member_mail(uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_mail_name_reads_as_qorpera(text)') is null then
		raise exception '20260930796000 needs 20260930716000 and 20260928319810'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.mail_handles_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company mail handles integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.mail_handles_patch('public.qorpera_folder_company_open(uuid,uuid,text)'::regprocedure,
	$old$declare v_name text := btrim(p_name); v_request$old$,
	$new$declare v_name text := case when p_name is null
		or p_name ~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*$' then 'No name yet' else btrim(p_name) end;
	v_request$new$);

select pg_temp.mail_handles_patch('public.qorpera_open_company_founding(uuid,text)'::regprocedure,
	$old$if p_client_creation_id is null or p_company_name is null or char_length(btrim(p_company_name)) not between 1 and 120 then$old$,
	$new$if p_client_creation_id is null or char_length(btrim(p_company_name)) > 120 then$new$);

select pg_temp.mail_handles_patch('public.qorpera_update_company_founding(uuid,bigint,text,text)'::regprocedure,
	$old$v_name text := btrim(p_company_name);$old$,
	$new$v_name text := case when p_company_name is null
		or p_company_name ~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*$' then 'No name yet'
		else btrim(p_company_name) end;$new$);

create table public.qorpera_company_mail_handles (
	handle text primary key check (handle ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$'),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	claimed_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default statement_timestamp()
);
create index qorpera_company_mail_handles_company on public.qorpera_company_mail_handles (profile_id);
alter table public.qorpera_company_mail_handles enable row level security;
revoke all on table public.qorpera_company_mail_handles from public, anon, authenticated, service_role;

insert into public.qorpera_company_mail_handles (handle, profile_id, claimed_by_user_id, created_at)
select mailbox.local_part, mailbox.profile_id, mailbox.created_by_user_id, mailbox.created_at
from public.qorpera_company_mailboxes as mailbox
where mailbox.removed_at is null and mailbox.local_part ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$'
order by mailbox.created_at, mailbox.id
on conflict (handle) do nothing;

create function public.qorpera_mail_name_reserved(p_name text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_name, '') in ('postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'administrator', 'root',
		'security', 'noc', 'noreply', 'no-reply', 'mailer-daemon', 'www', 'ftp', 'uucp', 'usenet', 'news')
$$;
revoke all on function public.qorpera_mail_name_reserved(text) from public, anon, authenticated, service_role;

create function public.qorpera_mail_handle_state(p_profile_id uuid, p_handle text)
returns text language sql stable set search_path = '' as $$
	select case
		when p_handle is null or p_handle !~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$'
			or public.qorpera_mail_name_reserved(p_handle) or public.qorpera_mail_name_reads_as_qorpera(p_handle) then 'invalid'
		when exists (select 1 from public.qorpera_company_mail_handles as owned
			where owned.handle = p_handle and owned.profile_id = p_profile_id) then 'ours'
		when exists (select 1 from public.qorpera_company_mail_handles as owned where owned.handle = p_handle)
			or exists (select 1 from public.qorpera_company_mailboxes as mailbox
				where mailbox.removed_at is null and mailbox.profile_id <> p_profile_id
					and (mailbox.local_part = p_handle or right(mailbox.local_part, char_length(p_handle) + 1) = '.' || p_handle))
			then 'taken'
		else 'free' end
$$;
revoke all on function public.qorpera_mail_handle_state(uuid, text) from public, anon, authenticated, service_role;

create function public.qorpera_mail_admit_local_part(p_profile_id uuid, p_local_part text, p_claim_user_id uuid)
returns void language plpgsql set search_path = '' as $$
declare
	v_box text := split_part(coalesce(p_local_part, ''), '.', 1);
	v_handle text := split_part(coalesce(p_local_part, ''), '.', 2);
	v_state text;
begin
	if p_local_part is null
		or p_local_part !~ '^[a-z0-9]([a-z0-9_-]{0,37}[a-z0-9])?\.[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$' then
		raise exception 'A new address is a name, a dot and the company''s handle, like hello.acme' using errcode = '22023'; end if;
	if public.qorpera_mail_name_reserved(v_box) or public.qorpera_mail_name_reserved(v_handle) then
		raise exception 'This mailbox name is reserved' using errcode = '22023'; end if;
	if public.qorpera_mail_name_reads_as_qorpera(v_box) or public.qorpera_mail_name_reads_as_qorpera(v_handle) then
		raise exception 'A mailbox name that reads as Qorpera is reserved' using errcode = '22023'; end if;
	v_state := public.qorpera_mail_handle_state(p_profile_id, v_handle);
	if v_state = 'ours' then return; end if;
	if v_state <> 'free' then
		raise exception 'This address is taken' using errcode = '23505'; end if;
	if p_claim_user_id is null then
		raise exception 'Only a member can choose the company''s email handle' using errcode = '42501'; end if;
	if (select count(*) from public.qorpera_company_mail_handles as owned where owned.profile_id = p_profile_id) >= 3 then
		raise exception 'A company has at most 3 email handles' using errcode = '54000'; end if;
	insert into public.qorpera_company_mail_handles (handle, profile_id, claimed_by_user_id)
	values (v_handle, p_profile_id, p_claim_user_id)
	on conflict (handle) do nothing;
	if public.qorpera_mail_handle_state(p_profile_id, v_handle) <> 'ours' then
		raise exception 'This address is taken' using errcode = '23505'; end if;
end
$$;
revoke all on function public.qorpera_mail_admit_local_part(uuid, text, uuid) from public, anon, authenticated, service_role;

select pg_temp.mail_handles_patch('public.qorpera_create_company_mailbox(uuid,uuid,text,text)'::regprocedure,
	$old$	if exists (select 1 from public.qorpera_company_mailboxes
		where local_part = p_local_part and removed_at is null) then
		raise exception 'This address is taken' using errcode = '23505';
	end if;
$old$,
	$new$	perform public.qorpera_mail_admit_local_part(p_profile_id, p_local_part, auth.uid());
	if exists (select 1 from public.qorpera_company_mailboxes
		where local_part = p_local_part and removed_at is null) then
		raise exception 'This address is taken' using errcode = '23505';
	end if;
$new$);

select pg_temp.mail_handles_patch('public.qorpera_folder_manage_hook_effect(jsonb,jsonb,public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,bytea,text,text)'::regprocedure,
	$old$				if exists (select 1 from public.qorpera_company_mailboxes
					where local_part = p_request ->> 'localPart' and removed_at is null) then
$old$,
	$new$				perform public.qorpera_mail_admit_local_part(v_run.profile_id, p_request ->> 'localPart', null);
				if exists (select 1 from public.qorpera_company_mailboxes
					where local_part = p_request ->> 'localPart' and removed_at is null) then
$new$);

create function public.qorpera_company_mail_handle_status(p_profile_id uuid, p_handle text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Company mail addresses are unavailable' using errcode = '42501'; end if;
	return public.qorpera_mail_handle_state(p_profile_id, p_handle);
end
$$;
revoke all on function public.qorpera_company_mail_handle_status(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_company_mail_handle_status(uuid, text) to authenticated;

create function public.qorpera_company_mail_handles(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Company mail addresses are unavailable' using errcode = '42501'; end if;
	return jsonb_build_object(
		'domain', (select settings.domain from public.qorpera_mail_settings as settings),
		'handles', coalesce((select jsonb_agg(owned.handle order by owned.created_at, owned.handle)
			from public.qorpera_company_mail_handles as owned where owned.profile_id = p_profile_id), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_company_mail_handles(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_company_mail_handles(uuid) to authenticated;

create function public.qorpera_mail_header_safe_name(p_name text)
returns text language sql immutable set search_path = '' as $$
	select btrim(regexp_replace(regexp_replace(coalesce(p_name, ''),
		'["\\<>[:cntrl:]\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]', ' ', 'g'), '\s+', ' ', 'g'))
$$;
revoke all on function public.qorpera_mail_header_safe_name(text) from public, anon, authenticated, service_role;

create function public.qorpera_mail_company_short_name(p_name text)
returns text language plpgsql immutable set search_path = '' as $$
declare
	v_name text := public.qorpera_mail_header_safe_name(p_name);
	v_space integer;
begin
	if v_name = '' or v_name = 'No name yet' then return null; end if;
	while position(' ' in v_name) > 0 and lower(substring(v_name from '[^ ]+$')) in ('aps', 'a/s', 'ivs', 'i/s', 'k/s', 'p/s',
		'inc', 'inc.', 'llc', 'ltd', 'ltd.', 'limited', 'gmbh', 'ag', 'ab', 'oy', 'bv', 'nv', 'sa', 'sas', 'sarl', 'srl', 'plc',
		'corp', 'corp.') loop
		v_name := rtrim(regexp_replace(v_name, ' [^ ]+$', ''), ' ,');
	end loop;
	if char_length(v_name) > 40 then
		v_space := 39 - coalesce(nullif(position(' ' in reverse(left(v_name, 39))), 0), 40) + 1;
		v_name := case when v_space >= 20 then left(v_name, v_space - 1) else left(v_name, 39) end;
		v_name := regexp_replace(v_name, '[[:space:][:punct:]]+$', '') || '…';
	end if;
	return v_name;
end
$$;
revoke all on function public.qorpera_mail_company_short_name(text) from public, anon, authenticated, service_role;

select pg_temp.mail_handles_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	v_company := public.qorpera_mail_display_name((select profile.name from public.qorpera_profiles as profile
		where profile.id = v_run.profile_id), 'the company');$old$,
	$new$	v_company := coalesce(nullif(public.qorpera_mail_header_safe_name((select profile.name
		from public.qorpera_profiles as profile where profile.id = v_run.profile_id)), ''), 'the company');$new$);
select pg_temp.mail_handles_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$format('Written and sent by %s, an AI agent working for %s.', v_agent, v_company);$old$,
	$new$format('Written and sent by %s, an AI agent working for %s.', v_agent,
			case when v_company = 'No name yet' then 'a new company' else v_company end);$new$);
select pg_temp.mail_handles_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$		v_agent || ' at ' || v_company, v_to,$old$,
	$new$		v_agent || coalesce(' at ' || public.qorpera_mail_company_short_name(v_company), ''), v_to,$new$);
select pg_temp.mail_handles_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$	v_company := public.qorpera_mail_display_name((select profile.name from public.qorpera_profiles as profile
		where profile.id = v_profile_id), 'the company');$old$,
	$new$	v_company := coalesce(nullif(public.qorpera_mail_header_safe_name((select profile.name
		from public.qorpera_profiles as profile where profile.id = v_profile_id)), ''), 'the company');$new$);
select pg_temp.mail_handles_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$		v_member || ' at ' || v_company, v_to,$old$,
	$new$		v_member || coalesce(' at ' || public.qorpera_mail_company_short_name(v_company), ''), v_to,$new$);

select pg_temp.mail_handles_patch('public.qorpera_interaction_request_valid(jsonb)'::regprocedure,
	$old$		if v_payload - 'options' - 'multiSelect' - 'allowCustom' - 'dismissOnMoveOn' <> '{}'::jsonb
$old$,
	$new$		if v_payload - 'options' - 'multiSelect' - 'allowCustom' - 'dismissOnMoveOn' - 'input' <> '{}'::jsonb
			or (v_payload ? 'input' and (v_payload -> 'input' is distinct from '{"kind":"mail_address"}'::jsonb
				or v_payload -> 'allowCustom' is distinct from 'true'::jsonb))
$new$);
