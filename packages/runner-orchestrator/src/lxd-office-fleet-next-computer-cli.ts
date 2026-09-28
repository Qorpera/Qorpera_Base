#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type OfficeInstalledDocuments, planOfficeNextComputer } from "./lxd-office-fleet-next-computer.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "./lxd-office-lifecycle-service.ts";

/** Prints the plan for a company's next Company Computer on this host. Reads
 * the service documents of the offices installed here (the template and every
 * other) and the documents they name; writes nothing. The root operator
 * publishes the files and runs the listed steps. Errors print a fixed code only:
 * a message could quote bytes of a file read by mistake. */
const [request, ...extra] = process.argv.slice(2);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;
async function documents(servicePath: unknown): Promise<OfficeInstalledDocuments> {
	if (typeof servicePath !== "string" || !servicePath.startsWith("/"))
		throw new Error("OFFICE_NEXT_COMPUTER_REQUEST_INVALID");
	const service = await json(servicePath);
	const parsed = parseLxdOfficeLifecycleServiceConfig(service);
	return {
		servicePath,
		service,
		policy: await json(parsed.policyPath),
		...(parsed.passthroughPath === undefined ? {} : { passthrough: await json(parsed.passthroughPath) }),
	};
}
/** The template's layout, from its lifecycle plan: layout 2 names a company root. */
async function layout(servicePath: string): Promise<1 | 2> {
	const plan = (await json(parseLxdOfficeLifecycleServiceConfig(await json(servicePath)).planPath)) as {
		input?: { shared?: object };
	};
	if (!plan?.input?.shared || typeof plan.input.shared !== "object")
		throw new Error("OFFICE_NEXT_COMPUTER_LAYOUT_UNKNOWN");
	return Object.hasOwn(plan.input.shared, "company") ? 2 : 1;
}
if (!request?.startsWith("/") || extra.length) {
	process.stderr.write("Usage: qorpera-office-next-computer /absolute/request.json\n");
	process.exitCode = 2;
} else {
	void (async () => {
		const input = officeRecord(await json(request), ["template", "others", "office", "host"]);
		const template = officeRecord(input.template, ["servicePath"]);
		if (!Array.isArray(input.others)) throw new Error("OFFICE_NEXT_COMPUTER_REQUEST_INVALID");
		const host = { ...(input.host as Record<string, unknown>) };
		host.adoptionId ??= randomUUID();
		host.layout ??= await layout(String(template.servicePath));
		const plan = planOfficeNextComputer({
			template: await documents(template.servicePath),
			others: await Promise.all(input.others.map((path) => documents(path))),
			office: input.office as never,
			host: host as never,
		});
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
	})().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "";
		process.stderr.write(
			`${/^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "OFFICE_NEXT_COMPUTER_UNCONFIRMED"}\n`,
		);
		process.exitCode = 1;
	});
}
