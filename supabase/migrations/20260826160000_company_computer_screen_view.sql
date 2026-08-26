-- Step 3 screens: the brokered member path onto a screen. A member mints a
-- short-lived single-use view capability for a screen of their company's
-- computer; the host-side viewer gateway redeems it with provider authority
-- where member traffic terminates, then opens the guest attach leg with the
-- per-computer viewer token. The capability is stored hashed, never
-- readable by clients, and redemption is recorded in the audit trail.
-- Watching and driving are one surface (the live screen is take-over-able
-- by design), so minting requires profile write access.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

create table public.qorpera_company_computer_screen_view_capabilities (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	screen_id uuid not null references public.qorpera_company_computer_screens(id) on delete cascade,
	capability_sha256 text not null unique check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	minted_by_user_id uuid not null references auth.users(id) on delete restrict,
	expires_at timestamptz not null,
	redeemed_at timestamptz,
	created_at timestamptz not null default statement_timestamp(),
	check (redeemed_at is null or redeemed_at >= created_at)
);

alter table public.qorpera_company_computer_screen_view_capabilities enable row level security;
revoke all on table public.qorpera_company_computer_screen_view_capabilities from anon, authenticated;

alter table public.qorpera_company_computer_events
	drop constraint qorpera_company_computer_events_event_type_check;
alter table public.qorpera_company_computer_events
	add constraint qorpera_company_computer_events_event_type_check check (event_type in (
		'company_computer_registered', 'company_computer_lifecycle',
		'company_computer_screen_registered', 'company_computer_screen_attached',
		'company_computer_screen_detached', 'company_computer_screen_retired',
		'company_computer_screen_claimed', 'company_computer_screen_released',
		'company_computer_screen_viewed'
	));

create function public.qorpera_mint_company_computer_screen_view(p_screen_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_registry public.qorpera_company_computers%rowtype;
	v_capability text;
	v_expires_at timestamptz := statement_timestamp() + interval '120 seconds';
begin
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id;
	if not found or v_user_id is null or not public.qorpera_can_write_profile(v_screen.profile_id) then
		raise exception 'company computer screen viewing requires write access' using errcode = '42501';
	end if;
	if v_screen.status <> 'active' then
		raise exception 'company computer screen is retired' using errcode = '55000';
	end if;
	select registry.* into strict v_registry
	from public.qorpera_company_computers as registry
	where registry.id = v_screen.company_computer_id;
	if v_registry.lifecycle_state not in ('active', 'snapshotting') then
		raise exception 'company computer is not available for viewing' using errcode = '55000';
	end if;
	delete from public.qorpera_company_computer_screen_view_capabilities
	where screen_id = p_screen_id and expires_at < statement_timestamp() - interval '1 day';
	v_capability := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
	insert into public.qorpera_company_computer_screen_view_capabilities (
		profile_id, screen_id, capability_sha256, minted_by_user_id, expires_at
	) values (
		v_screen.profile_id, v_screen.id,
		encode(extensions.digest(v_capability, 'sha256'), 'hex'),
		v_user_id, v_expires_at
	);
	return jsonb_build_object(
		'capability', v_capability,
		'expires_at', v_expires_at,
		'screen', public.qorpera_company_computer_screen_json(v_screen)
	);
end
$$;

revoke all on function public.qorpera_mint_company_computer_screen_view(uuid) from public;
grant execute on function public.qorpera_mint_company_computer_screen_view(uuid) to authenticated;

-- Redeemed exactly once by the viewer gateway where member traffic
-- terminates; the connection it opens lives as long as the socket, but the
-- capability itself cannot be replayed.
create function public.qorpera_redeem_company_computer_screen_view(p_capability text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_row public.qorpera_company_computer_screen_view_capabilities%rowtype;
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_registry public.qorpera_company_computers%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer screen view redemption requires provider authority' using errcode = '42501';
	end if;
	if p_capability is null or p_capability !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'company computer screen view capability is invalid' using errcode = '22023';
	end if;
	update public.qorpera_company_computer_screen_view_capabilities
	set redeemed_at = statement_timestamp()
	where capability_sha256 = encode(extensions.digest(p_capability, 'sha256'), 'hex')
		and redeemed_at is null
		and expires_at > statement_timestamp()
	returning * into v_row;
	if not found then
		raise exception 'company computer screen view capability is expired or unknown' using errcode = '55000';
	end if;
	select screen.* into strict v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = v_row.screen_id;
	if v_screen.status <> 'active' then
		raise exception 'company computer screen is retired' using errcode = '55000';
	end if;
	select registry.* into strict v_registry
	from public.qorpera_company_computers as registry
	where registry.id = v_screen.company_computer_id;
	if v_registry.lifecycle_state not in ('active', 'snapshotting') then
		raise exception 'company computer is not available for viewing' using errcode = '55000';
	end if;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_registry.id, 'company_computer_screen_viewed',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'minted_by_user_id', v_row.minted_by_user_id
		)
	);
	return jsonb_build_object(
		'screen_id', v_screen.id,
		'screen_ordinal', v_screen.screen_ordinal,
		'profile_id', v_screen.profile_id,
		'company_computer_id', v_registry.id,
		'logical_computer_id', v_registry.logical_computer_id,
		'minted_by_user_id', v_row.minted_by_user_id
	);
end
$$;

revoke all on function public.qorpera_redeem_company_computer_screen_view(text) from public;
grant execute on function public.qorpera_redeem_company_computer_screen_view(text) to service_role;
