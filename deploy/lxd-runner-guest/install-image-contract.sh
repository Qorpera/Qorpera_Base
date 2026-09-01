#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${1:-}
NATIVE_EXECUTION_GROUP="qorpera-native-execution"
NATIVE_EXECUTION_GID=42041
RUNNER_USER="qorpera-runner"
NATIVE_USER="qorpera-native-provider"
SUBID_START=200000
SUBID_COUNT=65536

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this installer as root inside the image-builder VM." >&2
	exit 1
fi
if [[ -z ${PACKAGE_ROOT} || ${PACKAGE_ROOT} != /* || ! -d ${PACKAGE_ROOT} || -L ${PACKAGE_ROOT} ]]; then
	echo "An absolute physical guest-package directory is required." >&2
	exit 1
fi
if ! grep -q '^VERSION_ID="26.04"$' /etc/os-release; then
	echo "The LXD runner image contract is pinned to Ubuntu 26.04." >&2
	exit 1
fi
if [[ $(uname -m) != x86_64 ]]; then
	echo "The first-node LXD runner image is pinned to x86_64." >&2
	exit 1
fi

# Failed executions must keep their service journals for post-mortem review;
# the default volatile journal loses the evidence with the guest.
install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=256M\n' > /etc/systemd/journald.conf.d/qorpera-persistent.conf

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates crun dbus-user-session fuse-overlayfs git nodejs npm podman slirp4netns uidmap

node_version=$(node --version | sed 's/^v//')
if ! dpkg --compare-versions "${node_version}" ge 22.19.0; then
	echo "Node.js ${node_version} is older than the guest minimum." >&2
	exit 1
fi
podman_version=$(podman --version | awk '{ print $3 }')
if ! dpkg --compare-versions "${podman_version}" ge 5.0.0; then
	echo "Podman ${podman_version} is older than the guest minimum." >&2
	exit 1
fi
if [[ ! -x /usr/bin/crun ]]; then
	echo "The pinned rootless Podman OCI runtime is unavailable." >&2
	exit 1
fi
if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
	echo "The image builder is not running with cgroups v2." >&2
	exit 1
fi

PACKAGE_ROOT=${PACKAGE_ROOT} node <<'NODE'
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");

const root = realpathSync(process.env.PACKAGE_ROOT);
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schema !== "qorpera.lxd-runner-guest-package/v1" || !Array.isArray(manifest.artifacts)) {
  throw new Error("Guest package manifest is invalid");
}
const runnerImage = manifest.runnerImage;
if (
  !runnerImage ||
  runnerImage.schema !== "qorpera.ephemeral-runner-image-contract/v1" ||
  !/^[0-9a-f]{40}$/.test(runnerImage.source_commit) ||
  !/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(runnerImage.base_image) ||
  !/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(runnerImage.image) ||
  !runnerImage.archive ||
  !runnerImage.cosign_bundle ||
  runnerImage.archive.file !== "runner-image/qorpera-sandbox-probe.oci.tar" ||
  runnerImage.cosign_bundle.file !== "runner-image/qorpera-sandbox-probe.cosign-bundle.json" ||
  !Number.isSafeInteger(runnerImage.archive.bytes) ||
  !Number.isSafeInteger(runnerImage.cosign_bundle.bytes) ||
  !/^[0-9a-f]{64}$/.test(runnerImage.archive.sha256) ||
  !/^[0-9a-f]{64}$/.test(runnerImage.cosign_bundle.sha256) ||
  runnerImage.cosign_bundle.workflow_sha !== runnerImage.source_commit ||
  runnerImage.cosign_bundle.workflow_trigger !== "workflow_dispatch" ||
  runnerImage.cosign_bundle.certificate_oidc_issuer !== "https://token.actions.githubusercontent.com" ||
  runnerImage.cosign_bundle.certificate_identity !==
    `https://github.com/Qorpera/Qorpera_Base/.github/workflows/ephemeral-runner-linux.yml@refs/heads/codex/step2-first-node`
) {
  throw new Error("Runner image contract is invalid");
}
const expected = new Set([
	"company-lock-heartbeat.mjs",
	"harness/package-lock.json",
  "harness/package.json",
  "install-image-contract.sh",
  "qorpera-company-runner.service",
  "qorpera-ephemeral-runner.mjs",
  "qorpera-ephemeral-runner.service",
  "qorpera-lxd-runner-bootstrap.mjs",
  "qorpera-lxd-runner-bootstrap.service",
  "qorpera-lxd-native-login-bootstrap.mjs",
  "qorpera-lxd-native-login-bootstrap.service",
  "qorpera-native-provider-host.mjs",
  "qorpera-native-provider-host.service",
  "qorpera-native-company-host.service",
  "runner-image/contract.json",
  "runner-image/qorpera-sandbox-probe.cosign-bundle.json",
  "runner-image/qorpera-sandbox-probe.oci.tar",
  "qorpera-sandbox-probe.mjs",
  "run-job",
]);
if (manifest.nativeCompany) {
  const native = manifest.nativeCompany;
  const artifactMetadata = lstatSync(join(root, "native-company/artifact.json"));
  if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink() || artifactMetadata.size > 65536) {
    throw new Error("Governed native artifact metadata is unsafe");
  }
  const artifact = JSON.parse(readFileSync(join(root, "native-company/artifact.json"), "utf8"));
  if (native.schema !== "qorpera.native-company-guest/v1" ||
      native.binaryPath !== "/opt/qorpera-harnesses/native-company/codex" ||
      native.target !== "x86_64-unknown-linux-gnu" || native.profile !== "release" ||
      !/^[0-9a-f]{64}$/.test(native.binarySha256) ||
      artifact.schema !== "qorpera.native-codex-artifact/v1" ||
      artifact.artifact?.file !== "codex" || artifact.artifact.sha256 !== native.binarySha256 ||
      artifact.artifact.target !== native.target || artifact.artifact.profile !== "release" ||
      artifact.source?.commit !== native.sourceCommit || artifact.source?.patchSha256 !== native.patchSha256) {
    throw new Error("Governed native company image contract is invalid");
  }
  for (const name of ["codex", "artifact.json", "LICENSE", "NOTICE"]) expected.add(`native-company/${name}`);
}
for (const artifact of manifest.artifacts) {
  if (!artifact || typeof artifact.file !== "string" || !expected.delete(artifact.file)) {
    throw new Error("Guest package contains an unexpected artifact");
  }
  const path = resolve(root, artifact.file);
  if (!path.startsWith(`${root}/`) || basename(path) === "manifest.json") {
    throw new Error("Guest package artifact escapes its root");
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.bytes) {
    throw new Error("Guest package artifact metadata is invalid");
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== artifact.sha256) throw new Error("Guest package artifact checksum mismatch");
}
if (expected.size !== 0) throw new Error("Guest package is incomplete");
if (manifest.nativeCompany && manifest.artifacts.find((item) => item.file === "native-company/codex")?.sha256 !== manifest.nativeCompany.binarySha256) {
  throw new Error("Governed native binary pin does not match packaged bytes");
}
NODE

if getent group "${NATIVE_EXECUTION_GROUP}" >/dev/null; then
	if [[ $(getent group "${NATIVE_EXECUTION_GROUP}" | cut -d: -f3) != "${NATIVE_EXECUTION_GID}" ]]; then
		echo "The native execution group has an unexpected GID." >&2
		exit 1
	fi
else
	groupadd --system --gid "${NATIVE_EXECUTION_GID}" "${NATIVE_EXECUTION_GROUP}"
fi

if ! getent passwd "${RUNNER_USER}" >/dev/null; then
	useradd --system --create-home --home-dir /var/lib/qorpera-runner --shell /usr/sbin/nologin --user-group "${RUNNER_USER}"
fi
if ! getent passwd "${NATIVE_USER}" >/dev/null; then
	useradd --system --create-home --home-dir /var/lib/qorpera-native-provider --shell /usr/sbin/nologin \
		--gid "${NATIVE_EXECUTION_GROUP}" "${NATIVE_USER}"
fi
if [[ $(getent passwd "${RUNNER_USER}" | cut -d: -f6) != /var/lib/qorpera-runner ]] ||
	[[ $(getent passwd "${NATIVE_USER}" | cut -d: -f6) != /var/lib/qorpera-native-provider ]] ||
	[[ $(id -g "${NATIVE_USER}") != "${NATIVE_EXECUTION_GID}" ]]; then
	echo "The guest service accounts do not match the image contract." >&2
	exit 1
fi
usermod -aG "${NATIVE_EXECUTION_GROUP}" "${RUNNER_USER}"

# Governed execution never joins the NAS sharing group or the legacy
# cross-process workspace group. These accounts are private to the new lane.
for company_account in qorpera-company-runner qorpera-native-company; do
	if ! getent passwd "${company_account}" >/dev/null; then
		useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "${company_account}"
	fi
	if [[ $(id -Gn "${company_account}") != "${company_account}" ]]; then
		echo "A governed service account has unexpected supplementary groups." >&2
		exit 1
	fi
done

subid_end=$((SUBID_START + SUBID_COUNT - 1))
for subid_file in /etc/subuid /etc/subgid; do
	if awk -F: -v account="${RUNNER_USER}" -v first="${SUBID_START}" -v last="${subid_end}" '
		$1 != account && $2 <= last && ($2 + $3 - 1) >= first { exit 1 }
	' "${subid_file}"; then
		:
	else
		echo "The fixed rootless Podman subordinate-ID range is already allocated." >&2
		exit 1
	fi
done
if grep -q "^${RUNNER_USER}:" /etc/subuid; then
	[[ $(grep "^${RUNNER_USER}:" /etc/subuid) == "${RUNNER_USER}:${SUBID_START}:${SUBID_COUNT}" ]]
else
	usermod --add-subuids "${SUBID_START}-${subid_end}" "${RUNNER_USER}"
fi
if grep -q "^${RUNNER_USER}:" /etc/subgid; then
	[[ $(grep "^${RUNNER_USER}:" /etc/subgid) == "${RUNNER_USER}:${SUBID_START}:${SUBID_COUNT}" ]]
else
	usermod --add-subgids "${SUBID_START}-${subid_end}" "${RUNNER_USER}"
fi

install -d -o root -g root -m 0755 /opt/qorpera-runner /opt/qorpera-harnesses /etc/qorpera
install -d -o root -g root -m 0700 /var/lib/qorpera-bootstrap /var/lib/qorpera-bootstrap/credentials
install -d -o root -g root -m 0700 /var/lib/qorpera /var/lib/qorpera/identity
install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" -m 0700 \
	/var/lib/qorpera-runner /var/lib/qorpera-native-workspace /run/qorpera-runner
install -d -o "${NATIVE_USER}" -g "${NATIVE_EXECUTION_GROUP}" -m 0700 \
	/var/lib/qorpera-native-provider /var/lib/qorpera-native-provider/tmp

for artifact in \
	company-lock-heartbeat.mjs \
	qorpera-ephemeral-runner.mjs \
	qorpera-native-provider-host.mjs \
	qorpera-lxd-runner-bootstrap.mjs \
	qorpera-lxd-native-login-bootstrap.mjs; do
	install -o root -g root -m 0555 "${PACKAGE_ROOT}/${artifact}" "/opt/qorpera-runner/${artifact}"
	node --check "/opt/qorpera-runner/${artifact}"
done
for unit in \
	qorpera-company-runner.service \
	qorpera-native-company-host.service \
	qorpera-ephemeral-runner.service \
	qorpera-native-provider-host.service \
	qorpera-lxd-runner-bootstrap.service \
	qorpera-lxd-native-login-bootstrap.service; do
	install -o root -g root -m 0644 "${PACKAGE_ROOT}/${unit}" "/etc/systemd/system/${unit}"
done

install -o root -g root -m 0644 "${PACKAGE_ROOT}/harness/package.json" /opt/qorpera-harnesses/package.json
install -o root -g root -m 0644 "${PACKAGE_ROOT}/harness/package-lock.json" /opt/qorpera-harnesses/package-lock.json
npm ci --prefix /opt/qorpera-harnesses --ignore-scripts --include=optional --omit=dev
ln -sfn /opt/qorpera-harnesses/node_modules/.bin/codex /usr/local/bin/codex
ln -sfn /opt/qorpera-harnesses/node_modules/@anthropic-ai/claude-code-linux-x64/claude /usr/local/bin/claude

codex_version=$(DISABLE_AUTOUPDATER=1 /usr/local/bin/codex --version)
claude_version=$(DISABLE_AUTOUPDATER=1 /usr/local/bin/claude --version)
if [[ ${codex_version} != *"0.147.0"* || ${claude_version} != 2.1.231* ]]; then
	echo "The installed native harness versions do not match their package lock." >&2
	exit 1
fi

native_company_enabled=$(PACKAGE_ROOT=${PACKAGE_ROOT} node -e '
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
process.stdout.write(JSON.parse(readFileSync(join(process.env.PACKAGE_ROOT, "manifest.json"), "utf8")).nativeCompany ? "yes" : "no");
')
if [[ ${native_company_enabled} == yes ]]; then
	install -d -o root -g root -m 0755 /opt/qorpera-harnesses/native-company
	install -o root -g root -m 0555 "${PACKAGE_ROOT}/native-company/codex" /opt/qorpera-harnesses/native-company/codex
	for native_file in artifact.json LICENSE NOTICE; do
		install -o root -g root -m 0444 "${PACKAGE_ROOT}/native-company/${native_file}" "/opt/qorpera-harnesses/native-company/${native_file}"
	done
fi

runner_image=$(PACKAGE_ROOT=${PACKAGE_ROOT} node -e '
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const contract = JSON.parse(readFileSync(join(process.env.PACKAGE_ROOT, "runner-image/contract.json"), "utf8"));
process.stdout.write(contract.image);
')
if ! /usr/bin/cat "${PACKAGE_ROOT}/runner-image/qorpera-sandbox-probe.oci.tar" | (
	cd /var/lib/qorpera-runner
	runuser -u "${RUNNER_USER}" -- env \
		HOME=/var/lib/qorpera-runner \
		XDG_RUNTIME_DIR=/run/qorpera-runner \
		/usr/bin/podman load
); then
	echo "The signed runner image archive could not be loaded by the runner account." >&2
	exit 1
fi
if ! (
	cd /var/lib/qorpera-runner
	runuser -u "${RUNNER_USER}" -- env \
		HOME=/var/lib/qorpera-runner \
		XDG_RUNTIME_DIR=/run/qorpera-runner \
		/usr/bin/podman info >/dev/null
); then
	echo "Rootless Podman cannot initialize its pinned OCI runtime." >&2
	exit 1
fi
if ! (
	cd /var/lib/qorpera-runner
	runuser -u "${RUNNER_USER}" -- env \
		HOME=/var/lib/qorpera-runner \
		XDG_RUNTIME_DIR=/run/qorpera-runner \
		/usr/bin/podman image exists "${runner_image}"
); then
	echo "The signed runner image archive did not load under its immutable digest." >&2
	exit 1
fi
if [[ -e /var/lib/qorpera-runner/.config/containers/auth.json ]]; then
	echo "The published guest image would contain a registry credential." >&2
	exit 1
fi
install -o root -g root -m 0644 \
	"${PACKAGE_ROOT}/runner-image/contract.json" /etc/qorpera/ephemeral-runner-image.json
install -o root -g root -m 0644 \
	"${PACKAGE_ROOT}/runner-image/qorpera-sandbox-probe.cosign-bundle.json" \
	/etc/qorpera/ephemeral-runner-image.cosign-bundle.json

systemd-analyze verify \
	/etc/systemd/system/qorpera-company-runner.service \
	/etc/systemd/system/qorpera-native-company-host.service \
	/etc/systemd/system/qorpera-ephemeral-runner.service \
	/etc/systemd/system/qorpera-native-provider-host.service \
	/etc/systemd/system/qorpera-lxd-runner-bootstrap.service \
	/etc/systemd/system/qorpera-lxd-native-login-bootstrap.service
systemctl daemon-reload
systemctl disable \
	qorpera-company-runner.service \
	qorpera-native-company-host.service \
	qorpera-ephemeral-runner.service \
	qorpera-native-provider-host.service \
	qorpera-lxd-native-login-bootstrap.service \
	>/dev/null 2>&1 || true
systemctl enable qorpera-lxd-runner-bootstrap.service

manifest_sha256=$(sha256sum "${PACKAGE_ROOT}/manifest.json" | awk '{ print $1 }')
printf '%s\n' \
	'{' \
	'  "schema": "qorpera.lxd-runner-image/v1",' \
	'  "ubuntu_version": "26.04",' \
	'  "architecture": "x86_64",' \
	"  \"guest_package_manifest_sha256\": \"${manifest_sha256}\"," \
	"  \"node_version\": \"${node_version}\"," \
	"  \"podman_version\": \"${podman_version}\"," \
	'  "codex_version": "0.147.0",' \
	'  "claude_code_version": "2.1.231",' \
	"  \"runner_image\": \"${runner_image}\"," \
	"  \"native_execution_gid\": ${NATIVE_EXECUTION_GID}" \
	'}' > /etc/qorpera/lxd-runner-image.json
chmod 0644 /etc/qorpera/lxd-runner-image.json

if find /var/lib/qorpera-bootstrap -mindepth 1 -type f -print -quit | grep -q .; then
	echo "The published image would contain guest bootstrap secrets." >&2
	exit 1
fi
echo "LXD_RUNNER_IMAGE_CONTRACT_INSTALLED"
