#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_LXD_VERSION="6.9-ab8fad2"
EXPECTED_LXD_REVISION="40424"
LXD_CHANNEL="6/stable"
LXD_PROJECT="qorpera-runners"
LXD_POOL="qorpera-vm"
LXD_DEVICE_LV="qorpera-lxd-pool"
LXD_DEVICE_SIZE_GIB=1400
LXD_ZPOOL="qorpera-lxd"
LXD_NETWORK="qorpera0"
LXD_SUBNET="10.41.0.1/24"
JOB_PROFILE="qorpera-job-v1"
LOGIN_PROFILE="qorpera-login-v1"
MANAGEMENT_PROFILE="qorpera-management-v1"
PROVIDER_USER="qorpera-provider"
HOST_STATE_LOG="/var/log/qorpera-lxd-host-state.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi

install -o root -g root -m 0644 /dev/null /var/log/qorpera-lxd-bootstrap.log
exec > >(tee /var/log/qorpera-lxd-bootstrap.log) 2>&1
echo "Starting controlled LXD host bootstrap on $(date --iso-8601=seconds)."

if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to configure LXD on unexpected host $(hostname)." >&2
	exit 1
fi

if ! grep -q '^VERSION_ID="26.04"$' /etc/os-release; then
	echo "This bootstrap is pinned to Ubuntu 26.04." >&2
	exit 1
fi

if [[ ! -c /dev/kvm ]]; then
	echo "/dev/kvm is unavailable; full-VM execution cannot be enforced." >&2
	exit 1
fi

modules_tmp=$(mktemp)
printf '%s\n' br_netfilter >"${modules_tmp}"
install -o root -g root -m 0644 "${modules_tmp}" /etc/modules-load.d/qorpera-lxd.conf
rm -f -- "${modules_tmp}"
/usr/sbin/modprobe br_netfilter
if ! grep -q '^br_netfilter ' /proc/modules; then
	echo "br_netfilter is unavailable; bridged guest anti-spoof filtering cannot be enforced." >&2
	exit 1
fi

if snap list lxd >/dev/null 2>&1; then
	installed_version=$(snap list lxd | awk 'NR == 2 { print $2 }')
	installed_revision=$(snap list lxd | awk 'NR == 2 { print $3 }')
	if [[ ${installed_version} != "${EXPECTED_LXD_VERSION}" || ${installed_revision} != "${EXPECTED_LXD_REVISION}" ]]; then
		echo "Installed LXD ${installed_version} revision ${installed_revision} does not match the controlled pin." >&2
		exit 1
	fi
else
	snap install lxd --channel="${LXD_CHANNEL}" --revision="${EXPECTED_LXD_REVISION}"
fi

snap refresh --hold=forever lxd
snap set lxd ui.enable=false daemon.group=lxd daemon.user.group=lxd
systemctl restart snap.lxd.daemon.service

daemon_ready=false
for _attempt in $(seq 1 60); do
	if lxc query /1.0 >/dev/null 2>&1; then
		daemon_ready=true
		break
	fi
	sleep 1
done
if [[ ${daemon_ready} != true ]]; then
	echo "LXD did not make its local API available after restart." >&2
	exit 1
fi

if ! getent passwd "${PROVIDER_USER}" >/dev/null; then
	useradd --system --create-home --home-dir /var/lib/qorpera-provider --shell /usr/sbin/nologin "${PROVIDER_USER}"
fi
install -d -o root -g root -m 0755 /etc/qorpera
install -d -o "${PROVIDER_USER}" -g "${PROVIDER_USER}" -m 0700 \
	/var/lib/qorpera-provider \
	/var/lib/qorpera-provider/runs

# The snap may enroll the installing sudo user. LXD group membership is root-
# equivalent, and the provider reaches LXD with its own client certificate on
# the loopback listener, so the group keeps no non-root member at all; a re-run
# also takes out a provider an older bootstrap added.
IFS=',' read -r -a lxd_members <<<"$(getent group lxd | cut -d: -f4)"
for member in "${lxd_members[@]}"; do
	if [[ -n ${member} ]]; then
		gpasswd -d "${member}" lxd >/dev/null
	fi
done

if [[ -n $(getent group lxd | cut -d: -f4) ]]; then
	echo "The lxd group has unexpected non-root administrators." >&2
	exit 1
fi

