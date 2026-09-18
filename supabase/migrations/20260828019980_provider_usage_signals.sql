-- Runtime Order 1 (contract section 17, 2026-09-01 amendment placement): a
-- typed usage-limit signal from provider adapters and the member notification.
-- The native adapter distinguishes quota exhaustion (usage_limit) from
-- transient rate limiting (rate_limited) and provider outage
-- (provider_outage) from the harness's safe failure category, never from
-- provider text. The control plane records the signal against the exact run,
-- sponsor version and provider connection version, and notifies the member
-- who owns that connection once per open limit. Automatic sponsor handoff
-- (Order 3, acceptance 29) reads these records; it is not performed here.

create table public.qorpera_provider_connection_usage_signals (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	sponsor_binding_id uuid not null,
	sponsor_version bigint not null,
	provider_connection_id uuid not null references public.qorpera_provider_connections(id) on delete restrict,
	provider_connection_version bigint not null,
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	signal_kind text not null check (signal_kind in ('usage_limit','rate_limited','provider_outage')),
	source text not null check (source in ('native_adapter')),
	observed_at timestamptz not null default clock_timestamp(),
	resets_at timestamptz,
	foreign key (sponsor_binding_id,sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id,version) on delete restrict,
	foreign key (provider_connection_id,provider_connection_version)
		references public.qorpera_provider_connection_versions(connection_id,version) on delete restrict,
	unique (run_id,signal_kind)
);
create index qorpera_provider_connection_usage_signals_connection
	on public.qorpera_provider_connection_usage_signals(provider_connection_id,observed_at desc);
alter table public.qorpera_provider_connection_usage_signals enable row level security;
revoke all on public.qorpera_provider_connection_usage_signals from public,anon,authenticated,service_role;

-- Durable member notifications. A notification is a closed metadata record
-- addressed to one member; it carries identities, never prompt, transcript,
-- credential or provider text. At most one open notification exists per
-- member, kind and dedupe key; acknowledging it lets the next event notify
-- again.
create table public.qorpera_member_notifications (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	kind text not null constraint qorpera_member_notifications_kind check (kind in ('provider_usage_limit','company_ceiling_tripped')),
	subject jsonb not null check (jsonb_typeof(subject) = 'object' and pg_column_size(subject) <= 4096),
	dedupe_key text not null check (char_length(dedupe_key) between 1 and 256),
	created_at timestamptz not null default clock_timestamp(),
	acknowledged_at timestamptz
);
create unique index qorpera_member_notifications_open
	on public.qorpera_member_notifications(profile_id,user_id,kind,dedupe_key) where acknowledged_at is null;
create index qorpera_member_notifications_member
	on public.qorpera_member_notifications(user_id,profile_id,created_at desc);
alter table public.qorpera_member_notifications enable row level security;
revoke all on public.qorpera_member_notifications from public,anon,authenticated,service_role;

create function public.qorpera_member_notification_json(p_notification public.qorpera_member_notifications)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object(
		'schema','qorpera.member-notification/v1','notification_id',p_notification.id,
		'profile_id',p_notification.profile_id,'kind',p_notification.kind,'subject',p_notification.subject,
		'created_at',p_notification.created_at,'acknowledged_at',p_notification.acknowledged_at)
$$;

