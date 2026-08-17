#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
	echo "Ephemeral runner containment tests require Linux" >&2
	exit 1
fi
command -v node >/dev/null
command -v npm >/dev/null
command -v podman >/dev/null

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
base_image=${QORPERA_LINUX_BASE_IMAGE:-docker.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d}
local_image=${QORPERA_LINUX_LOCAL_IMAGE:-localhost/qorpera/sandbox-probe:linux-test}
case "$base_image" in *@sha256:*) ;; *) echo "Linux test base image must be digest-pinned" >&2; exit 2 ;; esac

cd "$repository_root"
node --test scripts/package-ephemeral-runner.test.mjs
npm run pack:ephemeral-runner
podman pull "$base_image"
podman build \
	--pull=never \
	--format=oci \
	--build-arg "BASE_IMAGE=$base_image" \
	--file deploy/ephemeral-runner/image/Containerfile \
	--tag "$local_image" \
	.artifacts/ephemeral-runner

image_digest=$(podman image inspect --format '{{.Digest}}' "$local_image")
digest_value=${image_digest#sha256:}
if [ "$digest_value" = "$image_digest" ] || [ "${#digest_value}" -ne 64 ]; then
	echo "Built probe image does not have a valid local digest" >&2
	exit 1
fi
case "$digest_value" in *[!0-9a-f]*) echo "Built probe image digest is invalid" >&2; exit 1 ;; esac
immutable_image="$local_image@$image_digest"
podman image exists "$immutable_image"

(
	cd packages/shell
	node ../../node_modules/vitest/dist/cli.js --run \
		test/cloud-runner-container.test.ts \
		test/cloud-runner-podman.test.ts
	QORPERA_LINUX_RUNNER_IMAGE="$immutable_image" \
	QORPERA_LINUX_PODMAN_PATH=$(command -v podman) \
		node ../../node_modules/vitest/dist/cli.js --run test/cloud-runner-podman-linux.integration.test.ts
)

if command -v shellcheck >/dev/null; then
	shellcheck scripts/test-ephemeral-runner-linux.sh deploy/ephemeral-runner/build-and-sign-image.sh deploy/ephemeral-runner/image/run-job
fi
if command -v systemd-analyze >/dev/null; then
	unit_copy=$(mktemp --suffix=.service)
	trap 'rm -f -- "$unit_copy"' EXIT HUP INT TERM
	sed \
		"s|/opt/qorpera-runner/qorpera-ephemeral-runner.mjs|$repository_root/.artifacts/ephemeral-runner/qorpera-ephemeral-runner.mjs|" \
		deploy/ephemeral-runner/qorpera-ephemeral-runner.service > "$unit_copy"
	systemd-analyze --user verify "$unit_copy"
fi

retained=$(podman ps --all --filter name=qorpera-job- --format '{{.Names}}')
if [ -n "$retained" ]; then
	echo "Runner test retained a disposable job container" >&2
	exit 1
fi
printf '%s\n' "$immutable_image"
