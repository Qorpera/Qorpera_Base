import { collectRuntimeNodeHealth } from "./runtime-node-health.ts";
import { runRuntimeNodeObserver } from "./runtime-node-observer-service.ts";

const CODE = /^[A-Z][A-Z0-9_]{1,127}$/;
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
if (process.argv.length === 3 && process.argv[2] === "--health-probe") {
	collectRuntimeNodeHealth(controller.signal)
		.then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
		.catch((error: unknown) => {
			// The observer ignores the probe's stderr. Someone running the probe by
			// hand sees the closed code that stopped it, never an error's text.
			const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
			const reason = [message, code].find((value) => typeof value === "string" && CODE.test(value));
			process.stderr.write(`NODE_HEALTH_COLLECTION_UNCONFIRMED${reason ? ` ${reason}` : ""}\n`);
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
			process.stdout.write(`${JSON.stringify({ event: "node_agent_exit", state })}\n`);
		},
	).catch(() => {
		process.stderr.write("NODE_OBSERVER_STARTUP_UNCONFIRMED\n");
		process.exitCode = 1;
	});
}
