#!/usr/bin/env bash
set -euo pipefail

ROLE="${1:-}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_UID=999

if [[ "${ROLE}" != "primary" && "${ROLE}" != "standby" ]]; then
	echo "Usage: $0 primary <cert-name>... | $0 standby <subcommand> [args...]" >&2
	exit 2
fi
shift
if [[ $# -eq 0 ]]; then
	if [[ "${ROLE}" == "primary" ]]; then
		echo "Usage: $0 primary <cert-name>..." >&2
	else
		echo "Usage: $0 standby <subcommand> [args...]" >&2
	fi
	exit 2
fi

if [[ ! -f "${KIT_DIR}/.env" ]]; then
	echo "Missing ${KIT_DIR}/.env (copy from .env.example and set DATA_LOCAL, DATA_BACKUP, DATA_GATEWAY_LISTEN, DATA_PLATFORM_URL, DATA_PLATFORM_KEY, DATA_GATEWAY_PACKAGE)" >&2
	exit 2
fi

# WHY: Parse .env with env.sh load_env instead of raw bash source so compose quoting works safely without executing shell syntax.
# shellcheck disable=SC1091
. "${KIT_DIR}/env.sh"
load_env "${KIT_DIR}/.env" || {
	echo "provision-data-vm: ${KIT_DIR}/.env has an unclosed quote" >&2
	exit 1
}

: "${DATA_LOCAL:?set DATA_LOCAL}" "${DATA_BACKUP:?set DATA_BACKUP}"
[[ ${DATA_LOCAL} == /* ]] || DATA_LOCAL="${KIT_DIR}/${DATA_LOCAL}"
[[ ${DATA_BACKUP} == /* ]] || DATA_BACKUP="${KIT_DIR}/${DATA_BACKUP}"
export DATA_LOCAL DATA_BACKUP

if [[ "$(id -u)" -ne 0 ]]; then
	echo "provision-data-vm: run as root" >&2
	exit 1
fi

install -d -m 0700 "${DATA_LOCAL}"
# WHY: Grant group traverse to postgres UID 999 so the container can write /backup/wal and /backup/base without EACCES.
install -d -m 0750 -o 0 -g "${PG_UID}" "${DATA_BACKUP}"

if [[ "${ROLE}" == "primary" ]]; then
	bash "${KIT_DIR}/init.sh" "$@"
	if command -v systemctl >/dev/null 2>&1; then
		install -m 0644 "${KIT_DIR}/systemd/qorpera-company-data-backup.service" /etc/systemd/system/
		install -m 0644 "${KIT_DIR}/systemd/qorpera-company-data-backup.timer" /etc/systemd/system/
		systemctl daemon-reload
		systemctl enable --now qorpera-company-data-backup.timer
	fi
else
	bash "${KIT_DIR}/standby.sh" "$@"
fi

echo "Provisioned company-data ${ROLE} from ${KIT_DIR}"
