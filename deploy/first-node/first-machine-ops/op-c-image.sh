#!/usr/bin/env bash
set -euo pipefail
# Step 3 first machine — operator round C: adopt the freshly built image
# (fingerprint read from the build's state log), create the profile, run the
# clean-boot acceptance, record evidence.
if [[ ${EUID} -ne 0 ]]; then echo "Run through sudo." >&2; exit 1; fi

fp=$(awk -F= '/^image_fingerprint=/ { print $2 }' /var/log/qorpera-lxd-company-computer-image-candidate.txt)
if [[ ! ${fp} =~ ^[0-9a-f]{64}$ ]]; then echo "No image fingerprint in the build state log." >&2; exit 1; fi
echo "image fingerprint: ${fp}"

if ! lxc image info "${fp}" --project qorpera-runners >/dev/null 2>&1; then
	lxc image copy "local:${fp}" local: --project default --target-project qorpera-runners
fi
if ! lxc profile show qorpera-company-computer-v1 --project qorpera-runners >/dev/null 2>&1; then
	lxc profile create qorpera-company-computer-v1 --project qorpera-runners
fi
if ! lxc profile device get qorpera-company-computer-v1 eth0 network --project qorpera-runners >/dev/null 2>&1; then
	lxc profile device add qorpera-company-computer-v1 eth0 nic network=qorpera0 name=enp5s0 --project qorpera-runners
fi
if ! lxc profile device get qorpera-company-computer-v1 root pool --project qorpera-runners >/dev/null 2>&1; then
	lxc profile device add qorpera-company-computer-v1 root disk pool=qorpera-vm path=/ --project qorpera-runners
fi

lxc delete -f qorpera-cc-verify --project qorpera-runners >/dev/null 2>&1 || true
{
	echo "clean-boot acceptance for image ${fp} at $(date --iso-8601=seconds)"
	# Override the profile root size during creation so LXD never attempts to
	# import the 80 GiB image into the profile's smaller default volume.
	lxc init "${fp}" qorpera-cc-verify --vm --project qorpera-runners \
		-p qorpera-company-computer-v1 -d root,size=80GiB 2>&1
	lxc start qorpera-cc-verify --project qorpera-runners 2>&1
} | tee /var/log/qorpera-cc-image-verify.log
for attempt in $(seq 1 36); do
	if lxc exec qorpera-cc-verify --project qorpera-runners -- /usr/bin/true >/dev/null 2>&1; then
		break
	fi
	if [[ ${attempt} -eq 36 ]]; then echo "guest agent never answered" >&2; exit 1; fi
	sleep 5
done
for unit in \
	qorpera-company-computer-bootstrap.service \
	qorpera-company-computer-runner.service \
	qorpera-company-computer-sync.service \
	qorpera-company-computer-screens.service; do
	state=$(lxc exec qorpera-cc-verify --project qorpera-runners -- \
		/usr/bin/systemctl is-enabled "${unit}" 2>&1 || true)
	echo "${unit}: ${state}" | tee -a /var/log/qorpera-cc-image-verify.log
	if [[ ${state} != disabled ]]; then
		echo "${unit} must be disabled in the immutable image" >&2
		exit 1
	fi
done
lxc delete -f qorpera-cc-verify --project qorpera-runners
sed -i -E \
	"s|^QORPERA_LXD_IMAGE_FINGERPRINT=.*$|QORPERA_LXD_IMAGE_FINGERPRINT=${fp}|; s|^QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=.*$|QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=93d06dc159d162e0bb50d433000b51f32aa44f616ea42ebeb5c6f4f2db0bb3a9|" \
	/etc/qorpera/lxd-company-provider.env
echo "evidence sha256: $(sha256sum /var/log/qorpera-cc-image-verify.log | cut -d' ' -f1)"
echo "OP-C-DONE"
