#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 || "$#" -ne 1 || ! "$1" =~ ^[a-z0-9-]{3,24}$ ]]; then
	echo "usage: refresh-step2-secret-custody-credentials.sh <vault-name>" >&2
	exit 64
fi

vault_name="$1"
umask 077
if [[ ! -c /dev/tpmrm0 ]]; then
	echo "Trusted Launch vTPM is unavailable" >&2
	exit 65
fi
systemd-creds has-tpm2 >/dev/null

metadata_token() {
	local resource="$1"
	curl --fail --silent --show-error --noproxy '*' \
		-H Metadata:true \
		"http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${resource}" \
		| jq -er '.access_token'
}

staging_directory="$(mktemp -d /etc/credstore.encrypted/.qorpera-refresh.XXXXXX)"
cleanup() {
	if [[ -d "${staging_directory}" && "${staging_directory}" == /etc/credstore.encrypted/.qorpera-refresh.* ]]; then
		find "${staging_directory}" -depth -delete
	fi
}
trap cleanup EXIT
vault_token="$(metadata_token 'https%3A%2F%2Fvault.azure.net')"

seal_secret() {
	local secret_name="$1"
	local credential_name="$2"
	local target="${staging_directory}/${credential_name}"
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

for credential in "${staging_directory}"/*; do
	mv "${credential}" "/etc/credstore.encrypted/${credential##*/}"
done
sync -f /etc/credstore.encrypted

systemctl reset-failed \
	qorpera-step2-secret-canary-destination.service \
	qorpera-cloud-secret-broker-canary.service \
	qorpera-cloud-secret-capture-proxy.service || true
systemctl restart qorpera-step2-secret-canary-destination.service
systemctl restart qorpera-cloud-secret-broker-canary.service
systemctl restart qorpera-cloud-secret-capture-proxy.service
systemctl is-active --quiet qorpera-step2-secret-canary-destination.service
systemctl is-active --quiet qorpera-cloud-secret-broker-canary.service
systemctl is-active --quiet qorpera-cloud-secret-capture-proxy.service

echo "Step 2 secret-custody credentials refreshed"
