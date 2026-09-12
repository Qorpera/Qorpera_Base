#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_ARTIFACT_SHA256="f3bb7b95e120dfe693fb1e7b1b4c32ad424d727beb46658f173327975a62308c"
EXPECTED_PROVENANCE_TOOL_SHA256="316006ebe6d263cb716ebf0fbed0917d170f47e777d25838b5720706f787dcec"
EXPECTED_UNIT_SHA256="18f6799fe72a840f795335a099d48be7b82690e7cd38cce3a2eda7b5020966c8"
EXPECTED_ENV_EXAMPLE_SHA256="a9061ec361965571dd9c63381711a90d4ef9b76af9c4b790a78c81646d68b585"
STAGING_ROOT="/home/company41-admin/step2-lxd"
ARTIFACT_SOURCE="${STAGING_ROOT}/qorpera-lxd-provider.mjs"
PROVENANCE_TOOL_SOURCE="${STAGING_ROOT}/qorpera-lxd-image-provenance.mjs"
UNIT_SOURCE="${STAGING_ROOT}/qorpera-lxd-provider.service"
ENV_EXAMPLE_SOURCE="${STAGING_ROOT}/lxd-provider.env.example"
INSTALL_ROOT="/opt/qorpera/runner-provider"
SERVICE_NAME="qorpera-lxd-provider.service"
INSTALL_LOG="/var/log/qorpera-lxd-provider-install.log"
STATE_LOG="/var/log/qorpera-lxd-provider-host-state.txt"
PROVIDER_USER="qorpera-provider"
PREFLIGHT_PORT=18081
PREFLIGHT_LOGIN_PORT=18082

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi

install -o root -g root -m 0644 /dev/null "${INSTALL_LOG}"
exec > >(tee "${INSTALL_LOG}") 2>&1
echo "Starting fail-closed LXD provider installation on $(date --iso-8601=seconds)."

if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to install on unexpected host $(hostname)." >&2
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
		echo "Checksum mismatch for ${file}." >&2
		exit 1
	fi
}

verify_sha256 "${ARTIFACT_SOURCE}" "${EXPECTED_ARTIFACT_SHA256}"
verify_sha256 "${PROVENANCE_TOOL_SOURCE}" "${EXPECTED_PROVENANCE_TOOL_SHA256}"
verify_sha256 "${UNIT_SOURCE}" "${EXPECTED_UNIT_SHA256}"
verify_sha256 "${ENV_EXAMPLE_SOURCE}" "${EXPECTED_ENV_EXAMPLE_SHA256}"

if ! getent passwd "${PROVIDER_USER}" >/dev/null; then
	echo "The dedicated provider account is missing; run the LXD host bootstrap first." >&2
	exit 1
fi
if ! lxc query /1.0 >/dev/null 2>&1; then
	echo "The local LXD API is unavailable." >&2
	exit 1
fi
if [[ $(lxc project get qorpera-runners features.networks) != false ]]; then
	echo "The LXD runner project has not passed its isolation bootstrap." >&2
	exit 1
fi
if systemctl is-active --quiet "${SERVICE_NAME}"; then
	echo "Refusing to replace a running provider service." >&2
	exit 1
fi

apt-get install --yes nodejs openssl
node_version=$(node --version | sed 's/^v//')
if ! dpkg --compare-versions "${node_version}" ge 22.19.0; then
	echo "Node.js ${node_version} is older than the controlled provider minimum." >&2
	exit 1
fi

install -d -o root -g root -m 0755 "${INSTALL_ROOT}"
install -o root -g root -m 0755 "${ARTIFACT_SOURCE}" "${INSTALL_ROOT}/qorpera-lxd-provider.mjs"
install -o root -g root -m 0755 "${PROVENANCE_TOOL_SOURCE}" "${INSTALL_ROOT}/qorpera-lxd-image-provenance.mjs"
install -o root -g root -m 0644 "${UNIT_SOURCE}" "/etc/systemd/system/${SERVICE_NAME}"
install -o root -g root -m 0600 "${ENV_EXAMPLE_SOURCE}" /etc/qorpera/lxd-provider.env.example

/usr/bin/node --check "${INSTALL_ROOT}/qorpera-lxd-provider.mjs"
/usr/bin/node --check "${INSTALL_ROOT}/qorpera-lxd-image-provenance.mjs"
if ! runuser -u "${PROVIDER_USER}" -- /usr/bin/node -e \
	"const http = require('node:http'); const request = http.get({ socketPath: '/var/snap/lxd/common/lxd/unix.socket', path: '/1.0' }, response => { response.resume(); response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1)); }); request.on('error', () => process.exit(1)); request.setTimeout(5000, () => request.destroy());"; then
	echo "The dedicated provider account cannot reach the local LXD socket." >&2
	exit 1
fi

systemctl daemon-reload
systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
if systemctl is-enabled --quiet "${SERVICE_NAME}"; then
	echo "The provider unit unexpectedly became enabled." >&2
	exit 1
fi

