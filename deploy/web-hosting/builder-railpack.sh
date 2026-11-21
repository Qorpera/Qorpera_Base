#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
	echo "Usage: $0 <repo_dir> <site_id> <registry_host>" >&2
	exit 2
fi

REPO_DIR="$1"
SITE_ID="$2"
REGISTRY_HOST="$3"
TAG="${REGISTRY_HOST}/sites/${SITE_ID}:build-$(date -u +%Y%m%d%H%M%S)"

if [ -f "${REPO_DIR}/Dockerfile" ]; then
	docker build --pull=false -t "${TAG}" "${REPO_DIR}"
	docker push "${TAG}"
	echo "kind=server"
	echo "image=${TAG}"
	exit 0
fi

if [ -f "${REPO_DIR}/next.config.mjs" ] || [ -f "${REPO_DIR}/next.config.js" ] || [ -f "${REPO_DIR}/next.config.ts" ]; then
	if command -v railpack >/dev/null 2>&1; then
		railpack build "${REPO_DIR}" --name "${TAG}"
		docker push "${TAG}"
		echo "kind=hybrid"
		echo "image=${TAG}"
		exit 0
	fi
fi

if command -v railpack >/dev/null 2>&1 && { [ -f "${REPO_DIR}/package.json" ] || [ -f "${REPO_DIR}/pyproject.toml" ] || [ -f "${REPO_DIR}/go.mod" ]; }; then
	railpack build "${REPO_DIR}" --name "${TAG}"
	docker push "${TAG}"
	echo "kind=server"
	echo "image=${TAG}"
	exit 0
fi

echo "kind=static"
echo "image="
