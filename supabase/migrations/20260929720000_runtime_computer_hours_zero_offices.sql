-- Computer hours, build step 6b part 2: Company Computers at zero (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero": no machine starts
-- or wakes; running work may finish for at most 1 hour, then its machines are stopped with their
-- disks kept). Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero"). Agreed with the
-- Company Computers session.
--
-- 1. A sleeping computer's wake waits while the company is at zero. A member or an agent may still
--    ask (the request is kept), but the idle check hands the wake to the provider only once the
--    company has hours again. Without this the provider would try the resume every few seconds and
--    be refused by the node (6b part 1) for as long as the company stays at zero. Once a wake has
--    been handed over it stays handed over (`wake_reported_at`): the provider may have begun the
--    resume, which then waits at the node refusal.
-- 2. Once the finishing window is over (`qorpera_computer_hour_finish_window_over`: an hour after
--    the company ran out, still at zero), the idle check powers the computer off at once, whatever
--    keeps it awake (screens, viewers, waiting work, a pause), as for a company being deleted. Its
--    disk is kept; it wakes as usual once hours are added.
-- 3. `qorpera_runtime_office_start_wait` says 'hours' for a sleeping computer, or a started one no
--    host has taken yet, of a company at zero. Members see it on the computer panel; operators in
--    the setup queue. `qorpera_runtime_office_start_stuck` (= 'setup') does not count it as stuck.
--
-- While the rule is off `qorpera_company_at_zero` and the finishing window are false and nothing
-- changes. The web learns 'hours' in the same change and is deployed before the rule is switched on.

set local lock_timeout = '3s';

alter table public.qorpera_runtime_office_idle_cycles add column wake_reported_at timestamptz;
-- Every wake asked for so far was handed over by the old rule at the provider's next check.
update public.qorpera_runtime_office_idle_cycles set wake_reported_at = wake_requested_at
where wake_requested_at is not null;

do $idle$
declare
	v_definition text := pg_get_functiondef('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure);
	v_patches constant text[][] := array[
		array[E'\t\treturn jsonb_build_object(''schema'',''qorpera.office-idle-policy/v1'',''request'',c.request,''wakeRequested'',c.wake_requested_at is not null);\n',
			E'\t\t-- Computer hours (20260929720000): a wake not yet handed to the provider waits while the\n'
			|| E'\t\t-- company is at zero. Once handed over it stays so: the provider may have begun the resume.\n'
			|| E'\t\tif c.wake_requested_at is not null and c.wake_reported_at is null then\n'
			|| E'\t\t\tif public.qorpera_company_at_zero(o.profile_id,v_at) then\n'
			|| E'\t\t\t\treturn jsonb_build_object(''schema'',''qorpera.office-idle-policy/v1'',''request'',c.request,''wakeRequested'',false);\n'
			|| E'\t\t\tend if;\n'
			|| E'\t\t\tupdate public.qorpera_runtime_office_idle_cycles set wake_reported_at=v_at where transition_id=c.transition_id returning * into c;\n'
			|| E'\t\tend if;\n'
			|| E'\t\treturn jsonb_build_object(''schema'',''qorpera.office-idle-policy/v1'',''request'',c.request,''wakeRequested'',c.wake_requested_at is not null);\n'],
		-- Past the finishing window the computer powers off like a company being deleted.
		array[E'\tif not v_provider.preparation_enabled or (not public.qorpera_company_deleting(o.profile_id)\n',
			E'\tif not v_provider.preparation_enabled or (not public.qorpera_company_deleting(o.profile_id)\n'
			|| E'\t\tand not public.qorpera_computer_hour_finish_window_over(o.profile_id,v_at)\n'],
		array[E'\telsif p.idle_since is null and not public.qorpera_company_deleting(o.profile_id) then\n',
			E'\telsif p.idle_since is null and not public.qorpera_company_deleting(o.profile_id)\n'
			|| E'\t\tand not public.qorpera_computer_hour_finish_window_over(o.profile_id,v_at) then\n'],
		array[E'\telsif public.qorpera_company_deleting(o.profile_id) or v_at>=p.idle_since+(case',
			E'\telsif public.qorpera_company_deleting(o.profile_id) or public.qorpera_computer_hour_finish_window_over(o.profile_id,v_at)\n'
			|| E'\t\tor v_at>=p.idle_since+(case']];
	v_index integer;
begin
	for v_index in 1 .. array_length(v_patches, 1) loop
		if (length(v_definition) - length(replace(v_definition, v_patches[v_index][1], ''))) / length(v_patches[v_index][1]) <> 1 then
			raise exception 'Computer hours: the office idle check differs (%)', v_index;
		end if;
		v_definition := replace(v_definition, v_patches[v_index][1], v_patches[v_index][2]);
	end loop;
	execute v_definition;
end
$idle$;

-- Why a started computer is not up yet: the company is out of computer hours ('hours'), its host
-- is not prepared for it ('setup'), or prepared hosts have no room ('room'). Null otherwise. A
-- sleeping computer says 'hours' too: it wakes once hours are added.
create or replace function public.qorpera_runtime_office_start_wait(p_office public.qorpera_runtime_offices)
returns text
language sql
stable
security definer
set search_path = ''
as $$
	select case
		when p_office.state = 'maintenance' then case when public.qorpera_runtime_office_idle_pending(p_office)
			and public.qorpera_company_at_zero(p_office.profile_id, clock_timestamp()) then 'hours' end
		when p_office.state not in ('provisioning', 'recovering') then null
		when not exists(select 1 from public.qorpera_runtime_office_start_intents i where i.office_id = p_office.id
			and i.computer_generation = p_office.generation and i.state <> 'cancelled') then null
		when exists(select 1 from public.qorpera_runtime_office_providers p where p.office_id = p_office.id
			and p.computer_generation = p_office.generation) then null
		when public.qorpera_company_at_zero(p_office.profile_id, clock_timestamp()) then 'hours'
		when exists(select 1 from public.qorpera_runtime_office_fleet_offers f where f.office_id = p_office.id
			and f.computer_generation = p_office.generation and f.ready_at > clock_timestamp() - interval '60 seconds') then 'room'
		else 'setup' end
$$;
