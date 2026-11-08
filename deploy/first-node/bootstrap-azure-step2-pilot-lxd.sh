#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="qorpera-step2-compat-01"
EXPECTED_OS_VERSION="26.04"
EXPECTED_DATA_DISK_LINK="/dev/disk/azure/data/by-lun/0"
EXPECTED_DATA_DISK_BYTES=274877906944
EXPECTED_LXD_VERSION="6.9-ab8fad2"
EXPECTED_LXD_REVISION="40424"
EXPECTED_NODE_PACKAGE_VERSION="22.22.1+dfsg+~cs22.19.15-1ubuntu1"
EXPECTED_NODE_VERSION="v22.22.1"
EXPECTED_ZFSUTILS_PACKAGE_VERSION="2.4.1-1ubuntu5"
LXD_CHANNEL="6/stable"
LXD_PROJECT="qorpera-runners"
LXD_POOL="qorpera-vm"
LXD_ZPOOL="qorpera-azure-step2"
LXD_NETWORK="qorpera0"
LXD_SUBNET="10.41.0.1/24"
JOB_PROFILE="qorpera-job-v1"
LOGIN_PROFILE="qorpera-login-v1"
MANAGEMENT_PROFILE="qorpera-management-v1"
PROVIDER_USER="qorpera-provider"
PILOT_ROOT="/var/lib/qorpera-step2-phase-a"
PILOT_BOOTSTRAP="${PILOT_ROOT}/bootstrap-azure-step2-pilot-lxd.sh"
HOST_STATE_LOG="/var/log/qorpera-azure-step2-lxd-host-state.txt"
BOOTSTRAP_LOG="/var/log/qorpera-azure-step2-lxd-bootstrap.log"

