#!/usr/bin/env bash
# Rebuild an execution host from a newly pinned runner guest image. Run as root
# on the node host (through the reviewed task-admin helper). The host's config,
# credentials and the co-located orchestrator's identity are reused from the
# staging directory; only the image and the Codex fence digest change.
#
#   rebuild-exec-host.sh <image-fingerprint>
#
# Environment (defaults fit node 2's pilot):
#   EXEC_VM          LXD instance name            (qorpera-exec-node02)
#   EXEC_PROJECT     LXD project                  (qn25b2)
#   EXEC_PACKAGE     built shared-execution package directory
#                    (/home/company41-admin/qorpera-turn-latency/shared-pkg)
#   EXEC_STAGING     root-only config staging dir (/root/qorpera-shared-exec-pilot)
#                    with shared-execution.env, runner-orchestrator.env, credentials/
#   EXEC_SLOTS       slot count                   (16)
# The orchestrator inside the host is left stopped: start it when the cut is live.
set -euo pipefail

FINGERPRINT="${1:-}"
if [[ ! ${FINGERPRINT} =~ ^[0-9a-f]{64}$ ]]; then
	echo "usage: $0 <image-fingerprint-sha256>" >&2
	exit 1
fi
if [[ ${EUID} -ne 0 ]]; then
	echo "Run as root on the node host." >&2
	exit 1
fi
VM="${EXEC_VM:-qorpera-exec-node02}"
PROJECT="${EXEC_PROJECT:-qn25b2}"
PACKAGE="${EXEC_PACKAGE:-/home/company41-admin/qorpera-turn-latency/shared-pkg}"
STAGING="${EXEC_STAGING:-/root/qorpera-shared-exec-pilot}"
SLOTS="${EXEC_SLOTS:-16}"
for file in qorpera-shared-execution-service.mjs install-shared-execution-guest.sh manifest.json; do
	[[ -f ${PACKAGE}/${file} ]] || { echo "Package is incomplete: ${PACKAGE}/${file}" >&2; exit 1; }
done
for file in shared-execution.env runner-orchestrator.env credentials/qorpera-runner-provider credentials/qorpera-supabase-service-key; do
	[[ -f ${STAGING}/${file} ]] || { echo "Staging is incomplete: ${STAGING}/${file}" >&2; exit 1; }
done
lxc image info "${FINGERPRINT}" --project "${PROJECT}" >/dev/null

exec_in() { lxc exec "${VM}" --project "${PROJECT}" -- "$@"; }
push() { lxc file push --project "${PROJECT}" --mode "$3" --uid 0 --gid 0 -p "$1" "${VM}$2"; }

# No new run may be admitted from here on: the orchestrator goes first, then the
# host is checked for anything still alive. A rebuild wipes the journals, so a
# sandbox in flight (even one still retiring, with a release owed) must not exist.
echo "Stopping the orchestrator before checking the host."
exec_in systemctl disable --now qorpera-runner-orchestrator.service
echo "Refusing to rebuild while any sandbox exists:"
units=$(exec_in systemctl list-units --no-legend --plain --state=active,activating,deactivating,reloading,refreshing 'qorpera-shared-run-host@*' 'qorpera-shared-runner@*')
journals=$(exec_in sh -c 'ls /var/lib/qorpera-shared-execution/journals/*.json 2>/dev/null || true')
if [[ -n ${units} || -n ${journals} ]]; then
	echo "  live on ${VM}:" >&2
	printf '  %s\n' ${units} ${journals} >&2
	echo "  wait for every sandbox to retire (or archive its journal after confirming its allocation is released), then retry." >&2
	exit 1
fi
echo "  none."
lxc stop "${VM}" --project "${PROJECT}" || true
lxc rebuild "${FINGERPRINT}" "${VM}" --project "${PROJECT}"
lxc start "${VM}" --project "${PROJECT}"
for _ in $(seq 1 120); do
	if exec_in true 2>/dev/null; then break; fi
	sleep 2
