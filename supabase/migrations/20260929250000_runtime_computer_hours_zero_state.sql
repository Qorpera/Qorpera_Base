-- Computer hours, build step 6c part 1: when a company ran out, and "out of hours" at zero without
-- owing (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 7 ("At zero") and 10 (email).
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero").
--
-- * `qorpera_computer_hour_zero_state` holds, for each company at zero, when it ran out. The one-hour
--   finishing window (build step 6c part 2) counts from it.
-- * A sweep after each meter pass keeps it: a company no longer at zero (hours arrived, it became
--   complimentary, a plan renewal is in its grace) is removed, and a company newly at zero is added.
--   Only a company whose live free hours are used up can be at zero, so only those are looked at.
--   While the zero rule is off (or in the dry run) the table is kept empty.
-- * A company that reaches zero without owing (hours taken back, credits expiring, a plan ending)
--   is used no further once its work is held, so the usage trigger (build step 5) never tells its
--   founders. The sweep queues "out of hours" for every founder then, under its own occasion
--   (`<company>:zero:<when it ran out>`). A company that owes was told when it started to owe.
-- * While a company is at zero, the usage trigger queues no further "out of hours" (work running
--   out its hour starts owing then, and the founders were already told), and the notices claim
--   keeps a zero notice while that time at zero lasts, drops it once hours arrive, and drops
--   "running low" at zero.

set local lock_timeout = '10s';

create table public.qorpera_computer_hour_zero_state (
	-- State, not a billing record: it goes with the company.
	profile_id uuid primary key references public.qorpera_profiles (id) on delete cascade,
	ran_out_at timestamptz not null
);
alter table public.qorpera_computer_hour_zero_state enable row level security;
revoke all on public.qorpera_computer_hour_zero_state from public, anon, authenticated, service_role;
grant select on public.qorpera_computer_hour_zero_state to service_role;

-- The occasion of one time at zero, for the notices' one-per-occasion rule.
create function public.qorpera_computer_hour_zero_occasion(p_profile_id uuid, p_ran_out_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
	select p_profile_id::text || ':zero:' || (extract(epoch from p_ran_out_at) * 1000000)::bigint::text
$$;
revoke all on function public.qorpera_computer_hour_zero_occasion(uuid, timestamptz)
	from public, anon, authenticated, service_role;

-- Runs after each meter pass, in its transaction and under its lock (a pass that found the lock
-- taken skips the sweep too).
create function public.qorpera_computer_hour_zero_sweep(p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_since timestamptz := (select billing.zero_rule_since from public.qorpera_computer_hour_billing billing);
	v_cleared integer;
	v_ran_out integer := 0;
	v_profile uuid;
begin
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.computer-hour-meter', 0)) then
		return jsonb_build_object('skipped', true);
	end if;
	if v_since is null or p_at < v_since or public.qorpera_computer_hour_dry_run(p_at) then
		delete from public.qorpera_computer_hour_zero_state;
		get diagnostics v_cleared = row_count;
		return jsonb_build_object('cleared', v_cleared, 'ranOut', 0);
	end if;
	delete from public.qorpera_computer_hour_zero_state zero
	where not public.qorpera_company_at_zero(zero.profile_id, p_at);
	get diagnostics v_cleared = row_count;
	for v_profile in
		select free.profile_id
		from public.qorpera_computer_hour_sources free
		join public.qorpera_profiles profile on profile.id = free.profile_id
		where free.kind = 'free' and not free.dry_run
			and (free.drawn_seconds >= free.granted_seconds or free.withdrawn_at is not null or free.frozen_at is not null)
			and not exists (
				select 1 from public.qorpera_computer_hour_zero_state zero where zero.profile_id = free.profile_id
			)
			and not public.qorpera_company_deleting(free.profile_id)
		order by free.profile_id
	loop
		continue when not public.qorpera_company_at_zero(v_profile, p_at);
		insert into public.qorpera_computer_hour_zero_state (profile_id, ran_out_at) values (v_profile, p_at);
		v_ran_out := v_ran_out + 1;
		if not exists (
			select 1 from public.qorpera_computer_hour_sources owed
			where owed.kind = 'owed' and owed.profile_id = v_profile and not owed.dry_run
				and owed.drawn_seconds > owed.repaid_seconds
		) then
			perform public.qorpera_computer_hour_queue_notice('out_of_hours', v_profile,
				array(select founder.user_id from public.qorpera_company_founders(v_profile) founder),
				public.qorpera_computer_hour_zero_occasion(v_profile, p_at),
				jsonb_build_object(
					'companyName', (select profile.name from public.qorpera_profiles profile where profile.id = v_profile),
					'leftSeconds', 0, 'month', public.qorpera_computer_hour_notice_month(p_at)),
				clock_timestamp() + interval '10 minutes');
		end if;
	end loop;
	return jsonb_build_object('cleared', v_cleared, 'ranOut', v_ran_out);
end
$$;
revoke all on function public.qorpera_computer_hour_zero_sweep(timestamptz) from public, anon, authenticated, service_role;

-- The meter pass pg_cron runs once a minute, now followed by the sweep. A failing sweep never holds
-- metering back: its work is undone and a warning logged, and the next pass tries again.
create or replace function public.qorpera_meter_computer_hours()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_result jsonb := public.qorpera_meter_computer_hours_at(clock_timestamp());
begin
	begin
		perform public.qorpera_computer_hour_zero_sweep(clock_timestamp());
	exception when others then
		raise warning 'Computer hours zero sweep failed: % (%)', sqlerrm, sqlstate;
	end;
	return v_result;
end
$$;

create function pg_temp.zero_state_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Zero state: % anchor is not present exactly once', p_what;
	end if;
	return replace(p_definition, p_old, p_new);
end
$$;

-- The usage trigger: no second "out of hours" while the company is at zero.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_computer_hour_notice_usage()'::regprocedure);
begin
	v_definition := pg_temp.zero_state_replace(v_definition, $old$		-- One time of owing is named by what had been repaid when it began; hours arriving move it.
		perform public.qorpera_computer_hour_queue_notice('out_of_hours', new.profile_id, v_founders,
			new.profile_id::text || ':' || v_owed.repaid_seconds::text, v_details, v_send_after);
		return null;$old$, $new$		-- One time of owing is named by what had been repaid when it began; hours arriving move it.
		-- At zero the founders were already told (when it ran out, or when it started to owe).
		if not exists (
			select 1 from public.qorpera_computer_hour_zero_state zero where zero.profile_id = new.profile_id
		) then
			perform public.qorpera_computer_hour_queue_notice('out_of_hours', new.profile_id, v_founders,
				new.profile_id::text || ':' || v_owed.repaid_seconds::text, v_details, v_send_after);
		end if;
		return null;$new$, 'usage out of hours');
	execute v_definition;
end
$patch$;

-- The claim: a zero notice holds while its time at zero lasts; "running low" is dropped at zero.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure);
begin
	v_definition := pg_temp.zero_state_replace(v_definition, $old$				and notice.occasion = notice.profile_id::text || ':' || owed.repaid_seconds::text
		);$old$, $new$				and notice.occasion = notice.profile_id::text || ':' || owed.repaid_seconds::text
		)
		-- Still the same time at zero: hours arriving end it, and running out again is a new one.
		and not exists (
			select 1 from public.qorpera_computer_hour_zero_state zero
			where zero.profile_id = notice.profile_id
				and notice.occasion = public.qorpera_computer_hour_zero_occasion(zero.profile_id, zero.ran_out_at)
		);$new$, 'claim out of hours');
	v_definition := pg_temp.zero_state_replace(v_definition, $old$			when owing.id is not null then 'The company ran out before it was sent'$old$,
		$new$			when owing.id is not null or zero.profile_id is not null then 'The company ran out before it was sent'$new$,
		'claim running low reason');
	v_definition := pg_temp.zero_state_replace(v_definition, $old$			and owing.drawn_seconds > owing.repaid_seconds
	where notice.id = open_notice.id$old$, $new$			and owing.drawn_seconds > owing.repaid_seconds
	left join public.qorpera_computer_hour_zero_state zero on zero.profile_id = open_notice.profile_id
	where notice.id = open_notice.id$new$, 'claim running low join');
	v_definition := pg_temp.zero_state_replace(v_definition, $old$		and (hours.left_seconds is null or owing.id is not null$old$,
		$new$		and (hours.left_seconds is null or owing.id is not null or zero.profile_id is not null$new$,
		'claim running low drop');
	execute v_definition;
end
$patch$;
