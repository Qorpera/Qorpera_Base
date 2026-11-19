#!/bin/bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
L=/home/tester/lanes/agent-box-C2
R=/var/lib/clu-probe-$$
install -d -m 0755 $L $L/pkg $L/cc
if [[ ! -x $L/cc/2.1.325/claude ]]; then
	rm -rf $L/pkg/cc; mkdir -p $L/pkg/cc
	(cd $L/pkg/cc && npm pack --silent "@anthropic-ai/claude-code-linux-x64@2.1.325" >/dev/null && tar xzf ./*.tgz)
	install -d -m 0755 $L/cc/2.1.325; install -m 0555 $L/pkg/cc/package/claude $L/cc/2.1.325/claude
fi
[[ $(sha256sum $L/cc/2.1.325/claude | cut -c1-16) == 0dc4f4a9a165fc60 ]] || { echo "not the pinned build"; exit 1; }
install -d -m 0755 $R $R/tls
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj "/CN=usage probe CA" \
	-keyout $R/tls/ca.key -out $R/tls/ca.pem 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=api.anthropic.com" \
	-keyout $R/tls/server.key -out $R/tls/server.csr 2>/dev/null
printf 'subjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com,DNS:claude.ai\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' >$R/tls/ext
openssl x509 -req -in $R/tls/server.csr -CA $R/tls/ca.pem -CAkey $R/tls/ca.key -CAcreateserial -days 1 \
	-extfile $R/tls/ext -out $R/tls/server.pem 2>/dev/null
chmod 0444 $R/tls/ca.pem
REPO=$(cd "$HERE/../../.." && pwd)
if [[ " $* " == *" reader-"* ]]; then
	npx esbuild "$HERE/usage-reader.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
		--alias:@qorpera/contracts=./packages/contracts/src/index.ts \
		"--banner:js=import { createRequire as __clu_require } from \"node:module\"; const require = __clu_require(import.meta.url);" \
		--outfile=$R/reader.bundle.mjs || { echo "BUNDLE FAILED"; exit 1; }
	chmod 0444 $R/reader.bundle.mjs
	export USAGE_READER_BUNDLE=$R/reader.bundle.mjs USAGE_NODE=$(command -v node)
fi
python3 "$HERE/usage-probe.py" $R $L/cc/2.1.325/claude $R/tls/ca.pem $R/tls/server.pem $R/tls/server.key "$@"
RC=$?
rm -rf $R
exit $RC
