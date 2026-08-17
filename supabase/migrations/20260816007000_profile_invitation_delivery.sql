-- Durable profile invitation email delivery.
--
-- Invitation creation and delivery are deliberately separate transactions.
-- The profile RPC commits the recipient-safe invitation and an outbox row.
-- A secret-authenticated Edge Function leases outbox rows, sends mail with a
-- provider idempotency key, then records success or a bounded retry schedule.

create table public.qorpera_profile_invitation_deliveries (
	invitation_id uuid primary key references public.qorpera_profile_invitations(id) on delete cascade,
	status text not null default 'pending' check (status in ('pending', 'delivering', 'retrying', 'delivered', 'failed')),
	attempt_count integer not null default 0 check (attempt_count >= 0),
	next_attempt_at timestamptz not null default statement_timestamp(),
	lease_id uuid,
	lease_expires_at timestamptz,
	provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 256),
	last_error text check (last_error is null or char_length(last_error) <= 1000),
	sent_at timestamptz,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	check ((lease_id is null) = (lease_expires_at is null)),
	check ((status = 'delivered') = (sent_at is not null))
);

create index qorpera_invitation_deliveries_ready
	on public.qorpera_profile_invitation_deliveries (next_attempt_at, created_at)
	where status in ('pending', 'retrying', 'delivering');

alter table public.qorpera_profile_invitation_deliveries enable row level security;

revoke all on public.qorpera_profile_invitation_deliveries from anon, authenticated;

create function public.qorpera_enqueue_profile_invitation_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_profile_invitation_deliveries (invitation_id)
	values (new.id)
	on conflict (invitation_id) do nothing;
	return new;
end
$$;

create trigger qorpera_profile_invitation_delivery_enqueue
	after insert on public.qorpera_profile_invitations
	for each row execute function public.qorpera_enqueue_profile_invitation_delivery();

insert into public.qorpera_profile_invitation_deliveries (invitation_id)
select invitation.id
from public.qorpera_profile_invitations as invitation
where invitation.expires_at > statement_timestamp()
on conflict (invitation_id) do nothing;

create function public.qorpera_profile_invitation_delivery_json(p_invitation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'status', delivery.status,
		'attempt_count', delivery.attempt_count,
		'next_attempt_at', delivery.next_attempt_at,
		'provider_message_id', delivery.provider_message_id,
		'last_error', delivery.last_error,
		'sent_at', delivery.sent_at
	)
	from public.qorpera_profile_invitation_deliveries as delivery
	where delivery.invitation_id = p_invitation_id
$$;

create or replace function public.qorpera_invite_profile_member(
	p_profile_id uuid,
	p_email text,
	p_role public.qorpera_profile_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_email text := lower(btrim(p_email));
	v_invitation public.qorpera_profile_invitations%rowtype;
begin
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if p_role = 'owner' or p_role is null then
		raise exception 'owner invitations are not permitted' using errcode = '22023';
	end if;
	if v_actor_role = 'admin' and p_role = 'admin' then
		raise exception 'only the owner can grant full access' using errcode = '42501';
	end if;
	if char_length(v_email) not between 3 and 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
		raise exception 'email is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.email = v_email
	) then
		raise exception 'this account already has access' using errcode = '23505';
	end if;
	delete from public.qorpera_profile_invitations
	where profile_id = p_profile_id and expires_at <= statement_timestamp();

	insert into public.qorpera_profile_invitations (
		profile_id,
		email,
		role,
		invited_by_user_id,
		expires_at
	)
	values (p_profile_id, v_email, p_role, v_actor_id, statement_timestamp() + interval '14 days')
	returning * into v_invitation;

	return jsonb_build_object(
		'id', v_invitation.id,
		'profile_id', v_invitation.profile_id,
		'email', v_invitation.email,
		'role', v_invitation.role,
		'invited_by_user_id', v_invitation.invited_by_user_id,
		'created_at', v_invitation.created_at,
		'expires_at', v_invitation.expires_at,
		'delivery', public.qorpera_profile_invitation_delivery_json(v_invitation.id)
	);
end
$$;

