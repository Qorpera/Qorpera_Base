import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLxdOfficeDeleteDisposition } from "./lxd-office-delete-disposition.ts";
import { reconcileLxdOfficeDeleteMetadata } from "./lxd-office-delete-reconciliation.ts";
import { parseLxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import { OFFICE_PROVIDER_USER } from "./lxd-office-installation.ts";
import { officeInstallCommand, officeInstallLockFd, officeInstallParents } from "./lxd-office-installation-host.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "./lxd-office-lifecycle-service.ts";
import {
	assertLxdOfficeHostMount,
	assertLxdOfficeHostNamespace,
	readLxdOfficeProtectedFile,
} from "./lxd-office-physical-host.ts";
import { lxdOfficePhysicalPolicySha256, parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";

const INSTALL_LOCK = "/run/qorpera-office-provider-install/install.lock";

/** Internal child of the root operator runner. It inherits both kernel locks
 * and uses the dedicated provider UID to preserve journal file ownership.
 * Root performs fresh physical/SQL checks and retains the locks before this
 * metadata-only child is launched. This command cannot acquire the root lock,
 * publish an operator receipt, call SQL, or perform any VM/service mutation. */
export async function runLxdOfficeDeleteMetadataCommand(configPath: string, allocationId: string, auditId: string) {
	const uid = process.getuid?.(),
		gid = process.getgid?.();
	if (process.platform !== "linux" || !uid || !gid || uid !== process.geteuid?.() || gid !== process.getegid?.())
		throw new Error("OFFICE_DELETE_METADATA_PROVIDER_UID_REQUIRED");
	const account = officeInstallCommand("/usr/bin/getent", ["passwd", OFFICE_PROVIDER_USER]).split(":");
	if (
		account.length !== 7 ||
		Number(account[2]) !== uid ||
		Number(account[3]) !== gid ||
		account[5] !== "/nonexistent" ||
		account[6] !== "/usr/sbin/nologin"
	)
		throw new Error("OFFICE_DELETE_METADATA_ACCOUNT_DIFFERS");
	const assertProcessIdentity = async () => {
		const status = await readFile("/proc/self/status", "utf8");
		const field = (name: string) => {
			const rows = status.split("\n").filter((line) => line.startsWith(`${name}:`));
			if (rows.length !== 1) throw new Error("OFFICE_DELETE_METADATA_PROCESS_PRIVILEGED");
			return rows[0]!.slice(name.length + 1).trim();
		};
		if (
			field("Uid").split(/\s+/).join(",") !== [uid, uid, uid, uid].join(",") ||
			field("Gid").split(/\s+/).join(",") !== [gid, gid, gid, gid].join(",") ||
			field("Groups")
				.split(/\s+/)
				.some((value) => value !== "" && value !== String(gid)) ||
			["CapInh", "CapPrm", "CapEff", "CapAmb"].some((name) => !/^0{16}$/.test(field(name))) ||
			field("NoNewPrivs") !== "1"
		)
			throw new Error("OFFICE_DELETE_METADATA_PROCESS_PRIVILEGED");
	};
	await assertProcessIdentity();
	const readConfig = async () => {
		const encoded = await readLxdOfficeProtectedFile(configPath, 16384);
		const config = parseLxdOfficeLifecycleServiceConfig(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(encoded)),
		);
		const policy = parseLxdOfficePhysicalPolicy(
			JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(await readLxdOfficeProtectedFile(config.policyPath, 65536)),
			),
		);
		return { encoded, config, policy };
	};
	const loaded = await readConfig();
	const context = await readLxdOfficeDeleteDisposition(allocationId, auditId);
	const binding = parseLxdOfficeGuestBinding({
		...loaded.policy.guest,
		schema: "qorpera.lxd-office-guest/v2",
		allocationId,
		providerPolicySha256: lxdOfficePhysicalPolicySha256(loaded.policy),
	});
	if (officeDigest(binding) !== context.plan.providerBindingSha256)
		throw new Error("OFFICE_DELETE_METADATA_POLICY_DIFFERS");
	const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	if (!/^[0-9a-f-]{36}$/.test(boot)) throw new Error("OFFICE_DELETE_METADATA_HOST_NAMESPACE_REQUIRED");
	const namespace = await assertLxdOfficeHostNamespace(boot);
	const root = loaded.policy.journal.path;
	const assertBoundary = async () => {
		await assertProcessIdentity();
		await officeInstallParents(INSTALL_LOCK);
		await officeInstallLockFd(INSTALL_LOCK, 0);
		await officeInstallParents(root);
		await officeInstallLockFd(join(root, "adoption.lock"), uid);
		const stat = await lstat(root);
		if (stat.uid !== uid || stat.gid !== gid || !stat.isDirectory() || (stat.mode & 0o7777) !== 0o700)
			throw new Error("OFFICE_DELETE_METADATA_JOURNAL_CUSTODY_DIFFERS");
		const file = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			assertLxdOfficeHostMount(
				await readFile("/proc/self/mountinfo", "utf8"),
				await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8"),
				loaded.policy.journal,
				root,
			);
		} finally {
			await file.close();
		}
		if (
			!isDeepStrictEqual(await readConfig(), loaded) ||
			!isDeepStrictEqual(await readLxdOfficeDeleteDisposition(allocationId, auditId), context) ||
			(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== boot ||
			(await assertLxdOfficeHostNamespace(boot)) !== namespace
		)
			throw new Error("OFFICE_DELETE_METADATA_BOUNDARY_CHANGED");
		const state = officeInstallCommand("/usr/bin/systemctl", [
			"show",
			"qorpera-office-provider.service",
			"--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,UnitFileState",
		]);
		const fields = Object.fromEntries(
			state.split("\n").map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
		);
		if (
			fields.LoadState !== "loaded" ||
			fields.ActiveState !== "inactive" ||
			fields.SubState !== "dead" ||
			fields.MainPID !== "0" ||
			fields.ControlPID !== "0" ||
			fields.Job !== "" ||
			fields.UnitFileState !== "disabled"
		)
			throw new Error("OFFICE_DELETE_METADATA_PROVIDER_NOT_STOPPED");
	};
	return reconcileLxdOfficeDeleteMetadata(root, context, assertBoundary);
}
