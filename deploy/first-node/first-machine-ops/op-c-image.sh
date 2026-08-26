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

lxc delete -f qorpera-cc-verify --project qorpera-runners >/dev/null 2>&1 || true
{
	echo "clean-boot acceptance for image ${fp} at $(date --iso-8601=seconds)"
	# The profile carries only the NIC; the provider adds its own root disk,
	# so the verify instance declares one explicitly the same way.
	lxc init "${fp}" qorpera-cc-verify --vm --project qorpera-runners -p qorpera-company-computer-v1 2>&1
	lxc config device add qorpera-cc-verify root disk pool=qorpera-vm path=/ size=32GiB --project qorpera-runners 2>&1
	lxc start qorpera-cc-verify --project qorpera-runners 2>&1
} | tee /var/log/qorpera-cc-image-verify.log
for attempt in $(seq 1 36); do
	if lxc exec qorpera-cc-verify --project qorpera-runners -- /usr/bin/systemctl is-enabled \
		qorpera-company-computer-bootstrap.service qorpera-company-computer-runner.service \
		qorpera-company-computer-sync.service qorpera-company-computer-screens.service \
		2>&1 | tee -a /var/log/qorpera-cc-image-verify.log; then
		break
	fi
	if [[ ${attempt} -eq 36 ]]; then echo "guest agent never answered" >&2; exit 1; fi
	sleep 5
done
lxc delete -f qorpera-cc-verify --project qorpera-runners
sed -i "s|REPLACE_AFTER_IMAGE_SIGNING|${fp}|; s|3f142af55d20862413dc03143a384d8329802b732d03549fa2fbd760fcfcb89f|acd2cd013361a66fdd56e61b30ecaa3807c8da0610db33ba48b3c6a660fbb1f0|" /etc/qorpera/lxd-company-provider.env
echo "evidence sha256: $(sha256sum /var/log/qorpera-cc-image-verify.log | cut -d' ' -f1)"
echo "OP-C-DONE"
