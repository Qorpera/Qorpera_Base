import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

/** Synthetic VM effects selected by the actual unresolved dispatch and its
 * exact retained seed. Historical operations remain independently pollable. */
export function officeVmOperationHttpFixture(
	root: string,
	action: "start" | "stop",
	firstOperationId: string,
	boot?: () => void,
) {
	const prefix = action === "start" ? "resume-request-" : "power-off-request-";
	const operations = new Map<string, { polls: number; instanceName: string }>();
	const commands = new Set<string>();
	let posts = 0,
		polls = 0;
	return {
		counts: () => ({ posts, polls }),
		async handle(
			method: string | undefined,
			url: string,
			body: Buffer,
			instance: Record<string, unknown>,
			response: ServerResponse,
		) {
			const send = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			const metadata = (id: string, name: string) => ({
				id,
				class: "task",
				status: "Success",
				status_code: 200,
				err: "",
				resources: {},
				metadata: { entity_url: `/1.0/instances/${name}?project=offices` },
			});
			if (
				method === "PUT" &&
				url === `/1.0/instances/${instance.name}/state?project=offices` &&
				JSON.parse(body.toString()).action === action
			) {
				const matches = [];
				const seeds = (await readdir(root)).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
				if (action === "start" && seeds.length === 0) return false;
				for (const name of seeds) {
					const seed = JSON.parse(await readFile(join(root, name), "utf8"));
					const journal = join(root, seed.binding.allocationId);
					const names = (await readdir(journal)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
					const event = JSON.parse(await readFile(join(journal, names.at(-1)!), "utf8"));
					const commandId = action === "start" ? seed.startCommandId : seed.commandId;
					if (event.kind === "dispatch" && event.action === action && event.commandId === commandId)
						matches.push(commandId);
				}
				assert.equal(matches.length, 1);
				assert(!commands.has(matches[0]), "a VM command was submitted twice");
				commands.add(matches[0]);
				const request = JSON.parse(body.toString());
				assert.equal(request.force, false);
				assert.equal(request.stateful, false);
				assert.equal(instance.status, action === "start" ? "Stopped" : "Running");
				const operationId = posts++ === 0 ? firstOperationId : randomUUID();
				instance.status = action === "start" ? "Running" : "Stopped";
				instance.status_code = action === "start" ? 103 : 102;
				if (action === "start") boot?.();
				operations.set(operationId, { polls: 0, instanceName: String(instance.name) });
				send(202, {
					type: "async",
					status_code: 100,
					operation: `/1.0/operations/${operationId}`,
					metadata: metadata(operationId, String(instance.name)),
				});
				return true;
			}
			const parsed = new URL(url, "http://fixture"),
				id = parsed.pathname.slice("/1.0/operations/".length);
			const operation =
				method === "GET" && parsed.pathname.startsWith("/1.0/operations/") ? operations.get(id) : undefined;
			if (operation) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				polls++;
				if (++operation.polls === 1) response.destroy();
				else send(200, { type: "sync", status_code: 200, metadata: metadata(id, operation.instanceName) });
				return true;
			}
			if (
				action === "stop" &&
				posts &&
				method === "GET" &&
				url === `/1.0/instances/${instance.name}/state?project=offices`
			) {
				send(200, {
					type: "sync",
					status_code: 200,
					metadata: { status: instance.status, status_code: instance.status_code, network: {} },
				});
				return true;
			}
			return false;
		},
	};
}
