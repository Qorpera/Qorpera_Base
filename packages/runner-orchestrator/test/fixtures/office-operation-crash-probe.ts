import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LxdUnixClient } from "../../src/lxd-client.ts";
import { LxdOfficeConfigurationJournal } from "../../src/lxd-office-configuration-journal.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../../src/lxd-office-guest.ts";
import { LxdOfficeOperationJournal } from "../../src/lxd-office-operations.ts";
import { LxdOfficePreparationJournal } from "../../src/lxd-office-preparation-journal.ts";
import { LxdOfficeServiceStartJournal } from "../../src/lxd-office-service-start-journal.ts";
import { testAgentMac } from "../helpers/agent-plug.ts";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const binding: LxdOfficeGuestBinding = {
	schema: "qorpera.lxd-office-guest/v2",
	providerId: id(7),
	providerPolicySha256: "f".repeat(64),
	companyId: id(1),
	environmentId: id(2),
	companyComputerId: id(3),
	logicalComputerId: id(4),
	computerGeneration: 1,
	allocationId: id(5),
	project: "offices",
	imageFingerprint: "a".repeat(64),
	bootstrapSha256: "b".repeat(64),
	storagePool: "office-vms",
	rootDiskBytes: 64 * 1024 ** 3,
	workbenchSource: "/mnt/nas/office",
	network: "office-net",
	cpus: 2,
	memoryBytes: 4 * 1024 ** 3,
};
const plan = lxdOfficeGuestPlan(binding);
const self = fileURLToPath(import.meta.url);
const serviceStart = process.argv.includes("--service-start");
const configuration = process.argv.includes("--configuration");
const preparation = process.argv.includes("--preparation") || configuration || serviceStart;
const preparationIdentity = {
	intentId: id(6),
	binding,
	bootObservationSha256: "d".repeat(64),
	command: { commandId: id(10), bootId: id(11), requestSha256: "c".repeat(64) },
};

const configurationIdentity = { ...preparationIdentity, preparationObservationSha256: "e".repeat(64) };
const openControl = (root: string, client: LxdUnixClient, existing = true) =>
	serviceStart
		? LxdOfficeServiceStartJournal.open(
				root,
				{ ...preparationIdentity, configurationObservationSha256: "e".repeat(64) },
				client,
				existing,
			)
		: configuration
			? LxdOfficeConfigurationJournal.open(root, configurationIdentity, client, existing)
			: LxdOfficePreparationJournal.open(root, preparationIdentity, client, existing);

