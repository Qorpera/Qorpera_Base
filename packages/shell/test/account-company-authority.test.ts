import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountAuthStoragePath, FileAccountAuthStorage, QorperaAccountAuth } from "../src/account-auth.ts";

const accountId = "29500000-0000-4000-8000-000000000001";
const otherAccountId = "29500000-0000-4000-8000-000000000002";
const companyId = "29500000-0000-4000-8000-000000000010";
const environmentId = "29500000-0000-4000-8000-000000000020";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: unknown = { companyId, environmentId, mode: "governed" }) {
	const root = mkdtempSync(join(tmpdir(), "qorpera-account-company-"));
	roots.push(root);
	const expiresAt = Math.floor(Date.now() / 1000) + 3600;
	const payload = Buffer.from(
		JSON.stringify({ sub: accountId, aud: "authenticated", role: "authenticated", exp: expiresAt }),
	).toString("base64url");
	const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
	new FileAccountAuthStorage(accountAuthStoragePath(root)).setItem(
		"sb-project-auth-token",
		JSON.stringify({
			access_token: token,
			refresh_token: "synthetic-refresh",
			expires_at: expiresAt,
			expires_in: 3600,
			token_type: "bearer",
			user: {
				id: accountId,
				email: "member@example.test",
				aud: "authenticated",
				role: "authenticated",
				app_metadata: {},
				user_metadata: {},
				created_at: "2026-08-15T00:00:00Z",
			},
		}),
	);
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
		if (url.endsWith("/qorpera_member_company_file_mode")) return Response.json(mode);
		if (url.endsWith("/qorpera_list_company_paths"))
			return Response.json({
				snapshotId: "29500000-0000-4000-8000-000000000040",
				items: [],
				hasMore: false,
				nextAfter: null,
			});
		throw new Error("Unexpected synthetic request");
	});
	const auth = new QorperaAccountAuth(root, {
		projectUrl: "https://project.test",
		publishableKey: "public-fixture",
		objectGatewayUrl: "https://gateway.test",
		fetch: fetcher,
		openExternal: async () => {},
	});
	return { auth, fetcher, token, signal: new AbortController().signal };
}

describe("account-bound governed company access", () => {
	it("checks mode using the current member token and exact company", async () => {
		const { auth, fetcher, token, signal } = fixture();
		expect(await auth.companyFileMode(companyId, accountId, signal)).toEqual({
			companyId,
			environmentId,
			mode: "governed",
		});
		const [url, request] = fetcher.mock.calls[0];
		expect(url).toBe("https://project.test/rest/v1/rpc/qorpera_member_company_file_mode");
		expect(JSON.parse(String(request?.body))).toEqual({ p_profile_id: companyId });
		expect(new Headers(request?.headers).get("authorization")).toBe(`Bearer ${token}`);
		expect(request?.signal).toBeInstanceOf(AbortSignal);
	});
	it("does not use another account for mode, file or attachment access", async () => {
		const { auth, fetcher, signal } = fixture();
		await expect(auth.companyFileMode(companyId, otherAccountId, signal)).rejects.toThrow("member changed");
		await expect(auth.memberCompanyFile(companyId, environmentId, otherAccountId).list("", signal)).rejects.toThrow(
			"Member sign-in is unavailable",
		);
		await expect(
			auth
				.sessionAttachments(companyId, environmentId, otherAccountId)
				.upload(companyId, environmentId, Buffer.from("PNG"), "image/png", signal),
		).rejects.toThrow("member changed");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("does not let an already created File client survive sign-out", async () => {
		const { auth, fetcher, signal } = fixture();
		const client = auth.memberCompanyFile(companyId, environmentId, accountId);
		await expect(client.list("", signal)).resolves.toMatchObject({ items: [] });
		await auth.signOut();
		fetcher.mockClear();
		await expect(client.list("", signal)).rejects.toThrow("Member sign-in is unavailable");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{},
		{ companyId: otherAccountId, environmentId, mode: "legacy" },
		{ companyId, environmentId, mode: "unknown" },
	])("never interprets missing or mismatched mode as legacy access", async (mode) => {
		const { auth, signal } = fixture(mode);
		await expect(auth.companyFileMode(companyId, accountId, signal)).rejects.toThrow();
	});
	it("fails closed on an unavailable mode RPC without revealing the database error", async () => {
		const { auth, fetcher, signal } = fixture();
		fetcher.mockImplementation(async () => Response.json({ message: "PRIVATE DB DETAILS" }, { status: 503 }));
		await expect(auth.companyFileMode(companyId, accountId, signal)).rejects.toThrow("access mode is unavailable");
	});
});
