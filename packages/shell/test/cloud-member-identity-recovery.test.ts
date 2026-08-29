import { describe, expect, it, vi } from "vitest";
import {
	CloudMemberIdentityRecoveryClient,
	type MemberRecoveryClientOptions,
} from "../src/cloud-member-identity-recovery.ts";
import {
	memberRecoveryReceipt,
	memberRecoveryReview,
	recoveryCompany,
	recoveryIdentity,
	recoveryOwner,
	recoveryTarget,
} from "./fixtures/member-identity-recovery.ts";

function fixture(response: unknown = memberRecoveryReview(), options: Partial<MemberRecoveryClientOptions> = {}) {
	const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
	const client = new CloudMemberIdentityRecoveryClient({
		companyId: recoveryCompany,
		supabaseUrl: "https://control.test",
		publishableKey: "public-key",
		accessToken: async () => "member-jwt",
		fetch: fetcher,
		...options,
	});
	return { client, fetcher, signal: new AbortController().signal };
}

describe("human cloud identity recovery transport", () => {
	it("reviews through a fixed member-JWT RPC without receiving recovery secrets", async () => {
		const { client, fetcher, signal } = fixture();
		expect(await client.review(recoveryIdentity, recoveryTarget, signal)).toEqual(memberRecoveryReview());
		const [url, input] = fetcher.mock.calls[0];
		expect(url).toBe("https://control.test/rest/v1/rpc/qorpera_review_member_identity_recovery");
		expect(input?.redirect).toBe("error");
		expect(new Headers(input?.headers).get("authorization")).toBe("Bearer member-jwt");
		expect(new Headers(input?.headers).get("apikey")).toBe("public-key");
		expect(JSON.parse(String(input?.body))).toEqual({
			p_company_id: recoveryCompany,
			p_compute_identity_id: recoveryIdentity,
			p_target_id: recoveryTarget,
		});
	});

	it("lists only bounded ordered identities and targets", async () => {
		const reviewed = memberRecoveryReview().review;
		const { client, fetcher, signal } = fixture({
			companyId: recoveryCompany,
			viewerUserId: recoveryOwner,
			isOwner: true,
			items: [reviewed.identity],
			nextAfter: null,
		});
		expect((await client.identities(null, signal)).items).toEqual([reviewed.identity]);
		expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
			p_company_id: recoveryCompany,
			p_after: null,
			p_limit: 25,
		});
		const target = {
			targetId: recoveryTarget,
			nodeId: reviewed.target.nodeId,
			status: "active",
			expiresAt: reviewed.target.expiresAt,
		};
		fetcher.mockResolvedValueOnce(
			Response.json({
				companyId: recoveryCompany,
				computeIdentityId: recoveryIdentity,
				items: [target],
				nextAfter: null,
			}),
		);
		expect(await client.targets(recoveryIdentity, null, signal)).toEqual({ items: [target], nextAfter: null });
	});

	it.each(["scope", "duplicate", "cursor", "oversize", "extra"])(
		"rejects invalid identity pages: %s",
		async (kind) => {
			const item = memberRecoveryReview().review.identity;
			const page = {
				companyId: recoveryCompany,
				viewerUserId: recoveryOwner,
				isOwner: true,
				items: [item],
				nextAfter: null as string | null,
			};
			if (kind === "scope") page.companyId = recoveryTarget;
			if (kind === "duplicate") page.items.push(item);
			if (kind === "cursor") page.nextAfter = recoveryIdentity;
			if (kind === "oversize") page.items = Array.from({ length: 26 }, () => item);
			const { client, signal } = fixture(kind === "extra" ? { ...page, privateKey: "NOT_ALLOWED" } : page);
			await expect(client.identities(null, signal)).rejects.toThrow();
		},
	);

	it.each(["company", "identity", "target", "digest", "schema", "backup", "extra"])(
		"rejects substituted review fields: %s",
		async (kind) => {
			const review = memberRecoveryReview();
			if (kind === "company") review.review.companyId = recoveryTarget;
			if (kind === "identity") review.review.identity.computeIdentityId = recoveryTarget;
			if (kind === "target") review.review.target.targetId = recoveryIdentity;
			if (kind === "digest") review.reviewSha256 = "not-a-digest";
			if (kind === "schema") Object.assign(review, { schema: "untrusted/v2" });
			if (kind === "backup" && review.review.backup) review.review.backup.objectBytes = 16385;
			const { client, signal } = fixture(
				kind === "extra" ? { ...review, serviceCapability: "NOT_ALLOWED" } : review,
			);
			await expect(client.review(recoveryIdentity, recoveryTarget, signal)).rejects.toThrow();
		},
	);

	it("submits exactly the reviewed identity, target, digest and explicit source", async () => {
		const receipt = memberRecoveryReceipt();
		const { client, fetcher, signal } = fixture(receipt);
		expect(
			await client.decide(
				memberRecoveryReview(),
				{
					kind: "request",
					requestId: recoveryOwner,
					storageSource: "nas",
				},
				signal,
			),
		).toEqual(receipt);
		expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
			p_company_id: recoveryCompany,
			p_compute_identity_id: recoveryIdentity,
			p_target_id: recoveryTarget,
			p_review_sha256: "a".repeat(64),
			p_decision: "request",
			p_client_request_id: recoveryOwner,
			p_storage_source: "nas",
		});
	});

	it("does not turn a read or an unavailable decision into an approval", async () => {
		const { client, fetcher, signal } = fixture();
		await client.review(recoveryIdentity, recoveryTarget, signal);
		const review = memberRecoveryReview();
		review.review.canRequest = false;
		await expect(
			client.decide(review, { kind: "request", requestId: recoveryOwner, storageSource: "nas" }, signal),
		).rejects.toThrow();
		await expect(client.decide(review, { kind: "consent" }, signal)).rejects.toThrow();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("rejects a receipt that substituted the backup or selected source", async () => {
		const { client, fetcher, signal } = fixture({ ...memberRecoveryReceipt(), backupRevision: 2 });
		const choice = { kind: "request" as const, requestId: recoveryOwner, storageSource: "nas" as const };
		await expect(client.decide(memberRecoveryReview(), choice, signal)).rejects.toThrow();
		fetcher.mockResolvedValueOnce(Response.json({ ...memberRecoveryReceipt(), storageSource: "supabase" }));
		await expect(client.decide(memberRecoveryReview(), choice, signal)).rejects.toThrow();
	});

	it.each([401, 403, 409, 429, 503])("never retries or exposes a raw error body (%s)", async (status) => {
		const { client, fetcher, signal } = fixture();
		fetcher.mockResolvedValueOnce(Response.json({ message: "PRIVATE_KEY_AND_DATABASE_DETAIL" }, { status }));
		await expect(
			client.decide(
				memberRecoveryReview(),
				{
					kind: "request",
					requestId: recoveryOwner,
					storageSource: "nas",
				},
				signal,
			),
		).rejects.not.toThrow("PRIVATE_KEY_AND_DATABASE_DETAIL");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("bounds token acquisition and never starts a request after the deadline", async () => {
		let complete: ((token: string) => void) | undefined;
		const { client, fetcher, signal } = fixture(null, {
			timeoutMs: 10,
			accessToken: () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		});
		await expect(client.identities(null, signal)).rejects.toThrow();
		complete?.("late-member-jwt");
		await Promise.resolve();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("bounds a stalled success body and ignores a stalled denial body", async () => {
		const { client, fetcher, signal } = fixture(null, { timeoutMs: 10 });
		const cancel = vi.fn();
		fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 200 }));
		await expect(client.review(recoveryIdentity, recoveryTarget, signal)).rejects.toThrow();
		expect(cancel).toHaveBeenCalled();
		fetcher.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					cancel() {
						return new Promise(() => {});
					},
				}),
				{ status: 403 },
			),
		);
		await expect(client.review(recoveryIdentity, recoveryTarget, signal)).rejects.toThrow("denied");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("rejects oversized and malformed responses", async () => {
		const { client, fetcher, signal } = fixture();
		for (const response of [
			new Response("x", { headers: { "content-length": String(128 * 1024 + 1) } }),
			new Response("x".repeat(128 * 1024 + 1)),
			new Response(Uint8Array.from([0xff])),
			new Response("{malformed"),
		]) {
			fetcher.mockResolvedValueOnce(response);
			await expect(client.review(recoveryIdentity, recoveryTarget, signal)).rejects.toThrow();
		}
	});

	it.each([
		{ supabaseUrl: "http://control.test" },
		{ supabaseUrl: "https://user:password@control.test" },
		{ supabaseUrl: "https://control.test/other" },
		{ publishableKey: "key\nother-header: secret" },
		{ companyId: "another-company" },
		{ timeoutMs: 0 },
		{ timeoutMs: 120001 },
	])("rejects unsafe transport configuration", (options) => {
		expect(() => fixture(null, options)).toThrow();
	});
});
