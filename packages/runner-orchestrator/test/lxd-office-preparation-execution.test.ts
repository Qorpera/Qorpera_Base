import { chmod, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LxdOfficeConfigurationClient,
	type LxdOfficePreparationCommand,
	type LxdOfficeServiceRestartClient,
	type LxdOfficeServiceStartClient,
	type LxdOfficeServiceStopClient,
	LxdUnixClient,
} from "../src/lxd-client.ts";
import {
	type LxdOfficeConfigurationIdentity,
	LxdOfficeConfigurationJournal,
} from "../src/lxd-office-configuration-journal.ts";
import { LxdOfficeControlJournal } from "../src/lxd-office-control-journal.ts";
import { observeLxdOfficeControlJournals, runLxdOfficeControlObserver } from "../src/lxd-office-control-observer.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import {
	type LxdOfficePreparationIdentity,
	LxdOfficePreparationJournal,
} from "../src/lxd-office-preparation-journal.ts";
import {
	type LxdOfficeServiceRestartIdentity,
	LxdOfficeServiceRestartJournal,
} from "../src/lxd-office-service-restart-journal.ts";
import {
	type LxdOfficeServiceStartIdentity,
	LxdOfficeServiceStartJournal,
} from "../src/lxd-office-service-start-journal.ts";
import {
	type LxdOfficeServiceStopIdentity,
	LxdOfficeServiceStopJournal,
} from "../src/lxd-office-service-stop-journal.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command = { commandId: id(10), bootId: id(11), requestSha256: "c".repeat(64) };
const identity: LxdOfficePreparationIdentity = {
	intentId: id(6),
	bootObservationSha256: "d".repeat(64),
	command,
	binding: {
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
	},
};
const name = lxdOfficeGuestPlan(identity.binding).request.name;
const reference = { project: "offices", instanceName: name, operationId: id(100) };
const signal = () => new AbortController().signal;
const operation = (overrides: Record<string, unknown> = {}) => ({
	id: id(100),
	class: "task",
	status: "Running",
	status_code: 103,
	err: "",
	resources: {},
	metadata: { entity_url: `/1.0/instances/${name}?project=offices` },
	...overrides,
});
const success = (exit: unknown = 0) =>
	operation({
		status: "Success",
		status_code: 200,
		metadata: { entity_url: `/1.0/instances/${name}?project=offices`, return: exit },
	});
