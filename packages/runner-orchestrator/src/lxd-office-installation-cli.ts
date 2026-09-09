#!/usr/bin/env node
import { runOfficeProviderInstallation } from "./lxd-office-installation-host.ts";

const [stage, option, path, ...extra] = process.argv.slice(2);
if (
	!["--check", "--apply", "--prepare", "--commit"].includes(stage ?? "") ||
	option !== "--spec" ||
	!path ||
	extra.length
) {
	console.error("OFFICE_INSTALL_ARGUMENTS_INVALID");
	process.exitCode = 2;
} else {
	void runOfficeProviderInstallation(stage as "--check" | "--apply" | "--prepare" | "--commit", path).catch(
		(error) => {
			const message =
				error instanceof Error && /^OFFICE_INSTALL_[A-Z_]+$/.test(error.message)
					? error.message
					: "OFFICE_INSTALL_UNCONFIRMED";
			console.error(message);
			process.exitCode = 1;
		},
	);
}