if (process.argv[2] === "--child") {
	const client = new LxdUnixClient(process.argv[4]);
	const result = preparation
		? await (await openControl(process.argv[3], client)).reconcile(AbortSignal.timeout(12000))
		: await (await LxdOfficeOperationJournal.open(process.argv[3], id(6), binding, client)).reconcile(
				id(10),
				"create",
				AbortSignal.timeout(12000),
				testAgentMac,
			);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
	assert.equal(process.platform, "linux", "This proof must run on Linux");
	assert.notEqual(process.getuid?.(), 0, "This proof must run as an unprivileged provider");
	let checks = 0;
	for (const cut of ["submission", "accepted"] as const) {
		const root = await realpath(await mkdtemp(join(tmpdir(), "office-crash-")));
		const socket = join(root, "lxd.socket");
		if (preparation) await openControl(root, new LxdUnixClient(socket), false);
		let phase: "crash" | "resume" = "crash";
		let posts = 0;
		let gets = 0;
		let notifyCut: () => void = () => {};
		const reachedCut = new Promise<void>((resolveCut) => {
			notifyCut = resolveCut;
		});
		const server = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				const operation = {
					id: id(100),
					class: "task",
					status_code: 200,
					status: "Success",
					err: "",
					resources: {},
					metadata: { entity_url: `/1.0/instances/${plan.request.name}?project=offices`, return: 0 },
				};
				if (
					request.method === "POST" &&
					request.url ===
						(preparation
							? `/1.0/instances/${plan.request.name}/exec?project=offices`
							: "/1.0/instances?project=offices")
				) {
					posts++;
					if (cut === "submission") {
						notifyCut();
						return;
					}
					response.writeHead(202, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							type: "async",
							status_code: 100,
							operation: `/1.0/operations/${id(100)}`,
							metadata: { ...operation, status: "Running", status_code: 103 },
						}),
					);
				} else if (request.method === "GET" && request.url === `/1.0/operations/${id(100)}?project=offices`) {
					gets++;
					if (phase === "crash") {
						notifyCut();
						return;
					}
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ type: "sync", status_code: 200, metadata: operation }));
				} else {
					response.writeHead(500);
					response.end();
				}
			});
		});
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(socket, resolveListen);
		});
		function child() {
			const processChild = spawn(
				process.execPath,
				[
					self,
					"--child",
					root,
					socket,
					...(serviceStart
						? ["--service-start"]
						: configuration
							? ["--configuration"]
							: preparation
								? ["--preparation"]
								: []),
				],
				{
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 15000,
				},
			);
			let output = "";
			let diagnostic = "";
			processChild.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			processChild.stderr.on("data", (chunk: Buffer) => {
				diagnostic += chunk.toString();
			});
			const closed = new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
				output: string;
				diagnostic: string;
			}>((resolveClose, reject) => {
				processChild.once("error", reject);
				processChild.once("close", (code, signal) => resolveClose({ code, signal, output, diagnostic }));
			});
			return { processChild, closed };
		}
		const first = child();
		try {
			await Promise.race([
				reachedCut,
				first.closed.then((result) => {
					throw new Error(`Provider exited before crash point: ${JSON.stringify(result)}`);
				}),
			]);
			assert.equal(first.processChild.kill("SIGKILL"), true);
			assert.equal((await first.closed).signal, "SIGKILL");
			phase = "resume";
			const second = await child().closed;
			assert.equal(second.code, 0, second.diagnostic);
			const expected = cut === "submission" ? { state: "unknown" } : { state: "succeeded", operationId: id(100) };
			assert.deepEqual(JSON.parse(second.output), expected);
			const third = await child().closed;
			assert.equal(third.code, 0, third.diagnostic);
			assert.deepEqual(JSON.parse(third.output), expected);
			assert.equal(posts, 1, "A killed provider must not cause a second mutation request");
			assert.equal(gets, cut === "submission" ? 0 : 2, "Replaying terminal results must not poll again");
			const directory = join(
				root,
				preparation
					? `${serviceStart ? "service-start" : configuration ? "configuration" : "preparation"}-${binding.allocationId}`
					: binding.allocationId,
			);
			const names = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
			assert.equal(names.length, cut === "submission" ? 1 : 3);
			const terminal = JSON.parse(await readFile(join(directory, names[names.length - 1]), "utf8"));
			assert.equal(terminal.kind, cut === "submission" ? "dispatch" : "settled");
			checks++;
		} finally {
			first.processChild.kill("SIGKILL");
			server.closeAllConnections();
			await new Promise<void>((resolveClose, reject) =>
				server.close((error) => (error ? reject(error) : resolveClose())),
			);
			await rm(root, { recursive: true, force: true });
		}
	}
	process.stdout.write(
		`${JSON.stringify({ schema: serviceStart ? "qorpera.office-service-start-crash-proof/v1" : configuration ? "qorpera.office-configuration-crash-proof/v1" : preparation ? "qorpera.office-preparation-crash-proof/v1" : "qorpera.office-operation-crash-proof/v1", platform: process.platform, uid: process.getuid?.(), checks, configurationExec: configuration, serviceStartExec: serviceStart, actualSigkill: true, realUnixSocket: true, physicalLxdGuest: false })}\n`,
	);
}
