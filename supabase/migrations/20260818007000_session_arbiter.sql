-- Session arbitration: one open session per staff agent, and turns as an
-- atomically claimed queue. See supabase/SESSIONS.md for the contract and
-- the two-machine fork (2026-08-18) this closes.

-- Existing data first: the fork this migration prevents has already happened,
-- so duplicate open staff sessions may exist. Keep the earliest (the one the
-- second machine should have adopted) and close the rest; the closed trails
-- remain readable history.
update public.qorpera_shared_sessions as session
set status = 'closed', updated_at = statement_timestamp()
where session.status = 'open'
	and session.staff_agent_id is not null
	and exists (
		select 1 from public.qorpera_shared_sessions as earlier
		where earlier.profile_id = session.profile_id
			and earlier.staff_agent_id = session.staff_agent_id
			and earlier.status = 'open'
			and (earlier.created_at, earlier.id) < (session.created_at, session.id)
	);

create unique index qorpera_shared_sessions_one_open_per_staff
	on public.qorpera_shared_sessions (profile_id, staff_agent_id)
	where status = 'open' and staff_agent_id is not null;

create table public.qorpera_session_inputs (
	id uuid primary key default extensions.gen_random_uuid(),
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	client_input_id uuid not null,
	position bigint generated always as identity,
	kind text not null default 'user_message' check (kind in ('kickoff', 'user_message')),
	author_user_id uuid not null references auth.users(id) on delete cascade,
	body jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default statement_timestamp(),
	claimant_id uuid,
	claimed_at timestamptz,
	claim_expires_at timestamptz,
	completed_at timestamptz,
	unique (session_id, client_input_id)
);

create index qorpera_session_inputs_pending
	on public.qorpera_session_inputs (session_id, position)
	where completed_at is null;

alter table public.qorpera_session_inputs enable row level security;
revoke all on public.qorpera_session_inputs from anon, authenticated;

