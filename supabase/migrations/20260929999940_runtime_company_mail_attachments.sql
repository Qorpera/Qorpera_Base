-- Company mail attachments: build step M2c-1 (Q1; Jonas, 2 October 2026: agents send and receive files by mail, a
-- received attachment is fetched when an agent saves it, not when the mail arrives; design
-- deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Mail (M2)", "Attachments (M2c-1)").
--
-- Received: the mail door keeps each attachment's description (M2a); the provider keeps its bytes for 30 days. An
-- agent saves one into the company folder with save_attachment: the first request records a fetch, which the Edge
-- Function mail-attachments (called at once through pg_net, and each minute by pg_cron) claims under a lease. It
-- streams the attachment from the provider into the company's objects in 4 MiB chunks, named by their sha256 in
-- the Storage bucket qorpera-profile-objects (the catalog records them, and the company's storage allowance counts
-- them), and completes the fetch with the chunks. The runtime then writes them as a company file through the path
-- gateway, as any write: the agent's authority, its version check and its receipt. A fetch is per received email
-- and attachment, so a second save of the same attachment reuses its bytes. An attachment is saved while its
-- email's text is kept (7 days), and at most 40 MiB. Nothing is stored that no agent saved.
--
-- Sent: send_mail takes up to 10 company files the agent may read (their paths), at most 28 MiB in all, which is
-- 40 MB once encoded, the provider's limit. The email records each file as it is when queued (its manifest, digest
-- and size), and the read joins the run's read paths as any read. mail-outbox reads the bytes from the company's
-- objects in Storage, where every object is copied, and sends them as attachments; a claim takes at most 64 MiB of
-- attachments, so one call of the sender stays within its time.
--
-- folder-v2 companies are refused both ways until their folder adds mail attachments as a GC root (C1d); no
-- production company uses folder-v2 today.
--
-- Locks: a save's request takes the run's job and run rows, then its fetch row; the worker's claim, completion and
-- failure take fetch rows only. A send with attachments takes the company folder's fence and row (the path actor,
-- as every Company File tool does) after the run and before the company's mail limits lock.

set local lock_timeout = '3s';

create function pg_temp.mail_attachment_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail attachments integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Received attachments: fetches
-- ---------------------------------------------------------------------------
create table public.qorpera_mail_attachment_fetches (
	id uuid primary key default extensions.gen_random_uuid(),
	delivery_id uuid not null references public.qorpera_event_deliveries(id) on delete cascade,
	-- Its place in the email's attachments as read_event shows them, from 1.
	attachment integer not null check (attachment between 1 and 50),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	-- The provider's ids for the received email and the attachment.
	email_id text not null check (email_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	provider_attachment_id text not null
		check (char_length(provider_attachment_id) between 1 and 128 and provider_attachment_id ~ '^[A-Za-z0-9_.-]+$'),
	filename text check (filename is null or char_length(filename) <= 256),
	content_type text check (content_type is null or char_length(content_type) <= 256),
	status text not null default 'pending' check (status in ('pending', 'fetching', 'stored', 'failed')),
	attempt_count integer not null default 0 check (attempt_count >= 0),
	next_attempt_at timestamptz not null default clock_timestamp(),
	lease_id uuid,
	lease_expires_at timestamptz,
	-- Once stored: the file's digest and size, and its chunks in order, each a company object.
	file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint check (bytes is null or bytes between 0 and 41943040),
	chunks jsonb check (chunks is null or (jsonb_typeof(chunks) = 'array' and jsonb_array_length(chunks) <= 10)),
	last_error text check (last_error is null or char_length(last_error) <= 1000),
	-- The run that asked first.
	requested_by_run_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz,
	unique (delivery_id, attachment),
	check ((status = 'stored') = (file_sha256 is not null and bytes is not null and chunks is not null))
);
create index qorpera_mail_attachment_fetches_due on public.qorpera_mail_attachment_fetches (next_attempt_at)
	where status in ('pending', 'fetching');
alter table public.qorpera_mail_attachment_fetches enable row level security;
revoke all on table public.qorpera_mail_attachment_fetches from public, anon, authenticated, service_role;

-- The fetch worker, called at once: through pg_net when it and the worker's Vault entries exist (the project's URL,
-- and the Supabase secret key the mail workers present), else nothing, and the minute's call takes it.
create function public.qorpera_mail_attachments_kick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_url text; v_key text;
begin
	if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
		or to_regclass('vault.decrypted_secrets') is null then
		return; end if;
	execute 'select (select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_project_url''),
		(select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_mail_outbox_key'')'
	into v_url, v_key;
	if v_url is null or v_key is null then return; end if;
	execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 120000)'
	using v_url || '/functions/v1/mail-attachments', jsonb_build_object('content-type', 'application/json', 'apikey', v_key);