runtime_preflight="skipped-existing-configuration"
if [[ ! -e /etc/qorpera/lxd-provider.env ]]; then
	preflight_config=/etc/qorpera/lxd-provider.env
	preflight_root=$(mktemp -d /run/qorpera-lxd-provider-preflight.XXXXXX)
	preflight_fingerprint=$(printf 'a%.0s' {1..64})
	preflight_base_fingerprint=$(printf 'b%.0s' {1..64})
	preflight_manifest=$(printf 'c%.0s' {1..64})
	preflight_runner_image="registry.invalid/qorpera@sha256:$(printf 'b%.0s' {1..64})"
	preflight_runner_archive=$(printf 'f%.0s' {1..64})
	preflight_runner_bundle=$(printf '0%.0s' {1..64})
	preflight_private_key="${preflight_root}/private.pem"
	preflight_public_key="${preflight_root}/public.pem"
	preflight_statement="${preflight_root}/statement.json"
	preflight_provenance="${preflight_root}/provenance.json"
	cleanup_preflight() {
		systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
		rm -f "${preflight_config}"
		rm -rf -- "${preflight_root}"
	}
	trap cleanup_preflight EXIT
	openssl genpkey -algorithm ED25519 -out "${preflight_private_key}"
	openssl pkey -in "${preflight_private_key}" -pubout -out "${preflight_public_key}"
	/usr/bin/node "${INSTALL_ROOT}/qorpera-lxd-image-provenance.mjs" create \
		--image-server local \
		--image-fingerprint "${preflight_fingerprint}" \
		--base-image-fingerprint "${preflight_base_fingerprint}" \
		--guest-package-manifest-sha256 "${preflight_manifest}" \
		--runner-image "${preflight_runner_image}" \
		--runner-image-archive-sha256 "${preflight_runner_archive}" \
		--runner-image-cosign-bundle-sha256 "${preflight_runner_bundle}" \
		--source-repository https://preflight.invalid/qorpera-base.git \
		--source-commit "$(printf 'd%.0s' {1..40})" \
		--source-tree clean \
		--tested-at "$(date --utc +%Y-%m-%dT%H:%M:%S.000Z)" \
		--acceptance-evidence-sha256 "$(printf 'e%.0s' {1..64})" \
		--output "${preflight_statement}"
	/usr/bin/node "${INSTALL_ROOT}/qorpera-lxd-image-provenance.mjs" sign \
		--statement "${preflight_statement}" \
		--private-key "${preflight_private_key}" \
		--output "${preflight_provenance}"
	rm -f -- "${preflight_private_key}" "${preflight_statement}"
	chown root:"${PROVIDER_USER}" "${preflight_root}"
	chmod 0750 "${preflight_root}"
	chown root:"${PROVIDER_USER}" "${preflight_public_key}" "${preflight_provenance}"
	chmod 0640 "${preflight_public_key}" "${preflight_provenance}"
	runuser -u "${PROVIDER_USER}" -- /usr/bin/node "${INSTALL_ROOT}/qorpera-lxd-image-provenance.mjs" verify \
		--provenance "${preflight_provenance}" \
		--public-key "${preflight_public_key}" \
		--image-server local \
		--image-fingerprint "${preflight_fingerprint}" \
		--guest-package-manifest-sha256 "${preflight_manifest}" \
		--runner-image "${preflight_runner_image}" \
		--runner-image-archive-sha256 "${preflight_runner_archive}" \
		--runner-image-cosign-bundle-sha256 "${preflight_runner_bundle}"
	install -o root -g root -m 0600 /dev/null "${preflight_config}"
	printf '%s\n' \
		'QORPERA_RUNNER_PROVIDER_BACKEND=lxd' \
		'QORPERA_RUNNER_PROVIDER_ADAPTER=lxd' \
		'QORPERA_RUNNER_PROVIDER_TOKEN=provider-runtime-preflight-only' \
		'QORPERA_RUNNER_PROVIDER_HOST=127.0.0.1' \
		"QORPERA_RUNNER_PROVIDER_PORT=${PREFLIGHT_PORT}" \
		'QORPERA_SUPABASE_URL=https://preflight.invalid' \
		'QORPERA_SUPABASE_SERVICE_KEY=preflight-service-key' \
		'QORPERA_SUPABASE_PUBLISHABLE_KEY=preflight-publishable-key' \
		'QORPERA_RUNNER_PROVIDER_STATE_ROOT=/var/lib/qorpera-provider/runs' \
		'QORPERA_LXD_SOCKET=/var/snap/lxd/common/lxd/unix.socket' \
		'QORPERA_LXD_OPERATION_TIMEOUT_SECONDS=10' \
		'QORPERA_LXD_PROJECT=qorpera-runners' \
		'QORPERA_LXD_JOB_PROFILE=qorpera-job-v1' \
		'QORPERA_LXD_LOGIN_PROFILE=qorpera-login-v1' \
		'QORPERA_LXD_NETWORK_INTERFACE=enp5s0' \
		'QORPERA_LXD_IMAGE_SERVER=local' \
		"QORPERA_LXD_IMAGE_FINGERPRINT=${preflight_fingerprint}" \
		"QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=${preflight_manifest}" \
		"QORPERA_LXD_IMAGE_PROVENANCE=${preflight_provenance}" \
		"QORPERA_LXD_IMAGE_PROVENANCE_PUBLIC_KEY=${preflight_public_key}" \
		'QORPERA_LXD_STORAGE_POOL=qorpera-vm' \
		'QORPERA_LXD_IDENTITY_VOLUME_PREFIX=identity-' \
		'QORPERA_LXD_IDENTITY_VOLUME_SIZE=32GiB' \
		'QORPERA_LXD_ROOT_DISK_SIZE=80GiB' \
		'QORPERA_LXD_CPU_LIMIT=4' \
		'QORPERA_LXD_MEMORY_LIMIT=8GiB' \
		'QORPERA_LXD_GUEST_ASSIGNMENT_PORT=8082' \
		'QORPERA_LXD_GUEST_ASSIGNMENT_SOURCE=10.41.0.1' \
		'QORPERA_LXD_NATIVE_BRIDGE_PORT=8083' \
		'QORPERA_LXD_NATIVE_EXECUTION_GID=42041' \
		'QORPERA_LXD_GUEST_READY_TIMEOUT_MS=300000' \
		'QORPERA_LXD_GUEST_BOOTSTRAP_SERVICE=qorpera-lxd-runner-bootstrap.service' \
		'QORPERA_LXD_LOGIN_STATE_ROOT=/var/lib/qorpera-provider/logins' \
		'QORPERA_LXD_LOGIN_GATEWAY_HOST=127.0.0.1' \
		"QORPERA_LXD_LOGIN_GATEWAY_PORT=${PREFLIGHT_LOGIN_PORT}" \
		'QORPERA_LXD_LOGIN_BOOTSTRAP_SERVICE=qorpera-lxd-native-login-bootstrap.service' \
		"QORPERA_EPHEMERAL_RUNNER_IMAGE=${preflight_runner_image}" \
		"QORPERA_EPHEMERAL_RUNNER_IMAGE_ARCHIVE_SHA256=${preflight_runner_archive}" \
		"QORPERA_EPHEMERAL_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256=${preflight_runner_bundle}" \
		'QORPERA_EPHEMERAL_RUNNER_PODMAN=/usr/bin/podman' \
		'QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT=/qorpera/bin/run-job' \
		'QORPERA_EPHEMERAL_RUNNER_VERSION=preflight' \
		'QORPERA_CODEX_PATH=/usr/local/bin/codex' \
		'QORPERA_CLAUDE_PATH=/usr/local/bin/claude' \
		>"${preflight_config}"

	if ! systemctl start "${SERVICE_NAME}"; then
		journalctl -u "${SERVICE_NAME}" --no-pager -n 80
		echo "The hardened provider unit failed its runtime preflight." >&2
		exit 1
	fi
	health_ready=false
	for _attempt in $(seq 1 30); do
		if /usr/bin/node -e \
			"Promise.all([${PREFLIGHT_PORT}, ${PREFLIGHT_LOGIN_PORT}].map(port => fetch('http://127.0.0.1:' + port + '/healthz').then(async response => { const payload = await response.json(); if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true || Object.keys(payload).length !== 1) throw new Error('health') }))).catch(() => process.exit(1))"; then
			health_ready=true
			break
		fi
		sleep 1
	done
	if [[ ${health_ready} != true ]]; then
		journalctl -u "${SERVICE_NAME}" --no-pager -n 80
		echo "The provider health endpoint failed its runtime preflight." >&2
		exit 1
	fi
	cleanup_preflight
	trap - EXIT
	systemctl reset-failed "${SERVICE_NAME}" >/dev/null 2>&1 || true
	runtime_preflight="passed"
fi

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "node=$(node --version)"
	echo "artifact_sha256=$(sha256sum "${INSTALL_ROOT}/qorpera-lxd-provider.mjs" | awk '{ print $1 }')"
	echo "provenance_tool_sha256=$(sha256sum "${INSTALL_ROOT}/qorpera-lxd-image-provenance.mjs" | awk '{ print $1 }')"
	echo "unit_load_state=$(systemctl show "${SERVICE_NAME}" -p LoadState --value)"
	echo "unit_file_state=$(systemctl show "${SERVICE_NAME}" -p UnitFileState --value)"
	echo "unit_active_state=$(systemctl show "${SERVICE_NAME}" -p ActiveState --value)"
	if [[ -e /etc/qorpera/lxd-provider.env ]]; then
		echo "configuration=present"
	else
		echo "configuration=absent-fail-closed"
	fi
	echo "lxd_socket_access=provider-user-verified"
	echo "runtime_preflight=${runtime_preflight}"
} >"${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f "${state_tmp}"

echo "LXD_PROVIDER_UNIT_INSTALLED_DISABLED"
echo "artifact=${INSTALL_ROOT}/qorpera-lxd-provider.mjs"
echo "configuration=/etc/qorpera/lxd-provider.env (intentionally absent)"
