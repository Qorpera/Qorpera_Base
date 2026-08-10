import { describe, expect, it } from "vitest";
import { brokerCredentialProjection, isScopedInferenceTarget } from "../src/model-request-scope.ts";

describe("kernel model-request broker", () => {
	it("projects opaque handles without copying API keys or OAuth tokens", () => {
		const projection = brokerCredentialProjection(
			{
				openai: { type: "api_key", key: "raw-openai-secret", env: { ALSO_SECRET: "value" } },
				"openai-codex": {
					type: "oauth",
					access: "raw-access-token",
					refresh: "raw-refresh-token",
					expires: 0,
				},
				github: { type: "api_key", key: "raw-github-secret" },
			},
			["anthropic"],
			new Set(["openai", "openai-codex", "anthropic"]),
		);
		const serialized = JSON.stringify(projection.credentials);
		expect(serialized).not.toContain("raw-");
		expect(serialized).not.toContain("ALSO_SECRET");
		expect(serialized).not.toContain("github");
		expect(projection.handles.size).toBe(3);
		expect(projection.credentials.openai).toMatchObject({ type: "api_key" });
		expect(projection.credentials["openai-codex"]).toMatchObject({ type: "oauth" });
	});

	it("allows only configured provider inference endpoints", () => {
		const domains = new Set(["api.openai.com"]);
		const bases = ["https://api.openai.com/v1"];
		expect(isScopedInferenceTarget(bases, new URL("https://api.openai.com/v1/responses"), domains)).toBe(true);
		expect(isScopedInferenceTarget(bases, new URL("https://api.openai.com/v1/files"), domains)).toBe(false);
		expect(isScopedInferenceTarget(bases, new URL("https://attacker.example/v1/responses"), domains)).toBe(false);
		expect(isScopedInferenceTarget(bases, new URL("http://api.openai.com/v1/responses"), domains)).toBe(false);
	});
});
