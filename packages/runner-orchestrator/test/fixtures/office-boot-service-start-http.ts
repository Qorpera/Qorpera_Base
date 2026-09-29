import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	type CompanyComputerStartupIdentity,
	companyComputerBootDirectory,
	parseCompanyComputerBootServiceStartRequest,
} from "@qorpera/contracts";

/** Synthetic root service behind actual Unix HTTP and provider journals.
 * The independent Linux/systemd acceptance runs the production root helpers.
 * Readiness here uses the actual disposable SQL registry. */
export function officeBootServiceStartHttpFixture(
	root: string,
	files: Map<string, { content: Buffer; mode: string }>,
	ready: (
		identity: CompanyComputerStartupIdentity,
		activationId: string,
		nativePort: number,
		viewerPort: number,
	) => Promise<void>,
) {
	const operations = new Map<string, Record<string, unknown>>();
	const started = new Set<string>();
	const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	let starts = 0,
		inspections = 0,
		uploads = 0;
	return {
		counts: () => ({ starts, inspections, uploads }),
		async handle(
			method: string | undefined,
			url: string,
			headers: IncomingHttpHeaders,
			body: Buffer,
			instanceName: string,
			response: ServerResponse,
		): Promise<boolean> {
			const parsed = new URL(url, "http://fixture");
			const send = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			const path = parsed.searchParams.get("path");
			if (
				parsed.pathname === `/1.0/instances/${instanceName}/files` &&
				path?.startsWith("/run/qorpera-office-preparation/boot-service-")
			) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				if (method === "POST") {
					assert.equal(path, `/run/qorpera-office-preparation/boot-service-start-incoming-${hash(body)}.json`);
					assert.equal(headers["x-lxd-uid"], "0");
					assert.equal(headers["x-lxd-gid"], "0");
					assert.equal(headers["x-lxd-mode"], "0400");
					parseCompanyComputerBootServiceStartRequest(JSON.parse(body.toString()));
					files.set(path, { content: body, mode: "0400" });
					uploads++;
					send(200, { type: "sync", status_code: 200, metadata: {} });
					return true;
				}
				assert.equal(method, "GET");
				const file = files.get(path);
				if (!file) {
					send(404, { error: "absent" });
					return true;
				}
				response.writeHead(200, {
					"content-type": "application/octet-stream",
					"x-lxd-type": "file",
					"x-lxd-uid": "0",
					"x-lxd-gid": "0",
					"x-lxd-mode": file.mode,
				});
				response.end(file.content);
				return true;
			}
			if (method === "POST" && url === `/1.0/instances/${instanceName}/exec?project=offices`) {
				const exec = JSON.parse(body.toString()),
					argv = exec.command;
				if (!argv?.includes("/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs"))
					return false;
				assert([7, 8].includes(argv.length));
				const staged = files.get(`/run/qorpera-office-preparation/boot-service-start-incoming-${argv[5]}.json`)!;
				assert.equal(hash(staged.content), argv[5]);
				const request = parseCompanyComputerBootServiceStartRequest(JSON.parse(staged.content.toString()));
				const { attestation, predecessor } = request.successor.request;
				const allocationId = predecessor.startup.allocationId;
				const suffix = `${allocationId}-${attestation.activationId}`;
				const retained = JSON.parse(
					await readFile(join(root, `boot-service-start-request-${suffix}.json`), "utf8"),
				);
				assert.deepEqual(retained.request, request);
				assert.deepEqual(exec, {
					command: [
						"/usr/bin/env",
						"-i",
						"/usr/bin/node",
						"/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs",
						retained.command.commandId,
						retained.command.requestSha256,
						retained.command.bootId,
						...(argv.length === 8 ? [argv[7]] : []),
					],
					environment: {},
					"wait-for-websocket": false,
					interactive: false,
					"record-output": true,
					user: 0,
					group: 0,
					cwd: "/",
				});
				const completionPath = "/run/qorpera-office-preparation/boot-service-start-completion.json";
				if (argv.length === 7) {
					const dispatch = JSON.parse(
						await readFile(join(root, `boot-service-start-${suffix}`, "000000.json"), "utf8"),
					);
					assert.equal(dispatch.kind, "dispatch");
					assert.equal(files.has(completionPath), false);
					assert(!started.has(retained.command.commandId));
					started.add(retained.command.commandId);
					starts++;
					const configBytes = files.get(
						`${companyComputerBootDirectory(attestation.bootId)}/credentials/config.json`,
					)!.content;
					assert.equal(hash(configBytes), attestation.configurationSha256);
					const config = JSON.parse(configBytes.toString()),
						binding = config.linux.attestation;
					const completion = {
						schema: "qorpera.office-boot-service-start-completion/v1",
						command: retained.command,
						bootIntentId: request.successor.request.bootIntentId,
						activationId: attestation.activationId,
						configurationCompletionSha256: request.configurationCompletionSha256,
						configurationSha256: attestation.configurationSha256,
						serviceInvocationId: randomUUID().replaceAll("-", ""),
						mainPid: 700,
						controlGroup: "/system.slice/qorpera-company-computer.service",
					};
					files.set(completionPath, { mode: "0600", content: Buffer.from(`${JSON.stringify(completion)}\n`) });
					files.set("/run/qorpera-office-preparation/boot-service-start-claim.json", {
						mode: "0600",
						content: Buffer.from(
							JSON.stringify({
								schema: "qorpera.office-boot-service-start-claim/v1",
								command: retained.command,
								bootIntentId: request.successor.request.bootIntentId,
								activationId: attestation.activationId,
								configurationCompletionSha256: request.configurationCompletionSha256,
							}),
						),
					});
					await ready(
						{
							scope: config.scope,
							computerGeneration: config.computerGeneration,
							allocationId: binding.allocationId,
							instanceSha256: binding.instanceSha256,
							imageSha256: binding.imageSha256,
							bootstrapSha256: binding.bootstrapSha256,
							bootId: binding.bootId,
							configurationSha256: attestation.configurationSha256,
							serviceInvocationId: completion.serviceInvocationId,
						},
						attestation.activationId,
						config.native.port,
						config.viewer.port,
					);
					response.destroy(); // Lost reply after physical start and committed SQL readiness.
					return true;
				}
				const inspectionId = argv[7];
				const dispatch = JSON.parse(
					await readFile(join(root, `boot-service-inspection-${allocationId}-${inspectionId}.json`), "utf8"),
				);
				assert.equal(dispatch.inspectionId, inspectionId);
				assert.deepEqual(dispatch.command, retained.command);
				const completion = JSON.parse(files.get(completionPath)!.content.toString());
				assert.deepEqual(dispatch.completion, completion);
				files.set(`/run/qorpera-office-preparation/boot-service-inspection-${inspectionId}.json`, {
					mode: "0600",
					content: Buffer.from(
						JSON.stringify({
							schema: "qorpera.office-boot-service-inspection/v1",
							inspectionId,
							start: completion,
						}),
					),
				});
				inspections++;
				assert.equal(
					(await readdir(root)).filter((name) => /^boot-service-inspection-.*-accepted\.json$/.test(name)).length,
					inspections - 1,
				);
				const operationId = randomUUID(),
					operation = {
						id: operationId,
						class: "task",
						status: "Success",
						status_code: 200,
						err: "",
						resources: {},
						metadata: { entity_url: `/1.0/instances/${instanceName}?project=offices`, return: 0 },
					};
				operations.set(operationId, operation);
				send(202, {
					type: "async",
					status_code: 100,
					operation: `/1.0/operations/${operationId}`,
					metadata: operation,
				});
				return true;
			}
			if (method === "GET" && parsed.pathname.startsWith("/1.0/operations/")) {
				const operation = operations.get(parsed.pathname.slice("/1.0/operations/".length));
				if (operation) {
					assert.equal(parsed.searchParams.get("project"), "offices");
					send(200, { type: "sync", status_code: 200, metadata: operation });
					return true;
				}
			}
			return false;
		},
	};
}