const accepted = () => ({
	type: "async",
	status_code: 100,
	operation: `/1.0/operations/${id(100)}`,
	metadata: operation(),
});
function send(response: ServerResponse, body: unknown, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
	purpose: "preparation" | "configuration" | "service-start" | "service-stop" | "service-restart" = "preparation",
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "prep-exec-")));
	roots.push(root);
	await chmod(root, 0o700);
	const calls: { method: string; url: string; body: unknown }[] = [];
	const handlers = {
		post: async (_request: IncomingMessage, response: ServerResponse) => send(response, accepted(), 202),
		get: async (_request: IncomingMessage, response: ServerResponse) =>
			send(response, { type: "sync", status_code: 200, metadata: operation() }),
	};
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			calls.push({
				method: request.method ?? "",
				url: request.url ?? "",
				body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
			});
			void (request.method === "POST" ? handlers.post : handlers.get)(request, response).catch((error) =>
				response.destroy(error),
			);
		});
	});
	servers.push(server);
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(join(root, "socket"), done);
	});
	const client = new LxdUnixClient(join(root, "socket"), 30);

	const selectedIdentity = {
		...identity,
		...(purpose === "configuration" ? { preparationObservationSha256: "1".repeat(64) } : {}),
		...(purpose === "service-start" ? { configurationObservationSha256: "2".repeat(64) } : {}),
		...(purpose === "service-stop"
			? { transitionId: id(20), revocationSha256: "3".repeat(64), startObservationSha256: "4".repeat(64) }
			: {}),
		...(purpose === "service-restart"
			? {
					activationId: id(30),
					transitionId: id(20),
					configurationObservationSha256: "2".repeat(64),
					stopObservationSha256: "4".repeat(64),
				}
			: {}),
	};
	const path = join(
		root,
		`${purpose}-${identity.binding.allocationId}${purpose === "service-stop" ? `-${selectedIdentity.transitionId}` : purpose === "service-restart" ? `-${selectedIdentity.activationId}` : ""}`,
	);
	const openWith = (
		port: Pick<
			LxdOfficeConfigurationClient &
				LxdOfficeServiceStartClient &
				LxdOfficeServiceStopClient &
				LxdOfficeServiceRestartClient,
			| "submitOfficePreparation"
			| "inspectOfficePreparation"
			| "submitOfficeConfiguration"
			| "inspectOfficeConfiguration"
			| "submitOfficeServiceStart"
			| "inspectOfficeServiceStart"
			| "submitOfficeServiceStop"
			| "inspectOfficeServiceStop"
			| "submitOfficeServiceRestart"
			| "inspectOfficeServiceRestart"
		>,
		existing: boolean,
		value = selectedIdentity,
	) =>
		purpose === "preparation"
			? LxdOfficePreparationJournal.open(root, value, port, existing)
			: purpose === "configuration"
				? LxdOfficeConfigurationJournal.open(root, value as LxdOfficeConfigurationIdentity, port, existing)
				: purpose === "service-start"
					? LxdOfficeServiceStartJournal.open(root, value as LxdOfficeServiceStartIdentity, port, existing)
					: purpose === "service-stop"
						? LxdOfficeServiceStopJournal.open(root, value as LxdOfficeServiceStopIdentity, port, existing)
						: LxdOfficeServiceRestartJournal.open(root, value as LxdOfficeServiceRestartIdentity, port, existing);
	const reopen = (value = selectedIdentity) => openWith(client, true, value);
	const initialize = () => openWith(client, false);
	const events = async () =>
		Promise.all(
			(await readdir(path))
				.filter((n) => /^\d{6}\.json$/.test(n))
				.sort()
				.map(async (n) => JSON.parse(await readFile(join(path, n), "utf8"))),
		);
	return { root, path, client, calls, handlers, reopen, initialize, events, identity: selectedIdentity, openWith };
}

