// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteConnectorReturn, type ServicesAccess, ServicesView } from "../src/app/views/settings-services.ts";
import type { Cloud } from "../src/cloud/client.ts";
import {
	createWebConnectors,
	HOSTED_CONNECTORS,
	type HostedConnectorConnection,
	takeConnectorReturn,
	type WebConnectors,
} from "../src/cloud/connectors.ts";
import { id, settle, timestamp } from "./fixtures.ts";

const gmail: HostedConnectorConnection = {
	secretId: id(91),
	version: 1,
	connectorId: "gmail",
	secretName: "primary",
	purpose: "Gmail account",
	ownerKind: "company",
	ownerUserId: null,
	status: "active",
	accountLabel: "anna@example.com",
	connectedByUserId: id(1),
	availableToAllAgents: true,
	activeGrantCount: 8,
	createdAt: timestamp,
	updatedAt: timestamp,
};

let view: ServicesView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	noteConnectorReturn(undefined);
	history.replaceState(null, "", "#/");
	sessionStorage.clear();
	vi.restoreAllMocks();
});

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

type ServicesClientMock = Pick<
	WebConnectors,
	"list" | "beginSignIn" | "finishSignIn" | "captureToken" | "grantAllAgents" | "disconnect"
>;

const admin: ServicesAccess = {
	canManage: () => true,
	memberName: (userId) => (userId === id(1) ? "Anna Owner" : undefined),
};

function setup(
	connections: HostedConnectorConnection[] = [],
	navigate = vi.fn<(url: string) => void>(),
	access: ServicesAccess = admin,
	configure?: (client: ServicesClientMock) => void,
) {
	const state = { connections: structuredClone(connections) };
	const client: ServicesClientMock = {
		list: vi.fn(async () => structuredClone(state.connections)),
		beginSignIn: vi.fn(async () => "https://accounts.google.com/o/oauth2/v2/auth?state=abc"),
		finishSignIn: vi.fn(async () => "octocat"),
		captureToken: vi.fn(async () => {
			state.connections.push({
				...gmail,
				secretId: id(92),
				connectorId: "github",
				accountLabel: null,
				availableToAllAgents: false,
				activeGrantCount: 0,
			});
		}),
		grantAllAgents: vi.fn(async (secretId: string) => {
			for (const item of state.connections)
				if (item.secretId === secretId) Object.assign(item, { availableToAllAgents: true, activeGrantCount: 7 });
		}),
		disconnect: vi.fn(async (secretId: string) => {
			for (const item of state.connections) if (item.secretId === secretId) item.status = "revoked";
		}),
	};
	configure?.(client);
	view = new ServicesView(client, new AbortController().signal, { navigate, access });
	document.body.append(view.el);
	return { client, navigate, state };
}

const cards = () => [...(view?.el.querySelectorAll<HTMLElement>(".service-card") ?? [])];
const card = (index: number): HTMLElement => cards()[index]!;
const buttons = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>("button")];

