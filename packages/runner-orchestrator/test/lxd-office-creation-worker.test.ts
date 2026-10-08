import { mkdtemp, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPlugClaim } from "../src/agent-plug.ts";
import { type LxdInstanceRecord, LxdUnixClient } from "../src/lxd-client.ts";
import { LxdOfficeCreationWorker } from "../src/lxd-office-creation-worker.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { lxdOfficePhysicalPolicySha256 } from "../src/lxd-office-physical-policy.ts";
import { nodeAdmissionFixture } from "./fixtures/node-admission.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";
import { pluggedOfficeRequest, testAgentMac, testAgentPlug } from "./helpers/agent-plug.ts";

const intentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const { policy } = officePhysicalFixture();
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-create-")));
	roots.push(root);
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	const scope = {
		companyId: policy.guest.companyId,
		environmentId: policy.guest.environmentId,
		companyComputerId: policy.guest.companyComputerId,
		logicalComputerId: policy.guest.logicalComputerId,
	};
	const state = {
		enabled: true,
		office: "provisioning",
		intent: "requested" as string | null,
		reservation: null as Record<string, unknown> | null,
		capacity: true,
		nodeCapacity: true,
		authority: true,
		lostReservation: false,
		lostSubmission: false,
		operation: "succeeded" as "pending" | "failed" | "succeeded",
		instance: undefined as LxdInstanceRecord | undefined,
		hiddenInstance: false,
	};
	const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
	const readIdentity = async () =>
		JSON.parse(await readFile(join(root, `intent-${intentId}.json`), "utf8")) as {
			binding: LxdOfficeGuestBinding;
			createCommandId: string;
		};
	const registry = {
		call: async (method: string, args: Record<string, unknown>, signal: AbortSignal) => {
			signal.throwIfAborted();
			calls.push({ method, args });
			if (method === "qorpera_reserve_runtime_node_machine") {
				expect(state.reservation?.allocationId).toBe(args.p_allocation_id);
				return state.nodeCapacity
					? nodeAdmissionFixture(args)
					: { state: "refused", reason: "NODE_CAPACITY_EXHAUSTED" };
			}
			if (method === "qorpera_runtime_office_provider_status")
				return {
					schema: "qorpera.office-provider-status/v1",
					scope,
					computerGeneration: 1,
					providerId: policy.guest.providerId,
					providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
					providerVersion: 1,
					preparationEnabled: state.enabled,
					officeState: state.office,
					imageSha256: policy.guest.imageFingerprint,
					bootstrapSha256: policy.guest.bootstrapSha256,
					intent:
						state.intent === null
							? null
							: {
									schema: "qorpera.office-start-intent/v1",
									intentId,
									companyComputerId: scope.companyComputerId,
									computerGeneration: 1,
									state: state.intent,
								},
					reservation: state.reservation,
				};
			if (method === "qorpera_reserve_runtime_office_start") {
				const local = await readIdentity();
				// Both durable layers must precede the first cloud reservation.
				expect(local.binding.allocationId).toBe(args.p_allocation_id);
				expect(
					JSON.parse(await readFile(join(root, local.binding.allocationId, "authority.json"), "utf8")).binding,
				).toEqual(local.binding);
				if (!state.capacity) return { state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" };
				state.reservation = {
					allocationId: args.p_allocation_id,
					instanceSha256: args.p_instance_sha256,
					providerBindingSha256: args.p_provider_binding_sha256,
				};
				state.intent = "reserved";
				if (state.lostReservation) {
					state.lostReservation = false;
					throw new Error("lost reservation response");
				}
				return {
					schema: "qorpera.office-start-intent/v1",
					intentId,
					companyComputerId: scope.companyComputerId,
					computerGeneration: 1,
					state: "reserved",
					...state.reservation,
				};
			}
			if (method === "qorpera_check_runtime_office_start") {
				if (!state.authority || !state.enabled || state.intent !== "reserved") throw new Error("authority revoked");
				return { state: "authorized", intentId, computerGeneration: 1, validForMs: 5000 };
			}
			throw new Error("unexpected registry mutation");
		},
	};
	const inspect = vi.fn(async (signal: AbortSignal) => {
		signal.throwIfAborted();
		return {
			signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
			validForMs: 5000,
			hostBootId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		};
	});
	const gate = { policy, inspect };
	const client = new LxdUnixClient("/not-used-office-fixture.socket");
	const get = vi
		.spyOn(client, "getInstance")
		.mockImplementation(async () => (state.hiddenInstance ? undefined : state.instance));
	const submit = vi.spyOn(client, "submitInstanceOperation").mockImplementation(async (project, action) => {
		expect(action.action).toBe("create");
		if (action.action !== "create") throw new Error("unexpected power operation");
		const binding = (await readIdentity()).binding;
		expect(action.request).toEqual(pluggedOfficeRequest(binding));
		const config = { ...action.request.config, "volatile.base_image": binding.imageFingerprint };
		state.instance = {
			name: action.request.name,
			type: "virtual-machine",
			status: "Stopped",
			statusCode: 102,
			config,
			expandedConfig: { ...config },
			devices: action.request.devices,
			expandedDevices: action.request.devices,
			profiles: [],
		};
		if (state.lostSubmission) throw new Error("lost provider response");
		return { project, instanceName: action.request.name, operationId };
	});
	const observe = vi.spyOn(client, "inspectInstanceOperation").mockImplementation(async () => state.operation);
	const plug = vi.fn(async (claim: AgentPlugClaim, signal: AbortSignal) => {
		calls.push({ method: "plug", args: { ...claim } });
		return testAgentPlug(claim, signal);
	});
	const worker = () => new LxdOfficeCreationWorker(gate, registry, client, plug);
	return { root, policy, state, calls, readIdentity, inspect, get, submit, observe, plug, worker };
}
const signal = () => new AbortController().signal;
describe("durable office creation from retained cloud intent", () => {
	it("retains the company reservation while node capacity refuses creation, then retries the same identity", async () => {
		const f = await fixture();
		f.state.nodeCapacity = false;
		const waiting = await f.worker().reconcile(signal());
		expect(waiting).toMatchObject({ state: "capacity_refused", reason: "NODE_CAPACITY_EXHAUSTED" });
		expect(f.state.reservation).not.toBeNull();
		expect(f.submit).not.toHaveBeenCalled();
		const before = await f.readIdentity();
		f.state.nodeCapacity = true;
		expect((await f.worker().reconcile(signal())).state).toBe("awaiting_adoption");
		expect(await f.readIdentity()).toEqual(before);
		expect(f.submit).toHaveBeenCalledOnce();
		// A plug never followed by a create is the same entry when it is plugged in again.
		expect(f.plug).toHaveBeenCalledTimes(2);
		expect(f.plug.mock.calls[1][0]).toEqual(f.plug.mock.calls[0][0]);
	});
	it("plugs the computer's agent card in right before its create, with the computer's identity", async () => {
		const f = await fixture();
		await expect(f.worker().reconcile(signal())).resolves.toHaveProperty("state", "awaiting_adoption");
		const { binding } = await f.readIdentity();
		expect(f.plug).toHaveBeenCalledOnce();
		expect(f.plug.mock.calls[0][0]).toEqual({
			kind: "office",
			companyId: binding.companyId,
			machineId: binding.companyComputerId,
			memberUserId: null,
			project: binding.project,
			instance: lxdOfficeGuestPlan(binding).request.name,
		});
		// After the company reservation, before the fresh authority that bounds the create.
		const methods = f.calls.map((call) => call.method);
		expect(methods.indexOf("plug")).toBeGreaterThan(methods.indexOf("qorpera_reserve_runtime_office_start"));
		expect(methods.indexOf("plug")).toBeLessThan(methods.indexOf("qorpera_check_runtime_office_start"));
		expect(f.state.instance?.devices.plug?.hwaddr).toBe(testAgentMac);
		// A dispatched create is never plugged in again.
		await f.worker().reconcile(signal());
		expect(f.plug).toHaveBeenCalledOnce();
	});
	it("creates nothing while the plug refuses, then the same identity once it plugs in", async () => {
		const f = await fixture();
		f.plug.mockRejectedValueOnce(new Error("PLUGGED_IN_FOR_ANOTHER_MACHINE"));
		await expect(f.worker().reconcile(signal())).rejects.toThrow("PLUGGED_IN_FOR_ANOTHER_MACHINE");
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.calls.map((call) => call.method)).not.toContain("qorpera_check_runtime_office_start");
		expect(f.state.reservation).not.toBeNull();
		const before = await f.readIdentity();
		await expect(f.worker().reconcile(signal())).resolves.toHaveProperty("state", "awaiting_adoption");
		expect(await f.readIdentity()).toEqual(before);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("refuses a plug answer that is not a plug MAC before claiming the create", async () => {
		const f = await fixture();
		f.plug.mockResolvedValueOnce("00:16:3e:00:00:01");
		await expect(f.worker().reconcile(signal())).rejects.toThrow("AGENT_PLUG_INVALID");
		expect(f.submit).not.toHaveBeenCalled();
		await expect(f.worker().reconcile(signal())).resolves.toHaveProperty("state", "awaiting_adoption");
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it.each([false, true])(
		"retains cancelled work until the ignored physical probe settles (composed=%s)",
		async (composed) => {
			const f = await fixture();
			const worker = f.worker();
			const stop = new AbortController();
			let settle!: () => void;
			f.inspect.mockImplementationOnce(
				(signal) =>
					new Promise((resolve) => {
						settle = () =>
							resolve({ signal, validForMs: 5000, hostBootId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
					}),
			);
			const result = composed ? worker.reconcileSettled(stop.signal) : worker.reconcile(stop.signal);
			let finished = false;
			void result
				.finally(() => {
					finished = true;
				})
				.catch(() => {});
			await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledTimes(1));
			stop.abort();
			if (composed) {
				await new Promise((resolve) => setImmediate(resolve));
				expect(finished).toBe(false);
			} else await expect(result).rejects.toThrow("OFFICE_CREATION_RECONCILIATION_ABORTED");
			await expect(worker.reconcile(signal())).rejects.toThrow("OFFICE_CREATION_RECONCILIATION_PENDING");
			settle();
			await expect(result).rejects.toThrow("OFFICE_CREATION_RECONCILIATION_ABORTED");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(await readdir(f.root)).toEqual([]);
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it("persists both journals, reserves, checks current authority, submits once and verifies a stopped VM", async () => {
		const f = await fixture();
		const first = await f.worker().reconcile(signal());
		expect(first.state).toBe("awaiting_adoption");
		expect(f.submit).toHaveBeenCalledTimes(1);
		await expect(f.worker().reconcile(signal())).resolves.toEqual(first);
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(f.calls.filter((call) => call.method === "qorpera_reserve_runtime_office_start")).toHaveLength(1);
		expect(f.state.office).toBe("provisioning");
	});
	it("recovers a lost reservation response with the same allocation and command", async () => {
		const f = await fixture();
		f.state.lostReservation = true;
		await expect(f.worker().reconcile(signal())).rejects.toThrow("lost reservation response");
		const before = await f.readIdentity();
		expect(f.submit).not.toHaveBeenCalled();
		await expect(f.worker().reconcile(signal())).resolves.toMatchObject({
			state: "awaiting_adoption",
			allocationId: before.binding.allocationId,
		});
		expect(await f.readIdentity()).toEqual(before);
	});
	it("never repeats an unknown create, even when subsequent instance reads report absence", async () => {
		const f = await fixture();
		f.state.lostSubmission = true;
		const first = await f.worker().reconcile(signal());
		expect(first.state).toBe("unknown");
		f.state.hiddenInstance = true;
		for (let attempt = 0; attempt < 3; attempt++)
			await expect(f.worker().reconcile(signal())).resolves.toEqual(first);
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(f.observe).not.toHaveBeenCalled();
		expect(f.state.reservation).not.toBeNull();
	});
	it("resumes accepted operations after worker replacement without redispatch", async () => {
		const f = await fixture();
		f.state.operation = "pending";
		await expect(f.worker().reconcile(signal())).resolves.toMatchObject({ state: "pending", operationId });
		f.state.operation = "succeeded";
		await expect(f.worker().reconcile(signal())).resolves.toMatchObject({ state: "awaiting_adoption", operationId });
		expect(f.submit).toHaveBeenCalledTimes(1);
	});
	it("retains failed operations and does not release capacity or create another VM", async () => {
		const f = await fixture();
		f.state.operation = "failed";
		const first = await f.worker().reconcile(signal());
		expect(first.state).toBe("failed");
		await expect(f.worker().reconcile(signal())).resolves.toEqual(first);
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(f.state.reservation).not.toBeNull();
	});
	it("keeps one durable identity across capacity refusal and a later successful reservation", async () => {
		const f = await fixture();
		f.state.capacity = false;
		const first = await f.worker().reconcile(signal());
		expect(first.state).toBe("capacity_refused");
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.plug).not.toHaveBeenCalled();
		const identity = await f.readIdentity();
		f.state.capacity = true;
		await expect(f.worker().reconcile(signal())).resolves.toMatchObject({
			state: "awaiting_adoption",
			allocationId: identity.binding.allocationId,
		});
	});
	it.each(["idle", "cancelled", "disabled", "active"])(
		"does not allocate or inspect physical state while %s",
		async (mode) => {
			const f = await fixture();
			if (mode === "idle") f.state.intent = null;
			if (mode === "cancelled") f.state.intent = "cancelled";
			if (mode === "disabled") f.state.enabled = false;
			if (mode === "active") f.state.office = "active";
			await expect(f.worker().reconcile(signal())).resolves.toMatchObject({
				state: mode === "idle" ? "idle" : "held",
			});
			expect(f.inspect).not.toHaveBeenCalled();
			expect(f.submit).not.toHaveBeenCalled();
			expect(await readdir(f.root)).toEqual([]);
		},
	);
	it("refuses revoked authority immediately before dispatch and retains the reservation", async () => {
		const f = await fixture();
		f.state.authority = false;
		await expect(f.worker().reconcile(signal())).rejects.toThrow("authority revoked");
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.state.reservation).not.toBeNull();
	});
	it.each(["index", "authority", "directory"])(
		"never recreates a missing %s after a cloud reservation",
		async (missing) => {
			const f = await fixture();
			f.state.authority = false;
			await expect(f.worker().reconcile(signal())).rejects.toThrow();
			const identity = await f.readIdentity();
			const path =
				missing === "index"
					? join(f.root, `intent-${intentId}.json`)
					: missing === "authority"
						? join(f.root, identity.binding.allocationId, "authority.json")
						: join(f.root, identity.binding.allocationId);
			await rm(path, { recursive: true });
			f.state.authority = true;
			await expect(f.worker().reconcile(signal())).rejects.toThrow();
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it("also refuses a lost operation journal behind a stale requested cloud snapshot", async () => {
		const f = await fixture();
		f.state.capacity = false;
		await f.worker().reconcile(signal());
		const identity = await f.readIdentity();
		await unlink(join(f.root, identity.binding.allocationId, "authority.json"));
		f.state.capacity = true;
		await expect(f.worker().reconcile(signal())).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.calls.filter((call) => call.method === "qorpera_reserve_runtime_office_start")).toHaveLength(1);
	});
	it("elects one allocation and command across concurrent workers", async () => {
		const f = await fixture();
		// Transient publication races may reject a reader; all recoveries must
		// use the eventual winner, never another allocation or create command.
		await Promise.allSettled(Array.from({ length: 5 }, () => f.worker().reconcile(signal())));
		await expect(f.worker().reconcile(signal())).resolves.toHaveProperty("state", "awaiting_adoption");
		expect(f.submit).toHaveBeenCalledTimes(1);
		expect(
			new Set(
				f.calls
					.filter((call) => call.method === "qorpera_reserve_runtime_office_start")
					.map((call) => call.args.p_allocation_id),
			).size,
		).toBe(1);
	});
	it("rejects VM drift or unexpected running state after successful creation", async () => {
		const f = await fixture();
		await f.worker().reconcile(signal());
		f.state.instance!.status = "Running";
		f.state.instance!.statusCode = 103;
		await expect(f.worker().reconcile(signal())).rejects.toThrow("OFFICE_CREATION_STOPPED_VM_UNCONFIRMED");
		f.state.instance!.status = "Stopped";
		f.state.instance!.statusCode = 102;
		// The agent card must be there, with a plug's MAC.
		const plugged = f.state.instance!.devices;
		const { plug, ...unplugged } = plugged;
		for (const devices of [unplugged, { ...plugged, plug: { ...plug, hwaddr: "00:16:3e:00:00:01" } }]) {
			f.state.instance!.devices = f.state.instance!.expandedDevices = devices;
			await expect(f.worker().reconcile(signal())).rejects.toThrow("LXD_OFFICE_GUEST_DRIFTED");
		}
		f.state.instance!.devices = plugged;
		f.state.instance!.expandedDevices = {
			...f.state.instance!.devices,
			forbidden: { type: "disk", source: "/secrets", path: "/secrets" },
		};
		await expect(f.worker().reconcile(signal())).rejects.toThrow("LXD_OFFICE_GUEST_DRIFTED");
		expect(f.submit).toHaveBeenCalledTimes(1);
	});
	it("never allocates while physical policy inspection fails", async () => {
		const f = await fixture();
		f.inspect.mockRejectedValue(new Error("physical mismatch"));
		await expect(f.worker().reconcile(signal())).rejects.toThrow("physical mismatch");
		expect(await readdir(f.root)).toEqual([]);
		expect(f.submit).not.toHaveBeenCalled();
	});
});
