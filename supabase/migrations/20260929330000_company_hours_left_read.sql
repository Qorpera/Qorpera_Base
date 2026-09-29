-- Computer hours: members see how many hours the company has left, from the live switch on.
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 5 (members see how many hours
-- the company has left, not who paid) and 12 (members see only measured hours until the switch).
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Plan & usage (web)", "Going live").
--
-- qorpera_read_company_computer_hours gains `hoursLeft`:
-- * null before the live switch (every balance is then a dry run);
-- * `{"complimentary": true}` for a company with a founder on an internal account (never limited);
-- * otherwise `leftSeconds` (as the zero rule counts it: free hours, the founders' current plan
--   periods and the company's packs, minus what it owes) and the parts: `freeSeconds`,
--   `planSeconds`, `creditSeconds`, `owedSeconds`. A founder's plan period is the founder's whole
--   plan, shared by every company it pays for.
-- * For a founder reading it, also `founders`: each founder's current plan period and the packs
--   they bought for this company, with hours left (who pays). Other members never see names.

set local lock_timeout = '3s';

create function public.qorpera_computer_hour_member_hours_left(p_profile_id uuid, p_reader uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_now timestamptz := clock_timestamp();
	v_founders uuid[];
	v_free bigint;
	v_plans bigint;
	v_credits bigint;
	v_owed bigint;
	v_payers jsonb;
begin
	if public.qorpera_computer_hour_dry_run(v_now) then
		return null;
	end if;
	if public.qorpera_computer_hour_complimentary_founder(p_profile_id) is not null then
		return jsonb_build_object('complimentary', true);
	end if;
	v_founders := array(select founder.user_id from public.qorpera_company_founders(p_profile_id) founder);
	-- The same terms as qorpera_company_computer_hours_left (live), part by part.
	select coalesce((select case when free.withdrawn_at is null and free.frozen_at is null
			then free.granted_seconds - free.drawn_seconds else 0 end
		from public.qorpera_computer_hour_sources free
		where free.kind = 'free' and free.profile_id = p_profile_id and not free.dry_run), 5 * 3600)
	into v_free;
	select coalesce(sum(plan.granted_seconds - plan.drawn_seconds), 0) into v_plans
	from public.qorpera_computer_hour_sources plan
	where plan.kind = 'plan_period' and not plan.dry_run and plan.user_id = any(v_founders)
		and plan.withdrawn_at is null and plan.frozen_at is null
		and plan.period_start <= v_now and v_now < plan.period_end;
	select coalesce(sum(credit.granted_seconds - credit.drawn_seconds), 0) into v_credits
	from public.qorpera_computer_hour_sources credit
	where credit.kind = 'credit' and credit.profile_id = p_profile_id and not credit.dry_run
		and credit.withdrawn_at is null and credit.frozen_at is null and credit.expires_at > v_now;
	select coalesce((select owed.drawn_seconds - owed.repaid_seconds from public.qorpera_computer_hour_sources owed
		where owed.kind = 'owed' and owed.profile_id = p_profile_id and not owed.dry_run), 0)
	into v_owed;
	if p_reader = any(v_founders) then
		select coalesce(jsonb_agg(jsonb_build_object(
				'userId', payer.user_id,
				'planSeconds', payer.plan_seconds,
				'planEndsAt', payer.plan_ends_at,
				'creditSeconds', payer.credit_seconds
			) order by payer.position), '[]'::jsonb)
		into v_payers
		from (
			select founder.user_id, founder.position,
				(select sum(plan.granted_seconds - plan.drawn_seconds)
					from public.qorpera_computer_hour_sources plan
					where plan.kind = 'plan_period' and not plan.dry_run and plan.user_id = founder.user_id
						and plan.withdrawn_at is null and plan.frozen_at is null
						and plan.period_start <= v_now and v_now < plan.period_end) as plan_seconds,
				(select max(plan.period_end)
					from public.qorpera_computer_hour_sources plan
					where plan.kind = 'plan_period' and not plan.dry_run and plan.user_id = founder.user_id
						and plan.withdrawn_at is null and plan.period_start <= v_now and v_now < plan.period_end) as plan_ends_at,
				(select sum(credit.granted_seconds - credit.drawn_seconds)
					from public.qorpera_computer_hour_sources credit
					where credit.kind = 'credit' and credit.profile_id = p_profile_id and not credit.dry_run
						and credit.user_id = founder.user_id and credit.withdrawn_at is null and credit.frozen_at is null
						and credit.expires_at > v_now) as credit_seconds
			from public.qorpera_company_founders(p_profile_id) with ordinality as founder(user_id, position)
		) payer;
	end if;
	return jsonb_build_object(
		'leftSeconds', v_free + v_plans + v_credits - v_owed,
		'freeSeconds', v_free,
		'planSeconds', v_plans,
		'creditSeconds', v_credits,
		'owedSeconds', v_owed
	) || case when v_payers is null then '{}'::jsonb else jsonb_build_object('founders', v_payers) end;
end
$$;
revoke all on function public.qorpera_computer_hour_member_hours_left(uuid, uuid)
	from public, anon, authenticated, service_role;

create function pg_temp.hours_left_read_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Hours left read: % anchor is not present exactly once', p_what;
	end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_read_company_computer_hours(uuid,date)'::regprocedure);
begin
	v_definition := pg_temp.hours_left_read_replace(v_definition,
		$old$		'waitingForHours', public.qorpera_company_at_zero(p_profile_id, clock_timestamp())$old$,
		$new$		'waitingForHours', public.qorpera_company_at_zero(p_profile_id, clock_timestamp()),
		'hoursLeft', public.qorpera_computer_hour_member_hours_left(p_profile_id, auth.uid())$new$, 'member hours read');
	execute v_definition;
end
$patch$;
