import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_SERVICE_CGROUP,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { type OfficeHttpGuest, officeHttpGuestRead, officeHttpGuestRefresh } from "./office-http-guest.ts";
import { officeStopHistoryFixture } from "./office-stop-history.ts";

/** Actual Unix HTTP/retained journals with optional actual root measurements. */
export function officeServiceStopHttpFixture(
	root: string,
	files: Map<string, { content: Buffer; mode: string }>,
	guest?: OfficeHttpGuest,
) {
	let stops = 0,
		inspections = 0,
		uploads = 0;
	const operations = new Map<string, Record<string, unknown>>();
	return {
		counts: () => ({ stops, inspections, uploads }),
		handle: async (
			method: string | undefined,
			url: string,
			headers: IncomingHttpHeaders,
			body: Buffer,
			instanceName: string,
			response: ServerResponse,
		) => {
			const parsed = new URL(url, "http://fixture"),
				path = parsed.searchParams.get("path");
			const send = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			if (
				parsed.pathname === `/1.0/instances/${instanceName}/files` &&
				(path?.startsWith("/run/qorpera-office-preparation/service-stop-") ||
					(method === "GET" && path?.startsWith("/etc/qorpera-office/history/")))
			) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				if (method === "POST") {
					assert.equal(
						path,
						`/run/qorpera-office-preparation/service-stop-incoming-${createHash("sha256").update(body).digest("hex")}.json`,
					);
					assert.equal(headers["x-lxd-uid"], "0");
					assert.equal(headers["x-lxd-gid"], "0");
					assert.equal(headers["x-lxd-mode"], "0400");
					parseCompanyComputerServiceStopRequest(JSON.parse(body.toString()));
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
				if (!argv?.includes("/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs")) return false;
				assert([7, 8].includes(argv.length));
				const staged = files.get(`/run/qorpera-office-preparation/service-stop-incoming-${argv[5]}.json`)!;
				const request = parseCompanyComputerServiceStopRequest(JSON.parse(staged.content.toString()));
				const { allocationId } = request.revocation.request.startup,
					{ transitionId } = request.revocation.request;
				const retained = JSON.parse(
					await readFile(join(root, `service-stop-request-${allocationId}-${transitionId}.json`), "utf8"),
				);
				assert.deepEqual(exec, {
					command: [
						"/usr/bin/env",
						"-i",
						"/usr/bin/node",
						"/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",
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
				const firstBytes = files.get("/run/qorpera-office-preparation/service-start-completion.json"),
					bootBytes = files.get("/run/qorpera-office-preparation/boot-service-start-completion.json");
				assert(firstBytes || bootBytes, "protected start evidence missing");
				assert(!(firstBytes && bootBytes), "mixed boot start evidence");
				const first = firstBytes ? JSON.parse(firstBytes.content.toString()) : undefined;
				if (bootBytes) {
					const origin = JSON.parse(bootBytes.content.toString());
					const selected =
						origin.activationId === request.revocation.request.activationId
							? bootBytes
							: files.get(
									`/run/qorpera-office-preparation/boot-service-restart-completion-${request.revocation.request.activationId}.json`,
								);
					assert(selected, "selected boot restart evidence missing");
					const start = JSON.parse(selected.content.toString());
					assert.equal(start.activationId, request.revocation.request.activationId);
					assert.equal(start.command.bootId, request.revocation.request.startup.bootId);
					assert.equal(createHash("sha256").update(selected.content).digest("hex"), request.startCompletionSha256);
				}
				const completionPath =
					first?.activationId === request.revocation.request.activationId
						? "/run/qorpera-office-preparation/service-stop-completion.json"
						: `/run/qorpera-office-preparation/service-stop-completion-${request.revocation.request.activationId}.json`;
				if (argv.length === 7) {
					assert.equal(
						JSON.parse(
							await readFile(join(root, `service-stop-${allocationId}-${transitionId}`, "000000.json"), "utf8"),
						).kind,
						"dispatch",
					);
					assert.equal(files.has(completionPath), false);
					stops++;
					if (guest) {
						await guest.execute(argv);
						await officeHttpGuestRefresh(files, guest, [completionPath]);
					} else {
						const completion = parseCompanyComputerServiceStopCompletion(
							{
								schema: "qorpera.office-service-stop-completion/v1",
								command: retained.command,
								transitionId,
								activationId: request.revocation.request.activationId,
								revocationRevision: request.revocation.revocationRevision,
								configurationSha256: request.revocation.request.startup.configurationSha256,
								startCompletionSha256: request.startCompletionSha256,
								fromServiceInvocationId: request.revocation.request.startup.serviceInvocationId,
								observedInvocationId: request.revocation.request.startup.serviceInvocationId,
								stoppedInvocationId: request.revocation.request.startup.serviceInvocationId,
								controlGroup: COMPANY_COMPUTER_SERVICE_CGROUP,
								cgroupState: "absent",
							},
							retained.command,
							request,
						);
						files.set(completionPath, { mode: "0600", content: Buffer.from(JSON.stringify(completion)) });
						for (const [path, content] of officeStopHistoryFixture(
							files,
							retained.command,
							request.revocation.request.activationId,
							completionPath,
						))
							files.set(path, { content, mode: "0600" });
					}
					response.destroy();
					return true; // Deliberately lose the committed physical reply.
				}
				const inspectionId = argv[7];
				const dispatch = JSON.parse(
					await readFile(
						join(root, `stop-inspection-${allocationId}-${transitionId}-${inspectionId}.json`),
						"utf8",
					),
				);
				assert.deepEqual(dispatch.command, retained.command);
				assert.equal(dispatch.inspectionId, inspectionId);
				if (guest) {
					await guest.execute(argv);
					await officeHttpGuestRefresh(files, guest, [
						`/run/qorpera-office-preparation/service-stop-inspection-${inspectionId}.json`,
					]);
				} else {
					files.set(`/run/qorpera-office-preparation/service-stop-inspection-${inspectionId}.json`, {
						mode: "0600",
						content: Buffer.from(
							JSON.stringify({
								schema: "qorpera.office-service-stop-inspection/v1",
								inspectionId,
								stop: JSON.parse(files.get(completionPath)!.content.toString()),
								cgroupState: "absent",
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
