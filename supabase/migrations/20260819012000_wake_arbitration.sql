-- Wake arbitration: autonomous wakes as claimed rows (SESSIONS.md).
--
-- Scheduled routines and durable coworker mail wake an agent on every machine
-- that has the company open, so without arbitration two machines fire the
-- same wake and run duplicate autonomous sessions — the 2026-08-18 fork, on
-- the proactive lane. Each wake occurrence has one deterministic key,
-- derived identically on every machine, and running it means claiming that
-- key: the same atomic claim-with-lease primitive the session turns use.
-- Two machines racing a due wake claim once; the winner runs it, the loser
-- consumes the occurrence locally without running. A claim whose lease
-- expires without completion is claimable again (the executor died
-- mid-wake); a completed claim never runs again anywhere.

create table public.qorpera_wake_claims (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	wake_key text not null,
	claimant_id uuid not null,
	claimed_at timestamptz not null default statement_timestamp(),
	claim_expires_at timestamptz not null,
	completed_at timestamptz,
	primary key (profile_id, wake_key)
);

alter table public.qorpera_wake_claims enable row level security;
revoke all on public.qorpera_wake_claims from anon, authenticated;

create function public.qorpera_wake_profile_for_write(p_environment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	return v_profile_id;
end
$$;

revoke all on function public.qorpera_wake_profile_for_write(uuid) from public, anon, authenticated;

create function public.qorpera_claim_wake(
	p_environment_id uuid,
	p_wake_key text,
	p_claimant_id uuid,
	p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_wake_profile_for_write(p_environment_id);
	v_wake_key text := btrim(p_wake_key);
	v_existing public.qorpera_wake_claims%rowtype;
begin
	if p_claimant_id is null then
		raise exception 'claimant id is required' using errcode = '22023';
	end if;
	if p_wake_key is null or char_length(v_wake_key) not between 1 and 200 then
		raise exception 'wake key is invalid' using errcode = '22023';
	end if;
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;

	-- Occurrence keys are time-derived and never recur; completed rows only
	-- need to outlive every machine's chance to re-derive the same key.
	delete from public.qorpera_wake_claims
	where profile_id = v_profile_id
		and completed_at is not null
		and completed_at < statement_timestamp() - interval '30 days';

	insert into public.qorpera_wake_claims (profile_id, wake_key, claimant_id, claim_expires_at)
	values (v_profile_id, v_wake_key, p_claimant_id,
		statement_timestamp() + make_interval(secs => p_lease_seconds))
	on conflict (profile_id, wake_key) do nothing;
	if found then
		return jsonb_build_object('claimed', true);
	end if;

	select claim.* into v_existing
	from public.qorpera_wake_claims as claim
	where claim.profile_id = v_profile_id and claim.wake_key = v_wake_key
	for update;
	if not found then
		-- Deleted between the conflict and the lock (GC race): treat as lost;
		-- the next tick claims cleanly if the occurrence still matters.
		return jsonb_build_object('claimed', false, 'reason', 'in-flight');
	end if;
	if v_existing.completed_at is not null then
		return jsonb_build_object('claimed', false, 'reason', 'already-run');
	end if;
	if v_existing.claim_expires_at > statement_timestamp() and v_existing.claimant_id is distinct from p_claimant_id then
		return jsonb_build_object('claimed', false, 'reason', 'in-flight');
	end if;
	-- Take over an expired claim (dead executor), or refresh the holder's own
	-- lease — a retry after a failed spawn stays idempotent.
	update public.qorpera_wake_claims
	set claimant_id = p_claimant_id,
		claimed_at = statement_timestamp(),
		claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	where profile_id = v_profile_id and wake_key = v_wake_key;
	return jsonb_build_object('claimed', true);
end
$$;

create function public.qorpera_renew_wake(
	p_environment_id uuid,
	p_wake_key text,
	p_claimant_id uuid,
	p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_wake_profile_for_write(p_environment_id);
	v_renewed integer;
begin
	if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
		raise exception 'lease duration is invalid' using errcode = '22023';
	end if;
	update public.qorpera_wake_claims as claim
	set claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	where claim.profile_id = v_profile_id
		and claim.wake_key = btrim(p_wake_key)
		and claim.claimant_id = p_claimant_id
		and claim.completed_at is null
		and claim.claim_expires_at > statement_timestamp();
	get diagnostics v_renewed = row_count;
	return jsonb_build_object('renewed', v_renewed);
end
$$;

create function public.qorpera_complete_wake(
	p_environment_id uuid,
	p_wake_key text,
	p_claimant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_wake_profile_for_write(p_environment_id);
	v_completed integer;
begin
	update public.qorpera_wake_claims as claim
	set completed_at = statement_timestamp()
	where claim.profile_id = v_profile_id
		and claim.wake_key = btrim(p_wake_key)
		and claim.claimant_id = p_claimant_id
		and claim.completed_at is null;
	get diagnostics v_completed = row_count;
	return jsonb_build_object('completed', v_completed);
end
$$;

revoke all on function public.qorpera_claim_wake(uuid, text, uuid, integer) from public, anon;
revoke all on function public.qorpera_renew_wake(uuid, text, uuid, integer) from public, anon;
revoke all on function public.qorpera_complete_wake(uuid, text, uuid) from public, anon;
grant execute on function public.qorpera_claim_wake(uuid, text, uuid, integer) to authenticated;
grant execute on function public.qorpera_renew_wake(uuid, text, uuid, integer) to authenticated;
grant execute on function public.qorpera_complete_wake(uuid, text, uuid) to authenticated;
