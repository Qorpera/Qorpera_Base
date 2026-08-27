#!/usr/bin/env bash
set -euo pipefail

# Step 3 operator round E — refresh the disposable VM root to a newly signed
# image without changing the live NAS dataset or Compute Identity volume.
# Select refresh-image, recover, or verify through the unprivileged phase
# marker, then run this script through interactive sudo with no arguments.

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_PROVIDER_ARTIFACT_SHA256="0c3e177ab79e6728a0da94218aa70344d30b55007f54de920209352702e612b9"
LOGICAL_COMPUTER_ID="6d9da3a0-f09b-4d63-b79b-8a3aad7919d9"
INSTANCE_NAME="qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9"
LXD_PROJECT="qorpera-runners"
NAS_ROOT="/mnt/qorpera-companies"
NAS_SOURCE="192.168.0.91:/volume1/qorpera-companies"
NAS_DATASET="company41"
NAS_SHARED_GID="100"
STAGING_ROOT="/home/company41-admin/step3-lxd"
PHASE_FILE="${STAGING_ROOT}/op-e-phase"
STAGED_PROVIDER="${STAGING_ROOT}/qorpera-lxd-provider.mjs"
STAGED_PROVENANCE="${STAGING_ROOT}/lxd-company-image-provenance.json"
PROVIDER_ENV="/etc/qorpera/lxd-company-provider.env"
PROVIDER_ARTIFACT="/opt/qorpera/company-provider/qorpera-lxd-provider.mjs"
INSTALLED_PROVENANCE="/etc/qorpera/lxd-company-image-provenance.json"
PROVIDER_SERVICE="qorpera-lxd-company-provider.service"
PROVIDER_JOURNAL="/var/lib/qorpera-company-provider/computers/${LOGICAL_COMPUTER_ID}/journal.json"

fail() {
	echo "$1" >&2
	exit 1
}

require_regular_file() {
	local path=$1
	[[ -f ${path} && ! -L ${path} ]] || fail "Missing or unsafe file: ${path}"
}

upsert_env() {
	local key=$1 value=$2 target=$3
	if grep -q "^${key}=" "${target}"; then
		sed -i -E "s|^${key}=.*$|${key}=${value}|" "${target}"
	else
		printf '%s=%s\n' "${key}" "${value}" >>"${target}"
	fi
}

