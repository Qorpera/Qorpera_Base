#!/usr/bin/env node
import { runOfficeFleetService } from "./lxd-office-fleet-service.ts";

const [mode, config, ...extra] = process.argv.slice(2);
if (!config?.startsWith("/") || extra.length || (mode !== "--config" && mode !== "--stage")) {
	process.stderr.write("Usage: qorpera-office-fleet --config|--stage /absolute/protected/fleet.json\n");
	process.exitCode = 2;
} else {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	void runOfficeFleetService(config, controller.signal, mode === "--stage")
		.catch(() => {
			if (!controller.signal.aborted) {
				process.stderr.write("OFFICE_FLEET_UNCONFIRMED\n");
				process.exitCode = 1;
			}
		})
		.finally(() => {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
		});
}
