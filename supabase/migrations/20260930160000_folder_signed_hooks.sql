-- Company folder core, C4 (E3b-1, Q1): GitHub and HMAC hooks, with a secret the vault makes
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.7; agreed with the coordinator on 6 October 2026).
--
-- An agent's manage_hook opens a signed hook through the company's secret broker, which makes the hook's signing secret,
-- seals it under the company's key and never shows it to the model; the vault later types it into the sender's settings.
-- * A signed hook keeps the site its secret may be typed into: qorpera_event_hooks.secret_site, null for address hooks,
--   mailboxes and hooks a member made in Settings. manage_hook's create takes `site`: optional for github (github.com),
--   required for hmac-sha256. Stripe stays refused (E3c takes its secret from Stripe's screen).
-- * E3a's function becomes qorpera_folder_manage_hook_effect(p_binding, p_request, p_vault, …), granted to no role: E3a's
--   order and checks word for word, with `site` in the request and in the receipt's digest. Its two callers:
--   - qorpera_folder_manage_hook, the host's (unchanged name, signature and grants), with no vault: a signed proof is
--     refused there (0A000), since the runtime sends signed creates to the broker;
--   - qorpera_folder_open_signed_hook, the broker's, with the vault: in the same step as the hook, its event_hook secret
--     (W1b's name, the company's, created by the run's requester), version 1 (the broker's envelope, this authority's key)
--     and an audit row hook_secret_made. A replay answers from the receipt and stores nothing.
-- * qorpera_folder_describe_signed_hook: the run and role checks, then what the envelope's associated data needs.
-- * qorpera_fill_event_hook_secret: A1's fill read for a hook's secret ({action: vault_fill, hook, field:
--   signing_secret}): the computer_browser receipt of exactly that call, the computer the run's screen lease holds and its
--   boot key; a live signed hook with a secret_site and a secret sealed for this authority; the requester an owner or
--   admin. Audit hook_secret_used. Not gated by A1's switch (the accounts').
-- * The broker functions run A1's checks before any lock (the broker's session and capability, a job of its company,
--   folder-v2 only); the fill holds the hook (rank 5, FOR SHARE), then its secret, then the receipt.
-- * qorpera_valid_office_browser_action accepts the hook variant of vault_fill; A1's fill refuses it as no such account.
-- Every inserted text names this migration (20260930160000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_folder_manage_hook(jsonb,jsonb)') is null then
		raise exception 'E3b-1 (20260930160000) needs E3a (20260930106000)'; end if;
	if to_regprocedure('public.qorpera_folder_open_signed_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,bytea,text)') is not null then
		raise exception 'E3b-1 (20260930160000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.e3b_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'E3b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Where a signed hook's secret may be typed, and the vault's two new audit events -------------------------------------

-- The host rule is qorpera_company_account_host_valid's, written out: a check runs with the writer's rights, and that
-- function is granted to no role.
alter table public.qorpera_event_hooks
	add column secret_site text,
	add constraint qorpera_event_hooks_secret_site_check check (secret_site is null or (proof in ('github', 'hmac-sha256')
		and char_length(secret_site) <= 253
		and secret_site ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'));
comment on column public.qorpera_event_hooks.secret_site is
	'20260930160000 (E3b): the site a signed hook''s secret may be typed into by the vault; null when the vault types none.';

-- The event types as they stand (each bundle adds its own), and the two new ones.
do $$
declare v_types text[];
begin
	select array_agg(m.value[1] order by m.ordinality) into v_types
	from pg_constraint as c
	cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') with ordinality as m(value, ordinality)
	where c.conrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and c.conname = 'qorpera_cloud_secret_audit_events_event_type_check';
	if v_types is null or not 'account_removed' = any(v_types) or 'hook_secret_made' = any(v_types) then
		raise exception 'E3b: the audit event types differ: %', v_types; end if;
	-- An in (…) list, as A1's rebuilt it: it reads back as ARRAY['…'::text, …], which the reader above parses.
	execute format('alter table public.qorpera_cloud_secret_audit_events
		drop constraint qorpera_cloud_secret_audit_events_event_type_check,
		add constraint qorpera_cloud_secret_audit_events_event_type_check check (event_type in (%s))',
		(select string_agg(quote_literal(t), ', ' order by o)
			from unnest(v_types || array['hook_secret_made', 'hook_secret_used']) with ordinality as u(t, o)));
end $$;

-- 2. The run effect, with or without the vault ----------------------------------------------------------------------------

create function public.qorpera_folder_manage_hook_effect(p_binding jsonb, p_request jsonb,
	p_vault public.qorpera_cloud_secret_broker_authorities, p_secret_id uuid, p_company_id uuid, p_environment_id uuid,
	p_key_id text, p_envelope bytea, p_envelope_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_action text; v_kind text; v_profile uuid; v_environment uuid; v_hook_id uuid; v_targets jsonb := '[]'::jsonb;
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_hook public.qorpera_event_hooks%rowtype; v_domain text; v_name text; v_status text;
	v_url text; v_signed boolean := false; v_site text;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930106000 (E3a): the request's shape. Every value a string, but the two limits, which are whole numbers.
	-- 20260930160000 (E3b): a hook may name the site its secret is typed into.
	if jsonb_typeof(p_request) is distinct from 'object'
		or jsonb_typeof(p_request -> 'operationKey') is distinct from 'string'
		or coalesce(p_request ->> 'operationKey', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request - array['maxBodyBytes','perMinute','proof','site']) k)
			is distinct from (case
				when p_request ->> 'action' in ('pause','resume','remove') then array['action','hook','operationKey']
				when p_request ->> 'action' = 'create' and p_request ->> 'kind' = 'hook'
					then array['action','kind','name','operationKey','purpose']
				when p_request ->> 'action' = 'create' and p_request ->> 'kind' = 'mailbox'
					then array['action','kind','localPart','operationKey','purpose'] end)
		or (p_request ?| array['maxBodyBytes','perMinute','proof','site'] and p_request ->> 'kind' is distinct from 'hook')
		or exists (select 1 from jsonb_each(p_request) e
			where (e.key in ('maxBodyBytes','perMinute') and (jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^[0-9]{1,9}$'))
				or (e.key not in ('maxBodyBytes','perMinute') and jsonb_typeof(e.value) <> 'string')) then
		raise exception 'Hook request is invalid' using errcode = '22023'; end if;
	v_action := p_request ->> 'action';
	v_kind := p_request ->> 'kind';
	-- E1's rules, word for word, before the receipt: a refusal here is the request's, never the company's state.
	if v_kind = 'hook' then
		if p_request ->> 'name' !~ '^[a-z][a-z0-9-]{0,63}$' or p_request ->> 'name' like 'mail-%' then
			raise exception 'A hook name uses lowercase letters, digits and hyphens, starts with a letter and has at most 64 characters'
				using errcode = '22023'; end if;
		if char_length(btrim(p_request ->> 'purpose')) not between 1 and 512 or p_request ->> 'purpose' ~ '[[:cntrl:]]' then
			raise exception 'A hook needs a purpose of one line, 1 to 512 characters' using errcode = '22023'; end if;
		if coalesce(p_request ->> 'proof', 'address') not in ('address', 'stripe', 'github', 'hmac-sha256') then
			raise exception 'A hook is proven by its address, or by a Stripe, GitHub or HMAC-SHA256 signature'
				using errcode = '22023'; end if;
		-- 20260930160000 (E3b): GitHub and HMAC hooks, whose secrets the vault makes and types into the sender's site
		-- (GitHub's unless named; an HMAC hook's sender is named). E3c takes Stripe's from Stripe's screen.
		if p_request ->> 'proof' = 'stripe' then
			raise exception 'A Stripe hook comes later: its secret is taken from Stripe''s screen' using errcode = '0A000'; end if;
		v_signed := coalesce(p_request ->> 'proof', 'address') in ('github', 'hmac-sha256');
		if not v_signed and p_request ? 'site' then
			raise exception 'Only a signed hook names the site its secret is typed into' using errcode = '22023'; end if;
		v_site := case when v_signed then coalesce(p_request ->> 'site',
			case when p_request ->> 'proof' = 'github' then 'github.com' end) end;
		if v_signed and v_site is null then
			raise exception 'An HMAC hook names the site its secret is typed into' using errcode = '22023'; end if;
		if v_signed and not public.qorpera_company_account_host_valid(v_site) then
			raise exception 'A site is a host name such as github.com' using errcode = '22023'; end if;
		if (p_request ->> 'maxBodyBytes')::bigint not between 1024 and 262144 then
			raise exception 'A hook body limit is between 1 KiB and 256 KiB' using errcode = '22023'; end if;
		if (p_request ->> 'perMinute')::bigint not between 1 and 120 then
			raise exception 'A hook accepts between 1 and 120 deliveries a minute' using errcode = '22023'; end if;
	elsif v_kind = 'mailbox' then
		if p_request ->> 'localPart' !~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$' or p_request ->> 'localPart' ~ '\.\.' then
			raise exception 'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores'
				using errcode = '22023'; end if;
		if p_request ->> 'localPart' in ('postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'administrator', 'root',
			'security', 'noc', 'noreply', 'no-reply', 'mailer-daemon', 'www', 'ftp', 'uucp', 'usenet', 'news') then
			raise exception 'This mailbox name is reserved' using errcode = '22023'; end if;
		if public.qorpera_mail_name_reads_as_qorpera(p_request ->> 'localPart') then
			raise exception 'A mailbox name that reads as Qorpera is reserved' using errcode = '22023'; end if;
		if char_length(btrim(p_request ->> 'purpose')) not between 1 and 512 or p_request ->> 'purpose' ~ '[[:cntrl:]]' then
			raise exception 'A mailbox purpose is one line of at most 512 characters' using errcode = '22023'; end if;
	elsif p_request ->> 'hook' !~ '^[a-z][a-z0-9-]{0,63}$' then
		raise exception 'No hook has this name' using errcode = 'P0002';
	end if;
	-- 20260930160000 (E3b): a signed hook is opened only through the vault, which opens nothing else; the broker's
	-- envelope is checked before any lock, as A1's opening checks its own.
	if p_vault.id is null and v_signed then
		raise exception 'A signed hook is opened through the vault' using errcode = '0A000'; end if;
	if p_vault.id is not null and not v_signed then
		raise exception 'The vault opens only a signed hook' using errcode = '22023'; end if;
	if p_vault.id is not null and (p_secret_id is null or p_key_id is distinct from p_vault.key_id or p_envelope is null
		or octet_length(p_envelope) not between 1 and 131072
		or p_envelope_sha256 is distinct from encode(extensions.digest(p_envelope, 'sha256'), 'hex')) then
		raise exception 'hook secret envelope is unavailable' using errcode = '42501'; end if;
	-- The target, from an unlocked read of the run's company: the live hook of that name, else the newest removed one (so
	-- a removed hook says so).
	if v_action <> 'create' and coalesce(p_binding ->> 'jobId', '') ~ c_uuid then
		select file.profile_id, file.environment_id into v_profile, v_environment from public.qorpera_runner_jobs job
		join public.qorpera_company_files file on file.environment_id = job.environment_id and file.core = 'folder-v2'
		where job.id = (p_binding ->> 'jobId')::uuid;
		select hook.id into v_hook_id from public.qorpera_event_hooks as hook
		where hook.profile_id = v_profile and hook.environment_id = v_environment and hook.name = p_request ->> 'hook'
		order by hook.status = 'removed', hook.created_at desc, hook.id limit 1;
		if v_hook_id is not null then
			v_targets := jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', v_hook_id::text,
				'mode', 'nokeyupdate', 'required', false));
		end if;
	end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, v_targets);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	-- 20260930160000 (E3b): the vault's company is the run's (read through the job before any lock; again under the run's
	-- locks), and the envelope was sealed for the run's company and environment.
	if p_vault.id is not null and p_vault.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501'; end if;
	if p_vault.id is not null and (p_company_id is distinct from v_run.profile_id
		or p_environment_id is distinct from v_run.environment_id) then
		raise exception 'hook secret envelope is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	-- A company agent's own run, never a worker's; and its requester an owner or admin, under the member row's lock.
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	v_digest := encode(extensions.digest(convert_to((jsonb_build_object('schema', 'qorpera.folder-hook/v1', 'runId', v_run.id,
		'action', v_action, 'operationKey', p_request ->> 'operationKey') || case
			when v_kind = 'hook' then jsonb_build_object('kind', v_kind, 'name', p_request ->> 'name',
				'purpose', btrim(p_request ->> 'purpose'), 'proof', coalesce(p_request ->> 'proof', 'address'),
				'maxBodyBytes', coalesce((p_request ->> 'maxBodyBytes')::integer, 65536),
				'perMinute', coalesce((p_request ->> 'perMinute')::integer, 60))
				-- 20260930160000 (E3b): a signed hook's site; an address hook's digest is E3a's.
				|| case when v_site is not null then jsonb_build_object('site', v_site) else '{}'::jsonb end
			when v_kind = 'mailbox' then jsonb_build_object('kind', v_kind, 'localPart', p_request ->> 'localPart',
				'purpose', btrim(p_request ->> 'purpose'))
			else jsonb_build_object('hook', p_request ->> 'hook') end)::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(p_binding, v_receipt_id, 'hook:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':hook:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'),
		false);
	if v_begun ->> 'state' = 'completed' then
		-- A replay: the first answer, with the hook read again for its address.
		v_result := v_begun -> 'result';
		select * into v_hook from public.qorpera_event_hooks where id = (v_result -> 'hook' ->> 'id')::uuid;
	else
		if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
			raise exception 'Hook operation needs reconciliation' using errcode = '55000'; end if;
		if v_action = 'create' then
			-- E1's per-company claim, after every row lock, for the caps and the live names; a mailbox then takes the mail
			-- domain FOR SHARE, last, as E1's creation does.
			perform pg_advisory_xact_lock(hashtextextended('qorpera.event-hooks:' || v_run.profile_id::text, 0));
			if v_kind = 'mailbox' then
				select settings.domain into v_domain from public.qorpera_mail_settings as settings for share;
				if v_domain is null then
					raise exception 'Company mail is not set up yet' using errcode = '0A000'; end if;
				if (select count(*) from public.qorpera_company_mailboxes
					where profile_id = v_run.profile_id and removed_at is null) >= 20 then
					raise exception 'A company has at most 20 mailboxes' using errcode = '54000'; end if;
			end if;
			if (select count(*) from public.qorpera_event_hooks as hook
				where hook.profile_id = v_run.profile_id and hook.status <> 'removed') >= 50 then
				raise exception 'A company has at most 50 hooks' using errcode = '54000'; end if;
			if v_kind = 'mailbox' then
				if exists (select 1 from public.qorpera_company_mailboxes
					where local_part = p_request ->> 'localPart' and removed_at is null) then
					raise exception 'This address is taken' using errcode = '23505'; end if;
				-- E1's name: mail-<local part>, or with a short digest when the local part does not fit a hook name.
				v_name := 'mail-' || (p_request ->> 'localPart');
				if v_name !~ '^[a-z][a-z0-9-]{0,63}$' then
					v_name := 'mail-' || left(regexp_replace(p_request ->> 'localPart', '[^a-z0-9-]', '-', 'g'), 52) || '-'
						|| left(encode(extensions.digest(p_request ->> 'localPart', 'sha256'), 'hex'), 6);
				end if;
			else
				v_name := p_request ->> 'name';
			end if;
			if exists (select 1 from public.qorpera_event_hooks as hook where hook.profile_id = v_run.profile_id
				and hook.environment_id = v_run.environment_id and hook.name = v_name and hook.status <> 'removed') then
				raise exception 'A hook with this name already exists' using errcode = '23505'; end if;
			if v_kind = 'mailbox' then
				begin
					insert into public.qorpera_event_hooks (
						profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_staff_agent_id
					) values (
						v_run.profile_id, v_run.environment_id, v_name, btrim(p_request ->> 'purpose'), 'mail',
						translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
						262144, 120, v_run.staff_agent_id
					) returning * into v_hook;
					insert into public.qorpera_company_mailboxes (hook_id, profile_id, environment_id, local_part, created_by_user_id)
					values (v_hook.id, v_run.profile_id, v_run.environment_id, p_request ->> 'localPart', null);
				exception when unique_violation then
					raise exception 'This address is taken' using errcode = '23505';
				end;
			else
				-- 20260930160000 (E3b): the broker's random id never collides in practice; if it did, the call fails as a
				-- broker fault (never a refusal the agent reads) and the next attempt draws a new id, as A1's opening does.
				if v_signed and exists (select 1 from public.qorpera_cloud_secrets as secret where secret.id = p_secret_id) then
					raise exception 'hook secret id is taken' using errcode = '42501'; end if;
				insert into public.qorpera_event_hooks (
					profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_staff_agent_id,
					secret_site
				) values (
					v_run.profile_id, v_run.environment_id, v_name, btrim(p_request ->> 'purpose'), coalesce(p_request ->> 'proof', 'address'),
					translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
					coalesce((p_request ->> 'maxBodyBytes')::integer, 65536), coalesce((p_request ->> 'perMinute')::integer, 60),
					v_run.staff_agent_id, v_site
				) returning * into v_hook;
				-- A signed hook's secret, in the same step: the company's, bound to this hook by W1b's name, created by the
				-- run's requester, version 1 the broker's envelope under this authority's key.
				if v_signed then
					insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
						owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
					values (p_secret_id, v_run.profile_id, v_run.environment_id, p_vault.id, 'company', null, 'event_hook',
						public.qorpera_event_hook_secret_name(v_hook.id), v_hook.purpose, 1, v_run.requested_by_user_id);
					insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id,
						encrypted_envelope, envelope_sha256, created_by_user_id)
					values (p_secret_id, 1, p_vault.id, p_key_id, p_envelope, p_envelope_sha256, v_run.requested_by_user_id);
					insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version,
						run_id, receipt_id, event_type, actor_user_id, connector_id)
					values (v_run.profile_id, v_run.environment_id, p_secret_id, 1, v_run.id, v_receipt_id, 'hook_secret_made',
						v_run.requested_by_user_id, 'event_hook');
				end if;
			end if;
		else
			if v_hook_id is null then
				raise exception 'No hook has this name' using errcode = 'P0002'; end if;
			-- Read again under the lock: the hook the target named, still this company's and still of that name.
			select * into v_hook from public.qorpera_event_hooks where id = v_hook_id;
			if v_hook.id is null or v_hook.profile_id <> v_run.profile_id or v_hook.environment_id <> v_run.environment_id
				or v_hook.name <> p_request ->> 'hook' then
				raise exception 'No hook has this name' using errcode = 'P0002'; end if;
			if v_hook.status = 'removed' then
				raise exception 'This hook was removed' using errcode = '55000'; end if;
			-- E2a's gate refuses a run whose event wake's hook is removed, and the receipt's completion checks the run again:
			-- the run this hook woke may pause it, never remove it.
			if v_action = 'remove' and exists (select 1 from public.qorpera_wake_occurrences as wake where wake.run_id = v_run.id
				and wake.source_kind = 'event' and wake.source_id = v_hook.id) then
				raise exception 'A run this hook woke cannot remove it; pause it instead' using errcode = '55000'; end if;
			v_status := case v_action when 'pause' then 'paused' when 'resume' then 'active' else 'removed' end;
			if v_hook.status <> v_status then
				update public.qorpera_event_hooks
				set status = v_status,
					removed_at = case when v_status = 'removed' then statement_timestamp() end,
					updated_at = statement_timestamp()
				where id = v_hook.id
				returning * into v_hook;
			end if;
		end if;
		v_result := jsonb_build_object('schema', 'qorpera.agent-hook-receipt/v1', 'runId', v_run.id, 'receiptId', v_receipt_id,
			'action', v_action, 'hook', public.qorpera_event_hook_descriptor(v_hook, false))
			-- 20260930160000 (E3b): a signed create's answer names where the hook's secret may be typed (a host, kept in the
			-- receipt); a pause, resume or removal answers as E3a's do.
			|| case when v_action = 'create' and v_hook.secret_site is not null
				then jsonb_build_object('secretSite', v_hook.secret_site) else '{}'::jsonb end;
		perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	end if;
	-- A create's answer: the hook's address, path and URL, from the row (never from the receipt), while the hook is live.
	if v_result ->> 'action' = 'create' and v_hook.proof <> 'mail' and v_hook.status <> 'removed' then
		select settings.public_url into v_url from public.qorpera_event_intake_settings as settings;
		v_result := v_result || jsonb_build_object('hook', (v_result -> 'hook') || jsonb_build_object('address', v_hook.address,
			'path', '/functions/v1/event-intake/' || v_hook.address) || case when v_url is not null
				then jsonb_build_object('url', v_url || '/functions/v1/event-intake/' || v_hook.address) else '{}'::jsonb end);
	end if;
	return v_result;
end $$;
revoke all on function public.qorpera_folder_manage_hook_effect(jsonb, jsonb, public.qorpera_cloud_secret_broker_authorities,
	uuid, uuid, uuid, text, bytea, text) from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The host's path: E3a's function, now the effect with no vault (its grants stay).
create or replace function public.qorpera_folder_manage_hook(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930106000 (E3a), 20260930160000 (E3b): with no vault, a signed proof is refused.
	return public.qorpera_folder_manage_hook_effect(p_binding, p_request, null::public.qorpera_cloud_secret_broker_authorities,
		null, null, null, null, null, null);
end $$;

-- 3. The broker's calls ---------------------------------------------------------------------------------------------------

-- A1's broker checks (as qorpera_company_account_call makes them), before any lock: the broker's session, its authority
-- and capability (null-safe), a job of the authority's company, and that company on the company folder. Not gated by A1's
-- switch, which is the accounts'.
create function public.qorpera_folder_signed_hook_authority(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb)
returns public.qorpera_cloud_secret_broker_authorities
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	-- 20260930160000 (E3b): plain reads only.
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_binding is null or jsonb_typeof(p_binding) <> 'object' then
		raise exception 'hook run binding is malformed' using errcode = '22023';
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	if not found or p_broker_capability_sha256 is null or v_authority.status is distinct from 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	if coalesce((p_binding ->> 'jobId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', true)
		or not exists (select 1 from public.qorpera_runner_jobs as job
			where job.id = (p_binding ->> 'jobId')::uuid and job.profile_id = v_authority.profile_id) then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	if not public.qorpera_binding_is_folder_v2(p_binding) then
		raise exception 'Hooks need a company on the company folder' using errcode = '0A000';
	end if;
	return v_authority;
end
$$;
revoke all on function public.qorpera_folder_signed_hook_authority(uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Before it makes a hook's secret the broker reads what the envelope's associated data needs: the run's company and
-- environment and the company's key id, after the run check and the effect's checks of the run and its requester. No
-- receipt, no vault row.
create function public.qorpera_folder_describe_signed_hook(p_broker_authority_id uuid, p_broker_capability_sha256 text,
	p_binding jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	-- 20260930160000 (E3b): the broker's checks, the run check, then the run and its requester as the effect checks them.
	v_authority := public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-signed-hook-context/v1', 'companyId', v_run.profile_id,
		'environmentId', v_run.environment_id, 'keyId', v_authority.key_id);
end
$$;

-- The broker opens a signed hook for the agent's manage_hook create: the effect with the vault. The broker chose the
-- secret's id and sealed it, with the run's company and environment, into the envelope's associated data, so all three
-- come in and must match.
create function public.qorpera_folder_open_signed_hook(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_request jsonb,
	p_secret_id uuid,
	p_company_id uuid,
	p_environment_id uuid,
	p_key_id text,
	p_encrypted_envelope bytea,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
begin
	-- 20260930160000 (E3b): the broker's checks before any lock, then manage_hook's effect with the vault.
	return public.qorpera_folder_manage_hook_effect(p_binding, p_request,
		public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding),
		p_secret_id, p_company_id, p_environment_id, p_key_id, p_encrypted_envelope, p_envelope_sha256);
end
$$;

-- The vault's read for one fill of a hook's secret. Bound, as A1's fill is, to the agent's executing `computer_browser`
-- receipt of exactly this `vault_fill` call (the broker passes the call's operation envelope; its SHA-256 is the receipt's
-- input digest) and the computer the run's screen lease holds, at its current generation and with its current boot's key.
-- The hook is the run's company's, live (active or paused) and signed, with a site the secret may be typed into and a
-- secret sealed for this authority; the run is a company agent's, its requester an owner or admin. Plain reads before
-- any lock; then the run check with the hook (rank 5, FOR SHARE, so a removal waits), the computer (plain reads), the
-- hook's secret, and last the receipt.
create function public.qorpera_fill_event_hook_secret(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_envelope jsonb;
	v_operation jsonb;
	v_target jsonb;
	v_hook_id uuid;
	v_targets jsonb := '[]'::jsonb;
	v_office public.qorpera_runtime_offices%rowtype;
	v_key text;
	v_hook public.qorpera_event_hooks%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930160000 (E3b): the broker's checks, the call, the run check with the hook, the computer, the secret, then
	-- the receipt.
	v_authority := public.qorpera_folder_signed_hook_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	-- The call itself: one vault_fill of a hook's secret into the company computer's browser, read before any lock.
	if p_envelope is null or octet_length(p_envelope) > 65536 then
		raise exception 'hook secret fill call is malformed' using errcode = '22023';
	end if;
	begin
		v_envelope := p_envelope::jsonb;
	exception when others then
		raise exception 'hook secret fill call is malformed' using errcode = '22023';
	end;
	v_operation := v_envelope -> 'operation';
	v_target := v_operation #> '{target,binding}';
	if jsonb_typeof(v_envelope) is distinct from 'object'
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_operation ->> 'tool' is distinct from 'computer_browser'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.company-computer-tools/v2'
		or v_operation #>> '{target,realm}' is distinct from 'company_computer'
		or not coalesce(public.qorpera_valid_office_browser_action(v_operation -> 'arguments'), false)
		or v_operation #>> '{arguments,action}' is distinct from 'vault_fill'
		or v_operation #>> '{arguments,field}' is distinct from 'signing_secret'
		or jsonb_typeof(v_target) is distinct from 'object'
		or coalesce(v_target ->> 'companyComputerId' !~ v_uuid, true)
		or coalesce(v_target ->> 'screenId' !~ v_uuid, true)
		or coalesce(v_target ->> 'computerGeneration' !~ '^[1-9][0-9]{0,15}$', true) then
		raise exception 'hook secret fill call is malformed' using errcode = '22023';
	end if;
	v_hook_id := (v_operation #>> '{arguments,hook}')::uuid;
	-- The hook, from an unlocked read within the job's company (the lock target names no company): held FOR SHARE.
	if exists (select 1 from public.qorpera_runner_jobs as job
		join public.qorpera_event_hooks as hook on hook.profile_id = job.profile_id and hook.environment_id = job.environment_id
		where job.id = (p_binding ->> 'jobId')::uuid and hook.id = v_hook_id) then
		v_targets := jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', v_hook_id::text,
			'mode', 'share', 'required', false));
	end if;
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs,
		public.qorpera_folder_tool_run(p_binding, v_targets) -> 'run');
	if v_authority.profile_id is distinct from v_run.profile_id then
		raise exception 'cloud secret broker does not serve this company' using errcode = '42501';
	end if;
	-- The run and its requester as manage_hook checks them: typing a hook's secret is part of opening it.
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Hook authority is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(v_run.profile_id) or not exists (select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id
			and member.role::text in ('owner', 'admin')) then
		raise exception 'Only owners and admins can open hooks; ask one of them' using errcode = '42501'; end if;
	-- The hook, read again under its lock.
	select * into v_hook from public.qorpera_event_hooks where id = v_hook_id;
	if v_hook.id is null or v_hook.profile_id <> v_run.profile_id or v_hook.environment_id <> v_run.environment_id then
		raise exception 'No hook has this id' using errcode = 'P0002'; end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000'; end if;
	if v_hook.secret_site is null then
		raise exception 'This hook has no secret the vault types' using errcode = '0A000'; end if;
	-- The computer the run's screen lease holds now, at the generation the call names, and that boot's key: plain reads.
	select office.* into v_office from public.qorpera_runtime_offices as office
	where office.id = (v_target ->> 'companyComputerId')::uuid
		and office.profile_id = v_run.profile_id and office.environment_id = v_run.environment_id;
	if not found or v_office.generation is distinct from (v_target ->> 'computerGeneration')::bigint
		or not exists (select 1 from public.qorpera_runtime_office_screens as screen
			where screen.id = (v_target ->> 'screenId')::uuid and screen.office_id = v_office.id
				and screen.run_id = v_run.id and screen.staff_agent_id = v_run.staff_agent_id
				and screen.lease_id is not null and screen.lease_expires_at > clock_timestamp()) then
		raise exception 'company computer lease is unavailable' using errcode = '42501';
	end if;
	select activation.fill_public_key into v_key from public.qorpera_runtime_office_activations as activation
	where activation.office_id = v_office.id and activation.computer_generation = v_office.generation
		and activation.superseded_at is null and activation.state = 'active';
	if v_key is null then
		raise exception 'The computer cannot type account values right now: it is still starting, or it needs a restart on a newer version'
			using errcode = '0A000';
	end if;
	-- The hook's secret, after the hook (as a removal revokes it), and its current version, sealed for this authority.
	select secret.* into v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = (public.qorpera_event_hook_secret(v_hook)).id
	for share;
	if not found or v_secret.status is distinct from 'active' then
		raise exception 'This hook''s secret is gone from the vault' using errcode = '55000';
	end if;
	select version.* into v_version from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_secret.id and version.version = v_secret.current_version;
	if not found or v_version.broker_authority_id is distinct from v_authority.id
		or v_version.key_id is distinct from v_authority.key_id then
		raise exception 'hook secret version is unavailable' using errcode = '42501';
	end if;
	-- Run-owned rows after the vault rows (C1C §5.7): this vault_fill call's receipt.
	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_run.id
	for update;
	if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
		or v_receipt.requires_company_revision is distinct from false
		or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)
		or v_receipt.downstream_idempotency_sha256 is distinct from p_downstream_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'computer_browser:' || (v_operation ->> 'logicalOperationKey') then
		raise exception 'hook secret fill receipt is unavailable' using errcode = '42501';
	end if;
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version, run_id,
		receipt_id, event_type, actor_user_id, connector_id)
	values (v_run.profile_id, v_run.environment_id, v_secret.id, v_version.version, v_run.id, p_receipt_id,
		'hook_secret_used', v_run.requested_by_user_id, 'event_hook');
	return jsonb_build_object(
		'schema', 'qorpera.event-hook-fill-context/v1',
		'hookId', v_hook.id,
		'proof', v_hook.proof,
		-- The only site the secret may be typed into.
		'site', v_hook.secret_site,
		'secretId', v_secret.id,
		'version', v_version.version,
		-- The envelope's associated data, for the broker to open it.
		'companyId', v_secret.profile_id,
		'environmentId', v_secret.environment_id,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		-- What the sealed box is bound to.
		'receiptId', p_receipt_id,
		'field', 'signing_secret',
		'companyComputerId', v_office.id,
		'computerGeneration', v_office.generation,
		'fillPublicKey', v_key
	);
end
$$;

revoke all on function public.qorpera_folder_describe_signed_hook(uuid, text, jsonb),
	public.qorpera_folder_open_signed_hook(uuid, text, jsonb, jsonb, uuid, uuid, uuid, text, bytea, text),
	public.qorpera_fill_event_hook_secret(uuid, text, jsonb, uuid, text, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_describe_signed_hook(uuid, text, jsonb),
	public.qorpera_folder_open_signed_hook(uuid, text, jsonb, jsonb, uuid, uuid, uuid, text, bytea, text),
	public.qorpera_fill_event_hook_secret(uuid, text, jsonb, uuid, text, text)
	to qorpera_secret_broker;

-- 4. The browser action: vault_fill of a hook's secret ----------------------------------------------------------------------

select pg_temp.e3b_replace('public.qorpera_valid_office_browser_action(jsonb)'::regprocedure,
	$old$    when 'vault_fill' then
        -- A password box is a textbox to the accessibility tree; a number box for a code is a spinbutton.
        v_keys:=v_keys||array['role','name','account','field'];
        if coalesce(p_args->>'role','') not in ('textbox','spinbutton')
            or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
            or octet_length(p_args->>'name')>512
            or jsonb_typeof(p_args->'account') is distinct from 'string'
            or (p_args->>'account') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or coalesce(p_args->>'field','') not in ('login','password','code') then return false; end if;
    when 'press' then$old$,
	$new$    when 'vault_fill' then
        -- A password box is a textbox to the accessibility tree; a number box for a code is a spinbutton.
        -- 20260930160000 (E3b): or a hook's signing secret, typed into a text box the guest makes a password box.
        if p_args ? 'hook' then
            v_keys:=v_keys||array['role','name','hook','field'];
            if coalesce(p_args->>'role','') <> 'textbox'
                or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
                or octet_length(p_args->>'name')>512
                or jsonb_typeof(p_args->'hook') is distinct from 'string'
                or (p_args->>'hook') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                or coalesce(p_args->>'field','') <> 'signing_secret' then return false; end if;
        else
            v_keys:=v_keys||array['role','name','account','field'];
            if coalesce(p_args->>'role','') not in ('textbox','spinbutton')
                or jsonb_typeof(p_args->'name') is distinct from 'string' or length(btrim(p_args->>'name'))=0
                or octet_length(p_args->>'name')>512
                or jsonb_typeof(p_args->'account') is distinct from 'string'
                or (p_args->>'account') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                or coalesce(p_args->>'field','') not in ('login','password','code') then return false; end if;
        end if;
    when 'press' then$new$);

-- 5. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_folder_manage_hook_effect(jsonb,jsonb,public.qorpera_cloud_secret_broker_authorities,uuid,uuid,uuid,text,bytea,text)',
		'public.qorpera_folder_manage_hook(jsonb,jsonb)',
		'public.qorpera_folder_signed_hook_authority(uuid,text,jsonb)',
		'public.qorpera_folder_describe_signed_hook(uuid,text,jsonb)',
		'public.qorpera_folder_open_signed_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,bytea,text)',
		'public.qorpera_fill_event_hook_secret(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_valid_office_browser_action(jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930160000') = 0 then
			raise exception 'E3b marker is missing in %', v_function; end if;
	end loop;
end $guard$;
