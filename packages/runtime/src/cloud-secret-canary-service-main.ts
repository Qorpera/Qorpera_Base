import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCloudSecretBrokerServiceMain } from "./cloud-secret-broker-service-main.ts";
import { createStep2SecretCanaryAdapter } from "./cloud-secret-canary-adapter.ts";

export function runStep2SecretCanaryBrokerServiceMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	return runCloudSecretBrokerServiceMain(environment, [createStep2SecretCanaryAdapter()]);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.length === 3 && process.argv[2] === "--describe") {
		console.log("Qorpera Step 2 secret-custody canary broker; fixed adapter only.");
	} else {
		runStep2SecretCanaryBrokerServiceMain().catch(() => {
			console.error("The Step 2 secret-custody canary broker could not start or continue.");
			process.exitCode = 1;
		});
	}
}