if ! lxc storage show "${LXD_POOL}" >/dev/null 2>&1; then
	root_source=$(findmnt -n -o SOURCE /)
	root_device=$(readlink -f "${root_source}")
	root_vg=""
	while read -r candidate_vg candidate_lv; do
		if [[ $(readlink -f "${candidate_lv}") == "${root_device}" ]]; then
			root_vg=${candidate_vg}
			break
		fi
	done < <(lvs --noheadings -o vg_name,lv_path)
	if [[ -z ${root_vg} ]]; then
		echo "Could not resolve the volume group that owns the root filesystem." >&2
		exit 1
	fi
	lxd_device="/dev/${root_vg}/${LXD_DEVICE_LV}"
	if ! lvs "${root_vg}/${LXD_DEVICE_LV}" >/dev/null 2>&1; then
		free_bytes=$(vgs --noheadings --units b --nosuffix -o vg_free "${root_vg}" | tr -d ' ' | cut -d. -f1)
		required_bytes=$(((LXD_DEVICE_SIZE_GIB + 128) * 1024 * 1024 * 1024))
		if [[ ! ${free_bytes} =~ ^[0-9]+$ || ${free_bytes} -lt ${required_bytes} ]]; then
			echo "The root volume group cannot provide the dedicated LXD device plus a 128 GiB reserve." >&2
			exit 1
		fi
		lvcreate --yes --size "${LXD_DEVICE_SIZE_GIB}G" --name "${LXD_DEVICE_LV}" "${root_vg}"
	fi
	if [[ ! -b ${lxd_device} ]]; then
		echo "The dedicated LXD logical block device is unavailable." >&2
		exit 1
	fi

	lxd init --preseed <<EOF
config: {}
networks:
- name: ${LXD_NETWORK}
  type: bridge
  config:
    ipv4.address: ${LXD_SUBNET}
    ipv4.nat: "true"
    ipv6.address: none
storage_pools:
- name: ${LXD_POOL}
  driver: zfs
  config:
    source: ${lxd_device}
    source.wipe: "true"
    zfs.pool_name: ${LXD_ZPOOL}
profiles:
- name: default
  description: Unused default profile; Qorpera instances name an exact project profile.
  config: {}
  devices: {}
projects: []
cluster: null
EOF
fi

# Besides its Unix socket, the daemon may listen only on loopback, where each
# service presents its own client certificate. The node step sets that listener;
# this script neither sets nor removes it. Remote LXD administration is outside
# the architecture, so any other address refuses the host.
loopback_listener='^((127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4})?$'
if [[ ! $(lxc config get core.https_address) =~ ${loopback_listener} ]]; then
	echo "The LXD HTTPS listener is not loopback-only; refusing the host boundary." >&2
	exit 1
fi

if lxc project show "${LXD_PROJECT}" >/dev/null 2>&1; then
	project_networks=$(lxc project get "${LXD_PROJECT}" features.networks)
	if [[ ${project_networks} != false ]]; then
		# A previous interrupted bootstrap can leave this project with the
		# default network feature enabled. Recreating it is safe only while it
		# contains no workload state and only our expected bootstrap profiles.
		project_json=$(lxc query "/1.0/projects/${LXD_PROJECT}")
		if ! PROJECT_JSON="${project_json}" \
			LXD_PROJECT="${LXD_PROJECT}" \
			EXPECTED_PROFILES="default,${JOB_PROFILE},${LOGIN_PROFILE},${MANAGEMENT_PROFILE}" \
			python3 - <<'PY'
import json
import os
from urllib.parse import parse_qs, unquote, urlparse

payload = json.loads(os.environ["PROJECT_JSON"])
project = payload.get("metadata", payload)
expected_project = os.environ["LXD_PROJECT"]
expected_profiles = set(os.environ["EXPECTED_PROFILES"].split(","))
unexpected = []

for reference in project.get("used_by", []):
    parsed = urlparse(reference)
    parts = parsed.path.strip("/").split("/")
    query_project = parse_qs(parsed.query).get("project", [expected_project])[0]
    is_expected_profile = (
        len(parts) == 3
        and parts[0] == "1.0"
        and parts[1] == "profiles"
        and unquote(parts[2]) in expected_profiles
        and query_project == expected_project
    )
    if not is_expected_profile:
        unexpected.append(reference)

if unexpected:
    print("Refusing to recreate a non-empty LXD project. Unexpected resources:")
    for reference in unexpected:
        print(f"- {reference}")
    raise SystemExit(1)
