import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	type CloudMemberCompanyCommand,
	CloudMemberCompanyFileClient,
	parseCloudMemberCompanyMode,
} from "../src/cloud-member-company-editor.ts";

const companyId = "29500000-0000-4000-8000-000000000010";
const environmentId = "29500000-0000-4000-8000-000000000020";
const commandId = "29500000-0000-4000-8000-000000000030";
const snapshotId = "29500000-0000-4000-8000-000000000040";
const version = "29500000-0000-4000-8000-000000000050";
const text = "A company decision";
const plan = {
	schema: "qorpera.company-path-mutation/v1",
	operationKey: "exact-intent",
	path: "files/decision.md",
	expectedVersion: version,
	entry: {
		path: "files/decision.md",
		kind: "file",
		executable: false,
		file: {
			fileSha256: createHash("sha256").update(text).digest("hex"),
			manifestSha256: "a".repeat(64),
			bytes: Buffer.byteLength(text),
			mediaType: "application/octet-stream",
		},
	},
} as const;
const target: CloudMemberCompanyCommand = {
	commandId,
	companyId,
	environmentId,
	plan,
	planSha256: "b".repeat(64),
	state: "review_required",
	expiresAt: "2099-01-01T00:00:00Z",
	result: null,
};
const edit = {
	operation: "write" as const,
	operationKey: plan.operationKey,
	path: plan.path,
	expectedVersion: version,
	text,
};

function fixture(response: unknown = target, status = 200) {
	const fetcher = vi.fn<typeof fetch>(async () => Response.json(response, { status }));
	const client = new CloudMemberCompanyFileClient({
		companyId,
		environmentId,
		supabaseUrl: "https://control.test",
		objectGatewayUrl: "https://gateway.test",
		publishableKey: "public-key",
		accessToken: async () => "member-jwt",
		fetch: fetcher,
	});
	return { client, fetcher, signal: new AbortController().signal };
}

describe("member Company File intent and display client", () => {
	it("sends human text to the cloud gateway without service credentials or a tree", async () => {
		const { client, fetcher, signal } = fixture();
		expect(await client.edit(edit, signal)).toEqual(target);
		const [url, request] = fetcher.mock.calls[0];
		expect(url).toBe(`https://gateway.test/v1/member-company-file/${environmentId}/edits`);
		expect(JSON.parse(String(request?.body))).toEqual(edit);
		expect(new Headers(request?.headers).get("authorization")).toBe("Bearer member-jwt");
		expect(new Headers(request?.headers).has("apikey")).toBe(false);
		expect(request?.redirect).toBe("error");
	});
	it.each([
		{ ...target, companyId: commandId },
		{ ...target, environmentId: commandId },
		{ ...target, plan: { ...plan, operationKey: "other" } },
		{ ...target, plan: { ...plan, expectedVersion: null } },
		{ ...target, plan: { ...plan, entry: { ...plan.entry, executable: true } } },
		{
			...target,
			plan: { ...plan, entry: { ...plan.entry, file: { ...plan.entry.file, fileSha256: "c".repeat(64) } } },
		},
	])("rejects a substituted command or effect", async (value) => {
		const { client, signal } = fixture(value);
		await expect(client.edit(edit, signal)).rejects.toThrow();
	});
	it("requires exact preview bytes and exact reviewed digest", async () => {
		const { client, fetcher, signal } = fixture({ commandId, planSha256: target.planSha256, text });
		expect(await client.pendingText(target, signal)).toBe(text);
		fetcher.mockImplementationOnce(async () =>
			Response.json({ commandId, planSha256: target.planSha256, text: "substituted" }),
		);
		await expect(client.pendingText(target, signal)).rejects.toThrow("content changed");
		fetcher.mockImplementationOnce(async () =>
			Response.json({ ...target, state: "approved", planSha256: "d".repeat(64) }),
		);
		await expect(client.review(target, "approve", signal)).rejects.toThrow("identity changed");
	});
	it("lists only direct children of the exact path and pinned page", async () => {
		const page = {
			snapshotId,
			items: [{ path: "files/decision.md", version, kind: "file", bytes: 10 }],
			hasMore: true,
			nextAfter: "files/decision.md",
		};
		const { client, fetcher, signal } = fixture(page);
		expect(await client.list("files", signal)).toEqual(page);
		const [url, request] = fetcher.mock.calls[0];
		expect(url).toBe("https://control.test/rest/v1/rpc/qorpera_list_company_paths");
		expect(new Headers(request?.headers).get("apikey")).toBe("public-key");
		expect(JSON.parse(String(request?.body))).toMatchObject({
			p_environment_id: environmentId,
			p_path: "files",
			p_binding: null,
		});
		fetcher.mockImplementationOnce(async () =>
			Response.json({ ...page, items: [{ ...page.items[0], path: "private/decision.md" }] }),
		);
		await expect(client.list("files", signal)).rejects.toThrow("scope changed");
		fetcher.mockImplementationOnce(async () => Response.json({ ...page, snapshotId: commandId }));
		await expect(client.list("files", signal, null, snapshotId)).rejects.toThrow("page changed");
	});
	it.each([401, 403, 409, 503])("does not automatically retry or reveal raw failures (%s)", async (status) => {
		const { client, fetcher, signal } = fixture({ error: "PRIVATE DATABASE ERROR" }, status);
		await expect(client.edit(edit, signal)).rejects.not.toThrow("PRIVATE DATABASE ERROR");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("rejects malformed or overbroad edits before network access", async () => {
		const { client, fetcher, signal } = fixture();
		await expect(client.edit({ ...edit, text: "x".repeat(32769) }, signal)).rejects.toThrow();
		await expect(client.edit({ ...edit, path: "../private" }, signal)).rejects.toThrow();
		await expect(client.edit({ ...edit, runId: commandId } as typeof edit, signal)).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("bounds an unresponsive token provider without starting an effect", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const client = new CloudMemberCompanyFileClient({
			companyId,
			environmentId,
			supabaseUrl: "https://control.test",
			objectGatewayUrl: "https://gateway.test",
			publishableKey: "public",
			accessToken: () => new Promise(() => {}),
			fetch: fetcher,
			timeoutMs: 10,
		});
		await expect(client.edit(edit, new AbortController().signal)).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("never interprets a missing or mismatched mode as legacy authority", () => {
		expect(parseCloudMemberCompanyMode({ companyId, environmentId, mode: "governed" }, companyId)).toEqual({
			companyId,
			environmentId,
			mode: "governed",
		});
		expect(parseCloudMemberCompanyMode({ companyId, environmentId, mode: "folder" }, companyId).mode).toBe("folder");
		for (const value of [
			null,
			{},
			{ companyId, environmentId, mode: "unknown" },
			{ companyId: commandId, environmentId, mode: "legacy" },
		])
			expect(() => parseCloudMemberCompanyMode(value, companyId)).toThrow();
	});
});