create or replace function public.qorpera_list_profile_invitations()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'id', invitation.id,
				'profile_id', invitation.profile_id,
				'environment_id', environment.id,
				'profile_name', profile.name,
				'environment_name', environment.name,
				'email', invitation.email,
				'role', invitation.role,
				'invited_by_user_id', invitation.invited_by_user_id,
				'created_at', invitation.created_at,
				'expires_at', invitation.expires_at,
				'delivery', public.qorpera_profile_invitation_delivery_json(invitation.id)
			)
			order by invitation.created_at
		),
		'[]'::jsonb
	)
	from public.qorpera_profile_invitations as invitation
	join public.qorpera_profiles as profile on profile.id = invitation.profile_id
	join lateral (
		select candidate.*
		from public.qorpera_company_environments as candidate
		where candidate.profile_id = invitation.profile_id
		order by candidate.created_at, candidate.id
		limit 1
	) as environment on true
	where invitation.email = lower(coalesce(auth.jwt() ->> 'email', ''))
		and invitation.expires_at > statement_timestamp()
$$;

create or replace function public.qorpera_profile_team_info(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_role public.qorpera_profile_role;
begin
	v_role := public.qorpera_member_role(p_profile_id);
	if v_role is null then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;

	return jsonb_build_object(
		'profile_id', p_profile_id,
		'role', v_role,
		'capabilities', jsonb_build_object(
			'read', true,
			'write', v_role in ('owner', 'admin', 'contributor'),
			'authorize', v_role in ('owner', 'admin'),
			'manage_members', v_role in ('owner', 'admin')
		),
		'members', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'user_id', member.user_id,
						'email', member.email,
						'display_name', member.display_name,
						'avatar_url', member.avatar_url,
						'role', member.role,
						'joined_at', member.joined_at
					)
					order by
						case member.role
							when 'owner' then 0
							when 'admin' then 1
							when 'contributor' then 2
							else 3
						end,
						member.joined_at
				)
				from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id
			),
			'[]'::jsonb
		),
		'invitations', case
			when v_role not in ('owner', 'admin') then '[]'::jsonb
			else coalesce(
				(
					select jsonb_agg(
						jsonb_build_object(
							'id', invitation.id,
							'profile_id', invitation.profile_id,
							'email', invitation.email,
							'role', invitation.role,
							'invited_by_user_id', invitation.invited_by_user_id,
							'created_at', invitation.created_at,
							'expires_at', invitation.expires_at,
							'delivery', public.qorpera_profile_invitation_delivery_json(invitation.id)
						)
						order by invitation.created_at
					)
					from public.qorpera_profile_invitations as invitation
					where invitation.profile_id = p_profile_id
						and invitation.expires_at > statement_timestamp()
				),
				'[]'::jsonb
			)
		end
	);
end
$$;

create function public.qorpera_claim_profile_invitation_deliveries(
	p_limit integer,
	p_lease_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_result jsonb;
begin
	if p_limit not between 1 and 50 or p_lease_id is null then
		raise exception 'invitation delivery claim is invalid' using errcode = '22023';
	end if;

	delete from public.qorpera_profile_invitations
	where expires_at <= statement_timestamp();

	with candidates as (
		select delivery.invitation_id
		from public.qorpera_profile_invitation_deliveries as delivery
		join public.qorpera_profile_invitations as invitation on invitation.id = delivery.invitation_id
		where invitation.expires_at > statement_timestamp()
			and delivery.status in ('pending', 'retrying', 'delivering')
			and delivery.next_attempt_at <= statement_timestamp()
			and (delivery.lease_expires_at is null or delivery.lease_expires_at <= statement_timestamp())
		order by delivery.next_attempt_at, delivery.created_at
		for update of delivery skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_profile_invitation_deliveries as delivery
		set status = 'delivering',
			attempt_count = delivery.attempt_count + 1,
			lease_id = p_lease_id,
			lease_expires_at = statement_timestamp() + interval '5 minutes',
			last_error = null,
			updated_at = statement_timestamp()
		from candidates
		where delivery.invitation_id = candidates.invitation_id
		returning delivery.*
	)
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'invitation_id', invitation.id,
				'profile_id', invitation.profile_id,
				'profile_name', profile.name,
				'recipient_email', invitation.email,
				'role', invitation.role,
				'invited_by_display_name', coalesce(inviter.display_name, 'A Qorpera teammate'),
				'expires_at', invitation.expires_at,
				'attempt_count', claimed.attempt_count,
				'lease_id', claimed.lease_id
			)
			order by claimed.created_at
		),
		'[]'::jsonb
	) into v_result
	from claimed
	join public.qorpera_profile_invitations as invitation on invitation.id = claimed.invitation_id
	join public.qorpera_profiles as profile on profile.id = invitation.profile_id
	left join public.qorpera_profile_members as inviter
		on inviter.profile_id = invitation.profile_id
		and inviter.user_id = invitation.invited_by_user_id;

	return v_result;
