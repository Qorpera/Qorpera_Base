import { runNodeObserverInstallation } from "./runtime-node-observer-installation-host.ts";

const [stage, option, path, ...extra] = process.argv.slice(2);
if (!["--check", "--apply", "--commit"].includes(stage ?? "") || option !== "--spec" || !path || extra.length) {
	console.error("NODE_OBSERVER_INSTALL_ARGUMENTS_INVALID");
	process.exitCode = 2;
} else
	runNodeObserverInstallation(stage as "--check" | "--apply" | "--commit", path).catch((error) => {
		console.error(
			error instanceof Error && /^NODE_OBSERVER_INSTALL_[A-Z_]+$/.test(error.message)
				? error.message
				: "NODE_OBSERVER_INSTALL_UNCONFIRMED",
		);
		process.exitCode = 1;
	});
