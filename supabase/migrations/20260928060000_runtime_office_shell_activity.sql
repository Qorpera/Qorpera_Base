-- 20260928060000: a command still running in a Company Computer shell keeps
-- the computer on (founder decision 2026-09-28: the shell has no 15-second
-- stop, and background processes live until the computer powers off or the
-- agent stops them). Each screen has its agent's shell. The office reports,
-- every 30 seconds while anything runs, the screens whose shells are busy; a
-- report is fresh for 90 seconds, so a lost office or a report that stops lets
-- the idle policy proceed. A report is not a wake: it counts only for the
-- office's current generation, and an office already powering off is not
-- woken by it. Per screen, so a busy shell can also keep its agent's seat.

create table public.qorpera_runtime_office_shell_activity (
	screen_id uuid primary key references public.qorpera_runtime_office_screens(id) on delete cascade,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete cascade,
	computer_generation bigint not null,
	busy_until timestamptz not null,
	reported_at timestamptz not null
);
create index qorpera_runtime_office_shell_activity_office on public.qorpera_runtime_office_shell_activity(office_id);
alter table public.qorpera_runtime_office_shell_activity enable row level security;
revoke all on public.qorpera_runtime_office_shell_activity from public,anon,authenticated,service_role;

-- The whole set: screens missing from a report have nothing running.
create function public.qorpera_report_runtime_office_shell_activity(p_scope jsonb,p_computer_generation bigint,p_screen_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_at timestamptz:=clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	if p_screen_ids is null or cardinality(p_screen_ids)>64 or array_position(p_screen_ids,null) is not null then
		raise exception 'Invalid office shell activity' using errcode='22023'; end if;
	-- The same office row lock the idle reconciler and the supervisor take.
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation then
		raise exception 'Office shell activity binding differs' using errcode='42501'; end if;
	if exists(select 1 from unnest(p_screen_ids) as reported(id) where not exists(
		select 1 from public.qorpera_runtime_office_screens s where s.id=reported.id and s.office_id=v_office.id)) then
		raise exception 'Office shell activity screen differs' using errcode='42501'; end if;
	delete from public.qorpera_runtime_office_shell_activity where office_id=v_office.id and screen_id<>all(p_screen_ids);
	insert into public.qorpera_runtime_office_shell_activity(screen_id,office_id,computer_generation,busy_until,reported_at)
		select distinct reported.id,v_office.id,v_office.generation,v_at+interval '90 seconds',v_at from unnest(p_screen_ids) as reported(id)
		on conflict(screen_id) do update set office_id=excluded.office_id,computer_generation=excluded.computer_generation,
			busy_until=excluded.busy_until,reported_at=excluded.reported_at;
	return jsonb_build_object('schema','qorpera.office-shell-activity/v1','screens',
		(select coalesce(jsonb_agg(distinct reported.id),'[]'::jsonb) from unnest(p_screen_ids) as reported(id)));
end $$;
revoke all on function public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_report_runtime_office_shell_activity(jsonb,bigint,uuid[]) to service_role;

-- Patched in place, like 20260919020000 does, so other demand patches commute.
create function pg_temp.office_shell_activity_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office shell activity integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.office_shell_activity_patch('public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure,
	$old$and (w.status='queued' or j.status in ('queued','leased','running')))$old$,
	$new$and (w.status='queued' or j.status in ('queued','leased','running')))
		-- A command still running in a Company Computer shell (20260928060000).
		or exists(select 1 from public.qorpera_runtime_office_shell_activity a where a.office_id=p_office.id
			and a.computer_generation=p_office.generation and a.busy_until>clock_timestamp())$new$);

-- The demand function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid='public.qorpera_runtime_office_has_demand(public.qorpera_runtime_offices)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office demand function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_runtime_office_shell_activity to %I',v_owner); end if;
end $$;