describe("services", () => {
	it("lists Gmail, Google Drive and GitHub with Connect, showing a connected account by its label", async () => {
		setup([gmail]);
		await settle();
		expect(cards().map((card) => card.dataset.connector)).toEqual(["gmail", "google_drive", "github"]);
		const [gmailCard, driveCard, githubCard] = [card(0), card(1), card(2)];
		// The member who connected it is attribution only.
		expect(gmailCard.textContent).toContain("Connected as anna@example.com by Anna Owner");
		expect(gmailCard.textContent).toContain("Available to every agent in the company");
		expect(buttons(gmailCard).map((button) => button.textContent)).toEqual(["Disconnect"]);
		expect(buttons(driveCard).map((button) => button.textContent)).toEqual(["Connect"]);
		expect(buttons(githubCard).map((button) => button.textContent)).toEqual([
			"Connect",
			"Use a personal access token instead",
		]);
		expect(view?.el.querySelector('input[type="password"]')).toBeNull();
	});

	it("shows each service's own logo, and the build ships every one", async () => {
		setup();
		await settle();
		const logos = cards().map((card) =>
			card.querySelector<HTMLImageElement>(".connection-logo")?.getAttribute("src"),
		);
		expect(logos).toEqual([
			"./assets/provider-gmail.svg",
			"./assets/provider-google-drive.svg",
			"./assets/provider-github.svg",
		]);
		const build = readFileSync(resolve("scripts/build.mjs"), "utf8");
		for (const { logo } of HOSTED_CONNECTORS) {
			expect(build).toContain(`"${logo}"`);
			expect(existsSync(resolve("../shell/userland", logo))).toBe(true);
		}
	});

	it("starts a provider sign-in and leaves for the consent page", async () => {
		const { client, navigate } = setup();
		await settle();
		buttons(card(1))[0]!.click();
		await settle();
		expect(client.beginSignIn).toHaveBeenCalledWith("google_drive", undefined, expect.any(AbortSignal));
		expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
	});

	it("finishes a sign-in this tab started, then shares the fresh connection with all agents", async () => {
		startedHere("github");
		history.replaceState(
			null,
			"",
			`#/c/${id(5)}/home?connector=github&connection=confirm&confirmation=${CONFIRMATION}`,
		);
		const outcome = takeConnectorReturn();
		expect(outcome).toMatchObject({ connector: "github", connection: "confirm", confirmation: CONFIRMATION });
		noteConnectorReturn(outcome);
		expect(location.hash).toBe(`#/c/${id(5)}/home`);
		const fresh = {
			...gmail,
			secretId: id(93),
			connectorId: "github",
			accountLabel: "octocat",
			availableToAllAgents: false,
			activeGrantCount: 0,
		};
		const { client } = setup([fresh]);
		await settle();
		expect(client.finishSignIn).toHaveBeenCalledWith(outcome, expect.any(AbortSignal));
		expect(client.grantAllAgents).toHaveBeenCalledWith(id(93), expect.any(AbortSignal));
		const githubCard = card(2);
		expect(githubCard.textContent).toContain(
			"GitHub is connected. The company's agents can use it from their next run.",
		);
		expect(githubCard.textContent).toContain("Connected as octocat");
		expect(githubCard.textContent).toContain("Available to every agent in the company");
	});

	it("does nothing for a crafted return link when this tab started no sign-in", async () => {
		history.replaceState(
			null,
			"",
			`#/c/${id(5)}/home?connector=github&connection=confirm&confirmation=${CONFIRMATION}`,
		);
		const outcome = takeConnectorReturn();
		expect(outcome).toBeUndefined();
		expect(location.hash).toBe(`#/c/${id(5)}/home`);
		noteConnectorReturn(outcome);
		const fresh = {
			...gmail,
			secretId: id(93),
			connectorId: "github",
			availableToAllAgents: false,
			activeGrantCount: 0,
		};
		const { client } = setup([fresh]);
		await settle();
		expect(client.finishSignIn).not.toHaveBeenCalled();
		expect(client.grantAllAgents).not.toHaveBeenCalled();
		expect(view?.el.textContent).not.toContain("is connected");
		// A sign-in started for another service does not count either.
		startedHere("gmail");
		history.replaceState(null, "", `#/?connector=github&connection=confirm&confirmation=${CONFIRMATION}`);
		expect(takeConnectorReturn()).toBeUndefined();
	});

	it("reports a sign-in the broker refused to finish and does not share", async () => {
		startedHere("github");
		history.replaceState(null, "", `#/?connector=github&connection=confirm&confirmation=${CONFIRMATION}`);
		noteConnectorReturn(takeConnectorReturn());
		const { client } = setup([], undefined, admin, (mock) =>
			vi.mocked(mock.finishSignIn).mockRejectedValue(Object.assign(new Error("x"), { reason: "browser_mismatch" })),
		);
		await settle();
		expect(card(2).textContent).toContain("GitHub was not connected. The sign-in was finished in another browser.");
		expect(client.grantAllAgents).not.toHaveBeenCalled();
	});

	it("shows a connected company service as available to every agent with Disconnect as its only action", async () => {
		// Always shared, no toggle: a legacy row not marked for all agents, and a
		// share whose grants died with their issuer, read the same as a live one.
		// Viewing the page issues no grant; the backend repairs those rows.
		const { client } = setup([
			gmail,
			{ ...gmail, secretId: id(94), connectorId: "google_drive", availableToAllAgents: false, activeGrantCount: 0 },
			{ ...gmail, secretId: id(95), connectorId: "github", availableToAllAgents: true, activeGrantCount: 0 },
		]);
		await settle();
		for (const item of cards()) {
			expect(buttons(item).map((button) => button.textContent)).toEqual(["Disconnect"]);
			expect(item.textContent).toContain("Available to every agent in the company, including new hires.");
			expect(item.textContent).not.toContain("Not yet available");
		}
		expect(client.grantAllAgents).not.toHaveBeenCalled();
	});

	it("says how to retry when a fresh connection could not be given to the agents", async () => {
		startedHere("github");
		history.replaceState(null, "", `#/?connector=github&connection=confirm&confirmation=${CONFIRMATION}`);
		noteConnectorReturn(takeConnectorReturn());
		const fresh = {
			...gmail,
			secretId: id(93),
			connectorId: "github",
			availableToAllAgents: false,
			activeGrantCount: 0,
		};
		const { client } = setup([fresh], undefined, admin, (mock) =>
			vi.mocked(mock.grantAllAgents).mockRejectedValue(new Error("offline")),
		);
		await settle();
		expect(client.grantAllAgents).toHaveBeenCalledWith(id(93), expect.any(AbortSignal));
		const githubCard = card(2);
		expect(githubCard.querySelector(".service-outcome.is-error")?.textContent).toBe(
			"The account is connected, but the company's agents could not get it yet. Disconnect it and connect it again.",
		);
		expect(githubCard.textContent).not.toContain("can use it from their next run");
		expect(buttons(githubCard).map((button) => button.textContent)).toEqual(["Disconnect"]);
	});

	it("explains a declined sign-in and does not touch grants", async () => {
		startedHere("gmail");
		history.replaceState(null, "", "#/?connector=gmail&connection=failed&reason=declined");
		noteConnectorReturn(takeConnectorReturn());
		const { client } = setup();
		await settle();
		expect(card(0).textContent).toContain(
			"Gmail was not connected. The sign-in was cancelled before access was granted.",
		);
		expect(client.grantAllAgents).not.toHaveBeenCalled();
	});

	it("captures a typed GitHub token at the broker and then shares it with all agents", async () => {
		const { client } = setup();
		await settle();
		const githubCard = card(2);
		buttons(githubCard)[1]!.click();
		const field = view?.el.querySelector<HTMLInputElement>('input[type="password"]');
		expect(field).not.toBeNull();
		expect(document.activeElement).toBe(field);
		field!.value = " github_pat_example_token_value ";
		[...card(2).querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Save token")!
			.click();
		await settle();
		expect(client.captureToken).toHaveBeenCalledWith(
			"github",
			" github_pat_example_token_value ",
			undefined,
			expect.any(AbortSignal),
		);
		expect(client.grantAllAgents).toHaveBeenCalledWith(id(92), expect.any(AbortSignal));
		expect(card(2).textContent).toContain("GitHub is connected");
		expect(view?.el.querySelector('input[type="password"]')).toBeNull();
	});

	it("disconnects and re-reads, restoring focus to the card", async () => {
		const { client } = setup([gmail]);
		await settle();
		const disconnect = buttons(card(0)).find((button) => button.textContent === "Disconnect")!;
		disconnect.focus();
		disconnect.click();
		await settle();
		expect(client.disconnect).toHaveBeenCalledWith(gmail.secretId, expect.any(AbortSignal));
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Connect"]);
	});

	it("shows company services read-only to members who are not owners or admins", async () => {
		const role = { manage: false };
		const { client } = setup([gmail], undefined, { ...admin, canManage: () => role.manage });
		await settle();
		expect(view?.el.textContent).toContain("Connected for the company by an owner or admin");
		for (const item of cards()) expect(buttons(item)).toEqual([]);
		expect(card(0).textContent).toContain("Connected as anna@example.com by Anna Owner");
		// A sign-in outcome never shares on a non-admin's behalf.
		expect(client.grantAllAgents).not.toHaveBeenCalled();
		// The role arrives (or changes) after the page: it redraws with the actions.
		role.manage = true;
		view?.update();
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Disconnect"]);
	});

	it("never shows a member's own secret as the company's connection", async () => {
		setup([{ ...gmail, ownerKind: "member", ownerUserId: id(2), connectedByUserId: null }]);
		await settle();
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Connect"]);
		expect(card(0).textContent).not.toContain("anna@example.com");
	});

	it("ignores unrelated hashes and unknown connectors when taking a return", () => {
		history.replaceState(null, "", `#/c/${id(5)}/chat/${id(6)}`);
		expect(takeConnectorReturn()).toBeUndefined();
		expect(location.hash).toBe(`#/c/${id(5)}/chat/${id(6)}`);
		history.replaceState(null, "", "#/?connector=slack&connection=confirm");
		expect(takeConnectorReturn()).toBeUndefined();
	});
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
		await createWebConnectors(cloud, profile, fetch).captureToken("github", "github_pat_value", undefined);
		expect(cloud.rpc).toHaveBeenCalledWith(
			"qorpera_begin_cloud_secret_capture",
			expect.objectContaining({ p_owner_kind: "company", p_owner_user_id: null, p_connector_id: "github" }),
		);
		expect(fetch.mock.calls[0]![0]).toBe(`${origin}/v1/captures/${id(20)}?company=${id(10)}`);
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
