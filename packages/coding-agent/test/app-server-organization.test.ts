import { existsSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompanyOrganizationHierarchyView, createCompanyAppServer } from "../src/core/app-server.ts";
import { scaffoldCompany } from "../src/core/company.ts";

let root: string;
let server: Server | undefined;
let base: string;
let readOrganization: () => CompanyOrganizationHierarchyView | undefined;

beforeEach(async () => {
	root = join(realpathSync(tmpdir()), `qorpera-organization-state-${Date.now()}-${crypto.randomUUID()}`);
	scaffoldCompany(root);
	readOrganization = () => undefined;
	server = createCompanyAppServer({
		root,
		authToken: "test-token",
		organizationReadModel: () => readOrganization(),
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as { port: number };
	base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("company organization renderer projection", () => {
	it("serves only the closed semantic hierarchy supplied by the desktop host", async () => {
		const hierarchy: CompanyOrganizationHierarchyView = {
			schema: "qorpera.company-organization-hierarchy/v1",
			profileId: "10000000-0000-4000-8000-000000000001",
			formationState: "operating",
			primary: [
				{
					id: "responsibility:product",
					kind: "responsibility",
					label: "Product",
					status: "active",
					canonicalId: "10000000-0000-4000-8000-000000000002",
					children: [
						{
							id: "agent:lead",
							kind: "agent",
							label: "Product Lead",
							status: "active",
							role: "Accountable",
							canonicalId: "10000000-0000-4000-8000-000000000003",
							children: [],
						},
					],
				},
			],
			inactive: [],
		};
		const expected = structuredClone(hierarchy);
		const unsafe = hierarchy as CompanyOrganizationHierarchyView & { secret?: string };
		unsafe.secret = "must-not-render";
		(
			hierarchy.primary[0] as CompanyOrganizationHierarchyView["primary"][number] & { privatePath?: string }
		).privatePath = "members/private";
		readOrganization = () => unsafe;

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			organizationHierarchy: CompanyOrganizationHierarchyView | null;
		};
		expect(state.organizationHierarchy).toEqual(expected);
		expect(JSON.stringify(state.organizationHierarchy)).not.toContain("must-not-render");
		expect(JSON.stringify(state.organizationHierarchy)).not.toContain("members/private");
	});

	it("keeps the company state readable when the semantic projection is unavailable", async () => {
		readOrganization = () => {
			throw new Error("temporary control-plane outage");
		};

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			organizationHierarchy: CompanyOrganizationHierarchyView | null;
		};
		expect(state.organizationHierarchy).toBeNull();
	});
});
