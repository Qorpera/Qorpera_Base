#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
	echo "Usage: $0 <base-image@sha256:digest> <registry/repository:tag>" >&2
	exit 2
fi

base_image=$1
target_image=$2
base_digest=${base_image##*@sha256:}
if [ "$base_digest" = "$base_image" ] || [ "${#base_digest}" -ne 64 ]; then
	echo "Base image must be pinned by SHA-256 digest" >&2
	exit 2
fi
case "$base_digest" in *[!0-9a-f]*) echo "Base image digest is invalid" >&2; exit 2 ;; esac
case "$target_image" in
	*@*) echo "Target image must be a mutable build tag, not a digest reference" >&2; exit 2 ;;
	*:*/*:*|*/*:*) ;;
	*) echo "Target image must include a registry, repository, and tag" >&2; exit 2 ;;
esac
: "${COSIGN_CERTIFICATE_IDENTITY_REGEXP:?Set the expected signing certificate identity regexp}"
: "${COSIGN_CERTIFICATE_OIDC_ISSUER:?Set the expected signing OIDC issuer}"
command -v node >/dev/null
command -v podman >/dev/null
command -v cosign >/dev/null
command -v timeout >/dev/null

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
work_directory=$(mktemp -d "${TMPDIR:-/tmp}/qorpera-ephemeral-runner-build.XXXXXX")
artifact_directory="$work_directory/artifact"
digest_file="$work_directory/digest"
active_pid=""
cleanup() {
	rm -rf -- "$work_directory"
}
on_signal() {
	sig=$1
	if [ -n "$active_pid" ]; then
		kill -s TERM "$active_pid" 2>/dev/null || true
		wait "$active_pid" 2>/dev/null || true
		active_pid=""
	fi
	cleanup
	trap - "$sig" EXIT
	kill -s "$sig" "$$"
}
trap cleanup EXIT
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

run_bounded() {
	seconds=$1
	shift
	timeout --kill-after=30 "$seconds" "$@" &
	active_pid=$!
	rc=0
	wait "$active_pid" || rc=$?
	active_pid=""
	return "$rc"
}

cd "$repository_root"
node scripts/package-ephemeral-runner.mjs --out "$artifact_directory"
run_bounded "${PODMAN_BUILD_TIMEOUT_SEC:-1800}" podman build \
	--pull=never \
	--build-arg "BASE_IMAGE=$base_image" \
	--file deploy/ephemeral-runner/image/Containerfile \
	--tag "$target_image" \
	"$artifact_directory"
run_bounded "${PODMAN_PUSH_TIMEOUT_SEC:-600}" podman push --digestfile "$digest_file" "$target_image"

digest=$(tr -d '\r\n' < "$digest_file")
digest_value=${digest#sha256:}
if [ "$digest_value" = "$digest" ] || [ "${#digest_value}" -ne 64 ]; then
	echo "Registry did not return a valid image digest" >&2
	exit 1
fi
case "$digest_value" in *[!0-9a-f]*) echo "Registry returned an invalid image digest" >&2; exit 1 ;; esac
immutable_image="$target_image@$digest"
run_bounded "${COSIGN_TIMEOUT_SEC:-120}" cosign sign --yes "$immutable_image"
run_bounded "${COSIGN_TIMEOUT_SEC:-120}" cosign verify \
	--certificate-identity-regexp "$COSIGN_CERTIFICATE_IDENTITY_REGEXP" \
	--certificate-oidc-issuer "$COSIGN_CERTIFICATE_OIDC_ISSUER" \
	"$immutable_image" >/dev/null

printf '%s\n' "$immutable_image"
