/**
 * Company connections state (Build 3): founder-bound destinations and
 * secrets, kernel-side dereferencing, and the RFC 6749 refresh lifecycle.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bindCompanySecret,
	bindNetworkDestination,
	bindWakeSchedule,
	companyConnectionsPath,
	destinationAllowed,
	disableWakeSchedule,
	disableWebhook,
	enableWebhook,
	MIN_WAKE_INTERVAL_MINUTES,
	readCompanyConnections,
	readWakeSchedule,
	readWebhookBinding,
	removeCompanySecret,
	removeNetworkDestination,
	resolveCompanySecret,
	suspendWakeSchedule,
} from "../src/core/company-connections.ts";

let root: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-connections-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
	process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-home");
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
	else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("network destinations", () => {
	it("binds, lists, and removes destinations; rejects invalid hosts", () => {
		bindNetworkDestination(root, "API.Example.com", "the API");
		bindNetworkDestination(root, "hooks.example.com:8443");
		expect(readCompanyConnections(root).destinations.map((destination) => destination.host)).toEqual([
			"api.example.com",
			"hooks.example.com:8443",
		]);
		expect(() => bindNetworkDestination(root, "https://api.example.com")).toThrow(/Invalid destination/);
		expect(removeNetworkDestination(root, "api.example.com")).toBe(true);
		expect(removeNetworkDestination(root, "api.example.com")).toBe(false);
	});

	it("allows only HTTPS to exactly bound hosts", () => {
		bindNetworkDestination(root, "api.example.com");
		bindNetworkDestination(root, "alt.example.com:8443");
		expect(destinationAllowed(root, new URL("https://api.example.com/v1/things?q=1"))).toBe(true);
		expect(destinationAllowed(root, new URL("http://api.example.com/v1"))).toBe(false);
		expect(destinationAllowed(root, new URL("https://sub.api.example.com/"))).toBe(false);
		expect(destinationAllowed(root, new URL("https://api.example.com:8443/"))).toBe(false);
		expect(destinationAllowed(root, new URL("https://alt.example.com:8443/"))).toBe(true);
		expect(destinationAllowed(root, new URL("https://evil.example.net/"))).toBe(false);
	});
});

describe("secrets", () => {
	it("binds and lists names only, never values", () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "raw-value" });
		const listed = readCompanyConnections(root);
		expect(listed.secretNames).toEqual(["api-key"]);
		expect(JSON.stringify(listed)).not.toContain("raw-value");
		expect(removeCompanySecret(root, "api-key")).toBe(true);
		expect(removeCompanySecret(root, "api-key")).toBe(false);
		expect(() => bindCompanySecret(root, "bad name!", { kind: "static", value: "x" })).toThrow(/Invalid secret name/);
	});

	it("resolves static secrets and non-expired oauth2 secrets without network", async () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "raw-value" });
		bindCompanySecret(root, "oauth", {
			kind: "oauth2",
			accessToken: "live-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://auth.example.com/token",
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		});
		const failingFetch: typeof fetch = () => {
			throw new Error("no network expected");
		};
		expect(await resolveCompanySecret(root, "api-key", failingFetch)).toBe("raw-value");
		expect(await resolveCompanySecret(root, "oauth", failingFetch)).toBe("live-token");
		await expect(resolveCompanySecret(root, "missing", failingFetch)).rejects.toThrow(/Unknown secret reference/);
	});

	it("refreshes expired oauth2 secrets through the token endpoint and persists the rotation", async () => {
		bindCompanySecret(root, "oauth", {
			kind: "oauth2",
			accessToken: "stale-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://auth.example.com/token",
			clientId: "client-a",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		const seen: Array<{ url: string; body: string }> = [];
		const fakeFetch: typeof fetch = async (url, init) => {
			seen.push({ url: String(url), body: String(init?.body) });
			return new Response(
				JSON.stringify({ access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3600 }),
				{ status: 200 },
			);
		};
		expect(await resolveCompanySecret(root, "oauth", fakeFetch)).toBe("fresh-token");
		expect(seen.length).toBe(1);
		expect(seen[0].url).toBe("https://auth.example.com/token");
		expect(seen[0].body).toContain("grant_type=refresh_token");
		expect(seen[0].body).toContain("refresh_token=refresh-1");
		expect(seen[0].body).toContain("client_id=client-a");
		// Rotation persisted: the store now carries the new pair, and the next
		// resolve needs no network until the new expiry.
		const stored = readFileSync(companyConnectionsPath(root), "utf-8");
		expect(stored).toContain("fresh-token");
		expect(stored).toContain("refresh-2");
		expect(stored).not.toContain("stale-token");
		const failingFetch: typeof fetch = () => {
			throw new Error("no network expected");
		};
		expect(await resolveCompanySecret(root, "oauth", failingFetch)).toBe("fresh-token");
	});

	it("fails closed when the token endpoint rejects the refresh", async () => {
		bindCompanySecret(root, "oauth", {
			kind: "oauth2",
			accessToken: "stale-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://auth.example.com/token",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		const rejectingFetch: typeof fetch = async () => new Response("denied", { status: 400 });
		await expect(resolveCompanySecret(root, "oauth", rejectingFetch)).rejects.toThrow(/refresh failed/);
	});
});

describe("wake schedule", () => {
	it("binds, reports, disables, and enforces the wake-rate ceiling", () => {
		expect(readWakeSchedule(root)).toBeUndefined();
		expect(() => bindWakeSchedule(root, MIN_WAKE_INTERVAL_MINUTES - 1)).toThrow(/ceiling/);
		const schedule = bindWakeSchedule(root, 30);
		expect(schedule).toEqual({ intervalMinutes: 30, enabled: true });
		expect(readWakeSchedule(root)).toEqual(schedule);
		expect(disableWakeSchedule(root)).toBe(true);
		expect(readWakeSchedule(root)?.enabled).toBe(false);
		expect(disableWakeSchedule(root)).toBe(false);
	});

	it("kernel suspension sticks until the founder re-binds", () => {
		bindWakeSchedule(root, 30);
		suspendWakeSchedule(root, "3 consecutive wake failures");
		expect(readWakeSchedule(root)?.suspendedReason).toContain("failures");
		// Re-binding is the founder's re-enable: suspension clears.
		expect(bindWakeSchedule(root, 30).suspendedReason).toBeUndefined();
	});
});

describe("webhook binding (optional kernel module)", () => {
	it("is off by default; enable mints a stable token; disable keeps it for re-enable", () => {
		expect(readWebhookBinding(root)).toBeUndefined();
		const first = enableWebhook(root, 4900);
		expect(first.enabled).toBe(true);
		expect(first.port).toBe(4900);
		expect(first.token.length).toBeGreaterThan(10);
		expect(disableWebhook(root)).toBe(true);
		expect(readWebhookBinding(root)?.enabled).toBe(false);
		// Re-enabling keeps the token: bound provider URLs stay valid.
		expect(enableWebhook(root).token).toBe(first.token);
		expect(() => enableWebhook(root, 99_999_999)).toThrow(/Invalid webhook port/);
	});
});
