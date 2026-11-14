#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${1:-}
NATIVE_EXECUTION_GROUP="qorpera-native-execution"
NATIVE_EXECUTION_GID=42041
RUNNER_USER="qorpera-runner"
NATIVE_USER="qorpera-native-provider"
# The Claude Code box's group: the run host accounts that may start the box's namespace helper (slice C2).
CLAUDE_BOX_GROUP="qorpera-claude-box"
SUBID_START=200000
SUBID_COUNT=65536
SELF_UPDATE_UNITS=(apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service)

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

# The published image must never update itself. Its apt timers are Persistent=
# and keep this build's stamps, so on every fresh boot apt-daily-upgrade catches
# up about 30 s in: unattended-upgrades then restarts the runner and native host
# through needrestart, cancelling the turn, and its shutdown inhibitor refuses
# the VM's poweroff. Mask the five units before this build installs anything.
# The guest bootstraps refuse (RUNNER_IMAGE_SELF_UPDATE_ENABLED) unless all five
# are links to /dev/null. Masking first means no timer can start a job after the
# check below; a job already running (a oneshot is "activating") is refused.
systemctl mask "${SELF_UPDATE_UNITS[@]}"
for unit in apt-daily.service apt-daily-upgrade.service; do
	state=$(systemctl show --property=ActiveState --value "${unit}")
	if [[ ${state} != inactive && ${state} != failed ]]; then
		echo "A package update (${unit}) is running in the image builder; let it finish, then rerun." >&2
		exit 1
	fi
done
systemctl stop apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service >/dev/null 2>&1 || true

# Failed executions must keep their service journals for post-mortem review;
# the default volatile journal loses the evidence with the guest.
install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=256M\n' > /etc/systemd/journald.conf.d/qorpera-persistent.conf

export DEBIAN_FRONTEND=noninteractive
apt-get update
# sshfs (with fuse3) mounts an agent's home for the Claude Code box, in the run's own namespace (slice C2).
apt-get install --yes bubblewrap ca-certificates crun dbus-user-session fuse-overlayfs git nodejs npm podman slirp4netns sshfs uidmap

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
  "qorpera-identity-recovery-restore.mjs",
  "qorpera-native-isolation-child.mjs",
  "qorpera-native-login-provider-host.service",
  "qorpera-native-provider-host.service",
  "qorpera-native-company-host.service",
  "runner-image/contract.json",
  "runner-image/qorpera-sandbox-probe.cosign-bundle.json",
  "runner-image/qorpera-sandbox-probe.oci.tar",
  "qorpera-sandbox-probe.mjs",
  "run-job",
  "qorpera-claude-home-shell.mjs",
  "qorpera-claude-box-stage.sh",
  "qorpera-claude-box-ns.apparmor",
  "native-claude/artifact.json",
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
# Nobody joins it here: the shared execution package adds each slot's host account (install-shared-execution-guest.sh).
getent group "${CLAUDE_BOX_GROUP}" >/dev/null || groupadd --system "${CLAUDE_BOX_GROUP}"

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
	qorpera-ephemeral-runner.mjs \
	qorpera-native-provider-host.mjs \
	qorpera-identity-recovery-restore.mjs \
	qorpera-native-isolation-child.mjs \
	qorpera-lxd-runner-bootstrap.mjs \
	qorpera-lxd-native-login-bootstrap.mjs \
	qorpera-claude-home-shell.mjs; do
	install -o root -g root -m 0555 "${PACKAGE_ROOT}/${artifact}" "/opt/qorpera-runner/${artifact}"
	node --check "/opt/qorpera-runner/${artifact}"
done
for unit in \
	qorpera-company-runner.service \
	qorpera-native-company-host.service \
	qorpera-ephemeral-runner.service \
	qorpera-native-login-provider-host.service \
	qorpera-native-provider-host.service \
	qorpera-lxd-runner-bootstrap.service \
	qorpera-lxd-native-login-bootstrap.service; do
	install -o root -g root -m 0644 "${PACKAGE_ROOT}/${unit}" "/etc/systemd/system/${unit}"
done

