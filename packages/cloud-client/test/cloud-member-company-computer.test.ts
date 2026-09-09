import { describe, expect, it, vi } from "vitest";
import { CloudMemberCompanyComputerClient } from "../src/cloud-member-company-computer.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
function fixture() {
	const data = {
		companyId: id(1),
		environmentId: id(2),
		canManage: true,
		scope,
		staff: [{ staffAgentId: id(5), name: "<img src=x>" }],
		nextAfter: null as string | null,
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
		expect(new Headers(init?.headers).get("apikey")).toBe("public");
		expect(new Request(url, init).cache).toBe("no-store");
		expect(init?.redirect).toBe("error");
		return Response.json(data);
	});
	const accessToken = vi.fn(async () => "fixture-token");
	const options = {
		companyId: id(1),
		environmentId: id(2),
		supabaseUrl: "https://control.test",
		publishableKey: "public",
		fetch,
		accessToken,
	};
	return { data, fetch, accessToken, options, client: new CloudMemberCompanyComputerClient(options) };
}
describe("member Company Computer transport", () => {
	it("discovers only member metadata and copies configuration", async () => {
		const f = fixture();
		f.options.environmentId = id(9);
		expect(await f.client.catalog(new AbortController().signal)).toEqual(f.data);
		expect(f.fetch.mock.calls[0][0]).toBe("https://control.test/rest/v1/rpc/qorpera_member_office_catalog");
		expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({ p_environment_id: id(2), p_after: null });
	});
	it.each(["company", "environment", "scope", "duplicate", "size", "cursor", "name"])(
		"refuses a malformed %s response",
		async (mode) => {
			const f = fixture();
			if (mode === "company") f.data.companyId = id(9);
			if (mode === "environment") f.data.environmentId = id(9);
			if (mode === "scope") f.data.scope = { ...scope, environmentId: id(9) };
			if (mode === "duplicate") f.data.staff.push(f.data.staff[0]);
			if (mode === "size") f.data.staff = Array(51).fill(f.data.staff[0]);
			if (mode === "cursor") f.data.nextAfter = id(5);
			if (mode === "name") f.data.staff[0].name = "x".repeat(161);
			await expect(f.client.catalog(new AbortController().signal)).rejects.toThrow();
		},
	);
	it("pages exact ordered staff without granting access", async () => {
		const f = fixture();
		f.data.staff = Array.from({ length: 50 }, (_, n) => ({ staffAgentId: id(n + 10), name: `Agent ${n}` }));
		f.data.nextAfter = id(59);
		expect((await f.client.catalog(new AbortController().signal, id(5))).nextAfter).toBe(id(59));
		f.data.staff = [];
		f.data.nextAfter = null;
		expect((await f.client.catalog(new AbortController().signal, id(59))).staff).toEqual([]);
	});
	it("uses existing start and access contracts without automatic mutation retries", async () => {
		const f = fixture(),
			signal = new AbortController().signal;
		f.fetch.mockResolvedValueOnce(
			Response.json({ scope, computerGeneration: 1, officeState: "provisioning", intent: null }),
		);
		expect((await f.client.start(scope).status(signal)).officeState).toBe("provisioning");
		f.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(f.client.start(scope).request(1, id(8), signal)).rejects.toThrow("REFRESH_STATUS");
		expect(f.fetch).toHaveBeenCalledTimes(2);
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.office-access-status/v1",
				scope,
				staffAgentId: id(5),
				grant: { grantId: id(6), version: 1, state: "active", capabilities: ["desktop", "shell"] },
			}),
		);
		await f.client
			.access(scope, id(5))
			.configure({ expectedVersion: 0, enabled: true, capabilities: ["desktop", "shell"] }, signal);
		expect(JSON.parse(f.fetch.mock.calls[2][1]!.body as string)).toEqual({
			p_scope: scope,
			p_staff_agent_id: id(5),
			p_expected_version: 0,
			p_enabled: true,
			p_capabilities: ["desktop", "shell"],
		});
	});
	it("refuses scope substitution and untrusted viewer URLs before I/O", () => {
		const f = fixture();
		expect(() => f.client.start({ ...scope, companyId: id(9) })).toThrow();
		expect(() => f.client.access({ ...scope, environmentId: id(9) }, id(5))).toThrow();
		expect(() => f.client.views(scope, id(7), `ws://localhost/office/${id(3)}/view`)).toThrow();
		expect(f.accessToken).not.toHaveBeenCalled();
	});
	it("observes cancellation and rejects member token failures without network I/O", async () => {
		const f = fixture(),
			controller = new AbortController();
		controller.abort();
		await expect(f.client.catalog(controller.signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
		f.accessToken.mockResolvedValue("invalid token");
		await expect(f.client.catalog(new AbortController().signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
});
