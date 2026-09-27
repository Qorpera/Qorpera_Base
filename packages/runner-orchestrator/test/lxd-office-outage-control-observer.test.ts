import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { type LxdOfficeControlIdentity, LxdOfficeControlJournal } from "../src/lxd-office-control-journal.ts";
import { observeLxdOfficeControlJournals, runLxdOfficeControlObserver } from "../src/lxd-office-control-observer.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const lanes = [
	{
		purpose: "outage-termination",
		submit: "submitOfficeOutageTermination",
		inspect: "inspectOfficeOutageTermination",
	},
	{
		purpose: "outage-configuration",
		submit: "submitOfficeOutageConfiguration",
		inspect: "inspectOfficeOutageConfiguration",
	},
	{
		purpose: "outage-service-start",
		submit: "submitOfficeOutageServiceStart",
		inspect: "inspectOfficeOutageServiceStart",
	},
] as const;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(lane: (typeof lanes)[number]) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "outage-obs-")));
	roots.push(root);
	const binding = lxdOfficeGuestPlan({
		schema: "qorpera.lxd-office-guest/v2",
		providerId: id(1),
		providerPolicySha256: "a".repeat(64),
		companyId: id(2),
		environmentId: id(3),
		companyComputerId: id(4),
		logicalComputerId: id(5),
		computerGeneration: 1,
		allocationId: id(6),
		project: "offices",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	}).binding;
	const identity: LxdOfficeControlIdentity = {
		intentId: id(7),
		binding,
		bootObservationSha256: "d".repeat(64),
		command: { commandId: id(8), bootId: id(9), requestSha256: "e".repeat(64) },
		activationId: id(10),
		recoveryId: id(11),
		...(lane.purpose === "outage-service-start"
			? { configurationObservationSha256: "f".repeat(64) }
			: { originPreparationSha256: "f".repeat(64) }),
	};
	const name = lxdOfficeGuestPlan(binding).request.name;
	const reference = { project: binding.project, instanceName: name, operationId: id(12) };
	const responseState: { value: "pending" | "succeeded" | "failed" | "missing" } = { value: "pending" };
	const calls: { method: string; url: string }[] = [];
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			calls.push({ method: request.method ?? "", url: request.url ?? "" });
			const post = request.method === "POST";
			if (!post && responseState.value === "missing") {
				response.writeHead(404, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			const pending = post || responseState.value === "pending";
			response.writeHead(post ? 202 : 200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					type: post ? "async" : "sync",
					status_code: post ? 100 : 200,
					...(post ? { operation: `/1.0/operations/${reference.operationId}` } : {}),
					metadata: {
						id: reference.operationId,
						class: "task",
						status: pending ? "Running" : "Success",
						status_code: pending ? 103 : 200,
						err: "",
						resources: {},
						metadata: {
							entity_url: `/1.0/instances/${name}?project=offices`,
							...(pending ? {} : { return: responseState.value === "succeeded" ? 0 : 1 }),
						},
					},
				}),
			);
		});
	});
	servers.push(server);
	const socket = join(root, "socket");
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(socket, done);
	});
	const client = new LxdUnixClient(socket, 30);
	// Termination attempts really live one level below the provider journal.
	const stateRoot =
		lane.purpose === "outage-termination"
			? join(root, `outage-inspection-${binding.allocationId}-${identity.recoveryId}-000`)
			: root;
	if (stateRoot !== root) await mkdir(stateRoot, { mode: 0o700 });
	const path = join(
		stateRoot,
		`${lane.purpose}-${binding.allocationId}-${lane.purpose === "outage-termination" ? identity.recoveryId : identity.activationId}`,
	);
	const open = (existing = true) =>
		LxdOfficeControlJournal.open(
			stateRoot,
			identity,
			{
				submit: client[lane.submit].bind(client),
				inspect: client[lane.inspect].bind(client),
			},
			existing,
			lane.purpose,
		);
	const journal = await open(false);
	const events = async () =>
		Promise.all(
			(await readdir(path))
				.filter((entry) => /^\d{6}\.json$/.test(entry))
				.sort()
				.map(async (entry) => JSON.parse(await readFile(join(path, entry), "utf8"))),
		);
	const capture = async () => {
		const stop = new AbortController();
		const errors: unknown[] = [];
		await runLxdOfficeControlObserver(
			async (checked) => {
				try {
					await observeLxdOfficeControlJournals(root, client, checked);
				} catch (error) {
					errors.push(error);
				} finally {
					stop.abort();
				}
			},
			stop.signal,
			() => errors.push(new Error("unexpected observer failure")),
		);
		expect(errors).toEqual([]);
	};
	return { root, stateRoot, path, client, calls, responseState, journal, open, events, capture, reference };
}

