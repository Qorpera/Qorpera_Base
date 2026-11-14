-- 20260930760000 (agent-box, 14 Nov 2026): a sleeping machine keeps its disk when the machine image changes.
--
-- What was wrong: a sleeping machine's placement was "stale" whenever its binding did not hold the executor's WHOLE
-- policy (qorpera_admit_company_machine, first written in 20260928259050: `not (v_placement.binding @> v_executor.policy)`).
-- The policy holds the image, the bootstrap and providerPolicySha256, which hashes the guest helper and the largest
-- machine the node makes too (scripts/machine-provider-policy.mjs). So every new image, bootstrap, helper or larger node
-- shape woke every sleeping machine on a new disk, cloned from the new image: what the agent installed or left outside
-- /company was gone (it was told, diskFreed, since 20260930757000, but the files were still lost). Read on production
-- 14 Nov: 11 sleeping machines on node 2 still hold disks of the image before (policy deb84d79, image c03bca32).
--
-- The change, one line of qorpera_admit_company_machine: a placement is stale only when the executor has no policy, or
-- the placement is in another PLACE than the executor makes machines now: another project, storage pool, network or
-- provider (the keys the executor's own plan holds a placement to, or its disk lives by). A new image, bootstrap, helper
-- or largest size keeps the placement: the machine wakes on its own disk, from the image it was made with. (Without a
-- policy, or without an executor row, the four keys read null, so they differ: stale, as before.)
--
-- Why that is safe, in short (the pull request walks each path):
-- * The wake reserves through the placement's OWN provider row (its binding's providerId and providerPolicySha256),
--   which stays enrolled: no migration deletes a provider row, and its node demand's foreign key keeps it. The size
--   check is that row's, which the machine passed when it was placed.
-- * If that reservation refuses or fails all the same (no such row: NODE_PROVIDER_UNCONFIGURED; a machine larger than
--   that row: 42501, NODE_UNAVAILABLE), a machine that is not running moves to a new disk as before, and is told
--   (disk_freed_at, diskFreed); with no room anywhere it waits in line on its old disk.
-- * The executor checks a placement's project and provider against its own (#plan), the node inventory the demand's
--   policy hash, and the instance against the request derived from the BINDING (its own image): an earlier policy's
--   placement passes all three. Its guest helper must be one the executor accepts (helperSha256 or
--   previousHelperSha256s): the roll scripts keep the earlier one.
-- * A running machine is untouched (it is reserved; nothing here runs for it), and a placement moved for any other
--   reason (no room on its node, the folder's new-disk rule, a give-away under real disk pressure) moves as before.
--
-- The way out when the executor no longer accepts a kept machine's guest helper (review r1 F2 of #1788). Only the executor
-- knows the helpers it accepts (helperSha256 and previousHelperSha256s, at most 16); one dropped from that list made every
-- machine of its image fail each start with COMPANY_MACHINE_HELPER_DIFFERS, for good, as SQL keeps its placement now. The
-- executor already records that code on the placement (qorpera_record_company_machine_error, stage start). From now on
-- that record also retires the placement when it was made under an EARLIER policy of its executor (its binding does not
-- hold the executor's policy now) and has no usable boot (not marked running: asleep and being woken, or a start whose
-- guest never became ready), under the same check the record makes (the placement's executor and node, not retired, not
-- removed): its commands end lost (the runs that asked are told), and the machine keeps when its disk went
-- (disk_freed_at), so its view says diskFreed and a take-again says it starts empty. The executor then stops it if it
-- holds room and deletes its VM and disk (removeDue), as any retired placement. A machine still wanted running starts on
-- a new disk at its next admission, on the current policy; one not wanted running stays without a placement until it is
-- asked for again. A machine that is RUNNING (always-on ones too) is never retired this way (review r2 F1 of #1788): a
-- helper dropped from the executor's list by mistake would otherwise take every running disk of that image at the next
-- pass; it keeps recording the error each pass, as before, until the helper is listed again or someone stops it, and
-- only then, asleep, does it start on a new disk. It cannot loop: a placement on the current policy is never retired
-- this way (its image's helper is the executor's current one; were the executor configured with another, every new
-- machine would fail alike, and retiring would only make one VM after another). Once retired, a second record is a
-- no-op. The way out takes the company's machine fence briefly, then the machine and the placement; when the fence is
-- busy past its brief wait, or refuses (a company being deleted), nothing is retired by that record and the record itself
-- goes on. Any other code, and the error's recording, are as before.
--
-- No table changes. The two functions are replaced in place (create or replace through their own definition): no table
-- lock; calls running meanwhile finish on the old body. Patched by exact text: the migration fails unless each old text
-- is there exactly once. The new bodies name this migration, for the deploy guards.
set local lock_timeout = '3s';

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_admit_company_machine(uuid,text)'::regprocedure);
	v_old text := $old$		v_stale := v_executor.policy is null or not (v_placement.binding @> v_executor.policy);$old$;
	v_new text := $new$		-- 20260930760000: stale only in another place than its executor makes machines now (another project, storage
		-- pool, network or provider; an executor without a policy, or none, differs in all four). A new image, bootstrap,
		-- helper or largest size keeps it: it wakes on its own disk.
		v_stale := (v_placement.binding ->> 'project', v_placement.binding ->> 'storagePool', v_placement.binding ->> 'network',
				v_placement.binding ->> 'providerId')
			is distinct from (v_executor.policy ->> 'project', v_executor.policy ->> 'storagePool', v_executor.policy ->> 'network',
				v_executor.policy ->> 'providerId');$new$;
begin
	if position('20260930760000' in v_definition) > 0 then raise exception '20260930760000 is already applied'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930760000 anchor differs in qorpera_admit_company_machine: %', left(v_old, 80); end if;
	execute replace(v_definition, v_old, v_new);
end $$;

-- The way out for a kept machine whose guest helper its executor refuses (review r1 F2 of #1788). Internal: called by
-- qorpera_record_company_machine_error, which checked the service role. Locks as custody does: the company's fence
-- (briefly), the machine, then the placement. True when it retired the placement.
create function public.qorpera_company_machine_helper_refused(p_placement_id uuid, p_owner text, p_machine_id_sha256 text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_policy jsonb;
begin
	-- 20260930760000
	perform public.qorpera_company_machine_fence_briefly(placement.profile_id) from public.qorpera_company_machine_placements placement
	where placement.id = p_placement_id;
	select machine.* into v_machine from public.qorpera_company_machines machine join public.qorpera_company_machine_placements placement
		on placement.machine_id = machine.id where placement.id = p_placement_id for update of machine;
	select * into v_placement from public.qorpera_company_machine_placements where id = p_placement_id for update;
	-- The record's own check: the placement of this executor on its node, still current.
	if v_placement.id is null or v_placement.owner is distinct from p_owner or v_placement.machine_id_sha256 is distinct from p_machine_id_sha256
		or v_placement.retired_at is not null or v_placement.removed_at is not null then
		return false; end if;
	-- Only one made under an earlier policy of its executor: a new placement, on the current policy, is never retired so.
	select policy into v_policy from public.qorpera_machine_executors where owner = v_placement.owner;
	if v_placement.binding @> v_policy then return false; end if;
	-- Only one without a usable boot: a running machine (always-on ones too) is never taken by one refusal (review r2 F1).
	if v_placement.running_at is not null then return false; end if;
	-- Its programs stop with it; the runs that asked are told.
	perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
	update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = v_placement.id;
	-- Its disk goes with the placement: the machine is told (its view's diskFreed, a take-again's reused).
	update public.qorpera_company_machines set disk_freed_at = clock_timestamp() where id = v_machine.id;
	return true;
end $$;
revoke all on function public.qorpera_company_machine_helper_refused(uuid, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_record_company_machine_error(uuid,text,text,text,text)'::regprocedure);
	v_old text := $old$		raise exception 'Machine error invalid' using errcode = '22023'; end if;
$old$;
	v_new text := $new$		raise exception 'Machine error invalid' using errcode = '22023'; end if;
	-- 20260930760000: a guest helper its executor refuses, on a placement of an earlier policy that is not running, retires
	-- that placement (the machine is told; it starts on a new disk when asked). A company whose fence is busy, or that is
	-- being deleted, is not retired by this record; the record goes on.
	if p_code = 'COMPANY_MACHINE_HELPER_DIFFERS' then
		begin
			perform public.qorpera_company_machine_helper_refused(p_placement_id, p_owner, p_machine_id_sha256);
		exception when lock_not_available or insufficient_privilege then null;
		end;
	end if;
$new$;
begin
	if position('20260930760000' in v_definition) > 0 then raise exception '20260930760000 is already applied'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930760000 anchor differs in qorpera_record_company_machine_error: %', left(v_old, 80); end if;
	execute replace(v_definition, v_old, v_new);
end $$;
