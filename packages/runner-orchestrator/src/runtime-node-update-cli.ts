import { runNodeUpdateOnce } from "./runtime-node-update-service.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log(
		"Usage: qorpera-node-updater --once --config /etc/qorpera/node-updater/service.json\nRequires independently enrolled root-owned configuration, a process-owned kernel flock and signed exact successor targets. Performs one bounded reconciliation; never applies migrations, updates guest images or enrolls credentials.",
	);
} else if (args.length === 3 && args[0] === "--once" && args[1] === "--config") {
	const controller = new AbortController();
	process.once("SIGINT", () => controller.abort());
	process.once("SIGTERM", () => controller.abort());
	runNodeUpdateOnce(args[2]!, controller.signal)
		.then((result) => console.log(JSON.stringify(result)))
		.catch((error: unknown) => {
			const code =
				error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)
					? error.message
					: "NODE_UPDATE_RECONCILIATION_UNCONFIRMED";
			console.error(code);
			process.exitCode = 1;
		});
} else {
	console.error("NODE_UPDATE_USAGE_INVALID");
	process.exitCode = 2;
}
