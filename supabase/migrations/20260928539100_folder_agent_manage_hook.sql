-- Company folder core, C4 (E3a, Q1): agents open hooks and mailboxes on folder-v2
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5; agreed with the coordinator on 6 October 2026).
--
-- An agent's manage_hook tool creates an address hook or a mailbox for its company, and pauses, resumes or removes one.
-- * One function, qorpera_folder_manage_hook(p_binding, p_request), host-dispatched with the binding's scope, as
--   qorpera_folder_cancel_agent_worker is. A run effect: the run check (qorpera_folder_tool_run, whose entry holds the
--   company row at rank 0 and the requester's member row at rank 1 KEY SHARE; a pause, resume or remove adds the hook at
--   rank 5 FOR NO KEY UPDATE, as E1's status change does), the role check under those locks, the run receipt (key
--   hook:<operationKey>; a replay answers from it), then for a creation E1's per-company advisory claim and, for a
--   mailbox, the mail domain FOR SHARE, last; then E1's caps, names and insert, or the status change.
-- * Authority: the run's requester is an owner or admin, as for E1's Settings calls and as list_hooks shows addresses only
--   to such a run. The agent acts with its requester's authority, never more; a worker never opens a hook. The hook
--   records the agent (created_by_staff_agent_id), which E1's connection file shows as createdBy.
-- * The request is checked before the receipt (its shape, then E1's name, purpose and limit rules, word for word); the
--   company's state after it (the caps, a taken name or address, the mail domain, the hook by name).
-- * A run that a hook's event woke may pause that hook but not remove it: E2a's gate refuses the run once its wake's hook
--   is removed, and the receipt's completion checks the run again.
-- * Signed hooks come later (E3b: GitHub and HMAC with a secret the vault makes; E3c: Stripe's secret taken from the
--   screen): any proof but address is refused.
-- * A create's answer carries the hook's address, path and URL, read from the hook row for each answer; the receipt keeps
--   the hook without its address (a capability), so it is never stored outside the hook row. A mailbox's email address
--   is public by nature and in both.
-- * The connection file follows the commit, through E1's marks.
-- Every inserted text names this migration (20260930106000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_folder_manage_hook(jsonb,jsonb)') is not null then
		raise exception 'E3a (20260930106000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.e3a_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'E3a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The run effect ------------------------------------------------------------------------------------------------------

create function public.qorpera_folder_manage_hook(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_action text; v_kind text; v_profile uuid; v_environment uuid; v_hook_id uuid; v_targets jsonb := '[]'::jsonb;
	v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_digest text; v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_hook public.qorpera_event_hooks%rowtype; v_domain text; v_name text; v_status text;
	v_url text;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930106000 (E3a): the request's shape. Every value a string, but the two limits, which are whole numbers.
	if jsonb_typeof(p_request) is distinct from 'object'
		or jsonb_typeof(p_request -> 'operationKey') is distinct from 'string'
		or coalesce(p_request ->> 'operationKey', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_request - array['maxBodyBytes','perMinute','proof']) k)
			is distinct from (case
				when p_request ->> 'action' in ('pause','resume','remove') then array['action','hook','operationKey']
				when p_request ->> 'action' = 'create' and p_request ->> 'kind' = 'hook'
					then array['action','kind','name','operationKey','purpose']
				when p_request ->> 'action' = 'create' and p_request ->> 'kind' = 'mailbox'
					then array['action','kind','localPart','operationKey','purpose'] end)
		or (p_request ?| array['maxBodyBytes','perMinute','proof'] and p_request ->> 'kind' is distinct from 'hook')
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
		-- E3b and E3c bring signed hooks, whose secrets the vault makes or takes from the screen, never the model.
		if coalesce(p_request ->> 'proof', 'address') <> 'address' then
			raise exception 'A signed hook comes later; use an address hook for now' using errcode = '0A000'; end if;
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
				insert into public.qorpera_event_hooks (
					profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_staff_agent_id
				) values (
					v_run.profile_id, v_run.environment_id, v_name, btrim(p_request ->> 'purpose'), 'address',
					translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
					coalesce((p_request ->> 'maxBodyBytes')::integer, 65536), coalesce((p_request ->> 'perMinute')::integer, 60),
					v_run.staff_agent_id
				) returning * into v_hook;
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
			'action', v_action, 'hook', public.qorpera_event_hook_descriptor(v_hook, false));
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
revoke all on function public.qorpera_folder_manage_hook(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_manage_hook(jsonb, jsonb) to service_role;

-- The native host may call it (G2), with the binding's scope, as the cancel of a worker.
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_folder_manage_hook', 'binding');

-- 2. Observations name the new tool -------------------------------------------------------------------------------------

select pg_temp.e3a_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'company_search','company_account',$old$,
	$new$'company_search','company_account','manage_hook' /* 20260930106000 (E3a) */,$new$);

-- 3. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_folder_manage_hook(jsonb,jsonb)', 'public.qorpera_record_runtime_observation(uuid,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930106000') = 0 then
			raise exception 'E3a marker is missing in %', v_function; end if;
	end loop;
end $guard$;
