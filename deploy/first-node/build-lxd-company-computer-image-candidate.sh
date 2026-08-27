#!/usr/bin/env bash
set -euo pipefail

# Builds the unsigned Company Computer image candidate from a staged guest
# package (scripts/package-lxd-company-computer-guest.mjs output), exactly
# like the runner image candidate: same proven Ubuntu base, same builder
# isolation, same publish-then-sign provenance cycle. The pinned manifest
# checksum below is enforced in lockstep by
# scripts/package-lxd-company-computer-guest.test.mjs.

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_BASE_FINGERPRINT="7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f"
EXPECTED_PACKAGE_MANIFEST_SHA256="1d6b7ec899e56c83674203ee5292c12d1e8af1bfcb38fe20f8aec8e7bf514821"
STAGING_ROOT="/home/company41-admin/step3-lxd/lxd-company-computer-guest-v1"
LXD_POOL="qorpera-vm"
LXD_NETWORK="qorpera0"
LXD_BUILDER_PROJECT="default"
BUILDER_INSTANCE="qorpera-company-computer-image-build-v2"
IMAGE_ALIAS="qorpera-company-computer-ubuntu-26.04-v2-unsigned"
STATE_LOG="/var/log/qorpera-lxd-company-computer-image-candidate.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to build on unexpected host $(hostname)." >&2
	exit 1
fi
if [[ ! -f ${STAGING_ROOT}/manifest.json || -L ${STAGING_ROOT}/manifest.json ]]; then
	echo "The staged Company Computer guest package is missing." >&2
	exit 1
fi
if [[ $(sha256sum "${STAGING_ROOT}/manifest.json" | awk '{ print $1 }') != "${EXPECTED_PACKAGE_MANIFEST_SHA256}" ]]; then
	echo "The staged guest package manifest checksum does not match the candidate recipe." >&2
	exit 1
fi
PACKAGE_ROOT=${STAGING_ROOT} node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = realpathSync(process.env.PACKAGE_ROOT);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (
  manifest.schema !== "qorpera.lxd-company-computer-guest-package/v1" ||
  !manifest.runnerPackage ||
  !/^[0-9a-f]{64}$/.test(manifest.runnerPackage.manifestSha256) ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("Staged guest package contract is invalid");
}
const runnerManifest = readFileSync(join(root, "runner/manifest.json"));
if (createHash("sha256").update(runnerManifest).digest("hex") !== manifest.runnerPackage.manifestSha256) {
  throw new Error("Staged nested runner package does not match the company manifest pin");
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

lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/install -d -o root -g root -m 0700 /root/qorpera-company-computer-guest </dev/null
lxc file push "${archive}" "${BUILDER_INSTANCE}/root/qorpera-company-computer-guest/package.tar.gz" --project "${LXD_BUILDER_PROJECT}"
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/tar \
	--extract --gzip --file /root/qorpera-company-computer-guest/package.tar.gz \
	--directory /root/qorpera-company-computer-guest </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/bash \
	/root/qorpera-company-computer-guest/install-image-contract.sh \
	/root/qorpera-company-computer-guest </dev/null

lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/rm -rf -- /root/qorpera-company-computer-guest </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/cloud-init clean --logs --machine-id </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/rm -f -- /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub \
	/etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
	/etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub </dev/null
lxc exec "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" -- /usr/bin/sync </dev/null
lxc stop "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" --timeout 120

lxc publish "${BUILDER_INSTANCE}" \
	--project "${LXD_BUILDER_PROJECT}" \
	--alias "${IMAGE_ALIAS}" \
	description="Qorpera Step 3 Ubuntu 26.04 Company Computer candidate" \
	os=Ubuntu \
	release=26.04 \
	user.qorpera.schema=qorpera.lxd-company-computer-image/v1 \
	user.qorpera.guest_package_manifest_sha256="${EXPECTED_PACKAGE_MANIFEST_SHA256}" \
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
	echo "image_alias=${IMAGE_ALIAS}"
	echo "image_project=${LXD_BUILDER_PROJECT}"
	echo "image_fingerprint=${fingerprint}"
	echo "provenance=unsigned-candidate"
} > "${state_tmp}"
install -o root -g root -m 0644 "${state_tmp}" "${STATE_LOG}"
rm -f -- "${state_tmp}"

trap - EXIT HUP INT TERM
rm -f -- "${archive}"
echo "LXD_COMPANY_COMPUTER_IMAGE_CANDIDATE_READY_UNSIGNED"
echo "fingerprint=${fingerprint}"
echo "Do not activate the provider against this image until it has signed provenance and a clean-boot acceptance test."