install -o root -g root -m 0644 "${PACKAGE_ROOT}/harness/package.json" /opt/qorpera-harnesses/package.json
install -o root -g root -m 0644 "${PACKAGE_ROOT}/harness/package-lock.json" /opt/qorpera-harnesses/package-lock.json
npm ci --prefix /opt/qorpera-harnesses --ignore-scripts --include=optional --omit=dev
ln -sfn /opt/qorpera-harnesses/node_modules/.bin/codex /usr/local/bin/codex

codex_version=$(DISABLE_AUTOUPDATER=1 /usr/local/bin/codex --version)
if [[ ${codex_version} != *"0.147.0"* ]]; then
	echo "The installed native harness versions do not match their package lock." >&2
	exit 1
fi

# One Claude Code on the image: the unmodified build native-claude/artifact.json pins (never older than 2.1.311),
# fetched by its npm integrity, checked by size and sha-256, root's and read-only. The Claude Code box runs it
# (CLAUDE_BOX_CONFIGURATION.binary in packages/runtime/src/cloud-claude-box.ts); /usr/local/bin/claude, which the
# node's own Claude sign-in path names (QORPERA_CLAUDE_PATH), is a link to the same file.
CLAUDE_DIR=/opt/qorpera-harnesses/native-claude
install -d -o root -g root -m 0755 "${CLAUDE_DIR}"
claude_fetch=$(mktemp -d /root/qorpera-native-claude.XXXXXX)
claude_version=$(PACKAGE_ROOT=${PACKAGE_ROOT} FETCH_ROOT=${claude_fetch} node <<'NODE'
const { createHash } = require("node:crypto");
const { createWriteStream, lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const metadata = lstatSync(join(process.env.PACKAGE_ROOT, "native-claude/artifact.json"));
if (!metadata.isFile() || metadata.size > 65536) throw new Error("Claude Code pin metadata is unsafe");
const pin = JSON.parse(readFileSync(join(process.env.PACKAGE_ROOT, "native-claude/artifact.json"), "utf8"));
const version = (text) => (/^\d+\.\d+\.\d+$/.test(text ?? "") ? text.split(".").map(Number) : undefined);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const current = version(pin.source?.version);
const minimum = version(pin.minimumVersion);
if (pin.schema !== "qorpera.native-claude-artifact/v1" || !current || !minimum || compare(minimum, [2, 1, 311]) < 0 ||
    compare(current, minimum) < 0 || pin.source.package !== "@anthropic-ai/claude-code-linux-x64" ||
    pin.source.tarball !== `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${pin.source.version}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.source.integrity) || !Number.isSafeInteger(pin.source.tarballBytes) ||
    pin.artifact?.path !== "package/claude" || !Number.isSafeInteger(pin.artifact.bytes) ||
    !/^[0-9a-f]{64}$/.test(pin.artifact.sha256) || pin.artifact.modified !== false) {
  throw new Error("Claude Code pin is invalid");
}
(async () => {
  const response = await fetch(pin.source.tarball, { redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Claude Code tarball fetch failed: ${response.status}`);
  const digest = createHash("sha512");
  let bytes = 0;
  const count = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > pin.source.tarballBytes) return done(new Error("Claude Code tarball is larger than its pin"));
      digest.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), count, createWriteStream(join(process.env.FETCH_ROOT, "claude.tgz"), { flags: "wx", mode: 0o600 }));
  if (bytes !== pin.source.tarballBytes || `sha512-${digest.digest("base64")}` !== pin.source.integrity) {
    throw new Error("Claude Code tarball does not match its npm integrity");
  }
  process.stdout.write(pin.source.version);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
)
tar --extract --gzip --file "${claude_fetch}/claude.tgz" --directory "${claude_fetch}" --no-same-owner package/claude
install -o root -g root -m 0555 "${claude_fetch}/package/claude" "${CLAUDE_DIR}/claude"
install -o root -g root -m 0444 "${PACKAGE_ROOT}/native-claude/artifact.json" "${CLAUDE_DIR}/artifact.json"
rm -rf -- "${claude_fetch}"
ln -sfn "${CLAUDE_DIR}/claude" /usr/local/bin/claude

