#!/usr/bin/env node
import {
	type LxdOfficeSoftwareUpdateStep,
	OFFICE_SOFTWARE_UPDATE_STEPS,
	runLxdOfficeSoftwareUpdate,
} from "./lxd-office-software-update.ts";

const USAGE = `Usage: qorpera-office-software-update --config /absolute/protected/update.json enroll --evidence-sha256 <64 hex>
       qorpera-office-software-update --config /absolute/protected/update.json begin|stage|install|status
One governed service-only revision step per invocation, never a loop or a retry.
Run as the provider user under the lifecycle's journal flock (adoption.lock) while the ordinary provider service is stopped.
`;
const CODES = /^OFFICE_SOFTWARE_UPDATE_[A-Z_]+$/;

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(USAGE);
		return;
	}
	const step = args[2] as LxdOfficeSoftwareUpdateStep;
	const evidence = args.length === 5 && args[3] === "--evidence-sha256" ? args[4] : undefined;
	if (
		args[0] !== "--config" ||
		!args[1]?.startsWith("/") ||
		!OFFICE_SOFTWARE_UPDATE_STEPS.includes(step) ||
		(step === "enroll" ? args.length !== 5 || !/^[0-9a-f]{64}$/.test(evidence ?? "") : args.length !== 3)
	) {
		process.stderr.write("OFFICE_SOFTWARE_UPDATE_ARGUMENTS_INVALID\n");
		process.exitCode = 2;
		return;
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		const result = await runLxdOfficeSoftwareUpdate(args[1], step, evidence, controller.signal);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error && CODES.test(error.message) ? error.message : "OFFICE_SOFTWARE_UPDATE_UNCONFIRMED"}\n`,
		);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}
void main();
