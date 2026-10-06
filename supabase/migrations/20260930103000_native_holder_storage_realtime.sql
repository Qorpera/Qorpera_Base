-- G2-4: the native host reaches Storage and Realtime without the service key (deploy/first-node/RUNTIME-NATIVE-HOST-KEY.md,
-- "G2-4"). Its two last uses of the key in a guest were the credential capsule store (bucket
-- qorpera-native-compute-capsules, objects `<capsule id>.capsule`) and the company presence client (private Realtime
-- topic qorpera-presence-<company>). Both now use the publishable key (anon) and carry the holder's credential in the
-- request header x-qorpera-identity, which hosted Storage and Realtime hand to the row policies in request.headers
-- (proven on hosted 4 Oct 2026; Supabase's request logs keep no value of it: the gateway logs fixed header keys only):
-- * `job.<job id>.<lease token>`: the runner job's lease token, as qorpera_native_host_call checks it (20260928409985):
--   the job leased, an agent turn, the lease unexpired, then the token's hash, by the job's primary key;
-- * `identity.<credential>`: the identity credential the node host bound to the holder's machine allocation, as
--   qorpera_native_identity_call checks it (20260928469140): the allocation unreleased, the identity active and not in
--   recovery, in the allocation's company, and the holder's own machine (its runner, or its sign-in or refresh).
--
-- What each holder may reach (qorpera_native_holder, read by the policies through two narrow functions):
-- * a job: its identity's active capsules (read: the account metadata loop also runs during a job) and its run's
--   leased capsule (create, write back), and its company's presence topic while its run has a live presence device
--   (qorpera_native_presence_register records one only for a company-audience run);
-- * an identity holder (a job guest, an execution host's slot, a refresh's login guest): its identity's active
--   capsules, read only (the account metadata loop);
-- * a sign-in's login guest while its sign-in is pending: one object, `<sign-in id>.capsule` (read, create, write
--   again on a retry). A sign-in's capsule is named for its sign-in: the entry point now refuses a completion whose
--   capsule id is not the sign-in's own, so a login guest can never reach, or claim, another sign-in's capsule.
-- No holder may delete, list beyond its own names, or reach another company. A request without a valid header is
-- anon's as before: nothing in the bucket, no presence topic.
--
-- The policies read the holder once per statement (each helper inside a scalar subquery), take no lock, and check the
-- credential's hash before anything else, so a refused request waits for nothing. The bucket's size limit becomes the
-- client's encrypted maximum (64 MiB + 1 MiB); it was 64 MiB, so the largest capsules were refused.
set local lock_timeout = '3s';

-- 1. The holder -------------------------------------------------------------------------------------------------------

create function public.qorpera_native_holder()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_header text; v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_credential public.qorpera_native_identity_credentials%rowtype;
	v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype; v_objects text[]; v_read text[];
begin
	begin
		v_header := nullif(current_setting('request.headers', true), '')::json ->> 'x-qorpera-identity';
	exception when others then return null;
	end;
	if v_header ~ '^job\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$' then
		-- The lease token first, by the job's primary key, with no lock.
		select job.* into v_job from public.qorpera_runner_jobs as job where job.id = split_part(v_header, '.', 2)::uuid;
		if not found or v_job.status <> 'leased' or v_job.job_type <> 'agent_turn' or v_job.required_capability <> 'agent_turn'
			or v_job.run_id is null or v_job.lease_token_sha256 is null
			or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp()
			or v_job.lease_token_sha256 <> encode(extensions.digest(convert_to(split_part(v_header, '.', 3), 'utf8'), 'sha256'), 'hex') then
			return null; end if;
		select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if not found then return null; end if;
		select array_agg(substr(capsule.encrypted_capsule_reference, 16) || '.capsule') into v_objects
		from public.qorpera_native_provider_connection_leases as lease
		join public.qorpera_native_credential_capsules as capsule on capsule.id = lease.credential_capsule_id
		where lease.job_id = v_job.id and lease.run_id = v_run.id and lease.status = 'active'
			and capsule.profile_id = v_run.profile_id and capsule.status = 'active'
			and capsule.encrypted_capsule_reference = 'native-capsule/' || capsule.id::text;
		select array_agg(substr(capsule.encrypted_capsule_reference, 16) || '.capsule') into v_read
		from public.qorpera_native_credential_capsules as capsule
		where capsule.compute_identity_id = v_run.compute_identity_id and capsule.profile_id = v_run.profile_id
			and capsule.status = 'active' and capsule.encrypted_capsule_reference = 'native-capsule/' || capsule.id::text;
		return jsonb_build_object('read', to_jsonb(coalesce(v_read, '{}') || coalesce(v_objects, '{}')),
			'write', to_jsonb(coalesce(v_objects, '{}')),
			'presenceTopic', case when exists (select 1 from public.qorpera_native_presence_devices as device
				where device.run_id = v_run.id and device.profile_id = v_run.profile_id and device.expires_at > clock_timestamp())
				then 'qorpera-presence-' || v_run.profile_id::text end);
	elsif v_header ~ '^identity\.[A-Za-z0-9_-]{43}$' then
		-- The credential first, by its hash, with no lock.
		select credential.* into v_credential from public.qorpera_native_identity_credentials as credential
		where credential.credential_sha256 = encode(extensions.digest(convert_to(substr(v_header, 10), 'utf8'), 'sha256'), 'hex');
		if not found then return null; end if;
		select allocation.* into v_allocation from public.qorpera_runtime_machine_allocations as allocation
		where allocation.id = v_credential.allocation_id;
		select identity.* into v_identity from public.qorpera_member_compute_identities as identity
		where identity.id = v_credential.compute_identity_id;
		if v_allocation.id is null or v_allocation.released_at is not null or v_identity.id is null
			or v_identity.status is distinct from 'active' or v_identity.recovery_pending_id is not null
			or v_identity.profile_id is distinct from v_allocation.profile_id
			or (case v_credential.holder_kind
				when 'login_guest' then v_allocation.login_compute_identity_id is not distinct from v_identity.id
				else exists (select 1 from public.qorpera_runners as runner
					where runner.id = v_allocation.runner_id and runner.compute_identity_id = v_identity.id
						and runner.status is distinct from 'revoked' and runner.compute_recovery_epoch = v_identity.recovery_epoch)
				end) is not true then
			return null; end if;
		if v_credential.holder_kind = 'login_guest' and v_allocation.login_session_id is not null then
			-- A sign-in's login guest: its sign-in's own capsule, while the sign-in is pending.
			if not exists (select 1 from public.qorpera_native_provider_login_sessions as login
				where login.id = v_allocation.login_session_id and login.compute_identity_id = v_identity.id
					and login.profile_id = v_identity.profile_id and login.status = 'pending'
					and login.expires_at > clock_timestamp()) then
				return null; end if;
			v_objects := array[v_allocation.login_session_id::text || '.capsule'];
			return jsonb_build_object('read', to_jsonb(v_objects), 'write', to_jsonb(v_objects));
		end if;
		if v_credential.holder_kind = 'login_guest' and v_allocation.account_refresh_request_id is null then
			return null; end if;
		select array_agg(substr(capsule.encrypted_capsule_reference, 16) || '.capsule') into v_objects
		from public.qorpera_native_credential_capsules as capsule
		where capsule.compute_identity_id = v_identity.id and capsule.profile_id = v_identity.profile_id
			and capsule.status = 'active' and capsule.encrypted_capsule_reference = 'native-capsule/' || capsule.id::text;
		return jsonb_build_object('read', to_jsonb(coalesce(v_objects, '{}')), 'write', '[]'::jsonb);
	end if;
	return null;
