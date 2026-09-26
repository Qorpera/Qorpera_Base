#!/usr/bin/env bash
set -euo pipefail
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test "$#" = 1
case "$1" in /*) ;; *) exit 2 ;; esac
test ! -e "$1"
mkdir -m 700 "$1"
mkdir -m 700 "$1/auth" "$1/rest"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-amd64.tar.xz -o "$1/auth.tar.xz"
echo "b5c2991d1df760c9b099c1c2395a94bd1c2f83ed58901934921997179dc9f7ea  $1/auth.tar.xz" | sha256sum --check --status
tar -xJf "$1/auth.tar.xz" -C "$1/auth"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://github.com/PostgREST/postgrest/releases/download/v16.4/postgrest-v16.4-linux-static-x86-64.tar.xz -o "$1/rest.tar.xz"
echo "b47ecc82fce1dcebbbc4183d839e52f07f7630c9d7ad0f54db753d1939299354  $1/rest.tar.xz" | sha256sum --check --status
tar -xJf "$1/rest.tar.xz" -C "$1/rest"
test -x "$1/auth/auth"
test -x "$1/rest/postgrest"
node node_modules/playwright-core/cli.js install --with-deps chromium
