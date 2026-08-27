#!/usr/bin/env bash
set -euo pipefail

# Installs the Company Computer provider service beside the ephemeral LXD
# provider: same artifact contract, its own install root, environment, state
# root, and unit, so the Step 2 acceptance lane's deployed binary is never
# touched. Fail-closed on staged checksums exactly like the ephemeral
# installer.

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_ARTIFACT_SHA256="0c3e177ab79e6728a0da94218aa70344d30b55007f54de920209352702e612b9"
EXPECTED_UNIT_SHA256="5520cac3c053b8a9043cb150b92ff09c0be23c6767161062e117c1be1521f92b"
EXPECTED_ENV_EXAMPLE_SHA256="cb443eb5003e2dacc106bc6052f6ea1f4ee65229e371ec2cc3d5e0768dfd330c"
STAGING_ROOT="/home/company41-admin/step3-lxd"
ARTIFACT_SOURCE="${STAGING_ROOT}/qorpera-lxd-provider.mjs"
UNIT_SOURCE="${STAGING_ROOT}/qorpera-lxd-company-provider.service"
ENV_EXAMPLE_SOURCE="${STAGING_ROOT}/lxd-company-provider.env.example"
INSTALL_ROOT="/opt/qorpera/company-provider"
SERVICE_NAME="qorpera-lxd-company-provider.service"
INSTALL_LOG="/var/log/qorpera-lxd-company-provider-install.log"
PROVIDER_USER="qorpera-provider"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi

install -o root -g root -m 0644 /dev/null "${INSTALL_LOG}"
exec > >(tee "${INSTALL_LOG}") 2>&1
echo "Starting fail-closed Company Computer provider installation on $(date --iso-8601=seconds)."

if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to install on unexpected host $(hostname)." >&2
	exit 1
fi
if ! id "${PROVIDER_USER}" >/dev/null 2>&1; then
	echo "The ${PROVIDER_USER} account is missing; install the ephemeral provider first." >&2
	exit 1
fi

verify_sha256() {
	local file=$1
	local expected=$2
	local actual
	if [[ ! -f ${file} || -L ${file} ]]; then
		echo "Missing or unsafe staged file: ${file}" >&2
		exit 1
	fi
	actual=$(sha256sum "${file}" | awk '{ print $1 }')
	if [[ ${actual} != "${expected}" ]]; then
		echo "Checksum mismatch for ${file}: ${actual}" >&2
		exit 1
	fi
}

verify_sha256 "${ARTIFACT_SOURCE}" "${EXPECTED_ARTIFACT_SHA256}"
verify_sha256 "${UNIT_SOURCE}" "${EXPECTED_UNIT_SHA256}"
verify_sha256 "${ENV_EXAMPLE_SOURCE}" "${EXPECTED_ENV_EXAMPLE_SHA256}"

install -d -o root -g root -m 0755 /opt/qorpera "${INSTALL_ROOT}"
install -o root -g root -m 0555 "${ARTIFACT_SOURCE}" "${INSTALL_ROOT}/qorpera-lxd-provider.mjs"
install -o root -g root -m 0644 "${UNIT_SOURCE}" "/etc/systemd/system/${SERVICE_NAME}"
install -o root -g root -m 0600 "${ENV_EXAMPLE_SOURCE}" /etc/qorpera/lxd-company-provider.env.example
install -d -o "${PROVIDER_USER}" -g "${PROVIDER_USER}" -m 0700 /var/lib/qorpera-company-provider

systemctl daemon-reload
echo "Installed. Fill /etc/qorpera/lxd-company-provider.env from the example,"
echo "then: systemctl enable --now ${SERVICE_NAME}"
