#!/usr/bin/env bash
set -euo pipefail
# Step 3 first machine — operator round D: install the signed provenance,
# replace the diagnostic root, provision the machine, start the provider.
if [[ ${EUID} -ne 0 ]]; then echo "Run through sudo." >&2; exit 1; fi

logical_computer_id=6d9da3a0-f09b-4d63-b79b-8a3aad7919d9
instance_name=qorpera-cc-6d9da3a0f09b4d63b79b8a3aad7919d9
previous_image_fingerprint=efe890d30817243af4466b7a4b00d802c46d55514e3eb7a5ffcb4e9d05229b2f
journal_path=/var/lib/qorpera-company-provider/computers/${logical_computer_id}/journal.json

# Refresh the provider artifact (the nodeHttpFetch control-plane fix),
# fail-closed on its checksum exactly like the installer.
staged_artifact=/home/company41-admin/step3-lxd/qorpera-lxd-provider.mjs
if [[ $(sha256sum "${staged_artifact}" | awk '{ print $1 }') != "212f2d2c0582831b45b187c22454df4c11f4348839492858d5eb1f5ed3b45b7e" ]]; then
	echo "Staged provider artifact checksum mismatch." >&2
	exit 1
fi
install -o root -g root -m 0555 "${staged_artifact}" /opt/qorpera/company-provider/qorpera-lxd-provider.mjs

fp=$(awk -F= '/^image_fingerprint=/ { print $2 }' /var/log/qorpera-lxd-company-computer-image-candidate.txt)
if [[ ! ${fp} =~ ^[0-9a-f]{64}$ ]]; then echo "No image fingerprint in the build state log." >&2; exit 1; fi
sed -i -E \
	"s|^QORPERA_LXD_IMAGE_FINGERPRINT=.*$|QORPERA_LXD_IMAGE_FINGERPRINT=${fp}|; s|^QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=.*$|QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256=93d06dc159d162e0bb50d433000b51f32aa44f616ea42ebeb5c6f4f2db0bb3a9|" \
	/etc/qorpera/lxd-company-provider.env
install -o root -g qorpera-provider -m 0640 /home/company41-admin/step3-lxd/lxd-company-image-provenance.json /etc/qorpera/lxd-company-image-provenance.json

# The diagnostic VM predates this image fix. Preserve every durable external
# asset and reset only its disposable root, with an exact journal backup for
# operator recovery. Re-runs accept both sides of the guarded transition.
systemctl stop qorpera-lxd-company-provider.service
if [[ -f ${journal_path} ]]; then
	if ! /usr/bin/jq -e \
		--arg logical "${logical_computer_id}" \
		--arg instance "${instance_name}" \
		--arg previous "${previous_image_fingerprint}" \
		--arg current "${fp}" \
		'.schema == "qorpera.lxd-company-computer-journal/v1" and
		 .logicalComputerId == $logical and
		 .instanceName == $instance and
		 (.activeAssignment == null) and
		 (.lxd.imageFingerprint == $previous or .lxd.imageFingerprint == $current)' \
		"${journal_path}" >/dev/null; then
		echo "Refusing to replace an unexpected or assigned Company Computer journal." >&2
		exit 1
	fi
	journal_fingerprint=$(/usr/bin/jq -r '.lxd.imageFingerprint' "${journal_path}")
	journal_state=$(/usr/bin/jq -r '.physicalState' "${journal_path}")
	instance_fingerprint=absent
	if lxc info "${instance_name}" --project qorpera-runners >/dev/null 2>&1; then
		instance_fingerprint=$(lxc config get "${instance_name}" volatile.base_image --project qorpera-runners)
	fi

	if [[ ${journal_fingerprint} == "${previous_image_fingerprint}" ]]; then
		if [[ ${instance_fingerprint} != absent && ${instance_fingerprint} != "${previous_image_fingerprint}" ]]; then
			echo "Refusing to replace a Company Computer instance with an unexpected base image." >&2
			exit 1
		fi
		if ! lxc image info "${previous_image_fingerprint}" --project qorpera-runners >/dev/null 2>&1; then
			echo "The previous image needed for rollback is missing." >&2
			exit 1
		fi
		journal_backup=${journal_path}.pre-image-${previous_image_fingerprint}
		if [[ -e ${journal_backup} ]]; then
			if ! cmp -s "${journal_path}" "${journal_backup}"; then
				echo "The existing Company Computer journal backup does not match." >&2
				exit 1
			fi
		else
			install -o qorpera-provider -g qorpera-provider -m 0600 "${journal_path}" "${journal_backup}"
		fi
		if [[ ${instance_fingerprint} != absent ]]; then
			lxc delete -f "${instance_name}" --project qorpera-runners
			echo "removed disposable diagnostic VM root from ${previous_image_fingerprint}"
		fi
		journal_tmp=$(mktemp "${journal_path}.replacement.XXXXXX")
		/usr/bin/jq --arg fingerprint "${fp}" \
			'.physicalState = "creating" |
			 .lxd.imageFingerprint = $fingerprint |
			 del(.guestAddress, .activeAssignment, .lastStopReason, .screensIdleSince)' \
			"${journal_path}" >"${journal_tmp}"
		install -o qorpera-provider -g qorpera-provider -m 0600 "${journal_tmp}" "${journal_path}"
		rm -f -- "${journal_tmp}"
	elif [[ ${instance_fingerprint} == "${previous_image_fingerprint}" && ${journal_state} == creating ]]; then
		# Resume safely if the previous run wrote the new journal before the
		# old root could be removed.
		lxc delete -f "${instance_name}" --project qorpera-runners
		echo "removed disposable diagnostic VM root from ${previous_image_fingerprint}"
	elif [[ ${instance_fingerprint} != absent && ${instance_fingerprint} != "${fp}" ]]; then
		echo "The Company Computer instance does not match the signed image." >&2
		exit 1
	elif [[ ${instance_fingerprint} == absent && ${journal_state} != creating ]]; then
		echo "The signed-image journal unexpectedly names no instance." >&2
		exit 1
	fi
elif lxc info "${instance_name}" --project qorpera-runners >/dev/null 2>&1; then
	echo "Refusing to adopt a Company Computer instance without its durable journal." >&2
	exit 1
fi

systemd-run --wait --pipe \
	--property=User=qorpera-provider --property=Group=qorpera-provider \
	--property=SupplementaryGroups=lxd \
	--property=EnvironmentFile=/etc/qorpera/lxd-company-provider.env \
	/usr/bin/node --jitless /opt/qorpera/company-provider/qorpera-lxd-provider.mjs provision "${logical_computer_id}"
systemctl enable --now qorpera-lxd-company-provider.service
sleep 3
systemctl --no-pager --full status qorpera-lxd-company-provider.service | head -12
lxc list --project qorpera-runners
echo "OP-D-DONE"