exception when others then
	-- The minute's call fetches it then.
	return;
end
$$;
revoke all on function public.qorpera_mail_attachments_kick() from public, anon, authenticated, service_role;

create function public.qorpera_mail_attachment_receipt(p_run_id uuid, p_fetch public.qorpera_mail_attachment_fetches)
returns jsonb
language sql
stable
set search_path = ''
as $$
	select jsonb_strip_nulls(jsonb_build_object('schema', 'qorpera.agent-mail-attachment/v1', 'runId', p_run_id,
		'deliveryId', p_fetch.delivery_id, 'attachment', p_fetch.attachment, 'filename', p_fetch.filename,
		'contentType', p_fetch.content_type,
		'state', case p_fetch.status when 'pending' then 'fetching' else p_fetch.status end,
		'bytes', p_fetch.bytes, 'fileSha256', p_fetch.file_sha256, 'chunks', p_fetch.chunks,
		'error', case when p_fetch.status = 'failed' then p_fetch.last_error end))
$$;
revoke all on function public.qorpera_mail_attachment_receipt(uuid, public.qorpera_mail_attachment_fetches)
	from public, anon, authenticated, service_role;

-- An agent's request for a received attachment's bytes (save_attachment): the email must be one its company
-- received in its environment, as read_event checks. The first request records the fetch and calls the worker; any
-- request answers the fetch's state, with the chunks once stored, which the runtime writes as a company file.
create function public.qorpera_native_mail_attachment(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_delivery public.qorpera_event_deliveries%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_fetch public.qorpera_mail_attachment_fetches%rowtype;
	v_message jsonb;
	v_item jsonb;
	v_attachment integer;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['deliveryId', 'attachment'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'deliveryId') is distinct from 'string'
		or p_request ->> 'deliveryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or jsonb_typeof(p_request -> 'attachment') is distinct from 'number'
		or p_request ->> 'attachment' !~ '^[1-9][0-9]?$' or (p_request ->> 'attachment')::integer > 50 then
		raise exception 'Attachment request is invalid' using errcode = '22023'; end if;
	v_attachment := (p_request ->> 'attachment')::integer;
	select * into v_delivery from public.qorpera_event_deliveries where id = (p_request ->> 'deliveryId')::uuid;
	select * into v_hook from public.qorpera_event_hooks where id = v_delivery.hook_id;
	if v_delivery.id is null or v_delivery.status <> 'verified' or v_delivery.event_type <> 'mail.received'
		or v_hook.proof is distinct from 'mail' or v_hook.profile_id is distinct from v_run.profile_id
		or v_hook.environment_id is distinct from v_run.environment_id then
		raise exception 'The email is not one the company received' using errcode = '42501'; end if;
	if public.qorpera_company_is_folder_v2(v_run.profile_id) then
		raise exception 'Saving attachments into this company''s folder is not built yet' using errcode = '0A000'; end if;
	select * into v_fetch from public.qorpera_mail_attachment_fetches
	where delivery_id = v_delivery.id and attachment = v_attachment;
	if not found then
		if v_delivery.body is null then
			raise exception 'The email''s text and attachments were cleared 7 days after it arrived' using errcode = '0A000';
		end if;
		begin
			v_message := convert_from(v_delivery.body, 'UTF8')::jsonb;
		exception when others then
			v_message := null;
		end;
		v_item := v_message -> 'attachments' -> (v_attachment - 1);
		if jsonb_typeof(v_item) is distinct from 'object' or jsonb_typeof(v_item -> 'id') is distinct from 'string'
			or v_item ->> 'id' !~ '^[A-Za-z0-9_.-]{1,128}$'
			or coalesce(v_message ->> 'emailId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'The email has no attachment %; read_event lists its attachments', v_attachment
				using errcode = '22023'; end if;
		if jsonb_typeof(v_item -> 'size') = 'number' and (v_item ->> 'size')::numeric > 41943040 then
			raise exception 'Attachment % is larger than 40 MiB, the most an attachment saved may be', v_attachment
				using errcode = '54000'; end if;
		insert into public.qorpera_mail_attachment_fetches (delivery_id, attachment, profile_id, environment_id, email_id,
			provider_attachment_id, filename, content_type, requested_by_run_id)
		values (v_delivery.id, v_attachment, v_run.profile_id, v_run.environment_id, v_message ->> 'emailId',
			v_item ->> 'id', left(v_item ->> 'filename', 256), left(v_item ->> 'contentType', 256), v_run.id)
		on conflict (delivery_id, attachment) do nothing
		returning * into v_fetch;
		if v_fetch.id is null then
			select * into strict v_fetch from public.qorpera_mail_attachment_fetches
			where delivery_id = v_delivery.id and attachment = v_attachment;
		else
			perform public.qorpera_mail_attachments_kick();
		end if;
	end if;
	return public.qorpera_mail_attachment_receipt(v_run.id, v_fetch);
end
$$;
revoke all on function public.qorpera_native_mail_attachment(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_native_mail_attachment(jsonb, jsonb) to service_role;
-- The guest's native host reaches it as it reaches find_mail (G2-1, 20260928409985; G2-2's dispatch lists it).
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_native_mail_attachment', 'binding');

-- The worker's claim: fetches waiting or whose lease ran out, five minutes each. A fetch is given up after six
-- attempts or a day.
create function public.qorpera_claim_mail_attachment_fetches(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_now timestamptz := clock_timestamp();
	v_result jsonb;
begin
	if p_limit is null or p_limit not between 1 and 10 or p_lease_id is null then
		raise exception 'Mail attachment claim is invalid' using errcode = '22023'; end if;
	update public.qorpera_mail_attachment_fetches as item
	set status = 'failed', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = left(case when item.attempt_count >= 6 then coalesce(item.last_error, 'Gave up after six attempts')
			else 'Not fetched within a day' end, 1000)
	where (item.status = 'pending' or (item.status = 'fetching' and item.lease_expires_at <= v_now))
		and (item.created_at <= v_now - interval '1 day' or item.attempt_count >= 6);
	with candidates as (
		select item.id
		from public.qorpera_mail_attachment_fetches as item
		where item.status in ('pending', 'fetching')
			and item.next_attempt_at <= v_now
			and (item.lease_expires_at is null or item.lease_expires_at <= v_now)
		order by item.next_attempt_at, item.created_at
		for update skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_mail_attachment_fetches as item
		set status = 'fetching', attempt_count = item.attempt_count + 1, lease_id = p_lease_id,
			lease_expires_at = v_now + interval '5 minutes'
		from candidates
		where item.id = candidates.id
		returning item.*
	)
	select coalesce(jsonb_agg(jsonb_build_object('fetchId', claimed.id, 'leaseId', claimed.lease_id,
		'attemptCount', claimed.attempt_count, 'companyId', claimed.profile_id, 'emailId', claimed.email_id,
		'attachmentId', claimed.provider_attachment_id) order by claimed.created_at), '[]'::jsonb) into v_result
	from claimed;
	return v_result;
end
$$;
revoke all on function public.qorpera_claim_mail_attachment_fetches(integer, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_claim_mail_attachment_fetches(integer, uuid) to service_role;

-- Stored: the chunks, in order, each this company's object of its size (the Storage insert recorded it): all 4 MiB
-- but the last, together the file's size.
create function public.qorpera_complete_mail_attachment_fetch(p_fetch_id uuid, p_lease_id uuid, p_file_sha256 text,
	p_bytes bigint, p_chunks jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare v_fetch public.qorpera_mail_attachment_fetches%rowtype; v_count integer;
begin
	select * into v_fetch from public.qorpera_mail_attachment_fetches where id = p_fetch_id for update;
	if not found or v_fetch.status <> 'fetching' or v_fetch.lease_id is distinct from p_lease_id then
		return false; end if;
	if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes not between 0 and 41943040
		or jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks) > 10
		or jsonb_array_length(p_chunks) <> ceil(p_bytes / 4194304.0)
		or exists (select 1 from jsonb_array_elements(p_chunks) with ordinality as chunk(value, n)
			where jsonb_typeof(chunk.value) <> 'object' or chunk.value - array['sha256', 'bytes'] <> '{}'::jsonb
				or jsonb_typeof(chunk.value -> 'sha256') is distinct from 'string'
				or chunk.value ->> 'sha256' !~ '^[0-9a-f]{64}$'
				or jsonb_typeof(chunk.value -> 'bytes') is distinct from 'number'
				or chunk.value ->> 'bytes' !~ '^[1-9][0-9]*$'
				or (chunk.value ->> 'bytes')::bigint <> least(4194304, p_bytes - (chunk.n - 1) * 4194304)) then
		raise exception 'Mail attachment is invalid' using errcode = '22023'; end if;
	select count(*) into v_count
	from jsonb_array_elements(p_chunks) as chunk(value)
	join public.qorpera_profile_objects as object on object.profile_id = v_fetch.profile_id
		and object.sha256 = chunk.value ->> 'sha256' and object.bytes = (chunk.value ->> 'bytes')::bigint;
	if v_count <> jsonb_array_length(p_chunks) then
		raise exception 'Mail attachment chunks are not stored' using errcode = '55000'; end if;
	update public.qorpera_mail_attachment_fetches
	set status = 'stored', file_sha256 = p_file_sha256, bytes = p_bytes, chunks = p_chunks, settled_at = clock_timestamp(),
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_fetch_id;
	return true;
end
$$;
revoke all on function public.qorpera_complete_mail_attachment_fetch(uuid, uuid, text, bigint, jsonb)
	from public, anon, authenticated;
grant execute on function public.qorpera_complete_mail_attachment_fetch(uuid, uuid, text, bigint, jsonb) to service_role;

-- Failed: tried again after 1, 2, 4 ... minutes when the failure may pass (a timeout, the provider's rate limit or
-- error), else at once for good (the provider no longer has it, it is too large, the allowance is used up).
create function public.qorpera_fail_mail_attachment_fetch(p_fetch_id uuid, p_lease_id uuid, p_error text,
	p_retryable boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare v_fetch public.qorpera_mail_attachment_fetches%rowtype;
begin
	select * into v_fetch from public.qorpera_mail_attachment_fetches where id = p_fetch_id for update;
	if not found or v_fetch.status <> 'fetching' or v_fetch.lease_id is distinct from p_lease_id then
		return false; end if;
	if p_retryable and v_fetch.attempt_count < 6 then
		update public.qorpera_mail_attachment_fetches
		set status = 'pending', lease_id = null, lease_expires_at = null, last_error = left(p_error, 1000),
			next_attempt_at = clock_timestamp() + make_interval(mins => power(2, v_fetch.attempt_count - 1)::integer)
		where id = p_fetch_id;
	else
		update public.qorpera_mail_attachment_fetches
		set status = 'failed', lease_id = null, lease_expires_at = null, settled_at = clock_timestamp(),
			last_error = left(coalesce(nullif(btrim(p_error), ''), 'The attachment could not be fetched'), 1000)
		where id = p_fetch_id;
	end if;
	return true;
end
$$;
revoke all on function public.qorpera_fail_mail_attachment_fetch(uuid, uuid, text, boolean)
	from public, anon, authenticated;
grant execute on function public.qorpera_fail_mail_attachment_fetch(uuid, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Sent attachments: company files on an email
-- ---------------------------------------------------------------------------
alter table public.qorpera_company_mail_outbox
	-- Each file as it was when queued: {path, filename, version, manifestSha256, fileSha256, bytes}.
	add column attachments jsonb not null default '[]'::jsonb
		check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10),
	add column attachment_bytes bigint not null default 0 check (attachment_bytes between 0 and 29360128);

-- The request names files by path; each must be a file the agent may read.
select pg_temp.mail_attachment_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	v_next timestamptz;
begin$old$,
	$new$	v_next timestamptz;
	v_actor jsonb;
	v_path text;
	v_entry public.qorpera_company_path_entries%rowtype;
	v_attachments jsonb := '[]'::jsonb;
	v_attachment_bytes bigint := 0;
begin$new$);
select pg_temp.mail_attachment_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$p_request - array['from','to','cc','subject','text','inReplyTo'] <> '{}'::jsonb$old$,
	$new$p_request - array['from','to','cc','subject','text','inReplyTo','attachments'] <> '{}'::jsonb
		or coalesce(jsonb_typeof(p_request -> 'attachments'), 'array') <> 'array'
		or jsonb_array_length(coalesce(p_request -> 'attachments', '[]')) > 10
		or exists (select 1 from jsonb_array_elements(coalesce(p_request -> 'attachments', '[]')) as item(value)
			where jsonb_typeof(item.value) <> 'string' or char_length(item.value #>> '{}') not between 1 and 4096)
		or (select count(distinct item.value) <> count(*)
			from jsonb_array_elements(coalesce(p_request -> 'attachments', '[]')) as item(value))$new$);
select pg_temp.mail_attachment_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	-- The company's limits on recipients, counted under one lock per company.$old$,
	$new$	-- Attachments: company files the agent may read, as they are now, through the Company File authority every
	-- file tool uses (it takes the company folder's fence after the run, before the limits lock below).
	if jsonb_array_length(coalesce(p_request -> 'attachments', '[]')) > 0 then
		if public.qorpera_company_is_folder_v2(v_run.profile_id) then
			raise exception 'Attaching files from this company''s folder is not built yet' using errcode = '0A000'; end if;
		v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
		for v_path in select item.value #>> '{}' from jsonb_array_elements(p_request -> 'attachments') as item(value) loop
			perform public.qorpera_company_path_remember_read(v_actor, v_path);
			select * into v_entry from public.qorpera_company_path_entries
			where environment_id = v_run.environment_id
				and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(v_path), 'sha256');
			if v_entry.entry ->> 'kind' is distinct from 'file' then
				raise exception 'Attachment % is not a file in the company folder', v_path using errcode = '22023'; end if;
			v_attachments := v_attachments || jsonb_build_array(jsonb_build_object('path', v_entry.path,
				'filename', regexp_replace(v_entry.path, '^.*/', ''), 'version', v_entry.version,
				'manifestSha256', v_entry.entry #>> '{file,manifestSha256}',
				'fileSha256', v_entry.entry #>> '{file,fileSha256}', 'bytes', (v_entry.entry #>> '{file,bytes}')::bigint));
			v_attachment_bytes := v_attachment_bytes + (v_entry.entry #>> '{file,bytes}')::bigint;
		end loop;
		if v_attachment_bytes > 29360128 then
			raise exception 'The attachments come to % bytes; an email carries at most 28 MiB (29360128 bytes)',
				v_attachment_bytes using errcode = '54000'; end if;
	end if;
	-- The company's limits on recipients, counted under one lock per company.$new$);
select pg_temp.mail_attachment_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$		thread_references)
	values$old$,
	$new$		thread_references, attachments, attachment_bytes)
	values$new$);
select pg_temp.mail_attachment_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$		(p_request ->> 'inReplyTo')::uuid, v_in_reply_to, v_references)$old$,
	$new$		(p_request ->> 'inReplyTo')::uuid, v_in_reply_to, v_references, v_attachments, v_attachment_bytes)$new$);

-- The receipt lists the files attached.
select pg_temp.mail_attachment_patch('public.qorpera_agent_mail_receipt(public.qorpera_company_mail_outbox,boolean)'::regprocedure,
	$old$		'subject', p_mail.subject)$old$,
	$new$		'subject', p_mail.subject)
		|| case when jsonb_array_length(p_mail.attachments) = 0 then '{}'::jsonb
			else jsonb_build_object('attachments', (select jsonb_agg(jsonb_build_object('path', item.value ->> 'path',
				'bytes', (item.value ->> 'bytes')::bigint) order by item.n)
				from jsonb_array_elements(p_mail.attachments) with ordinality as item(value, n))) end$new$);

