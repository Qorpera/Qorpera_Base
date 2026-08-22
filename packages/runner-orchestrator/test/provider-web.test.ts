import { describe, expect, it, vi } from "vitest";
import type { CloudRunnerProviderServiceBackend } from "../src/provider-service.ts";
import { WebCloudRunnerProviderService } from "../src/provider-web.ts";

describe("web cloud runner provider service", () => {
	it("authenticates and executes the shared provider request contract", async () => {
		const reconcile = vi.fn(async () => undefined);
		const backend: CloudRunnerProviderServiceBackend = {
			adapterId: "qorpera_infrastructure",
			reconcile,
			acquire: async () => {
				throw new Error("not used");
			},
			deliver: async () => {
				throw new Error("not used");
			},
			stop: async () => {
				throw new Error("not used");
			},
		};
		const service = new WebCloudRunnerProviderService(backend, "provider-secret");
		const unauthorized = await service.handle(
			new Request("https://provider.example.test/v1/qorpera-runner-provider", {
				method: "POST",
				body: "{}",
			}),
		);
		expect(unauthorized.status).toBe(401);
		const response = await service.handle(
			new Request("https://provider.example.test/v1/qorpera-runner-provider", {
				method: "POST",
				headers: { authorization: "Bearer provider-secret", "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.runner-provider/v1",
					action: "reconcile",
					adapter_id: "qorpera_infrastructure",
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ value: null });
		expect(reconcile).toHaveBeenCalledOnce();
	});
});