for (const lane of [
	{
		purpose: "outage-termination",
		submit: "submitOfficeOutageTermination",
		inspect: "inspectOfficeOutageTermination",
		error: "OUTAGE_TERMINATION",
	},
	{
		purpose: "outage-configuration",
		submit: "submitOfficeOutageConfiguration",
		inspect: "inspectOfficeOutageConfiguration",
		error: "OUTAGE_CONFIGURATION",
	},
	{
		purpose: "outage-service-start",
		submit: "submitOfficeOutageServiceStart",
		inspect: "inspectOfficeOutageServiceStart",
		error: "OUTAGE_SERVICE_START",
	},
	{
		purpose: "reset-configuration",
		submit: "submitOfficeResetConfiguration",
		inspect: "inspectOfficeResetConfiguration",
		error: "RESET_CONFIGURATION",
	},
	{
		purpose: "reset-service-start",
		submit: "submitOfficeResetServiceStart",
		inspect: "inspectOfficeResetServiceStart",
		error: "RESET_SERVICE_START",
	},
	{
		purpose: "reset-service-restart",
		submit: "submitOfficeResetServiceRestart",
		inspect: "inspectOfficeResetServiceRestart",
		error: "RESET_SERVICE_RESTART",
	},
	{
		purpose: "boot-service-restart",
		submit: "submitOfficeBootServiceRestart",
		inspect: "inspectOfficeBootServiceRestart",
		error: "BOOT_SERVICE_RESTART",
	},
	{
		purpose: "preparation",
		submit: "submitOfficePreparation",
		inspect: "inspectOfficePreparation",
		error: "PREPARATION",
	},
	{
		purpose: "configuration",
		submit: "submitOfficeConfiguration",
		inspect: "inspectOfficeConfiguration",
		error: "CONFIGURATION",
	},
	{
		purpose: "boot-configuration",
		submit: "submitOfficeBootConfiguration",
		inspect: "inspectOfficeBootConfiguration",
		error: "BOOT_CONFIGURATION",
	},
	{
		purpose: "boot-service-start",
		submit: "submitOfficeBootServiceStart",
		inspect: "inspectOfficeBootServiceStart",
		error: "BOOT_SERVICE_START",
	},
	{
		purpose: "service-start",
		submit: "submitOfficeServiceStart",
		inspect: "inspectOfficeServiceStart",
		error: "SERVICE_START",
	},
	{
		purpose: "service-stop",
		submit: "submitOfficeServiceStop",
		inspect: "inspectOfficeServiceStop",
		error: "SERVICE_STOP",
	},
	{
		purpose: "service-restart",
		submit: "submitOfficeServiceRestart",
		inspect: "inspectOfficeServiceRestart",
		error: "SERVICE_RESTART",
	},
] as const)
	describe(`fixed ${lane.purpose} exec over actual Unix HTTP`, () => {
		it("submits one fixed command with output recording to keep the VM exec bridge alive", async () => {
			const f = await fixture();
			await expect(f.client[lane.submit]("offices", name, command, signal())).resolves.toEqual(reference);
			expect(f.calls).toEqual([
				{
					method: "POST",
					url: `/1.0/instances/${name}/exec?project=offices`,
					body: {
						command: [
							"/usr/bin/env",
							"-i",
							"/usr/bin/node",
							`/opt/qorpera-office/qorpera-company-computer-${lane.purpose}-control.mjs`,
							command.commandId,
							command.requestSha256,
							command.bootId,
						],
						interactive: false,
						"wait-for-websocket": false,
						"record-output": true,
						user: 0,
						group: 0,
						cwd: "/",
						environment: {},
					},
				},
			]);
		});
		it.each([
			{},
			{ commandId: "../escape" },
			{ requestSha256: "c" },
			{ bootId: `${id(11)}x` },
			{ environment: { NODE_OPTIONS: "--import=evil" } },
		])("rejects invalid or extended command input %j before HTTP", async (change) => {
			const f = await fixture();
			const invalid = Object.keys(change).length ? { ...command, ...change } : {};
			await expect(
				f.client[lane.submit]("offices", name, invalid as LxdOfficePreparationCommand, signal()),
			).rejects.toThrow("SUBMISSION_UNCONFIRMED");
			expect(f.calls).toHaveLength(0);
		});
		it.each([0, 1, 129, 137, 255])("checks guest process exit %s separately from task success", async (exit) => {
			const f = await fixture();
			f.handlers.get = async (_r, response) =>
				send(response, { type: "sync", status_code: 200, metadata: success(exit) });
			await expect(f.client[lane.inspect](reference, signal())).resolves.toBe(exit === 0 ? "succeeded" : "failed");
			expect(f.calls).toEqual([
				{ method: "GET", url: `/1.0/operations/${id(100)}?project=offices`, body: undefined },
			]);
		});
		it.each([null, undefined, "0", -1, 256, 0.5])("refuses missing/malformed exit metadata %s", async (exit) => {
			const f = await fixture();
			const metadata = success();
			(metadata.metadata as Record<string, unknown>).return = exit;
			f.handlers.get = async (_r, response) => send(response, { type: "sync", status_code: 200, metadata });
			await expect(f.client[lane.inspect](reference, signal())).rejects.toThrow("OPERATION_UNCONFIRMED");
		});
		it.each(["Running", "Failure", "Cancelled"])("retains %s operation semantics", async (state) => {
			const f = await fixture();
			f.handlers.get = async (_r, response) =>
				send(response, {
					type: "sync",
					status_code: 200,
					metadata: operation({
						status: state,
						status_code: state === "Running" ? 103 : state === "Failure" ? 400 : 401,
					}),
				});
			await expect(f.client[lane.inspect](reference, signal())).resolves.toBe(
				state === "Running" ? "pending" : "failed",
			);
		});
		it.each([
			"wrong VM",
			"wrong project",
			"wrong operation",
			"websocket",
			"contradictory envelope",
			"redirect",
			"404",
			"truncated",
		])("refuses %s readback without leaking backend details", async (fault) => {
			const f = await fixture();
			f.handlers.get = async (_r, response) => {
				const metadata = success();
				if (fault === "wrong VM") metadata.metadata = { entity_url: "/1.0/instances/other?project=offices" };
				if (fault === "wrong project") metadata.metadata = { entity_url: `/1.0/instances/${name}?project=other` };
				if (fault === "wrong operation") metadata.id = id(101);
				if (fault === "websocket") metadata.class = "websocket";
				if (fault === "truncated") {
					response.writeHead(200, { "content-length": 9999 });
					response.write("{");
					response.destroy();
					return;
				}
				send(
					response,
					{
						type: "sync",
						status_code: 200,
						metadata,
						...(fault === "contradictory envelope" ? { error: "private diagnostic" } : {}),
					},
					fault === "redirect" ? 302 : fault === "404" ? 404 : 200,
				);
			};
			await expect(f.client[lane.inspect](reference, signal())).rejects.toThrow(
				new RegExp(`^LXD_OFFICE_${lane.error}_OPERATION_UNCONFIRMED$`),
			);
		});
		it.each(["bad URL", "sync", "HTTP 200", "error", "wrong target"])(
			"refuses ambiguous acceptance: %s",
			async (fault) => {
				const f = await fixture();
				f.handlers.post = async (_r, response) => {
					const body = accepted();
					if (fault === "bad URL") body.operation += "/wait";
					if (fault === "sync") body.type = "sync";
					if (fault === "wrong target") body.metadata.id = id(101);
					send(
						response,
						{ ...body, ...(fault === "error" ? { error_code: 500, error: "private" } : {}) },
						fault === "HTTP 200" ? 200 : 202,
					);
				};
				await expect(f.client[lane.submit]("offices", name, command, signal())).rejects.toThrow(
					new RegExp(`^LXD_OFFICE_${lane.error}_SUBMISSION_UNCONFIRMED$`),
				);
				expect(f.calls).toHaveLength(1);
			},
		);
		it.each(["post", "get"] as const)(
			"bounds stalled %s with a five-second deadline",
			async (method) => {
				const f = await fixture();
				f.handlers[method] = async (_r, response) => {
					response.writeHead(method === "post" ? 202 : 200);
					response.write("{");
				};
				await expect(
					method === "post"
						? f.client[lane.submit]("offices", name, command, signal())
						: f.client[lane.inspect](reference, signal()),
				).rejects.toThrow("UNCONFIRMED");
			},
			8000,
		);
		it("pre-aborted calls and invalid scopes never reach LXD", async () => {
			const f = await fixture();
			await expect(f.client[lane.submit]("offices", name, command, AbortSignal.abort())).rejects.toThrow(
				"UNCONFIRMED",
			);
			await expect(f.client[lane.inspect](reference, AbortSignal.abort())).rejects.toThrow("UNCONFIRMED");
			await expect(f.client[lane.submit]("../other", name, command, signal())).rejects.toThrow("UNCONFIRMED");
			await expect(f.client[lane.inspect]({ ...reference, operationId: "../other" }, signal())).rejects.toThrow(
				"UNCONFIRMED",
			);
			expect(f.calls).toHaveLength(0);
		});
	});