for (const lane of lanes)
	describe(`${lane.purpose} background terminal retention`, () => {
		it.each(["succeeded", "failed"] as const)(
			"retains %s before HTTP 404 expiry without another dispatch",
			async (state) => {
				const f = await fixture(lane);
				expect(await f.journal.reconcile(signal())).toEqual({
					state: "pending",
					operationId: f.reference.operationId,
				});
				f.responseState.value = state;
				await f.capture();
				expect((await f.events()).map((event) => [event.kind, event.state])).toEqual([
					["dispatch", null],
					["accepted", null],
					["settled", state],
				]);
				f.responseState.value = "missing";
				const count = f.calls.length;
				expect(await (await f.open()).reconcile(signal())).toEqual({ state, operationId: f.reference.operationId });
				expect(f.calls).toHaveLength(count);
				expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
			},
		);
		it.each(["pending", "missing", "untouched"] as const)(
			"does not manufacture a terminal fact for %s",
			async (state) => {
				const f = await fixture(lane);
				if (state !== "untouched") {
					await f.journal.reconcile(signal());
					f.responseState.value = state;
				}
				await f.capture();
				expect((await f.events()).map((event) => event.kind)).toEqual(
					state === "untouched" ? [] : ["dispatch", "accepted"],
				);
				expect((await (await f.open()).observe(signal())).state).toBe(
					state === "untouched" ? "not_dispatched" : state === "missing" ? "unknown" : "pending",
				);
				expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(state === "untouched" ? 0 : 1);
				if (state === "untouched") expect(f.calls).toEqual([]);
			},
		);
	});

it.each(["attempt", "journal"] as const)("does not follow a symlink at the termination %s directory", async (scope) => {
	const f = await fixture(lanes[0]);
	await f.journal.reconcile(signal());
	f.responseState.value = "succeeded";
	const original = scope === "attempt" ? f.stateRoot : f.path;
	const outside = await realpath(await mkdtemp(join(tmpdir(), "outage-outside-")));
	roots.push(outside);
	const moved = join(outside, basename(original));
	await rename(original, moved);
	await symlink(moved, original);
	const count = f.calls.length;
	await expect(observeLxdOfficeControlJournals(f.root, f.client, signal())).rejects.toThrow(
		"OFFICE_CONTROL_OBSERVATION_UNCONFIRMED",
	);
	expect(f.calls).toHaveLength(count);
	const journalPath = scope === "attempt" ? join(moved, basename(f.path)) : moved;
	expect((await readdir(journalPath)).sort()).toEqual(["000000.json", "000001.json", "authority.json"]);
});

it("does not scan arbitrary nested directories or other control purposes inside an outage attempt", async () => {
	const f = await fixture(lanes[1]);
	await f.journal.reconcile(signal());
	f.responseState.value = "succeeded";
	const unrelated = join(f.root, "unrelated");
	await mkdir(unrelated, { mode: 0o700 });
	await rename(f.path, join(unrelated, basename(f.path)));
	const count = f.calls.length;
	await observeLxdOfficeControlJournals(f.root, f.client, signal());
	expect(f.calls).toHaveLength(count);
	const attempt = join(f.root, `outage-inspection-${id(6)}-${id(11)}-000`);
	await rename(unrelated, attempt);
	await observeLxdOfficeControlJournals(f.root, f.client, signal());
	expect(f.calls).toHaveLength(count);
});

it.each([lanes[0], lanes[1]])("retains a valid $purpose result despite an unsafe sibling attempt", async (lane) => {
	const f = await fixture(lane);
	await f.journal.reconcile(signal());
	f.responseState.value = "succeeded";
	const outside = await realpath(await mkdtemp(join(tmpdir(), "outage-outside-")));
	roots.push(outside);
	await symlink(outside, join(f.root, `outage-inspection-${id(90)}-${id(91)}-000`));
	await expect(observeLxdOfficeControlJournals(f.root, f.client, signal())).rejects.toThrow(
		"OFFICE_CONTROL_OBSERVATION_UNCONFIRMED",
	);
	expect((await f.events()).map((event) => [event.kind, event.state])).toEqual([
		["dispatch", null],
		["accepted", null],
		["settled", "succeeded"],
	]);
	f.responseState.value = "missing";
	const count = f.calls.length;
	expect(await (await f.open()).reconcile(signal())).toEqual({
		state: "succeeded",
		operationId: f.reference.operationId,
	});
	expect(f.calls).toHaveLength(count);
	expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	expect(await readdir(outside)).toEqual([]);
});
