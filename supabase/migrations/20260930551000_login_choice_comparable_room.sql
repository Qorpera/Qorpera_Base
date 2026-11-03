-- A first login choice that works and compares room fairly (live company-building test, 3 November 2026).
--
-- Every first choice of a login (a new conversation, qorpera_select_member_session_account; new work,
-- qorpera_starter_sponsor; a new coding session, qorpera_coding_owner_login) took the login with the most room left:
-- the lowest `100 - usedPercent` of its windows. Two of the founder's logins: a ChatGPT workspace plan
-- (jonas.mk@qorpera.com) whose only window is 30 days long, 3% used (97 left), and a personal plan's weekly window at
-- 45 to 50% used (50 to 55 left). The workspace plan won every first choice, and it refused every Codex turn
-- ([code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]), while the weekly login completed every run it was given.
-- Two things were wrong: a share of a 30-day window and a share of a week are not the same amount, and a login whose
-- every recent turn was refused kept winning.
--
-- Now a first choice orders the logins by qorpera_native_account_rank, an array that sorts best first:
-- 1. A login whose provider refused its last three finished runs, all in the last six hours, comes after every other
--    one (qorpera_native_account_turns_refused). The refusal is the turn's own provider failure
--    ([code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]); any other ending breaks the run of refusals, and six hours
--    after the last refusal the login is chosen as before. It is never switched off: it stays the member's to pick,
--    and the only choice when it is the only login.
-- 2. A login at its usage limit (no room) comes next, as `remaining = 0` came first before.
-- 3. A login that completed a run in the last seven days and has at least 20% left in each window (or unknown usage)
--    comes before one that did not (qorpera_native_account_turn_completed): a login that is known to work.
-- 4. Then the most room on one scale (qorpera_native_account_paced_room): each window's remaining percent divided by
--    the share of that window still to run (`(resetAt - now) / windowSeconds`, between 5% and all of it; all of it when
--    the reading has no length or reset), the tightest window deciding. 50% left of a week that resets in a day is 350;
--    97% left of a 30-day window with 27 days to go is about 108. Unknown usage (-1) comes after measured room.
-- For an account login (20260930548000) the refusals, completed runs and readings of all its companies count, as its
-- usage limit and room left already do. A run's outcome comes from its native provider lease (one per run, naming the
-- connection) and the run's job.
--
-- Only first choices change. Which logins may pay is unchanged (qorpera_eligible_member_accounts, the plan and consent
-- rules), and a conversation, work that follows a run and a pinned coding session keep their login (20260930059000):
-- the payer never changes without the member. The member's connection list also reports each login's recent turns
-- (`recent_turns`: `refused`, `completed`), so the web orders "Choose a login" the same way.
--
-- Locks: one new index on the leases table (small: one row per native run). The order reads leases, jobs and usage
-- readings without locks. Every changed body carries the marker 20260930551000.

set local lock_timeout = '3s';

create index if not exists qorpera_native_provider_connection_leases_connection_created
	on public.qorpera_native_provider_connection_leases(provider_connection_id, created_at desc);

-- The connection and, for an account login's link, the same login's links in the member's other companies.
create function public.qorpera_native_account_login_connections(p_connection_id uuid)
returns table(connection_id uuid)
language sql stable security definer set search_path = '' as $$
	select p_connection_id
	union
	select sibling.connection_id from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling
