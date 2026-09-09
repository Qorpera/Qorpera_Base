import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import { HttpNativeProviderComputerBridge } from "@qorpera/runtime/cloud-native-provider";
import { NativeProviderHost } from "@qorpera/runtime/cloud-native-provider-host";
import {
	HttpNativeProviderHostService,
	SupabaseNativeCredentialCapsuleStore,
	SupabaseNativeProviderControlPlane,
} from "@qorpera/runtime/cloud-native-provider-service";
import type { CloudRunnerNativeAuthority } from "@qorpera/runtime/cloud-runner-broker";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function fixture() {
	const {
		binding,
		authority: { identity },
	} = nativeToolAuthorityFixture();
	const authority: CloudRunnerNativeAuthority = {
		...binding,
		providerConnectionId: identity.providerConnectionId,
		providerConnectionVersion: identity.providerConnectionVersion,
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: identity.sponsorUserId!,
		credentialOwnershipKind: "member",
		credentialOwnerUserId: identity.sponsorUserId!,
		encryptedCapsuleReference: `native-capsule/${binding.credentialCapsuleId}`,
		attestationPolicySha256: "a".repeat(64),
		authenticationMode: "native_subscription",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	return { binding, authority, job: { jobId: binding.jobId, attemptCount: 1 } };
}

it("enforces streamed size limits even with a false Content-Length", async () => {
	const cancel = vi.fn();
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(17));
				controller.enqueue(new Uint8Array(17));
			},
			cancel,
		}),
		{ headers: { "content-length": "1" } },
	);
	await expect(readBoundedCloudResponse(response, 32, new AbortController().signal)).rejects.toThrow("byte limit");
	expect(cancel).toHaveBeenCalledOnce();
});

it("bounds native execution HTTP even if the transport ignores its abort signal", async () => {
	const f = fixture();
	const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
	const bridge = new HttpNativeProviderComputerBridge("https://native.example/", "a".repeat(43), fetcher, {
		requestTimeoutMs: 20,
	});
	const process = await bridge.startCompany(f.authority, f.job);
	await expect(process.result).rejects.toThrow("request stopped");
	expect(fetcher).toHaveBeenCalledOnce();
});

it("rejects an already-cancelled native request before contacting its host", async () => {
	const f = fixture();
	const abort = new AbortController();
	abort.abort();
	const fetcher = vi.fn<typeof fetch>();
	const bridge = new HttpNativeProviderComputerBridge("https://native.example/", "a".repeat(43), fetcher, {
		signal: abort.signal,
	});
	const process = await bridge.startCompany(f.authority, f.job);
	await expect(process.result).rejects.toThrow();
	expect(fetcher).not.toHaveBeenCalled();
});

it.each([403, 503])("cancels a stalled %s bridge error body without exposing it", async (status) => {
	const f = fixture();
	const cancel = vi.fn();
	const fetcher = vi.fn<typeof fetch>(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("PRIVATE_UPSTREAM_ERROR"));
					},
					cancel,
				}),
				{ status },
			),
	);
	const bridge = new HttpNativeProviderComputerBridge("https://native.example/", "a".repeat(43), fetcher);
	const process = await bridge.startCompany(f.authority, f.job);
	await expect(process.result).rejects.toThrow(`Native provider bridge request failed (${status})`);
	expect(cancel).toHaveBeenCalledOnce();
});

it.each(["PRIVATE_MALFORMED_JSON", "x".repeat(64 * 1024 + 1)])(
	"does not retain or echo invalid bridge response bytes",
	async (body) => {
		const f = fixture();
		const bridge = new HttpNativeProviderComputerBridge(
			"https://native.example/",
			"a".repeat(43),
			async () => new Response(body),
		);
		const process = await bridge.startCompany(f.authority, f.job);
		await expect(process.result).rejects.toThrow(body.length > 64 * 1024 ? "byte limit" : "returned invalid JSON");
	},
);

it.each(["get", "put"] as const)("bounds capsule %s even if Storage never returns", async (method) => {
	vi.useFakeTimers();
	const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
	const capsules = new SupabaseNativeCredentialCapsuleStore(
		"https://cloud.example/",
		"SYNTHETIC_SERVICE_KEY",
		fetcher,
	);
	const reference = `native-capsule/${randomUUID()}`;
	const pending = method === "get" ? capsules.get(reference) : capsules.put(reference, new Uint8Array([1, 2, 3]));
	const rejected = expect(pending).rejects.toThrow("request deadline");
	await vi.advanceTimersByTimeAsync(30_000);
	await rejected;
	expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
	expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
	expect(fetcher).toHaveBeenCalledOnce();
});

