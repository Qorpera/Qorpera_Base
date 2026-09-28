import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type OfficeNextComputerInput, planOfficeNextComputer } from "../src/lxd-office-fleet-next-computer.ts";
import { parseOfficeFleetServiceConfig } from "../src/lxd-office-fleet-service.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "../src/lxd-office-lifecycle-service.ts";
import { parseLxdOfficePassthroughConfig } from "../src/lxd-office-passthrough.ts";
import { lxdOfficePhysicalPolicySha256, parseLxdOfficePhysicalPolicy } from "../src/lxd-office-physical-policy.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

function input(): OfficeNextComputerInput {
	const f = officePhysicalFixture();
	return {
		template: {
			policy: f.policy,
			service: {
				schema: "qorpera.lxd-office-provider-service/v1",
				policyPath: "/etc/qorpera-office/policy.json",
				provenancePath: "/etc/qorpera-office/provenance.json",
				planPath: "/etc/qorpera-office/plan.json",
				registryUrl: "https://control.example",
				registryCredential: { path: "/etc/qorpera-office/provider.credential", bytes: 64, sha256: "a".repeat(64) },
				inventoryLimits: {
					maxEntries: 100,
					maxDepth: 4,
					maxFileBytes: 1024,
					maxTotalBytes: 4096,
					maxManifestBytes: 65536,
				},
				pollIntervalMs: 2000,
				idleMs: 300000,
				passthroughPath: "/etc/qorpera-office/passthrough.json",
				softwareLanePath: "/etc/qorpera-office/software-lane.json",
			},
			passthrough: {
				schema: "qorpera.lxd-office-passthrough/v1",
				listenHost: "100.75.4.70",
				viewer: { listenPort: 18543, guestPort: 18543 },
				native: { listenPort: 18544, guestPort: 18544 },
				allowedClients: ["100.64.0.0/10"],
			},
		},
		office: {
			providerId: "77777777-7777-4777-8777-777777777777",
			companyComputerId: "88888888-8888-4888-8888-888888888888",
			logicalComputerId: "99999999-9999-4999-8999-999999999999",
			computerGeneration: 1,
		},
		host: {
			nodeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			configRoot: "/etc/qorpera/offices/88888888-8888-4888-8888-888888888888",
			workbench: { mountPoint: "/mnt/office-workbench-2", source: "192.0.2.1:/offices/test-computer-2" },
			journalPath: "/mnt/office-journal/computer-2",
			ports: { viewer: 18545, native: 18546 },
		},
	};
}
const file = (plan: ReturnType<typeof planOfficeNextComputer>, name: string) => {
	const found = plan.files.find((entry) => entry.path.endsWith(`/${name}`));
	if (!found) throw new Error(`missing ${name}`);
	return found;
};

describe("a company's next Company Computer on a host that runs its first", () => {
	it("copies the company's image, account and size, and gives the computer its own identity, folder, journal and ports", () => {
		const value = input();
		const plan = planOfficeNextComputer(value);
		const policy = parseLxdOfficePhysicalPolicy(JSON.parse(file(plan, "policy.json").text));
		const template = parseLxdOfficePhysicalPolicy(value.template.policy);
		expect(policy.guest).toEqual({
			...template.guest,
			...value.office,
			workbenchSource: "/mnt/office-workbench-2",
		});
		expect(policy.workbench).toEqual({
			...template.workbench,
			mountPoint: "/mnt/office-workbench-2",
			source: "192.0.2.1:/offices/test-computer-2",
		});
		expect(policy.journal).toEqual({ ...template.journal, path: "/mnt/office-journal/computer-2" });
		expect(policy.host).toEqual(template.host);
		expect(policy.image).toEqual(template.image);
		expect(plan.enrollment).toEqual({
			nodeId: value.host.nodeId,
			machineIdSha256: template.host.machineIdSha256,
			providerKind: "office",
			providerId: value.office.providerId,
			policySha256: lxdOfficePhysicalPolicySha256(policy),
		});
		const service = parseLxdOfficeLifecycleServiceConfig(JSON.parse(file(plan, "service.json").text));
		expect(service.policyPath).toBe(`${value.host.configRoot}/policy.json`);
		expect(service.passthroughPath).toBe(`${value.host.configRoot}/passthrough.json`);
		expect(service.registryCredential).toEqual({
			path: "/etc/qorpera-office/provider.credential",
			bytes: 64,
			sha256: "a".repeat(64),
		});
		// The template's own revision lanes are not carried to a computer that starts from the image.
		expect(service.softwareLanePath).toBeUndefined();
		const passthrough = parseLxdOfficePassthroughConfig(JSON.parse(file(plan, "passthrough.json").text));
		expect(passthrough.lanes.map((lane) => [lane.listenPort, lane.guestPort])).toEqual([
			[18545, 18543],
			[18546, 18544],
		]);
		const fleet = parseOfficeFleetServiceConfig(JSON.parse(file(plan, "fleet.json").text));
		expect(fleet.serviceConfigSha256).toBe(
			createHash("sha256").update(file(plan, "service.json").text).digest("hex"),
		);
		for (const entry of plan.files) expect(entry.sha256).toBe(createHash("sha256").update(entry.text).digest("hex"));
		expect(plan.steps.join("\n")).toContain(
			"qorpera-office-fleet-stage-88888888-8888-4888-8888-888888888888-g1.service",
		);
	});

	it.each([
		[
			"the same provider",
			(v: OfficeNextComputerInput) => {
				v.office.providerId = "11111111-1111-4111-8111-111111111111";
			},
		],
		[
			"the same computer",
			(v: OfficeNextComputerInput) => {
				v.office.companyComputerId = "44444444-4444-4444-8444-444444444444";
			},
		],
		[
			"the same working folder",
			(v: OfficeNextComputerInput) => {
				v.host.workbench.source = "192.0.2.1:/offices/test";
			},
		],
		["the same mount point", (v: OfficeNextComputerInput) => (v.host.workbench.mountPoint = "/mnt/office-workbench")],
		[
			"a mount inside the template's",
			(v: OfficeNextComputerInput) => {
				v.host.workbench.mountPoint = "/mnt/office-workbench/2";
			},
		],
		["the same journal", (v: OfficeNextComputerInput) => (v.host.journalPath = "/mnt/office-journal/state")],
		[
			"a journal inside the template's",
			(v: OfficeNextComputerInput) => {
				v.host.journalPath = "/mnt/office-journal/state/2";
			},
		],
		["a journal on another filesystem", (v: OfficeNextComputerInput) => (v.host.journalPath = "/var/lib/office-2")],
		["the template's ports", (v: OfficeNextComputerInput) => (v.host.ports = { viewer: 18543, native: 18546 })],
		["no ports for a passthrough", (v: OfficeNextComputerInput) => delete v.host.ports],
		[
			"documents inside the working folder",
			(v: OfficeNextComputerInput) => {
				v.host.configRoot = "/mnt/office-workbench-2/etc";
			},
		],
		["a bad node", (v: OfficeNextComputerInput) => (v.host.nodeId = "node-1")],
	])("refuses %s", (_name, change) => {
		const value = input();
		change(value);
		expect(() => planOfficeNextComputer(value)).toThrow();
	});
});
