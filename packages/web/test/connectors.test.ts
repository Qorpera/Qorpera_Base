// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cloud } from "../src/cloud/client.ts";
import { createWebConnectors, HOSTED_CONNECTORS, takeConnectorReturn } from "../src/cloud/connectors.ts";
import { id, timestamp } from "./fixtures.ts";

/* The company connector client (cloud/connectors.ts). Settings' Company connections page that drew these is gone
 * (Jonas, 10 Nov 2026: fully Qorpera-hosted companies); the Bank page still signs in through this client. */

const here = dirname(fileURLToPath(import.meta.url));

/** A sign-in this tab started (what beginSignIn leaves in session storage). */
function startedHere(connectorId: string) {
	sessionStorage.setItem(
		"qorpera.connector-sign-in.v1",
		JSON.stringify({
			ticketId: id(20),
			connectorId,
			companyId: id(10),
			serviceOrigin: "https://company41-node-01.tailbb15c7.ts.net:10000",
			browserProof: "p".repeat(43),
			startedAt: Date.now(),
		}),
	);
}
const CONFIRMATION = "c".repeat(43);

afterEach(() => {
	history.replaceState(null, "", "#/");
	sessionStorage.clear();
	vi.restoreAllMocks();
});

it("ships every provider logo, sign-in included", () => {
	// The build copies public/ whole. The sign-in buttons build their logo name from the provider (signin.ts).
	const signIn = ["google", "github"].map((provider) => `provider-${provider}.svg`);
	for (const logo of [...HOSTED_CONNECTORS.map((connector) => connector.logo), ...signIn]) {
		expect(existsSync(join(here, "../public/assets", logo))).toBe(true);
	}
});

it("ignores unrelated hashes and unknown connectors when taking a return", () => {
	history.replaceState(null, "", `#/c/${id(5)}/chat/${id(6)}`);
	expect(takeConnectorReturn()).toBeUndefined();
	expect(location.hash).toBe(`#/c/${id(5)}/chat/${id(6)}`);
	history.replaceState(null, "", "#/?connector=slack&connection=confirm");
	expect(takeConnectorReturn()).toBeUndefined();
});

