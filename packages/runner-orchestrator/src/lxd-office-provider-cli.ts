#!/usr/bin/env node
import { runLxdOfficeDeleteMetadataCommand } from "./lxd-office-delete-metadata-command.ts";
import { runLxdOfficeLifecycleService } from "./lxd-office-lifecycle-service.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(
			"Usage: qorpera-office-provider --config /absolute/protected/service.json\n       qorpera-office-provider --journal-history /absolute/journal/root allocation-uuid\n       qorpera-office-provider --reconcile-delete-metadata /absolute/protected/service.json allocation-uuid audit-uuid\nRequires a dedicated Linux user and a process-owned journal flock for service work. History is read only. Metadata reconciliation is an internal root operator child requiring inherited installation and adoption locks and an existing protected SQL receipt.\n",
		);
	} else if (args.length === 3 && args[0] === "--journal-history" && args[1]?.startsWith("/")) {
		try {
			process.stdout.write(`${JSON.stringify(await LxdOfficeOperationJournal.readHistory(args[1], args[2]))}\n`);
		} catch {
			process.stderr.write("OFFICE_PROVIDER_HISTORY_UNCONFIRMED\n");
			process.exitCode = 1;
		}
	} else if (args.length === 4 && args[0] === "--reconcile-delete-metadata" && args[1]?.startsWith("/")) {
		try {
			process.stdout.write(
				`${JSON.stringify(await runLxdOfficeDeleteMetadataCommand(args[1], args[2], args[3]))}\n`,
			);
		} catch {
			process.stderr.write("OFFICE_DELETE_METADATA_UNCONFIRMED\n");
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
