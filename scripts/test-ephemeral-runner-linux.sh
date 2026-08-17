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
	shellcheck scripts/test-ephemeral-runner-linux.sh deploy/ephemeral-runner/build-and-sign-image.sh deploy/ephemeral-runner/image/run-job deploy/ephemeral-runner/systemd-boundary-probe.sh
fi
if command -v systemd-analyze >/dev/null; then
	unit_copy=$(mktemp --tmpdir qorpera-ephemeral-runner-boundary-XXXXXX.service)
	unit_name=$(basename "$unit_copy")
	node_path=$(command -v node)
	home_marker=$HOME/.qorpera-systemd-boundary-probe
	runtime_directory=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
	runtime_marker=$runtime_directory/qorpera-systemd-boundary-probe
	user_manager_ready=false
	cleanup_systemd_probe() {
		if [ "$user_manager_ready" = true ]; then
			systemctl --user stop "$unit_name" >/dev/null 2>&1 || true
			systemctl --user disable "$unit_name" >/dev/null 2>&1 || true
			systemctl --user daemon-reload >/dev/null 2>&1 || true
		fi
		rm -f -- "$unit_copy" "$home_marker" "$runtime_marker"
	}
	trap cleanup_systemd_probe EXIT HUP INT TERM
	sed \
		-e "s|/usr/bin/node|$node_path|" \
		-e "s|/opt/qorpera-runner/qorpera-ephemeral-runner.mjs|$repository_root/.artifacts/ephemeral-runner/qorpera-ephemeral-runner.mjs|" \
		deploy/ephemeral-runner/qorpera-ephemeral-runner.service > "$unit_copy"
	systemd-analyze --user verify "$unit_copy"

	if ! systemctl --user show-environment >/dev/null 2>&1 && [ "${CI:-}" = true ] && command -v sudo >/dev/null; then
		sudo systemctl start "user@$(id -u).service"
		export XDG_RUNTIME_DIR="$runtime_directory"
		export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus"
	fi
	if systemctl --user show-environment >/dev/null 2>&1; then
		user_manager_ready=true
		podman_path=$(command -v podman)
		sed \
			-e 's/^Type=exec$/Type=oneshot/' \
			-e 's/^Restart=on-failure$/Restart=no/' \
			-e '/^Environment=/d' \
			-e '/^LoadCredential=/d' \
			-e "s|^ExecStart=.*|Environment=QORPERA_SYSTEMD_PROBE_PODMAN=$podman_path\\nEnvironment=QORPERA_SYSTEMD_PROBE_IMAGE=$immutable_image\\nEnvironment=QORPERA_SYSTEMD_PROBE_HOME=$home_marker\\nEnvironment=QORPERA_SYSTEMD_PROBE_RUNTIME=$runtime_marker\\nExecStart=/bin/sh $repository_root/deploy/ephemeral-runner/systemd-boundary-probe.sh|" \
			deploy/ephemeral-runner/qorpera-ephemeral-runner.service > "$unit_copy"
		systemctl --user link "$unit_copy"
		systemctl --user daemon-reload
		systemctl --user start "$unit_name"
		if [ "$(systemctl --user show --property=Result --value "$unit_name")" != success ]; then
			echo "Systemd runner boundary probe failed" >&2
			exit 1
		fi
		test "$(cat "$home_marker")" = home
		test "$(cat "$runtime_marker")" = runtime
	else
		echo "User systemd manager unavailable; runtime unit probe skipped" >&2
	fi
fi

retained=$(podman ps --all --filter name=qorpera-job- --format '{{.Names}}')
if [ -n "$retained" ]; then
	echo "Runner test retained a disposable job container" >&2
	exit 1
fi
printf '%s\n' "$immutable_image"
