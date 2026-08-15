import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@qorpera/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAccountStore } from "../src/model-accounts.ts";

const temporaryDirectories: string[] = [];

function temporaryStore(fetch?: typeof globalThis.fetch): {
	store: ModelAccountStore;
	legacyPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "qorpera-model-accounts-"));
	temporaryDirectories.push(root);
	const legacyPath = join(root, "agent", "auth.json");
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(legacyPath, "{}", { encoding: "utf-8", mode: 0o600, flag: "w" });
	return {
		store: new ModelAccountStore(join(root, "model-accounts.json"), legacyPath, {
			ownerUserId: "user-one",
			...(fetch ? { fetch } : {}),
		}),
		legacyPath,
	};
}

function oauth(accountId: string, email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 60 * 60_000,
		accountId,
		email,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model account store", () => {
	it("migrates the canonical credential and preserves multiple accounts per provider", async () => {
		const root = mkdtempSync(join(tmpdir(), "qorpera-model-accounts-"));
		temporaryDirectories.push(root);
		const legacyPath = join(root, "auth.json");
		writeFileSync(legacyPath, JSON.stringify({ "openai-codex": oauth("one", "one@example.com") }));
		const store = new ModelAccountStore(join(root, "accounts.json"), legacyPath, { ownerUserId: "user-one" });

		expect(store.views()).toHaveLength(1);
		expect(store.views()[0]?.accountName).toBe("one@example.com");
		await store.add("openai-codex", oauth("two", "two@example.com"));
		expect(store.views().map((account) => account.accountName)).toEqual(["one@example.com", "two@example.com"]);

		const second = store.views()[1]!;
		expect(await store.remove(second.id)).toBe(true);
		expect(store.views()).toHaveLength(1);
		const canonical = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<string, OAuthCredential>;
		expect(canonical["openai-codex"]?.accountId).toBe("one");

		expect(await store.remove(store.views()[0]!.id)).toBe(true);
		const empty = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<string, OAuthCredential>;
		expect(empty["openai-codex"]).toBeUndefined();
	});

	it("routes a request through the account with the most remaining usage", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
			const authorization = new Headers(init?.headers).get("authorization");
			const usedPercent = authorization === "Bearer access-one" ? 82 : 17;
			return new Response(
				JSON.stringify({
					rate_limit: {
						primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000 },
						secondary_window: { used_percent: usedPercent + 1, limit_window_seconds: 604_800 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const { store } = temporaryStore(fetch);
		await store.add("openai-codex", oauth("one", "one@example.com"));
		await store.add("openai-codex", oauth("two", "two@example.com"));
		await store.refreshUsage(async (accountId) => {
			const account = store.views().find((candidate) => candidate.id === accountId);
			return account?.accountName === "one@example.com" ? "access-one" : "access-two";
		});

		const lease = store.lease("openai-codex");
		expect(lease).toBeDefined();
		await lease!.run(async () => {
			const credential = (await store.read("openai-codex")) as OAuthCredential;
			expect(credential.accountId).toBe("two");
		});
		lease!.release();

		store.markRateLimited(lease!.accountId);
		const fallback = store.lease("openai-codex");
		await fallback!.run(async () => {
			const credential = (await store.read("openai-codex")) as OAuthCredential;
			expect(credential.accountId).toBe("one");
		});
		fallback!.release();
	});

	it("projects Anthropic usage windows without exposing credentials", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = String(input);
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer anthropic-access-token");
			if (url === "https://api.anthropic.com/api/oauth/profile") {
				return new Response(
					JSON.stringify({
						account: { uuid: "anthropic-account", display_name: "Claude Founder", email: "claude@example.com" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 24, resets_at: "2026-08-15T12:00:00.000Z" },
					seven_day: { utilization: 61, resets_at: "2026-08-19T12:00:00.000Z" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const { store } = temporaryStore(fetch);
		await store.add("anthropic", {
			type: "oauth",
			access: "old-access-token",
			refresh: "old-refresh-token",
			expires: Date.now() + 60 * 60_000,
		});
		const [view] = await store.refreshUsage(async () => "anthropic-access-token");

		expect(view).toMatchObject({
			accountName: "claude@example.com",
			usage: {
				status: "available",
				windows: [
					{ label: "5 hours", remainingPercent: 76 },
					{ label: "Weekly", remainingPercent: 39 },
				],
			},
		});
		expect(JSON.stringify(view)).not.toContain("anthropic-access-token");
		expect(JSON.stringify(view)).not.toContain("old-refresh-token");
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
