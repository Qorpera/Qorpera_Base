#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { planOfficeNextComputer } from "./lxd-office-fleet-next-computer.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";

/** Prints the plan for a company's next Company Computer on this host. Reads
 * the company's installed computer's documents and writes nothing: the root
 * operator publishes the files and runs the listed steps. */
const [request, ...extra] = process.argv.slice(2);
if (!request?.startsWith("/") || extra.length) {
	process.stderr.write("Usage: qorpera-office-next-computer /absolute/request.json\n");
	process.exitCode = 2;
} else {
	void (async () => {
		const input = officeRecord(JSON.parse(await readFile(request, "utf8")), ["template", "office", "host"]);
		const paths = officeRecord(input.template, [
			"policyPath",
			"servicePath",
			...(input.template && Object.hasOwn(input.template, "passthroughPath") ? ["passthroughPath"] : []),
		]);
		const read = async (path: unknown) => JSON.parse(await readFile(String(path), "utf8"));
		const plan = planOfficeNextComputer({
			template: {
				policy: await read(paths.policyPath),
				service: await read(paths.servicePath),
				...(paths.passthroughPath === undefined ? {} : { passthrough: await read(paths.passthroughPath) }),
			},
			office: input.office as never,
			host: input.host as never,
		});
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
	})().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : "OFFICE_NEXT_COMPUTER_UNCONFIRMED"}\n`);
		process.exitCode = 1;
	});
}
