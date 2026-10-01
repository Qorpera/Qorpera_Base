#!/usr/bin/env bash
# Rebuild an execution host from a newly pinned runner guest image. Run as root
# on the node host (through the reviewed task-admin helper). The host's config,
# credentials and the co-located orchestrator's identity are reused from the
# staging directory; only the image and the Codex fence digest change.
#
#   rebuild-exec-host.sh <image-fingerprint>
#
# Environment, all required (the same script serves every node; there are no
# node defaults, so a rebuild never silently takes another node's name or the
# pilot's 16 slots):
#   EXEC_VM          LXD instance name            (e.g. qorpera-exec-node02)
#   EXEC_PROJECT     LXD project                  (e.g. qn25b2)
#   EXEC_PACKAGE     built shared-execution package directory
#   EXEC_STAGING     root-only config staging dir with shared-execution.env,
#                    runner-orchestrator.env, credentials/
#   EXEC_SLOTS       slot count (the node's sized value, e.g. 2 or 4); the staged
#                    shared-execution.env must say the same
#                    (QORPERA_SHARED_EXECUTION_SLOTS), or the script refuses
# Optional:
#   EXEC_RUNTIME_BUNDLE_SHA256  declare the re-registered orchestrator's runtime
#                    bundle (rolling updates; needs migration 20260928182000).
#                    Unset: the orchestrator claims runs of any bundle. Once
#                    20260928182000 is live, re-registration clears an earlier
#                    declaration. Only a registered bundle can be declared, and
#                    a bundle is registered by its activation: a rebuild before
#                    the activation leaves it unset, and the operator declares
#                    the orchestrator after the activation, while the node is
#                    still switched off (RUNTIME-ROLLING-UPDATE.md). It is
#                    declared last, once the host is set up.
#   EXEC_PREFLIGHT_ONLY=1  check the inputs, change nothing, exit
#   EXEC_FRESH=1     set only by create-exec-host.sh: the host was just created
#                    from this image and never started, so there is nothing to
#                    stop, check or rebuild. The script checks that the VM is
#                    stopped, from this image and without identity devices; it
#                    cannot tell that it never ran, so never set it by hand.
# The orchestrator inside the host is left stopped: start it when the cut is live.
# `lxc rebuild` replaces the root disk only: the instance keeps its devices,
# the Compute Identity devices (identity-<uuid>) the login gateway attached
# included. The script refuses to finish if one went missing.
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
for name in EXEC_VM EXEC_PROJECT EXEC_PACKAGE EXEC_STAGING EXEC_SLOTS; do
	[[ -n ${!name:-} ]] || { echo "${name} is required (no node defaults)." >&2; exit 1; }
