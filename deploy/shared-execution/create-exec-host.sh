#!/usr/bin/env bash
# Create a shared execution host (fast host) on any node, then install it with
# rebuild-exec-host.sh. Run as root on the node host (through the reviewed
# task-admin helper). Identical nodes, change 5 (deploy/first-node/RUNTIME-IDENTICAL-NODES.md).
#
#   create-exec-host.sh <image-fingerprint>
#
# Environment, all required:
#   EXEC_VM, EXEC_PROJECT, EXEC_PACKAGE, EXEC_STAGING, EXEC_SLOTS  as for rebuild-exec-host.sh
#   EXEC_PROFILE     LXD profile the node's run VMs use          (e.g. native25-job-a1)
#   EXEC_POOL        storage pool                                (e.g. qorpera-vm)
#   EXEC_NETWORK     managed network of the run VMs              (e.g. qorpera0)
# Optional:
#   EXEC_SLOT_CPU    vCPUs per slot     (2)   the host gets EXEC_SLOTS x EXEC_SLOT_CPU vCPUs
#   EXEC_SLOT_GIB    GiB memory per slot (4)  and EXEC_SLOTS x EXEC_SLOT_GIB GiB memory
#
# The host gets no identity devices: with logins in the vault (Stateless Compute
# step 1) no fast host mounts a login disk. A node whose logins still live on
# identity volumes keeps its existing host (node 2) until those logins move.
# The script prints the host's inventory entry; the operator enrolls it
# (qorpera_replace_runtime_node_inventory) and writes the observer configuration
# before the node can take work again: from `lxc init` until then the node's
# observer sees an instance its policy does not list and publishes the node
# unavailable, so the node takes no new work. The orchestrator inside the host
# stays stopped until the operator starts it. If any step after `lxc init`
# fails, the script deletes the VM it made (nothing ran in it). An orchestrator
# row it registered stays: nothing runs behind it, so it claims nothing, but the
# bundle roll status lists it as undeclared until the operator revokes it.
#
# The staged runner-orchestrator.env must name a NEW orchestrator id. Reusing
# another host's id re-registers that orchestrator here and takes it over.
set -euo pipefail
# Modes of rebuild-exec-host.sh are set here for its own calls only, never
# inherited from the caller's shell. A new host is not declared for a bundle:
# a refused declaration would delete a host that is otherwise set up. Declare
# it after enrolment if a rolling update needs it.
unset EXEC_PREFLIGHT_ONLY EXEC_FRESH EXEC_RUNTIME_BUNDLE_SHA256
HERE="$(cd "$(dirname "$0")" && pwd)"

FINGERPRINT="${1:-}"
if [[ ! ${FINGERPRINT} =~ ^[0-9a-f]{64}$ ]]; then
	echo "usage: $0 <image-fingerprint-sha256>" >&2
	exit 1
fi
if [[ ${EUID} -ne 0 ]]; then
	echo "Run as root on the node host." >&2
	exit 1
fi
for name in EXEC_VM EXEC_PROJECT EXEC_PACKAGE EXEC_STAGING EXEC_SLOTS EXEC_PROFILE EXEC_POOL EXEC_NETWORK; do
	[[ -n ${!name:-} ]] || { echo "${name} is required (no node defaults)." >&2; exit 1; }
done
VM="${EXEC_VM}"
PROJECT="${EXEC_PROJECT}"
SLOTS="${EXEC_SLOTS}"
SLOT_CPU="${EXEC_SLOT_CPU:-2}"
SLOT_GIB="${EXEC_SLOT_GIB:-4}"
if [[ ! ${VM} =~ ^qorpera-exec-[a-z0-9-]{1,40}$ ]]; then
	echo "EXEC_VM must be qorpera-exec-<short node name>, e.g. qorpera-exec-node01." >&2
	exit 1
