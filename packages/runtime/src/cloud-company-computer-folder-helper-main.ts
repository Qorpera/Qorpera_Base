import { realpathSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CompanyComputerFolderHelper,
	createCompanyComputerFolderHelperServer,
	createLinuxCompanyComputerFolderHelperSystem,
} from "./cloud-company-computer-folder-helper.ts";

/** qorpera-office-folder-helper.service: root, in PID 1's mount namespace, on the socket systemd passes. */
export async function runCompanyComputerFolderHelperMain(): Promise<void> {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getgid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("COMPANY_COMPUTER_FOLDER_HELPER_ROOT_REQUIRED");
	// A mount made in a namespace of the helper's own would reach no desktop and no command.
	if ((await readlink("/proc/self/ns/mnt")) !== (await readlink("/proc/1/ns/mnt")))
		throw new Error("COMPANY_COMPUTER_FOLDER_HELPER_NAMESPACE_CHANGED");
	if (process.env.LISTEN_FDS !== "1" || process.env.LISTEN_PID !== String(process.pid))
		throw new Error("COMPANY_COMPUTER_FOLDER_HELPER_SOCKET_REQUIRED");
	const helper = new CompanyComputerFolderHelper(createLinuxCompanyComputerFolderHelperSystem());
	await helper.prepare();
	const server = createCompanyComputerFolderHelperServer(helper);
	server.listen({ fd: 3 }, () => console.error("folder-helper: serving on the socket from systemd"));
	// The mounts are their own units and stay; a request cut short leaves its name held, for `list` and `drop`.
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 5000).unref();
		});
}

if (
	process.argv[1] &&
	["cloud-company-computer-folder-helper-main.ts", "qorpera-company-computer-folder-helper.mjs"].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log("The office's company folder helper. Requires root and qorpera-office-folder-helper.socket.");
	} else if (process.argv.length !== 2) {
		console.error("The folder helper accepts only --help.");
		process.exitCode = 1;
	} else {
		runCompanyComputerFolderHelperMain().catch((error) => {
			console.error(`folder-helper: ${error instanceof Error ? error.message : "failed"}`);
			process.exitCode = 1;
		});
	}
}
