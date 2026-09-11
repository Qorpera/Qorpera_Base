import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { LxdUnixClient } from "../../src/lxd-client.ts";
import { planLxdOfficeAdoption } from "../../src/lxd-office-adoption-plan.ts";
import { LxdOfficeBootWorker } from "../../src/lxd-office-boot-worker.ts";
import { openLxdOfficeCreationIdentity } from "../../src/lxd-office-creation-journal.ts";
import { lxdOfficeGuestPlan } from "../../src/lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../../src/lxd-office-inventory-worker.ts";
import { publish } from "../../src/lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "../../src/lxd-office-operations.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { nodeAdmissionFixture } from "./node-admission.ts";
import { officePhysicalFixture } from "./office-physical-policy.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = (): AbortSignal => new AbortController().signal;
export async function officeBootWorkerFixture(roots: string[]) {
	const { policy } = officePhysicalFixture();
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-boot-worker-")));
	roots.push(root);
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	const client = new LxdUnixClient("/unused-office-boot.socket");
	let running = false;
	const submit = vi.spyOn(client, "submitInstanceOperation").mockImplementation(async (project, action) => {
		if (action.action === "start") running = true;
		return {
			project,
			instanceName: action.action === "create" ? action.request.name : action.name,
			operationId: action.action === "create" ? id(2) : id(3),
		};
	});
	const inspect = vi.spyOn(client, "inspectInstanceOperation").mockResolvedValue("succeeded");
	const identity = await openLxdOfficeCreationIdentity(policy, id(1), false, client, signal());
	const journal = await LxdOfficeOperationJournal.open(root, id(1), identity.binding, client, true);
	await journal.reconcile(identity.createCommandId, "create", signal());
	submit.mockClear();
	inspect.mockClear();
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
	const get = vi.spyOn(client, "getInstance").mockImplementation(async () => ({
		...instance,
		status: running ? "Running" : "Stopped",
		statusCode: running ? 103 : 102,
	}));
	const file = vi
		.spyOn(client, "readInstanceFile")
		.mockResolvedValue({ content: Buffer.from(`${id(4)}\n`), uid: 0, gid: 0, mode: 0o444 });
	const execute = vi.spyOn(client, "execInstance").mockRejectedValue(new Error("unexpected guest command"));
	const push = vi.spyOn(client, "pushInstanceFile").mockRejectedValue(new Error("unexpected guest mutation"));
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId: id(1),
		allocationId: binding.allocationId,
		providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
		hostBootId: id(5),
		inventory: {
			schema: "qorpera.office-storage-inventory/v1",
			root: binding.workbenchSource,
			mountId: "123",
			totalBytes: 0,
			entries: [
				{
					path: ".",
					kind: "directory",
					dev: "1",
					ino: "1",
					uid: 1000,
					gid: 1000,
					mode: 0o700,
					mtimeNs: "1",
					ctimeNs: "1",
					bytes: 0,
					sha256: null,
				},
			],
		},
	};
	const input = {
		schema: "qorpera.lxd-office-adoption-input/v1",
		adoptionId: id(6),
		shared: { workbench: null, desktopHome: null },
		legacy: null,
		quarantine: [],
	};
	const plan = planLxdOfficeAdoption(input, binding, observation);
	const handoffBytes = Buffer.from(
		officeCanonical({
			schema: "qorpera.lxd-office-storage-maintenance/v1",
			state: "exclusive_writers_confirmed",
			hostBootId: observation.hostBootId,
			providerBindingSha256: observation.providerBindingSha256,
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
		}),
	);
	const reviewBytes = Buffer.from(
		officeCanonical({
			schema: "qorpera.lxd-office-storage-review/v1",
			reviewId: id(7),
			decision: "initialize_empty",
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
			writerFence: {
				state: "exclusive_writers_confirmed",
				evidenceSha256: createHash("sha256").update(handoffBytes).digest("hex"),
			},
		}),
	);
	const copyAuthority = {
		schema: "qorpera.lxd-office-adoption-authority/v1",
		observationSha256: officeDigest(observation),
		planSha256: officeDigest(plan),
		reviewSha256: createHash("sha256").update(reviewBytes).digest("hex"),
	};
	const copy = {
		...copyAuthority,
		schema: "qorpera.lxd-office-adoption-copy/v1",
		state: "copied",
		adoptionId: plan.adoptionId,
		outputInventorySha256: "f".repeat(64),
	};
	const files = {
		observation: `inventory-${officeDigest(observation)}.json`,
		authority: `adoption-${plan.adoptionId}.json`,
		copy: `adoption-result-${plan.adoptionId}.json`,
		bootIntent: `boot-intent-${binding.allocationId}.json`,
		boot: `boot-observation-${binding.allocationId}.json`,
	};
	for (const [name, value] of [
		[files.observation, observation],
		[files.authority, copyAuthority],
		[files.copy, copy],
	] as const)
		await publish(root, name, Buffer.from(officeCanonical(value)));
	const request = {
		intentId: id(1),
		observationSha256: officeDigest(observation),
		input,
		reviewPath: "/protected/review.json",
		writerFencePath: "/protected/maintenance.json",
	};
	const call = vi.fn(async (method: string, args: Record<string, unknown>) =>
		method === "qorpera_reserve_runtime_node_machine"
			? nodeAdmissionFixture(args)
			: {
					state: "authorized",
					intentId: id(1),
					computerGeneration: 1,
					validForMs: 5000,
					mappings: args.p_mappings,
				},
	);
	const check = vi.fn(async () => ({ signal: signal(), validForMs: 5000, hostBootId: observation.hostBootId }));
	const kernelLock = vi.fn(async () => {});
	const readProtected = vi.fn(async (path: string) => {
		if (path === request.reviewPath) return reviewBytes;
		if (path === request.writerFencePath) return handoffBytes;
		if (path === `${request.reviewPath}.preparation-recovery`)
			throw Object.assign(new Error("no preparation recovery review"), { code: "ENOENT" });
		throw new Error("unexpected protected path");
	});
	const create = () => new LxdOfficeBootWorker({ policy, check }, { call }, { client, kernelLock, readProtected });
	return {
		root,
		client,
		policy,
		request,
		binding,
		identity,
		instance,
		journal,
		create,
		worker: create(),
		submit,
		inspect,
		get,
		file,
		execute,
		push,
		call,
		check,
		kernelLock,
		readProtected,
		reviewBytes,
		handoffBytes,
		files,
		copy,
		running: () => running,
	};
}