create function public.qorpera_session_profile_for_write(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select session.profile_id into v_profile_id
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'session write access is required' using errcode = '42501';
	end if;
	return v_profile_id;
end
$$;

revoke all on function public.qorpera_session_profile_for_write(uuid) from public, anon, authenticated;

create function public.qorpera_ensure_staff_session(
	p_environment_id uuid,
	p_staff_agent_id text,
	p_client_session_id uuid,
	p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype;
	v_created boolean := false;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if p_client_session_id is null then
		raise exception 'client session id is required' using errcode = '22023';
	end if;
	if p_staff_agent_id is null or char_length(btrim(p_staff_agent_id)) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023';
	end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023';
	end if;

	insert into public.qorpera_shared_sessions (
		profile_id, environment_id, client_session_id, title, staff_agent_id, created_by_user_id
	)
	values (
		v_profile_id, p_environment_id, p_client_session_id, btrim(p_title),
		btrim(p_staff_agent_id), v_user_id
	)
	on conflict (profile_id, staff_agent_id) where status = 'open' and staff_agent_id is not null
	do nothing
	returning * into v_session;
	v_created := found;

	if v_created then
		-- Creation and the kickoff row commit together: there is exactly one
		-- kickoff to claim, ever, no matter how many machines raced here.
		insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id)
		values (v_session.id, v_session.id, 'kickoff', v_user_id);
	else
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.profile_id = v_profile_id
			and session.staff_agent_id = btrim(p_staff_agent_id)
			and session.status = 'open';
		if not found then
			raise exception 'staff session could not be adopted' using errcode = '40001';
		end if;
	end if;

	return jsonb_build_object(
		'session_id', v_session.id,
		'environment_id', v_session.environment_id,
		'title', v_session.title,
		'created', v_created,
		'created_by_user_id', v_session.created_by_user_id
	);
end
$$;

create function public.qorpera_append_session_input(
	p_session_id uuid,
	p_client_input_id uuid,
	p_kind text,
	p_body jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_input public.qorpera_session_inputs%rowtype;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	if p_client_input_id is null then
		raise exception 'client input id is required' using errcode = '22023';
	end if;
	if p_kind is distinct from 'user_message' then
		-- Kickoffs are minted only by session creation; a client that could
		-- enqueue one directly could re-run it.
		raise exception 'input kind is invalid' using errcode = '22023';
	end if;
	if p_body is null or jsonb_typeof(p_body) <> 'object' or pg_column_size(p_body) > 65536 then
		raise exception 'input body is invalid' using errcode = '22023';
	end if;

	insert into public.qorpera_session_inputs (session_id, client_input_id, kind, author_user_id, body)
	values (p_session_id, p_client_input_id, 'user_message', v_user_id, p_body)
	on conflict (session_id, client_input_id) do nothing
	returning * into v_input;
	if not found then
		select input.* into v_input
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.client_input_id = p_client_input_id;
	end if;
	return jsonb_build_object('input_id', v_input.id, 'position', v_input.position);
end
$$;

create function public.qorpera_claim_session_turn(
	p_session_id uuid,
	p_claimant_id uuid,
	p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_claimed jsonb;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	if p_claimant_id is null then
		raise exception 'claimant id is required' using errcode = '22023';
	end if;
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;

	-- One turn in flight per session. The lock serializes racing claimants;
	-- expired claims count as dead executors and are claimable again.
	perform 1 from public.qorpera_shared_sessions as session
	where session.id = p_session_id for update;

	if exists (
		select 1 from public.qorpera_session_inputs as input
		where input.session_id = p_session_id
			and input.completed_at is null
			and input.claimant_id is not null
			and input.claim_expires_at > statement_timestamp()
	) then
		return jsonb_build_object('claimed', false, 'reason', 'turn-in-flight');
	end if;

	with turn as (
		update public.qorpera_session_inputs as input
		set claimant_id = p_claimant_id,
			claimed_at = statement_timestamp(),
			claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
		where input.session_id = p_session_id and input.completed_at is null
		returning input.id, input.position, input.kind, input.author_user_id, input.body, input.created_at
	)
	select jsonb_agg(jsonb_build_object(
		'input_id', turn.id, 'position', turn.position, 'kind', turn.kind,
		'author_user_id', turn.author_user_id, 'body', turn.body, 'created_at', turn.created_at
	) order by turn.position) into v_claimed
	from turn;

	if v_claimed is null then
		return jsonb_build_object('claimed', false, 'reason', 'queue-empty');
	end if;
	return jsonb_build_object('claimed', true, 'inputs', v_claimed);
end
$$;

create function public.qorpera_renew_session_turn(p_session_id uuid, p_claimant_id uuid, p_lease_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_renewed integer;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;
	update public.qorpera_session_inputs as input
	set claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	where input.session_id = p_session_id
		and input.claimant_id = p_claimant_id
		and input.completed_at is null
		and input.claim_expires_at > statement_timestamp();
	get diagnostics v_renewed = row_count;
	return jsonb_build_object('renewed', v_renewed);
end
$$;

create function public.qorpera_complete_session_turn(p_session_id uuid, p_claimant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_completed integer;
begin
	perform public.qorpera_session_profile_for_write(p_session_id);
	update public.qorpera_session_inputs as input
	set completed_at = statement_timestamp()
	where input.session_id = p_session_id
		and input.claimant_id = p_claimant_id
		and input.completed_at is null;
	get diagnostics v_completed = row_count;
	return jsonb_build_object('completed', v_completed);
end
$$;

revoke all on function public.qorpera_ensure_staff_session(uuid, text, uuid, text) from public, anon;
revoke all on function public.qorpera_append_session_input(uuid, uuid, text, jsonb) from public, anon;
revoke all on function public.qorpera_claim_session_turn(uuid, uuid, integer) from public, anon;
revoke all on function public.qorpera_renew_session_turn(uuid, uuid, integer) from public, anon;
revoke all on function public.qorpera_complete_session_turn(uuid, uuid) from public, anon;
grant execute on function public.qorpera_ensure_staff_session(uuid, text, uuid, text) to authenticated;
grant execute on function public.qorpera_append_session_input(uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.qorpera_claim_session_turn(uuid, uuid, integer) to authenticated;
grant execute on function public.qorpera_renew_session_turn(uuid, uuid, integer) to authenticated;
grant execute on function public.qorpera_complete_session_turn(uuid, uuid) to authenticated;
