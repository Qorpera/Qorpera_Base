import { createHash } from "node:crypto";
import {
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationReport,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { planLxdOfficeAdoption } from "../src/lxd-office-adoption-plan.ts";
import { createLxdOfficeGuestPreparationRequest } from "../src/lxd-office-guest-preparation.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../src/lxd-office-inventory-worker.ts";
import { lxdOfficeProviderBindingSha256 } from "../src/lxd-office-start-control.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const { binding } = officePhysicalFixture();
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId: id(1),
		allocationId: binding.allocationId,
		providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
		hostBootId: id(2),
		inventory: {
			schema: "qorpera.office-storage-inventory/v1",
			root: binding.workbenchSource,
			mountId: "123",
			totalBytes: 1,
			entries: [".", "old", "old/note"].map((path, index) => ({
				path,
				kind: index === 2 ? "file" : "directory",
				dev: "1",
				ino: String(index + 1),
				uid: 1000,
				gid: 1000,
				mode: index === 2 ? 0o755 : 0o700,
				mtimeNs: "1",
				ctimeNs: "1",
				bytes: index === 2 ? 1 : 0,
				sha256: index === 2 ? createHash("sha256").update("x").digest("hex") : null,
			})),
		},
	};
	const plan = planLxdOfficeAdoption(
		{
			schema: "qorpera.lxd-office-adoption-input/v1",
			adoptionId: id(3),
			shared: { workbench: "old", desktopHome: null },
			legacy: null,
			quarantine: [],
		},
		binding,
		observation,
	);
	const options = {
		binding,
		observation,
		plan,
		result: {
			schema: "qorpera.lxd-office-adoption-copy/v1" as const,
			state: "copied" as const,
			adoptionId: plan.adoptionId,
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
			reviewSha256: "a".repeat(64),
			outputInventorySha256: "b".repeat(64),
		},
		bootId: id(4),
		uid: 1000,
		gid: 1000,
		limits: { memoryBytes: 1024 ** 3, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
		workbenchMount: {
			filesystem: "virtiofs",
			source: "workbench",
			root: "/",
			mountPoint: "/var/lib/qorpera-office" as const,
		},
	};
	return { options, request: createLxdOfficeGuestPreparationRequest(options) };
}
function reportFixture() {
	const { request } = fixture();
	const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const expected = { requestSha256: sha(request), contentSha256: sha(request.entries) };
	const report = {
		schema: "qorpera.office-guest-preparation-result/v1",
		state: "prepared",
		scope: request.scope,
		computerGeneration: request.computerGeneration,
		allocationId: request.allocationId,
		instanceSha256: request.instanceSha256,
		imageSha256: request.imageSha256,
		bootstrapSha256: request.bootstrapSha256,
		bootId: request.bootId,
		copy: request.copy,
		workbenchMount: request.workbenchMount,
		...expected,
		observationSha256: "a".repeat(64),
		entries: request.entries.length,
		totalBytes: request.entries.reduce((sum, entry) => sum + entry.bytes, 0),
		invocationId: "b".repeat(32),
	};
	return { request, report, expected };
}
describe("layout version 2 (company root)", () => {
	it("derives layoutVersion 2, the fifth admitted root and the receipt's company root only from a plan that names it", () => {
		const { options, request } = fixture();
		expect(request).not.toHaveProperty("layoutVersion");
		expect(companyComputerPreparationAdoptionReceipt(request).layout).not.toHaveProperty("companyRoot");
		const plan = planLxdOfficeAdoption(
			{
				schema: "qorpera.lxd-office-adoption-input/v1",
				adoptionId: id(3),
				shared: { workbench: "old", desktopHome: null, company: null },
				legacy: null,
				quarantine: [],
			},
			options.binding,
			options.observation,
		);
		const v2 = createLxdOfficeGuestPreparationRequest({
			...options,
			plan,
			result: { ...options.result, planSha256: officeDigest(plan) },
		});
		expect(v2.layoutVersion).toBe(2);
		expect(v2.entries.find((entry) => entry.path === "company")).toEqual({
			path: "company",
			kind: "directory",
			mode: 0o700,
			bytes: 0,
			sha256: null,
		});
		const root = `/var/lib/qorpera-office/.qorpera-adopted-${id(3)}`;
		expect(companyComputerPreparationAdoptionReceipt(v2).layout).toEqual({
			workbenchRoot: `${root}/workbench`,
			desktopHome: `${root}/desktop`,
			screenStateRoot: `${root}/screens`,
			browserProfilesRoot: `${root}/profiles`,
			companyRoot: `${root}/company`,
		});
		// A version 1 request must not carry a company entry, and version 2 must carry it.
		expect(() =>
			parseCompanyComputerPreparationRequest({
				...request,
				entries: [...request.entries, v2.entries.find((e) => e.path === "company")!],
			}),
		).toThrow("INVALID_OFFICE_PREPARATION_REQUEST");
		expect(() =>
			parseCompanyComputerPreparationRequest({ ...v2, entries: v2.entries.filter((e) => e.path !== "company") }),
		).toThrow("INVALID_OFFICE_PREPARATION_REQUEST");
		expect(() => parseCompanyComputerPreparationRequest({ ...v2, layoutVersion: 3 })).toThrow(
			"INVALID_OFFICE_PREPARATION_REQUEST",
		);
	});
});
describe("closed preparation completion data", () => {
	function completionFixture() {
		const f = reportFixture();
		const expected = {
			...f.expected,
			commandId: id(80),
			adoptionReceiptSha256: createHash("sha256")
				.update(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(f.request))}\n`)
				.digest("hex"),
			reportSha256: createHash("sha256")
				.update(`${JSON.stringify(f.report)}\n`)
				.digest("hex"),
		};
		const completion = {
			schema: "qorpera.office-preparation-completion/v2",
			command: { commandId: expected.commandId, requestSha256: expected.requestSha256, bootId: f.request.bootId },
			invocationId: f.report.invocationId,
			reportSha256: expected.reportSha256,
			adoptionReceiptSha256: expected.adoptionReceiptSha256,
			report: f.report,
		};
		return { ...f, expected, completion };
	}
	it("binds the retained command and independently read report, cloning immutable data", () => {
		const f = completionFixture();
		const parsed = parseCompanyComputerPreparationCompletion(f.completion, f.request, f.expected);
		expect(parsed).toEqual(f.completion);
		expect(Object.isFrozen(parsed.command)).toBe(true);
		expect(Object.isFrozen(parsed.report.copy)).toBe(true);
		f.completion.command.commandId = id(81);
		expect(parsed.command.commandId).toBe(id(80));
	});
	it.each(["schema", "command", "invocationId", "reportSha256", "adoptionReceiptSha256", "report", "extra"])(
		"refuses changed completion %s",
		(field) => {
			const f = completionFixture();
			expect(() =>
				parseCompanyComputerPreparationCompletion({ ...f.completion, [field]: "changed" }, f.request, f.expected),
			).toThrow();
		},
	);
	it.each(["commandId", "bootId", "requestSha256"])("refuses a valid but different command %s", (field) => {
		const f = completionFixture();
		const command = { ...f.completion.command, [field]: field === "requestSha256" ? "c".repeat(64) : id(81) };
		expect(() =>
			parseCompanyComputerPreparationCompletion({ ...f.completion, command }, f.request, f.expected),
		).toThrow();
	});
	it.each(["commandId", "reportSha256", "adoptionReceiptSha256"])(
		"refuses changed externally retained %s",
		(field) => {
			const f = completionFixture();
			expect(() =>
				parseCompanyComputerPreparationCompletion(f.completion, f.request, {
					...f.expected,
					[field]: field === "commandId" ? id(81) : "c".repeat(64),
				}),
			).toThrow();
		},
	);
});
describe("closed preparation report data", () => {
	it("matches the delivered request and portable manifest without depending on JSON property order", () => {
		const { request, report, expected } = reportFixture();
		const parsed = parseCompanyComputerPreparationReport(
			{ ...report, scope: Object.fromEntries(Object.entries(report.scope).reverse()) },
			request,
			expected,
		);
		expect(parsed).toEqual(report);
		expect(Object.isFrozen(parsed.copy)).toBe(true);
	});
	it.each([
		"schema",
		"state",
		"scope",
		"computerGeneration",
		"allocationId",
		"instanceSha256",
		"imageSha256",
		"bootstrapSha256",
		"bootId",
		"copy",
		"workbenchMount",
		"contentSha256",
		"observationSha256",
		"entries",
		"totalBytes",
		"requestSha256",
		"invocationId",
		"extra",
	])("refuses altered %s", (field) => {
		const { request, report, expected } = reportFixture();
		expect(() =>
			parseCompanyComputerPreparationReport({ ...report, [field]: "altered" }, request, expected),
		).toThrow();
	});
	it.each(["", "0".repeat(32), "a".repeat(31), "A".repeat(32), "b".repeat(33)])(
		"refuses invalid or absent invocation identity %s",
		(invocationId) => {
			const { request, report, expected } = reportFixture();
			expect(() => parseCompanyComputerPreparationReport({ ...report, invocationId }, request, expected)).toThrow();
		},
	);
	it("refuses a report for a different exact request encoding or expected manifest", () => {
		const { request, report, expected } = reportFixture();
		for (const changed of [
			{ ...expected, requestSha256: "c".repeat(64) },
			{ ...expected, contentSha256: "d".repeat(64) },
		])
			expect(() => parseCompanyComputerPreparationReport(report, request, changed)).toThrow(
				"OFFICE_PREPARATION_REPORT_MISMATCH",
			);
	});
});
describe("portable copied-state preparation requests", () => {
	it("binds the full copy/allocation/boot and translates host files to a portable private manifest", () => {
		const { options, request } = fixture();
		expect(request.allocationId).toBe(options.binding.allocationId);
		expect(request.copy.planSha256).toBe(officeDigest(options.plan));
		expect(request.entries.find((entry) => entry.path === "workbench/note")).toEqual({
			path: "workbench/note",
			kind: "file",
			mode: 0o700,
			bytes: 1,
			sha256: options.observation.inventory.entries[2].sha256,
		});
		expect(JSON.stringify(request)).not.toContain(options.binding.workbenchSource);
		expect(Object.isFrozen(request.entries[0])).toBe(true);
	});
	it.each(["adoptionId", "observationSha256", "planSha256", "schema", "state", "extra"])(
		"rejects changed copy %s",
		(field) => {
			const { options } = fixture();
			expect(() =>
				createLxdOfficeGuestPreparationRequest({ ...options, result: { ...options.result, [field]: "changed" } }),
			).toThrow();
		},
	);
	it("does not transplant retained evidence into a replacement allocation", () => {
		const { options } = fixture();
		expect(() =>
			createLxdOfficeGuestPreparationRequest({ ...options, binding: { ...options.binding, allocationId: id(99) } }),
		).toThrow("OFFICE_PREPARATION_COPY_MISMATCH");
	});
	it("normalizes manifest order and property order without retaining mutable caller input", () => {
		const { request } = fixture();
		const raw = structuredClone(request);
		const changed = {
			...raw,
			entries: [...raw.entries].reverse().map((entry) => Object.fromEntries(Object.entries(entry).reverse())),
		};
		expect(JSON.stringify(parseCompanyComputerPreparationRequest(changed).entries)).toBe(
			JSON.stringify(request.entries),
		);
	});
	it.each([
		"../outside",
		"/workbench/file",
		"workbench/../file",
		"workbench//file",
		"unknown/file",
		"workbench/a\\b",
		"workbench/a\nfile",
	])("rejects escaping or unsupported path %s", (path) => {
		const { request } = fixture();
		expect(() =>
			parseCompanyComputerPreparationRequest({
				...request,
				entries: [...request.entries, { path, kind: "file", mode: 0o600, bytes: 0, sha256: "a".repeat(64) }],
			}),
		).toThrow();
	});
	it.each(["mode", "bytes", "sha256", "kind", "extra"])("rejects invalid content metadata %s", (field) => {
		const { request } = fixture();
		expect(() =>
			parseCompanyComputerPreparationRequest({
				...request,
				entries: request.entries.map((entry) => (entry.kind === "file" ? { ...entry, [field]: "invalid" } : entry)),
			}),
		).toThrow();
	});
	it("rejects missing parents, duplicate files, shared permissions and absent admitted roots", () => {
		const { request } = fixture();
		for (const entries of [
			request.entries.filter((entry) => entry.path !== "workbench"),
			[...request.entries, request.entries[0]],
			request.entries.map((entry) => ({ ...entry, mode: 0o777 })),
			request.entries.filter((entry) => entry.path !== "profiles"),
		]) {
			expect(() => parseCompanyComputerPreparationRequest({ ...request, entries })).toThrow();
		}
	});
	it("rejects volatile mounts, arbitrary roots, credentials and missing physical identity", () => {
		const { request } = fixture();
		for (const changed of [
			{ workbenchMount: { ...request.workbenchMount, filesystem: "tmpfs" } },
			{ workbenchMount: { ...request.workbenchMount, mountPoint: "/etc" } },
			{ uid: 0 },
			{ bootId: "" },
			{ registryToken: "untrusted-token" },
			{ limits: { ...request.limits, pids: 0 } },
		]) {
			expect(() => parseCompanyComputerPreparationRequest({ ...request, ...changed })).toThrow();
		}
	});
});