describe("connector client", () => {
	const profile = { profileId: id(10), environmentId: id(11) };
	const origin = "https://company41-node-01.tailbb15c7.ts.net:10000";
	function cloudWith(rpc: (name: string, args: Record<string, unknown>) => unknown) {
		return {
			rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)),
		} as unknown as Cloud & {
			rpc: ReturnType<typeof vi.fn>;
		};
	}
	const ticket = {
		schema: "qorpera.cloud-secret-capture/v1",
		ticketId: id(20),
		captureCapability: "c".repeat(43),
		serviceOrigin: origin,
		expiresAt: timestamp,
		scope: { companyId: id(10) },
	};

	it("opens a company-owned ticket and starts the sign-in at the company's broker behind the shared origin", async () => {
		const cloud = cloudWith(() => ticket);
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				schema: "qorpera.cloud-connector-oauth-started/v1",
				connectorId: "gmail",
				authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${id(10)}.abc`,
				expiresAt: timestamp,
			}),
		);
		const url = await createWebConnectors(cloud, profile, fetch).beginSignIn("gmail", undefined);
		expect(url).toContain("https://accounts.google.com/");
		expect(cloud.rpc).toHaveBeenCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({ p_owner_kind: "company", p_owner_user_id: null, p_connector_id: "gmail" }),
		);
		expect(fetch.mock.calls[0]![0]).toBe(`${origin}/v1/oauth/${id(20)}/start?company=${id(10)}`);
		expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
		// Only the proof's hash leaves with the start; the proof stays in this tab.
		const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, string>;
		expect(body.schema).toBe("qorpera.cloud-connector-oauth-start/v2");
		const kept = JSON.parse(sessionStorage.getItem("qorpera.connector-sign-in.v1") ?? "{}") as Record<string, string>;
		expect(kept).toMatchObject({ ticketId: id(20), connectorId: "gmail", companyId: id(10), serviceOrigin: origin });
		expect(kept.browserProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kept.browserProof)));
		expect(body.browserProofSha256).toBe([...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
		expect(JSON.stringify(body)).not.toContain(kept.browserProof);
	});

	it("starts the company's bank with the bank the member picked, and only the bank with one", async () => {
		const cloud = cloudWith(() => ticket);
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				schema: "qorpera.cloud-connector-oauth-started/v1",
				connectorId: "bank",
				authorizationUrl: "https://tilisy.enablebanking.com/ais/start?sessionid=abc",
				expiresAt: timestamp,
			}),
		);
		const connectors = createWebConnectors(cloud, profile, fetch);
		const bank = { name: "Danske Bank", country: "DK", psuType: "business" as const };
		const url = await connectors.beginSignIn("bank", id(30), undefined, bank);
		expect(url).toBe("https://tilisy.enablebanking.com/ais/start?sessionid=abc");
		expect(cloud.rpc).toHaveBeenCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({
				p_owner_kind: "company",
				p_connector_id: "bank",
				p_purpose: "Company bank",
				p_existing_secret_id: id(30),
			}),
		);
		const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({ schema: "qorpera.cloud-connector-oauth-start/v2", bank });
		const kept = JSON.parse(sessionStorage.getItem("qorpera.connector-sign-in.v1") ?? "{}") as Record<string, string>;
		expect(kept.connectorId).toBe("bank");
		// A bank start names its bank; no other connector's does.
		await expect(connectors.beginSignIn("bank", undefined)).rejects.toThrow("Invalid bank sign-in.");
		await expect(connectors.beginSignIn("gmail", undefined, undefined, bank)).rejects.toThrow(
			"Invalid bank sign-in.",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		// The bank's sign-in comes back like any other, for the Bank page to finish.
		history.replaceState(
			null,
			"",
			`#/c/${id(10)}/i/bank?connector=bank&connection=confirm&confirmation=${CONFIRMATION}`,
		);
		expect(takeConnectorReturn()).toMatchObject({ connector: "bank", connection: "confirm" });
		expect(location.hash).toBe(`#/c/${id(10)}/i/bank`);
	});

	it("returns to the page the sign-in was started on, even when the member moved on meanwhile", async () => {
		history.replaceState(null, "", `#/c/${id(10)}/i/bank`);
		const cloud = cloudWith(() => {
			// The member moves to another page while the ticket is issued.
			history.replaceState(null, "", `#/c/${id(10)}/i/members`);
			return ticket;
		});
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				schema: "qorpera.cloud-connector-oauth-started/v1",
				connectorId: "bank",
				authorizationUrl: "https://tilisy.enablebanking.com/ais/start?sessionid=abc",
				expiresAt: timestamp,
			}),
		);
		await createWebConnectors(cloud, profile, fetch).beginSignIn("bank", undefined, undefined, {
			name: "Danske Bank",
			country: "DK",
			psuType: "business",
		});
		const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;
		expect(body.returnTo).toBe(`${location.origin}/#/c/${id(10)}/i/bank`);
	});

	it("finishes the sign-in with this tab's proof once and forgets it", async () => {
		startedHere("gmail");
		history.replaceState(null, "", `#/?connector=gmail&connection=confirm&confirmation=${CONFIRMATION}`);
		const outcome = takeConnectorReturn();
		expect(outcome).toBeDefined();
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				schema: "qorpera.cloud-connector-oauth-confirmed/v1",
				connectorId: "gmail",
				accountLabel: "anna@example.com",
			}),
		);
		const connectors = createWebConnectors(
			cloudWith(() => null),
			profile,
			fetch,
		);
		await expect(connectors.finishSignIn(outcome!)).resolves.toBe("anna@example.com");
		expect(fetch.mock.calls[0]![0]).toBe(`${origin}/v1/oauth/${id(20)}/confirm?company=${id(10)}`);
		expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
			schema: "qorpera.cloud-connector-oauth-confirm/v1",
			confirmation: CONFIRMATION,
			browserProof: "p".repeat(43),
		});
		expect(sessionStorage.getItem("qorpera.connector-sign-in.v1")).toBeNull();
		// A refusal carries the broker's reason.
		const refused = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json(
				{ schema: "qorpera.cloud-connector-oauth-failed/v1", reason: "browser_mismatch" },
				{ status: 403 },
			),
		);
		await expect(
			createWebConnectors(
				cloudWith(() => null),
				profile,
				refused,
			).finishSignIn(outcome!),
		).rejects.toMatchObject({ reason: "browser_mismatch" });
		// Another company's page never finishes this company's sign-in.
		await expect(
			createWebConnectors(
				cloudWith(() => null),
				{ profileId: id(12), environmentId: id(11) },
				fetch,
			).finishSignIn(outcome!),
		).rejects.toThrow("cannot be finished here");
	});

	it("captures a typed GitHub token at the company's broker with the company in the query", async () => {
		const cloud = cloudWith(() => ticket);
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
		const connectors = createWebConnectors(cloud, profile, fetch);
		await connectors.captureToken("github", " github_pat_value ", undefined);
		expect(cloud.rpc).toHaveBeenCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({ p_owner_kind: "company", p_owner_user_id: null, p_connector_id: "github" }),
		);
		expect(fetch.mock.calls[0]![0]).toBe(`${origin}/v1/captures/${id(20)}?company=${id(10)}`);
		expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
			schema: "qorpera.cloud-secret-capture-request/v1",
			fields: { access_token: "github_pat_value" },
		});
		await expect(connectors.captureToken("github", "bad token", undefined)).rejects.toThrow(
			"That does not look like a token.",
		);
		await expect(connectors.captureToken("gmail", "ya29.token", undefined)).rejects.toThrow(
			"This service only connects by signing in.",
		);
		expect(cloud.rpc).toHaveBeenCalledTimes(1);
	});

	it("refuses a ticket whose id is not a UUID before any request leaves", async () => {
		const cloud = cloudWith(() => ({ ...ticket, ticketId: "../../v1/operations" }));
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(createWebConnectors(cloud, profile, fetch).beginSignIn("gmail", undefined)).rejects.toThrow(
			"Invalid capture ticket.",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
