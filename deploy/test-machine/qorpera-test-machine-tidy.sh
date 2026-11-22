#!/bin/bash
set -euo pipefail

HOME_DIR="${QORPERA_TEST_HOME:-/home/tester}"
KEEP_TREES="${QORPERA_TIDY_KEEP_TREES:-12}"
CONTAINER_AGE_SEC="${QORPERA_TIDY_CONTAINER_AGE_SEC:-7200}"
RUN_AGE_HOURS="${QORPERA_TIDY_RUN_AGE_HOURS:-3}"
TMP_AGE_MIN="${QORPERA_TIDY_TMP_AGE_MIN:-120}"
BUILDER_UNTIL="${QORPERA_TIDY_BUILDER_UNTIL:-48h}"
JOURNAL_MAX="${QORPERA_TIDY_JOURNAL_MAX:-200M}"

log() { printf '[%s] test-machine-tidy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if command -v docker >/dev/null 2>&1; then
	now=$(date +%s)
	removed_ct=0
	ids=$(
		{
			docker ps -aq --filter 'name=^cdgateway-' 2>/dev/null || true
			docker ps -aq --filter 'name=^qext-' 2>/dev/null || true
			docker ps -aq --filter 'name=^qorpera-hosted-db-' 2>/dev/null || true
			docker ps -aq --filter 'label=qorpera-run' 2>/dev/null || true
			docker ps -aq --filter 'status=exited' 2>/dev/null || true
		} | sort -u
	)
	for id in $ids; do
		[ -n "$id" ] || continue
		created=$(docker inspect -f '{{.Created}}' "$id" 2>/dev/null || true)
		[ -n "$created" ] || continue
		ts=$(date -d "$created" +%s 2>/dev/null || echo "$now")
		if [ $((now - ts)) -gt "$CONTAINER_AGE_SEC" ]; then
			if docker rm -f -v "$id" >/dev/null 2>&1; then
				removed_ct=$((removed_ct + 1))
			fi
		fi
	done
	# WHY: Never pass --all to docker image prune so pre-pulled pinned CI images remain cached offline.
	vol_out=$(docker volume prune -f 2>/dev/null | tail -n 1 || true)
	img_out=$(docker image prune -f 2>/dev/null | tail -n 1 || true)
	bld_out=$(docker builder prune -f --filter "until=${BUILDER_UNTIL}" 2>/dev/null | tail -n 1 || true)
	log "containers_reaped=${removed_ct} volumes='${vol_out}' images='${img_out}' builder='${bld_out}'"
fi

if [ -d "${HOME_DIR}/runs" ]; then
	cutoff=$(date -u -d "-${RUN_AGE_HOURS} hours" +%Y%m%dT%H%M%S)
	ps_snap=$(ps -ef 2>/dev/null || true)
	removed_runs=0
	for d in "${HOME_DIR}/runs"/*/; do
		[ -d "$d" ] || continue
		n=$(basename "$d")
		if [[ "$n" =~ ^[0-9]{8}T[0-9]{6}- && "${n%%-*}" < "$cutoff" ]]; then
			if ! printf '%s\n' "$ps_snap" | grep -Fq "$n"; then
				rm -rf -- "$d" && removed_runs=$((removed_runs + 1))
			fi
		fi
	done
	log "runs_removed=${removed_runs}"
fi

if [ -d "${HOME_DIR}/trees" ]; then
	removed_trees=0
	while IFS= read -r lock_file; do
		[ -f "$lock_file" ] || continue
		if flock -n "$lock_file" rm -rf -- "${lock_file%.lock}" 2>/dev/null; then
			rm -f -- "$lock_file"
			removed_trees=$((removed_trees + 1))
		fi
	done < <(ls -t "${HOME_DIR}/trees"/*.lock 2>/dev/null | tail -n "+$((KEEP_TREES + 1))" || true)
	for d in "${HOME_DIR}/trees"/*/; do
		[ -d "$d" ] || continue
		base="${d%/}"
		if [ ! -e "${base}.lock" ] && [ -n "$(find "$base" -maxdepth 0 -mmin "+${TMP_AGE_MIN}" 2>/dev/null)" ]; then
			rm -rf -- "$base" && removed_trees=$((removed_trees + 1))
		fi
	done
	log "trees_removed=${removed_trees}"
fi

find /tmp -maxdepth 1 -mindepth 1 -mmin "+${TMP_AGE_MIN}" \
	\( -name 'code-site-*' -o -name 'qorpera-runtime-bundle-test-*' -o -name 'qorpera-bench-*' \) \
	-exec rm -rf -- {} + 2>/dev/null || true
if command -v journalctl >/dev/null 2>&1; then
	journalctl --vacuum-size="$JOURNAL_MAX" >/dev/null 2>&1 || true
fi

avail_root=$(df -Pm / | awk 'NR==2 {print $4}')
avail_tmp=$(df -Pm /tmp | awk 'NR==2 {print $4}')
log "done root_avail_mib=${avail_root} tmp_avail_mib=${avail_tmp}"
