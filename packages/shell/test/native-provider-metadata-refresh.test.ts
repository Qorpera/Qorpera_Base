import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAccountRefreshBody } from "@qorpera/cloud-client/native-account-refresh";
import {
	type NativeProviderAccountRefresh,
	type NativeProviderControlPlane,
	NativeProviderHost,
	sealNativeCredentialCapsule,
} from "@qorpera/runtime/cloud-native-provider-host";
import {
	HttpNativeProviderHostService,
	SupabaseNativeProviderControlPlane,
} from "@qorpera/runtime/cloud-native-provider-service";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchHttp = fetch;
const identity = "10000000-0000-4000-8000-000000000001";
const account: NativeProviderAccountRefresh = {
	connectionId: "10000000-0000-4000-8000-000000000002",
	connectionVersion: 1,
	capsuleId: "10000000-0000-4000-8000-000000000003",
	encryptedCapsuleReference: "native-capsule/10000000-0000-4000-8000-000000000003",
	nativeHarness: "codex-cli",
};
const request = {
	requestId: "10000000-0000-4000-8000-000000000004",
	computeIdentityId: identity,
	requestedByUserId: "10000000-0000-4000-8000-000000000005",
	expiresAt: "2099-01-01T00:00:00.000Z",
	capability: "a".repeat(43),
};
const roots: string[] = [];
const hosts: NativeProviderHost[] = [];

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-account-test-"));
	roots.push(root);
	const source = join(root, "source");
	const temporaryRoot = join(root, "temporary");
	await mkdir(join(source, "codex"), { recursive: true });
	await mkdir(temporaryRoot);
	const token = `header.${Buffer.from(JSON.stringify({ email: "member@example.com" })).toString("base64url")}.signature`;
	await writeFile(
		join(source, "codex", "auth.json"),
		JSON.stringify({
			tokens: {
				id_token: token,
				access_token: "provider-secret",
				account_id: "provider-account",
			},
		}),
		{ mode: 0o600 },
	);
	const masterKey = randomBytes(32).toString("base64url");
	const sealed = await sealNativeCredentialCapsule(source, masterKey, account.capsuleId);
	const list = vi.fn(async () => [account]);
	const record = vi.fn<NonNullable<NativeProviderControlPlane["recordAccountMetadata"]>>(async () => undefined);
	const get = vi.fn(async () => sealed);
	const put = vi.fn(async () => undefined);
	const unavailable = async (): Promise<never> => {
		throw new Error("Unexpected harness operation");
	};
	const describeRefresh = vi.fn(async () => ({
		computeIdentityId: identity,
		requestedByUserId: request.requestedByUserId,
		expiresAt: request.expiresAt,
		status: "pending" as const,
	}));
	const completeRefresh = vi.fn(async () => true);
	const control: NativeProviderControlPlane = {
		describeAccountRefresh: describeRefresh,
		completeAccountRefresh: completeRefresh,
		describeLogin: unavailable,
		completeLogin: unavailable,
		validateExecution: unavailable,
		sendMessage: unavailable,
		listAccountRefreshes: list,
		recordAccountMetadata: record,
	};
	const host = new NativeProviderHost({
		controlPlane: control,
		capsules: { get, put },
		masterKey,
		computeIdentityId: identity,
		temporaryRoot,
		harness: { beginLogin: unavailable, execute: unavailable },
	});
	hosts.push(host);
	const fetcher = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					rate_limit: {
						primary_window: { used_percent: 91, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
					},
				}),
			),
	);
	vi.stubGlobal("fetch", fetcher);
	return { host, list, record, get, put, fetcher, temporaryRoot, describeRefresh, completeRefresh };
}

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stopAccountMetadataRefresh();
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native provider account metadata refresh", () => {
	it("completes scoped refresh only after actual metadata writes and cleanup finish", async () => {
		const f = await fixture();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		f.record.mockImplementationOnce(async () => {
			entered();
			await gate;
		});
		const pending = f.host.refreshRequestedAccountMetadata(request);
		await started;
		expect(f.completeRefresh).not.toHaveBeenCalled();
		release();
		expect(await pending).toEqual({
			schema: "qorpera.native-account-refresh-result/v1",
			request_id: request.requestId,
			status: "completed",
		});
		expect(f.describeRefresh).toHaveBeenCalledWith(request.requestId, request.capability, expect.any(AbortSignal));
		expect(f.completeRefresh).toHaveBeenCalledWith(request.requestId, request.capability, expect.any(AbortSignal));
		expect(f.put).not.toHaveBeenCalled();
		expect(await readdir(f.temporaryRoot)).toEqual([]);
	});
	it("records a finished attempt with unknown quota after provider failure without claiming fresh usage", async () => {
		const f = await fixture();
		f.fetcher.mockRejectedValueOnce(new Error("Provider unavailable"));
		await f.host.refreshRequestedAccountMetadata(request);
		expect(f.completeRefresh).toHaveBeenCalledTimes(1);
		expect(f.record.mock.calls[0]?.[2]).not.toHaveProperty("providerAccountUsage");
		expect(f.put).not.toHaveBeenCalled();
	});
	it("rejects mismatched requester and denied completion", async () => {
		const f = await fixture();
		await expect(f.host.refreshRequestedAccountMetadata({ ...request, requestedByUserId: identity })).rejects.toThrow(
			"authority changed",
		);
		expect(f.get).not.toHaveBeenCalled();
		f.completeRefresh.mockResolvedValueOnce(false);
		await expect(f.host.refreshRequestedAccountMetadata(request)).rejects.toThrow("unavailable");
	});

	it("accepts refresh capability at the guest route and refuses another bearer", async () => {
		const f = await fixture();
		const service = new HttpNativeProviderHostService(f.host, "b".repeat(43), "127.0.0.1", 0, "127.0.0.1");
		const port = await service.start();
		try {
			const denied = await fetchHttp(`http://127.0.0.1:${port}/account-refresh`, {
				method: "POST",
				headers: { authorization: `Bearer ${"b".repeat(43)}` },
				body: JSON.stringify(nativeAccountRefreshBody(request)),
			});
			expect(denied.status).toBe(401);
			expect(f.describeRefresh).not.toHaveBeenCalled();
			const response = await fetchHttp(`http://127.0.0.1:${port}/account-refresh`, {
				method: "POST",
				headers: { authorization: `Bearer ${request.capability}` },
				body: JSON.stringify(nativeAccountRefreshBody(request)),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				schema: "qorpera.native-account-refresh-result/v1",
				request_id: request.requestId,
				status: "completed",
			});
			expect(f.completeRefresh).toHaveBeenCalledTimes(1);
		} finally {
			await service.close();
		}
	});
	it("hashes maintenance capability and fences completion to the local recovery epoch", async () => {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const fetcher: typeof fetch = async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return Response.json(
				String(url).endsWith("qorpera_describe_native_account_refresh_route")
					? {
							request_id: request.requestId,
							profile_id: account.connectionId,
							compute_identity_id: identity,
							requested_by_user_id: request.requestedByUserId,
							expires_at: request.expiresAt,
							status: "pending",
						}
					: true,
			);
		};
		const control = new SupabaseNativeProviderControlPlane("https://example.supabase.co", "test-key", fetcher, {
			computeIdentityId: identity,
			epoch: 4,
		});
		expect((await control.describeAccountRefresh(request.requestId, request.capability)).computeIdentityId).toBe(
			identity,
		);
		expect(await control.completeAccountRefresh(request.requestId, request.capability)).toBe(true);
		expect(calls[1]?.body).toEqual({
			p_request_id: request.requestId,
			p_capability_sha256: createHash("sha256").update(request.capability).digest("hex"),
			p_recovery_epoch: 4,
		});
		expect(JSON.stringify(calls)).not.toContain(request.capability);
	});

	it("hydrates actual account metadata without changing the credential capsule", async () => {
		const f = await fixture();
		await f.host.refreshAccountMetadata();
		expect(f.list).toHaveBeenCalledTimes(2);
		expect(f.list).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
		expect(f.record).toHaveBeenCalledWith(
			identity,
			account,
			{
				providerAccountEmail: "member@example.com",
				providerAccountIdentity: createHash("sha256").update("openai-account:provider-account").digest("hex"),
				providerAccountUsage: {
					observedAt: expect.any(String),
					windows: [
						{
							id: "primary",
							label: "5 hours",
							usedPercent: 91,
							windowSeconds: 18_000,
							resetAt: new Date(1_900_000_000_000).toISOString(),
						},
					],
				},
			},
			expect.any(AbortSignal),
		);
		expect(f.put).not.toHaveBeenCalled();
		expect(await readdir(f.temporaryRoot)).toEqual([]);
	});

	it("rechecks revocation before making a provider request and removes plaintext", async () => {
		const f = await fixture();
		f.list.mockResolvedValueOnce([account]).mockResolvedValueOnce([]);
		await f.host.refreshAccountMetadata();
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.record).not.toHaveBeenCalled();
		expect(await readdir(f.temporaryRoot)).toEqual([]);
	});

	it("coalesces simultaneous refreshes and cleans up after a fenced write fails", async () => {
		const f = await fixture();
		f.record.mockRejectedValueOnce(new Error("Recovery epoch changed"));
		await Promise.all([f.host.refreshAccountMetadata(), f.host.refreshAccountMetadata()]);
		expect(f.get).toHaveBeenCalledTimes(1);
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(await readdir(f.temporaryRoot)).toEqual([]);
	});

	it("still hydrates email when quota is unavailable", async () => {
		const f = await fixture();
		f.fetcher.mockRejectedValueOnce(new Error("Provider unavailable"));
		await f.host.refreshAccountMetadata();
		expect(f.record).toHaveBeenCalledWith(
			identity,
			account,
			{
				providerAccountEmail: "member@example.com",
				providerAccountIdentity: createHash("sha256").update("openai-account:provider-account").digest("hex"),
			},
			expect.any(AbortSignal),
		);
		expect(await readdir(f.temporaryRoot)).toEqual([]);
	});

	it("cancels provider reads on shutdown and removes plaintext", async () => {
		const f = await fixture();
		let started!: () => void;
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.stubGlobal(
			"fetch",
			(_url: unknown, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					started();
					init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const refresh = f.host.refreshAccountMetadata();
		await start;
		await f.host.stopAccountMetadataRefresh();
		await refresh;
		expect(f.record).not.toHaveBeenCalled();
		expect(await readdir(f.temporaryRoot)).toEqual([]);
	});

	it("sends the local identity epoch and exact capsule when recording metadata", async () => {
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const fetcher: typeof fetch = async (url, init) => {
			requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return new Response(
				JSON.stringify(
					String(url).endsWith("qorpera_list_native_provider_account_refreshes")
						? [
								{
									connection_id: account.connectionId,
									connection_version: account.connectionVersion,
									credential_capsule_id: account.capsuleId,
									encrypted_capsule_reference: account.encryptedCapsuleReference,
									native_harness: account.nativeHarness,
								},
							]
						: null,
				),
			);
		};
		const control = new SupabaseNativeProviderControlPlane("https://example.supabase.co", "test-key", fetcher, {
			computeIdentityId: identity,
			epoch: 4,
		});
		expect(await control.listAccountRefreshes(identity)).toEqual([account]);
		await control.recordAccountMetadata(identity, account, { providerAccountEmail: "member@example.com" });
		expect(requests[0]?.body).toEqual({ p_compute_identity_id: identity, p_recovery_epoch: 4 });
		expect(requests[1]?.body).toEqual({
			p_compute_identity_id: identity,
			p_recovery_epoch: 4,
			p_connection_id: account.connectionId,
			p_connection_version: account.connectionVersion,
			p_credential_capsule_id: account.capsuleId,
			p_provider_account_email: "member@example.com",
			p_provider_account_usage: null,
			p_provider_account_identity: null,
		});
	});

	it("rejects another identity before contacting the control plane", async () => {
		const fetcher = vi.fn();
		const control = new SupabaseNativeProviderControlPlane("https://example.supabase.co", "test-key", fetcher, {
			computeIdentityId: identity,
			epoch: 4,
		});
		await expect(control.listAccountRefreshes(account.connectionId)).rejects.toThrow("matching local identity");
		await expect(control.recordAccountMetadata(account.connectionId, account, {})).rejects.toThrow(
			"matching local identity",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
