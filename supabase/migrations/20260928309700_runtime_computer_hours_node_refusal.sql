-- Computer hours, build step 6b part 1: machines do not start or wake at zero (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero": no machine
-- starts or wakes). Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero"). Agreed with the
-- nodes session (S3): the refusal sits in the node reserve, the one writer of `reserved_at` /
-- `suspended_at`, after NODE_DISABLED and with the same demand condition.
--
-- `qorpera_reserve_runtime_node_machine` refuses, with `COMPUTER_HOURS_EXHAUSTED`, a new reservation
-- or the wake of a sleeping machine of a company at zero, for Company Computers (`office`), coding
-- machines (`coding`) and agents' machines (`machine`). A machine already reserved and awake passes,
-- as on an emptying node: running work finishes its hour (the finishing window stops it). Run
-- machines (`native`) and sign-in machines (`login`) are never refused here: a run created before
-- the company ran out is running work, and a sign-in is not the company's work. NODE_DISABLED wins
-- when both hold. The demand's `last_refusal` may now say COMPUTER_HOURS_EXHAUSTED.
--
-- The runner orchestrator learns the reason in the same change (node admission and the coding
-- executor, which waits it out), and its binaries are installed on both nodes before the zero rule
-- is switched on. While the rule is off `qorpera_company_at_zero` is false and nothing changes.

set local lock_timeout = '3s';

do $check$
declare v_name text;
begin
	select constraint_row.conname into strict v_name
	from pg_constraint constraint_row
	where constraint_row.conrelid = 'public.qorpera_runtime_node_demands'::regclass and constraint_row.contype = 'c'
		and pg_get_constraintdef(constraint_row.oid) like '%last_refusal%';
	execute format('alter table public.qorpera_runtime_node_demands drop constraint %I', v_name);
end
$check$;
alter table public.qorpera_runtime_node_demands add constraint qorpera_runtime_node_demands_last_refusal_check
	check (last_refusal in ('NODE_DISABLED', 'NODE_OBSERVATION_UNAVAILABLE', 'NODE_HARDWARE_CHANGED',
		'NODE_CAPACITY_EXHAUSTED', 'COMPUTER_HOURS_EXHAUSTED'));

do $admission$
declare
	v_definition text := pg_get_functiondef(
		'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure);
	v_old text := $old$ then v_reason:='NODE_DISABLED';$old$;
	v_new text := $new$ then v_reason:='NODE_DISABLED';
 elsif p_provider_kind in ('office','coding','machine') and (v_demand.reserved_at is null or v_demand.suspended_at is not null)
  and public.qorpera_company_at_zero(v_profile, clock_timestamp()) then v_reason:='COMPUTER_HOURS_EXHAUSTED';$new$;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Computer hours node refusal: the NODE_DISABLED anchor is not present exactly once';
	end if;
	execute replace(v_definition, v_old, v_new);
end
$admission$;
