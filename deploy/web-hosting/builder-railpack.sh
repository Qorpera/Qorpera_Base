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

if [ -z "${HOME:-}" ]; then
	HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
	if [ -z "$HOME" ]; then
		HOME="/var/lib/qorpera-coding-executor"
	fi
	export HOME
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qorpera-build-XXXXXX")"
cleanup() {
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

generate_node_dockerfile() {
	local out_file="$1"
	local has_build="0"
	local start_cmd='["npm", "start"]'
	if command -v node >/dev/null 2>&1; then
		has_build="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(p.scripts&&p.scripts.build?"1":"0")' "${SOURCE_DIR}/package.json" 2>/dev/null || echo 0)"
		start_cmd="$(node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const dir=process.argv[2];
if (p.scripts && p.scripts.start) { process.stdout.write(JSON.stringify(["npm","start"])); }
else if (p.main) { process.stdout.write(JSON.stringify(["node", String(p.main)])); }
else if (fs.existsSync(dir+"/server.js")) { process.stdout.write(JSON.stringify(["node","server.js"])); }
else if (fs.existsSync(dir+"/index.js")) { process.stdout.write(JSON.stringify(["node","index.js"])); }
else { process.stdout.write(JSON.stringify(["npm","start"])); }
' "${SOURCE_DIR}/package.json" "$SOURCE_DIR" 2>/dev/null || echo '["npm", "start"]')"
	fi

	{
		echo "FROM docker.io/library/node:24-slim"
		echo "ARG PORT=3000"
		echo "WORKDIR /app"
		if [ -f "${SOURCE_DIR}/pnpm-lock.yaml" ]; then
			echo "RUN corepack enable"
			echo "COPY package.json pnpm-lock.yaml ./"
			echo "RUN pnpm install --frozen-lockfile"
		elif [ -f "${SOURCE_DIR}/yarn.lock" ]; then
			echo "RUN corepack enable"
			echo "COPY package.json yarn.lock ./"
			echo "RUN yarn install --frozen-lockfile"
		elif [ -f "${SOURCE_DIR}/package-lock.json" ]; then
			echo "COPY package.json package-lock.json ./"
			echo "RUN npm ci --no-audit --no-fund"
		else
			echo "COPY package.json ./"
			echo "RUN npm install --no-audit --no-fund"
		fi
		echo "COPY . ."
		if [ "$has_build" = "1" ]; then
			echo "RUN npm run build"
		fi
		echo "ENV NODE_ENV=production"
		echo "ENV HOST=0.0.0.0"
		echo "ENV PORT=\${PORT}"
		echo "EXPOSE \${PORT}"
		echo "CMD ${start_cmd}"
	} >"$out_file"
}

generate_python_dockerfile() {
	local out_file="$1"
	local start_cmd='["python3", "app.py"]'
	if [ -f "${SOURCE_DIR}/main.py" ] && [ ! -f "${SOURCE_DIR}/app.py" ]; then
		start_cmd='["python3", "main.py"]'
	elif [ -f "${SOURCE_DIR}/server.py" ] && [ ! -f "${SOURCE_DIR}/app.py" ]; then
		start_cmd='["python3", "server.py"]'
	fi

	{
		echo "FROM docker.io/library/python:3.12-slim"
		echo "ARG PORT=3000"
		echo "WORKDIR /app"
		if [ -f "${SOURCE_DIR}/requirements.txt" ]; then
			echo "COPY requirements.txt ./"
			echo "RUN pip install --no-cache-dir -r requirements.txt"
		fi
		echo "COPY . ."
		if [ -f "${SOURCE_DIR}/pyproject.toml" ] && [ ! -f "${SOURCE_DIR}/requirements.txt" ]; then
			echo "RUN pip install --no-cache-dir ."
		fi
		echo "ENV HOST=0.0.0.0"
		echo "ENV PORT=\${PORT}"
		echo "EXPOSE \${PORT}"
		echo "CMD ${start_cmd}"
	} >"$out_file"
}

DOCKERFILE_PATH=""
USE_RAILPACK="0"
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
elif [ -f "${SOURCE_DIR}/Dockerfile" ]; then
	DOCKERFILE_PATH="${SOURCE_DIR}/Dockerfile"
elif command -v railpack >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
	USE_RAILPACK="1"
elif [ -f "${SOURCE_DIR}/package.json" ]; then
	DOCKERFILE_PATH="${WORK_DIR}/Dockerfile.generated"
	generate_node_dockerfile "$DOCKERFILE_PATH"
elif [ -f "${SOURCE_DIR}/requirements.txt" ] || [ -f "${SOURCE_DIR}/pyproject.toml" ]; then
	DOCKERFILE_PATH="${WORK_DIR}/Dockerfile.generated"
	generate_python_dockerfile "$DOCKERFILE_PATH"
else
	echo "No Dockerfile, package.json, or Python project found in $SOURCE_DIR" >&2
	exit 5
fi

IMAGE_REPO="${IMAGE_TAG%:*}"

if command -v buildah >/dev/null 2>&1 && [ "$USE_RAILPACK" = "0" ]; then
	STORAGE_ROOT="${QORPERA_BUILDAH_ROOT:-${HOME}/.local/share/containers/storage}"
	mkdir -p "$STORAGE_ROOT" "${HOME}/.config/containers" "${WORK_DIR}/run"
	BUILDAH_ARGS=(
		--root "$STORAGE_ROOT"
		--runroot "${WORK_DIR}/run"
		--storage-driver overlay
		--storage-opt overlay.ignore_chown_errors=true
	)
	buildah "${BUILDAH_ARGS[@]}" bud \
		--isolation=oci \
		--network=host \
		--build-arg "PORT=${APP_PORT}" \
		-f "$DOCKERFILE_PATH" \
		-t "$IMAGE_TAG" \
		"$SOURCE_DIR" >&2

	PUSH_ARGS=()
	case "$IMAGE_TAG" in
		127.*/*|localhost:*/*|localhost/*)
			PUSH_ARGS+=(--tls-verify=false)
			;;
	esac
	DIGEST_FILE="${WORK_DIR}/digest"
	buildah "${BUILDAH_ARGS[@]}" push "${PUSH_ARGS[@]}" --digestfile "$DIGEST_FILE" "$IMAGE_TAG" "docker://${IMAGE_TAG}" >&2
	DIGEST="$(tr -d '[:space:]' <"$DIGEST_FILE")"
	buildah "${BUILDAH_ARGS[@]}" rmi "$IMAGE_TAG" >/dev/null 2>&1 || true
	DIGEST_REF="${IMAGE_REPO}@${DIGEST}"
elif command -v docker >/dev/null 2>&1; then
	if [ "$USE_RAILPACK" = "1" ]; then
		railpack build "$SOURCE_DIR" --name "$IMAGE_TAG" --env "PORT=${APP_PORT}" >&2
	else
		docker build --build-arg "PORT=${APP_PORT}" -f "$DOCKERFILE_PATH" -t "$IMAGE_TAG" "$SOURCE_DIR" >&2
	fi
	docker push "$IMAGE_TAG" >&2
	DIGEST_REF="$(docker inspect --format='{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_TAG" 2>/dev/null | grep -F "${IMAGE_REPO}@sha256:" | head -n 1 || true)"
	if [ -z "$DIGEST_REF" ]; then
		DIGEST_REF="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_TAG" 2>/dev/null || true)"
	fi
else
	echo "Neither buildah nor docker is installed" >&2
	exit 5
fi

if [ -z "$DIGEST_REF" ] || [[ ! "$DIGEST_REF" =~ @sha256:[0-9a-f]{64}$ ]]; then
	echo "Failed to resolve immutable OCI digest for $IMAGE_TAG" >&2
	exit 6
fi

printf '%s\n' "$DIGEST_REF"
