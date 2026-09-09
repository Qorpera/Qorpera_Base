import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
	COMPANY_COMPUTER_BOOTS_ROOT,
	type CompanyComputerPreparationCommand,
	companyComputerBootDirectory,
} from "@qorpera/contracts";
import { assertCompanyComputerImageArtifact } from "./cloud-company-computer-linux-host.ts";
import { assertCompanyComputerPreparationLockAndBoot } from "./cloud-company-computer-preparation-control.ts";

/** Fixed root-disk paths selected by actual boot identity, with no current/latest
 * link. Receipts may be public within a boot directory; credentials remain 0700.
 * Creation is allowed only before configuration acknowledgement. */
export async function assertCompanyComputerBootCredentials(command: CompanyComputerPreparationCommand, create = false) {
	await assertCompanyComputerPreparationLockAndBoot(command);
	const boot = companyComputerBootDirectory(command.bootId);
	const anchor = await lstat("/etc/qorpera-office");
	for (const [path, mode] of [
		[COMPANY_COMPUTER_BOOTS_ROOT, 0o755],
		[boot, 0o755],
		[`${boot}/credentials`, 0o700],
	] as const) {
		await assertCompanyComputerImageArtifact(dirname(path), true);
		const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			if ((await realpath(`/proc/self/fd/${parent.fd}`)) !== dirname(path)) throw new Error("boot parent changed");
			if (create) {
				try {
					await mkdir(`/proc/self/fd/${parent.fd}/${basename(path)}`, { mode });
					const created = await open(
						`/proc/self/fd/${parent.fd}/${basename(path)}`,
						constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
					);
					try {
						await created.chmod(mode);
						await created.sync();
					} finally {
						await created.close();
					}
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
				}
			}
			await assertCompanyComputerImageArtifact(path, true);
			const stat = await lstat(path),
				retained = await lstat(`/proc/self/fd/${parent.fd}/${basename(path)}`);
			if (
				stat.uid !== 0 ||
				stat.gid !== 0 ||
				(stat.mode & 0o7777) !== mode ||
				stat.dev !== anchor.dev ||
				stat.dev !== retained.dev ||
				stat.ino !== retained.ino
			)
				throw new Error("boot directory custody");
			if (create) await parent.sync();
		} finally {
			await parent.close();
		}
	}
	await assertCompanyComputerPreparationLockAndBoot(command);
	return `${boot}/credentials`;
}
