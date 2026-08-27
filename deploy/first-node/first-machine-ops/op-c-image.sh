#!/usr/bin/env bash
set -euo pipefail

# Step 3 image acceptance. Reads the immutable candidate contract emitted by
# the builder, proves a clean boot in a uniquely tagged disposable VM, and
# records evidence. It deliberately does not mutate the live provider.

STATE_LOG="/var/log/qorpera-lxd-company-computer-image-candidate.txt"
RUNNER_PROJECT="qorpera-runners"
COMPUTER_PROFILE="qorpera-company-computer-v1"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run through sudo." >&2
	exit 1
fi
if [[ ! -f ${STATE_LOG} || -L ${STATE_LOG} ]]; then
	echo "The candidate build state log is missing or unsafe." >&2
	exit 1
fi

fingerprint=$(awk -F= '/^image_fingerprint=/ { print $2 }' "${STATE_LOG}")
guest_manifest=$(awk -F= '/^guest_package_manifest_sha256=/ { print $2 }' "${STATE_LOG}")
if [[ ! ${fingerprint} =~ ^[0-9a-f]{64}$ || ! ${guest_manifest} =~ ^[0-9a-f]{64}$ ]]; then
	echo "The candidate build state log is invalid." >&2
	exit 1
fi

if ! lxc image info "${fingerprint}" --project "${RUNNER_PROJECT}" >/dev/null 2>&1; then
	lxc image copy "local:${fingerprint}" local: --project default --target-project "${RUNNER_PROJECT}"
fi
image_manifest=$(
	lxc query "/1.0/images/${fingerprint}?project=${RUNNER_PROJECT}" |
		jq -r '.properties["user.qorpera.guest_package_manifest_sha256"] // empty'
)
if [[ ${image_manifest} != "${guest_manifest}" ]]; then
	echo "The candidate image does not match the staged guest manifest." >&2
	exit 1
fi

verification_instance="qorpera-cc-verify-${fingerprint:0:12}"
evidence_path="/var/log/qorpera-cc-image-verify-${fingerprint}.log"
if lxc info "${verification_instance}" --project "${RUNNER_PROJECT}" >/dev/null 2>&1; then
	echo "Refusing to replace existing verification instance ${verification_instance}." >&2
	exit 1
fi

cleanup() {
	if lxc info "${verification_instance}" --project "${RUNNER_PROJECT}" >/dev/null 2>&1 &&
		[[ $(lxc config get "${verification_instance}" user.qorpera.acceptance_verifier --project "${RUNNER_PROJECT}" 2>/dev/null || true) == "${fingerprint}" ]]; then
		lxc delete "${verification_instance}" --project "${RUNNER_PROJECT}" --force >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT HUP INT TERM

tested_at=$(date --iso-8601=seconds)
{
	echo "clean-boot acceptance for image ${fingerprint} at ${tested_at}"
	echo "verification_instance=${verification_instance}"
	lxc init "${fingerprint}" "${verification_instance}" \
		--vm --project "${RUNNER_PROJECT}" \
		-p "${COMPUTER_PROFILE}" \
		-d root,size=80GiB \
		--config user.qorpera.acceptance_verifier="${fingerprint}"
	lxc start "${verification_instance}" --project "${RUNNER_PROJECT}"
} | tee "${evidence_path}"

guest_ready=false
for _attempt in $(seq 1 36); do
	if lxc exec "${verification_instance}" --project "${RUNNER_PROJECT}" -- /usr/bin/true >/dev/null 2>&1; then
		guest_ready=true
		break
	fi
	sleep 5
done
if [[ ${guest_ready} != true ]]; then
	echo "The verification guest agent never answered." >&2
	exit 1
fi
echo "guest_agent=ready" | tee -a "${evidence_path}"

base_image=$(lxc config get "${verification_instance}" volatile.base_image --project "${RUNNER_PROJECT}")
if [[ ${base_image} != "${fingerprint}" ]]; then
	echo "The verification VM did not boot from the accepted fingerprint." >&2
	exit 1
fi
echo "volatile.base_image=${base_image}" | tee -a "${evidence_path}"

marker=$(
	lxc exec "${verification_instance}" --project "${RUNNER_PROJECT}" -- \
		/usr/bin/cat /etc/qorpera/lxd-company-computer-image.json
)
if ! jq -e \
	--arg fingerprint "${guest_manifest}" \
	'.schema == "qorpera.lxd-company-computer-image/v1" and
	 .guest_package_manifest_sha256 == $fingerprint and
	 .desktop_stack == "xfce4-tigervnc-chrome" and
	 (.runner_package_manifest_sha256 | test("^[0-9a-f]{64}$"))' \
	<<<"${marker}" >/dev/null; then
	echo "The clean-boot image marker does not match the candidate contract." >&2
	exit 1
fi
echo "image_marker=$(jq -c . <<<"${marker}")" | tee -a "${evidence_path}"

for unit in \
	qorpera-company-computer-bootstrap.service \
	qorpera-company-computer-runner.service \
	qorpera-company-computer-screens.service; do
	state=$(
		lxc exec "${verification_instance}" --project "${RUNNER_PROJECT}" -- \
			/usr/bin/systemctl is-enabled "${unit}" 2>&1 || true
	)
	echo "${unit}=${state}" | tee -a "${evidence_path}"
	if [[ ${state} != disabled ]]; then
		echo "${unit} must be disabled in the immutable image." >&2
		exit 1
	fi
done

for path in \
	/usr/bin/google-chrome-stable \
	/usr/bin/Thunar \
	/usr/bin/xfce4-terminal \
	/usr/local/bin/qorpera-screen-session \
	/usr/local/bin/qorpera-files \
	/usr/local/bin/qorpera-terminal; do
	lxc exec "${verification_instance}" --project "${RUNNER_PROJECT}" -- /usr/bin/test -x "${path}"
	echo "${path}=executable" | tee -a "${evidence_path}"
done

failed_units=$(
	lxc exec "${verification_instance}" --project "${RUNNER_PROJECT}" -- \
		/usr/bin/systemctl --failed --no-legend --plain
)
if [[ -n ${failed_units} ]]; then
	echo "failed_systemd_units=${failed_units}" | tee -a "${evidence_path}"
	exit 1
fi
echo "failed_systemd_units=none" | tee -a "${evidence_path}"
echo "result=accepted" | tee -a "${evidence_path}"

cleanup
trap - EXIT HUP INT TERM
evidence_sha256=$(sha256sum "${evidence_path}" | awk '{ print $1 }')
echo "tested_at=${tested_at}"
echo "evidence_path=${evidence_path}"
echo "evidence_sha256=${evidence_sha256}"
echo "OP-C-DONE"
