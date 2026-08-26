#!/usr/bin/env bash
set -euo pipefail
# Step 3 first machine — operator round D: install the signed provenance,
# start the company provider, provision the machine.
if [[ ${EUID} -ne 0 ]]; then echo "Run through sudo." >&2; exit 1; fi

# The stuck op-c never patched the environment; the image facts land here.
sed -i "s|REPLACE_AFTER_IMAGE_SIGNING|efe890d30817243af4466b7a4b00d802c46d55514e3eb7a5ffcb4e9d05229b2f|; s|3f142af55d20862413dc03143a384d8329802b732d03549fa2fbd760fcfcb89f|acd2cd013361a66fdd56e61b30ecaa3807c8da0610db33ba48b3c6a660fbb1f0|" /etc/qorpera/lxd-company-provider.env
install -o root -g qorpera-provider -m 0640 /home/company41-admin/step3-lxd/lxd-company-image-provenance.json /etc/qorpera/lxd-company-image-provenance.json
systemctl enable --now qorpera-lxd-company-provider.service
systemctl restart qorpera-lxd-company-provider.service
sleep 3
systemctl --no-pager --full status qorpera-lxd-company-provider.service | head -12
systemd-run --wait --pipe \
	--property=User=qorpera-provider --property=Group=qorpera-provider \
	--property=SupplementaryGroups=lxd \
	--property=EnvironmentFile=/etc/qorpera/lxd-company-provider.env \
	/usr/bin/node --jitless /opt/qorpera/company-provider/qorpera-lxd-provider.mjs provision 6d9da3a0-f09b-4d63-b79b-8a3aad7919d9
lxc list --project qorpera-runners
echo "OP-D-DONE"
