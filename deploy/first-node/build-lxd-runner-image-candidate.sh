#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_BASE_FINGERPRINT="7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f"
EXPECTED_PACKAGE_MANIFEST_SHA256="90ead7bc3566994b40b588622c2009a3fcdd67fe29779ccdb9766fa2fa112abf"
EXPECTED_RUNNER_IMAGE="localhost/qorpera/sandbox-probe:96c2e17ec75cc0a1d5ed7a4e7c582ecd53ce2954@sha256:bc4b4543cd7c3a048188458eeab11bfa4b183aa1686b9c89fc012fc3e2c8987e"
STAGING_ROOT="/home/company41-admin/step2-lxd/lxd-runner-guest-v14"
LXD_POOL="qorpera-vm"
LXD_NETWORK="qorpera0"
LXD_BUILDER_PROJECT="default"
BUILDER_INSTANCE="qorpera-runner-image-build-v14"
IMAGE_ALIAS="qorpera-runner-ubuntu-26.04-v14-unsigned"
STATE_LOG="/var/log/qorpera-lxd-runner-image-candidate.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to build on unexpected host $(hostname)." >&2
	exit 1
fi
if [[ ! -f ${STAGING_ROOT}/manifest.json || -L ${STAGING_ROOT}/manifest.json ]]; then
	echo "The staged LXD runner guest package is missing." >&2
	exit 1
fi
if [[ $(sha256sum "${STAGING_ROOT}/manifest.json" | awk '{ print $1 }') != "${EXPECTED_PACKAGE_MANIFEST_SHA256}" ]]; then
	echo "The staged guest package manifest checksum does not match the candidate recipe." >&2
	exit 1
fi
PACKAGE_ROOT=${STAGING_ROOT} EXPECTED_RUNNER_IMAGE=${EXPECTED_RUNNER_IMAGE} node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = realpathSync(process.env.PACKAGE_ROOT);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (
  manifest.schema !== "qorpera.lxd-runner-guest-package/v1" ||
  manifest.runnerImage?.image !== process.env.EXPECTED_RUNNER_IMAGE ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("Staged guest package contract is invalid");
}
for (const artifact of manifest.artifacts) {
  const path = resolve(root, artifact.file);
  if (!path.startsWith(`${root}/`)) throw new Error("Guest package artifact escapes its root");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.bytes) {
    throw new Error(`Guest package artifact metadata is invalid: ${artifact.file}`);
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== artifact.sha256) throw new Error(`Guest package artifact checksum mismatch: ${artifact.file}`);
}
NODE
if lxc image info "${IMAGE_ALIAS}" --project "${LXD_BUILDER_PROJECT}" >/dev/null 2>&1; then
	echo "Refusing to replace existing local image alias ${IMAGE_ALIAS}." >&2
	exit 1
fi
if lxc info "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" >/dev/null 2>&1; then
	echo "Refusing to reuse existing builder instance ${BUILDER_INSTANCE}." >&2
	exit 1
fi
if [[ $(lxc config get core.https_address) != "" ]]; then
	echo "The LXD daemon unexpectedly exposes a remote listener." >&2
	exit 1
fi
if ! lxc image info "${EXPECTED_BASE_FINGERPRINT}" --project "${LXD_BUILDER_PROJECT}" >/dev/null 2>&1; then
	echo "The exact base image proven by verify-lxd-vm-boundary.sh is not present in the local image cache." >&2
	echo "Run the boundary verification again before building the candidate." >&2
	exit 1
fi

archive=$(mktemp --suffix=.tar.gz)
cleanup() {
	rm -f -- "${archive}"
	if lxc info "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" >/dev/null 2>&1 &&
		[[ $(lxc config get "${BUILDER_INSTANCE}" user.qorpera.image_builder --project "${LXD_BUILDER_PROJECT}" 2>/dev/null || true) == true ]]; then
		lxc delete "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" --force >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT HUP INT TERM

tar --create --gzip --file "${archive}" --directory "${STAGING_ROOT}" .
lxc init "${EXPECTED_BASE_FINGERPRINT}" "${BUILDER_INSTANCE}" \
	--project "${LXD_BUILDER_PROJECT}" \
	--vm \
	--storage "${LXD_POOL}" \
	--network "${LXD_NETWORK}" \
	--config boot.mode=uefi-secureboot \
	--config limits.cpu=4 \
	--config limits.memory=8GiB \
	--config user.qorpera.image_builder=true
lxc config device set "${BUILDER_INSTANCE}" root size=80GiB --project "${LXD_BUILDER_PROJECT}"
lxc start "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}"

guest_ready=false
for _attempt in $(seq 1 180); do
	if lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/cloud-init status --wait </dev/null >/dev/null 2>&1; then
		guest_ready=true
		break
	fi
	sleep 2
done
if [[ ${guest_ready} != true ]]; then
	echo "The image-builder guest did not become ready." >&2
	exit 1
fi

lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/install -d -o root -g root -m 0700 /root/qorpera-lxd-runner-guest </dev/null
lxc file push "${archive}" "${BUILDER_INSTANCE}/root/qorpera-lxd-runner-guest/package.tar.gz" --project "${LXD_BUILDER_PROJECT}"
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/tar \
	--extract --gzip --file /root/qorpera-lxd-runner-guest/package.tar.gz \
	--directory /root/qorpera-lxd-runner-guest </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/bash \
	/root/qorpera-lxd-runner-guest/install-image-contract.sh \
	/root/qorpera-lxd-runner-guest </dev/null

lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/rm -rf -- /root/qorpera-lxd-runner-guest </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/cloud-init clean --logs --machine-id </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/rm -f -- /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub \
	/etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
	/etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/sync </dev/null
lxc stop "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" --timeout 120

lxc publish "${BUILDER_INSTANCE}" \
	--project "${LXD_BUILDER_PROJECT}" \
	--alias "${IMAGE_ALIAS}" \
	description="Qorpera Step 2 Ubuntu 26.04 LXD runner candidate" \
	os=Ubuntu \
	release=26.04 \
	user.qorpera.schema=qorpera.lxd-runner-image/v1 \
	user.qorpera.guest_package_manifest_sha256="${EXPECTED_PACKAGE_MANIFEST_SHA256}" \
	user.qorpera.runner_image="${EXPECTED_RUNNER_IMAGE}" \
	user.qorpera.provenance=unsigned-candidate

fingerprint=$(lxc image info "${IMAGE_ALIAS}" --project "${LXD_BUILDER_PROJECT}" | awk '/^Fingerprint:/ { print $2 }')
if [[ ! ${fingerprint} =~ ^[0-9a-f]{64}$ ]]; then
	echo "LXD did not return a complete immutable image fingerprint." >&2
	exit 1
fi
lxc delete "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}"

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "base_fingerprint=${EXPECTED_BASE_FINGERPRINT}"
	echo "guest_package_manifest_sha256=${EXPECTED_PACKAGE_MANIFEST_SHA256}"
	echo "runner_image=${EXPECTED_RUNNER_IMAGE}"
	echo "image_alias=${IMAGE_ALIAS}"
	echo "image_project=${LXD_BUILDER_PROJECT}"
	echo "image_fingerprint=${fingerprint}"
	echo "provenance=unsigned-candidate"
} > "${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f -- "${state_tmp}"

trap - EXIT HUP INT TERM
rm -f -- "${archive}"
echo "LXD_RUNNER_IMAGE_CANDIDATE_READY_UNSIGNED"
echo "fingerprint=${fingerprint}"
echo "Do not enable the provider until this exact image has signed provenance and a clean-boot acceptance test."
