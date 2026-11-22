#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
	echo "Usage: $0 <source_dir> <image_tag>" >&2
	exit 2
fi

SOURCE_DIR="$1"
IMAGE_TAG="$2"
DOCKERFILE_REL="${QORPERA_DOCKERFILE:-}"
APP_PORT="${QORPERA_APP_PORT:-3000}"

if [ ! -d "$SOURCE_DIR" ]; then
	echo "Source directory not found: $SOURCE_DIR" >&2
	exit 3
fi

if [ -n "$DOCKERFILE_REL" ]; then
	case "$DOCKERFILE_REL" in
		/*|*..*|*\\*)
			echo "Invalid dockerfile path: $DOCKERFILE_REL" >&2
			exit 4
			;;
	esac
	DOCKERFILE_PATH="${SOURCE_DIR}/${DOCKERFILE_REL}"
	if [ ! -f "$DOCKERFILE_PATH" ]; then
		echo "Dockerfile not found: $DOCKERFILE_PATH" >&2
		exit 4
	fi
	docker build --pull=false --build-arg "PORT=${APP_PORT}" -f "$DOCKERFILE_PATH" -t "$IMAGE_TAG" "$SOURCE_DIR" >&2
elif [ -f "${SOURCE_DIR}/Dockerfile" ]; then
	docker build --pull=false --build-arg "PORT=${APP_PORT}" -f "${SOURCE_DIR}/Dockerfile" -t "$IMAGE_TAG" "$SOURCE_DIR" >&2
elif command -v railpack >/dev/null 2>&1; then
	railpack build "$SOURCE_DIR" --name "$IMAGE_TAG" --env "PORT=${APP_PORT}" >&2
else
	echo "No Dockerfile found and railpack is not installed" >&2
	exit 5
fi

docker push "$IMAGE_TAG" >&2
IMAGE_REPO="${IMAGE_TAG%:*}"
DIGEST_REF="$(docker inspect --format='{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_TAG" 2>/dev/null | grep -F "${IMAGE_REPO}@sha256:" | head -n 1 || true)"
if [ -z "$DIGEST_REF" ]; then
	DIGEST_REF="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_TAG" 2>/dev/null || true)"
fi
if [ -z "$DIGEST_REF" ] || [[ ! "$DIGEST_REF" =~ @sha256:[0-9a-f]{64}$ ]]; then
	echo "Failed to resolve immutable OCI digest for $IMAGE_TAG" >&2
	exit 6
fi

printf '%s\n' "$DIGEST_REF"