create function public.qorpera_record_provider_usage_signal(
	p_binding jsonb,p_signal_kind text,p_resets_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_signal public.qorpera_provider_connection_usage_signals%rowtype;
	v_recipient uuid; v_notified uuid[] := '{}'::uuid[]; v_replayed boolean := false;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Provider usage signals require native host authority' using errcode = '42501'; end if;
	if p_signal_kind is null or p_signal_kind not in ('usage_limit','rate_limited','provider_outage')
		or (p_resets_at is not null and p_resets_at not between clock_timestamp() - interval '1 day'
			and clock_timestamp() + interval '90 days') then
		raise exception 'Provider usage signal is invalid' using errcode = '22023'; end if;
	-- The binding must name the run's current native lease; a stale or foreign
	-- binding cannot label another member's connection.
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	select * into strict v_lease from public.qorpera_native_provider_connection_leases
	where id = (p_binding ->> 'leaseId')::uuid and run_id = v_run.id;
	select * into strict v_connection from public.qorpera_provider_connections
	where id = v_lease.provider_connection_id;
	insert into public.qorpera_provider_connection_usage_signals(profile_id,run_id,job_id,sponsor_binding_id,
		sponsor_version,provider_connection_id,provider_connection_version,provider,signal_kind,source,resets_at)
	values (v_run.profile_id,v_run.id,v_run.job_id,v_run.sponsor_binding_id,v_run.sponsor_version,
		v_lease.provider_connection_id,v_lease.provider_connection_version,v_connection.provider,
		p_signal_kind,'native_adapter',p_resets_at)
	on conflict (run_id,signal_kind) do nothing returning * into v_signal;
	if v_signal.id is null then
		v_replayed := true;
		select * into strict v_signal from public.qorpera_provider_connection_usage_signals
		where run_id = v_run.id and signal_kind = p_signal_kind;
	end if;
	if p_signal_kind = 'usage_limit' then
		-- A member connection notifies its owner; a company connection notifies
		-- the company's owners and admins. Never another member.
		for v_recipient in
			select recipient.user_id from (
				select v_connection.owner_user_id user_id where v_connection.owner_user_id is not null
				union
				select member.user_id from public.qorpera_profile_members member
				where v_connection.owner_user_id is null and member.profile_id = v_run.profile_id
					and member.role in ('owner','admin')
			) recipient order by recipient.user_id loop
			insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
			values (v_run.profile_id,v_recipient,'provider_usage_limit',jsonb_build_object(
				'schema','qorpera.member-notification.provider-usage-limit/v1','signalId',v_signal.id,
				'connectionId',v_connection.id,'connectionVersion',v_lease.provider_connection_version,
				'provider',v_connection.provider,'runId',v_run.id,'sponsorBindingId',v_run.sponsor_binding_id,
				'sponsorVersion',v_run.sponsor_version,'resetsAt',p_resets_at),
				v_connection.id::text || ':' || v_lease.provider_connection_version::text)
			on conflict (profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
			v_notified := array_append(v_notified,v_recipient);
		end loop;
	end if;
	return jsonb_build_object('schema','qorpera.provider-usage-signal-receipt/v1','signalId',v_signal.id,
		'runId',v_run.id,'signalKind',p_signal_kind,'providerConnectionId',v_connection.id,
		'providerConnectionVersion',v_lease.provider_connection_version,'observedAt',v_signal.observed_at,
		'resetsAt',v_signal.resets_at,'replayed',v_replayed,'notifiedUserIds',to_jsonb(v_notified));
end
$$;

create function public.qorpera_list_member_notifications(p_profile_id uuid,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'member notification access denied' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 200 then
		raise exception 'member notification limit is invalid' using errcode = '22023'; end if;
	return coalesce((select jsonb_agg(public.qorpera_member_notification_json(notification)
		order by notification.created_at desc,notification.id)
		from (select * from public.qorpera_member_notifications
			where profile_id = p_profile_id and user_id = auth.uid()
			order by created_at desc,id limit p_limit) notification),'[]'::jsonb);
end
$$;

create function public.qorpera_acknowledge_member_notification(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_notification public.qorpera_member_notifications%rowtype;
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	update public.qorpera_member_notifications set acknowledged_at = coalesce(acknowledged_at,clock_timestamp())
	where id = p_notification_id and user_id = auth.uid() returning * into v_notification;
	if not found then raise exception 'member notification is unavailable' using errcode = '42501'; end if;
	return public.qorpera_member_notification_json(v_notification);
end
$$;

revoke all on function public.qorpera_member_notification_json(public.qorpera_member_notifications),
	public.qorpera_record_provider_usage_signal(jsonb,text,timestamptz),
	public.qorpera_list_member_notifications(uuid,integer),
	public.qorpera_acknowledge_member_notification(uuid)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_record_provider_usage_signal(jsonb,text,timestamptz) to service_role;
grant execute on function public.qorpera_list_member_notifications(uuid,integer),
	public.qorpera_acknowledge_member_notification(uuid) to authenticated;