-- A claim takes the due emails in order while their attachments come to 64 MiB, and always the first.
select pg_temp.mail_attachment_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$		select mail.id
		from public.qorpera_company_mail_outbox as mail$old$,
	$new$		select mail.id, mail.next_attempt_at, mail.created_at, mail.attachment_bytes
		from public.qorpera_company_mail_outbox as mail$new$);
select pg_temp.mail_attachment_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$		limit p_limit
	), claimed as ($old$,
	$new$		limit p_limit
	), budgeted as (
		select ordered.id from (
			select candidates.id,
				row_number() over (order by candidates.next_attempt_at, candidates.created_at, candidates.id) as place,
				sum(candidates.attachment_bytes)
					over (order by candidates.next_attempt_at, candidates.created_at, candidates.id) as running
			from candidates) as ordered
		where ordered.place = 1 or ordered.running <= 67108864
	), claimed as ($new$);
select pg_temp.mail_attachment_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$		from candidates
		where mail.id = candidates.id$old$,
	$new$		from budgeted
		where mail.id = budgeted.id$new$);
select pg_temp.mail_attachment_patch('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$'auto-replied' end))
	) order by claimed.created_at)$old$,
	$new$'auto-replied' end))
	)
	-- An email with files: the company and each file as queued, read from the company's objects.
	|| case when jsonb_array_length(claimed.attachments) = 0 then '{}'::jsonb
		else jsonb_build_object('companyId', claimed.profile_id,
			'attachments', (select jsonb_agg(jsonb_build_object('filename', item.value ->> 'filename',
				'manifestSha256', item.value ->> 'manifestSha256', 'fileSha256', item.value ->> 'fileSha256',
				'bytes', (item.value ->> 'bytes')::bigint) order by item.n)
				from jsonb_array_elements(claimed.attachments) with ordinality as item(value, n))) end
	order by claimed.created_at)$new$);

-- ---------------------------------------------------------------------------
-- 3. Observations name the new tool
-- ---------------------------------------------------------------------------
select pg_temp.mail_attachment_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'list_hooks','read_event','send_mail','find_mail',$old$,
	$new$'list_hooks','read_event','send_mail','find_mail','save_attachment',$new$);