$$;
revoke all on function public.qorpera_native_account_login_connections(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The provider refused the login's last three finished runs, all in the last six hours.
create function public.qorpera_native_account_turns_refused(p_connection_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930551000
	select count(*) = 3 and bool_and(recent.refused)
	from (
		select job.status = 'failed' and job.finished_at > statement_timestamp() - interval '6 hours'
				and strpos(coalesce(job.last_error, ''), '[code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]') > 0 as refused
		from public.qorpera_native_account_login_connections(p_connection_id) as login
		join public.qorpera_native_provider_connection_leases as lease on lease.provider_connection_id = login.connection_id
			and lease.created_at > statement_timestamp() - interval '2 days'
		join public.qorpera_runner_jobs as job on job.id = lease.job_id
		where job.status in ('completed', 'failed') and job.finished_at is not null
		order by job.finished_at desc, job.id
		limit 3
	) as recent
$$;
revoke all on function public.qorpera_native_account_turns_refused(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The login completed a run in the last seven days.
create function public.qorpera_native_account_turn_completed(p_connection_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930551000
	select exists (select 1
		from public.qorpera_native_account_login_connections(p_connection_id) as login
		join public.qorpera_native_provider_connection_leases as lease on lease.provider_connection_id = login.connection_id
			and lease.created_at > statement_timestamp() - interval '7 days'
		join public.qorpera_runner_jobs as job on job.id = lease.job_id and job.status = 'completed')
$$;
revoke all on function public.qorpera_native_account_turn_completed(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One company connection's room on one scale: qorpera_native_account_remaining_company's fresh windows, each window's
-- remaining percent divided by the share of the window still to run (5% to 100%), the tightest window deciding; -1
-- when unknown, 0 at an open usage limit.
create function public.qorpera_native_account_paced_room_company(p_connection_id uuid, p_connection_version bigint)
returns numeric
language sql stable security definer set search_path = '' as $$
	-- 20260930551000
	select case when public.qorpera_native_account_usage_limit_reset_company(p_connection_id) is not null then 0
		else coalesce((select min((100 - (w.value ->> 'usedPercent')::numeric) / greatest(0.05, least(1,
				case when jsonb_typeof(w.value -> 'windowSeconds') = 'number' and (w.value ->> 'windowSeconds')::numeric > 0
						and jsonb_typeof(w.value -> 'resetAt') = 'string'
					then extract(epoch from (w.value ->> 'resetAt')::timestamptz - statement_timestamp())
						/ (w.value ->> 'windowSeconds')::numeric
					else 1 end)))
			from public.qorpera_native_provider_account_metadata as m,
				lateral jsonb_array_elements(m.provider_account_usage -> 'windows') as w
			where m.connection_id = p_connection_id and m.connection_version = p_connection_version
				and (m.provider_account_usage ->> 'observedAt')::timestamptz > statement_timestamp() - interval '5 minutes'
				and (not (w.value ? 'resetAt') or (w.value ->> 'resetAt')::timestamptz > statement_timestamp())), -1) end
$$;
revoke all on function public.qorpera_native_account_paced_room_company(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The login's room on that scale: the tightest known reading of its companies, as qorpera_native_account_remaining.
create function public.qorpera_native_account_paced_room(p_connection_id uuid, p_connection_version bigint)
returns numeric
language sql stable security definer set search_path = '' as $$
	-- 20260930551000
	select case when public.qorpera_native_account_usage_limit_reset(p_connection_id) is not null then 0
		else coalesce((select min(known.room) from (
				select public.qorpera_native_account_paced_room_company(p_connection_id, p_connection_version) as room
				union all
				select public.qorpera_native_account_paced_room_company(sibling.connection_id, sibling.connection_version)
				from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling
			) as known where known.room >= 0), -1) end
$$;
revoke all on function public.qorpera_native_account_paced_room(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- How a first choice orders a login, best first: [refused, at its limit, not known to work with room, -room].
create function public.qorpera_native_account_rank(p_connection_id uuid, p_connection_version bigint)
returns numeric[]
language sql stable security definer set search_path = '' as $$
	-- 20260930551000
	select array[
		case when public.qorpera_native_account_turns_refused(p_connection_id) then 1 else 0 end,
		case when usage.remaining = 0 then 1 else 0 end,
		case when (usage.remaining < 0 or usage.remaining >= 20)
			and public.qorpera_native_account_turn_completed(p_connection_id) then 0 else 1 end,
		-public.qorpera_native_account_paced_room(p_connection_id, p_connection_version)]::numeric[]
	from (select public.qorpera_native_account_remaining(p_connection_id, p_connection_version) as remaining) as usage
$$;
revoke all on function public.qorpera_native_account_rank(uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The three first choices, patched in place through their current text (each keeps its ACL).
create function pg_temp.lr_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930551000 patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

do $$
begin
	if position('20260930551000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) > 0
	then
		return;
	end if;
	-- A new conversation's first choice.
	perform pg_temp.lr_patch('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure,
		'order by candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1;',
		E'-- 20260930551000: a login that works and the most room on one scale (qorpera_native_account_rank).\n'
		|| E'        order by public.qorpera_native_account_rank(candidate.connection_id, (select max(version.version)\n'
		|| E'                from public.qorpera_provider_connection_versions as version\n'
		|| E'                where version.connection_id = candidate.connection_id)),\n'
		|| E'            candidate.connection_id,candidate.binding_id limit 1;');
	-- New work's first choice (the requester's own logins).
	perform pg_temp.lr_patch('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure,
		E'select binding.id as binding_id, sponsor.version, connection.id as connection_id,\n'
		|| E'\t\t\tpublic.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at',
		E'select binding.id as binding_id, sponsor.version, connection.id as connection_id,\n'
		|| E'\t\t\tpublic.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at,\n'
		|| E'\t\t\tversion.version as connection_version');
	perform pg_temp.lr_patch('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure,
		'order by own.remaining = 0, own.remaining desc, own.created_at desc, own.binding_id',
		E'-- 20260930551000: a login that works and the most room on one scale, a used-up one after those.\n'
		|| E'\t\t\torder by public.qorpera_native_account_rank(own.connection_id, own.connection_version), own.created_at desc,\n'
		|| E'\t\t\t\town.binding_id');
	-- A new coding session's first choice, after the consent and the plan rule.
	perform pg_temp.lr_patch('public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure,
		'usage.remaining = 0, usage.remaining desc, connection.created_at desc, connection.id',
		E'-- 20260930551000: a login that works and the most room on one scale.\n'
		|| E'\t\tpublic.qorpera_native_account_rank(connection.id, version.version), usage.remaining = 0,\n'
		|| E'\t\tconnection.created_at desc, connection.id');
	-- The member's connection list reports each login's recent turns.
	perform pg_temp.lr_patch('public.qorpera_list_member_native_execution_connections(uuid)'::regprocedure,
		$old$'usage_limit_reset_at', public.qorpera_native_account_usage_limit_reset(connection.id),$old$,
		$new$'usage_limit_reset_at', public.qorpera_native_account_usage_limit_reset(connection.id),
                 -- 20260930551000: whether the provider refused the login's last three runs (six hours) and whether
                 -- it completed one this week, for the web's order of the member's logins.
                 'recent_turns', jsonb_build_object(
                     'refused', public.qorpera_native_account_turns_refused(connection.id),
                     'completed', public.qorpera_native_account_turn_completed(connection.id)),$new$);
end
$$;