done
exec_in true

echo "Installing the shared execution package."
exec_in rm -rf /var/lib/qorpera-bootstrap/shared-execution /var/lib/qorpera-bootstrap/shared-pkg
lxc file push --project "${PROJECT}" -r -p "${PACKAGE}" "${VM}/var/lib/qorpera-bootstrap/" >/dev/null
exec_in mv "/var/lib/qorpera-bootstrap/$(basename "${PACKAGE}")" /var/lib/qorpera-bootstrap/shared-execution
exec_in env "QORPERA_SHARED_EXECUTION_SLOTS=${SLOTS}" bash /var/lib/qorpera-bootstrap/shared-execution/install-shared-execution-guest.sh \
	| grep -v 'CPUAccounting\|strict user' | tail -1

echo "Configuring: the fence digest is taken from the image, never from the previous host."
fence=$(exec_in sha256sum /opt/qorpera-harnesses/native-company/codex | cut -d' ' -f1)
[[ ${fence} =~ ^[0-9a-f]{64}$ ]]
sed -i "s/^QORPERA_NATIVE_CODEX_FENCE_SHA256=.*/QORPERA_NATIVE_CODEX_FENCE_SHA256=${fence}/" "${STAGING}/shared-execution.env"
push "${STAGING}/shared-execution.env" /etc/qorpera/shared-execution.env 0600
# The rebuilt host lost the orchestrator's rotated control state; re-register
# the same orchestrator id with a fresh bootstrap control token (service role).
supabase_url=$(sed -n 's/^QORPERA_SUPABASE_URL=//p' "${STAGING}/shared-execution.env")
adapter=$(sed -n 's/^QORPERA_RUNNER_PROVIDER_ADAPTER=//p' "${STAGING}/shared-execution.env")
orchestrator_id=$(sed -n 's/^QORPERA_RUNNER_ORCHESTRATOR_ID=//p' "${STAGING}/runner-orchestrator.env")
control_token=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
control_sha256=$(printf '%s' "${control_token}" | sha256sum | cut -d' ' -f1)
service_key=$(tr -d '\n' < "${STAGING}/credentials/qorpera-supabase-service-key")
# The service key never appears on a command line: curl reads its headers from a
# file descriptor this shell owns.
registered=$(curl -sS -X POST "${supabase_url}/rest/v1/rpc/qorpera_register_runner_orchestrator" \
	-K <(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "${service_key}" "${service_key}") \
	-d "{\"p_orchestrator_id\":\"${orchestrator_id}\",\"p_display_name\":\"shared-execution ${VM}\",\"p_provider_adapter\":\"${adapter}\",\"p_control_token_sha256\":\"${control_sha256}\",\"p_control_token_seconds\":86400}")
unset service_key
[[ ${registered} == *'"status": "active"'* || ${registered} == *'"status":"active"'* ]] || { echo "Orchestrator registration failed" >&2; exit 1; }
sed -i "s|^QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN=.*|QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN=${control_token}|" "${STAGING}/runner-orchestrator.env"
unset control_token
push "${STAGING}/runner-orchestrator.env" /etc/qorpera/runner-orchestrator.env 0600
for name in "${STAGING}"/credentials/*; do
	mode=0600
	[[ ${name} == *.crt ]] && mode=0644
	push "${name}" "/etc/qorpera/shared-execution-credentials/$(basename "${name}")" "${mode}"
done
exec_in chmod 700 /etc/qorpera/shared-execution-credentials
exec_in systemctl enable --now qorpera-shared-execution.service >/dev/null
sleep 2
status=$(exec_in systemctl is-active qorpera-shared-execution.service)
health=$(exec_in curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18450/healthz)
echo "image=${FINGERPRINT} fence=${fence} service=${status} healthz=${health} orchestrator=stopped"
echo "Start the orchestrator when the cut is live: lxc exec ${VM} --project ${PROJECT} -- systemctl enable --now qorpera-runner-orchestrator.service"
