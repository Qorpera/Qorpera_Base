-- 20260930659000: every boot of a company machine is kept, with the ask it answered (perf sprint round 2, 8 November
-- 2026, measure T9: stopped to ready, the scoreboard's A5).
-- Stopped to ready could not be read back: a machine keeps only its latest ask (wanted_at, its last start or wake) and
-- its current boot's running_at, which a stop clears. From 7 November 00:10Z to 8 November 00:10Z the executors finished
-- 27 boots, and 13 of them still had their ask on record.
-- 1. qorpera_company_machine_boots: one row per boot the executor marks running, with the machine's ask at that moment,
--    when its placement was made (after the ask: a new disk), the mark itself, who asked (desired_by) and whether the
--    boot answered no ask (restarted): the placement's previous boot was still marked running, or an earlier boot
--    already answered this ask (a move to a new disk without a new start, as a folder retirement or a given-up node
--    makes). Ids and times only.
-- 2. qorpera_mark_company_machine_running writes the row in the step that marks the new boot, under the machine and
--    placement locks its custody already holds. A boot id the placement had before (a guest reporting it again after
--    a stop) adds no row and marks as before. Each new boot also removes up to 50 rows over 30 days old, of any machine,
--    skipping rows another session holds: about 27 boots a day add as many rows, so the table holds the last 30 days
--    (rows of removed machines included). Once per boot: nothing on a hot path, no wait, the lock order unchanged. A
--    boot the function keeps out (not wanted running, no room, no boot id) writes nothing, as before.
-- 3. Row security on and no API role reaches it: the operators' own database roles read it. The mark function's owner
--    may be private in production (deploy/first-node/RUNTIME-COMPANY-COMPUTER-SCALE-OUT.md); it is given what its new
--    text uses, and the migration fails unless it can (read on production 8 November: postgres owns the function and
--    every table, and runs the migrations, so the grant is a no-op there).
-- Exact-text patch: it fails unless the function has the text given exactly once.

set local lock_timeout = '3s';

create table public.qorpera_company_machine_boots (
	id uuid primary key default extensions.gen_random_uuid(),
	machine_id uuid not null references public.qorpera_company_machines(id) on delete cascade,
	placement_id uuid not null references public.qorpera_company_machine_placements(id) on delete cascade,
	profile_id uuid not null,
	boot_id uuid not null,
	-- The machine's wanted_at when the boot was marked: the start or wake it answered (an old one for a restart).
	asked_at timestamptz not null,
	-- The placement's creation: later than the ask when this wake made a new disk (a first start, or a move).
	placed_at timestamptz not null,
	-- The placement's running_at: the executor saw the guest ready in this boot.
	ready_at timestamptz not null,
	asked_by text not null check (asked_by in ('agent','member','kernel')),
	-- It answered no ask: the placement's previous boot was still marked running (the guest restarted), or an earlier
	-- boot already answered this ask (a move to a new disk). Its asked_at is then an old one.
	restarted boolean not null,
	unique (placement_id, boot_id)
);
create index qorpera_company_machine_boots_machine on public.qorpera_company_machine_boots (machine_id, ready_at);
create index qorpera_company_machine_boots_ready on public.qorpera_company_machine_boots (ready_at);
alter table public.qorpera_company_machine_boots enable row level security;
revoke all on public.qorpera_company_machine_boots from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.company_machine_boots_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

select pg_temp.company_machine_boots_patch('public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure,
	$old$update public.qorpera_company_machine_placements set running_at = clock_timestamp(), boot_id = p_boot_id where id = v_placement.id;$old$,
	$new$update public.qorpera_company_machine_placements set running_at = clock_timestamp(), boot_id = p_boot_id where id = v_placement.id;
		-- 20260930659000: the boot is kept with the ask it answered, past the next stop (the custody holds the machine and
		-- the placement). v_placement is the row before the mark: a boot id there means a boot still marked running.
		insert into public.qorpera_company_machine_boots(machine_id, placement_id, profile_id, boot_id, asked_at, placed_at, ready_at,
			asked_by, restarted)
		select v_machine.id, placement.id, placement.profile_id, placement.boot_id, v_machine.wanted_at, placement.created_at,
			placement.running_at, v_machine.desired_by, v_placement.boot_id is not null or exists (select 1
				from public.qorpera_company_machine_boots answered
				where answered.machine_id = v_machine.id and answered.ready_at >= v_machine.wanted_at)
		from public.qorpera_company_machine_placements placement where placement.id = v_placement.id
		on conflict (placement_id, boot_id) do nothing;
		delete from public.qorpera_company_machine_boots where id in (select expired.id from public.qorpera_company_machine_boots expired
			where expired.ready_at < clock_timestamp() - interval '30 days' order by expired.ready_at limit 50 for update skip locked);$new$);

-- 3. The mark function may have a private owner in production: it reaches the boots, as 20260928489140 grants its
--    sibling's owner. FOR UPDATE in the expiry needs update.
do $$ declare v_owner name := (select pg_get_userbyid(proowner) from pg_proc
	where oid = 'public.qorpera_mark_company_machine_running(uuid,text,text,text,uuid)'::regprocedure);
begin
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'qorpera_mark_company_machine_running has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select, insert, update, delete on public.qorpera_company_machine_boots to %I', v_owner); end if;
	-- Row security has no policy here, so the owner must own the table or pass row security, as for the machine tables.
	if not (has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'select')
			and has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'insert')
			and has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'update')
			and has_table_privilege(v_owner, 'public.qorpera_company_machine_boots', 'delete'))
		or not (v_owner = (select pg_get_userbyid(relowner) from pg_class where oid = 'public.qorpera_company_machine_boots'::regclass)
			or exists (select 1 from pg_roles where rolname = v_owner and (rolsuper or rolbypassrls))) then
		raise exception 'The owner of qorpera_mark_company_machine_running (%) cannot keep the boots', v_owner; end if;
end $$;