fi
if [[ ! ${SLOTS} =~ ^[1-9][0-9]?$ ]] || ((SLOTS > 64)) || [[ ! ${SLOT_CPU} =~ ^[1-9]$ ]] || [[ ! ${SLOT_GIB} =~ ^[1-9][0-9]?$ ]]; then
	echo "EXEC_SLOTS (1-64), EXEC_SLOT_CPU (1-9) and EXEC_SLOT_GIB (1-99) must be whole numbers." >&2
	exit 1
fi
if lxc info "${VM}" --project "${PROJECT}" >/dev/null 2>&1; then
	echo "${VM} already exists in ${PROJECT}; use rebuild-exec-host.sh." >&2
	exit 1
fi
# The run profile is part of the host's inventory digest; the observer refuses an
# infrastructure entry with any user.qorpera.* key.
for file in rebuild-exec-host.sh exec-host-inventory-digest.py; do
	[[ -f ${HERE}/${file} ]] || { echo "${HERE}/${file} is missing." >&2; exit 1; }
done
profile_keys=$(lxc query "/1.0/profiles/${EXEC_PROFILE}?project=${PROJECT}" \
	| python3 -c 'import json,sys; print(sum(k.startswith("user.qorpera.") for k in json.load(sys.stdin)["config"]))')
if [[ ${profile_keys} != 0 ]]; then
	echo "Profile ${EXEC_PROFILE} sets a user.qorpera.* key; the host could never be enrolled." >&2
	exit 1
fi
# Every input the install needs is checked before anything is created.
EXEC_PREFLIGHT_ONLY=1 bash "${HERE}/rebuild-exec-host.sh" "${FINGERPRINT}"
CPU=$((SLOTS * SLOT_CPU))
MEMORY_GIB=$((SLOTS * SLOT_GIB))

echo "Creating ${VM} in ${PROJECT}: ${SLOTS} slots, ${CPU} vCPU, ${MEMORY_GIB} GiB."
created=
cleanup() {
	if [[ -n ${created} ]]; then
		echo "Failed; deleting the half-made ${VM}." >&2
		lxc delete --force "${VM}" --project "${PROJECT}" >&2 || echo "Could not delete ${VM}; delete it by hand." >&2
	fi
}
trap cleanup EXIT
lxc init "${FINGERPRINT}" "${VM}" --project "${PROJECT}" --vm \
	-p "${EXEC_PROFILE}" -s "${EXEC_POOL}" \
	-c "limits.cpu=${CPU}" -c "limits.memory=${MEMORY_GIB}GiB" -c boot.mode=uefi-secureboot \
	-d root,size=80GiB
# Only a VM this run made is ever deleted: an init that fails (the name exists) deletes nothing.
created=1
lxc config device add "${VM}" eth0 nic "network=${EXEC_NETWORK}" name=eth0 \
	security.ipv4_filtering=true security.ipv6_filtering=true \
	security.mac_filtering=true security.port_isolation=true --project "${PROJECT}" >/dev/null

# The same install, configuration and orchestrator registration as every rebuild,
# without the stop, sandbox check and rebuild a new host has no use for.
EXEC_FRESH=1 bash "${HERE}/rebuild-exec-host.sh" "${FINGERPRINT}"

echo "Inventory entry for this node's policy (enroll it, then write the observer configuration):"
digest=$(lxc query "/1.0/instances/${VM}?project=${PROJECT}" | python3 "${HERE}/exec-host-inventory-digest.py" \
	| python3 -c 'import json,sys; print(json.load(sys.stdin)["configurationSha256"])')
[[ ${digest} =~ ^[0-9a-f]{64}$ ]]
uuid=$(lxc config get "${VM}" volatile.uuid --project "${PROJECT}")
[[ ${uuid} =~ ^[0-9a-f-]{36}$ ]]
printf '{"project":"%s","name":"%s","physicalId":"%s","type":"virtual-machine","configurationSha256":"%s","cpuMillis":%d,"memoryBytes":%d}\n' \
	"${PROJECT}" "${VM}" "${uuid}" "${digest}" $((CPU * 1000)) $((MEMORY_GIB * 1024 * 1024 * 1024))
created=
