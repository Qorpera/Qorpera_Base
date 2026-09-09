import { randomBytes, randomUUID } from "node:crypto";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { tagNativeRuntimeFailure } from "@qorpera/runtime/cloud-native-failure";
import type { NativeProviderHost } from "@qorpera/runtime/cloud-native-provider-host";
import { HttpNativeProviderHostService } from "@qorpera/runtime/cloud-native-provider-service";
import { cloudToolRequest } from "@qorpera/runtime/cloud-native-tool-authority";
import { cloudRuntimeErrorCategory } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it.each(["timeout", "cancelled"] as const)(
	"preserves the %s category without copying abort reasons",
	async (category) => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const result = cloudToolRequest(async () => new Promise<never>(() => undefined), abort.signal, 20);
		const rejected = expect(result).rejects.toMatchObject({ category, message: "Cloud tool authority unavailable" });
		if (category === "cancelled") abort.abort(new Error("PRIVATE_ABORT_REASON"));
		await vi.advanceTimersByTimeAsync(21);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	},
);

it.each(["transport", "body", "malformed", "denied", "forged"] as const)(
	"records a safe startup stage through the HTTP service after %s failure",
	async (failure) => {
		const transport = vi.fn<typeof fetch>(async () => {
			if (failure === "transport") throw new TypeError("PRIVATE_CREDENTIAL PRIVATE_PATH");
			if (failure === "body")
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("PRIVATE_BODY"));
						},
					}),
				);
			if (failure === "malformed") return new Response("PRIVATE_INVALID_JSON");
			return Response.json({ message: "PRIVATE_DENIAL" }, { status: 403 });
		});
		const control = new HttpCloudCompanyPathControl({
			supabaseUrl: "https://authority.example",
			serviceRoleKey: "synthetic-key",
			fetch: transport,
		});
		const host = {
			beginLogin: async () => {
				if (failure === "forged")
					throw Object.assign(new Error("PRIVATE_FORGED"), { stage: "wake-envelope", category: "timeout" });
				try {
					await control.call("qorpera_read_native_wake", {}, new AbortController().signal);
				} catch (error) {
					throw new Error("PRIVATE_WRAPPER", {
						cause: tagNativeRuntimeFailure(error, "wake-envelope", cloudRuntimeErrorCategory(error)),
					});
				}
			},
		} as unknown as NativeProviderHost;
		const service = new HttpNativeProviderHostService(host, randomBytes(32).toString("base64url"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const capability = randomBytes(32).toString("base64url");
		const port = await service.start();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/login`, {
				method: "POST",
				headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.native-provider-login/v1",
					login_id: randomUUID(),
					client_connection_id: randomUUID(),
					compute_identity_id: randomUUID(),
					compute_identity_ownership_kind: "member",
					compute_identity_owner_user_id: randomUUID(),
					compute_identity_owner_scope_key: null,
					provider: "openai",
					native_harness: "codex-cli",
					login_capability: capability,
					expires_at: new Date(Date.now() + 60000).toISOString(),
				}),
			});
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({ error: "request rejected" });
			if (failure === "forged") {
				expect(logged).toHaveBeenCalledWith(
					expect.stringMatching(
						/^Native provider request rejected: internal rejection \(error; message-sha256=[a-f0-9]{16}\)$/,
					),
				);
				expect(transport).not.toHaveBeenCalled();
			} else {
				const category =
					failure === "denied"
						? "authority_unavailable"
						: failure === "malformed"
							? "invalid_response"
							: "transport_unavailable";
				expect(logged).toHaveBeenCalledWith(
					`Native provider request rejected: Native provider execution failed (stage=wake-envelope, category=${category})`,
				);
				expect(transport).toHaveBeenCalledTimes(1);
			}
			expect(logged.mock.calls.flat().join("\n")).not.toContain("PRIVATE");
		} finally {
			await service.close();
		}
	},
);
