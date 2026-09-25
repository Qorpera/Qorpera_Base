import { collectRuntimeNodeHealth } from "./runtime-node-health.ts";
import { runRuntimeNodeObserver } from "./runtime-node-observer-service.ts";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
if (process.argv.length === 3 && process.argv[2] === "--health-probe") {
	collectRuntimeNodeHealth(controller.signal)
		.then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
		.catch(() => {
			process.stderr.write("NODE_HEALTH_COLLECTION_UNCONFIRMED\n");
			process.exitCode = 1;
		});
} else {
	if (process.argv.length !== 2) {
		if (process.argv.length === 3 && process.argv[2] === "--help") {
			process.stdout.write(
				"Qorpera headless node observer. Reads /etc/qorpera/node-observer.json and the separate protected node-observer.key; never enrolls policy or mutates VMs.\n",
			);
			process.exit(0);
		}
		process.stderr.write("NODE_OBSERVER_ARGUMENTS_INVALID\n");
		process.exit(2);
	}
	runRuntimeNodeObserver(
		controller.signal,
		(state) => {
			process.stdout.write(`${JSON.stringify({ event: "node_inventory", state })}\n`);
		},
		(state) => {
			process.stdout.write(`${JSON.stringify({ event: "node_health", state })}\n`);
		},
		(state) => {
			process.stdout.write(`${JSON.stringify({ event: "computer_usage_shadow", state })}\n`);
		},
	).catch(() => {
		process.stderr.write("NODE_OBSERVER_STARTUP_UNCONFIRMED\n");
		process.exitCode = 1;
	});
}