usage() {
	echo "Usage: $0 --preflight-only|--format-empty-pilot-disk|--stage-self EXPECTED_SHA256" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
	usage
	exit 64
fi

case $1 in
	--preflight-only)
		apply=false
		stage_self=false
		;;
	--format-empty-pilot-disk)
		apply=true
		stage_self=false
		;;
	--stage-self | stage-self)
		if [[ $# -ne 2 || ! $2 =~ ^[0-9a-f]{64}$ ]]; then
			usage
			exit 64
		fi
		apply=false
		stage_self=true
		expected_stage_sha256=$2
		;;
	*)
		usage
		exit 64
		;;
esac

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through Azure Run Command as root." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to configure an unexpected host: $(hostname)." >&2
	exit 1
fi
if ! grep -q "^VERSION_ID=\"${EXPECTED_OS_VERSION}\"$" /etc/os-release; then
	echo "The Azure pilot host is not running the pinned Ubuntu release." >&2
	exit 1
fi
if [[ ${stage_self} == true ]]; then
	install -d -o root -g root -m 0700 "${PILOT_ROOT}"
	stage_tmp=$(mktemp "${PILOT_ROOT}/.bootstrap-stage.XXXXXX")
	# Azure Run Command inserts positional-argument exports immediately after the
	# shebang. Remove only that leading handler prelude before checking the exact
	# submitted source digest and admitting the bootstrap.
	awk '
		NR == 1 { print; next }
		!source_started && /^export arg[0-9]+=/ { next }
		!source_started && /^set -- / { next }
		{ source_started=1; print }
	' "$0" >"${stage_tmp}"
	if [[ $(sha256sum "${stage_tmp}" | awk '{ print $1 }') != "${expected_stage_sha256}" ]]; then
		unlink "${stage_tmp}"
		echo "Azure Run Command changed the submitted bootstrap bytes." >&2
		exit 1
	fi
	install -o root -g root -m 0600 "${stage_tmp}" "${PILOT_BOOTSTRAP}"
	unlink "${stage_tmp}"
	echo "AZURE_STEP2_BOOTSTRAP_STAGED"
	sha256sum "${PILOT_BOOTSTRAP}"
	exit 0
fi
if [[ ! -c /dev/kvm ]]; then
	echo "/dev/kvm is unavailable; full-VM execution cannot be enforced." >&2
	exit 1
fi
if [[ ! -L ${EXPECTED_DATA_DISK_LINK} ]]; then
	echo "The exact Azure LUN 0 data-disk link is unavailable." >&2
	exit 1
fi

data_disk=$(readlink -f -- "${EXPECTED_DATA_DISK_LINK}")
if [[ ! -b ${data_disk} ]]; then
	echo "The Azure LUN 0 link does not resolve to a block device." >&2
	exit 1
fi
read -r data_disk_type data_disk_bytes < <(lsblk --nodeps --bytes --noheadings --output TYPE,SIZE "${data_disk}")
if [[ ${data_disk_type} != disk || ${data_disk_bytes} != "${EXPECTED_DATA_DISK_BYTES}" ]]; then
	echo "The Azure LUN 0 device does not match the exact empty 256-GiB pilot disk." >&2
	exit 1
fi
if [[ $(lsblk --noheadings --raw --output NAME "${data_disk}" | wc -l) -ne 1 ]]; then
	echo "The Azure pilot data disk already has child block devices." >&2
	exit 1
fi
if findmnt --raw --noheadings --source "${data_disk}" | grep -q .; then
	echo "The Azure pilot data disk is unexpectedly mounted." >&2
	exit 1
fi
if [[ -n $(lsblk --nodeps --noheadings --output FSTYPE "${data_disk}" | tr -d '[:space:]') ]]; then
	echo "The Azure pilot data disk already has a filesystem type." >&2
	exit 1
fi
if wipefs --no-act --noheadings "${data_disk}" | grep -q .; then
	echo "The Azure pilot data disk contains an existing signature." >&2
	exit 1
fi

root_source=$(findmnt --noheadings --output SOURCE /)
root_parent=$(lsblk --noheadings --raw --output PKNAME "${root_source}" 2>/dev/null | head -n 1 || true)
if [[ $(readlink -f -- "${root_source}") == "${data_disk}" ]] ||
	[[ -n ${root_parent} && $(readlink -f -- "/dev/${root_parent}") == "${data_disk}" ]]; then
	echo "The proposed Azure pilot data disk owns the root filesystem." >&2
	exit 1
fi

echo "AZURE_STEP2_LXD_DISK_PREFLIGHT_VERIFIED"
echo "device_link=${EXPECTED_DATA_DISK_LINK}"
echo "device=${data_disk}"
echo "bytes=${data_disk_bytes}"
echo "state=empty-unformatted-unmounted"

if [[ ${apply} != true ]]; then
	exit 0
fi

# The only destructive operation in this provisioner is LXD's explicit wipe of
# the exact stable LUN 0 link validated above. A lost acknowledgement must fail
# on replay because the device will no longer be empty.
install -o root -g root -m 0644 /dev/null "${BOOTSTRAP_LOG}"
exec > >(tee "${BOOTSTRAP_LOG}") 2>&1
echo "Starting Azure Step 2 LXD bootstrap on $(date --iso-8601=seconds)."

export DEBIAN_FRONTEND=noninteractive
apt-get update -o Acquire::Retries=3
apt-get install --yes --no-install-recommends \
	"nodejs=${EXPECTED_NODE_PACKAGE_VERSION}" \
	"zfsutils-linux=${EXPECTED_ZFSUTILS_PACKAGE_VERSION}"
if [[ $(dpkg-query --show --showformat='${Version}' nodejs) != "${EXPECTED_NODE_PACKAGE_VERSION}" ]]; then
	echo "The installed nodejs package does not match the Azure pilot pin." >&2
	exit 1
fi
if [[ $(node --version) != "${EXPECTED_NODE_VERSION}" ]]; then
	echo "The installed Node runtime does not match the Azure pilot pin." >&2
	exit 1
fi
if [[ $(dpkg-query --show --showformat='${Version}' zfsutils-linux) != "${EXPECTED_ZFSUTILS_PACKAGE_VERSION}" ]]; then
	echo "The installed zfsutils-linux package does not match the Azure pilot pin." >&2
	exit 1
fi
apt-mark hold nodejs zfsutils-linux >/dev/null

modules_tmp=$(mktemp)
printf '%s\n' br_netfilter >"${modules_tmp}"
install -o root -g root -m 0644 "${modules_tmp}" /etc/modules-load.d/qorpera-lxd.conf
rm -f -- "${modules_tmp}"
/usr/sbin/modprobe br_netfilter
if ! grep -q '^br_netfilter ' /proc/modules; then
	echo "br_netfilter is unavailable; guest anti-spoof filtering cannot be enforced." >&2
	exit 1
fi

if snap list lxd >/dev/null 2>&1; then
	installed_version=$(snap list lxd | awk 'NR == 2 { print $2 }')
	installed_revision=$(snap list lxd | awk 'NR == 2 { print $3 }')
	if [[ ${installed_version} != "${EXPECTED_LXD_VERSION}" || ${installed_revision} != "${EXPECTED_LXD_REVISION}" ]]; then
		echo "Installed LXD ${installed_version} revision ${installed_revision} does not match the pilot pin." >&2
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
	echo "LXD did not make its local API available." >&2
	exit 1
fi

if ! getent passwd "${PROVIDER_USER}" >/dev/null; then
	useradd --system --create-home --home-dir /var/lib/qorpera-provider --shell /usr/sbin/nologin "${PROVIDER_USER}"
fi
install -d -o root -g root -m 0755 /etc/qorpera
install -d -o "${PROVIDER_USER}" -g "${PROVIDER_USER}" -m 0700 \
	/var/lib/qorpera-provider \
	/var/lib/qorpera-provider/runs

# The provider reaches LXD with its own client certificate on the loopback
# listener, so the root-equivalent lxd group keeps no non-root member.
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

if lxc storage show "${LXD_POOL}" >/dev/null 2>&1; then
	echo "Refusing to reuse an existing Azure pilot LXD pool." >&2
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
    source: ${EXPECTED_DATA_DISK_LINK}
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

# Only a loopback HTTPS listener, set by the node step, may exist; this script
# neither sets nor removes it.
loopback_listener='^((127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4})?$'

if lxc project show "${LXD_PROJECT}" >/dev/null 2>&1; then
	echo "Refusing to reuse an existing Azure pilot LXD project." >&2
	exit 1
fi
lxc project create "${LXD_PROJECT}" \
	-c features.images=false \
	-c features.networks=false \
	-c features.profiles=true \
	-c features.storage.volumes=true \
	-c restricted=false

create_profile() {
	local profile=$1
	lxc profile create "${profile}" --project "${LXD_PROJECT}"
	lxc profile device add "${profile}" eth0 nic \
		network="${LXD_NETWORK}" \
		name=eth0 \
		--project "${LXD_PROJECT}"
	lxc profile device set "${profile}" eth0 \
		security.mac_filtering=true \
		security.ipv4_filtering=true \
		security.ipv6_filtering=true \
		security.port_isolation=true \
		--project "${LXD_PROJECT}"
	lxc profile set "${profile}" boot.mode=uefi-secureboot --project "${LXD_PROJECT}"
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
if [[ ! $(lxc config get core.https_address) =~ ${loopback_listener} ]] ||
	[[ -n $(ss -lnt | awk 'NR > 1 && $4 ~ /:8443$/ && $4 !~ /^(127\.0\.0\.1|\[::1\]):8443$/ { print $4 }') ]]; then
	echo "A remote LXD listener is present; refusing the Azure host boundary." >&2
	exit 1
fi

state_tmp=$(mktemp)
{
	echo "schema=qorpera.azure-step2-lxd-host-state/v1"
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "data_disk_link=${EXPECTED_DATA_DISK_LINK}"
	echo "data_disk=${data_disk}"
	echo "data_disk_bytes=${data_disk_bytes}"
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
	echo "[socket]"
	stat -c '%A %U:%G %n' /var/snap/lxd/common/lxd/unix.socket
	echo
	echo "[node]"
	dpkg-query --show --showformat='package=${Package} version=${Version}\n' nodejs
	node --version
	dpkg-query --show --showformat='package=${Package} version=${Version}\n' zfsutils-linux
	for held_package in nodejs zfsutils-linux; do
		apt-mark showhold | grep -Fx "${held_package}"
	done
	echo
	echo "[listeners]"
	ss -lnt
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${HOST_STATE_LOG}"
rm -f -- "${state_tmp}"

echo "AZURE_STEP2_LXD_HOST_READY"
echo "version=${EXPECTED_LXD_VERSION} revision=${EXPECTED_LXD_REVISION} channel=${LXD_CHANNEL} held=forever"
echo "node=${EXPECTED_NODE_VERSION} package=${EXPECTED_NODE_PACKAGE_VERSION} held=forever"
echo "zfsutils=${EXPECTED_ZFSUTILS_PACKAGE_VERSION} held=forever"
echo "project=${LXD_PROJECT} pool=${LXD_POOL} network=${LXD_NETWORK}"
echo "profiles=${JOB_PROFILE},${LOGIN_PROFILE},${MANAGEMENT_PROFILE} provider_user=${PROVIDER_USER}"
