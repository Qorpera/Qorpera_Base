#!/usr/bin/env bash
# Company data proofs: one throwaway PostgreSQL 17 in a container on a test machine, never production.
# Run through scripts/run-on-node.mjs: `node scripts/run-on-node.mjs --no-status -- bash deploy/company-data/proof/run.sh p1 p2 p3`
# The container is capped (2 CPUs, 4 GiB), listens on loopback only, and is removed when the script ends.
set -euo pipefail
cd "$(dirname "$0")/../../.."
IMAGE="docker.io/library/postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3"
NAME="cdproof-$$-$(date +%s)"
PASS="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
# The snapshot proof writes its files here, inside this run's own folder; it is removed when the script ends.
SNAP="$PWD/.cdproof-snap-$$"
mkdir -m 0777 "$SNAP"
chmod 0777 "$SNAP"
cleanup() {
	docker exec "$NAME" find /snap -mindepth 1 -delete >/dev/null 2>&1 || true
	docker ps -aq --filter "name=^cdproof-$$-" | xargs -r docker rm -f -v >/dev/null 2>&1 || true
	docker ps -aq --filter "name=^cdrest-$$-" | xargs -r docker rm -f -v >/dev/null 2>&1 || true
	rm -rf "$SNAP"
}
trap cleanup EXIT
docker run -d --name "$NAME" --cpus 2 --memory 4g --shm-size 512m \
	-e POSTGRES_PASSWORD="$PASS" \
	-e POSTGRES_INITDB_ARGS="--locale-provider=icu --encoding=UTF-8 --icu-locale=en_US.UTF-8" \
	-v "$SNAP:/snap" -p "127.0.0.1:$PORT:5432" "$IMAGE" \
	-c max_connections=300 -c shared_buffers=512MB -c listen_addresses='*' -c fsync=on -c synchronous_commit=on >/dev/null
for _ in $(seq 1 120); do
	if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 &&
		docker exec "$NAME" psql -h 127.0.0.1 -U postgres -Atc 'select 1' >/dev/null 2>&1; then break; fi
	sleep 0.5
done
docker exec "$NAME" psql -h 127.0.0.1 -U postgres -Atc 'select version()'
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGPASSWORD="$PASS" CDPROOF_CONTAINER="$NAME" CDPROOF_PID="$$" CDPROOF_SNAP_HOST="$SNAP"
echo "== machine: $(nproc) vCPU, $(awk '/MemAvailable/ {printf "%.1f GiB available", $2/1048576}' /proc/meminfo), load $(cut -d' ' -f1-3 /proc/loadavg)"
status=0
for proof in "$@"; do
	echo
	echo "==================== $proof ===================="
	node "deploy/company-data/proof/$proof.mjs" || { status=$?; echo "== $proof FAILED ($status)"; }
done
exit "$status"