for (const purpose of ["preparation", "configuration", "service-start", "service-stop", "service-restart"] as const)
	describe(`durable ${purpose} command journal with actual filesystem and HTTP`, () => {
		it("retains the terminal exit independently before LXD expires the operation", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			await journal.reconcile(signal());
			f.handlers.get = async (_r, response) =>
				send(response, { type: "sync", status_code: 200, metadata: success() });
			const stop = new AbortController();
			let observed!: () => void;
			const captured = new Promise<void>((done) => {
				observed = done;
			});
			const running = runLxdOfficeControlObserver(
				async (checked) => {
					await observeLxdOfficeControlJournals(f.root, f.client, checked);
					observed();
				},
				stop.signal,
				() => {
					throw new Error("unexpected observation error");
				},
			);
			try {
				await captured;
			} finally {
				stop.abort();
				await running;
			}
			f.handlers.get = async (_r, response) => send(response, {}, 404);
			const calls = f.calls.length;
			await expect((await f.reopen()).reconcile(signal())).resolves.toEqual({
				state: "succeeded",
				operationId: id(100),
			});
			expect(f.calls).toHaveLength(calls);
			expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
			expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted", "settled"]);
		});
		it("cannot dispatch an untouched journal or invent a missing terminal fact", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			await observeLxdOfficeControlJournals(f.root, f.client, signal());
			expect(f.calls).toHaveLength(0);
			await journal.reconcile(signal());
			f.handlers.get = async (_r, response) => send(response, {}, 404);
			await observeLxdOfficeControlJournals(f.root, f.client, signal());
			expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted"]);
			expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
			await expect(
				LxdOfficeControlJournal.observeExisting(
					f.root,
					"../other",
					f.client.inspectOfficePreparation.bind(f.client),
					signal(),
				),
			).rejects.toThrow("INVALID_OFFICE_CONTROL_JOURNAL_NAME");
		});
		it("shares immutable completion publication with a simultaneous lifecycle observation", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			await journal.reconcile(signal());
			f.handlers.get = async (_r, response) =>
				send(response, { type: "sync", status_code: 200, metadata: success(137) });
			await Promise.allSettled([
				journal.observe(signal()),
				observeLxdOfficeControlJournals(f.root, f.client, signal()),
			]);
			await expect((await f.reopen()).observe(signal())).resolves.toEqual({ state: "failed", operationId: id(100) });
			expect((await f.events()).map((event) => event.kind)).toEqual(["dispatch", "accepted", "settled"]);
			expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
		});
		it("persists dispatch before POST, acceptance before GET and reopens the same completed command", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			expect(await readFile(join(f.path, "authority.json"), "utf8")).toBe(
				`${JSON.stringify({
					schema: `qorpera.lxd-office-${purpose}-journal/v1`,
					intentId: f.identity.intentId,
					binding: f.identity.binding,
					bootObservationSha256: f.identity.bootObservationSha256,
					command: f.identity.command,
					...(purpose === "configuration"
						? { preparationObservationSha256: f.identity.preparationObservationSha256 }
						: {}),
					...(purpose === "service-start"
						? { configurationObservationSha256: f.identity.configurationObservationSha256 }
						: {}),
					...(purpose === "service-stop"
						? {
								transitionId: f.identity.transitionId,
								revocationSha256: f.identity.revocationSha256,
								startObservationSha256: f.identity.startObservationSha256,
							}
						: {}),
					...(purpose === "service-restart"
						? {
								activationId: f.identity.activationId,
								transitionId: f.identity.transitionId,
								configurationObservationSha256: f.identity.configurationObservationSha256,
								stopObservationSha256: f.identity.stopObservationSha256,
							}
						: {}),
				})}\n`,
			);
			f.handlers.post = async (_r, response) => {
				expect((await f.events()).map((e) => e.kind)).toEqual(["dispatch"]);
				send(response, accepted(), 202);
			};
			f.handlers.get = async (_r, response) => {
				expect((await f.events()).map((e) => e.kind)).toEqual(["dispatch", "accepted"]);
				send(response, { type: "sync", status_code: 200, metadata: operation() });
			};
			await expect(journal.reconcile(signal())).resolves.toEqual({ state: "pending", operationId: id(100) });
			f.handlers.get = async (_r, response) =>
				send(response, { type: "sync", status_code: 200, metadata: success() });
			await expect((await f.reopen()).reconcile(signal())).resolves.toEqual({
				state: "succeeded",
				operationId: id(100),
			});
			await expect((await f.reopen()).reconcile(signal())).resolves.toEqual({
				state: "succeeded",
				operationId: id(100),
			});
			expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
			expect((await f.events()).map((e) => e.kind)).toEqual(["dispatch", "accepted", "settled"]);
		});
		it("never resubmits after a lost accepted response, including restart", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			f.handlers.post = async (_r, response) => {
				response.destroy();
			};
			await expect(journal.reconcile(signal())).resolves.toEqual({ state: "unknown" });
			await expect((await f.reopen()).reconcile(signal())).resolves.toEqual({ state: "unknown" });
			expect(f.calls).toHaveLength(1);
		});
		it("retains missing accepted operations until an actual exit is observed", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			f.handlers.get = async (_r, response) => send(response, {}, 404);
			await expect(journal.reconcile(signal())).resolves.toEqual({ state: "unknown", operationId: id(100) });
			f.handlers.get = async (_r, response) =>
				send(response, { type: "sync", status_code: 200, metadata: success(42) });
			await expect((await f.reopen()).reconcile(signal())).resolves.toEqual({
				state: "failed",
				operationId: id(100),
			});
			await expect((await f.reopen()).reconcile(signal())).resolves.toMatchObject({ state: "failed" });
			expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
		});
		it("prevents a competing observer from dispatching while the first POST is pending", async () => {
			const f = await fixture(purpose);
			const journal = await f.initialize();
			const other = await f.reopen();
			let release!: () => void;
			const gate = new Promise<void>((done) => {
				release = done;
			});
			let entered!: () => void;
			const started = new Promise<void>((done) => {
				entered = done;
			});
			f.handlers.post = async (_r, response) => {
				entered();
				await gate;
				send(response, accepted(), 202);
			};
			const first = journal.reconcile(signal());
			await started;
			await expect(other.reconcile(signal())).resolves.toEqual({ state: "unknown" });
			release();
			await first;
			expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
		});
		it("preserves accepted identity when cancellation arrives with the reply", async () => {
			const f = await fixture(purpose);
			const stop = new AbortController();
			const client = {
				submitOfficePreparation: async () => {
					stop.abort();
					return reference;
				},
				inspectOfficePreparation: f.client.inspectOfficePreparation.bind(f.client),
				submitOfficeConfiguration: async () => {
					stop.abort();
					return reference;
				},
				inspectOfficeConfiguration: f.client.inspectOfficeConfiguration.bind(f.client),
				submitOfficeServiceStart: async () => {
					stop.abort();
					return reference;
				},
				inspectOfficeServiceStart: f.client.inspectOfficeServiceStart.bind(f.client),
				submitOfficeServiceStop: async () => {
					stop.abort();
					return reference;
				},
				inspectOfficeServiceStop: f.client.inspectOfficeServiceStop.bind(f.client),
				submitOfficeServiceRestart: async () => {
					stop.abort();
					return reference;
				},
				inspectOfficeServiceRestart: f.client.inspectOfficeServiceRestart.bind(f.client),
			};
			const journal = await f.openWith(client, false);
			await expect(journal.reconcile(stop.signal)).resolves.toEqual({ state: "unknown", operationId: id(100) });
			expect((await f.events()).map((e) => e.kind)).toEqual(["dispatch", "accepted"]);
			await expect((await f.reopen()).reconcile(signal())).resolves.toMatchObject({ state: "pending" });
			expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
		});
		it.each([
			"boot",
			"request",
			"command",
			"observation",
			"provider",
			"intent",
			...(purpose === "configuration" ? ["preparation"] : []),
			...(purpose === "service-start" ? ["configuration"] : []),
			...(purpose === "service-stop" ? ["transition", "revocation", "start"] : []),
			...(purpose === "service-restart" ? ["transition", "activation", "configuration", "stop"] : []),
		])("rejects changed retained %s identity", async (field) => {
			const f = await fixture(purpose);
			await f.initialize();
			const changed = structuredClone(f.identity);
			if (field === "boot") changed.command = { ...changed.command, bootId: id(12) };
			if (field === "request") changed.command = { ...changed.command, requestSha256: "e".repeat(64) };
			if (field === "command") changed.command = { ...changed.command, commandId: id(13) };
			if (field === "observation") changed.bootObservationSha256 = "e".repeat(64);
			if (field === "provider") changed.binding.providerId = id(14);
			if (field === "intent") changed.intentId = id(15);
			if (field === "preparation") changed.preparationObservationSha256 = "2".repeat(64);
			if (field === "configuration") changed.configurationObservationSha256 = "3".repeat(64);
			if (field === "transition") changed.transitionId = id(21);
			if (field === "revocation") changed.revocationSha256 = "5".repeat(64);
			if (field === "start") changed.startObservationSha256 = "6".repeat(64);
			if (field === "activation") changed.activationId = id(31);
			if (field === "stop") changed.stopObservationSha256 = "6".repeat(64);
			await expect(f.reopen(changed)).rejects.toThrow("JOURNAL_UNCONFIRMED");
			expect(f.calls).toHaveLength(0);
		});
		it.each(["authority missing", "event hole", "hash", "permissions", "symlink", "partial", "extra"])(
			"refuses %s without reconstructing evidence",
			async (fault) => {
				const f = await fixture(purpose);
				await (await f.initialize()).reconcile(signal());
				const path = join(f.path, "000001.json");
				if (fault === "authority missing") await rm(join(f.path, "authority.json"));
				if (fault === "event hole") await rm(join(f.path, "000000.json"));
				if (fault === "hash") {
					const data = JSON.parse(await readFile(path, "utf8"));
					data.previousSha256 = "0".repeat(64);
					await writeFile(path, JSON.stringify(data));
				}
				if (fault === "permissions") await chmod(path, 0o644);
				if (fault === "symlink") {
					await rm(path);
					await symlink(join(f.path, "authority.json"), path);
				}
				if (fault === "partial") await writeFile(path, "{");
				if (fault === "extra") await writeFile(join(f.path, "unknown.json"), "{}");
				await expect(f.reopen()).rejects.toThrow("JOURNAL_UNCONFIRMED");
				await expect(f.initialize()).rejects.toThrow();
				expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
			},
		);
		it("requires explicit initial creation and makes observation/pre-cancellation inert", async () => {
			const f = await fixture(purpose);
			await expect(f.reopen()).rejects.toThrow("JOURNAL_UNCONFIRMED");
			const journal = await f.initialize();
			await expect(journal.observe(signal())).resolves.toEqual({ state: "not_dispatched" });
			await expect(journal.reconcile(AbortSignal.abort())).rejects.toThrow();
			expect(await f.events()).toEqual([]);
			expect(f.calls).toHaveLength(0);
		});
	});

