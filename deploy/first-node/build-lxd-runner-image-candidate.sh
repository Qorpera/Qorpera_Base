#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOSTNAME="company41-node-01"
EXPECTED_BASE_FINGERPRINT="5e644adaf5d1c43149ea7310ac2a7cad927fa6603343e8fa9070a9200a24b7b8"
EXPECTED_SOURCE_COMMIT="3a4b8b5c229d725b8ce6d47b27f0349b521f3839"
EXPECTED_PACKAGE_ARCHIVE_SHA256="86079a21785f1a60fc176a77c0b6a8f67dc940e455787b63d9d83e5dee0dc0e3"
EXPECTED_PACKAGE_MANIFEST_SHA256="5edcc95298dd82a6af203493c5610527498f03f907da6324bb69bb4fc6b18c5f"
EXPECTED_RUNNER_IMAGE="localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1"
PACKAGE_ARCHIVE="/home/company41-admin/step2-lxd/lxd-runner-guest-v55-secret-proof.tar.gz"
LXD_POOL="qorpera-vm"
LXD_NETWORK="qorpera0"
LXD_BUILDER_PROJECT="default"
BUILDER_INSTANCE="qorpera-runner-image-build-v55"
IMAGE_ALIAS="qorpera-runner-ubuntu-26.04-v55-secret-proof-unsigned"
STATE_LOG="/var/log/qorpera-lxd-runner-image-candidate-v55.txt"

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script through sudo." >&2
	exit 1
fi
if [[ $(hostname) != "${EXPECTED_HOSTNAME}" ]]; then
	echo "Refusing to build on unexpected host $(hostname)." >&2
	exit 1
fi
if [[ ! -f ${PACKAGE_ARCHIVE} || -L ${PACKAGE_ARCHIVE} ]]; then
	echo "The sealed LXD runner guest package archive is missing." >&2
	exit 1
fi
if [[ $(sha256sum "${PACKAGE_ARCHIVE}" | awk '{ print $1 }') != "${EXPECTED_PACKAGE_ARCHIVE_SHA256}" ]]; then
	echo "The sealed LXD runner guest package archive checksum does not match the candidate recipe." >&2
	exit 1
fi

package_root=$(mktemp -d /run/qorpera-lxd-runner-package.XXXXXX)
cleanup() {
	rm -rf -- "${package_root}"
	if lxc info "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" >/dev/null 2>&1 &&
		[[ $(lxc config get "${BUILDER_INSTANCE}" user.qorpera.image_builder --project "${LXD_BUILDER_PROJECT}" 2>/dev/null || true) == true ]]; then
		lxc delete "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" --force >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT HUP INT TERM
tar --extract --gzip --file "${PACKAGE_ARCHIVE}" --directory "${package_root}" --no-same-owner
if [[ ! -f ${package_root}/manifest.json || -L ${package_root}/manifest.json ]] ||
	[[ $(sha256sum "${package_root}/manifest.json" | awk '{ print $1 }') != "${EXPECTED_PACKAGE_MANIFEST_SHA256}" ]]; then
	echo "The staged guest package manifest checksum does not match the candidate recipe." >&2
	exit 1
fi
PACKAGE_ROOT=${package_root} EXPECTED_RUNNER_IMAGE=${EXPECTED_RUNNER_IMAGE} node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = realpathSync(process.env.PACKAGE_ROOT);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (
  manifest.schema !== "qorpera.lxd-runner-guest-package/v1" ||
  manifest.nativeCompany?.schema !== "qorpera.native-company-guest/v1" ||
  manifest.nativeCompany?.binarySha256 !== "2f2c26cfdfacebbcce848fb50cfaaa4e8d0aa3c6ec3c1009123ecf766c8335f7" ||
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

lxc init "${EXPECTED_BASE_FINGERPRINT}" "${BUILDER_INSTANCE}" \
	--project "${LXD_BUILDER_PROJECT}" \
	--vm \
	--storage "${LXD_POOL}" \
	--network "${LXD_NETWORK}" \
	--config boot.mode=uefi-secureboot \
	--config limits.cpu=4 \
	--config limits.memory=8GiB \
	--config user.qorpera.image_builder=true \
	--config user.qorpera.purpose=step2-v55-secret-proof
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
lxc file push "${PACKAGE_ARCHIVE}" "${BUILDER_INSTANCE}/root/qorpera-lxd-runner-guest/package.tar.gz" --project "${LXD_BUILDER_PROJECT}"
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
	description="Qorpera Runtime Step 2 integrated secret-custody proof candidate" \
	os=Ubuntu \
	release=26.04 \
	user.qorpera.schema=qorpera.lxd-runner-image/v1 \
	user.qorpera.source_commit="${EXPECTED_SOURCE_COMMIT}" \
	user.qorpera.guest_package_manifest_sha256="${EXPECTED_PACKAGE_MANIFEST_SHA256}" \
	user.qorpera.runner_image="${EXPECTED_RUNNER_IMAGE}" \
	user.qorpera.provenance=unsigned-candidate

fingerprint=$(lxc image info "${IMAGE_ALIAS}" --project "${LXD_BUILDER_PROJECT}" | awk '/^Fingerprint:/ { print $2 }')
if [[ ! ${fingerprint} =~ ^[0-9a-f]{64}$ ]]; then
	echo "LXD did not return a complete immutable image fingerprint." >&2
	exit 1
fi
lxc delete "${BUILDER_INSTANCE}" --project "${LXD_BUILDER_PROJECT}" --force

state_tmp=$(mktemp)
{
	echo "generated_at=$(date --iso-8601=seconds)"
	echo "hostname=$(hostname)"
	echo "base_fingerprint=${EXPECTED_BASE_FINGERPRINT}"
	echo "source_commit=${EXPECTED_SOURCE_COMMIT}"
	echo "package_archive_sha256=${EXPECTED_PACKAGE_ARCHIVE_SHA256}"
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
rm -rf -- "${package_root}"
echo "LXD_RUNNER_IMAGE_CANDIDATE_READY_UNSIGNED"
echo "fingerprint=${fingerprint}"
echo "Do not enable the provider until this exact image has signed provenance and a clean-boot acceptance test."
