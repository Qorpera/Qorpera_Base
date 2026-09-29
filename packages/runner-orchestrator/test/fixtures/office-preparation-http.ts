import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { lxdOfficePreparationCommand } from "../../src/lxd-client.ts";
import { type OfficeHttpGuest, officeHttpGuestRead, officeHttpGuestRefresh } from "./office-http-guest.ts";

/** Unix HTTP for the disposable SQL flow. Checks durable dispatch before fixed
 * exec; an optional systemd guest supplies actual protected files and controls. */
export function officePreparationHttpFixture(root: string, guest?: OfficeHttpGuest) {
	const operationId = "12121212-1212-4212-8212-121212121212";
	const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
	const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
	const files = new Map<string, { content: Buffer; mode: string }>([
		["/run/qorpera-office-preparation/control.lock", { content: Buffer.alloc(0), mode: "0600" }],
	]);
	let pending = true,
		posts = 0,
		polls = 0,
		uploads = 0;
	return {
		files,
		finish: () => {
			pending = false;
		},
		counts: () => ({ posts, polls, uploads }),
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
			if (
				parsed.pathname === `/1.0/instances/${instanceName}/files` &&
				(parsed.searchParams.get("path")?.startsWith("/run/qorpera-office-preparation/") ||
					parsed.searchParams.get("path") === COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH)
			) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				const path = parsed.searchParams.get("path")!;
				if (method === "POST") {
					assert.equal(path, `/run/qorpera-office-preparation/incoming-${hash(body)}.json`);
					assert.equal(headers["x-lxd-uid"], "0");
					assert.equal(headers["x-lxd-gid"], "0");
					assert.equal(headers["x-lxd-mode"], "0400");
					parseCompanyComputerPreparationRequest(JSON.parse(body.toString()));
					await guest?.stage(path, body);
					files.set(path, { content: body, mode: "0400" });
					uploads++;
					send(200, { type: "sync", status_code: 200, metadata: {} });
					return true;
				}
				assert.equal(method, "GET");
				const file = await officeHttpGuestRead(files, guest, path);
				assert(file, "Missing synthetic guest file");
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
			const operation = () => ({
				id: operationId,
				class: "task",
				status: pending ? "Running" : "Success",
				status_code: pending ? 103 : 200,
				err: "",
				resources: {},
				metadata: {
					entity_url: `/1.0/instances/${instanceName}?project=offices`,
					...(pending ? {} : { return: 0 }),
				},
			});
			if (method === "POST" && url === `/1.0/instances/${instanceName}/exec?project=offices`) {
				const names = (await readdir(root)).filter((name) => name.startsWith("preparation-intent-"));
				assert.equal(names.length, 1);
				const intent = JSON.parse(await readFile(join(root, names[0]), "utf8"));
				const authority = JSON.parse(
					await readFile(join(root, `preparation-${intent.allocationId}`, "authority.json"), "utf8"),
				);
				const dispatch = JSON.parse(
					await readFile(join(root, `preparation-${intent.allocationId}`, "000000.json"), "utf8"),
				);
				assert.equal(dispatch.kind, "dispatch");
				assert.equal(authority.command.commandId, intent.commandId);
				assert.deepEqual(JSON.parse(body.toString()), {
					command: lxdOfficePreparationCommand(authority.command),
					environment: {},
					"wait-for-websocket": false,
					interactive: false,
					"record-output": true,
					user: 0,
					group: 0,
					cwd: "/",
				});
				const staged = files.get(`/run/qorpera-office-preparation/incoming-${intent.requestSha256}.json`);
				assert(staged);
				const request = parseCompanyComputerPreparationRequest(JSON.parse(staged.content.toString()));
				if (guest) {
					await guest.execute(JSON.parse(body.toString()).command);
					await officeHttpGuestRefresh(files, guest, [
						COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
						"/run/qorpera-office-preparation/result.json",
						"/run/qorpera-office-preparation/completion.json",
					]);
				} else {
					const report = {
						schema: "qorpera.office-guest-preparation-result/v1",
						state: "prepared",
						scope: request.scope,
						computerGeneration: request.computerGeneration,
						allocationId: request.allocationId,
						instanceSha256: request.instanceSha256,
						imageSha256: request.imageSha256,
						bootstrapSha256: request.bootstrapSha256,
						bootId: request.bootId,
						copy: request.copy,
						workbenchMount: request.workbenchMount,
						requestSha256: intent.requestSha256,
						contentSha256: hash(JSON.stringify(request.entries)),
						observationSha256: "a".repeat(64),
						entries: request.entries.length,
						totalBytes: request.entries.reduce((sum, entry) => sum + entry.bytes, 0),
						invocationId: "b".repeat(32),
					};
					const reportBytes = encode(report);
					const receiptBytes = encode(companyComputerPreparationAdoptionReceipt(request));
					files.set(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, { content: receiptBytes, mode: "0444" });
					files.set("/run/qorpera-office-preparation/result.json", { content: reportBytes, mode: "0600" });
					files.set("/run/qorpera-office-preparation/completion.json", {
						content: encode({
							schema: "qorpera.office-preparation-completion/v2",
							command: authority.command,
							invocationId: report.invocationId,
							reportSha256: hash(reportBytes),
							adoptionReceiptSha256: hash(receiptBytes),
							report,
						}),
						mode: "0600",
					});
				}
				posts++;
				send(202, {
					type: "async",
					status_code: 100,
					operation: `/1.0/operations/${operationId}`,
					metadata: operation(),
				});
				return true;
			}
			if (method === "GET" && url === `/1.0/operations/${operationId}?project=offices`) {
				polls++;
				send(200, { type: "sync", status_code: 200, metadata: operation() });
				return true;
			}
			return false;
		},
	};
}
