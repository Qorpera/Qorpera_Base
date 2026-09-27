import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_GUEST_LAYOUT_KEYS,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResetAdoptionReceiptPath,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { CompanyComputerLinuxBoundary } from "@qorpera/runtime/cloud-company-computer-linux-boundary";
import { OfficeComputerMeteringPending } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";
import { bootConfigurationFixture } from "./fixtures/company-computer-boot-configuration.ts";

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
	const startupIdentity = () => ({
		scope: options.scope,
		computerGeneration: options.computerGeneration,
		allocationId: options.attestation.allocationId,
		instanceSha256: options.attestation.instanceSha256,
		imageSha256: options.attestation.imageSha256,
		bootstrapSha256: options.attestation.bootstrapSha256,
		bootId: options.attestation.bootId,
		configurationSha256: "e".repeat(64),
		serviceInvocationId: "f".repeat(32),
	});
	const create = () => new CompanyComputerLinuxBoundary({ ...options, startupIdentity: startupIdentity() });
	return { options, receipt, publish, registry, create, startupIdentity, signal: new AbortController().signal };
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
	it.each([1, 2] as const)(
		"admits a resumed boot of a layout version %i office through its retained boot receipt",
		async (version) => {
			// Service startup after power-off/resume: the attested receipt is the boot
			// adoption receipt, which carries the company root on layout version 2.
			const b = bootConfigurationFixture(
				version === 1
					? {}
					: {
							original: {
								layoutVersion: 2,
								entries: [".", "company", "desktop", "profiles", "screens", "workbench"].map((path) => ({
									path,
									kind: "directory" as const,
									mode: 0o700,
									bytes: 0,
									sha256: null,
								})),
							},
						},
			);
			const linux = JSON.parse(b.input.material.configuration).linux;
			expect(Object.keys(linux.layout).sort()).toEqual([...COMPANY_COMPUTER_GUEST_LAYOUT_KEYS[version]].sort());
			let text = `${JSON.stringify(b.receipt)}\n`;
			expect(createHash("sha256").update(text).digest("hex")).toBe(linux.attestation.adoptionReceiptSha256);
			physical.read.mockImplementation(async (path) =>
				path.endsWith("boot_id") ? `${linux.attestation.bootId}\n` : text,
			);
			const create = (adoptionReceiptSha256: string) =>
				new CompanyComputerLinuxBoundary({
					...linux,
					attestation: { ...linux.attestation, adoptionReceiptSha256 },
					scope: b.original.scope,
					computerGeneration: 1,
					registry: {
						call: vi.fn(async () => ({ state: "authorized", computerGeneration: 1, validForMs: 5000 })),
					},
				});
			await create(linux.attestation.adoptionReceiptSha256).assertPhysicalReady(new AbortController().signal);
			expect(physical.open.mock.calls.map(([path]) => path)).toEqual([
				...Object.values(b.receipt.layout),
				"/run/qorpera-office/private",
			]);
			// An attested receipt with a root outside the admitted key sets is still refused.
			text = `${JSON.stringify({ ...b.receipt, layout: { ...b.receipt.layout, otherRoot: "/var/lib/qorpera-office/other" } })}\n`;
			await expect(
				create(createHash("sha256").update(text).digest("hex")).assertPhysicalReady(new AbortController().signal),
			).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
		},
	);
	it.each([1, 2] as const)(
		"binds a reset-born boot to the original attested receipt through the retained reset receipt (layout version %i)",
		async (version) => {
			const f = fixture();
			if (version === 2) {
				Object.assign(f.options.layout, { companyRoot: "/srv/company" });
				f.publish(f.receipt);
			}
			const a = f.options.attestation;
			const originBootId = a.bootId;
			const resetBootId = computerId(73);
			const retained = {
				schema: "qorpera.office-state-reset-retained/v1",
				state: "complete",
				scope: f.options.scope,
				computerGeneration: 1,
				allocationId: a.allocationId,
				instanceSha256: a.instanceSha256,
				imageSha256: a.imageSha256,
				bootstrapSha256: a.bootstrapSha256,
				bootId: resetBootId,
				layout: f.options.layout,
				workbenchMount: f.options.workbenchMount,
				origin: {
					bootId: originBootId,
					preparationSha256: "1".repeat(64),
					adoptionReceiptSha256: a.adoptionReceiptSha256,
				},
				reset: {
					resetId: computerId(74),
					rootIncarnationId: computerId(75),
					activationId: computerId(76),
					predecessor: { transitionId: computerId(77), activationId: computerId(78), bootId: computerId(79) },
				},
			};
			const originalText = JSON.stringify(f.receipt);
			let retainedText = JSON.stringify(retained);
			a.bootId = resetBootId;
			physical.read.mockImplementation(async (path) =>
				path.endsWith("boot_id")
					? `${resetBootId}\n`
					: path === companyComputerResetAdoptionReceiptPath(resetBootId)
						? retainedText
						: originalText,
			);
			const boundary = f.create();
			await boundary.assertOfficeReady(f.signal);
			expect(physical.artifact).toHaveBeenCalledWith(companyComputerResetAdoptionReceiptPath(resetBootId));
			for (const broken of [
				{ ...retained, bootId: computerId(80) },
				{ ...retained, origin: { ...retained.origin, adoptionReceiptSha256: "9".repeat(64) } },
				{ ...retained, origin: { ...retained.origin, bootId: computerId(81) } },
				{ ...retained, allocationId: computerId(82) },
				{ ...retained, layout: { ...retained.layout, workbenchRoot: "/srv/other" } },
			]) {
				retainedText = JSON.stringify(broken);
				await expect(boundary.assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
			}
			physical.artifact.mockRejectedValueOnce(new Error("missing"));
			retainedText = JSON.stringify(retained);
			await expect(boundary.assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
		},
	);
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
			"qorpera_check_runtime_office_work_binding",
			{ p_startup: f.startupIdentity() },
			expect.any(AbortSignal),
		);
	});
	it("requires exact startup identity for work, while physical preflight and transient recovery remain possible", async () => {
		const f = fixture();
		const missing = new CompanyComputerLinuxBoundary(f.options);
		await missing.assertPhysicalReady(f.signal);
		await expect(missing.assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
		const wrong = new CompanyComputerLinuxBoundary({
			...f.options,
			startupIdentity: { ...f.startupIdentity(), bootId: computerId(99) },
		});
		await expect(wrong.assertOfficeReady(f.signal)).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
		expect(f.registry.call).not.toHaveBeenCalled();
		const boundary = f.create();
		f.registry.call.mockRejectedValueOnce(new OfficeComputerMeteringPending());
		await expect(boundary.assertOfficeReady(f.signal)).rejects.toBeInstanceOf(OfficeComputerMeteringPending);
		await boundary.assertOfficeReady(f.signal);
		expect(f.registry.call).toHaveBeenCalledTimes(2);
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