require_host_and_nas() {
	[[ ${EUID} -eq 0 ]] || fail "Run through sudo."
	[[ $# -eq 0 ]] || fail "This guarded image refresh accepts no arguments."
	[[ $(hostname) == "${EXPECTED_HOSTNAME}" ]] || fail "Refusing unexpected host $(hostname)."
	[[ $(findmnt -n -o SOURCE --target "${NAS_ROOT}") == "${NAS_SOURCE}" ]] ||
		fail "The Company File mount source is not the approved Synology export."
	[[ $(findmnt -n -o FSTYPE --target "${NAS_ROOT}") =~ ^nfs4?$ ]] ||
		fail "The Company File root is not backed by NFS."
	[[ ,$(findmnt -n -o OPTIONS --target "${NAS_ROOT}"), == *,rw,* ]] ||
		fail "The Company File NFS mount is not read-write."
	[[ $(realpath -e "${NAS_ROOT}/${NAS_DATASET}") == "${NAS_ROOT}/${NAS_DATASET}" ]] ||
		fail "The Company File dataset escapes its approved NAS root."
	[[ $(stat -c '%g' "${NAS_ROOT}/${NAS_DATASET}") == "${NAS_SHARED_GID}" ]] ||
		fail "The Company File dataset does not use shared GID ${NAS_SHARED_GID}."
}

read_target_contract() {
	require_regular_file "${STAGED_PROVIDER}"
	require_regular_file "${STAGED_PROVENANCE}"
	require_regular_file "${PROVIDER_ENV}"
	[[ $(sha256sum "${STAGED_PROVIDER}" | awk '{ print $1 }') == "${EXPECTED_PROVIDER_ARTIFACT_SHA256}" ]] ||
		fail "The staged provider artifact does not match the reviewed image-refresh source."
	/usr/bin/node --check "${STAGED_PROVIDER}"
	TARGET_FINGERPRINT=$(jq -r '.statement.image.fingerprint // empty' "${STAGED_PROVENANCE}")
	TARGET_GUEST_MANIFEST=$(jq -r '.statement.image.guestPackageManifestSha256 // empty' "${STAGED_PROVENANCE}")
	[[ ${TARGET_FINGERPRINT} =~ ^[0-9a-f]{64}$ && ${TARGET_GUEST_MANIFEST} =~ ^[0-9a-f]{64}$ ]] ||
		fail "The staged provenance envelope has no valid image contract."
	lxc image info "${TARGET_FINGERPRINT}" --project "${LXD_PROJECT}" >/dev/null ||
		fail "The signed target image is missing from the Company Computer project."
	image_manifest=$(
		lxc query "/1.0/images/${TARGET_FINGERPRINT}?project=${LXD_PROJECT}" |
			jq -r '.properties["user.qorpera.guest_package_manifest_sha256"] // empty'
	)
	[[ ${image_manifest} == "${TARGET_GUEST_MANIFEST}" ]] ||
		fail "The signed target image does not match its guest-package contract."
}

read_current_journal() {
	require_regular_file "${PROVIDER_JOURNAL}"
	jq -e \
		--arg logical "${LOGICAL_COMPUTER_ID}" \
		--arg dataset "${NAS_DATASET}" \
		--arg source "${NAS_ROOT}/${NAS_DATASET}" \
		'.schema == "qorpera.lxd-company-computer-journal/v1" and
		 .logicalComputerId == $logical and .nasDataset == $dataset and
		 .lxd.project == "qorpera-runners" and .lxd.datasetSource == $source and
		 (.lxd.imageFingerprint | test("^[0-9a-f]{64}$")) and
		 (.lxd.identityVolume | type == "string" and length > 0)' \
		"${PROVIDER_JOURNAL}" >/dev/null || fail "The durable Company Computer journal is invalid."
	CURRENT_FINGERPRINT=$(jq -r '.lxd.imageFingerprint' "${PROVIDER_JOURNAL}")
	IDENTITY_VOLUME=$(jq -r '.lxd.identityVolume' "${PROVIDER_JOURNAL}")
}

require_current_instance() {
	lxc info "${INSTANCE_NAME}" --project "${LXD_PROJECT}" >/dev/null ||
		fail "The current Company Computer instance is missing."
	[[ $(lxc config get "${INSTANCE_NAME}" volatile.base_image --project "${LXD_PROJECT}") == "${CURRENT_FINGERPRINT}" ]] ||
		fail "The current VM root does not match its durable journal."
	[[ $(lxc config device get "${INSTANCE_NAME}" company-dataset source --project "${LXD_PROJECT}") == "${NAS_ROOT}/${NAS_DATASET}" ]] ||
		fail "The current VM is not attached to the approved NAS dataset."
	[[ $(lxc config device get "${INSTANCE_NAME}" compute-identity source --project "${LXD_PROJECT}") == "${IDENTITY_VOLUME}" ]] ||
		fail "The current VM is not attached to its durable Compute Identity."
}

prepare_runtime() {
	RUNTIME_ROOT=$(mktemp -d /run/qorpera-image-refresh.XXXXXX)
	chown root:qorpera-provider "${RUNTIME_ROOT}"
	chmod 0750 "${RUNTIME_ROOT}"
	RUNTIME_PROVIDER="${RUNTIME_ROOT}/qorpera-lxd-provider.mjs"
	RUNTIME_PROVENANCE="${RUNTIME_ROOT}/lxd-company-image-provenance.json"
	RUNTIME_ENV="${RUNTIME_ROOT}/lxd-company-provider.env"
	install -o root -g qorpera-provider -m 0550 "${STAGED_PROVIDER}" "${RUNTIME_PROVIDER}"
	install -o root -g qorpera-provider -m 0440 "${STAGED_PROVENANCE}" "${RUNTIME_PROVENANCE}"
	cp "${PROVIDER_ENV}" "${RUNTIME_ENV}"
	upsert_env QORPERA_LXD_IMAGE_FINGERPRINT "${TARGET_FINGERPRINT}" "${RUNTIME_ENV}"
	upsert_env QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256 "${TARGET_GUEST_MANIFEST}" "${RUNTIME_ENV}"
	upsert_env QORPERA_LXD_IMAGE_PROVENANCE "${RUNTIME_PROVENANCE}" "${RUNTIME_ENV}"
	chown root:qorpera-provider "${RUNTIME_ENV}"
	chmod 0640 "${RUNTIME_ENV}"
}

run_operator() {
	local operation=$1
	systemctl stop "${PROVIDER_SERVICE}"
	if ! systemd-run --wait --pipe --collect \
		--property=User=qorpera-provider --property=Group=qorpera-provider \
		--property=SupplementaryGroups=lxd \
		--property=EnvironmentFile="${RUNTIME_ENV}" \
		/usr/bin/node --jitless "${RUNTIME_PROVIDER}" "${operation}" "${LOGICAL_COMPUTER_ID}"; then
		echo "The provider remains stopped. Select the recover phase only if the control-plane lifecycle reached recovering." >&2
		exit 1
	fi
	install -o root -g root -m 0555 "${STAGED_PROVIDER}" "${PROVIDER_ARTIFACT}"
	install -o root -g qorpera-provider -m 0640 "${STAGED_PROVENANCE}" "${INSTALLED_PROVENANCE}"
	upsert_env QORPERA_LXD_IMAGE_PROVENANCE "${INSTALLED_PROVENANCE}" "${RUNTIME_ENV}"
	install -o root -g root -m 0600 "${RUNTIME_ENV}" "${PROVIDER_ENV}"
	systemctl daemon-reload
	systemctl enable --now "${PROVIDER_SERVICE}"
}

verify() {
	require_regular_file "${PROVIDER_ARTIFACT}"
	require_regular_file "${INSTALLED_PROVENANCE}"
	[[ $(sha256sum "${PROVIDER_ARTIFACT}" | awk '{ print $1 }') == "${EXPECTED_PROVIDER_ARTIFACT_SHA256}" ]] ||
		fail "The installed provider is not the reviewed image-refresh artifact."
	cmp -s "${STAGED_PROVENANCE}" "${INSTALLED_PROVENANCE}" ||
		fail "The installed provenance does not match the signed target envelope."
	grep -qx "QORPERA_LXD_IMAGE_FINGERPRINT=${TARGET_FINGERPRINT}" "${PROVIDER_ENV}" ||
		fail "The provider environment does not pin the signed target image."
	grep -qx "QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=${TARGET_GUEST_MANIFEST}" "${PROVIDER_ENV}" ||
		fail "The provider environment does not pin the signed guest contract."
	grep -qx "QORPERA_LXD_IMAGE_PROVENANCE=${INSTALLED_PROVENANCE}" "${PROVIDER_ENV}" ||
		fail "The provider environment does not use the installed provenance."
	systemctl is-active --quiet "${PROVIDER_SERVICE}" || fail "The Company Computer provider is not active."
	systemctl is-enabled --quiet "${PROVIDER_SERVICE}" || fail "The Company Computer provider is not enabled."
	read_current_journal
	[[ ${CURRENT_FINGERPRINT} == "${TARGET_FINGERPRINT}" ]] || fail "The durable journal still pins the previous image."
	require_current_instance
	echo "COMPANY_COMPUTER_IMAGE_REFRESH_VERIFIED"
}

[[ $# -eq 0 ]] || fail "This guarded image refresh accepts no arguments."
require_host_and_nas
read_target_contract
read_current_journal
require_regular_file "${PHASE_FILE}"
[[ $(stat -c '%U:%G:%a' "${PHASE_FILE}") == "company41-admin:company41-admin:644" ]] ||
	fail "The image-refresh phase marker has unsafe ownership or mode."
[[ $(stat -c '%s' "${PHASE_FILE}") -le 16 ]] || fail "The image-refresh phase marker is too large."
phase=$(<"${PHASE_FILE}")

RUNTIME_ROOT=""
cleanup() {
	if [[ -n ${RUNTIME_ROOT} && ${RUNTIME_ROOT} == /run/qorpera-image-refresh.* && -d ${RUNTIME_ROOT} ]]; then
		rm -rf -- "${RUNTIME_ROOT}"
	fi
}
trap cleanup EXIT HUP INT TERM

case ${phase} in
	refresh-image)
		require_current_instance
		[[ $(lxc list "${INSTANCE_NAME}" --project "${LXD_PROJECT}" --format csv -c s) == STOPPED ]] ||
			fail "The current Company Computer must be stopped before its image is refreshed."
		prepare_runtime
		run_operator refresh-image
		verify
		;;
	recover)
		prepare_runtime
		run_operator recover
		verify
		;;
	verify) verify ;;
	*) fail "The image-refresh phase marker is invalid." ;;
esac