# The rest of the box's parts: its mount stage, its shell prefix (installed with the runtime above), and its namespace
# helper, a copy of util-linux unshare that root and the box's group alone may run, with the AppArmor profile that lets
# it make a user namespace with its capabilities (Ubuntu denies that to every other unprivileged program). The
# profile is in /etc/apparmor.d, so apparmor.service loads it at every boot; it is loaded now for the checks below.
install -o root -g root -m 0555 "${PACKAGE_ROOT}/qorpera-claude-box-stage.sh" /opt/qorpera-runner/qorpera-claude-box-stage.sh
bash -n /opt/qorpera-runner/qorpera-claude-box-stage.sh
install -o root -g "${CLAUDE_BOX_GROUP}" -m 0750 /usr/bin/unshare /opt/qorpera-runner/qorpera-claude-box-ns
install -o root -g root -m 0644 "${PACKAGE_ROOT}/qorpera-claude-box-ns.apparmor" /etc/apparmor.d/qorpera-claude-box-ns
apparmor_parser --replace --write-cache /etc/apparmor.d/qorpera-claude-box-ns

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
	/etc/systemd/system/qorpera-native-login-provider-host.service \
	/etc/systemd/system/qorpera-native-provider-host.service \
	/etc/systemd/system/qorpera-lxd-runner-bootstrap.service \
	/etc/systemd/system/qorpera-lxd-native-login-bootstrap.service
systemctl daemon-reload
systemctl disable \
	qorpera-company-runner.service \
	qorpera-native-company-host.service \
	qorpera-ephemeral-runner.service \
	qorpera-native-login-provider-host.service \
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
	"  \"claude_code_version\": \"${claude_version}\"," \
	"  \"runner_image\": \"${runner_image}\"," \
	"  \"native_execution_gid\": ${NATIVE_EXECUTION_GID}" \
	'}' > /etc/qorpera/lxd-runner-image.json
chmod 0644 /etc/qorpera/lxd-runner-image.json

# The Claude Code box's parts, checked as the image will hold them (a later image that loses one fails here).
# --- the Claude Code box's checks: begin
claude_box_refuse() {
	echo "The Claude Code box's parts do not match the image contract: $1" >&2
	exit 1
}
for part in "${CLAUDE_DIR}/claude:0:0:555" "${CLAUDE_DIR}/artifact.json:0:0:444" \
	/opt/qorpera-runner/qorpera-claude-box-stage.sh:0:0:555 /opt/qorpera-runner/qorpera-claude-home-shell.mjs:0:0:555 \
	"/opt/qorpera-runner/qorpera-claude-box-ns:0:$(getent group "${CLAUDE_BOX_GROUP}" | cut -d: -f3):750" \
	/etc/apparmor.d/qorpera-claude-box-ns:0:0:644 /usr/bin/sshfs:0:0:755 /usr/bin/bwrap:0:0:755 /usr/bin/node:0:0:755; do
	path=${part%%:*}
	# Each folder above the part is root's and no one else may write it (the runtime's rootOwnedFile, at start).
	[[ ! -L ${path} && -f ${path} && $(stat -c "%u:%g:%a:%h" "${path}") == "${part#*:}:1" ]] || claude_box_refuse "${path}"
	folder=$(dirname "${path}")
	while true; do
		[[ ! -L ${folder} && $(stat -c %u "${folder}") == 0 && $((0$(stat -c %a "${folder}") & 022)) == 0 ]] ||
			claude_box_refuse "${folder}"
		[[ ${folder} == / ]] && break
		folder=$(dirname "${folder}")
	done
done
cmp -s /usr/bin/unshare /opt/qorpera-runner/qorpera-claude-box-ns || claude_box_refuse "the namespace helper is not util-linux unshare"
CLAUDE_DIR=${CLAUDE_DIR} node -e '
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const pin = JSON.parse(readFileSync(`${process.env.CLAUDE_DIR}/artifact.json`, "utf8")).artifact;
const binary = `${process.env.CLAUDE_DIR}/claude`;
if (statSync(binary).size !== pin.bytes || createHash("sha256").update(readFileSync(binary)).digest("hex") !== pin.sha256) process.exit(1);
' || claude_box_refuse "Claude Code is not the pinned build"
[[ $(readlink -f /usr/local/bin/claude) == "${CLAUDE_DIR}/claude" ]] || claude_box_refuse "/usr/local/bin/claude"
[[ ! -e /opt/qorpera-harnesses/node_modules/@anthropic-ai ]] || claude_box_refuse "a second Claude Code in the harness packages"
claude_home=$(mktemp -d /root/qorpera-claude-version.XXXXXX)
installed_claude=$(env -i HOME="${claude_home}" CLAUDE_CONFIG_DIR="${claude_home}" DISABLE_AUTOUPDATER=1 PATH=/usr/bin:/bin \
	"${CLAUDE_DIR}/claude" --version)