it("never adopts the other phase's authority or event files", async () => {
	const f = await fixture("configuration");
	await f.initialize();
	const authority = join(f.path, "authority.json");
	const original = await readFile(authority, "utf8");
	await writeFile(
		authority,
		original.replace("qorpera.lxd-office-configuration-journal/v1", "qorpera.lxd-office-preparation-journal/v1"),
	);
	await expect(f.reopen()).rejects.toThrow("OFFICE_CONFIGURATION_JOURNAL_UNCONFIRMED");
	await writeFile(authority, original);
	await (await f.reopen()).reconcile(signal());
	const event = join(f.path, "000001.json");
	await writeFile(
		event,
		(await readFile(event, "utf8")).replace(
			"qorpera.lxd-office-configuration-event/v1",
			"qorpera.lxd-office-preparation-event/v1",
		),
	);
	await expect(f.reopen()).rejects.toThrow("OFFICE_CONFIGURATION_JOURNAL_UNCONFIRMED");
	expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
});

for (const lane of [
	{ purpose: "service-start", inspect: "submitOfficeServiceInspection" },
	{ purpose: "boot-service-start", inspect: "submitOfficeBootServiceInspection" },
	{ purpose: "boot-service-restart", inspect: "submitOfficeBootServiceRestartInspection" },
	{ purpose: "reset-service-restart", inspect: "submitOfficeResetServiceRestartInspection" },
	{ purpose: "reset-service-start", inspect: "submitOfficeResetServiceInspection" },
	{ purpose: "outage-service-start", inspect: "submitOfficeOutageServiceInspection" },
	{ purpose: "service-stop", inspect: "submitOfficeServiceStopInspection" },
	{ purpose: "service-restart", inspect: "submitOfficeServiceRestartInspection" },
] as const)
	describe(`fixed ${lane.purpose} inspection mode over actual Unix HTTP`, () => {
		it("adds only the fresh nonce to the original command", async () => {
			const f = await fixture();
			await f.client[lane.inspect]("offices", name, command, id(500), signal());
			expect(f.calls).toHaveLength(1);
			expect(f.calls[0].body).toEqual({
				command: [
					"/usr/bin/env",
					"-i",
					"/usr/bin/node",
					`/opt/qorpera-office/qorpera-company-computer-${lane.purpose}-control.mjs`,
					command.commandId,
					command.requestSha256,
					command.bootId,
					id(500),
				],
				interactive: false,
				"wait-for-websocket": false,
				"record-output": true,
				user: 0,
				group: 0,
				cwd: "/",
				environment: {},
			});
		});
		it.each([undefined, null, "", command.commandId, "../escape", "--locked", `${id(500).toUpperCase()}x`])(
			"refuses %s instead of falling back to an effect",
			async (nonce) => {
				const f = await fixture();
				await expect(f.client[lane.inspect]("offices", name, command, nonce as string, signal())).rejects.toThrow(
					"SUBMISSION_UNCONFIRMED",
				);
				expect(f.calls).toHaveLength(0);
			},
		);
	});
