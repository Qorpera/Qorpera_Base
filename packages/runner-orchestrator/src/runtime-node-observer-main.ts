import { collectRuntimeNodeHealth } from "./runtime-node-health.ts";
import { runtimeNodeObserverCode } from "./runtime-node-observer.ts";
import { runRuntimeNodeObserver, runtimeNodeObserverLine } from "./runtime-node-observer-service.ts";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
if (process.argv.length === 3 && process.argv[2] === "--health-probe") {
	collectRuntimeNodeHealth(controller.signal)
		.then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
		.catch((error: unknown) => {
			// The observer reads this one line (collectRuntimeNodeHealthProcess) and logs its code. Someone running
			// the probe by hand sees the same: the closed code that stopped it, never an error's text.
			process.stderr.write(`NODE_HEALTH_COLLECTION_UNCONFIRMED ${runtimeNodeObserverCode(error)}\n`);
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
		(state, reason) => {
			process.stdout.write(runtimeNodeObserverLine("node_inventory", state, reason));
		},
		(state, reason) => {
			process.stdout.write(runtimeNodeObserverLine("node_health", state, reason));
		},
		(state, reason) => {
			process.stdout.write(runtimeNodeObserverLine("node_agent_exit", state, reason));
		},
	).catch(() => {
		process.stderr.write("NODE_OBSERVER_STARTUP_UNCONFIRMED\n");
		process.exitCode = 1;
	});
}
