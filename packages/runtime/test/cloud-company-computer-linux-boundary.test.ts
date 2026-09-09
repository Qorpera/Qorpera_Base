import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { CompanyComputerLinuxBoundary } from "@qorpera/runtime/cloud-company-computer-linux-boundary";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

const physical = vi.hoisted(() => ({
	host: vi.fn(),
	artifact: vi.fn(),
	read: vi.fn(),
	open: vi.fn(),
	mount: vi.fn(),
	close: vi.fn(),
}));
vi.mock("../src/cloud-company-computer-linux-host.ts", () => ({
	assertCompanyComputerLinuxHost: physical.host,
	assertCompanyComputerImageArtifact: physical.artifact,
	readCompanyComputerLinuxMetadata: physical.read,
	openCompanyComputerLinuxDirectory: physical.open,
	assertCompanyComputerWorkbenchMount: physical.mount,
}));
beforeEach(() => {
	for (const fn of Object.values(physical)) fn.mockReset();
	for (const fn of [physical.host, physical.artifact, physical.mount, physical.close]) fn.mockResolvedValue(undefined);
	physical.open.mockImplementation(async (path) => ({ path, close: physical.close }));
});
function fixture() {
	const registry = {
		call: vi.fn(async (): Promise<unknown> => ({ state: "authorized", computerGeneration: 1, validForMs: 5000 })),
	};
	const options = {
		scope: computerScope(),
		computerGeneration: 1,
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		limits: { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
		workbenchMount: { filesystem: "virtiofs", source: "office", root: "/", mountPoint: "/srv" },
		privateWorkbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/run/private" },
		displayRuntimeRoot: "/run/screens",
		browserRuntimeRoot: "/run/browser",
		captureRoot: "/run/captures",
		registry,
		attestation: {
			allocationId: computerId(70),
			instanceSha256: "a".repeat(64),
			imageSha256: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			bootId: computerId(71),
			adoptionReceiptPath: "/etc/qorpera/adoption.json",
			adoptionReceiptSha256: "d".repeat(64),
		},
	};
	const receipt = {
		schema: "qorpera.office-state-adoption/v1",
		state: "complete",
		scope: options.scope,
		computerGeneration: 1,
		allocationId: options.attestation.allocationId,
		instanceSha256: options.attestation.instanceSha256,
		imageSha256: options.attestation.imageSha256,
		bootstrapSha256: options.attestation.bootstrapSha256,
		bootId: options.attestation.bootId,
		layout: options.layout,
		workbenchMount: options.workbenchMount,
		disposition: "verified_empty",
		inventorySha256: "e".repeat(64),
		reviewSha256: "f".repeat(64),
	};
	let text = JSON.stringify(receipt);
	const publish = (value: unknown) => {
		text = JSON.stringify(value);
		options.attestation.adoptionReceiptSha256 = createHash("sha256").update(text).digest("hex");
	};
	publish(receipt);
	physical.read.mockImplementation(async (path) =>
		path.endsWith("boot_id") ? `${options.attestation.bootId}\n` : text,
	);
	const create = () => new CompanyComputerLinuxBoundary(options);
	return { options, receipt, publish, registry, create, signal: new AbortController().signal };
}
describe("physical office preflight (kernel/filesystem mocked; separate Linux proof)", () => {
	it("separates read-only physical startup checks from mandatory active work authority", async () => {
		const f = fixture(),
			boundary = f.create();
		await boundary.assertPhysicalReady(f.signal);
		expect(f.registry.call).not.toHaveBeenCalled();
		expect(physical.open).toHaveBeenCalledTimes(5);
		f.registry.call.mockRejectedValue(new Error("office still provisioning"));
		await expect(boundary.assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
		expect(f.registry.call).toHaveBeenCalledOnce();
		physical.mount.mockRejectedValue(new Error("mount changed"));
		await expect(boundary.assertPhysicalReady(f.signal)).rejects.toThrow();
	});
	it("accepts the preparation helper's exact adopted receipt while retaining fresh cloud admission", async () => {
		const f = fixture();
		const a = f.options.attestation;
		const request = parseCompanyComputerPreparationRequest({
			schema: "qorpera.office-guest-preparation/v1",
			scope: f.options.scope,
			computerGeneration: 1,
			allocationId: a.allocationId,
			instanceSha256: a.instanceSha256,
			imageSha256: a.imageSha256,
			bootstrapSha256: a.bootstrapSha256,
			bootId: a.bootId,
			uid: 1000,
			gid: 1000,
			copy: {
				adoptionId: computerId(72),
				observationSha256: "a".repeat(64),
				planSha256: "b".repeat(64),
				reviewSha256: "c".repeat(64),
				outputInventorySha256: "d".repeat(64),
			},
			workbenchMount: {
				filesystem: "virtiofs",
				source: "lxd_workbench",
				root: "/",
				mountPoint: "/var/lib/qorpera-office",
			},
			limits: f.options.limits,
			entries: [".", "workbench", "desktop", "profiles", "screens"].map((path) => ({
				path,
				kind: "directory",
				mode: 0o700,
				bytes: 0,
				sha256: null,
			})),
		});
		const receipt = companyComputerPreparationAdoptionReceipt(request);
		expect(receipt.layout.workbenchRoot).toBe(`/var/lib/qorpera-office/.qorpera-adopted-${computerId(72)}/workbench`);
		expect(receipt.disposition).toBe("migration_completed");
		expect(receipt.inventorySha256).toBe(request.copy.outputInventorySha256);
		expect(receipt.reviewSha256).toBe(request.copy.reviewSha256);
		f.options.layout = receipt.layout;
		f.options.workbenchMount = receipt.workbenchMount;
		f.options.attestation.adoptionReceiptPath = COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH;
		f.publish(receipt);
		const boundary = f.create();
		await boundary.assertOfficeReady(f.signal);
		f.registry.call.mockRejectedValue(new Error("office still provisioning"));
		await expect(boundary.assertOfficeReady(f.signal)).rejects.toThrow();
		expect(f.registry.call).toHaveBeenCalledTimes(2);
	});
	it.each(["tmpfs", "ramfs", "overlay"])("rejects volatile workbench filesystem %s", (filesystem) => {
		const f = fixture();
		f.options.workbenchMount.filesystem = filesystem;
		expect(f.create).toThrow("INVALID_OFFICE_STORAGE_BINDING");
	});
	it("rejects a shared private workbench or persistent private framebuffer roots", () => {
		const f = fixture();
		f.options.privateWorkbenchMount.mountPoint = f.options.layout.workbenchRoot;
		expect(f.create).toThrow("INVALID_OFFICE_STORAGE_BINDING");
	});
	it("requires current identity, reviewed adoption, all mounts and fresh cloud allocation on every read", async () => {
		const f = fixture();
		const boundary = f.create();
		expect(physical.read).not.toHaveBeenCalled();
		await boundary.assertOfficeReady(f.signal);
		await boundary.assertReady(computerBinding(), f.signal);
		expect(physical.open).toHaveBeenCalledTimes(10);
		expect(physical.close).toHaveBeenCalledTimes(10);
		expect(f.registry.call).toHaveBeenCalledTimes(2);
		expect(f.registry.call).toHaveBeenLastCalledWith(
			"qorpera_check_runtime_office_guest_binding",
			{
				p_scope: computerScope(),
				p_computer_generation: 1,
				p_allocation_id: f.options.attestation.allocationId,
				p_instance_sha256: "a".repeat(64),
				p_image_sha256: "b".repeat(64),
				p_bootstrap_sha256: "c".repeat(64),
			},
			expect.any(AbortSignal),
		);
	});
	it.each([
		"/srv/workbench/adoption.json",
		"/srv/profiles/adoption.json",
		"/run/private/adoption.json",
		"/run/screens/adoption.json",
		"/etc/../adoption.json",
	])("refuses mutable or aliased receipt path %s", (path) => {
		const f = fixture();
		f.options.attestation.adoptionReceiptPath = path;
		expect(f.create).toThrow("INVALID_OFFICE_GUEST_ATTESTATION");
	});
	it.each(["state", "scope", "generation", "instance", "layout", "mount", "inventory", "review", "extra"])(
		"rejects a correctly hashed but invalid adoption %s",
		async (changed) => {
			const f = fixture();
			const receipt = structuredClone(f.receipt);
			if (changed === "state") receipt.state = "pending";
			else if (changed === "scope") receipt.scope = { ...receipt.scope, companyId: computerId(90) };
			else if (changed === "generation") receipt.computerGeneration++;
			else if (changed === "instance") receipt.instanceSha256 = "d".repeat(64);
			else if (changed === "layout") receipt.layout.workbenchRoot = "/srv/different";
			else if (changed === "mount") receipt.workbenchMount.source = "different";
			else if (changed === "inventory") receipt.inventorySha256 = "missing";
			else if (changed === "review") receipt.reviewSha256 = "missing";
			else Object.assign(receipt, { bypass: true });
			f.publish(receipt);
			await expect(f.create().assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
			expect(f.registry.call).not.toHaveBeenCalled();
		},
	);
	it("rejects replacement of the protected receipt after construction", async () => {
		const f = fixture();
		const boundary = f.create();
		f.publish({ ...f.receipt, disposition: "migration_completed" });
		await expect(boundary.assertOfficeReady(f.signal)).rejects.toThrow();
	});
	it.each(["boot", "artifact", "host", "mount"])(
		"denies changed physical %s without requesting cloud authority",
		async (changed) => {
			const f = fixture();
			if (changed === "boot") physical.read.mockResolvedValue(computerId(99));
			else physical[changed as "artifact" | "host" | "mount"].mockRejectedValue(new Error("synthetic mismatch"));
			await expect(f.create().assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
			expect(f.registry.call).not.toHaveBeenCalled();
			if (changed === "mount") expect(physical.close).toHaveBeenCalledOnce();
		},
	);
	it.each([
		null,
		{ state: "authorized", computerGeneration: 2, validForMs: 5000 },
		{ state: "authorized", computerGeneration: 1, validForMs: 0 },
		{ state: "authorized", computerGeneration: 1, validForMs: 5001 },
		{ state: "authorized", computerGeneration: 1, validForMs: 5000, extra: true },
	])("rejects invalid authority response %j", async (response) => {
		const f = fixture();
		f.registry.call.mockResolvedValue(response);
		await expect(f.create().assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
	});
	it("does not release readiness when cancelled during the authority read", async () => {
		const f = fixture();
		const stop = new AbortController();
		f.registry.call.mockImplementation(async () => {
			stop.abort();
			return { state: "authorized", computerGeneration: 1, validForMs: 5000 };
		});
		await expect(f.create().assertOfficeReady(stop.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
	});
	it("rejects a different screen generation scope before filesystem access", async () => {
		const f = fixture();
		await expect(f.create().assertReady({ ...computerBinding(), computerGeneration: 2 }, f.signal)).rejects.toThrow(
			"OFFICE_GENERATION_MISMATCH",
		);
		expect(physical.read).not.toHaveBeenCalled();
	});
});
