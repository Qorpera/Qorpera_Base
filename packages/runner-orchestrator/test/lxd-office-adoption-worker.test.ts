import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import type { executeLxdOfficeAdoptionFiles } from "../src/lxd-office-adoption-files.ts";
import { planLxdOfficeAdoption } from "../src/lxd-office-adoption-plan.ts";
import { assertOfficeStorageMaintenanceHandoff, LxdOfficeAdoptionWorker } from "../src/lxd-office-adoption-worker.ts";
import { openLxdOfficeCreationIdentity } from "../src/lxd-office-creation-journal.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../src/lxd-office-inventory-worker.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";
import { lxdOfficeProviderBindingSha256 } from "../src/lxd-office-start-control.ts";
import { parseLxdOfficeStorageReview } from "../src/lxd-office-storage-review.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const { policy } = officePhysicalFixture();
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-adoption-worker-")));
	roots.push(root);
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	const client = new LxdUnixClient("/unused-adoption-fixture.socket");
	const submit = vi.spyOn(client, "submitInstanceOperation").mockImplementation(async (project, action) => ({
		project,
		instanceName: action.action === "create" ? action.request.name : action.name,
		operationId: action.action === "create" ? id(2) : id(42),
	}));
	vi.spyOn(client, "inspectInstanceOperation").mockResolvedValue("succeeded");
	const identity = await openLxdOfficeCreationIdentity(policy, id(1), false, client, signal());
	const journal = await LxdOfficeOperationJournal.open(root, id(1), identity.binding, client, true);
	await journal.reconcile(identity.createCommandId, "create", signal());
	submit.mockClear();
	const { binding } = identity;
	const { request: vm } = lxdOfficeGuestPlan(binding);
	const instance = {
		name: vm.name,
		type: "virtual-machine" as const,
		status: "Stopped",
		statusCode: 102,
		profiles: [],
		config: { ...vm.config, "volatile.base_image": binding.imageFingerprint },
		expandedConfig: { ...vm.config, "volatile.base_image": binding.imageFingerprint },
		devices: vm.devices,
		expandedDevices: vm.devices,
	};
	const get = vi.spyOn(client, "getInstance").mockResolvedValue(instance);
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId: id(1),
		allocationId: binding.allocationId,
		providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
		hostBootId: id(3),
		inventory: {
			schema: "qorpera.office-storage-inventory/v1",
			root: policy.workbench.mountPoint,
			mountId: "123",
			totalBytes: 0,
			entries: [".", "profiles", "profiles/screen-1", "screens", "screens/screen-1"].map((path, index) => ({
				path,
				kind: "directory",
				dev: "1",
				ino: String(index + 1),
				uid: 1000,
				gid: 1000,
				mode: 0o700,
				mtimeNs: "1",
				ctimeNs: "1",
				bytes: 0,
				sha256: null,
			})),
		},
	};
	const scope = {
		companyId: binding.companyId,
		environmentId: binding.environmentId,
		companyComputerId: binding.companyComputerId,
		logicalComputerId: binding.logicalComputerId,
	};
	const screen = { ...scope, screenId: id(4), staffAgentId: id(5), screenOrdinal: 1 };
	const mapping = {
		binding: { ...screen, screenGeneration: 1, computerGeneration: 1 },
		browserProfile: { profileId: id(6), grantId: id(7), version: 1 },
	};
	const input = {
		schema: "qorpera.lxd-office-adoption-input/v1",
		adoptionId: id(8),
		shared: { workbench: null, desktopHome: null },
		legacy: {
			roots: { screenStateRoot: "screens", browserProfilesRoot: "profiles" },
			mappings: [{ legacy: screen, ...mapping }],
		},
		quarantine: [],
	};
	const plan = planLxdOfficeAdoption(input, binding, observation);
	const handoff = {
		schema: "qorpera.lxd-office-storage-maintenance/v1",
		state: "exclusive_writers_confirmed",
		hostBootId: observation.hostBootId,
		providerBindingSha256: observation.providerBindingSha256,
		observationSha256: officeDigest(observation),
		planSha256: officeDigest(plan),
	};
	const bytes = Buffer.from(officeCanonical(handoff));
	const review = parseLxdOfficeStorageReview(
		{
			schema: "qorpera.lxd-office-storage-review/v1",
			reviewId: id(9),
			decision: "migrate_existing",
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
			writerFence: {
				state: "exclusive_writers_confirmed",
				evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
			},
		},
		observation,
		officeDigest(plan),
	);
	const evidence = `inventory-${officeDigest(observation)}.json`;
	await publish(root, evidence, Buffer.from(officeCanonical(observation)));
	const call = vi.fn(async (_method: string, args: Record<string, unknown>) => ({
		state: "authorized",
		intentId: id(1),
		computerGeneration: 1,
		validForMs: 5000,
		mappings: args.p_mappings,
	}));
	const check = vi.fn(async () => ({ signal: signal(), validForMs: 5000, hostBootId: id(3) }));
	const readProtected = vi.fn(async () => bytes);
	const kernelLock = vi.fn(async () => {});
	const result = {
		schema: "qorpera.lxd-office-adoption-copy/v1" as const,
		state: "copied" as const,
		adoptionId: id(8),
		observationSha256: officeDigest(observation),
		planSha256: officeDigest(plan),
		reviewSha256: officeDigest(review),
		outputInventorySha256: "f".repeat(64),
	};
	const copy = vi.fn<typeof executeLxdOfficeAdoptionFiles>(async (_options, guard, checked) => {
		await guard.assertWritable(plan, review, checked);
		await guard.assertWritable(plan, review, checked);
		return result;
	});
	const limits = { maxEntries: 100, maxDepth: 8, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 };
	const worker = new LxdOfficeAdoptionWorker({ policy, check }, { call }, limits, {
		client,
		copy,
		kernelLock,
		readProtected,
	});
	const request = {
		intentId: id(1),
		observationSha256: officeDigest(observation),
		input,
		reviewPath: "/protected/review.json",
		writerFencePath: "/protected/maintenance.json",
	};
	return {
		root,
		worker,
		request,
		copy,
		check,
		call,
		get,
		instance,
		submit,
		kernelLock,
		readProtected,
		result,
		identity,
		journal,
		observation,
		plan,
		review,
		bytes,
		handoff,
		mapping,
		evidence,
	};
}
describe("office adoption provider composition", () => {
	it("renews actual composition gates for each copy checkpoint and returns only the copier result", async () => {
		const f = await fixture();
		await expect(f.worker.copy(f.request, signal())).resolves.toEqual(f.result);
		expect(f.call).toHaveBeenCalledTimes(2);
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_check_runtime_office_adoption",
			expect.objectContaining({ p_mappings: [f.mapping] }),
			expect.any(AbortSignal),
		);
		expect(f.readProtected).toHaveBeenCalledTimes(2);
		expect(f.readProtected).toHaveBeenLastCalledWith(f.request.writerFencePath, 16384);
		expect(f.kernelLock).toHaveBeenCalledTimes(3);
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("refuses an absent process-owned kernel lock before opening state or invoking the copier", async () => {
		const f = await fixture();
		f.kernelLock.mockRejectedValue(new Error("kernel lock absent"));
		await expect(f.worker.copy(f.request, signal())).rejects.toThrow("kernel lock absent");
		expect(f.copy).not.toHaveBeenCalled();
	});
	it.each(["host", "cloud", "vm", "maintenance", "physical"])(
		"refuses changed %s authority at a later copy checkpoint",
		async (kind) => {
			const f = await fixture();
			if (kind === "host")
				f.check
					.mockResolvedValueOnce({ signal: signal(), validForMs: 5000, hostBootId: id(3) })
					.mockResolvedValue({ signal: signal(), validForMs: 5000, hostBootId: id(99) });
			if (kind === "physical")
				f.check
					.mockResolvedValueOnce({ signal: signal(), validForMs: 5000, hostBootId: id(3) })
					.mockRejectedValue(new Error("physical refused"));
			if (kind === "cloud")
				f.call
					.mockImplementationOnce(async (_method, args) => ({
						state: "authorized",
						intentId: id(1),
						computerGeneration: 1,
						validForMs: 5000,
						mappings: args.p_mappings,
					}))
					.mockRejectedValue(new Error("grant revoked"));
			if (kind === "vm")
				f.get
					.mockResolvedValueOnce(f.instance)
					.mockResolvedValue({ ...f.instance, status: "Running", statusCode: 103 });
			if (kind === "maintenance")
				f.readProtected.mockResolvedValueOnce(f.bytes).mockRejectedValue(new Error("handoff removed"));
			await expect(f.worker.copy(f.request, signal())).rejects.toThrow(
				/HOST_CHANGED|physical refused|grant revoked|STOPPED_VM|handoff removed/,
			);
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it("rejects exact-VM configuration drift even when it remains stopped", async () => {
		const f = await fixture();
		f.get.mockResolvedValue({
			...f.instance,
			expandedDevices: {
				...f.instance.expandedDevices,
				unexpected: { type: "disk", source: "/secret", path: "/secret" },
			},
		});
		await expect(f.worker.copy(f.request, signal())).rejects.toThrow();
		expect(f.readProtected).not.toHaveBeenCalled();
	});
	it("rejects later lifecycle commands even if the VM is currently stopped", async () => {
		const f = await fixture();
		await f.journal.reconcile(id(40), "start", signal());
		f.submit.mockClear();
		await expect(f.worker.copy(f.request, signal())).rejects.toThrow("OFFICE_INITIAL_CREATION_UNCONFIRMED");
		expect(f.call).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
	});
	it.each(["identity", "observation"])("does not reconstruct missing %s evidence", async (kind) => {
		const f = await fixture();
		await unlink(join(f.root, kind === "identity" ? `intent-${id(1)}.json` : f.evidence));
		await expect(f.worker.copy(f.request, signal())).rejects.toThrow();
		expect(f.copy).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("rejects changed observation bytes before copying", async () => {
		const f = await fixture();
		await writeFile(join(f.root, f.evidence), officeCanonical({ ...f.observation, hostBootId: id(90) }));
		await expect(f.worker.copy(f.request, signal())).rejects.toThrow("OFFICE_INVENTORY_EVIDENCE_CHANGED");
		expect(f.copy).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"holds the pending worker until an aborted underlying copy actually settles (composed=%s)",
		async (composed) => {
			const f = await fixture();
			let finish!: () => void;
			f.copy.mockImplementation(async () => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return f.result;
			});
			const caller = new AbortController();
			const running = composed
				? f.worker.copySettled(f.request, caller.signal)
				: f.worker.copy(f.request, caller.signal);
			let finished = false;
			void running
				.finally(() => {
					finished = true;
				})
				.catch(() => {});
			await vi.waitFor(() => expect(f.copy).toHaveBeenCalledOnce());
			caller.abort();
			if (composed) {
				await new Promise((resolve) => setImmediate(resolve));
				expect(finished).toBe(false);
			} else await expect(running).rejects.toThrow("OFFICE_ADOPTION_WORKER_ABORTED");
			await expect(f.worker.copy(f.request, signal())).rejects.toThrow("OFFICE_ADOPTION_WORKER_PENDING");
			finish();
			await expect(running).rejects.toThrow("OFFICE_ADOPTION_WORKER_ABORTED");
			expect(f.copy.mock.calls[0][3]).toBe(true);
		},
	);
	it.each(["schema", "state", "hostBootId", "providerBindingSha256", "observationSha256", "planSha256", "extra"])(
		"rejects root maintenance evidence with altered %s, even with a matching file hash",
		async (field) => {
			const f = await fixture();
			const bytes = Buffer.from(officeCanonical({ ...f.handoff, [field]: "changed" }));
			const review = {
				...f.review,
				writerFence: { ...f.review.writerFence, evidenceSha256: createHash("sha256").update(bytes).digest("hex") },
			};
			expect(() => assertOfficeStorageMaintenanceHandoff(bytes, f.observation, f.plan, review)).toThrow(
				"OFFICE_ADOPTION_MAINTENANCE_HANDOFF_REQUIRED",
			);
		},
	);
	it("does not accept different maintenance bytes with equivalent parsed fields", async () => {
		const f = await fixture();
		expect(() =>
			assertOfficeStorageMaintenanceHandoff(Buffer.from(`${f.bytes}\n`), f.observation, f.plan, f.review),
		).toThrow("OFFICE_ADOPTION_MAINTENANCE_HANDOFF_REQUIRED");
	});
});
