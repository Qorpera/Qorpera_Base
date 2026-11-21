#!/usr/bin/env bash
set -euo pipefail

ROLE="${1:-}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${ROLE}" != "primary" && "${ROLE}" != "standby" ]]; then
	echo "Usage: $0 <primary|standby>" >&2
	exit 2
fi

if [[ ! -f "${KIT_DIR}/.env" ]]; then
	echo "Missing ${KIT_DIR}/.env (copy from .env.example and set DATA_LOCAL, DATA_BACKUP, DATA_GATEWAY_LISTEN, DATA_PLATFORM_URL, DATA_PLATFORM_KEY, DATA_GATEWAY_PACKAGE)" >&2
	exit 2
fi

set -a
source "${KIT_DIR}/.env"
set +a

install -d -m 0700 "${DATA_LOCAL:?set DATA_LOCAL}"
install -d -m 0750 "${DATA_BACKUP:?set DATA_BACKUP}"

if [[ "${ROLE}" == "primary" ]]; then
	bash "${KIT_DIR}/init.sh"
	if command -v systemctl >/dev/null 2>&1; then
		install -m 0644 "${KIT_DIR}/systemd/qorpera-company-data-backup.service" /etc/systemd/system/
		install -m 0644 "${KIT_DIR}/systemd/qorpera-company-data-backup.timer" /etc/systemd/system/
		systemctl daemon-reload
		systemctl enable --now qorpera-company-data-backup.timer
	fi
else
	bash "${KIT_DIR}/standby.sh"
fi

echo "Provisioned company-data ${ROLE} from ${KIT_DIR}"
