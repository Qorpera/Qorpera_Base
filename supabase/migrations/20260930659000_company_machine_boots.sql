-- 20260930659000: every boot of a company machine is kept, with the ask it answered (perf sprint round 2, 8 November
-- 2026, measure T9: stopped to ready, the scoreboard's A5).
-- Stopped to ready could not be read back: a machine keeps only its latest ask (wanted_at, its last start or wake) and
-- its current boot's running_at, which a stop clears. From 7 November 00:10Z to 8 November 00:10Z the executors finished
-- 27 boots, and 13 of them still had their ask on record.
-- 1. qorpera_company_machine_boots: one row per boot the executor marks running, with the machine's ask at that moment,
--    when its placement was made (after the ask: a new disk), the mark itself, who asked (desired_by) and whether the
--    boot replaced one still marked running (a restart no one asked for, whose ask is an old one). Ids and times only.
-- 2. qorpera_mark_company_machine_running writes the row in the step that marks the new boot, under the machine and
--    placement locks its custody already holds, and removes this machine's rows over 30 days old (so the table holds
--    each machine's last month; a row is about 150 bytes, a few dozen boots a day). Once per boot: nothing on a hot
--    path, no new lock, the lock order unchanged. A boot the function keeps out (not wanted running, no room, no boot
--    id) writes nothing, as before.
-- 3. Row security on and no API role reaches it: the operators' own database roles read it.
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
	-- The placement's previous boot was still marked running: the guest restarted without a stop or an ask.
	restarted boolean not null,
	unique (placement_id, boot_id)
);
create index qorpera_company_machine_boots_machine on public.qorpera_company_machine_boots (machine_id, ready_at);
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
			placement.running_at, v_machine.desired_by, v_placement.boot_id is not null
		from public.qorpera_company_machine_placements placement where placement.id = v_placement.id;
		delete from public.qorpera_company_machine_boots where machine_id = v_machine.id and ready_at < clock_timestamp() - interval '30 days';$new$);