done
VM="${EXEC_VM}"
PROJECT="${EXEC_PROJECT}"
PACKAGE="${EXEC_PACKAGE}"
STAGING="${EXEC_STAGING}"
SLOTS="${EXEC_SLOTS}"
BUNDLE="${EXEC_RUNTIME_BUNDLE_SHA256:-}"
for name in VM PROJECT; do
	[[ ${!name} =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || { echo "EXEC_${name} is not an LXD name." >&2; exit 1; }
done
FRESH="${EXEC_FRESH:-}"
if [[ ! ${SLOTS} =~ ^[1-9][0-9]?$ ]] || ((SLOTS > 64)); then
	echo "EXEC_SLOTS must be 1-64." >&2
	exit 1
fi
if [[ -n ${BUNDLE} && ! ${BUNDLE} =~ ^[0-9a-f]{64}$ ]]; then
	echo "EXEC_RUNTIME_BUNDLE_SHA256 must be a sha256." >&2
	exit 1
fi
for file in qorpera-shared-execution-service.mjs install-shared-execution-guest.sh manifest.json; do
	[[ -f ${PACKAGE}/${file} ]] || { echo "Package is incomplete: ${PACKAGE}/${file}" >&2; exit 1; }
done
for file in shared-execution.env runner-orchestrator.env credentials/qorpera-runner-provider credentials/qorpera-supabase-service-key; do
	[[ -f ${STAGING}/${file} ]] || { echo "Staging is incomplete: ${STAGING}/${file}" >&2; exit 1; }
done
# The service reads its slot count from the staged env (default 16); the host is
# sized and installed for EXEC_SLOTS. The two must agree.
staged_slots=$(sed -n 's/^QORPERA_SHARED_EXECUTION_SLOTS=//p' "${STAGING}/shared-execution.env")
if [[ ${staged_slots} != "${SLOTS}" ]]; then
	echo "${STAGING}/shared-execution.env must set QORPERA_SHARED_EXECUTION_SLOTS=${SLOTS} (it says '${staged_slots:-16 by default}')." >&2
	exit 1
fi
for name in QORPERA_SUPABASE_URL QORPERA_RUNNER_PROVIDER_ADAPTER QORPERA_NATIVE_CODEX_FENCE_SHA256; do
	grep -q "^${name}=" "${STAGING}/shared-execution.env" || { echo "${STAGING}/shared-execution.env has no ${name} line." >&2; exit 1; }
done
for name in QORPERA_RUNNER_ORCHESTRATOR_ID QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN; do
	[[ $(grep -c "^${name}=" "${STAGING}/runner-orchestrator.env") == 1 ]] || { echo "${STAGING}/runner-orchestrator.env must have exactly one ${name} line." >&2; exit 1; }
done
lxc image info "${FINGERPRINT}" --project "${PROJECT}" >/dev/null
if [[ -n ${EXEC_PREFLIGHT_ONLY:-} ]]; then
	echo "Inputs checked; nothing changed."
	exit 0
fi

exec_in() { lxc exec "${VM}" --project "${PROJECT}" -- "$@"; }
identity_devices() {
	lxc query "/1.0/instances/${VM}?project=${PROJECT}" \
		| python3 -c 'import json,sys; print("\n".join(sorted(k for k in json.load(sys.stdin)["devices"] if k.startswith("identity-"))))'
}
push() { lxc file push --project "${PROJECT}" --mode "$3" --uid 0 --gid 0 -p "$1" "${VM}$2"; }

if [[ -n ${FRESH} ]]; then
	# Only a host create-exec-host.sh just made: stopped, from this image, no identity devices.
	fresh=$(lxc query "/1.0/instances/${VM}?project=${PROJECT}" | python3 -c 'import json,sys; i=json.load(sys.stdin); print(i["status"], i["config"].get("volatile.base_image", ""), sum(k.startswith("identity-") for k in i["devices"]))')
	if [[ ${fresh} != "Stopped ${FINGERPRINT} 0" ]]; then
		echo "EXEC_FRESH is only for a host create-exec-host.sh just made (stopped, from this image, no identity devices)." >&2
		exit 1
	fi
	echo "New host: nothing to stop, check or rebuild."
else
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
	identities_before=$(identity_devices)
	lxc stop "${VM}" --project "${PROJECT}" || true
	lxc rebuild "${FINGERPRINT}" "${VM}" --project "${PROJECT}"
	# The login gateway may add identities meanwhile; none may be lost.
	lost=$(LC_ALL=C comm -23 <(printf '%s\n' "${identities_before}" | sed '/^$/d') <(identity_devices))
	if [[ -n ${lost} ]]; then
		echo "The rebuild lost Compute Identity devices; re-attach them before starting:" >&2
		printf '  %s\n' ${lost} >&2
		exit 1
	fi
	echo "Kept $(printf '%s\n' "${identities_before}" | sed '/^$/d' | wc -l | tr -d ' ') Compute Identity devices."
fi
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
# The body goes through standard input too: the control token's sha256 names the orchestrator's wake-up
# topic (migration 20260929550000), so it is kept off the command line like the key.
registered=$(printf '{"p_orchestrator_id":"%s","p_display_name":"shared-execution %s","p_provider_adapter":"%s","p_control_token_sha256":"%s","p_control_token_seconds":86400}' \
	"${orchestrator_id}" "${VM}" "${adapter}" "${control_sha256}" |
	curl -sS -X POST "${supabase_url}/rest/v1/rpc/qorpera_register_runner_orchestrator" \
		-K <(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "${service_key}" "${service_key}") \
		--data-binary @-)
[[ ${registered} == *'"status": "active"'* || ${registered} == *'"status":"active"'* ]] || { unset service_key; echo "Orchestrator registration failed" >&2; exit 1; }
unset service_key
# The token goes through the environment, never a command line (/proc/*/cmdline is world-readable).
# Written to a temporary file and renamed, so a failed write never leaves an empty file.
CONTROL_TOKEN="${control_token}" python3 -c 'import os,re,sys
path = sys.argv[1]
with open(path, newline="") as f:
    text = f.read()
line = "QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN=" + os.environ["CONTROL_TOKEN"]
text, count = re.subn(r"(?m)^QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN=.*$", lambda _: line, text)
if count != 1:
    sys.exit("expected exactly one control token line")
temporary = path + ".new"
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, os.stat(path).st_mode & 0o7777)
with os.fdopen(fd, "w", newline="") as f:
    f.write(text)
    f.flush()
    os.fsync(f.fileno())
os.replace(temporary, path)' "${STAGING}/runner-orchestrator.env"
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
if [[ -n ${BUNDLE} ]]; then
	# Last, so a refused declaration (an unregistered bundle) leaves a host that is set up
	# and an orchestrator that is registered but undeclared.
	service_key=$(tr -d '\n' < "${STAGING}/credentials/qorpera-supabase-service-key")
	declared=$(curl -sS -X POST "${supabase_url}/rest/v1/rpc/qorpera_declare_runner_orchestrator_bundle" \
		-K <(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "${service_key}" "${service_key}") \
		-d "{\"p_orchestrator_id\":\"${orchestrator_id}\",\"p_runtime_bundle_sha256\":\"${BUNDLE}\"}") || declared="(no reply from the database)"
	unset service_key
	declared_bundle=$(printf '%s' "${declared}" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("runtimeBundleSha256") or "")
except Exception:
    print("")')
	if [[ ${declared_bundle} != "${BUNDLE}" ]]; then
		declaration_failed=1
		declaration_reply=$(printf '%s' "${declared:-(empty reply)}" | head -c 300)
		BUNDLE=
	fi
fi
echo "image=${FINGERPRINT} fence=${fence} slots=${SLOTS} bundle=${BUNDLE:-any} service=${status} healthz=${health} orchestrator=stopped"
if [[ -z ${FRESH} ]]; then
	echo "If the node's inventory policy lists this host exactly (no \"role\": \"execution-host\", #436), re-enrol its digest (image.* keys changed);"
	echo "identity devices are not part of it when the entry declares identityVolumes: lxc query '/1.0/instances/${VM}?project=${PROJECT}' | exec-host-inventory-digest.py --pool <pool> --source-prefix <prefix>"
	echo "A host listed by role needs no re-enrol while the release that pins this image is staged on the node."
fi
echo "Start the orchestrator when the cut is live: lxc exec ${VM} --project ${PROJECT} -- systemctl enable --now qorpera-runner-orchestrator.service"
if [[ -n ${declaration_failed:-} ]]; then
	echo "The host is set up, but the bundle declaration failed; the orchestrator claims any bundle until it is declared: ${declaration_reply}" >&2
	exit 1
fi
