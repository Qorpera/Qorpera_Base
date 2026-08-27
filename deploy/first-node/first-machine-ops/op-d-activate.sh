#!/usr/bin/env bash
set -euo pipefail

# Step 3 first machine — guarded direct-NAS activation. This script occupies
# the one temporary sudoers path already granted for the first-machine proof.
# Each phase is explicit and idempotent; `prepare` cannot move the registry,
# and `finalize` removes that temporary privilege only after verification.

EXPECTED_HOSTNAME="company41-node-01"
LOGICAL_COMPUTER_ID="6d9da3a0-f09b-4d63-b79b-8a3aad7919d9"
INSTANCE_NAME="qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9"
NAS_ROOT="/mnt/qorpera-companies"
NAS_SOURCE="192.168.0.91:/volume1/qorpera-companies"
NAS_DATASET="company41"
NAS_SHARED_GID="100"
IMAGE_FINGERPRINT="614dce363812ca0f32f39cb7eb7e6d2d4439a4c5b3fca633d2a2afa8f4a15ec2"
GUEST_MANIFEST_SHA256="a18cbb67634c6f6bd88235c25b858466bff4b786d39ae6f7fa265b4bf11e237e"
PROVENANCE_SHA256="06791a4535f1d58d62a7c9f26df3cf637bf46ac7d496201f6c64daa9a1442412"
INSTALLER_SHA256="9c18535dfd1f9a2376b693d526a9383d19dcc2cfda298df1ec76d6403a8cfeb7"
STAGING_ROOT="/home/company41-admin/step3-lxd"
PHASE_FILE="${STAGING_ROOT}/op-d-phase"
INSTALLER="${STAGING_ROOT}/install-lxd-company-provider-host.sh"
STAGED_PROVENANCE="${STAGING_ROOT}/lxd-company-image-provenance.json"
INSTALLED_PROVENANCE="/etc/qorpera/lxd-company-image-provenance.json"
PROVIDER_ENV="/etc/qorpera/lxd-company-provider.env"
PROVIDER_ARTIFACT="/opt/qorpera/company-provider/qorpera-lxd-provider.mjs"
PROVIDER_SERVICE="qorpera-lxd-company-provider.service"
PROVIDER_JOURNAL="/var/lib/qorpera-company-provider/computers/${LOGICAL_COMPUTER_ID}/journal.json"
TEMPORARY_SUDOERS="/etc/sudoers.d/qorpera-step3-first-machine"

fail() {
	echo "$1" >&2
	exit 1
}

require_regular_file() {
	local path=$1
	[[ -f ${path} && ! -L ${path} ]] || fail "Missing or unsafe file: ${path}"
}

