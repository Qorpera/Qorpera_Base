-- Company mailboxes, build step M2a (Q1; founder decisions of 29 September 2026: email waking agents is the top
-- priority, and a company's first address is on a mail domain Qorpera owns (decision 7); contract section 19,
-- 2026-09-29 amendment "events wake agents", item 9; design deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)").
--
-- An owner or admin creates a mailbox, <local part>@<the platform's mail domain>. The domain is one setting: a
-- mailbox keeps only its local part, so setting the domain moves every mailbox to it. A mailbox is a platform-owned hook
-- with the proof 'mail': only the mail door fills it, and the public event intake treats its hook address as unknown.
-- The Edge Function mail-intake verifies the mail provider's signed webhook, fetches the whole message and hands it
-- to qorpera_receive_mail, which stores it as a verified delivery of type 'mail.received' within the hook's and the
-- company's limits. A routine wakes on the mailbox with the event trigger on its hook (W2), and agents read the whole
-- message with read_event. Mail is outside content like every event. Sending (M2b) and attachment contents follow.
--
-- Lock order: creating a mailbox takes the company row without its key, then its Company File row (shared), as hook
-- creation does. A hook status change updates its mailbox after the hook row. The mail door locks only the company's
-- hourly usage row, as a receive does.

set local lock_timeout = '3s';

create function pg_temp.mailbox_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mailbox integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Settings: switched off, with no domain until operators set one
-- ---------------------------------------------------------------------------
create table public.qorpera_mail_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false,
	domain text check (domain is null or (domain = lower(domain) and char_length(domain) <= 200
		and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'))
);
insert into public.qorpera_mail_settings (singleton) values (true);
alter table public.qorpera_mail_settings enable row level security;
revoke all on table public.qorpera_mail_settings from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hooks gain the proof 'mail'; mailboxes
-- ---------------------------------------------------------------------------
do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_event_hooks_proof_check'
		and conrelid = 'public.qorpera_event_hooks'::regclass))
		is distinct from 'CHECK ((proof = ANY (ARRAY[''address''::text, ''stripe''::text, ''github''::text, ''hmac-sha256''::text])))' then
		raise exception 'Hook proofs differ'; end if;
end
$$;
alter table public.qorpera_event_hooks drop constraint qorpera_event_hooks_proof_check;
alter table public.qorpera_event_hooks add constraint qorpera_event_hooks_proof_check
	check (proof in ('address', 'stripe', 'github', 'hmac-sha256', 'mail'));

