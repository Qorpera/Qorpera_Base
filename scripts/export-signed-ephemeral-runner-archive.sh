#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
	echo "Usage: $0 <local-image> <source-commit> <output-directory>" >&2
	exit 2
fi

local_image=$1
source_commit=$2
output_root=$3

if [ "${#source_commit}" -ne 40 ]; then
	echo "Source commit must be exactly 40 lowercase hexadecimal characters" >&2
	exit 2
fi
case "$source_commit" in
	*[!0-9a-f]*)
		echo "Source commit must be exactly 40 lowercase hexadecimal characters" >&2
		exit 2
		;;
esac
if [ -e "$output_root" ]; then
	echo "Output directory already exists: $output_root" >&2
	exit 2
fi
: "${QORPERA_LINUX_BASE_IMAGE:?Set the digest-pinned Linux base image}"
: "${COSIGN_CERTIFICATE_IDENTITY_REGEXP:?Set the expected signing certificate identity regexp}"
: "${COSIGN_CERTIFICATE_OIDC_ISSUER:?Set the expected signing OIDC issuer}"
base_digest=${QORPERA_LINUX_BASE_IMAGE##*@sha256:}
if [ "$base_digest" = "$QORPERA_LINUX_BASE_IMAGE" ] || [ "${#base_digest}" -ne 64 ]; then
	echo "Linux base image must be digest-pinned" >&2
	exit 2
fi
case "$base_digest" in *[!0-9a-f]*) echo "Linux base image digest is invalid" >&2; exit 2 ;; esac
command -v cosign >/dev/null
command -v node >/dev/null
command -v podman >/dev/null
command -v sha256sum >/dev/null

image_digest=$(podman image inspect --format '{{.Digest}}' "$local_image")
digest_value=${image_digest#sha256:}
if [ "$digest_value" = "$image_digest" ] || [ "${#digest_value}" -ne 64 ]; then
	echo "Built probe image does not have a valid local digest" >&2
	exit 1
fi
case "$digest_value" in *[!0-9a-f]*) echo "Built probe image digest is invalid" >&2; exit 1 ;; esac

target_tag="localhost/qorpera/sandbox-probe:$source_commit"
immutable_image="$target_tag@$image_digest"
podman tag "$local_image" "$target_tag"
podman image exists "$immutable_image"

mkdir -m 0700 "$output_root"
archive="$output_root/qorpera-sandbox-probe.oci.tar"
bundle="$output_root/qorpera-sandbox-probe.cosign-bundle.json"
manifest="$output_root/manifest.json"
podman save --format oci-archive --output "$archive" "$immutable_image"
cosign sign-blob --yes --bundle "$bundle" "$archive" >/dev/null
cosign verify-blob \
	--bundle "$bundle" \
	--certificate-identity-regexp "$COSIGN_CERTIFICATE_IDENTITY_REGEXP" \
	--certificate-oidc-issuer "$COSIGN_CERTIFICATE_OIDC_ISSUER" \
	"$archive" >/dev/null

ARCHIVE_SHA256=$(sha256sum "$archive" | awk '{ print $1 }') \
BUNDLE_SHA256=$(sha256sum "$bundle" | awk '{ print $1 }') \
IMMUTABLE_IMAGE="$immutable_image" \
SOURCE_COMMIT="$source_commit" \
BASE_IMAGE="$QORPERA_LINUX_BASE_IMAGE" \
MANIFEST_PATH="$manifest" \
	node <<'NODE'
const { writeFileSync } = require("node:fs");

const manifest = {
	schema: "qorpera.ephemeral-runner-oci-archive/v1",
	source_commit: process.env.SOURCE_COMMIT,
	base_image: process.env.BASE_IMAGE,
	image: process.env.IMMUTABLE_IMAGE,
	archive: {
		file: "qorpera-sandbox-probe.oci.tar",
		sha256: process.env.ARCHIVE_SHA256,
	},
	cosign_bundle: {
		file: "qorpera-sandbox-probe.cosign-bundle.json",
		sha256: process.env.BUNDLE_SHA256,
	},
};
writeFileSync(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, {
	encoding: "utf8",
	mode: 0o600,
});
NODE

chmod 0600 "$archive" "$bundle" "$manifest"
printf '%s\n' "$immutable_image"