PY
		then
			exit 1
		fi
		echo "Repairing the empty project left by an interrupted bootstrap."
		lxc project delete "${LXD_PROJECT}" --force
	fi
fi

if ! lxc project show "${LXD_PROJECT}" >/dev/null 2>&1; then
	lxc project create "${LXD_PROJECT}" \
		-c features.images=false \
		-c features.networks=false \
		-c features.profiles=true \
		-c features.storage.volumes=true \
		-c restricted=false
fi

if [[ $(lxc project get "${LXD_PROJECT}" features.networks) != false ]]; then
	echo "The runner project does not enforce inherited host networking." >&2
	exit 1
fi

create_profile() {
	local profile=$1
	if ! lxc profile show "${profile}" --project "${LXD_PROJECT}" >/dev/null 2>&1; then
		lxc profile create "${profile}" --project "${LXD_PROJECT}"
	fi
	if ! lxc profile device get "${profile}" eth0 type --project "${LXD_PROJECT}" >/dev/null 2>&1; then
		lxc profile device add "${profile}" eth0 nic \
			network="${LXD_NETWORK}" \
			name=eth0 \
			--project "${LXD_PROJECT}"
	fi
	lxc profile device set "${profile}" eth0 \
		security.mac_filtering=true \
		security.ipv4_filtering=true \
		security.ipv6_filtering=true \
		security.port_isolation=true \
		--project "${LXD_PROJECT}"
	# LXD 6.9 replaced security.secureboot with the explicit boot.mode key.
	lxc profile set "${profile}" boot.mode=uefi-secureboot \
		--project "${LXD_PROJECT}"
}

create_profile "${JOB_PROFILE}"
create_profile "${LOGIN_PROFILE}"
create_profile "${MANAGEMENT_PROFILE}"
lxc profile set "${MANAGEMENT_PROFILE}" security.devlxd=false --project "${LXD_PROJECT}"

if [[ $(stat -c %G /var/snap/lxd/common/lxd/unix.socket) != lxd ]]; then
	systemctl restart snap.lxd.daemon.service
	for _attempt in $(seq 1 60); do
		[[ -S /var/snap/lxd/common/lxd/unix.socket ]] && break
		sleep 1
	done
fi
if [[ $(stat -c %G /var/snap/lxd/common/lxd/unix.socket) != lxd ]]; then
	echo "The LXD socket is not owned by the dedicated administrative group." >&2
	exit 1
fi

if [[ -n $(ss -lnt | awk 'NR > 1 && $4 ~ /:8443$/ && $4 !~ /^(127\.0\.0\.1|\[::1\]):8443$/ { print $4 }') ]]; then
	echo "A public LXD HTTPS listener is present; refusing the host boundary." >&2
	exit 1
fi

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	snap list lxd
	echo
	echo "[project]"
	lxc project show "${LXD_PROJECT}"
	echo
	echo "[storage]"
	lxc storage show "${LXD_POOL}"
	echo
	echo "[network]"
	lxc network show "${LXD_NETWORK}"
	echo
	echo "[job-profile]"
	lxc profile show "${JOB_PROFILE}" --project "${LXD_PROJECT}"
	echo
	echo "[login-profile]"
	lxc profile show "${LOGIN_PROFILE}" --project "${LXD_PROJECT}"
	echo
	echo "[management-profile]"
	lxc profile show "${MANAGEMENT_PROFILE}" --project "${LXD_PROJECT}"
	echo
	echo "[instances]"
	lxc list --project "${LXD_PROJECT}" --format compact
	echo
	echo "[socket]"
	stat -c '%A %U:%G %n' /var/snap/lxd/common/lxd/unix.socket
	echo
	echo "[listeners]"
	ss -lnt
	echo
	echo "[bridge-netfilter]"
	grep '^br_netfilter ' /proc/modules
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${HOST_STATE_LOG}"
rm -f "${state_tmp}"

echo "LXD_HOST_READY"
echo "version=${EXPECTED_LXD_VERSION} revision=${EXPECTED_LXD_REVISION} channel=${LXD_CHANNEL} held=forever"
echo "project=${LXD_PROJECT} pool=${LXD_POOL} network=${LXD_NETWORK}"
echo "profiles=${JOB_PROFILE},${LOGIN_PROFILE},${MANAGEMENT_PROFILE} provider_user=${PROVIDER_USER}"
