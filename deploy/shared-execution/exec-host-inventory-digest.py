#!/usr/bin/env python3
"""Inventory digest of a shared execution host, exactly as the node inventory
observer computes it (packages/runner-orchestrator/src/runtime-node-inventory.ts,
runtimeNodeInstanceConfiguration; the identity-device rule is
execution-host-identity.ts). Read-only: it only reads the instance JSON.

    lxc query '/1.0/instances/qorpera-exec-node02?project=qn25b2' \\
      | exec-host-inventory-digest.py --pool qorpera-vm --source-prefix phql-a1-identity-

prints {"configurationSha256": "...", "identities": ["<uuid>", ...]}: the
digest to enroll for an infrastructure entry that declares
identityVolumes {"pool": ..., "sourcePrefix": ...}, and the identity devices
it leaves out (each exactly identity-<uuid> = {type: disk, pool, source:
<prefix><uuid>, path: /var/lib/qorpera/identities/<uuid>}, the same in the
instance's own and expanded devices). Without --pool/--source-prefix it prints
the digest of an entry without identityVolumes, where every device counts.
With --role execution-host it prints the digest of an entry listed by role
(`"role": "execution-host"`): LXD's image.* keys are left out, because the
observer checks the image against the node's signed releases instead, so a
rebuild onto a released image keeps the digest.

Operator wrappers (refresh-host.py, snapshot.py, operator.py) may import
`configuration(instance, pool, prefix, role)` instead of their own `shape()`.
"""
import argparse
import hashlib
import json
import re
import sys

IDENTITY_ROOT = "/var/lib/qorpera/identities/"
DEVICE = re.compile(r"identity-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})")
POOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}")
PREFIX = re.compile(r"[a-z][a-z0-9-]{0,31}")
ROLES = ("execution-host",)


def identity_of(pool, prefix, name, device):
    match = DEVICE.fullmatch(name)
    if not match or not isinstance(device, dict):
        return None
    identity = match.group(1)
    expected = {"type": "disk", "pool": pool, "source": prefix + identity, "path": IDENTITY_ROOT + identity}
    return identity if device == expected else None


def configuration(instance, pool=None, prefix=None, role=None):
    """(configurationSha256, identities) of an `lxc query /1.0/instances/<name>` document."""
    if role is not None and role not in ROLES:
        raise ValueError("invalid role")
    devices, expanded = instance["devices"], instance["expanded_devices"]
    identities = []
    if pool is not None or prefix is not None:
        if not (isinstance(pool, str) and POOL.fullmatch(pool) and isinstance(prefix, str) and PREFIX.fullmatch(prefix)):
            raise ValueError("invalid identity volume pool or prefix")
        names = [
            name
            for name in devices
            if identity_of(pool, prefix, name, devices[name]) is not None
            and identity_of(pool, prefix, name, expanded.get(name)) == identity_of(pool, prefix, name, devices[name])
        ]
        identities = sorted(name[len("identity-"):] for name in names)
        devices = {k: v for k, v in devices.items() if k not in names}
        expanded = {k: v for k, v in expanded.items() if k not in names}
    stable = lambda config: {  # noqa: E731
        k: v for k, v in config.items() if not k.startswith("volatile.") and not (role and k.startswith("image."))
    }
    shape = {
        "type": instance["type"],
        "profiles": instance["profiles"],
        "config": stable(instance["config"]),
        "expandedConfig": stable(instance["expanded_config"]),
        "devices": devices,
        "expandedDevices": expanded,
    }
    # JSON.stringify of sorted keys: compact, non-ASCII kept as UTF-8.
    canonical = json.dumps(shape, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest(), identities


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--pool")
    parser.add_argument("--source-prefix")
    parser.add_argument("--role", choices=ROLES)
    args = parser.parse_args()
    instance = json.load(sys.stdin)
    digest, identities = configuration(instance, args.pool, args.source_prefix, args.role)
    print(json.dumps({"configurationSha256": digest, "identities": identities}))


if __name__ == "__main__":
    main()
