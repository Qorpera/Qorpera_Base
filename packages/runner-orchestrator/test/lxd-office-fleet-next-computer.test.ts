import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type OfficeNextComputerInput, planOfficeNextComputer } from "../src/lxd-office-fleet-next-computer.ts";
import { parseOfficeFleetServiceConfig } from "../src/lxd-office-fleet-service.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "../src/lxd-office-lifecycle-service.ts";
import { parseLxdOfficePassthroughConfig } from "../src/lxd-office-passthrough.ts";
import { lxdOfficePhysicalPolicySha256, parseLxdOfficePhysicalPolicy } from "../src/lxd-office-physical-policy.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const service = (root: string) => ({
	schema: "qorpera.lxd-office-provider-service/v1",
	policyPath: `${root}/policy.json`,
	provenancePath: `${root}/provenance.json`,
	planPath: `${root}/plan.json`,
	registryUrl: "https://control.example",
	registryCredential: { path: "/etc/qorpera-office/provider.credential", bytes: 64, sha256: "a".repeat(64) },
	inventoryLimits: { maxEntries: 100, maxDepth: 4, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 },
	pollIntervalMs: 2000,
	idleMs: 300000,
	passthroughPath: `${root}/passthrough.json`,
	softwareLanePath: `${root}/software-lane.json`,
	resetImagePackageManifestPath: "/etc/qorpera-images/reset-manifest.json",
});
const passthrough = (viewer: number, native: number) => ({
	schema: "qorpera.lxd-office-passthrough/v1",
	listenHost: "100.75.4.70",
	viewer: { listenPort: viewer, guestPort: 18543 },
	native: { listenPort: native, guestPort: 18544 },
	allowedClients: ["100.64.0.0/10"],
});
function input(): OfficeNextComputerInput {
	const f = officePhysicalFixture();
	// Another company's office on the same host.
	const other = officePhysicalFixture().policy;
	other.guest = {
		...other.guest,
		providerId: "12121212-1212-4121-8121-121212121212",
		companyId: "13131313-1313-4131-8131-131313131313",
		companyComputerId: "14141414-1414-4141-8141-141414141414",
		logicalComputerId: "15151515-1515-4151-8151-151515151515",
		workbenchSource: "/mnt/office-workbench-other",
	};
	other.workbench = {
		...other.workbench,
		mountPoint: "/mnt/office-workbench-other",
		source: "192.0.2.1:/offices/other",
	};
	other.journal = { ...other.journal, path: "/mnt/office-journal/other" };
	return {
		template: {
			servicePath: "/etc/qorpera-office/service.json",
			service: service("/etc/qorpera-office"),
			policy: f.policy,
			passthrough: passthrough(18543, 18544),
		},
		others: [
			{
				servicePath: "/etc/qorpera/offices/other/service.json",
				service: service("/etc/qorpera/offices/other"),
				policy: other,
				passthrough: passthrough(18547, 18548),
			},
		],
		office: {
			providerId: "77777777-7777-4777-8777-777777777777",
			companyId: f.policy.guest.companyId,
			environmentId: f.policy.guest.environmentId,
			companyComputerId: "88888888-8888-4888-8888-888888888888",
			logicalComputerId: "99999999-9999-4999-8999-999999999999",
			computerGeneration: 1,
			imageSha256: f.policy.guest.imageFingerprint,
			bootstrapSha256: f.policy.guest.bootstrapSha256,
		},
		host: {
			nodeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			configRoot: "/etc/qorpera/offices/88888888-8888-4888-8888-888888888888",
			workbench: { mountPoint: "/mnt/office-workbench-2", source: "192.0.2.1:/offices/test-computer-2" },
			journalPath: "/mnt/office-journal/computer-2",
			ports: { viewer: 18545, native: 18546 },
			adoptionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			layout: 2,
		},
	};
}
const file = (plan: ReturnType<typeof planOfficeNextComputer>, name: string) => {
	const found = plan.files.find((entry) => entry.path.endsWith(`/${name}`));
	if (!found) throw new Error(`missing ${name}`);
	return found;
};
type Change = (value: OfficeNextComputerInput) => void;
const refusals: [string, string, Change][] = [
	[
		"the same provider",
		"OFFICE_NEXT_COMPUTER_IDENTITY_TAKEN",
		(v) => {
			v.office.providerId = "11111111-1111-4111-8111-111111111111";
		},
	],
	[
		"another office's computer",
		"OFFICE_NEXT_COMPUTER_IDENTITY_TAKEN",
		(v) => {
			v.office.companyComputerId = "14141414-1414-4141-8141-141414141414";
		},
	],
	[
		"another company's office as the template",
		"OFFICE_NEXT_COMPUTER_TEMPLATE_OTHER_COMPANY",
		(v) => {
			v.office.companyId = "13131313-1313-4131-8131-131313131313";
		},
	],
	[
		"another environment's office as the template",
		"OFFICE_NEXT_COMPUTER_TEMPLATE_OTHER_COMPANY",
		(v) => {
			v.office.environmentId = "16161616-1616-4161-8161-161616161616";
		},
	],
	[
		"another image",
		"OFFICE_NEXT_COMPUTER_IMAGE_DIFFERS",
		(v) => {
			v.office.imageSha256 = "c".repeat(64);
		},
	],
	[
		"the same scratch area",
		"OFFICE_NEXT_COMPUTER_WORKBENCH_TAKEN",
		(v) => {
			v.host.workbench.source = "192.0.2.1:/offices/test/";
		},
	],
	[
		"a folder inside the template's",
		"OFFICE_NEXT_COMPUTER_WORKBENCH_TAKEN",
		(v) => {
			v.host.workbench.source = "192.0.2.1://offices/test/computer-2";
		},
	],
	[
		"a folder inside another office's",
		"OFFICE_NEXT_COMPUTER_WORKBENCH_TAKEN",
		(v) => {
			v.host.workbench.source = "192.0.2.1:/offices/other/2";
		},
	],
	[
		"a folder on another NAS",
		"OFFICE_NEXT_COMPUTER_WORKBENCH_INVALID",
		(v) => {
			v.host.workbench.source = "192.0.2.9:/offices/test-computer-2";
		},
	],
	[
		"the same mount point",
		"OFFICE_NEXT_COMPUTER_WORKBENCH_TAKEN",
		(v) => {
			v.host.workbench.mountPoint = "/mnt/office-workbench";
		},
	],
	[
		"another office's mount point",
		"OFFICE_NEXT_COMPUTER_WORKBENCH_TAKEN",
		(v) => {
			v.host.workbench.mountPoint = "/mnt/office-workbench-other/2";
		},
	],
	[
		"the same journal",
		"OFFICE_NEXT_COMPUTER_JOURNAL_TAKEN",
		(v) => {
			v.host.journalPath = "/mnt/office-journal/state";
		},
	],
	[
		"another office's journal",
		"OFFICE_NEXT_COMPUTER_JOURNAL_TAKEN",
		(v) => {
			v.host.journalPath = "/mnt/office-journal/other/2";
		},
	],
	[
		"a journal on another filesystem",
		"OFFICE_NEXT_COMPUTER_JOURNAL_INVALID",
		(v) => {
			v.host.journalPath = "/var/lib/office-2";
		},
	],
	[
		"the template's ports",
		"OFFICE_NEXT_COMPUTER_PORT_TAKEN",
		(v) => {
			v.host.ports = { viewer: 18543, native: 18546 };
		},
	],
	[
		"another office's ports",
		"OFFICE_NEXT_COMPUTER_PORT_TAKEN",
		(v) => {
			v.host.ports = { viewer: 18545, native: 18548 };
		},
	],
	[
		"no ports for a passthrough",
		"INVALID_OFFICE_PHYSICAL_RECORD",
		(v) => {
			delete v.host.ports;
		},
	],
	[
		"documents in the template's folder",
		"OFFICE_NEXT_COMPUTER_DOCUMENTS_TAKEN",
		(v) => {
			v.host.configRoot = "/etc/qorpera-office";
		},
	],
	[
		"documents in another office's folder",
		"OFFICE_NEXT_COMPUTER_DOCUMENTS_TAKEN",
		(v) => {
			v.host.configRoot = "/etc/qorpera/offices/other";
		},
	],
	[
		"documents inside the scratch area",
		"OFFICE_NEXT_COMPUTER_DOCUMENTS_TAKEN",
		(v) => {
			v.host.configRoot = "/mnt/office-workbench-2/etc";
		},
	],
	[
		"a bad node",
		"OFFICE_NEXT_COMPUTER_IDENTITY_INVALID",
		(v) => {
			v.host.nodeId = "node-1";
		},
	],
];