it("bounds a stalled encrypted capsule body and cancels it on expiry", async () => {
	vi.useFakeTimers();
	const cancel = vi.fn();
	const capsules = new SupabaseNativeCredentialCapsuleStore(
		"https://cloud.example/",
		"SYNTHETIC_SERVICE_KEY",
		async () => new Response(new ReadableStream({ cancel })),
	);
	const rejected = expect(capsules.get(`native-capsule/${randomUUID()}`)).rejects.toThrow("request deadline");
	await vi.advanceTimersByTimeAsync(30_000);
	await rejected;
	expect(cancel).toHaveBeenCalledOnce();
});

it("does not follow capsule redirects or trust an oversized declared body", async () => {
	const cancel = vi.fn();
	const fetcher = vi.fn<typeof fetch>(
		async () =>
			new Response(new ReadableStream({ cancel }), {
				headers: { "content-length": String(65 * 1024 * 1024 + 1) },
			}),
	);
	const capsules = new SupabaseNativeCredentialCapsuleStore(
		"https://cloud.example/",
		"SYNTHETIC_SERVICE_KEY",
		fetcher,
	);
	await expect(capsules.get(`native-capsule/${randomUUID()}`)).rejects.toThrow("byte limit");
	expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
	expect(cancel).toHaveBeenCalledOnce();
});

it.each([
	"https://user:secret@cloud.example/",
	"https://cloud.example/?key=private",
	"https://cloud.example/other",
	"http://cloud.example/",
])("rejects non-origin credential transport configuration", (url) => {
	expect(() => new SupabaseNativeCredentialCapsuleStore(url, "key")).toThrow("HTTPS origin");
	expect(() => new SupabaseNativeProviderControlPlane(url, "key")).toThrow("HTTPS origin");
});

async function serviceFixture() {
	const f = fixture();
	const host = new NativeProviderHost({
		masterKey: randomBytes(32).toString("base64url"),
		computeIdentityId: f.binding.computeIdentityId,
		controlPlane: {
			validateExecution: async () => {},
			sendMessage: async () => {
				throw new Error("No send");
			},
			describeLogin: async () => {
				throw new Error("No login");
			},
			completeLogin: async () => {},
		},
		capsules: {
			get: async () => {
				throw new Error("No credentials");
			},
			put: async () => {},
		},
		harness: {
			beginLogin: async () => {
				throw new Error("No login");
			},
			execute: async () => {
				throw new Error("No model");
			},
		},
	});
	const execute = vi.spyOn(host, "execute").mockImplementation(
		async (_request, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("Synthetic execution stopped")), { once: true });
			}),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
	const token = "a".repeat(43);
	const service = new HttpNativeProviderHostService(host, token);
	const port = await service.start();
	const url = `http://127.0.0.1:${port}/`;
	return { ...f, execute, service, url, port, token };
}

it("stops a native execution when its runner connection closes", async () => {
	const f = await serviceFixture();
	const abort = new AbortController();
	try {
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.token, fetch, { signal: abort.signal });
		const process = await bridge.startCompany(f.authority, f.job);
		const rejected = expect(process.result).rejects.toThrow();
		await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
		abort.abort();
		await rejected;
		await vi.waitFor(() => expect(f.execute.mock.calls[0][1]?.aborted).toBe(true));
	} finally {
		await f.service.close();
	}
});

it("rejects cancellation for another run and aborts the exact active execution", async () => {
	const f = await serviceFixture();
	try {
		const bridge = new HttpNativeProviderComputerBridge(f.url, f.token);
		const process = await bridge.startCompany(f.authority, f.job);
		const rejected = expect(process.result).rejects.toThrow();
		await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
		const body = {
			schema: "qorpera.native-provider-cancel/v1",
			lease_id: f.binding.leaseId,
			run_id: randomUUID(),
			assignment_id: f.binding.assignmentId,
			reason: "cancelled",
		};
		const response = await fetch(`${f.url}cancel`, {
			method: "POST",
			headers: { authorization: `Bearer ${f.token}` },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(422);
		await response.arrayBuffer();
		expect(f.execute.mock.calls[0][1]?.aborted).toBe(false);
		const accepted = await fetch(`${f.url}cancel`, {
			method: "POST",
			headers: { authorization: `Bearer ${f.token}` },
			body: JSON.stringify({ ...body, run_id: f.binding.runId }),
		});
		expect(await accepted.json()).toEqual({ cancelled: true });
		await rejected;
	} finally {
		await f.service.close();
	}
});

it("closes incomplete requests without starting work after service shutdown", async () => {
	const f = await serviceFixture();
	const request = httpRequest(`${f.url}execute`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${f.token}`,
			"content-length": "200",
		},
	});
	request.on("error", () => {});
	try {
		const connected = new Promise<void>((resolve) =>
			request.once("socket", (socket) => socket.once("connect", resolve)),
		);
		request.write("{");
		await connected;
		await f.service.close();
		request.end("}");
		await vi.waitFor(() => expect(request.destroyed).toBe(true));
		expect(f.execute).not.toHaveBeenCalled();
	} finally {
		request.destroy();
		await f.service.close();
	}
});