rm -rf -- "${claude_home}"
[[ ${installed_claude} == "${claude_version} "* ]] || claude_box_refuse "Claude Code says ${installed_claude}"
[[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns) == 1 ]] ||
	claude_box_refuse "unprivileged user namespaces are not restricted, so the helper's profile cannot be checked"
[[ $(systemctl is-enabled apparmor.service) == enabled ]] || claude_box_refuse "apparmor.service would not load the profile at boot"
grep -Fxq "qorpera-claude-box-ns (unconfined)" /sys/kernel/security/apparmor/profiles || claude_box_refuse "the helper's profile is not loaded"
# The box's own start, as an account of the box's group in a unit hardened like the run host's: the helper makes the
# run's namespaces and mounts there (its /proc, and a made-up tmpfs); util-linux's own unshare, the same in all else,
# cannot; an account outside the group cannot run the helper.
claude_box_unit() {
	local group=$1
	shift
	systemd-run --quiet --pipe --wait --collect --uid=nobody --gid="${group}" \
		-p NoNewPrivileges=yes -p PrivateDevices=yes -p "DeviceAllow=/dev/fuse rw" -p BindPaths=/dev/fuse \
		-p CapabilityBoundingSet= -p AmbientCapabilities= -p "RestrictNamespaces=user mnt pid net ipc uts cgroup" \
		-p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p ProtectProc=invisible -p ProcSubset=all \
		-p ProtectKernelTunables=no -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes "$@" </dev/null
}
for helper in /opt/qorpera-runner/qorpera-claude-box-ns /usr/bin/unshare; do
	box_start=$(claude_box_unit "${CLAUDE_BOX_GROUP}" "${helper}" --user --map-current-user --keep-caps --mount --pid --fork \
		--kill-child --mount-proc -- /bin/sh -c 'test -c /dev/fuse && cat /proc/self/attr/current' 2>&1) && box_rc=0 || box_rc=$?
	made_up=$(claude_box_unit "${CLAUDE_BOX_GROUP}" "${helper}" --user --map-root-user --mount -- \
		/bin/sh -c 'mount -t tmpfs qorpera-claude-box-check /mnt && findmnt -n -r -o FSTYPE,SOURCE /mnt' 2>&1) && mount_rc=0 || mount_rc=$?
	echo "Claude Code box namespace check with ${helper}: start rc=${box_rc} (${box_start}); made-up mount rc=${mount_rc} (${made_up})"
	if [[ ${helper} == /usr/bin/unshare ]]; then
		((box_rc != 0 && mount_rc != 0)) || claude_box_refuse "util-linux unshare mounts in a new user namespace too"
	elif ((box_rc != 0 || mount_rc != 0)) || [[ ${box_start} != "qorpera-claude-box-ns (unconfined)" ]] ||
		[[ ${made_up} != "tmpfs qorpera-claude-box-check" ]]; then
		claude_box_refuse "the helper cannot start the box's namespace"
	fi
done
if claude_box_unit nogroup /opt/qorpera-runner/qorpera-claude-box-ns --user -- /bin/true 2>/dev/null; then
	claude_box_refuse "an account outside ${CLAUDE_BOX_GROUP} can run the helper"
fi
# --- the Claude Code box's checks: end

for unit in "${SELF_UPDATE_UNITS[@]}"; do
	if [[ $(readlink "/etc/systemd/system/${unit}") != /dev/null ]] ||
		[[ $(systemctl is-enabled "${unit}" 2>/dev/null) != masked ]]; then
		echo "The published image could update itself: ${unit} is not masked." >&2
		exit 1
	fi
done

if find /var/lib/qorpera-bootstrap -mindepth 1 -type f -print -quit | grep -q .; then
	echo "The published image would contain guest bootstrap secrets." >&2
	exit 1
fi
echo "LXD_RUNNER_IMAGE_CONTRACT_INSTALLED"
