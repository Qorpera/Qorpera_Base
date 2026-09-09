#!/usr/bin/env node
import { runLxdOfficeLifecycleService } from "./lxd-office-lifecycle-service.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(
			"Usage: qorpera-office-provider --config /absolute/protected/service.json\n       qorpera-office-provider --journal-history /absolute/journal/root allocation-uuid\nRequires a dedicated Linux user and a process-owned journal flock for service work. History is read only.\n",
		);
	} else if (args.length === 3 && args[0] === "--journal-history" && args[1]?.startsWith("/")) {
		try {
			process.stdout.write(`${JSON.stringify(await LxdOfficeOperationJournal.readHistory(args[1], args[2]))}\n`);
		} catch {
			process.stderr.write("OFFICE_PROVIDER_HISTORY_UNCONFIRMED\n");
			process.exitCode = 1;
		}
	} else if (args.length !== 2 || args[0] !== "--config" || !args[1]?.startsWith("/")) {
		process.stderr.write("OFFICE_PROVIDER_ARGUMENTS_INVALID\n");
		process.exitCode = 2;
	} else {
		const controller = new AbortController();
		const stop = () => controller.abort();
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		try {
			await runLxdOfficeLifecycleService(args[1], controller.signal);
		} catch {
			process.stderr.write("OFFICE_PROVIDER_SERVICE_UNCONFIRMED\n");
			process.exitCode = 1;
		} finally {
			process.removeListener("SIGTERM", stop);
			process.removeListener("SIGINT", stop);
		}
	}
}
void main();