end
$$;
revoke all on function public.qorpera_native_holder() from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The capsule objects the request's holder may read (p_write false) or create and write (p_write true); none without
-- a valid header.
create function public.qorpera_native_holder_capsules(p_write boolean)
returns text[] language sql stable security definer set search_path = '' as $$
	select coalesce(array(select jsonb_array_elements_text(holder -> case when p_write then 'write' else 'read' end)), '{}')
	from (select public.qorpera_native_holder() as holder) as request
$$;
-- The company presence topic the request's holder may join; null without one.
create function public.qorpera_native_holder_presence_topic()
returns text language sql stable security definer set search_path = '' as $$
	select public.qorpera_native_holder() ->> 'presenceTopic'
$$;
revoke all on function public.qorpera_native_holder_capsules(boolean), public.qorpera_native_holder_presence_topic()
	from public, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_native_holder_capsules(boolean), public.qorpera_native_holder_presence_topic()
	to anon;

-- 2. The capsule bucket -----------------------------------------------------------------------------------------------

create policy qorpera_native_capsule_holder_read on storage.objects for select to anon
	using (bucket_id = 'qorpera-native-compute-capsules'
		and name = any ((select public.qorpera_native_holder_capsules(false))::text[]));
create policy qorpera_native_capsule_holder_create on storage.objects for insert to anon
	with check (bucket_id = 'qorpera-native-compute-capsules'
		and name = any ((select public.qorpera_native_holder_capsules(true))::text[]));
create policy qorpera_native_capsule_holder_write on storage.objects for update to anon
	using (bucket_id = 'qorpera-native-compute-capsules'
		and name = any ((select public.qorpera_native_holder_capsules(true))::text[]))
	with check (bucket_id = 'qorpera-native-compute-capsules'
		and name = any ((select public.qorpera_native_holder_capsules(true))::text[]));

update storage.buckets set file_size_limit = 64 * 1024 * 1024 + 1024 * 1024
where id = 'qorpera-native-compute-capsules';

-- 3. The company presence topic ---------------------------------------------------------------------------------------

-- A job's native host joins its company's presence topic as anon, receives and publishes there (presence track and
-- signal broadcasts), and only there; the members' policies are unchanged.
create policy qorpera_presence_native_receive on realtime.messages for select to anon
	using (realtime.messages.extension in ('presence', 'broadcast')
		and realtime.messages.topic = (select realtime.topic())
		and realtime.messages.topic = (select public.qorpera_native_holder_presence_topic()));
create policy qorpera_presence_native_publish on realtime.messages for insert to anon
	with check (realtime.messages.extension in ('presence', 'broadcast')
		and realtime.messages.topic = (select realtime.topic())
		and realtime.messages.topic = (select public.qorpera_native_holder_presence_topic()));

-- 4. A sign-in's capsule is named for its sign-in --------------------------------------------------------------------

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_native_identity_dispatch(uuid,text,text,jsonb)'::regprocedure);
	v_old text := E'\t\t\t\t\t\tand p_args ->> ''p_encrypted_capsule_reference'' = ''native-capsule/'' || (p_args ->> ''p_capsule_id'')))\n';
	v_new text := E'\t\t\t\t\t\tand p_args ->> ''p_encrypted_capsule_reference'' = ''native-capsule/'' || (p_args ->> ''p_capsule_id'')\n'
		|| E'\t\t\t\t\t\t-- 20260930103000: named for the sign-in, the one capsule its login guest may write (G2-4).\n'
		|| E'\t\t\t\t\t\tand p_args ->> ''p_capsule_id'' = v_allocation.login_session_id::text))\n';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'G2-4: the sign-in completion check of qorpera_native_identity_dispatch moved'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
