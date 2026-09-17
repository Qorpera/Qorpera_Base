import { createHash } from "node:crypto";
import { COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, parseCompanyComputerServiceSoftwarePlan } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { LxdOfficeLifecycle } from "../src/lxd-office-lifecycle.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "../src/lxd-office-lifecycle-service.ts";
import {
	type LxdOfficeSoftwareLaneOptions,
	loadLxdOfficeSoftwareLane,
	parseLxdOfficeSoftwareLaneDocument,
} from "../src/lxd-office-software-lane.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";
import { officeSoftwareFixture } from "./fixtures/office-software.ts";

const capability = "0123456789abcdef".repeat(4);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const document = (plan: unknown = null) => ({
	schema: "qorpera.lxd-office-software-lane/v1",
	plan,
	expectedRevision: 1,
	expectedService: { path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, bytes: 360615, sha256: "6".repeat(64) },
	tools: { install: "7".repeat(64), measure: "8".repeat(64) },
	capabilityCredential: { path: "/etc/qorpera-office/software.capability", bytes: 64, sha256: sha(capability) },
});
const serviceConfig = () => ({
	schema: "qorpera.lxd-office-provider-service/v1",
	policyPath: "/etc/qorpera-office/policy.json",
	provenancePath: "/etc/qorpera-office/provenance.json",
	planPath: "/etc/qorpera-office/plan.json",
	registryUrl: "https://control.example",
	registryCredential: { path: "/etc/qorpera-office/provider.credential", bytes: 64, sha256: "a".repeat(64) },
	inventoryLimits: { maxEntries: 100, maxDepth: 4, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 },
	pollIntervalMs: 2000,
});
describe("office software lane document", () => {
	it("parses a closed lane with or without a signed plan and pins every digest", () => {
		const plain = parseLxdOfficeSoftwareLaneDocument(document());
		expect(plain.plan).toBeUndefined();
		expect(plain.expectedService).toEqual({
			path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
			bytes: 360615,
			sha256: "6".repeat(64),
		});
		expect(plain.tools).toEqual({ install: "7".repeat(64), measure: "8".repeat(64) });
		const { plan } = officeSoftwareFixture();
		expect(parseLxdOfficeSoftwareLaneDocument(document(plan)).plan).toEqual(plan);
	});
	it.each([
		["schema", { schema: "qorpera.lxd-office-software-lane/v2" }],
		["unknown key", { extra: true }],
		["path", { expectedService: { path: "/opt/other.mjs", bytes: 1, sha256: "6".repeat(64) } }],
		["digest", { tools: { install: "7".repeat(63), measure: "8".repeat(64) } }],
		["credential length", { capabilityCredential: { path: "/etc/x", bytes: 32, sha256: "9".repeat(64) } }],
		["relative credential path", { capabilityCredential: { path: "etc/x", bytes: 64, sha256: "9".repeat(64) } }],
		["revision", { expectedRevision: -1 }],
		["plan", { plan: { schema: "qorpera.office-service-software-plan/v1" } }],
	])("refuses an open or invalid lane (%s)", (_name, change) => {
		expect(() => parseLxdOfficeSoftwareLaneDocument({ ...document(), ...change })).toThrow(
			"INVALID_OFFICE_SOFTWARE_LANE",
		);
	});
	it("loads the capability through the credential reader, binds its digest and wipes the buffer", async () => {
		const lane = parseLxdOfficeSoftwareLaneDocument(document());
		const buffers: Buffer[] = [];
		const read = vi.fn(async (path: string, limit: number) => {
			expect([path, limit]).toEqual(["/etc/qorpera-office/software.capability", 64]);
			const buffer = Buffer.from(capability, "ascii");
			buffers.push(buffer);
			return buffer;
		});
		const options = await loadLxdOfficeSoftwareLane(lane, read);
		expect(options).toEqual({
			plan: undefined,
			expectedRevision: 1,
			expectedService: lane.expectedService,
			measurementToolSha256: "8".repeat(64),
			installToolSha256: "7".repeat(64),
			providerCapability: capability,
		});
		expect(buffers[0].every((byte) => byte === 0)).toBe(true);
		await expect(loadLxdOfficeSoftwareLane(lane, async () => Buffer.from("f".repeat(64)))).rejects.toThrow(
			"OFFICE_SOFTWARE_CAPABILITY_DIFFERS",
		);
		await expect(loadLxdOfficeSoftwareLane(lane, async () => Buffer.from(`${capability}\n`))).rejects.toThrow(
			"OFFICE_SOFTWARE_CAPABILITY_DIFFERS",
		);
	});
});
describe("provider service configuration software lane", () => {
	it("names a host copy of the pinned measurement tool and loads its exact bytes", async () => {
		const tool = Buffer.from("measure tool bytes");
		const lane = parseLxdOfficeSoftwareLaneDocument({
			...document(),
			tools: { install: "7".repeat(64), measure: sha(tool) },
			measurementTool: { path: "/etc/qorpera-office/software-control/measure.mjs", bytes: tool.length, sha256: sha(tool) },
		});
		expect(lane.measurementTool).toEqual({
			path: "/etc/qorpera-office/software-control/measure.mjs",
			bytes: tool.length,
			sha256: sha(tool),
		});
		expect(() =>
			parseLxdOfficeSoftwareLaneDocument({
				...document(),
				measurementTool: { path: "/etc/qorpera-office/software-control/measure.mjs", bytes: 1, sha256: sha(tool) },
			}),
		).toThrow("INVALID_OFFICE_SOFTWARE_LANE");
		const read = async () => Buffer.from(capability, "ascii");
		const options = await loadLxdOfficeSoftwareLane(lane, read, async (path, limit) => {
			expect([path, limit]).toEqual(["/etc/qorpera-office/software-control/measure.mjs", tool.length]);
			return Buffer.from(tool);
		});
		expect(options.measurementTool).toEqual(tool);
		await expect(loadLxdOfficeSoftwareLane(lane, read, async () => Buffer.from("other bytes"))).rejects.toThrow(
			"OFFICE_SOFTWARE_TOOL_PIN_DIFFERS",
		);
		expect((await loadLxdOfficeSoftwareLane(parseLxdOfficeSoftwareLaneDocument(document()), read)).measurementTool).toBeUndefined();
	});
	it("keeps the existing closed configuration and accepts only an explicit lane path", () => {
		expect(parseLxdOfficeLifecycleServiceConfig(serviceConfig()).softwareLanePath).toBeUndefined();
		expect(
			parseLxdOfficeLifecycleServiceConfig({
				...serviceConfig(),
				softwareLanePath: "/etc/qorpera-office/software-lane.json",
			}).softwareLanePath,
		).toBe("/etc/qorpera-office/software-lane.json");
		expect(() =>
			parseLxdOfficeLifecycleServiceConfig({ ...serviceConfig(), softwareLanePath: "relative.json" }),
		).toThrow();
		expect(() => parseLxdOfficeLifecycleServiceConfig({ ...serviceConfig(), softwareLane: {} })).toThrow();
	});
});
describe("lifecycle software lane wiring", () => {
	it("composes the measurement hook for successor and boot activations only from a valid lane", () => {
		const { policy } = officePhysicalFixture();
		const plan = parseCompanyComputerServiceSoftwarePlan(officeSoftwareFixture().plan);
		const registry = { call: vi.fn() };
		const options = {
			planPath: "/protected/lifecycle.json",
			inventoryLimits: {
				maxEntries: 100,
				maxDepth: 4,
				maxFileBytes: 1024,
				maxTotalBytes: 4096,
				maxManifestBytes: 65536,
			},
		};
		const software: LxdOfficeSoftwareLaneOptions = {
			plan,
			expectedRevision: 1,
			expectedService: { path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, bytes: 234, sha256: "6".repeat(64) },
			measurementToolSha256: "8".repeat(64),
			installToolSha256: "7".repeat(64),
			providerCapability: capability,
		};
		const gate = { policy, check: vi.fn(), inspect: vi.fn() };
		expect(() => new LxdOfficeLifecycle(gate, registry, options)).not.toThrow();
		expect(() => new LxdOfficeLifecycle(gate, registry, { ...options, software })).not.toThrow();
		expect(
			() => new LxdOfficeLifecycle(gate, registry, { ...options, software: { ...software, plan: undefined } }),
		).not.toThrow();
		expect(
			() =>
				new LxdOfficeLifecycle(gate, registry, {
					...options,
					software: { ...software, providerCapability: "X".repeat(64) },
				}),
		).toThrow("OFFICE_SOFTWARE_AUTHORITY_INVALID");
		expect(
			() =>
				new LxdOfficeLifecycle(gate, registry, {
					...options,
					software: { ...software, measurementToolSha256: "nope" },
				}),
		).toThrow();
	});
});
