#!/bin/bash
# docker compose for this machine's project, with exactly the files the kit's scripts use: the .env's COMPOSE_FILE,
# plus run-door.yml whenever DATA_RUN_LISTEN is set (lib.sh). Use it for every compose command by hand, from any
# folder, as root; a bare `docker compose` reads only the .env and would bring the gateway back without its run door.
#   compose.sh up -d data-gateway      a new gateway package, or a changed setting
#   compose.sh ps | logs data-gateway | stop | config ...
set -euo pipefail
. "$(dirname "$0")/lib.sh"
exec docker compose --project-directory "$K" "$@"
