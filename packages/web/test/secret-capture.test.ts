import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudApi } from "../src/cloud/api.ts";
import { fixture, id, profileA } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const ticket = (scope: Record<string, unknown> = {}) => ({
	schema: "qorpera.cloud-secret-capture/v1",
	ticketId: id(40),
	captureCapability: "capture-capability-fixture",
	serviceOrigin: "https://custody.example.invalid:10000",
	scope: {
		companyId: profileA.profileId,
		environmentId: profileA.environmentId,
		secretId: id(41),
		version: 1,
		ownerKind: "company",
		ownerUserId: null,
		connectorId: "github",
		secretName: "token",
		purpose: "fixture",
		...scope,
	},
	expiresAt: "2026-09-23T20:00:00Z",
});

async function begin(cloud: ReturnType<typeof fixture>["cloud"], value: unknown) {
	vi.mocked(cloud.rpc).mockResolvedValueOnce(value as never);
	return new CloudApi(cloud).beginSecretCapture({
		profileId: profileA.profileId,
		environmentId: profileA.environmentId,
		ownerKind: "company",
		connectorId: "github",
		secretName: "token",
		purpose: "fixture",
	});
}

describe("secret capture", () => {
	it("posts the value to the ticket's origin with the company that routes it to that company's broker", async () => {
		const { cloud } = fixture();
		const captured = await begin(cloud, ticket());
		expect(captured.companyId).toBe(profileA.profileId);
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						secretId: id(41),
						version: 1,
						connectorId: "github",
						secretName: "token",
						purpose: "fixture",
						ownerKind: "company",
						status: "active",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		await new CloudApi(cloud).captureSecret(captured, "value-fixture");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [route, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(route).toBe(`https://custody.example.invalid:10000/v1/captures/${id(40)}?company=${profileA.profileId}`);
		expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
		expect(JSON.parse(String(init.body))).toMatchObject({ captureCapability: "capture-capability-fixture" });
	});

	it.each([
		["a missing company", { companyId: undefined }],
		["a company that is not a UUID", { companyId: "company-a&company=b" }],
	])("refuses a ticket with %s", async (_label, scope) => {
		const { cloud } = fixture();
		await expect(begin(cloud, ticket(scope))).rejects.toThrow();
	});
});