describe("a company's next Company Computer on a host that runs its first", () => {
	it("copies the company's image, account and size, and gives the computer its own identity, folder, journal and ports", () => {
		const value = input();
		const plan = planOfficeNextComputer(value);
		const policy = parseLxdOfficePhysicalPolicy(JSON.parse(file(plan, "policy.json").text));
		const template = parseLxdOfficePhysicalPolicy(value.template.policy);
		const { imageSha256: _image, bootstrapSha256: _bootstrap, ...identity } = value.office;
		expect(policy.guest).toEqual({ ...template.guest, ...identity, workbenchSource: "/mnt/office-workbench-2" });
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
			cpuMillis: template.guest.cpus * 1000,
			memoryBytes: template.guest.memoryBytes,
		});
		const parsed = parseLxdOfficeLifecycleServiceConfig(JSON.parse(file(plan, "service.json").text));
		expect(parsed.policyPath).toBe(`${value.host.configRoot}/policy.json`);
		expect(parsed.passthroughPath).toBe(`${value.host.configRoot}/passthrough.json`);
		expect(parsed.registryCredential).toEqual({
			path: "/etc/qorpera-office/provider.credential",
			bytes: 64,
			sha256: "a".repeat(64),
		});
		// The template's own revision lane is not carried over; the image's reset manifest is.
		expect(parsed.softwareLanePath).toBeUndefined();
		expect(parsed.resetImagePackageManifestPath).toBe("/etc/qorpera-images/reset-manifest.json");
		const lanes = parseLxdOfficePassthroughConfig(JSON.parse(file(plan, "passthrough.json").text)).lanes;
		expect(lanes.map((lane) => [lane.listenPort, lane.guestPort])).toEqual([
			[18545, 18543],
			[18546, 18544],
		]);
		const fleet = parseOfficeFleetServiceConfig(JSON.parse(file(plan, "fleet.json").text));
		expect(fleet.serviceConfigSha256).toBe(
			createHash("sha256").update(file(plan, "service.json").text).digest("hex"),
		);
		for (const entry of plan.files) expect(entry.sha256).toBe(createHash("sha256").update(entry.text).digest("hex"));
		expect(plan.lifecyclePlan).toEqual({
			path: `${value.host.configRoot}/plan.json`,
			input: {
				schema: "qorpera.lxd-office-adoption-input/v1",
				adoptionId: value.host.adoptionId,
				shared: { workbench: null, desktopHome: null, company: null },
				legacy: null,
				quarantine: [],
			},
			reviewPath: `${value.host.configRoot}/review.json`,
			writerFencePath: `${value.host.configRoot}/writer-fence.json`,
			serviceBootstrapPath: `${value.host.configRoot}/service-bootstrap.json`,
		});
		const steps = plan.steps.join("\n");
		expect(steps).toContain("qorpera-office-fleet-stage-88888888-8888-4888-8888-888888888888-g1.service");
		expect(steps).toContain("never copy the template's TLS key");
	});

	it("keeps layout 1 for a template on layout 1", () => {
		const value = input();
		value.host.layout = 1;
		expect(planOfficeNextComputer(value).lifecyclePlan.input.shared).toEqual({ workbench: null, desktopHome: null });
	});

	it.each(refusals)("refuses %s", (_name, code, change) => {
		const value = input();
		change(value);
		expect(() => planOfficeNextComputer(value)).toThrow(code);
	});
});
