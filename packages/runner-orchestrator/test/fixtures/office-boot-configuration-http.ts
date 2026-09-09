import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootAdoptionReceipt,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResumeObservationCanonical,
	parseCompanyComputerBootConfigurationRequest,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { lxdOfficeBootConfigurationCommand } from "../../src/lxd-client.ts";

/** Synthetic root installation behind actual Unix HTTP. The actual root CLI
 * is exercised separately by Linux/systemd tests; this fixture proves provider
 * dispatch/readback/SQL composition, not a real reboot or root-file custody. */
export function officeBootConfigurationHttpFixture(
	root: string,
	files: Map<string, { content: Buffer; mode: string }>,
) {
	const operations = new Map<string, number>(),
		commands = new Set<string>();
	const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
	let posts = 0,
		polls = 0,
		uploads = 0;
	return {
		counts: () => ({ posts, polls, uploads }),
		async handle(
			method: string | undefined,
			url: string,
			headers: IncomingHttpHeaders,
			bytes: Buffer,
			instanceName: string,
			response: ServerResponse,
		) {
			const parsed = new URL(url, "http://fixture"),
				path = parsed.searchParams.get("path");
			const send = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			if (
				parsed.pathname === `/1.0/instances/${instanceName}/files` &&
				path &&
				(path.startsWith("/run/qorpera-office-preparation/boot-configuration-incoming-") ||
					/^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/(adoption|configuration-completion|configuration-claim)\.json$/.test(
						path,
					))
			) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				if (method === "POST") {
					assert.equal(path, `/run/qorpera-office-preparation/boot-configuration-incoming-${hash(bytes)}.json`);
					assert.equal(headers["x-lxd-uid"], "0");
					assert.equal(headers["x-lxd-gid"], "0");
					assert.equal(headers["x-lxd-mode"], "0400");
					parseCompanyComputerBootConfigurationRequest(JSON.parse(bytes.toString()));
					files.set(path, { content: bytes, mode: "0400" });
					uploads++;
					send(200, { type: "sync", status_code: 200, metadata: {} });
					return true;
				}
				assert.equal(method, "GET");
				const file = files.get(path);
				assert(file);
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
			const metadata = (operationId: string) => ({
				id: operationId,
				class: "task",
				status: "Success",
				status_code: 200,
				err: "",
				resources: {},
				metadata: { entity_url: `/1.0/instances/${instanceName}?project=offices`, return: 0 },
			});
			if (method === "POST" && url === `/1.0/instances/${instanceName}/exec?project=offices`) {
				const exec = JSON.parse(bytes.toString());
				if (!exec.command?.includes("/opt/qorpera-office/qorpera-company-computer-boot-configuration-control.mjs"))
					return false;
				const indices = await Promise.all(
					(await readdir(root))
						.filter((name) => name.startsWith("boot-configuration-intent-"))
						.map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))),
				);
				const matches = indices.filter((index) => exec.command.includes(index.commandId));
				assert.equal(matches.length, 1);
				const index = matches[0],
					directory = join(root, `boot-configuration-${index.allocationId}-${index.activationId}`),
					authority = JSON.parse(await readFile(join(directory, "authority.json"), "utf8")),
					dispatch = JSON.parse(await readFile(join(directory, "000000.json"), "utf8"));
				assert.equal(dispatch.kind, "dispatch");
				assert.equal(authority.command.commandId, index.commandId);
				assert.deepEqual(exec, {
					command: lxdOfficeBootConfigurationCommand(authority.command),
					environment: {},
					"wait-for-websocket": false,
					interactive: false,
					"record-output": false,
					user: 0,
					group: 0,
					cwd: "/",
				});
				const body = parseCompanyComputerBootConfigurationRequest(
					JSON.parse(
						files
							.get(`/run/qorpera-office-preparation/boot-configuration-incoming-${index.requestSha256}.json`)!
							.content.toString(),
					),
				);
				const originalBytes = await readFile(join(root, `preparation-request-${index.allocationId}.json`)),
					original = parseCompanyComputerPreparationRequest(JSON.parse(originalBytes.toString())),
					bootObservationSha256 = hash(
						companyComputerResumeObservationCanonical(body.observation, body.bootIntent.request),
					),
					receipt = companyComputerBootAdoptionReceipt(
						original,
						hash(originalBytes),
						hash(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
						body.bootIntent.request,
						body.observation,
						bootObservationSha256,
					),
					receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
				assert.equal(body.originPreparationSha256, hash(originalBytes));
				assert.equal(body.observation.bootId, authority.command.bootId);
				const installed = Object.fromEntries(
					Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, name]) => {
						const content = Buffer.from(body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
						files.set(`${companyComputerBootDirectory(authority.command.bootId)}/credentials/${name}`, {
							content,
							mode: "0400",
						});
						return [name, { bytes: content.length, sha256: hash(content) }];
					}),
				);
				files.set(companyComputerBootAdoptionReceiptPath(authority.command.bootId), {
					content: receiptBytes,
					mode: "0444",
				});
				files.set(`${companyComputerBootDirectory(authority.command.bootId)}/configuration-claim.json`, {
					mode: "0600",
					content: Buffer.from(
						`${JSON.stringify({ schema: "qorpera.office-boot-configuration-claim/v1", command: authority.command, bootIntentId: body.bootIntent.request.bootIntentId, activationId: body.bootIntent.request.activationId })}\n`,
					),
				});
				files.set(`${companyComputerBootDirectory(authority.command.bootId)}/configuration-completion.json`, {
					mode: "0600",
					content: Buffer.from(
						`${JSON.stringify({ schema: "qorpera.office-boot-configuration-completion/v1", command: authority.command, bootIntentId: body.bootIntent.request.bootIntentId, activationId: body.bootIntent.request.activationId, originPreparationSha256: hash(originalBytes), adoptionReceiptSha256: hash(receiptBytes), bootObservationSha256, files: installed })}\n`,
					),
				});
				assert(!commands.has(index.commandId));
				commands.add(index.commandId);
				const operationId = posts++ === 0 ? "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc" : randomUUID();
				operations.set(operationId, 0);
				send(202, {
					type: "async",
					status_code: 100,
					operation: `/1.0/operations/${operationId}`,
					metadata: metadata(operationId),
				});
				return true;
			}
			const operationId = parsed.pathname.slice("/1.0/operations/".length);
			if (method === "GET" && operations.has(operationId)) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				polls++;
				const count = operations.get(operationId)! + 1;
				operations.set(operationId, count);
				if (count === 1) response.destroy();
				else send(200, { type: "sync", status_code: 200, metadata: metadata(operationId) });
				return true;
			}
			return false;
		},
	};
}
