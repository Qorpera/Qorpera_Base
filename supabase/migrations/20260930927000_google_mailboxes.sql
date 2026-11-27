do $$ begin
	if to_regclass('public.qorpera_google_mailboxes') is not null then
		raise exception '20260930927000 is already applied'; end if;
	if to_regclass('public.qorpera_company_mail_handles') is null
		or to_regprocedure('public.qorpera_send_member_mail(uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)') is null then
		raise exception '20260930927000 needs 20260930796000, 20260930716000 and the cloud secret capture'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.google_mailbox_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Google mailbox integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

create table public.qorpera_google_mailboxes (
	mailbox_id uuid primary key references public.qorpera_company_mailboxes(id) on delete cascade,
	hook_id uuid not null unique references public.qorpera_event_hooks(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	address text not null check (char_length(address) <= 254 and address = lower(address)
		and address ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
	secret_id uuid not null references public.qorpera_cloud_secrets(id) on delete cascade,
	state text not null default 'bringing_in' check (state in ('bringing_in', 'live', 'sign_in_again')),
	paused boolean not null default false,
	history_id text check (history_id ~ '^[0-9]{1,20}$'),
	page_token text check (char_length(page_token) between 1 and 512 and page_token ~ '^[\x21-\x7e]+$'),
	brought_in integer not null default 0 check (brought_in >= 0),
	import_count integer not null default 0 check (import_count between 0 and 50000),
	gap boolean not null default false,
	capped boolean not null default false,
	resume_pending boolean not null default false,
	resume_page_token text check (char_length(resume_page_token) between 1 and 512 and resume_page_token ~ '^[\x21-\x7e]+$'),
	resume_count integer check (resume_count between 0 and 50000),
	total integer check (total >= 0),
	imported_at timestamptz,
	due_at timestamptz,
	lease_id uuid,
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	last_error text check (char_length(last_error) between 1 and 300),
	checked_at timestamptz,
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	removed_at timestamptz,
	check (state <> 'live' or imported_at is not null)
);
create unique index qorpera_google_mailboxes_live_address on public.qorpera_google_mailboxes (address)
	where removed_at is null;
create index qorpera_google_mailboxes_due on public.qorpera_google_mailboxes (due_at)
	where due_at is not null and removed_at is null;
create index qorpera_google_mailboxes_company on public.qorpera_google_mailboxes (profile_id, environment_id);
create index qorpera_google_mailboxes_secret on public.qorpera_google_mailboxes (secret_id);
alter table public.qorpera_google_mailboxes enable row level security;
revoke all on table public.qorpera_google_mailboxes from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_google_mail_messages (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	address text not null,
	gmail_id text not null check (gmail_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	mailbox_id uuid not null references public.qorpera_company_mailboxes(id) on delete cascade,
	gmail_thread_id text check (gmail_thread_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	delivery_id uuid references public.qorpera_event_deliveries(id) on delete set null,
	mail_id uuid references public.qorpera_company_mail_outbox(id) on delete cascade,
	imported boolean not null default false,
	gap boolean not null default false,
	created_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, address, gmail_id)
);
create index qorpera_google_mail_messages_delivery on public.qorpera_google_mail_messages (delivery_id)
	where delivery_id is not null;
create index qorpera_google_mail_messages_mail on public.qorpera_google_mail_messages (mail_id) where mail_id is not null;
create index qorpera_google_mail_messages_mailbox on public.qorpera_google_mail_messages (mailbox_id);
alter table public.qorpera_google_mail_messages enable row level security;
revoke all on table public.qorpera_google_mail_messages from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_google_mailbox_tickets (
	ticket_id uuid primary key references public.qorpera_cloud_secret_capture_tickets(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	mailbox_id uuid references public.qorpera_company_mailboxes(id) on delete cascade,
	created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_google_mailbox_tickets enable row level security;
revoke all on table public.qorpera_google_mailbox_tickets from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_company_mail_outbox add column route text not null default 'platform'
	check (route in ('platform', 'gmail'));
alter table public.qorpera_company_mail_outbox
	add column gmail_draft_id text check (gmail_draft_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	add column gmail_draft_message_id text check (gmail_draft_message_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	add constraint qorpera_company_mail_outbox_gmail_draft
		check ((gmail_draft_id is null) = (gmail_draft_message_id is null) and (gmail_draft_id is null or route = 'gmail'));
create index qorpera_company_mail_outbox_gmail_due on public.qorpera_company_mail_outbox (profile_id, next_attempt_at)
	where route = 'gmail' and status in ('pending', 'retrying', 'delivering');

create function public.qorpera_google_mailbox_address(p_mailbox_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select google.address from public.qorpera_google_mailboxes as google where google.mailbox_id = p_mailbox_id
$$;
revoke all on function public.qorpera_google_mailbox_address(uuid) from public, anon, authenticated, service_role;

create function public.qorpera_mailbox_address(p_mailbox_id uuid, p_local_part text, p_domain text)
returns text language sql stable security definer set search_path = '' as $$
	select coalesce(public.qorpera_google_mailbox_address(p_mailbox_id), p_local_part || '@' || p_domain)
$$;
revoke all on function public.qorpera_mailbox_address(uuid, text, text) from public, anon, authenticated, service_role;

create function public.qorpera_google_mailbox_state(p_google public.qorpera_google_mailboxes)
returns text language sql immutable set search_path = '' as $$
	select case when p_google.state = 'sign_in_again' then 'sign_in_again' when p_google.paused then 'paused'
		else p_google.state end
$$;
revoke all on function public.qorpera_google_mailbox_state(public.qorpera_google_mailboxes)
	from public, anon, authenticated, service_role;

create function public.qorpera_google_address_key(p_address text)
returns text language sql immutable set search_path = '' as $$
	select case when address.domain in ('gmail.com', 'googlemail.com')
		then replace(address.local, '.', '') || '@gmail.com' else address.local || '@' || address.domain end
	from (select split_part(split_part(lower(btrim(p_address)), '@', 1), '+', 1) as local,
		split_part(lower(btrim(p_address)), '@', 2) as domain) as address
$$;
revoke all on function public.qorpera_google_address_key(text) from public, anon, authenticated, service_role;

create function public.qorpera_google_mail_door()
returns jsonb language sql stable set search_path = '' as $$
	select nullif(current_setting('qorpera.google_mail_door', true), '')::jsonb
$$;
revoke all on function public.qorpera_google_mail_door() from public, anon, authenticated, service_role;

create function public.qorpera_google_mail_email_id(p_profile_id uuid, p_address text, p_gmail_id text)
returns text language sql immutable set search_path = '' as $$
	select substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-' || substr(digest, 13, 4) || '-'
		|| substr(digest, 17, 4) || '-' || substr(digest, 21, 12)
	from (select encode(extensions.digest(convert_to('qorpera.gmail-message/v1' || chr(10) || p_profile_id::text || chr(10)
		|| p_address || chr(10) || p_gmail_id, 'UTF8'), 'sha256'), 'hex') as digest) as derived
$$;
revoke all on function public.qorpera_google_mail_email_id(uuid, text, text) from public, anon, authenticated, service_role;

create function public.qorpera_google_mailbox_authority(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns public.qorpera_cloud_secret_broker_authorities
language plpgsql security definer set search_path = '' as $$
declare v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501'; end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501'; end if;
	return v_authority;
end
$$;
revoke all on function public.qorpera_google_mailbox_authority(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_google_mailbox_leased(p_profile_id uuid, p_mailbox_id uuid, p_lease_id uuid)
returns public.qorpera_google_mailboxes
language plpgsql security definer set search_path = '' as $$
declare v_google public.qorpera_google_mailboxes%rowtype;
begin
	select google.* into v_google from public.qorpera_google_mailboxes as google
	where google.mailbox_id = p_mailbox_id and google.profile_id = p_profile_id for update;
	if v_google.mailbox_id is null or v_google.removed_at is not null or v_google.lease_id is distinct from p_lease_id
		or v_google.lease_until is null or v_google.lease_until <= clock_timestamp() then
		raise exception 'Google mailbox is not leased' using errcode = '55000'; end if;
	return v_google;
end
$$;
revoke all on function public.qorpera_google_mailbox_leased(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_google_mailbox_end_sign_in(p_secret_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret public.qorpera_cloud_secrets%rowtype;
begin
	if exists (select 1 from public.qorpera_google_mailboxes as google
		where google.secret_id = p_secret_id and google.removed_at is null) then
		return; end if;
	perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
	where grant_row.secret_id = p_secret_id and grant_row.status = 'active' order by grant_row.id for update;
	update public.qorpera_cloud_secrets
	set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = p_user_id,
		updated_at = statement_timestamp()
	where id = p_secret_id and status = 'active'
	returning * into v_secret;
	if v_secret.id is null then return; end if;
	update public.qorpera_cloud_secret_operation_grants
	set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = p_user_id
	where secret_id = p_secret_id and status = 'active';
	insert into public.qorpera_cloud_secret_audit_events (profile_id, environment_id, secret_id, secret_version, event_type,
		actor_user_id, connector_id)
	values (v_secret.profile_id, v_secret.environment_id, v_secret.id, v_secret.current_version, 'secret_revoked',
		p_user_id, v_secret.connector_id);
end
$$;
revoke all on function public.qorpera_google_mailbox_end_sign_in(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_google_mailbox_follow_mailbox()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_google public.qorpera_google_mailboxes%rowtype;
begin
	update public.qorpera_google_mailboxes
	set removed_at = new.removed_at, due_at = null, lease_id = null, lease_until = null, updated_at = clock_timestamp()
	where mailbox_id = new.id and removed_at is null
	returning * into v_google;
	if v_google.mailbox_id is not null then
		perform public.qorpera_google_mailbox_end_sign_in(v_google.secret_id, auth.uid());
	end if;
	return null;
end
$$;
revoke all on function public.qorpera_google_mailbox_follow_mailbox()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_google_mailbox_follow_mailbox after update of removed_at on public.qorpera_company_mailboxes
	for each row when (old.removed_at is null and new.removed_at is not null)
	execute function public.qorpera_google_mailbox_follow_mailbox();

create function public.qorpera_google_mailbox_follow_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.status = 'revoked' then
		update public.qorpera_google_mailboxes
		set state = 'sign_in_again', due_at = null, lease_id = null, lease_until = null,
			last_error = 'The Google sign-in was ended', updated_at = clock_timestamp()
		where secret_id = new.id and removed_at is null;
	elsif new.current_version <> old.current_version then
		update public.qorpera_google_mailboxes
		set state = case when imported_at is null then 'bringing_in' else 'live' end,
			due_at = case when paused then null else clock_timestamp() end, attempts = 0, last_error = null,
			updated_at = clock_timestamp()
		where secret_id = new.id and removed_at is null and state = 'sign_in_again'
			and address = lower(coalesce(new.account_label, ''));
	end if;
	return null;
end
$$;
revoke all on function public.qorpera_google_mailbox_follow_secret()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_google_mailbox_follow_secret after update of status, current_version on public.qorpera_cloud_secrets
	for each row when (new.connector_id = 'gmail')
	execute function public.qorpera_google_mailbox_follow_secret();

create function public.qorpera_google_mail_outbox_route()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_google public.qorpera_google_mailboxes%rowtype;
begin
	select google.* into v_google from public.qorpera_google_mailboxes as google
	where google.mailbox_id = new.mailbox_id and google.removed_at is null;
	if v_google.mailbox_id is null then
		new.route := 'platform';
		return new;
	end if;
	if v_google.state = 'sign_in_again' then
		raise exception 'Google asked you to sign in again.' using errcode = '0A000'; end if;
	if jsonb_array_length(new.attachments) > 0 then
		raise exception 'Email sent from a Google address carries no attached files' using errcode = '0A000'; end if;
	new.route := 'gmail';
	new.from_address := v_google.address;
	return new;
end
$$;
revoke all on function public.qorpera_google_mail_outbox_route() from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_google_mail_outbox_route before insert on public.qorpera_company_mail_outbox
	for each row execute function public.qorpera_google_mail_outbox_route();

create function public.qorpera_begin_google_mailbox(p_environment_id uuid, p_mailbox_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_ticket jsonb;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if auth.uid() is null or v_profile_id is null or public.qorpera_company_deleting(v_profile_id)
		or coalesce(public.qorpera_member_role(v_profile_id)::text not in ('owner', 'admin'), true) then
		raise exception 'Only owners and admins connect Google mail' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_mail_settings as settings
		where settings.enabled and settings.domain is not null) then
		raise exception 'Company mail is not set up yet' using errcode = '0A000'; end if;
	if p_mailbox_id is not null then
		select google.* into v_google from public.qorpera_google_mailboxes as google
		where (google.mailbox_id = p_mailbox_id or google.hook_id = p_mailbox_id)
			and google.environment_id = p_environment_id and google.removed_at is null;
		if v_google.mailbox_id is null then
			raise exception 'This company has no such Google mailbox' using errcode = '22023'; end if;
		select secret.* into v_secret from public.qorpera_cloud_secrets as secret
		where secret.id = v_google.secret_id and secret.status = 'active' and secret.owner_kind = 'company'
			and secret.connector_id = 'gmail';
		if v_secret.id is not null then
			update public.qorpera_cloud_secret_capture_tickets
			set status = 'cancelled'
			where secret_id = v_secret.id and status = 'pending' and target_version > 1
				and id in (select mark.ticket_id from public.qorpera_google_mailbox_tickets as mark);
		end if;
	end if;
	v_ticket := public.qorpera_begin_cloud_secret_capture(v_profile_id, p_environment_id, 'company', null, 'gmail',
		coalesce(v_secret.secret_name, 'mailbox-' || encode(extensions.gen_random_bytes(5), 'hex')),
		coalesce(v_secret.purpose, 'Google mail in the Mailbox'), v_secret.id);
	insert into public.qorpera_google_mailbox_tickets (ticket_id, profile_id, environment_id, mailbox_id)
	values ((v_ticket ->> 'ticketId')::uuid, v_profile_id, p_environment_id, v_google.mailbox_id);
	return v_ticket;
end
$$;
revoke all on function public.qorpera_begin_google_mailbox(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_begin_google_mailbox(uuid, uuid) to authenticated;

create function public.qorpera_connect_existing_google_mailbox(p_environment_id uuid, p_secret_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_profile_id uuid;
	v_domain text;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_address text;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_removed public.qorpera_google_mailboxes%rowtype;
	v_old_secret uuid;
	v_hook public.qorpera_event_hooks%rowtype;
	v_mailbox_id uuid;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if auth.uid() is null or v_profile_id is null or public.qorpera_company_deleting(v_profile_id)
		or coalesce(public.qorpera_member_role(v_profile_id)::text not in ('owner', 'admin'), true) then
		raise exception 'Only owners and admins connect Google mail' using errcode = '42501'; end if;
	select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
	if v_domain is null then
		raise exception 'Company mail is not set up yet' using errcode = '0A000'; end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = v_profile_id
		and secret.environment_id = p_environment_id and secret.owner_kind = 'company'
		and secret.connector_id = 'gmail' and secret.status = 'active'
	for share;
	v_address := lower(btrim(coalesce(v_secret.account_label, '')));
	if v_secret.id is null or char_length(v_address) > 254
		or v_address !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
		or not exists (select 1 from public.qorpera_cloud_secret_versions as version
			join public.qorpera_cloud_secret_broker_authorities as authority
				on authority.id = version.broker_authority_id and authority.status = 'active'
			where version.secret_id = v_secret.id and version.version = v_secret.current_version
				and version.encrypted_envelope is not null) then
		raise exception 'This company has no such Gmail connection' using errcode = '22023'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-google-mailbox:' || v_address, 0));
	if exists (select 1 from public.qorpera_google_mailboxes as other
		where other.address = v_address and other.removed_at is null
			and (other.profile_id <> v_profile_id or other.environment_id <> p_environment_id)) then
		return jsonb_build_object('schema', 'qorpera.google-mailbox-refused/v1', 'reason', 'address_taken',
			'message', 'This address is already brought in by another company.');
	end if;
	select google.* into v_google from public.qorpera_google_mailboxes as google
	where google.environment_id = p_environment_id and google.address = v_address
		and google.removed_at is null
	for update;
	if v_google.mailbox_id is not null then
		if v_google.state <> 'sign_in_again' and v_google.secret_id = v_secret.id then
			return jsonb_build_object('schema', 'qorpera.google-mailbox-connected/v1', 'outcome', 'relinked',
				'mailboxId', v_google.mailbox_id, 'hookId', v_google.hook_id, 'address', v_address,
				'secretId', v_secret.id);
		end if;
		v_old_secret := v_google.secret_id;
		update public.qorpera_google_mailboxes
		set secret_id = v_secret.id,
			state = case when state = 'sign_in_again' then case when imported_at is null then 'bringing_in' else 'live' end
				else state end,
			due_at = case when paused then null else clock_timestamp() end,
			lease_id = null, lease_until = null, attempts = 0, last_error = null, updated_at = clock_timestamp()
		where mailbox_id = v_google.mailbox_id;
		if v_old_secret <> v_secret.id then
			perform public.qorpera_google_mailbox_end_sign_in(v_old_secret, auth.uid());
		end if;
		return jsonb_build_object('schema', 'qorpera.google-mailbox-connected/v1', 'outcome', 'relinked',
			'mailboxId', v_google.mailbox_id, 'hookId', v_google.hook_id, 'address', v_address, 'secretId', v_secret.id);
	end if;
	if public.qorpera_environment_is_folder_v2(p_environment_id) then
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile_id, '[]'::jsonb, false);
		perform pg_advisory_xact_lock(hashtextextended('qorpera.event-hooks:' || v_profile_id::text, 0));
	else
		perform 1 from public.qorpera_profiles as profile where profile.id = v_profile_id for no key update;
	end if;
	if (select count(*) from public.qorpera_company_mailboxes as mailbox
		where mailbox.profile_id = v_profile_id and mailbox.removed_at is null) >= 20 then
		raise exception 'A company has at most 20 mailboxes' using errcode = '54000'; end if;
	if (select count(*) from public.qorpera_event_hooks as hook
		where hook.profile_id = v_profile_id and hook.status <> 'removed') >= 50 then
		raise exception 'A company has at most 50 hooks' using errcode = '54000'; end if;
	select google.* into v_removed from public.qorpera_google_mailboxes as google
	where google.profile_id = v_profile_id and google.environment_id = p_environment_id
		and google.address = v_address and google.removed_at is not null
	order by google.removed_at desc, google.mailbox_id limit 1
	for update;
	if v_removed.mailbox_id is not null then
		update public.qorpera_event_hooks set status = 'active', removed_at = null, updated_at = statement_timestamp()
		where id = v_removed.hook_id;
		update public.qorpera_company_mailboxes set removed_at = null where id = v_removed.mailbox_id;
		update public.qorpera_google_mailboxes
		set removed_at = null, secret_id = v_secret.id, state = 'bringing_in', paused = false,
			history_id = null, page_token = null, import_count = 0, gap = true,
			resume_pending = case when gap then resume_pending else imported_at is null end,
			resume_page_token = case when gap then resume_page_token when imported_at is null then page_token end,
			resume_count = case when gap then resume_count when imported_at is null then import_count end,
			imported_at = null, due_at = clock_timestamp(),
			lease_id = null, lease_until = null, attempts = 0, last_error = null, updated_at = clock_timestamp()
		where mailbox_id = v_removed.mailbox_id;
		return jsonb_build_object('schema', 'qorpera.google-mailbox-connected/v1', 'outcome', 'relinked',
			'mailboxId', v_removed.mailbox_id, 'hookId', v_removed.hook_id, 'address', v_address,
			'secretId', v_secret.id);
	end if;
	insert into public.qorpera_event_hooks (
		profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_user_id
	) values (
		v_profile_id, p_environment_id,
		'mail-google-' || left(encode(extensions.digest(v_address, 'sha256'), 'hex'), 12),
		left('Google mail for ' || v_address, 512), 'mail',
		translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
		262144, 120, auth.uid()
	) returning * into v_hook;
	insert into public.qorpera_company_mailboxes (hook_id, profile_id, environment_id, local_part, created_by_user_id)
	values (v_hook.id, v_profile_id, p_environment_id,
		'google_' || encode(extensions.gen_random_bytes(12), 'hex'), auth.uid())
	returning id into v_mailbox_id;
	insert into public.qorpera_google_mailboxes (mailbox_id, hook_id, profile_id, environment_id, address, secret_id,
		state, due_at, created_by_user_id)
	values (v_mailbox_id, v_hook.id, v_profile_id, p_environment_id, v_address, v_secret.id,
		'bringing_in', clock_timestamp(), auth.uid());
	return jsonb_build_object('schema', 'qorpera.google-mailbox-connected/v1', 'outcome', 'linked',
		'mailboxId', v_mailbox_id, 'hookId', v_hook.id, 'address', v_address, 'secretId', v_secret.id);
end
$$;
revoke all on function public.qorpera_connect_existing_google_mailbox(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_connect_existing_google_mailbox(uuid, uuid) to authenticated;

create function public.qorpera_pause_google_mailbox(p_mailbox_id uuid, p_paused boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_google public.qorpera_google_mailboxes%rowtype;
begin
	select google.* into v_google from public.qorpera_google_mailboxes as google
	where (google.mailbox_id = p_mailbox_id or google.hook_id = p_mailbox_id) and google.removed_at is null;
	if auth.uid() is null or v_google.mailbox_id is null
		or coalesce(public.qorpera_member_role(v_google.profile_id)::text not in ('owner', 'admin'), true) then
		raise exception 'Only owners and admins change a Google mailbox' using errcode = '42501'; end if;
	if p_paused is null then
		raise exception 'A Google mailbox is paused or not' using errcode = '22023'; end if;
	update public.qorpera_google_mailboxes
	set paused = p_paused,
		due_at = case when p_paused or state = 'sign_in_again' then null else clock_timestamp() end,
		lease_id = case when p_paused then null else lease_id end,
		lease_until = case when p_paused then null else lease_until end,
		updated_at = clock_timestamp()
	where mailbox_id = v_google.mailbox_id
	returning * into v_google;
	return jsonb_build_object('hookId', v_google.hook_id, 'address', v_google.address,
		'state', public.qorpera_google_mailbox_state(v_google));
end
$$;
revoke all on function public.qorpera_pause_google_mailbox(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_pause_google_mailbox(uuid, boolean) to authenticated;

create function public.qorpera_describe_google_mailbox_ticket(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capture_capability_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_mark public.qorpera_google_mailbox_tickets%rowtype;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	select mark.* into v_mark
	from public.qorpera_google_mailbox_tickets as mark
	join public.qorpera_cloud_secret_capture_tickets as ticket on ticket.id = mark.ticket_id
	where mark.ticket_id = p_ticket_id and ticket.broker_authority_id = v_authority.id
		and ticket.capture_capability_sha256 = p_capture_capability_sha256 and ticket.status = 'pending'
		and ticket.expires_at > clock_timestamp();
	if v_mark.ticket_id is null then return null; end if;
	return jsonb_build_object('schema', 'qorpera.google-mailbox-ticket/v1', 'mailboxId', v_mark.mailbox_id,
		'address', public.qorpera_google_mailbox_address(v_mark.mailbox_id));
end
$$;
revoke all on function public.qorpera_describe_google_mailbox_ticket(uuid, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_describe_google_mailbox_ticket(uuid, text, uuid, text) to qorpera_secret_broker;

create function public.qorpera_complete_google_mailbox_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capture_capability_sha256 text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_address text
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_ticket public.qorpera_cloud_secret_capture_tickets%rowtype;
	v_mark public.qorpera_google_mailbox_tickets%rowtype;
	v_address text := lower(btrim(coalesce(p_address, '')));
	v_google public.qorpera_google_mailboxes%rowtype;
	v_waiting text;
	v_reused uuid;
	v_removed public.qorpera_google_mailboxes%rowtype;
	v_secret_id uuid;
	v_old_secret uuid;
	v_domain text;
	v_hook public.qorpera_event_hooks%rowtype;
	v_mailbox_id uuid;
	v_outcome text;
	v_refusal jsonb;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if char_length(v_address) > 254
		or v_address !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then
		raise exception 'The Google address is invalid' using errcode = '22023'; end if;
	select ticket.* into v_ticket from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id and ticket.broker_authority_id = v_authority.id
		and ticket.capture_capability_sha256 = p_capture_capability_sha256;
	select mark.* into v_mark from public.qorpera_google_mailbox_tickets as mark where mark.ticket_id = v_ticket.id;
	if v_ticket.id is null or v_mark.ticket_id is null or v_ticket.status <> 'pending'
		or v_ticket.expires_at <= clock_timestamp() or v_ticket.connector_id <> 'gmail'
		or v_ticket.owner_kind <> 'company' then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_ticket.profile_id) then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-google-mailbox:' || v_address, 0));
	if exists (select 1 from public.qorpera_google_mailboxes as other
		where other.address = v_address and other.removed_at is null
			and (other.profile_id <> v_ticket.profile_id or other.environment_id <> v_ticket.environment_id)) then
		return jsonb_build_object('schema', 'qorpera.google-mailbox-refused/v1', 'reason', 'address_taken',
			'message', 'This address is already brought in by another company.');
	end if;
	if v_mark.mailbox_id is not null then
		select google.* into v_google from public.qorpera_google_mailboxes as google
		where google.mailbox_id = v_mark.mailbox_id and google.removed_at is null;
		if v_google.mailbox_id is null then
			raise exception 'cloud secret capture is unavailable' using errcode = '42501'; end if;
		if v_google.address <> v_address then
			v_refusal := jsonb_build_object('schema', 'qorpera.google-mailbox-refused/v1', 'reason', 'wrong_account',
				'address', v_google.address, 'message', format('Sign in with %s.', v_google.address));
		end if;
	else
		select google.* into v_google from public.qorpera_google_mailboxes as google
		where google.environment_id = v_ticket.environment_id and google.address = v_address
			and google.removed_at is null;
		if v_google.mailbox_id is null then
			select google.address into v_waiting from public.qorpera_google_mailboxes as google
			where google.environment_id = v_ticket.environment_id and google.removed_at is null
				and google.state = 'sign_in_again'
			order by google.created_at, google.mailbox_id limit 1;
			if v_waiting is not null then
				v_refusal := jsonb_build_object('schema', 'qorpera.google-mailbox-refused/v1', 'reason', 'wrong_account',
					'address', v_waiting, 'message', format('Sign in with %s.', v_waiting));
			end if;
		end if;
	end if;
	if v_refusal is not null then return v_refusal; end if;
	if v_google.mailbox_id is null then
		select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
		if v_domain is null then
			raise exception 'Company mail is not set up yet' using errcode = '0A000'; end if;
		if public.qorpera_environment_is_folder_v2(v_ticket.environment_id) then
			perform public.qorpera_folder_company_enter(v_ticket.environment_id, v_ticket.profile_id, '[]'::jsonb, false);
			perform pg_advisory_xact_lock(hashtextextended('qorpera.event-hooks:' || v_ticket.profile_id::text, 0));
		else
			perform 1 from public.qorpera_profiles as profile where profile.id = v_ticket.profile_id for no key update;
		end if;
		if (select count(*) from public.qorpera_company_mailboxes as mailbox
			where mailbox.profile_id = v_ticket.profile_id and mailbox.removed_at is null) >= 20 then
			raise exception 'A company has at most 20 mailboxes' using errcode = '54000'; end if;
		if (select count(*) from public.qorpera_event_hooks as hook
			where hook.profile_id = v_ticket.profile_id and hook.status <> 'removed') >= 50 then
			raise exception 'A company has at most 50 hooks' using errcode = '54000'; end if;
		select secret.id into v_reused from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_ticket.profile_id and secret.environment_id = v_ticket.environment_id
			and secret.owner_kind = 'company' and secret.connector_id = 'gmail' and secret.status = 'active'
			and secret.id <> v_ticket.secret_id and lower(secret.account_label) = v_address
		order by secret.created_at, secret.id limit 1;
		select google.* into v_removed from public.qorpera_google_mailboxes as google
		where google.profile_id = v_ticket.profile_id and google.environment_id = v_ticket.environment_id
			and google.address = v_address and google.removed_at is not null
		order by google.removed_at desc, google.mailbox_id limit 1
		for update;
	end if;
	if v_reused is not null then
		update public.qorpera_cloud_secret_capture_tickets set status = 'cancelled' where id = v_ticket.id;
		v_secret_id := v_reused;
		v_outcome := 'linked';
	else
		perform set_config('qorpera.google_mailbox_capture', v_ticket.id::text, true);
		perform public.qorpera_complete_cloud_secret_capture(p_broker_authority_id, p_broker_capability_sha256, p_ticket_id,
			p_capture_capability_sha256, p_encrypted_envelope_base64, p_envelope_sha256, v_address);
		perform set_config('qorpera.google_mailbox_capture', '', true);
		v_secret_id := v_ticket.secret_id;
	end if;
	if v_google.mailbox_id is not null then
		v_old_secret := v_google.secret_id;
		update public.qorpera_google_mailboxes
		set secret_id = v_secret_id,
			state = case when state = 'sign_in_again' then case when imported_at is null then 'bringing_in' else 'live' end
				else state end,
			due_at = case when paused then null else clock_timestamp() end,
			lease_id = null, lease_until = null, attempts = 0, last_error = null, updated_at = clock_timestamp()
		where mailbox_id = v_google.mailbox_id;
		if v_old_secret <> v_secret_id then
			perform public.qorpera_google_mailbox_end_sign_in(v_old_secret, v_ticket.created_by_user_id);
		end if;
		v_mailbox_id := v_google.mailbox_id;
		v_outcome := 'relinked';
	elsif v_removed.mailbox_id is not null then
		update public.qorpera_event_hooks set status = 'active', removed_at = null, updated_at = statement_timestamp()
		where id = v_removed.hook_id;
		update public.qorpera_company_mailboxes set removed_at = null where id = v_removed.mailbox_id;
		update public.qorpera_google_mailboxes
		set removed_at = null, secret_id = v_secret_id, state = 'bringing_in', paused = false,
			history_id = null, page_token = null, import_count = 0, gap = true,
			resume_pending = case when gap then resume_pending else imported_at is null end,
			resume_page_token = case when gap then resume_page_token when imported_at is null then page_token end,
			resume_count = case when gap then resume_count when imported_at is null then import_count end,
			imported_at = null, due_at = clock_timestamp(),
			lease_id = null, lease_until = null, attempts = 0, last_error = null, updated_at = clock_timestamp()
		where mailbox_id = v_removed.mailbox_id;
		v_mailbox_id := v_removed.mailbox_id;
		v_outcome := coalesce(v_outcome, 'relinked');
	else
		insert into public.qorpera_event_hooks (
			profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_user_id
		) values (
			v_ticket.profile_id, v_ticket.environment_id,
			'mail-google-' || left(encode(extensions.digest(v_address, 'sha256'), 'hex'), 12),
			left('Google mail for ' || v_address, 512), 'mail',
			translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
			262144, 120, v_ticket.created_by_user_id
		) returning * into v_hook;
		insert into public.qorpera_company_mailboxes (hook_id, profile_id, environment_id, local_part, created_by_user_id)
		values (v_hook.id, v_ticket.profile_id, v_ticket.environment_id,
			'google_' || encode(extensions.gen_random_bytes(12), 'hex'), v_ticket.created_by_user_id)
		returning id into v_mailbox_id;
		insert into public.qorpera_google_mailboxes (mailbox_id, hook_id, profile_id, environment_id, address, secret_id,
			state, due_at, created_by_user_id)
		values (v_mailbox_id, v_hook.id, v_ticket.profile_id, v_ticket.environment_id, v_address, v_secret_id,
			'bringing_in', clock_timestamp(), v_ticket.created_by_user_id);
		v_outcome := coalesce(v_outcome, 'created');
	end if;
	return jsonb_build_object('schema', 'qorpera.google-mailbox-connected/v1', 'outcome', v_outcome,
		'mailboxId', v_mailbox_id, 'address', v_address, 'secretId', v_secret_id);
end
$$;
revoke all on function public.qorpera_complete_google_mailbox_capture(uuid, text, uuid, text, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_google_mailbox_capture(uuid, text, uuid, text, text, text, text)
	to qorpera_secret_broker;

create function public.qorpera_claim_google_mailbox(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_row record;
	v_now timestamptz := clock_timestamp();
	v_lease uuid := extensions.gen_random_uuid();
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	loop
		select google.mailbox_id, google.environment_id, google.address, google.state, google.secret_id,
			google.history_id, google.page_token, google.brought_in, google.total, google.import_count, google.gap,
			secret.status as secret_status, secret.current_version, version.key_id, version.encrypted_envelope,
			version.envelope_sha256, version.broker_authority_id as sealed_for, hook.status as hook_status
		into v_row
		from public.qorpera_google_mailboxes as google
		join public.qorpera_event_hooks as hook on hook.id = google.hook_id
		left join public.qorpera_cloud_secrets as secret on secret.id = google.secret_id
		left join public.qorpera_cloud_secret_versions as version
			on version.secret_id = secret.id and version.version = secret.current_version
		where google.profile_id = v_authority.profile_id and google.removed_at is null and not google.paused
			and google.state in ('bringing_in', 'live') and google.due_at <= v_now
			and (google.lease_until is null or google.lease_until <= v_now)
		order by google.due_at, google.mailbox_id
		limit 1
		for update of google skip locked;
		if not found then return null; end if;
		if v_row.secret_status is distinct from 'active' or v_row.encrypted_envelope is null
			or v_row.sealed_for is distinct from v_authority.id then
			update public.qorpera_google_mailboxes
			set state = 'sign_in_again', due_at = null, last_error = 'The Google sign-in is no longer held',
				updated_at = v_now
			where mailbox_id = v_row.mailbox_id;
			continue;
		end if;
		if v_row.hook_status <> 'active' then
			update public.qorpera_google_mailboxes set due_at = v_now + interval '5 minutes', updated_at = v_now
			where mailbox_id = v_row.mailbox_id;
			continue;
		end if;
		update public.qorpera_google_mailboxes
		set lease_id = v_lease, lease_until = v_now + interval '5 minutes', attempts = attempts + 1, updated_at = v_now
		where mailbox_id = v_row.mailbox_id;
		return jsonb_build_object(
			'schema', 'qorpera.google-mailbox-claim/v1',
			'companyId', v_authority.profile_id, 'environmentId', v_row.environment_id, 'mailboxId', v_row.mailbox_id,
			'address', v_row.address, 'state', v_row.state, 'lease', v_lease,
			'secretId', v_row.secret_id, 'secretVersion', v_row.current_version, 'keyId', v_row.key_id,
			'encryptedEnvelopeBase64', translate(encode(v_row.encrypted_envelope, 'base64'), E'\n', ''),
			'envelopeSha256', v_row.envelope_sha256,
			'historyId', v_row.history_id, 'pageToken', v_row.page_token, 'broughtIn', v_row.brought_in,
			'total', v_row.total, 'importCount', v_row.import_count, 'gap', v_row.gap);
	end loop;
end
$$;
revoke all on function public.qorpera_claim_google_mailbox(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_google_mailbox(uuid, text) to qorpera_secret_broker;

create function public.qorpera_google_mail_known_among(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mailbox_id uuid,
	p_lease_id uuid,
	p_gmail_ids jsonb
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_known jsonb;
	v_stops jsonb;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if jsonb_typeof(p_gmail_ids) is distinct from 'array' or jsonb_array_length(p_gmail_ids) > 500
		or exists (select 1 from jsonb_array_elements(p_gmail_ids) as item(value)
			where jsonb_typeof(item.value) <> 'string' or item.value #>> '{}' !~ '^[A-Za-z0-9_-]{1,64}$') then
		raise exception 'Gmail message ids are invalid' using errcode = '22023'; end if;
	v_google := public.qorpera_google_mailbox_leased(v_authority.profile_id, p_mailbox_id, p_lease_id);
	select coalesce(jsonb_agg(known.gmail_id order by known.gmail_id), '[]'::jsonb),
		coalesce(jsonb_agg(known.gmail_id order by known.gmail_id) filter (where not known.gap), '[]'::jsonb)
	into v_known, v_stops
	from public.qorpera_google_mail_messages as known
	where known.profile_id = v_google.profile_id and known.address = v_google.address
		and known.gmail_id in (select item.value #>> '{}' from jsonb_array_elements(p_gmail_ids) as item(value));
	return jsonb_build_object('schema', 'qorpera.google-mail-known/v1', 'known', v_known, 'stops', v_stops);
end
$$;
revoke all on function public.qorpera_google_mail_known_among(uuid, text, uuid, uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_google_mail_known_among(uuid, text, uuid, uuid, jsonb) to qorpera_secret_broker;

create function public.qorpera_bring_in_google_mail(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mailbox_id uuid,
	p_lease_id uuid,
	p_gmail_id text,
	p_gmail_thread_id text,
	p_imported boolean,
	p_received_at timestamptz,
	p_message text
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_email_id text;
	v_domain text;
	v_result jsonb;
	v_item jsonb;
	v_delivery_id uuid;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_gmail_id is null or p_gmail_id !~ '^[A-Za-z0-9_-]{1,64}$'
		or (p_gmail_thread_id is not null and p_gmail_thread_id !~ '^[A-Za-z0-9_-]{1,64}$')
		or p_imported is null or p_received_at is null or p_message is null then
		raise exception 'The message is malformed' using errcode = '22023'; end if;
	v_google := public.qorpera_google_mailbox_leased(v_authority.profile_id, p_mailbox_id, p_lease_id);
	if exists (select 1 from public.qorpera_google_mail_messages as known
		where known.profile_id = v_google.profile_id and known.address = v_google.address
			and known.gmail_id = p_gmail_id) then
		return jsonb_build_object('schema', 'qorpera.google-mail-brought-in/v1', 'outcome', 'duplicate');
	end if;
	if p_imported and v_google.state = 'bringing_in' and v_google.import_count >= 50000 then
		return jsonb_build_object('schema', 'qorpera.google-mail-brought-in/v1', 'outcome', 'bounded');
	end if;
	v_email_id := public.qorpera_google_mail_email_id(v_google.profile_id, v_google.address, p_gmail_id);
	begin
		if (p_message::jsonb ->> 'emailId') is distinct from v_email_id then
			raise exception 'The message is malformed' using errcode = '22023'; end if;
	exception when invalid_text_representation then
		raise exception 'The message is malformed' using errcode = '22023';
	end;
	select settings.domain into v_domain from public.qorpera_mail_settings as settings;
	perform set_config('qorpera.google_mail_door', jsonb_build_object('mailboxId', v_google.mailbox_id,
		'imported', p_imported, 'receivedAt', p_received_at)::text, true);
	v_result := public.qorpera_receive_mail(v_email_id, array[(select mailbox.local_part from public.qorpera_company_mailboxes
		as mailbox where mailbox.id = v_google.mailbox_id) || '@' || coalesce(v_domain, 'invalid')], p_message);
	perform set_config('qorpera.google_mail_door', '', true);
	if v_result ->> 'outcome' is distinct from 'settled' then
		return jsonb_build_object('schema', 'qorpera.google-mail-brought-in/v1', 'outcome', 'unavailable');
	end if;
	v_item := v_result -> 'results' -> 0;
	if v_item ->> 'outcome' = 'accepted' then
		v_delivery_id := (v_item ->> 'deliveryId')::uuid;
	elsif v_item ->> 'outcome' = 'duplicate' then
		select delivery.id into v_delivery_id from public.qorpera_event_deliveries as delivery
		where delivery.hook_id = v_google.hook_id and delivery.status = 'verified'
			and delivery.delivery_key = 'mail:' || v_email_id;
	else
		return jsonb_build_object('schema', 'qorpera.google-mail-brought-in/v1',
			'outcome', coalesce(v_item ->> 'outcome', 'unavailable'))
			|| case when v_item ? 'retryAfterSeconds' then jsonb_build_object('retryAfterSeconds', v_item -> 'retryAfterSeconds')
				else '{}'::jsonb end;
	end if;
	insert into public.qorpera_google_mail_messages (profile_id, address, gmail_id, mailbox_id, gmail_thread_id, delivery_id,
		imported, gap)
	values (v_google.profile_id, v_google.address, p_gmail_id, v_google.mailbox_id, p_gmail_thread_id, v_delivery_id,
		p_imported, p_imported and v_google.gap and v_google.state = 'bringing_in')
	on conflict do nothing;
	if p_imported and v_google.state = 'bringing_in' and v_item ->> 'outcome' = 'accepted' then
		update public.qorpera_google_mailboxes
		set brought_in = brought_in + 1, import_count = import_count + 1,
			total = case when total is null then null else greatest(total, brought_in + 1) end,
			updated_at = clock_timestamp()
		where mailbox_id = v_google.mailbox_id;
	end if;
	return jsonb_build_object('schema', 'qorpera.google-mail-brought-in/v1', 'outcome', v_item ->> 'outcome',
		'deliveryId', v_delivery_id);
end
$$;
revoke all on function public.qorpera_bring_in_google_mail(uuid, text, uuid, uuid, text, text, boolean, timestamptz, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_bring_in_google_mail(uuid, text, uuid, uuid, text, text, boolean, timestamptz, text)
	to qorpera_secret_broker;

create function public.qorpera_finish_google_mailbox_pass(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mailbox_id uuid,
	p_lease_id uuid,
	p_outcome text,
	p_history_id text,
	p_page_token text,
	p_total integer,
	p_capped boolean,
	p_error text
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_now timestamptz := clock_timestamp();
	v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_outcome is null or p_outcome not in ('importing', 'imported', 'current', 'limited', 'failed', 'refused')
		or (p_outcome in ('failed', 'refused')) <> (v_error is not null)
		or (p_history_id is not null and p_history_id !~ '^[0-9]{1,20}$')
		or (p_page_token is not null and (char_length(p_page_token) > 512 or p_page_token !~ '^[\x21-\x7e]+$'))
		or (p_outcome <> 'importing' and p_page_token is not null)
		or (p_total is not null and p_total < 0)
		or p_capped is null or (p_capped and p_outcome <> 'imported') then
		raise exception 'Google mailbox pass answer is invalid' using errcode = '22023'; end if;
	v_google := public.qorpera_google_mailbox_leased(v_authority.profile_id, p_mailbox_id, p_lease_id);
	if (p_outcome in ('importing', 'imported') and v_google.state <> 'bringing_in')
		or (p_outcome = 'current' and v_google.state <> 'live')
		or (p_outcome in ('imported', 'current') and coalesce(p_history_id, v_google.history_id) is null) then
		raise exception 'Google mailbox pass answer is invalid' using errcode = '22023'; end if;
	update public.qorpera_google_mailboxes
	set state = case p_outcome when 'imported' then case when gap and resume_pending then 'bringing_in' else 'live' end
			when 'refused' then 'sign_in_again' else state end,
		imported_at = case when p_outcome = 'imported' and not (gap and resume_pending) then v_now else imported_at end,
		gap = case when p_outcome = 'imported' then false else gap end,
		capped = case when p_outcome = 'imported' and not gap then p_capped else capped end,
		history_id = coalesce(p_history_id, history_id),
		page_token = case p_outcome when 'importing' then p_page_token
			when 'imported' then case when gap and resume_pending then resume_page_token end else page_token end,
		import_count = case when p_outcome = 'imported' and gap and resume_pending then resume_count else import_count end,
		resume_pending = case when p_outcome = 'imported' and gap then false else resume_pending end,
		resume_page_token = case when p_outcome = 'imported' and gap then null else resume_page_token end,
		resume_count = case when p_outcome = 'imported' and gap then null else resume_count end,
		total = case when coalesce(p_total, total) is null then null
			else greatest(coalesce(p_total, total), brought_in) end,
		due_at = case p_outcome
			when 'importing' then v_now
			when 'imported' then v_now
			when 'current' then v_now + interval '1 minute'
			when 'limited' then v_now + interval '1 minute'
			when 'failed' then v_now + least(interval '1 minute' * power(2, least(greatest(v_google.attempts - 1, 0), 7)),
				interval '2 hours')
		end,
		lease_id = null,
		lease_until = null,
		attempts = case when p_outcome = 'failed' then attempts else 0 end,
		last_error = v_error,
		checked_at = case when p_outcome in ('importing', 'imported', 'current') then v_now else checked_at end,
		updated_at = v_now
	where mailbox_id = v_google.mailbox_id
	returning * into v_google;
	return jsonb_build_object('schema', 'qorpera.google-mailbox-pass/v1',
		'state', public.qorpera_google_mailbox_state(v_google), 'dueAt', v_google.due_at);
end
$$;
revoke all on function public.qorpera_finish_google_mailbox_pass(uuid, text, uuid, uuid, text, text, text, integer, boolean, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_finish_google_mailbox_pass(uuid, text, uuid, uuid, text, text, text, integer, boolean, text)
	to qorpera_secret_broker;

create function public.qorpera_google_mail_thread(p_mail_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select coalesce(
		(select known.gmail_thread_id from public.qorpera_google_mail_messages as known
			where p_mail.in_reply_to_delivery_id is not null and known.delivery_id = p_mail.in_reply_to_delivery_id
				and known.gmail_thread_id is not null limit 1),
		(select known.gmail_thread_id from public.qorpera_mail_received as received
			join public.qorpera_google_mail_messages as known on known.delivery_id = received.delivery_id
			where p_mail.in_reply_to is not null and received.mailbox_id = p_mail.mailbox_id
				and received.message_id = p_mail.in_reply_to and known.gmail_thread_id is not null
			order by received.received_at desc limit 1),
		(select known.gmail_thread_id from public.qorpera_company_mail_outbox as sent
			join public.qorpera_google_mail_messages as known on known.mail_id = sent.id
			where p_mail.in_reply_to is not null and sent.mailbox_id = p_mail.mailbox_id
				and sent.message_id = p_mail.in_reply_to and known.gmail_thread_id is not null
			order by sent.created_at desc limit 1),
		(select known.gmail_thread_id from public.qorpera_mail_received as received
			join public.qorpera_google_mail_messages as known on known.delivery_id = received.delivery_id
			where received.thread_id = p_mail.thread and received.mailbox_id = p_mail.mailbox_id
				and known.gmail_thread_id is not null
			order by received.received_at desc limit 1))
	from public.qorpera_company_mail_outbox as p_mail where p_mail.id = p_mail_id
$$;
revoke all on function public.qorpera_google_mail_thread(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_claim_google_mail_sends(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_limit integer
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_now timestamptz := clock_timestamp();
	v_lease uuid := extensions.gen_random_uuid();
	v_result jsonb;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_limit is null or p_limit not between 1 and 10 then
		raise exception 'Google mail claim is invalid' using errcode = '22023'; end if;
	if not exists (select 1 from public.qorpera_mail_settings as settings where settings.enabled and settings.sending) then
		return jsonb_build_object('schema', 'qorpera.google-mail-sends/v1', 'sends', '[]'::jsonb);
	end if;
	with candidates as (
		select mail.id
		from public.qorpera_company_mail_outbox as mail
		join public.qorpera_google_mailboxes as google on google.mailbox_id = mail.mailbox_id and google.removed_at is null
			and google.state <> 'sign_in_again'
		join public.qorpera_cloud_secrets as secret on secret.id = google.secret_id and secret.status = 'active'
		join public.qorpera_cloud_secret_versions as version
			on version.secret_id = secret.id and version.version = secret.current_version
				and version.broker_authority_id = v_authority.id
		where mail.profile_id = v_authority.profile_id and mail.route = 'gmail'
			and mail.status in ('pending', 'retrying', 'delivering') and mail.next_attempt_at <= v_now
			and (mail.lease_expires_at is null or mail.lease_expires_at <= v_now)
			and mail.created_at > v_now - interval '1 day' and mail.attempt_count < 8
		order by mail.next_attempt_at, mail.created_at, mail.id
		for update of mail skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_company_mail_outbox as mail
		set status = 'delivering', attempt_count = mail.attempt_count + 1, lease_id = v_lease,
			lease_expires_at = v_now + interval '5 minutes'
		from candidates
		where mail.id = candidates.id
		returning mail.*
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'mailId', claimed.id, 'leaseId', claimed.lease_id, 'attemptCount', claimed.attempt_count,
		'mailboxId', claimed.mailbox_id, 'address', google.address,
		'fromName', claimed.from_name, 'to', to_jsonb(claimed.recipients_to), 'cc', to_jsonb(claimed.recipients_cc),
		'subject', claimed.subject, 'text', claimed.body,
		'headers', jsonb_strip_nulls(jsonb_build_object('In-Reply-To', claimed.in_reply_to,
			'References', claimed.thread_references,
			'Auto-Submitted', case when claimed.in_reply_to_delivery_id is not null then 'auto-replied' end)),
		'gmailThreadId', public.qorpera_google_mail_thread(claimed.id),
		'draftId', claimed.gmail_draft_id, 'draftMessageId', claimed.gmail_draft_message_id,
		'companyId', secret.profile_id, 'environmentId', secret.environment_id, 'secretId', secret.id, 'secretVersion', secret.current_version, 'keyId', version.key_id,
		'encryptedEnvelopeBase64', translate(encode(version.encrypted_envelope, 'base64'), E'\n', ''),
		'envelopeSha256', version.envelope_sha256
	) order by claimed.created_at, claimed.id), '[]'::jsonb) into v_result
	from claimed
	join public.qorpera_google_mailboxes as google on google.mailbox_id = claimed.mailbox_id
	join public.qorpera_cloud_secrets as secret on secret.id = google.secret_id
	join public.qorpera_cloud_secret_versions as version
		on version.secret_id = secret.id and version.version = secret.current_version;
	return jsonb_build_object('schema', 'qorpera.google-mail-sends/v1', 'sends', v_result);
end
$$;
revoke all on function public.qorpera_claim_google_mail_sends(uuid, text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_google_mail_sends(uuid, text, integer) to qorpera_secret_broker;

create function public.qorpera_record_google_mail_draft(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mail_id uuid,
	p_lease_id uuid,
	p_draft_id text,
	p_draft_message_id text
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_mail public.qorpera_company_mail_outbox%rowtype;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_draft_id is null or p_draft_id !~ '^[A-Za-z0-9_-]{1,64}$'
		or p_draft_message_id is null or p_draft_message_id !~ '^[A-Za-z0-9_-]{1,64}$' then
		raise exception 'Google mail draft is invalid' using errcode = '22023'; end if;
	update public.qorpera_company_mail_outbox
	set gmail_draft_id = p_draft_id, gmail_draft_message_id = p_draft_message_id
	where id = p_mail_id and lease_id = p_lease_id and status = 'delivering' and route = 'gmail'
		and profile_id = v_authority.profile_id and gmail_draft_id is null
	returning * into v_mail;
	return jsonb_build_object('schema', 'qorpera.google-mail-draft/v1', 'recorded', v_mail.id is not null);
end
$$;
revoke all on function public.qorpera_record_google_mail_draft(uuid, text, uuid, uuid, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_google_mail_draft(uuid, text, uuid, uuid, text, text)
	to qorpera_secret_broker;

create function public.qorpera_complete_google_mail_send(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mail_id uuid,
	p_lease_id uuid,
	p_gmail_id text,
	p_gmail_thread_id text,
	p_message_id text
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_mail public.qorpera_company_mail_outbox%rowtype;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_gmail_id is null or p_gmail_id !~ '^[A-Za-z0-9_-]{1,64}$'
		or (p_gmail_thread_id is not null and p_gmail_thread_id !~ '^[A-Za-z0-9_-]{1,64}$') then
		raise exception 'Google mail send answer is invalid' using errcode = '22023'; end if;
	update public.qorpera_company_mail_outbox
	set status = 'sent', settled_at = clock_timestamp(), provider_message_id = 'gmail:' || p_gmail_id,
		message_id = case when char_length(p_message_id) <= 998 and p_message_id ~ '^<[^<>[:space:][:cntrl:]]+>$'
			then p_message_id end,
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_mail_id and lease_id = p_lease_id and status = 'delivering' and route = 'gmail'
		and profile_id = v_authority.profile_id
	returning * into v_mail;
	if v_mail.id is null then
		return jsonb_build_object('schema', 'qorpera.google-mail-send/v1', 'completed', false); end if;
	insert into public.qorpera_google_mail_messages (profile_id, address, gmail_id, mailbox_id, gmail_thread_id, mail_id)
	values (v_mail.profile_id, v_mail.from_address, p_gmail_id, v_mail.mailbox_id, p_gmail_thread_id, v_mail.id)
	on conflict do nothing;
	return jsonb_build_object('schema', 'qorpera.google-mail-send/v1', 'completed', true);
end
$$;
revoke all on function public.qorpera_complete_google_mail_send(uuid, text, uuid, uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_google_mail_send(uuid, text, uuid, uuid, text, text, text)
	to qorpera_secret_broker;

create function public.qorpera_fail_google_mail_send(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mail_id uuid,
	p_lease_id uuid,
	p_error text,
	p_retryable boolean,
	p_refused boolean
)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_mail public.qorpera_company_mail_outbox%rowtype;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_retryable is null or p_refused is null then
		raise exception 'Google mail send answer is invalid' using errcode = '22023'; end if;
	update public.qorpera_company_mail_outbox
	set status = case when (p_retryable or p_refused) and attempt_count < 8 then 'retrying' else 'failed' end,
		settled_at = case when (p_retryable or p_refused) and attempt_count < 8 then null else clock_timestamp() end,
		next_attempt_at = clock_timestamp()
			+ least(interval '1 hour', interval '1 minute' * power(2, greatest(attempt_count - 1, 0))),
		last_error = case when p_refused then 'Google asked you to sign in again.'
			else left(coalesce(nullif(btrim(p_error), ''), 'Google did not send the email'), 1000) end,
		lease_id = null, lease_expires_at = null
	where id = p_mail_id and lease_id = p_lease_id and status = 'delivering' and route = 'gmail'
		and profile_id = v_authority.profile_id
	returning * into v_mail;
	if v_mail.id is null then
		return jsonb_build_object('schema', 'qorpera.google-mail-send/v1', 'completed', false); end if;
	if p_refused then
		update public.qorpera_google_mailboxes
		set state = 'sign_in_again', due_at = null, lease_id = null, lease_until = null,
			last_error = 'Google asked you to sign in again.', updated_at = clock_timestamp()
		where mailbox_id = v_mail.mailbox_id and removed_at is null;
	end if;
	return jsonb_build_object('schema', 'qorpera.google-mail-send/v1', 'completed', true, 'status', v_mail.status);
end
$$;
revoke all on function public.qorpera_fail_google_mail_send(uuid, text, uuid, uuid, text, boolean, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_fail_google_mail_send(uuid, text, uuid, uuid, text, boolean, boolean)
	to qorpera_secret_broker;

create function public.qorpera_broker_principal_google_mailboxes_due(p_principal_id uuid, p_capability_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_due jsonb;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	select coalesce(jsonb_agg(due.profile_id order by due.profile_id), '[]'::jsonb) into v_due
	from (
		select distinct waiting.profile_id from (
			select google.profile_id from public.qorpera_google_mailboxes as google
			where google.removed_at is null and not google.paused and google.state in ('bringing_in', 'live')
				and google.due_at <= clock_timestamp()
				and (google.lease_until is null or google.lease_until <= clock_timestamp())
			union all
			select mail.profile_id from public.qorpera_company_mail_outbox as mail
			where mail.route = 'gmail' and mail.status in ('pending', 'retrying', 'delivering')
				and exists (select 1 from public.qorpera_mail_settings as settings where settings.enabled and settings.sending)
				and mail.next_attempt_at <= clock_timestamp()
				and (mail.lease_expires_at is null or mail.lease_expires_at <= clock_timestamp())
		) as waiting
		join public.qorpera_cloud_secret_broker_authorities as authority
			on authority.profile_id = waiting.profile_id and authority.principal_id = v_principal.id
				and authority.status = 'active'
		limit 1000
	) as due;
	return jsonb_build_object('schema', 'qorpera.broker-principal-google-mailboxes/v1', 'companyIds', v_due);
end
$$;
revoke all on function public.qorpera_broker_principal_google_mailboxes_due(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_broker_principal_google_mailboxes_due(uuid, text) to qorpera_secret_broker;

create or replace function public.qorpera_member_mail_addresses(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id); v_domain text; v_result jsonb;
begin
	select settings.domain into v_domain from public.qorpera_mail_settings as settings where settings.enabled;
	if v_domain is null then return '[]'::jsonb; end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'address', public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, v_domain), 'hookId', mailbox.hook_id,
		'status', hook.status,
		'kind', case when google.mailbox_id is null then 'qorpera' else 'google' end,
		'handledBy', coalesce((select jsonb_agg(public.qorpera_member_mail_agent(v_profile_id, listening.staff_agent_id)
			order by listening.staff_agent_id) from (select distinct version.staff_agent_id
				from public.qorpera_event_listener_cursors as cursor
				join public.qorpera_cloud_routines as routine on routine.id = cursor.routine_id
				join public.qorpera_cloud_routine_versions as version
					on version.routine_id = routine.id and version.version = routine.current_version
				where cursor.hook_id = mailbox.hook_id and cursor.active and routine.status = 'active') as listening),
			'[]'::jsonb),
		'routines', coalesce((select jsonb_agg(jsonb_build_object('routineId', routine.id, 'title', version.title,
				'staffAgentId', version.staff_agent_id) order by version.title, routine.id)
			from public.qorpera_event_listener_cursors as cursor
			join public.qorpera_cloud_routines as routine on routine.id = cursor.routine_id
			join public.qorpera_cloud_routine_versions as version
				on version.routine_id = routine.id and version.version = routine.current_version
			where cursor.hook_id = mailbox.hook_id and cursor.active and routine.status = 'active'), '[]'::jsonb),
		'last7Days', case when google.mailbox_id is null then (select count(*) from (select 1
				from public.qorpera_event_deliveries as delivery
				where delivery.hook_id = mailbox.hook_id and delivery.status = 'verified'
					and delivery.event_type = 'mail.received' and delivery.received_at > clock_timestamp() - interval '7 days'
				limit 10000) as recent)
			else (select count(*) from (select 1 from public.qorpera_mail_received as received
				where received.mailbox_id = mailbox.id and received.received_at > clock_timestamp() - interval '7 days'
				limit 10000) as recent) end
	) || case when google.mailbox_id is null then '{}'::jsonb else jsonb_build_object('google', jsonb_build_object(
		'state', public.qorpera_google_mailbox_state(google),
		'broughtIn', google.brought_in,
		'total', google.total,
		'capped', google.capped,
		'lastWeek', (select count(*) from (select 1 from public.qorpera_mail_received as received
			where received.mailbox_id = mailbox.id and received.received_at > clock_timestamp() - interval '7 days'
			limit 10000) as recent))) end
	order by public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, v_domain)), '[]'::jsonb) into v_result
	from public.qorpera_company_mailboxes as mailbox
	join public.qorpera_event_hooks as hook on hook.id = mailbox.hook_id
	left join public.qorpera_google_mailboxes as google on google.mailbox_id = mailbox.id
	where mailbox.environment_id = p_environment_id and mailbox.profile_id = v_profile_id and mailbox.removed_at is null;
	return v_result;
end
$$;

select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$	v_headers jsonb;
begin$old$,
	$new$	v_headers jsonb;
	v_google jsonb := public.qorpera_google_mail_door();
	v_imported boolean := coalesce((public.qorpera_google_mail_door() ->> 'imported')::boolean, false);
	v_at timestamptz := case when coalesce((public.qorpera_google_mail_door() ->> 'imported')::boolean, false)
		then (public.qorpera_google_mail_door() ->> 'receivedAt')::timestamptz end;
begin$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		if v_hook.id is null or v_hook.status = 'removed' or v_hook.proof <> 'mail'
			or public.qorpera_company_deleting(v_hook.profile_id) then$old$,
	$new$		if v_hook.id is null or v_hook.status = 'removed' or v_hook.proof <> 'mail'
			or public.qorpera_company_deleting(v_hook.profile_id)
			or exists (select 1 from public.qorpera_google_mailboxes as google where google.mailbox_id = v_mailbox.id)
				<> coalesce(v_google ->> 'mailboxId' = v_mailbox.id::text, false) then$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		v_headers := public.qorpera_mail_delivery_headers(p_recipients, v_settings.domain, v_mailbox.local_part, v_parsed);$old$,
	$new$		v_headers := public.qorpera_mail_delivery_headers(p_recipients, v_settings.domain, v_mailbox.local_part, v_parsed);
		if v_google is not null then
			v_headers := v_headers || jsonb_build_object('delivered-to', public.qorpera_google_mailbox_address(v_mailbox.id));
		end if;$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		if (select count(*) from public.qorpera_event_deliveries as recent$old$,
	$new$		if not v_imported and (select count(*) from public.qorpera_event_deliveries as recent$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		if v_used_deliveries + 1 > v_intake.company_hourly_deliveries
			or v_used_bytes + octet_length(v_body) + octet_length(v_headers::text) > v_intake.company_hourly_bytes then$old$,
	$new$		if not v_imported and (v_used_deliveries + 1 > v_intake.company_hourly_deliveries
			or v_used_bytes + octet_length(v_body) + octet_length(v_headers::text) > v_intake.company_hourly_bytes) then$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$			id, hook_id, profile_id, status, delivery_key, event_type, content_type, headers,
			body, body_bytes, body_sha256, verified_at
		) values (
			v_delivery_id, v_hook.id, v_hook.profile_id, 'verified',$old$,
	$new$			id, hook_id, profile_id, received_at, status, delivery_key, event_type, content_type, headers,
			body, body_bytes, body_sha256, verified_at
		) values (
			v_delivery_id, v_hook.id, v_hook.profile_id, coalesce(v_at, clock_timestamp()), 'verified',$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		insert into public.qorpera_event_intake_usage as usage (profile_id, hour, deliveries, bytes)
		values (v_hook.profile_id, v_hour, 1, octet_length(v_body) + octet_length(v_headers::text))
		on conflict (profile_id, hour) do update
		set deliveries = usage.deliveries + 1, bytes = usage.bytes + excluded.bytes;$old$,
	$new$		if not v_imported then
			insert into public.qorpera_event_intake_usage as usage (profile_id, hour, deliveries, bytes)
			values (v_hook.profile_id, v_hour, 1, octet_length(v_body) + octet_length(v_headers::text))
			on conflict (profile_id, hour) do update
			set deliveries = usage.deliveries + 1, bytes = usage.bytes + excluded.bytes;
		end if;$new$);
select pg_temp.google_mailbox_patch('public.qorpera_receive_mail(text,text[],text)'::regprocedure,
	$old$		perform public.qorpera_mail_received_note(v_delivery_id, v_mailbox, clock_timestamp(), v_parsed,$old$,
	$new$		perform public.qorpera_mail_received_note(v_delivery_id, v_mailbox, coalesce(v_at, clock_timestamp()), v_parsed,$new$);

select pg_temp.google_mailbox_patch(
	'public.qorpera_event_listener_waiting(public.qorpera_event_listener_cursors,jsonb,integer)'::regprocedure,
	$old$			and not exists (select 1 from public.qorpera_event_wake_deliveries as taken$old$,
	$new$			and not exists (select 1 from public.qorpera_google_mail_messages as google
				where google.delivery_id = delivery.id and google.imported)
			and not exists (select 1 from public.qorpera_event_wake_deliveries as taken$new$);

select pg_temp.google_mailbox_patch('public.qorpera_purge_event_deliveries(integer)'::regprocedure,
	$old$		where delivery.received_at < v_now - interval '30 days'
$old$,
	$new$		where delivery.received_at < v_now - interval '30 days'
			and not exists (select 1 from public.qorpera_google_mailboxes as google
				where google.hook_id = delivery.hook_id)
$new$);
select pg_temp.google_mailbox_patch('public.qorpera_purge_event_deliveries(integer)'::regprocedure,
	$old$			and delivery.received_at < v_now - interval '7 days'
$old$,
	$new$			and delivery.received_at < v_now - interval '7 days'
			and not exists (select 1 from public.qorpera_google_mailboxes as google
				where google.hook_id = delivery.hook_id)
$new$);

select pg_temp.google_mailbox_patch('public.qorpera_purge_event_deliveries(integer)'::regprocedure,
	$old$		where removed.status = 'removed' and removed.removed_at < v_now - interval '30 days'
$old$,
	$new$		where removed.status = 'removed' and removed.removed_at < v_now - interval '30 days'
			and not exists (select 1 from public.qorpera_google_mailboxes as google where google.hook_id = removed.id)
$new$);

select pg_temp.google_mailbox_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	with doomed as materialized (
		select id from public.qorpera_mail_threads
		where last_at < v_now - interval '30 days'
		order by last_at, id
		limit 500
		for update skip locked
	)$old$,
	$new$	with doomed as materialized (
		select id from public.qorpera_mail_threads
		where last_at < v_now - interval '30 days'
			and not exists (select 1 from public.qorpera_google_mailboxes as google
				where google.mailbox_id = qorpera_mail_threads.mailbox_id)
		order by last_at, id
		limit 500
		for update skip locked
	)$new$);
select pg_temp.google_mailbox_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$		where mail.status in ('pending', 'retrying', 'delivering')
			and mail.next_attempt_at <= v_now$old$,
	$new$		where mail.status in ('pending', 'retrying', 'delivering') and mail.route = 'platform'
			and mail.next_attempt_at <= v_now$new$);
select pg_temp.google_mailbox_patch('public.qorpera_company_mail_message_ids_due(integer)'::regprocedure,
	$old$		where mail.status = 'sent' and mail.message_id is null and mail.provider_message_id is not null$old$,
	$new$		where mail.status = 'sent' and mail.message_id is null and mail.provider_message_id is not null
			and mail.route = 'platform'$new$);

select pg_temp.google_mailbox_patch(
	'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
	$old$	if v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp() then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;$old$,
	$new$	if v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp() then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_google_mailbox_tickets as mark where mark.ticket_id = v_ticket.id)
		and current_setting('qorpera.google_mailbox_capture', true) is distinct from v_ticket.id::text then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;$new$);

select pg_temp.google_mailbox_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$	if v_from like '%@%' then
		if v_from <> split_part(v_from, '@', 1) || '@' || v_settings.domain then$old$,
	$new$	if v_from like '%@%' and not exists (select 1 from public.qorpera_google_mailboxes as google
		where google.address = v_from and google.removed_at is null) then
		if v_from <> split_part(v_from, '@', 1) || '@' || v_settings.domain then$new$);
select pg_temp.google_mailbox_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$	where local_part = v_from and removed_at is null and profile_id = v_profile_id and environment_id = p_environment_id;$old$,
	$new$	where (local_part = v_from or id = (select google.mailbox_id from public.qorpera_google_mailboxes as google
			where google.address = v_from and google.removed_at is null))
		and removed_at is null and profile_id = v_profile_id and environment_id = p_environment_id;$new$);
select pg_temp.google_mailbox_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	if v_from like '%@%' then
		if v_from <> split_part(v_from, '@', 1) || '@' || v_settings.domain then$old$,
	$new$	if v_from like '%@%' and not exists (select 1 from public.qorpera_google_mailboxes as google
		where google.address = v_from and google.removed_at is null) then
		if v_from <> split_part(v_from, '@', 1) || '@' || v_settings.domain then$new$);
select pg_temp.google_mailbox_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	where local_part = v_from and removed_at is null and profile_id = v_run.profile_id$old$,
	$new$	where (local_part = v_from or id = (select google.mailbox_id from public.qorpera_google_mailboxes as google
			where google.address = v_from and google.removed_at is null))
		and removed_at is null and profile_id = v_run.profile_id$new$);

select pg_temp.google_mailbox_patch('public.qorpera_send_member_mail(uuid,jsonb)'::regprocedure,
	$old$			and exists (select 1 from unnest(v_to || v_cc) as recipient
				where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
					and public.qorpera_mail_box_part(recipient) = mailbox.local_part)) then$old$,
	$new$			and (exists (select 1 from unnest(v_to || v_cc) as recipient
				where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
					and public.qorpera_mail_box_part(recipient) = mailbox.local_part)
				or exists (select 1 from public.qorpera_google_mailboxes as google, unnest(v_to || v_cc) as recipient
					where google.mailbox_id = mailbox.id and google.removed_at is null
						and public.qorpera_google_address_key(recipient) = public.qorpera_google_address_key(google.address)))) then$new$);
select pg_temp.google_mailbox_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$			and exists (select 1 from unnest(v_to || v_cc) as recipient
				where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
					and public.qorpera_mail_box_part(recipient) = mailbox.local_part)) then$old$,
	$new$			and (exists (select 1 from unnest(v_to || v_cc) as recipient
				where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
					and public.qorpera_mail_box_part(recipient) = mailbox.local_part)
				or exists (select 1 from public.qorpera_google_mailboxes as google, unnest(v_to || v_cc) as recipient
					where google.mailbox_id = mailbox.id and google.removed_at is null
						and public.qorpera_google_address_key(recipient) = public.qorpera_google_address_key(google.address)))) then$new$);

select pg_temp.google_mailbox_patch('public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'::regprocedure,
	$old$'email', (select mailbox.local_part || '@' || settings.domain from$old$,
	$new$'email', (select public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, settings.domain) from$new$);
select pg_temp.google_mailbox_patch('public.qorpera_find_agent_mail(jsonb,jsonb)'::regprocedure,
	$old$and (v_mailbox is null or mailbox.local_part || '@' || v_settings.domain = v_mailbox);$old$,
	$new$and (v_mailbox is null
			or public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, v_settings.domain) = v_mailbox);$new$);
select pg_temp.google_mailbox_patch('public.qorpera_find_agent_mail(jsonb,jsonb)'::regprocedure,
	$old$'mailbox', mailbox.local_part || '@' || v_settings.domain,$old$,
	$new$'mailbox', public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, v_settings.domain),$new$);
select pg_temp.google_mailbox_patch('public.qorpera_find_company_accounts(jsonb,jsonb)'::regprocedure,
	$old$		and mailbox.environment_id = v_run.environment_id and mailbox.removed_at is null;$old$,
	$new$		and mailbox.environment_id = v_run.environment_id and mailbox.removed_at is null
		and not exists (select 1 from public.qorpera_google_mailboxes as google where google.mailbox_id = mailbox.id);$new$);
select pg_temp.google_mailbox_patch('public.qorpera_member_mail_thread(uuid,text,jsonb)'::regprocedure,
	$old$'address', (select box.local_part || '@' || v_domain from$old$,
	$new$'address', (select public.qorpera_mailbox_address(box.id, box.local_part, v_domain) from$new$);
select pg_temp.google_mailbox_patch('public.qorpera_member_mail_threads(uuid,jsonb)'::regprocedure,
	$old$'thread', shown.id, 'address', shown.local_part || '@' || v_domain,$old$,
	$new$'thread', shown.id, 'address', public.qorpera_mailbox_address(shown.mailbox_id, shown.local_part, v_domain),$new$);
select pg_temp.google_mailbox_patch('public.qorpera_member_mail_threads(uuid,jsonb)'::regprocedure,
	$old$	if p_request ? 'address' and (v_box is null$old$,
	$new$	if exists (select 1 from public.qorpera_google_mailboxes as google where google.environment_id = p_environment_id
		and google.removed_at is null and google.address = lower(btrim(p_request ->> 'address'))) then
		v_box := (select box.local_part from public.qorpera_google_mailboxes as google
			join public.qorpera_company_mailboxes as box on box.id = google.mailbox_id
			where google.environment_id = p_environment_id and google.removed_at is null
				and google.address = lower(btrim(p_request ->> 'address')));
	elsif p_request ? 'address' and (v_box is null$new$);
select pg_temp.google_mailbox_patch('public.qorpera_folder_hook_file_state(text,uuid,uuid)'::regprocedure,
	$old$'address', v_box.local_part || '@' || v_domain,$old$,
	$new$'address', public.qorpera_mailbox_address(v_box.id, v_box.local_part, v_domain),$new$);
select pg_temp.google_mailbox_patch('public.qorpera_folder_hook_file_state(text,uuid,uuid)'::regprocedure,
	$old$			v_name := v_box.local_part;$old$,
	$new$			v_name := coalesce(public.qorpera_google_mailbox_address(v_box.id), v_box.local_part);$new$);
