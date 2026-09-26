import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	type CompanyComputerStartupIdentity,
	companyComputerBootDirectory,
	parseCompanyComputerBootServiceRestartRequest,
} from "@qorpera/contracts";
import { type OfficeHttpGuest, officeHttpGuestRead, officeHttpGuestRefresh } from "./office-http-guest.ts";

/** Actual Unix HTTP and journal assertions with optional actual root/systemd
 * measurements. The fixture reports measured readiness to disposable SQL. */
export function officeBootServiceRestartHttpFixture(
	root: string,
	files: Map<string, { content: Buffer; mode: string }>,
	ready: (
		identity: CompanyComputerStartupIdentity,
		activationId: string,
		nativePort: number,
		viewerPort: number,
	) => Promise<void>,
	guest?: OfficeHttpGuest,
) {
	const operations = new Map<string, Record<string, unknown>>();
	let starts = 0,
		inspections = 0,
		uploads = 0;
	return {
		counts: () => ({ starts, inspections, uploads }),
		handle: async (
			method: string | undefined,
			url: string,
			headers: IncomingHttpHeaders,
			body: Buffer,
			instanceName: string,
			response: ServerResponse,
		): Promise<boolean> => {
			const parsed = new URL(url, "http://fixture");
			const send = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			const path = parsed.searchParams.get("path");
			if (
				parsed.pathname === `/1.0/instances/${instanceName}/files` &&
				path?.startsWith("/run/qorpera-office-preparation/boot-service-restart-")
			) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				if (method === "POST") {
					assert.equal(
						path,
						`/run/qorpera-office-preparation/boot-service-restart-incoming-${createHash("sha256").update(body).digest("hex")}.json`,
					);
					assert.equal(headers["x-lxd-uid"], "0");
					assert.equal(headers["x-lxd-gid"], "0");
					assert.equal(headers["x-lxd-mode"], "0400");
					parseCompanyComputerBootServiceRestartRequest(JSON.parse(body.toString()));
					await guest?.stage(path, body);
					files.set(path, { content: body, mode: "0400" });
					uploads++;
					send(200, { type: "sync", status_code: 200, metadata: {} });
					return true;
				}
				assert.equal(method, "GET");
				const file = await officeHttpGuestRead(files, guest, path);
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
				if (!argv?.includes("/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs"))
					return false;
				assert([7, 8].includes(argv.length));
				const staged = files.get(`/run/qorpera-office-preparation/boot-service-restart-incoming-${argv[5]}.json`)!;
				const request = parseCompanyComputerBootServiceRestartRequest(JSON.parse(staged.content.toString()));
				const configBytes = files.get(`${companyComputerBootDirectory(argv[6])}/credentials/config.json`)!.content;
				const config = JSON.parse(configBytes.toString()),
					binding = config.linux.attestation;
				const retained = JSON.parse(
					await readFile(
						join(
							root,
							`boot-service-restart-request-${binding.allocationId}-${request.successor.request.attestation.activationId}.json`,
						),
						"utf8",
					),
				);
				assert.deepEqual(exec, {
					command: [
						"/usr/bin/env",
						"-i",
						"/usr/bin/node",
						"/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs",
						retained.command.commandId,
						retained.command.requestSha256,
						retained.command.bootId,
						...(argv.length === 8 ? [argv[7]] : []),
					],
					environment: {},
					"wait-for-websocket": false,
					interactive: false,
					"record-output": false,
					user: 0,
					group: 0,
					cwd: "/",
				});
				const completionPath = `/run/qorpera-office-preparation/boot-service-restart-completion-${request.successor.request.attestation.activationId}.json`;
				if (argv.length === 7) {
					const dispatch = JSON.parse(
						await readFile(
							join(
								root,
								`boot-service-restart-${binding.allocationId}-${request.successor.request.attestation.activationId}`,
								"000000.json",
							),
							"utf8",
						),
					);
					assert.equal(dispatch.kind, "dispatch");
					assert.equal(files.has(completionPath), false);
					starts++;
					if (guest) await guest.execute(argv);
					const completion = guest
						? JSON.parse((await officeHttpGuestRead(files, guest, completionPath))!.content.toString())
						: {
								schema: "qorpera.office-boot-service-restart-completion/v1",
								...(request.origin.schema === "qorpera.office-outage-service-start-request/v1"
									? { recoveryId: request.origin.successor.request.recovery.recoveryId }
									: { bootIntentId: request.origin.successor.request.bootIntentId }),
								originActivationId: request.origin.successor.request.attestation.activationId,
								command: retained.command,
								activationId: request.successor.request.attestation.activationId,
								configurationCompletionSha256: request.origin.configurationCompletionSha256,
								configurationSha256: request.successor.request.attestation.configurationSha256,
								serviceInvocationId: randomUUID().replaceAll("-", ""),
								mainPid: 700,
								controlGroup: "/system.slice/qorpera-company-computer.service",
							};
					if (!guest)
						files.set(
							`/run/qorpera-office-preparation/service-successor-${request.stop.revocation.request.activationId}.json`,
							{
								mode: "0600",
								content: Buffer.from(
									JSON.stringify({
										schema: "qorpera.office-boot-service-successor-claim/v1",
										command: retained.command,
										...(request.origin.schema === "qorpera.office-outage-service-start-request/v1"
											? { recoveryId: request.origin.successor.request.recovery.recoveryId }
											: { bootIntentId: request.origin.successor.request.bootIntentId }),
										originActivationId: request.origin.successor.request.attestation.activationId,
										activationId: request.successor.request.attestation.activationId,
										predecessorActivationId: request.stop.revocation.request.activationId,
										stopCompletionSha256: request.stopCompletionSha256,
									}),
								),
							},
						);
					if (!guest)
						files.set(completionPath, { mode: "0600", content: Buffer.from(`${JSON.stringify(completion)}\n`) });
					await ready(
						{
							scope: config.scope,
							computerGeneration: config.computerGeneration,
							allocationId: binding.allocationId,
							instanceSha256: binding.instanceSha256,
							imageSha256: binding.imageSha256,
							bootstrapSha256: binding.bootstrapSha256,
							bootId: binding.bootId,
							configurationSha256: request.successor.request.attestation.configurationSha256,
							serviceInvocationId: completion.serviceInvocationId,
						},
						request.successor.request.attestation.activationId,
						config.native.port,
						config.viewer.port,
					);
					// Deliberately lose the start response after physical and SQL readiness.
					response.destroy();
					return true;
				}
				const inspectionId = argv[7];
				const dispatch = JSON.parse(
					await readFile(
						join(root, `boot-service-restart-inspection-${binding.allocationId}-${inspectionId}.json`),
						"utf8",
					),
				);
				assert.equal(dispatch.inspectionId, inspectionId);
				assert.deepEqual(dispatch.command, retained.command);
				const completion = JSON.parse(files.get(completionPath)!.content.toString());
				if (guest) {
					await guest.execute(argv);
					await officeHttpGuestRefresh(files, guest, [
						`/run/qorpera-office-preparation/boot-service-restart-inspection-${inspectionId}.json`,
					]);
				} else {
					files.set(`/run/qorpera-office-preparation/boot-service-restart-inspection-${inspectionId}.json`, {
						mode: "0600",
						content: Buffer.from(
							JSON.stringify({
								schema: "qorpera.office-boot-service-restart-inspection/v1",
								inspectionId,
								start: completion,
							}),
						),
					});
				}
				inspections++;
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