create table public.qorpera_company_mailboxes (
	id uuid primary key default extensions.gen_random_uuid(),
	hook_id uuid not null unique references public.qorpera_event_hooks(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	-- Lowercase letters, digits, dots, hyphens and underscores; no leading, trailing or doubled dot.
	local_part text not null check (local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$' and local_part !~ '\.\.'),
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default statement_timestamp(),
	removed_at timestamptz
);
-- An address belongs to one live mailbox across the platform; removing a mailbox frees it.
create unique index qorpera_company_mailboxes_live_address on public.qorpera_company_mailboxes (local_part)
	where removed_at is null;
create index qorpera_company_mailboxes_company on public.qorpera_company_mailboxes (profile_id, environment_id);
alter table public.qorpera_company_mailboxes enable row level security;
revoke all on table public.qorpera_company_mailboxes from public, anon, authenticated, service_role;

-- A mailbox is removed with its hook (qorpera_set_event_hook_status), which frees its address.
create function public.qorpera_mailbox_follow_hook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.proof = 'mail' and new.status = 'removed' and old.status is distinct from 'removed' then
		update public.qorpera_company_mailboxes set removed_at = coalesce(new.removed_at, clock_timestamp())
		where hook_id = new.id and removed_at is null;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_mailbox_follow_hook() from public, anon, authenticated, service_role;
create trigger qorpera_mailbox_follow_hook after update of status on public.qorpera_event_hooks
	for each row execute function public.qorpera_mailbox_follow_hook();

-- ---------------------------------------------------------------------------
-- 3. The public intake never fills a mailbox, and never shows its hook address
-- ---------------------------------------------------------------------------
select pg_temp.mailbox_patch('public.qorpera_receive_event(text,text,jsonb,text)'::regprocedure,
	$old$	if v_hook.id is null or v_hook.status = 'removed' or public.qorpera_company_deleting(v_hook.profile_id) then$old$,
	$new$	if v_hook.id is null or v_hook.status = 'removed' or v_hook.proof = 'mail'
		or public.qorpera_company_deleting(v_hook.profile_id) then$new$);

select pg_temp.mailbox_patch('public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'::regprocedure,
	$old$		'address', case when p_with_address then p_hook.address end,
		'path', case when p_with_address then '/functions/v1/event-intake/' || p_hook.address end,$old$,
	$new$		'address', case when p_with_address and p_hook.proof <> 'mail' then p_hook.address end,
		'path', case when p_with_address and p_hook.proof <> 'mail' then '/functions/v1/event-intake/' || p_hook.address end,
		-- A mailbox's address is public by nature: every member sees it.
		'email', (select mailbox.local_part || '@' || settings.domain from public.qorpera_company_mailboxes as mailbox,
			public.qorpera_mail_settings as settings where mailbox.hook_id = p_hook.id),$new$);

select pg_temp.mailbox_patch('public.qorpera_list_agent_event_hooks(jsonb)'::regprocedure,
	$old$			|| case when v_addresses and v_url is not null$old$,
	$new$			|| case when v_addresses and v_url is not null and hook.proof <> 'mail'$new$);

-- ---------------------------------------------------------------------------
-- 4. Owners and admins create mailboxes; pausing and removing is the hook's
-- ---------------------------------------------------------------------------
create function public.qorpera_create_company_mailbox(
	p_profile_id uuid,
	p_environment_id uuid,
	p_local_part text,
	p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := public.qorpera_member_role(p_profile_id)::text;
	v_domain text;
	v_core text;
	v_name text;
	v_hook public.qorpera_event_hooks%rowtype;
begin
	if auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can create mailboxes' using errcode = '42501';
	end if;
	if p_environment_id is null or not exists (select 1 from public.qorpera_company_environments
		where id = p_environment_id and profile_id = p_profile_id) then
		raise exception 'The environment is not this company''s' using errcode = '22023';
	end if;
	if p_local_part is null or p_local_part !~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$' or p_local_part ~ '\.\.' then
		raise exception 'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores'
			using errcode = '22023';
	end if;
	-- Names every mail domain keeps for itself (RFC 2142) or that invite abuse.
	if p_local_part in ('postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'administrator', 'root',
		'security', 'noc', 'noreply', 'no-reply', 'mailer-daemon', 'www', 'ftp', 'uucp', 'usenet', 'news') then
		raise exception 'This mailbox name is reserved' using errcode = '22023';
	end if;
	if p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 512 or p_purpose ~ '[[:cntrl:]]' then
		raise exception 'A mailbox purpose is one line of at most 512 characters' using errcode = '22023';
	end if;
	select settings.domain into v_domain from public.qorpera_mail_settings as settings;
	if v_domain is null then
		raise exception 'Company mail is not set up yet' using errcode = '0A000';
	end if;
	-- As hook creation: the company row without its key (serializes creations, waits for the gc fence), the
	-- deletion recheck, then the Company File row shared.
	perform 1 from public.qorpera_profiles where id = p_profile_id for no key update;
	if public.qorpera_company_deleting(p_profile_id) then
		raise exception 'Only owners and admins can create mailboxes' using errcode = '42501';
	end if;
	select file.core into v_core from public.qorpera_company_files as file
	where file.environment_id = p_environment_id for share;
	if v_core = 'folder-v2' then
		raise exception 'Mailboxes for folder companies come with their connection file' using errcode = '0A000';
	end if;
	if (select count(*) from public.qorpera_company_mailboxes
		where profile_id = p_profile_id and removed_at is null) >= 20 then
		raise exception 'A company has at most 20 mailboxes' using errcode = '54000';
	end if;
	if (select count(*) from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.status <> 'removed') >= 50 then
		raise exception 'A company has at most 50 hooks' using errcode = '54000';
	end if;
	if exists (select 1 from public.qorpera_company_mailboxes
		where local_part = p_local_part and removed_at is null) then
		raise exception 'This address is taken' using errcode = '23505';
	end if;
	v_name := 'mail-' || left(regexp_replace(p_local_part, '[^a-z0-9-]', '-', 'g'), 59);
	if exists (select 1 from public.qorpera_event_hooks as hook where hook.profile_id = p_profile_id
		and hook.environment_id = p_environment_id and hook.name = v_name and hook.status <> 'removed') then
		raise exception 'A hook with this name already exists' using errcode = '23505';
	end if;
	begin
		insert into public.qorpera_event_hooks (
			profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_user_id
		) values (
			p_profile_id, p_environment_id, v_name, btrim(p_purpose), 'mail',
			translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
			262144, 120, auth.uid()
		) returning * into v_hook;
		insert into public.qorpera_company_mailboxes (hook_id, profile_id, environment_id, local_part, created_by_user_id)
		values (v_hook.id, p_profile_id, p_environment_id, p_local_part, auth.uid());
	exception when unique_violation then
		raise exception 'This address is taken' using errcode = '23505';
	end;
	return public.qorpera_event_hook_descriptor(v_hook, true);
end
$$;
revoke all on function public.qorpera_create_company_mailbox(uuid, uuid, text, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_create_company_mailbox(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The mail door (service_role only): one received message to one recipient
-- ---------------------------------------------------------------------------
-- Answers accepted (with the delivery id), duplicate (the provider's message was stored for this mailbox already),
-- unknown (no live mailbox has this address), paused, too_large, limited (with retryAfterSeconds) or unavailable
-- (company mail is switched off). The per-hook minute and the company's hourly budget are the event intake's. A
-- refused message writes nothing.
create function public.qorpera_receive_mail(p_email_id text, p_recipient text, p_message jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_settings public.qorpera_mail_settings%rowtype;
	v_intake public.qorpera_event_intake_settings%rowtype;
	v_recipient text;
	v_local text;
	v_domain text;
	v_mailbox public.qorpera_company_mailboxes%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_body bytea;
	v_delivery_id uuid := extensions.gen_random_uuid();
	v_inserted uuid;
	v_hour timestamptz := date_trunc('hour', clock_timestamp(), 'UTC');
	v_used_deliveries bigint;
	v_used_bytes bigint;
begin
	if p_email_id is null or p_email_id !~ '^[A-Za-z0-9._:-]{1,128}$'
		or p_recipient is null or char_length(p_recipient) not between 3 and 320
		or jsonb_typeof(p_message) is distinct from 'object' or octet_length(p_message::text) > 262144 then
		raise exception 'The message is malformed' using errcode = '22023';
	end if;
	select settings.* into v_settings from public.qorpera_mail_settings as settings;
	if not coalesce(v_settings.enabled, false) or v_settings.domain is null then
		return jsonb_build_object('outcome', 'unavailable');
	end if;
	v_recipient := lower(btrim(p_recipient));
	v_local := substring(v_recipient from '^(.*)@[^@]*$');
	v_domain := substring(v_recipient from '@([^@]*)$');
	if v_local is null or v_domain is distinct from v_settings.domain then
		return jsonb_build_object('outcome', 'unknown');
	end if;
	select mailbox.* into v_mailbox from public.qorpera_company_mailboxes as mailbox
	where mailbox.local_part = v_local and mailbox.removed_at is null;
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = v_mailbox.hook_id;
	if v_hook.id is null or v_hook.status = 'removed' or v_hook.proof <> 'mail'
		or public.qorpera_company_deleting(v_hook.profile_id) then
		return jsonb_build_object('outcome', 'unknown');
	end if;
	if v_hook.status = 'paused' then
		return jsonb_build_object('outcome', 'paused');
	end if;
	v_body := convert_to(p_message::text, 'UTF8');
	if octet_length(v_body) > v_hook.max_body_bytes then
		return jsonb_build_object('outcome', 'too_large', 'maxBodyBytes', v_hook.max_body_bytes);
	end if;
	if exists (select 1 from public.qorpera_event_deliveries as earlier
		where earlier.hook_id = v_hook.id and earlier.status = 'verified' and earlier.delivery_key = 'mail:' || p_email_id) then
		return jsonb_build_object('outcome', 'duplicate');
	end if;
	if (select count(*) from public.qorpera_event_deliveries as recent
		where recent.hook_id = v_hook.id and recent.received_at > clock_timestamp() - interval '60 seconds')
		>= v_hook.per_minute then
		return jsonb_build_object('outcome', 'limited', 'retryAfterSeconds', 60);
	end if;
	select settings.* into v_intake from public.qorpera_event_intake_settings as settings;
	select coalesce(sum(usage.deliveries), 0), coalesce(sum(usage.bytes), 0) into v_used_deliveries, v_used_bytes
	from public.qorpera_event_intake_usage as usage
	where usage.profile_id = v_hook.profile_id and usage.hour >= v_hour - interval '1 hour';
	if v_used_deliveries + 1 > v_intake.company_hourly_deliveries
		or v_used_bytes + octet_length(v_body) > v_intake.company_hourly_bytes then
		return jsonb_build_object('outcome', 'limited', 'retryAfterSeconds', 600);
	end if;
	insert into public.qorpera_event_deliveries (
		id, hook_id, profile_id, status, delivery_key, event_type, content_type, headers,
		body, body_bytes, body_sha256, verified_at
	) values (
		v_delivery_id, v_hook.id, v_hook.profile_id, 'verified', 'mail:' || p_email_id, 'mail.received',
		'application/json', '{}'::jsonb, v_body, octet_length(v_body),
		encode(extensions.digest(v_body, 'sha256'), 'hex'), clock_timestamp()
	)
	on conflict (hook_id, delivery_key) where status = 'verified' do nothing
	returning id into v_inserted;
	if v_inserted is null then
		return jsonb_build_object('outcome', 'duplicate');
	end if;
	insert into public.qorpera_event_intake_usage as usage (profile_id, hour, deliveries, bytes)
	values (v_hook.profile_id, v_hour, 1, octet_length(v_body))
	on conflict (profile_id, hour) do update
	set deliveries = usage.deliveries + 1, bytes = usage.bytes + excluded.bytes;
	return jsonb_build_object('outcome', 'accepted', 'deliveryId', v_delivery_id);
end
$$;
revoke all on function public.qorpera_receive_mail(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_receive_mail(text, text, jsonb) to service_role;
