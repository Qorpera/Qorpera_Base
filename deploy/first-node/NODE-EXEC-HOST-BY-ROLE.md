# The fast host listed by its job (identical nodes, change 6)

Design page: "Identical Nodes" (https://claude.ai/artifact/8Gm5z4Jym3fpLWpeXe4t9Y), step 2. Migration
`20260928186000`.

## Why

Every runtime release rebuilds each node's shared execution host (the fast host) from the new runner
image. `lxc rebuild` keeps the machine: its physical UUID, devices, profiles and limits. But LXD copies
the new image's `image.*` keys into the machine's configuration, so the host's inventory digest
changes. Until now the coordinator had to replace the node's inventory policy and restart the observer
after every rebuild, and the node reported unavailable in between.

## The rule

An infrastructure entry in a node's inventory policy may declare `"role": "execution-host"`:

```json
{ "project": "qn25b2", "name": "qorpera-exec-node02", "physicalId": "<volatile.uuid>",
  "type": "virtual-machine", "configurationSha256": "<digest without image.*>",
  "cpuMillis": 4000, "memoryBytes": 8589934592, "role": "execution-host" }
```

- Only for a virtual machine. It may also declare `identityVolumes`.
- The observer leaves LXD's `image.*` keys out of that entry's digest.
- In their place it checks the image itself. The host's `volatile.base_image` (the same in its own and
  its expanded configuration) must be a runner image that a signed node-agent release on the node pins:
  - the provider role's `QORPERA_LXD_IMAGE_FINGERPRINT`,
  - in any release folder under `/opt/qorpera-node/releases` (staged, current or the rollback; the
    newest 16 by revision),
  - whose `release.json` verifies against the node's enrolled release key
    (`/etc/qorpera-node/keys/release.pem`).
- Otherwise the entry is `INSTANCE_IMAGE_NOT_RELEASED` and the node is unavailable. No key or no
  releases means no image is accepted.
- Everything else stays exact: name, physical UUID, type, profiles, devices, every other configuration
  key, size. Any other difference is `INSTANCE_AUTHORITY_DIFFERS`, as before.
- The observer reads the releases only when an entry declares a role. Policies without one behave
  exactly as before.
- An observer without this change refuses a policy with a role, so the node reports unavailable rather
  than half-checked.

The digest for the entry:

```sh
lxc query '/1.0/instances/<host>?project=<project>' \
  | deploy/shared-execution/exec-host-inventory-digest.py [--pool <pool> --source-prefix <prefix>] --role execution-host
```

## Rollout (coordinator, at a cut)

No runner, image or guest change, and no bundle input. The migration is safe for the running bundle,
so it needs no pause.

0. **Read-only checks.** The node agent runs on the node (phase B, live on both nodes since
   2026-09-23), with the release key installed. The fast host's current image is pinned by a release
   on the node: compare the host's `volatile.base_image` with the provider role's
   `QORPERA_LXD_IMAGE_FINGERPRINT` in `/opt/qorpera-node/current/release.json`.
1. **Migration.** Apply `20260928186000` (dry run first). Guard marker for the release branch:
   `'INSTANCE_IMAGE_NOT_RELEASED'` in `qorpera_observe_runtime_node_inventory`. Check that it is
   ABSENT live first. Existing policies are unaffected.
2. **Observer.** Build the observer package from the release commit
   (`node scripts/package-runtime-node-observer.mjs --out <dir>`) and install it on each node through
   the reviewed observer installation (`NODE-OBSERVER-INSTALLATION.md`). With no role in the policy,
   it behaves as before.
3. **Policy, per node with a fast host** (node 2 today; node 1 once its host exists, #434):
   - compute the entry's digest with `--role execution-host` as above;
   - replace the node's policy with the same policy, the host's entry carrying
     `"role": "execution-host"` and that digest (`qorpera_replace_runtime_node_inventory`);
   - write the same policy to the observer configuration and restart the observer.

   Between the replace and the restart the node reports unavailable for a few seconds
   (`NODE_OBSERVER_POLICY_DIFFERS`). Do it in a quiet moment, or empty the node first (change 1).
4. **Check** that the node reports `ready` and the host's entry has reason `null`.

## After the rollout

- A fast host rebuild needs no new policy, provided the release that pins the new image is **staged**
  on the node before the rebuild. Otherwise the node reports `INSTANCE_IMAGE_NOT_RELEASED` until it is.
- Run `agent gc` only after the rebuild. A host still on an image whose release was removed reports
  `INSTANCE_IMAGE_NOT_RELEASED`.
- The cut lane's re-enrol step after the fast host rebuild is dropped for a host listed by role.
- A change to anything else about the host (size, devices, profile) still needs a new policy, as
  before.

## Rollback

Replace the policy with the exact entry again (no role, digest with `image.*`, from
`exec-host-inventory-digest.py` without `--role`), write it to the observer configuration and restart
the observer. Only then may an older observer be installed, since it refuses a policy with a role.