end
$$;

create function public.qorpera_complete_profile_invitation_delivery(
	p_invitation_id uuid,
	p_lease_id uuid,
	p_provider_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if char_length(btrim(p_provider_message_id)) not between 1 and 256 then
		raise exception 'provider message id is invalid' using errcode = '22023';
	end if;
	update public.qorpera_profile_invitation_deliveries
	set status = 'delivered',
		provider_message_id = btrim(p_provider_message_id),
		last_error = null,
		sent_at = statement_timestamp(),
		next_attempt_at = statement_timestamp(),
		lease_id = null,
		lease_expires_at = null,
		updated_at = statement_timestamp()
	where invitation_id = p_invitation_id
		and status = 'delivering'
		and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise exception 'invitation delivery lease is unavailable' using errcode = '40001';
	end if;
	return 'true'::jsonb;
end
$$;

create function public.qorpera_fail_profile_invitation_delivery(
	p_invitation_id uuid,
	p_lease_id uuid,
	p_error text,
	p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_attempt_count integer;
	v_expires_at timestamptz;
	v_status text;
	v_next_attempt_at timestamptz;
begin
	select delivery.attempt_count, invitation.expires_at
	into v_attempt_count, v_expires_at
	from public.qorpera_profile_invitation_deliveries as delivery
	join public.qorpera_profile_invitations as invitation on invitation.id = delivery.invitation_id
	where delivery.invitation_id = p_invitation_id
		and delivery.status = 'delivering'
		and delivery.lease_id = p_lease_id
		and delivery.lease_expires_at > statement_timestamp()
	for update of delivery;
	if not found then
		raise exception 'invitation delivery lease is unavailable' using errcode = '40001';
	end if;

	v_status := case
		when p_retryable and v_attempt_count < 8 and v_expires_at > statement_timestamp() then 'retrying'
		else 'failed'
	end;
	v_next_attempt_at := case
		when v_status = 'retrying' then statement_timestamp() + make_interval(
			secs => least(3600, (30 * power(2, greatest(v_attempt_count - 1, 0)))::integer)
		)
		else v_expires_at
	end;

	update public.qorpera_profile_invitation_deliveries
	set status = v_status,
		last_error = left(coalesce(nullif(btrim(p_error), ''), 'Email delivery failed'), 1000),
		next_attempt_at = v_next_attempt_at,
		lease_id = null,
		lease_expires_at = null,
		updated_at = statement_timestamp()
	where invitation_id = p_invitation_id;

	return jsonb_build_object('status', v_status, 'next_attempt_at', v_next_attempt_at);
end
$$;

create function public.qorpera_retry_profile_invitation_delivery(
	p_profile_id uuid,
	p_invitation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_role public.qorpera_profile_role;
begin
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if not exists (
		select 1
		from public.qorpera_profile_invitations as invitation
		where invitation.id = p_invitation_id
			and invitation.profile_id = p_profile_id
			and invitation.expires_at > statement_timestamp()
	) then
		raise exception 'profile invitation was not found' using errcode = 'P0002';
	end if;

	update public.qorpera_profile_invitation_deliveries
	set status = 'pending',
		attempt_count = 0,
		next_attempt_at = statement_timestamp(),
		lease_id = null,
		lease_expires_at = null,
		provider_message_id = null,
		last_error = null,
		sent_at = null,
		updated_at = statement_timestamp()
	where invitation_id = p_invitation_id;

	return public.qorpera_profile_invitation_delivery_json(p_invitation_id);
end
$$;

revoke all on function public.qorpera_enqueue_profile_invitation_delivery() from public;
revoke all on function public.qorpera_profile_invitation_delivery_json(uuid) from public;
revoke all on function public.qorpera_claim_profile_invitation_deliveries(integer, uuid) from public;
revoke all on function public.qorpera_complete_profile_invitation_delivery(uuid, uuid, text) from public;
revoke all on function public.qorpera_fail_profile_invitation_delivery(uuid, uuid, text, boolean) from public;
revoke all on function public.qorpera_retry_profile_invitation_delivery(uuid, uuid) from public;

grant execute on function public.qorpera_claim_profile_invitation_deliveries(integer, uuid) to service_role;
grant execute on function public.qorpera_complete_profile_invitation_delivery(uuid, uuid, text) to service_role;
grant execute on function public.qorpera_fail_profile_invitation_delivery(uuid, uuid, text, boolean) to service_role;
grant execute on function public.qorpera_retry_profile_invitation_delivery(uuid, uuid) to authenticated;
