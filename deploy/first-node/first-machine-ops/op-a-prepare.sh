#!/usr/bin/env bash
set -euo pipefail
# Step 3 first machine — operator round A: dataset root, provider install,
# environment fill. Everything node-local; no secret leaves the machine.
echo "RETIRED: this script creates the obsolete local candidate dataset. Follow STEP-3-FIRST-MACHINE.md Direct NAS correction." >&2
exit 1

if [[ ${EUID} -ne 0 ]]; then echo "Run through sudo." >&2; exit 1; fi

install -d -o root -g root -m 0755 /srv/qorpera-nas /srv/qorpera-nas/companies /srv/qorpera-nas/companies/0d2053f0-c1a8-444d-99a8-68c8214e5414
echo "dataset root ready"

bash /home/company41-admin/step3-lxd/install-lxd-company-provider-host.sh

cp /etc/qorpera/lxd-company-provider.env.example /etc/qorpera/lxd-company-provider.env
chmod 0600 /etc/qorpera/lxd-company-provider.env
set -a; source /etc/qorpera/lxd-provider.env; set +a
sed -i "s|https://REPLACE.supabase.co|https://wovsmjvghnbcbfazdtvr.supabase.co|; s|REPLACE_WITH_SERVICE_ROLE_SECRET|${QORPERA_SUPABASE_SERVICE_KEY}|; s|REPLACE_WITH_PUBLISHABLE_KEY|${QORPERA_SUPABASE_PUBLISHABLE_KEY}|" /etc/qorpera/lxd-company-provider.env
sed -i "s|REPLACE_WITH_ORCHESTRATOR_TO_PROVIDER_CAPABILITY|$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')|" /etc/qorpera/lxd-company-provider.env
sed -i "s|REPLACE_WITH_64_HEX_GUEST_PACKAGE_MANIFEST_DIGEST|93d06dc159d162e0bb50d433000b51f32aa44f616ea42ebeb5c6f4f2db0bb3a9|; s|REPLACE_WITH_DIGEST_PINNED_RUNNER_IMAGE|localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1|; s|REPLACE_WITH_64_HEX_ARCHIVE_DIGEST|c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239|; s|REPLACE_WITH_64_HEX_BUNDLE_DIGEST|98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce|" /etc/qorpera/lxd-company-provider.env
if grep -q "REPLACE_WITH" /etc/qorpera/lxd-company-provider.env; then
	echo "environment still holds REPLACE_WITH markers (fingerprint fills in round C)"
fi
echo "OP-A-DONE"
