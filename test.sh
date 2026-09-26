#!/usr/bin/env bash
set -euo pipefail

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
# Darwin's per-user temporary path can exceed Unix socket limits after fixture
# subdirectories are appended. Keep the same private, owned test isolation.
case "${OSTYPE-}" in
	darwin*) temp_parent="/private/tmp" ;;
esac
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/pi-test.XXXXXX")"
# Darwin inherits the temporary parent's group. Keep fixtures aligned with the
# process identity before creating their private directories.
case "${OSTYPE-}" in
	darwin*) chgrp "$(id -g)" "$test_root" ;;
esac
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.pi-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

test_home="$test_root/home"
test_tmp="$test_root/tmp"
test_config="$test_root/home/.config"
test_cache="$test_root/cache"
test_npm_cache="$test_root/cache/npm"
test_agent_dir="$test_root/home/.qorpera/agent"
test_npm_userconfig="$test_root/npm-userconfig"
test_npm_globalconfig="$test_root/npm-globalconfig"
if [[ ${OS-} == "Windows_NT" ]] && command -v cygpath >/dev/null 2>&1; then
	test_home="$(cygpath -w "$test_home")"
	test_tmp="$(cygpath -w "$test_tmp")"
	test_config="$(cygpath -w "$test_config")"
	test_cache="$(cygpath -w "$test_cache")"
	test_npm_cache="$(cygpath -w "$test_npm_cache")"
	test_agent_dir="$(cygpath -w "$test_agent_dir")"
	test_npm_userconfig="$(cygpath -w "$test_npm_userconfig")"
	test_npm_globalconfig="$(cygpath -w "$test_npm_globalconfig")"
fi
readonly test_home test_tmp test_config test_cache test_npm_cache test_agent_dir test_npm_userconfig test_npm_globalconfig

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/pi-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.pi-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_home"
	"USERPROFILE=$test_home"
	"TMPDIR=$test_tmp"
	"TMP=$test_tmp"
	"TEMP=$test_tmp"
	"XDG_CONFIG_HOME=$test_config"
	"XDG_CACHE_HOME=$test_cache"
	"QORPERA_CODING_AGENT_DIR=$test_agent_dir"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_npm_userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_npm_globalconfig"
	"NPM_CONFIG_CACHE=$test_npm_cache"
	"QORPERA_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Bound local parallelism without admitting endpoint or authentication settings.
if [[ -n ${VITEST_MAX_WORKERS-} ]]; then
	if [[ ! $VITEST_MAX_WORKERS =~ ^([1-9]|[12][0-9]|3[0-2])$ ]]; then
		printf 'VITEST_MAX_WORKERS must be an integer from 1 to 32\n' >&2
		exit 1
	fi
	test_env+=("VITEST_MAX_WORKERS=$VITEST_MAX_WORKERS")
fi

# Real root-owned filesystem probes run only when explicitly enabled on an
# isolated Linux test host; this admits no executable paths or credentials.
if [[ -n ${QORPERA_LINUX_ROOT_PROBES-} ]]; then
	if [[ $QORPERA_LINUX_ROOT_PROBES != 1 || ${OSTYPE-} != linux* ]]; then
		printf 'QORPERA_LINUX_ROOT_PROBES requires Linux and the exact value 1\n' >&2
		exit 1
	fi
	test_env+=("QORPERA_LINUX_ROOT_PROBES=1")
fi

# Native Windows needs these inherited values to launch child processes.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"
env -i "${test_env[@]}" npm test