require_host_and_nas() {
	[[ ${EUID} -eq 0 ]] || fail "Run through sudo."
	[[ $(hostname) == "${EXPECTED_HOSTNAME}" ]] || fail "Refusing unexpected host $(hostname)."
	[[ $(findmnt -n -o SOURCE --target "${NAS_ROOT}") == "${NAS_SOURCE}" ]] ||
		fail "The Company File mount source is not the approved Synology export."
	[[ $(findmnt -n -o FSTYPE --target "${NAS_ROOT}") =~ ^nfs4?$ ]] ||
		fail "The Company File root is not backed by NFS."
	[[ ,$(findmnt -n -o OPTIONS --target "${NAS_ROOT}"), == *,rw,* ]] ||
		fail "The Company File NFS mount is not read-write."
	local dataset_root live_root live_mode
	dataset_root=$(realpath -e "${NAS_ROOT}/${NAS_DATASET}")
	live_root=$(realpath -e "${NAS_ROOT}/${NAS_DATASET}/live")
	[[ ${dataset_root} == "${NAS_ROOT}/${NAS_DATASET}" && ${live_root} == "${dataset_root}/live" ]] ||
		fail "The Company File path escapes its approved NAS root."
	[[ $(stat -c '%g' "${dataset_root}") == "${NAS_SHARED_GID}" ]] ||
		fail "The Company File dataset does not use shared GID ${NAS_SHARED_GID}."
	[[ $(stat -c '%g' "${live_root}") == "${NAS_SHARED_GID}" ]] ||
		fail "The live Company File does not use shared GID ${NAS_SHARED_GID}."
	live_mode=$(stat -c '%a' "${live_root}")
	(( (8#${live_mode} & 0070) == 0070 )) || fail "The live Company File is not group-readable and writable."
	lxc image info "${IMAGE_FINGERPRINT}" --project qorpera-runners >/dev/null ||
		fail "The accepted image is missing from the Company Computer project."
}

upsert_env() {
	local key=$1 value=$2 target=$3
	if grep -q "^${key}=" "${target}"; then
		sed -i -E "s|^${key}=.*$|${key}=${value}|" "${target}"
	else
		printf '%s=%s\n' "${key}" "${value}" >>"${target}"
	fi
}

require_installed_contract() {
	require_regular_file "${PROVIDER_ENV}"
	require_regular_file "${PROVIDER_ARTIFACT}"
	require_regular_file "${INSTALLED_PROVENANCE}"
	[[ $(sha256sum "${INSTALLED_PROVENANCE}" | awk '{ print $1 }') == "${PROVENANCE_SHA256}" ]] ||
		fail "Installed Company Computer provenance does not match the accepted image."
	grep -qx "QORPERA_LXD_IMAGE_FINGERPRINT=${IMAGE_FINGERPRINT}" "${PROVIDER_ENV}" ||
		fail "Provider environment does not pin the accepted image."
	grep -qx "QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=${GUEST_MANIFEST_SHA256}" "${PROVIDER_ENV}" ||
		fail "Provider environment does not pin the accepted guest contract."
	grep -qx "QORPERA_LXD_NAS_DATASET_ROOT=${NAS_ROOT}" "${PROVIDER_ENV}" ||
		fail "Provider environment does not pin the approved NAS root."
	grep -qx "QORPERA_LXD_NAS_SHARED_GID=${NAS_SHARED_GID}" "${PROVIDER_ENV}" ||
		fail "Provider environment does not pin the shared NAS group."
}

prepare() {
	require_regular_file "${INSTALLER}"
	[[ $(sha256sum "${INSTALLER}" | awk '{ print $1 }') == "${INSTALLER_SHA256}" ]] ||
		fail "Staged provider installer does not match the reviewed source."
	require_regular_file "${STAGED_PROVENANCE}"
	[[ $(sha256sum "${STAGED_PROVENANCE}" | awk '{ print $1 }') == "${PROVENANCE_SHA256}" ]] ||
		fail "Staged provenance does not match the accepted clean-boot image."
	[[ -f ${PROVIDER_ENV} && ! -L ${PROVIDER_ENV} ]] || fail "The existing provider environment is missing."
	for key in QORPERA_RUNNER_PROVIDER_TOKEN QORPERA_SUPABASE_URL QORPERA_SUPABASE_SERVICE_KEY QORPERA_SUPABASE_PUBLISHABLE_KEY; do
		grep -Eq "^${key}=[^[:space:]]+$" "${PROVIDER_ENV}" || fail "Provider secret ${key} is unavailable."
	done
	! grep -q 'REPLACE_WITH\|REPLACE_AFTER\|REPLACE\.supabase' "${PROVIDER_ENV}" ||
		fail "The provider environment still contains placeholder values."

	systemctl stop "${PROVIDER_SERVICE}"
	bash "${INSTALLER}"
	install -o root -g qorpera-provider -m 0640 "${STAGED_PROVENANCE}" "${INSTALLED_PROVENANCE}"

	local env_tmp
	env_tmp=$(mktemp /etc/qorpera/lxd-company-provider.env.direct-nas.XXXXXX)
	cp "${PROVIDER_ENV}" "${env_tmp}"
	upsert_env QORPERA_LXD_IMAGE_FINGERPRINT "${IMAGE_FINGERPRINT}" "${env_tmp}"
	upsert_env QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256 "${GUEST_MANIFEST_SHA256}" "${env_tmp}"
	upsert_env QORPERA_LXD_NAS_DATASET_ROOT "${NAS_ROOT}" "${env_tmp}"
	upsert_env QORPERA_LXD_NAS_SHARED_GID "${NAS_SHARED_GID}" "${env_tmp}"
	upsert_env QORPERA_LXD_DATASET_SNAPSHOT_INTERVAL_SECONDS 21600 "${env_tmp}"
	# A snapshot hook is installed separately only after its native NAS action
	# is proven. Never carry a stale or guessed command into this cutover.
	sed -i '/^QORPERA_LXD_DATASET_SNAPSHOT_COMMAND=/d' "${env_tmp}"
	install -o root -g root -m 0600 "${env_tmp}" "${PROVIDER_ENV}"
	rm -f -- "${env_tmp}"
	systemctl daemon-reload
	require_installed_contract
	echo "DIRECT_NAS_PROVIDER_PREPARED"
}

run_operator() {
	local operation=$1
	systemctl stop "${PROVIDER_SERVICE}"
	if ! systemd-run --wait --pipe --collect \
		--property=User=qorpera-provider --property=Group=qorpera-provider \
		--property=SupplementaryGroups=lxd \
		--property=EnvironmentFile="${PROVIDER_ENV}" \
		/usr/bin/node --jitless "${PROVIDER_ARTIFACT}" "${operation}" "${LOGICAL_COMPUTER_ID}" "${NAS_DATASET}"; then
		echo "The provider remains stopped. After correcting the cause, select op-d-phases/recover and rerun this argument-free sudo command." >&2
		exit 1
	fi
	systemctl enable --now "${PROVIDER_SERVICE}"
	echo "DIRECT_NAS_${operation^^}_COMPLETE"
}

verify() {
	require_installed_contract
	systemctl is-active --quiet "${PROVIDER_SERVICE}" || fail "The Company Computer provider is not active."
	systemctl is-enabled --quiet "${PROVIDER_SERVICE}" || fail "The Company Computer provider is not enabled."
	require_regular_file "${PROVIDER_JOURNAL}"
	jq -e \
		--arg logical "${LOGICAL_COMPUTER_ID}" \
		--arg dataset "${NAS_DATASET}" \
		--arg fingerprint "${IMAGE_FINGERPRINT}" \
		--arg source "${NAS_ROOT}/${NAS_DATASET}" \
		'.schema == "qorpera.lxd-company-computer-journal/v1" and
		 .logicalComputerId == $logical and .nasDataset == $dataset and
		 .lxd.imageFingerprint == $fingerprint and .lxd.datasetSource == $source and
		 .activeAssignment == null' "${PROVIDER_JOURNAL}" >/dev/null ||
		fail "The durable Company Computer journal does not match the direct-NAS activation."
	[[ $(lxc config get "${INSTANCE_NAME}" volatile.base_image --project qorpera-runners) == "${IMAGE_FINGERPRINT}" ]] ||
		fail "The Company Computer root is not the accepted image."
	[[ $(lxc config device get "${INSTANCE_NAME}" company-dataset source --project qorpera-runners) == "${NAS_ROOT}/${NAS_DATASET}" ]] ||
		fail "The Company Computer does not mount the approved NAS dataset."
	echo "DIRECT_NAS_ACTIVATION_VERIFIED"
}

finalize() {
	verify
	if [[ -e ${TEMPORARY_SUDOERS} ]]; then
		[[ -f ${TEMPORARY_SUDOERS} && ! -L ${TEMPORARY_SUDOERS} ]] || fail "Temporary sudoers path is unsafe."
		rm -- "${TEMPORARY_SUDOERS}"
		echo "Removed the temporary Step 3 sudo grant."
	fi
	echo "DIRECT_NAS_ACTIVATION_FINALIZED"
}

[[ $# -eq 0 ]] || fail "This guarded sudo path accepts no arguments; select a reviewed op-d-phase file first."
require_host_and_nas
require_regular_file "${PHASE_FILE}"
[[ $(stat -c '%U:%G:%a' "${PHASE_FILE}") == "company41-admin:company41-admin:644" ]] ||
	fail "The activation phase marker has unsafe ownership or mode."
[[ $(stat -c '%s' "${PHASE_FILE}") -le 16 ]] || fail "The activation phase marker is too large."
phase=$(<"${PHASE_FILE}")
case ${phase} in
	prepare) prepare ;;
	relocate)
		require_installed_contract
		run_operator relocate-dataset
		;;
	recover)
		require_installed_contract
		run_operator recover
		;;
	verify) verify ;;
	finalize) finalize ;;
	*) fail "The activation phase marker is invalid." ;;
esac
