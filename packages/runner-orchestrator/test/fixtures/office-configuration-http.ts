import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootDirectory,
	parseCompanyComputerConfigurationRequest,
} from "@qorpera/contracts";
import { lxdOfficeConfigurationCommand } from "../../src/lxd-client.ts";
import { type OfficeHttpGuest, officeHttpGuestRead, officeHttpGuestRefresh } from "./office-http-guest.ts";

/** Unix HTTP validates write-ahead dispatch and fixed argv. An optional systemd
 * guest executes the actual root helper; the default measurements are synthetic. */
export function officeConfigurationHttpFixture(
	root: string,
	files: Map<string, { content: Buffer; mode: string }>,
	guest?: OfficeHttpGuest,
) {
	const operationId = "13131313-1313-4313-8313-131313131313";
	const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
	let pending = true,
		posts = 0,
		polls = 0,
		uploads = 0;
	return {
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
			const path = parsed.searchParams.get("path");
			if (
				parsed.pathname === `/1.0/instances/${instanceName}/files` &&
				path &&
				(path.startsWith("/run/qorpera-office-preparation/configuration-") ||
					path.startsWith("/etc/qorpera-office/credentials/") ||
					/^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/credentials\//.test(path))
			) {
				assert.equal(parsed.searchParams.get("project"), "offices");
				if (method === "POST") {
					assert.equal(path, `/run/qorpera-office-preparation/configuration-incoming-${hash(body)}.json`);
					assert.equal(headers["x-lxd-uid"], "0");
					assert.equal(headers["x-lxd-gid"], "0");
					assert.equal(headers["x-lxd-mode"], "0400");
					parseCompanyComputerConfigurationRequest(JSON.parse(body.toString()));
					await guest?.stage(path, body);
					files.set(path, { content: body, mode: "0400" });
					uploads++;
					send(200, { type: "sync", status_code: 200, metadata: {} });
					return true;
				}
				assert.equal(method, "GET");
				const file = await officeHttpGuestRead(files, guest, path);
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
				const exec = JSON.parse(body.toString());
				if (!exec.command?.includes("/opt/qorpera-office/qorpera-company-computer-configuration-control.mjs"))
					return false;
				const names = (await readdir(root)).filter((name) => name.startsWith("configuration-intent-"));
				assert.equal(names.length, 1);
				const intent = JSON.parse(await readFile(join(root, names[0]), "utf8"));
				const authority = JSON.parse(
					await readFile(join(root, `configuration-${intent.allocationId}`, "authority.json"), "utf8"),
				);
				const dispatch = JSON.parse(
					await readFile(join(root, `configuration-${intent.allocationId}`, "000000.json"), "utf8"),
				);
				assert.equal(dispatch.kind, "dispatch");
				assert.equal(authority.command.commandId, intent.commandId);
				assert.deepEqual(exec, {
					command: lxdOfficeConfigurationCommand(authority.command),
					environment: {},
					"wait-for-websocket": false,
					interactive: false,
					"record-output": true,
					user: 0,
					group: 0,
					cwd: "/",
				});
				const staged = files.get(
					`/run/qorpera-office-preparation/configuration-incoming-${intent.requestSha256}.json`,
				);
				assert(staged);
				const payload = parseCompanyComputerConfigurationRequest(JSON.parse(staged.content.toString()));
				if (guest) {
					await guest.execute(exec.command);
					await officeHttpGuestRefresh(files, guest, [
						"/run/qorpera-office-preparation/configuration-completion.json",
						...Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES).flatMap((name) => [
							`/etc/qorpera-office/credentials/${name}`,
							`${companyComputerBootDirectory(authority.command.bootId)}/credentials/${name}`,
						]),
					]);
				} else {
					const metadata = Object.fromEntries(
						Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([name, path]) => {
							const content = Buffer.from(payload[name as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
							files.set(`/etc/qorpera-office/credentials/${path}`, { content, mode: "0400" });
							files.set(`${companyComputerBootDirectory(authority.command.bootId)}/credentials/${path}`, {
								content: Buffer.from(content),
								mode: "0400",
							});
							return [path, { bytes: content.length, sha256: hash(content) }];
						}),
					);
					const prepared = files.get("/run/qorpera-office-preparation/completion.json")!;
					files.set("/run/qorpera-office-preparation/configuration-completion.json", {
						mode: "0600",
						content: Buffer.from(
							`${JSON.stringify({ schema: "qorpera.office-configuration-completion/v1", command: authority.command, preparation: payload.preparation, preparationCompletionSha256: hash(prepared.content), adoptionReceiptSha256: JSON.parse(prepared.content.toString()).adoptionReceiptSha256, files: metadata })}\n`,
						),
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
