import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSubscriptionControlPlane } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";
import { SupabaseNativeProviderControlPlane } from "@qorpera/runtime/cloud-native-provider-service";
import { nativeProviderAccountEmail } from "@qorpera/runtime/native-provider-account";
import { describe, expect, it, vi } from "vitest";

const jwt = (claims: unknown): string =>
	`header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

async function projectAccount(metadata: Record<string, unknown>) {
	const control = new NativeSubscriptionControlPlane({
		rpc: async () => ({
			compute_identity: null,
			connections: [
				{
					connection_id: "10000000-0000-4000-8000-000000000001",
					client_connection_id: "10000000-0000-4000-8000-000000000003",
					connection_version: 1,
					provider: "openai",
					native_harness: "codex-cli",
					authorization_state: "active",
					connection_status: "active",
					max_native_concurrency: 1,
					billing_source: "personal_subscription",
					consent_version: "v1",
					consented_at: "2026-09-19T12:00:00Z",
					policy: { implementation_status: "supported", enablement_status: "enabled", policy_version: 1 },
					...metadata,
				},
			],
		}),
	});
	return (await control.listConnections("10000000-0000-4000-8000-000000000002")).connections[0]!;
}

describe("native provider account display metadata", () => {
	it("projects bounded usage without leaking extra provider metadata", async () => {
		const usage = {
			observedAt: "2026-09-19T12:00:00.000Z",
			windows: [
				{ id: "primary", label: "5-hour limit", usedPercent: 0, windowSeconds: 18000 },
				{ id: "secondary", label: "Weekly limit", usedPercent: 100, resetAt: "2026-09-26T12:00:00.000Z" },
			],
		};
		const account = await projectAccount({
			provider_account_usage: { ...usage, accessToken: "private" },
			usage_limit_reset_at: "2026-09-19T18:00:00Z",
		});
		expect(account.providerAccountUsage).toEqual(usage);
		expect(account.usageLimitResetAt).toBe("2026-09-19T18:00:00.000Z");
		expect(JSON.stringify(account)).not.toContain("private");
	});
	it.each([
		null,
		undefined,
		{},
		{ observedAt: "bad", windows: [] },
		{ observedAt: "2026-09-19T12:00:00Z", windows: [] },
		...[NaN, Infinity, -1, 101, "10", null].map((usedPercent) => ({
			observedAt: "2026-09-19T12:00:00Z",
			windows: [{ id: "primary", label: "5-hour limit", usedPercent }],
		})),
		{
			observedAt: "2026-09-19T12:00:00Z",
			windows: [{ id: "primary", label: "5-hour limit", usedPercent: 50, resetAt: "bad" }],
		},
		{
			observedAt: "2026-09-19T12:00:00Z",
			windows: [{ id: "primary", label: "5-hour limit", usedPercent: 50, windowSeconds: 0 }],
		},
		{
			observedAt: "2026-09-19T12:00:00Z",
			windows: [
				{ id: "primary", label: "5-hour limit", usedPercent: 50 },
				{ id: "primary", label: "Duplicate", usedPercent: 20 },
			],
		},
	])("keeps connection authority intact when optional usage is malformed (%j)", async (usage) => {
		const account = await projectAccount({ provider_account_usage: usage });
		expect(account.providerAccountUsage).toBeUndefined();
		expect(account.authorizationState).toBe("active");
		expect(account.connectionId).toBe("10000000-0000-4000-8000-000000000001");
	});
	it("still rejects invalid connection authority even when optional usage is malformed", async () => {
		await expect(projectAccount({ provider_account_usage: {}, authorization_state: "unknown" })).rejects.toThrow(
			"invalid connection authority",
		);
	});
	it("selects only email claims from official Codex credentials", () => {
		expect(
			nativeProviderAccountEmail(
				"codex-cli",
				JSON.stringify({
					tokens: {
						id_token: jwt({ email: "member@example.com", sub: "private-subject" }),
						access_token: "private-token",
					},
				}),
			),
		).toBe("member@example.com");
		expect(
			nativeProviderAccountEmail(
				"codex-cli",
				JSON.stringify({
					tokens: {
						id_token: "malformed",
						access_token: jwt({ "https://api.openai.com/profile": { email: "other@example.com" } }),
					},
				}),
			),
		).toBe("other@example.com");
		expect(nativeProviderAccountEmail("claude-code", '{"email":"claude@example.com","accessToken":"private"}')).toBe(
			"claude@example.com",
		);
	});

	it.each([
		undefined,
		"",
		"private-token",
		"member@example.com\nprivate",
		`${"a".repeat(255)}@example.com`,
		{ email: "member@example.com" },
	])("does not expose invalid email metadata (%j)", (email) => {
		expect(
			nativeProviderAccountEmail("codex-cli", JSON.stringify({ tokens: { id_token: jwt({ email }) } })),
		).toBeUndefined();
		expect(nativeProviderAccountEmail("claude-code", JSON.stringify({ email }))).toBeUndefined();
	});

	it("does not use arbitrary credential fields or raw status output as email", () => {
		expect(
			nativeProviderAccountEmail("codex-cli", '{"email":"wrong@example.com","access_token":"private"}'),
		).toBeUndefined();
		expect(nativeProviderAccountEmail("claude-code", "Logged in as member@example.com")).toBeUndefined();
	});

	it("extracts email after official login while preserving the opaque account reference", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-account-email-"));
		try {
			await writeFile(
				join(root, "login"),
				[
					'const fs = require("node:fs");',
					'const path = require("node:path");',
					'if (process.argv[2] === "--device-auth") {',
					`fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), ${JSON.stringify(JSON.stringify({ tokens: { id_token: jwt({ email: "member@example.com" }), refresh_token: "private" } }))});`,
					'console.log("https://auth.openai.com/device");',
					'} else console.log("Logged in using ChatGPT");',
				].join("\n"),
			);
			const driver = new OfficialCliNativeHarnessDriver(process.execPath, process.execPath);
			const login = await driver.beginLogin("codex-cli", root);
			await login.prompt;
			const result = await login.completed;
			expect(result.providerAccountEmail).toBe("member@example.com");
			expect(result.providerAccountReference).toMatch(/^codex-cli:[a-f0-9]{64}$/);
			expect(JSON.stringify(result)).not.toContain("private");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("passes display email separately to service-only login completion", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
		const control = new SupabaseNativeProviderControlPlane("https://cloud.example.com", "test-service-key", fetcher);
		await control.completeLogin({
			loginId: "10000000-0000-4000-8000-000000000001",
			capability: "test-capability",
			capsuleId: "10000000-0000-4000-8000-000000000002",
			encryptedCapsuleReference: "test-capsule",
			attestationPolicySha256: "a".repeat(64),
			providerAccountReference: "codex-cli:opaque",
			providerAccountEmail: "member@example.com",
		});
		expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
			p_provider_account_reference: "codex-cli:opaque",
			p_provider_account_email: "member@example.com",
		});
	});

	it.each([undefined, "member@example.com"])(
		"projects optional email without deriving it from the account reference (%s)",
		async (providerAccountEmail) => {
			const control = new NativeSubscriptionControlPlane({
				rpc: async () => ({
					compute_identity: null,
					connections: [
						{
							connection_id: "10000000-0000-4000-8000-000000000001",
							client_connection_id: "10000000-0000-4000-8000-000000000003",
							connection_version: 1,
							provider: "openai",
							native_harness: "codex-cli",
							authorization_state: "active",
							connection_status: "active",
							max_native_concurrency: 1,
							provider_account_reference: "codex-cli:opaque",
							provider_account_email: providerAccountEmail,
							billing_source: "personal_subscription",
							consent_version: "v1",
							consented_at: "2026-09-19T12:00:00Z",
							policy: { implementation_status: "supported", enablement_status: "enabled", policy_version: 1 },
						},
					],
				}),
			});
			const result = await control.listConnections("10000000-0000-4000-8000-000000000002");
			expect(result.connections[0]?.clientConnectionId).toBe("10000000-0000-4000-8000-000000000003");
			expect(result.connections[0]?.providerAccountEmail).toBe(providerAccountEmail);
			expect(result.connections[0]?.providerAccountReference).toBe("codex-cli:opaque");
		},
	);
});
