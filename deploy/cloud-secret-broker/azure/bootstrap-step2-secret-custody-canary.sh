#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 || "$#" -ne 3 ]]; then
	echo "usage: bootstrap-step2-secret-custody-canary.sh <vault-name> <storage-account> <artifact-sha256>" >&2
	exit 64
fi

vault_name="$1"
storage_account="$2"
artifact_sha256="$3"
if [[ ! "${vault_name}" =~ ^[a-z0-9-]{3,24}$ || ! "${storage_account}" =~ ^[a-z0-9]{3,24}$ || ! "${artifact_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
	echo "invalid Step 2 secret-custody bootstrap identity" >&2
	exit 65
fi

umask 077
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl jq nginx openssl xz-utils

work_directory="$(mktemp -d /var/tmp/qorpera-step2-secret-bootstrap.XXXXXX)"
cleanup() {
	if [[ -d "${work_directory}" && "${work_directory}" == /var/tmp/qorpera-step2-secret-bootstrap.* ]]; then
		find "${work_directory}" -depth -delete
	fi
}
trap cleanup EXIT

node_version="22.19.0"
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_sha256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
	"https://nodejs.org/dist/v${node_version}/${node_archive}" \
	--output "${work_directory}/${node_archive}"
printf '%s  %s\n' "${node_sha256}" "${work_directory}/${node_archive}" | sha256sum --check --status
if [[ ! -x "/opt/node-v${node_version}-linux-x64/bin/node" ]]; then
	tar -C /opt -xJf "${work_directory}/${node_archive}"
fi
ln -sfn "/opt/node-v${node_version}-linux-x64/bin/node" /usr/local/bin/node
[[ "$(/usr/local/bin/node --version)" == "v${node_version}" ]]

metadata_token() {
	local resource="$1"
	curl --fail --silent --show-error --noproxy '*' \
		-H Metadata:true \
		"http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${resource}" \
		| jq -er '.access_token'
}

storage_token="$(metadata_token 'https%3A%2F%2Fstorage.azure.com%2F')"
artifact="${work_directory}/qorpera-step2-secret-canary.tgz"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
	-H "Authorization: Bearer ${storage_token}" \
	-H 'x-ms-version: 2023-11-03' \
	"https://${storage_account}.blob.core.windows.net/artifacts/qorpera-step2-secret-canary-${artifact_sha256}.tgz" \
	--output "${artifact}"
storage_token=''
printf '%s  %s\n' "${artifact_sha256}" "${artifact}" | sha256sum --check --status

cat >"${work_directory}/expected-archive-entries" <<'EOF'
./
./capture-proxy.conf
./manifest.json
./qorpera-cloud-secret-broker-canary-service.mjs
./qorpera-cloud-secret-broker-canary.service
./qorpera-cloud-secret-capture-proxy.service
./qorpera-step2-secret-canary-destination.mjs
./qorpera-step2-secret-canary-destination.service
./qorpera-step2-secret-canary-driver.mjs
./supabase-prod-ca-2021.crt
EOF
tar -tzf "${artifact}" | LC_ALL=C sort >"${work_directory}/archive-entries"
LC_ALL=C sort "${work_directory}/expected-archive-entries" -o "${work_directory}/expected-archive-entries"
if ! cmp --silent "${work_directory}/expected-archive-entries" "${work_directory}/archive-entries"; then
	echo "Step 2 secret-custody archive contains unexpected entries" >&2
	exit 66
fi

install_root="/usr/local/lib/qorpera-step2-secret-canary-${artifact_sha256}"
if [[ -e "${install_root}" ]]; then
	echo "Step 2 secret-custody artifact is already installed" >&2
	exit 68
fi
install -d -m 0755 "${install_root}"
tar --no-same-owner --no-same-permissions --no-xattrs -C "${install_root}" -xzf "${artifact}"
chown root:root "${install_root}" "${install_root}"/*
chmod 0755 "${install_root}"
chmod 0644 "${install_root}"/*
/usr/local/bin/node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const root = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.schema !== "qorpera.step2-secret-canary-package/v1") throw new Error("manifest schema differs");
const allowed = [
  "capture-proxy.conf",
  "qorpera-cloud-secret-broker-canary-service.mjs",
  "qorpera-cloud-secret-broker-canary.service",
  "qorpera-cloud-secret-capture-proxy.service",
  "qorpera-step2-secret-canary-destination.mjs",
  "qorpera-step2-secret-canary-destination.service",
  "qorpera-step2-secret-canary-driver.mjs",
  "supabase-prod-ca-2021.crt",
].sort();
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.map((item) => item.file).sort().join("\\0") !== allowed.join("\\0")) {
  throw new Error("manifest inventory differs");
}
if (fs.readdirSync(root).sort().join("\\0") !== [...allowed, "manifest.json"].sort().join("\\0")) {
  throw new Error("installed inventory differs");
}
for (const artifact of manifest.artifacts) {
  const bytes = fs.readFileSync(path.join(root, artifact.file));
  if (bytes.length !== artifact.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error("artifact digest differs");
  }
}
' "${install_root}"
ln -sfn "${install_root}" /usr/local/lib/qorpera-step2-secret-canary

getent group qorpera-secret-broker >/dev/null || groupadd --system qorpera-secret-broker
id -u qorpera-secret-broker >/dev/null 2>&1 || \
	useradd --system --gid qorpera-secret-broker --home-dir /nonexistent --shell /usr/sbin/nologin qorpera-secret-broker
getent group qorpera-secret-canary >/dev/null || groupadd --system qorpera-secret-canary
id -u qorpera-secret-canary >/dev/null 2>&1 || \
	useradd --system --gid qorpera-secret-canary --home-dir /nonexistent --shell /usr/sbin/nologin qorpera-secret-canary
getent group qorpera-secret-proxy >/dev/null || groupadd --system qorpera-secret-proxy
id -u qorpera-secret-proxy >/dev/null 2>&1 || \
	useradd --system --gid qorpera-secret-proxy --home-dir /nonexistent --shell /usr/sbin/nologin qorpera-secret-proxy

install -d -m 0755 /etc/qorpera-secret-broker
install -d -m 0700 /etc/credstore.encrypted
install -m 0644 "${install_root}/capture-proxy.conf" /etc/qorpera-secret-broker/capture-proxy.conf
install -m 0644 "${install_root}/qorpera-cloud-secret-broker-canary.service" /etc/systemd/system/
install -m 0644 "${install_root}/qorpera-step2-secret-canary-destination.service" /etc/systemd/system/
install -m 0644 "${install_root}/qorpera-cloud-secret-capture-proxy.service" /etc/systemd/system/

if [[ ! -c /dev/tpmrm0 ]]; then
	echo "Trusted Launch vTPM is unavailable" >&2
	exit 67
fi
systemd-creds has-tpm2 >/dev/null
vault_token="$(metadata_token 'https%3A%2F%2Fvault.azure.net')"
seal_secret() {
	local secret_name="$1"
	local credential_name="$2"
	local target="/etc/credstore.encrypted/${credential_name}"
	curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
		-H "Authorization: Bearer ${vault_token}" \
		"https://${vault_name}.vault.azure.net/secrets/${secret_name}?api-version=7.4" \
		| jq -jer '.value' \
		| systemd-creds encrypt --with-key=host+tpm2 --name="${credential_name}" - "${target}" >/dev/null
	chmod 0600 "${target}"
	systemd-creds decrypt "${target}" - >/dev/null
}

seal_secret broker-config qorpera-cloud-secret-config
seal_secret supabase-service-key qorpera-supabase-service-key
seal_secret broker-database-url qorpera-cloud-secret-database-url
seal_secret broker-control qorpera-cloud-secret-control
seal_secret runtime-token qorpera-cloud-secret-runtime
seal_secret broker-keyring qorpera-cloud-secret-keyring
seal_secret canary-provider-token qorpera-step2-canary-provider-token
seal_secret tls-private-key qorpera-step2-canary-tls-key
seal_secret tls-certificate qorpera-step2-canary-tls-cert
seal_secret tls-ca-certificate qorpera-step2-canary-ca-cert
vault_token=''

systemctl daemon-reload
systemctl enable qorpera-step2-secret-canary-destination.service
systemctl enable qorpera-cloud-secret-broker-canary.service
systemctl enable qorpera-cloud-secret-capture-proxy.service
systemctl restart qorpera-step2-secret-canary-destination.service
systemctl restart qorpera-cloud-secret-broker-canary.service
systemctl restart qorpera-cloud-secret-capture-proxy.service
systemctl is-active --quiet qorpera-step2-secret-canary-destination.service
systemctl is-active --quiet qorpera-cloud-secret-broker-canary.service
systemctl is-active --quiet qorpera-cloud-secret-capture-proxy.service

echo "Step 2 secret-custody canary bootstrap completed"
