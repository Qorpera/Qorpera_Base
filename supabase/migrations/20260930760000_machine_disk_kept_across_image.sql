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
-- No table changes. The function is replaced in place (create or replace through its own definition): no table lock;
-- admissions running meanwhile finish on the old body. Patched by exact text: the migration fails unless the old line is
-- there exactly once. The new body names this migration, for the deploy guards.
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
