// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteConnectorReturn, type ServicesAccess, ServicesView } from "../src/app/views/settings-services.ts";
import type { Cloud } from "../src/cloud/client.ts";
import {
	createWebConnectors,
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
	vi.restoreAllMocks();
});

const admin: ServicesAccess = {
	canManage: () => true,
	memberName: (userId) => (userId === id(1) ? "Anna Owner" : undefined),
};

function setup(
	connections: HostedConnectorConnection[] = [],
	navigate = vi.fn<(url: string) => void>(),
	access: ServicesAccess = admin,
) {
	const state = { connections: structuredClone(connections) };
	const client: Pick<WebConnectors, "list" | "beginSignIn" | "captureToken" | "grantAllAgents" | "disconnect"> = {
		list: vi.fn(async () => structuredClone(state.connections)),
		beginSignIn: vi.fn(async () => "https://accounts.google.com/o/oauth2/v2/auth?state=abc"),
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
		expect(buttons(gmailCard).map((button) => button.textContent)).toEqual(["Reconnect", "Disconnect"]);
		expect(buttons(driveCard).map((button) => button.textContent)).toEqual(["Connect"]);
		expect(buttons(githubCard).map((button) => button.textContent)).toEqual([
			"Connect",
			"Use a personal access token instead",
		]);
		expect(view?.el.querySelector('input[type="password"]')).toBeNull();
	});

	it("starts a provider sign-in and leaves for the consent page", async () => {
		const { client, navigate } = setup();
		await settle();
		buttons(card(1))[0]!.click();
		await settle();
		expect(client.beginSignIn).toHaveBeenCalledWith("google_drive", undefined, expect.any(AbortSignal));
		expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
	});

	it("reconnecting rotates the existing connection instead of creating a second one", async () => {
		const { client } = setup([gmail]);
		await settle();
		buttons(card(0))[0]!.click();
		await settle();
		expect(client.beginSignIn).toHaveBeenCalledWith("gmail", gmail.secretId, expect.any(AbortSignal));
	});

	it("shows the outcome a sign-in returned in the page hash and shares a fresh connection with all agents", async () => {
		history.replaceState(null, "", `#/c/${id(5)}/home?connector=github&connection=connected`);
		noteConnectorReturn(takeConnectorReturn());
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
		expect(client.grantAllAgents).toHaveBeenCalledWith(id(93), expect.any(AbortSignal));
		const githubCard = card(2);
		expect(githubCard.textContent).toContain(
			"GitHub is connected. The company's agents can use it from their next run.",
		);
		expect(githubCard.textContent).toContain("Connected as octocat");
		expect(githubCard.textContent).toContain("Available to every agent in the company");
	});

	it("explains a declined sign-in and does not touch grants", async () => {
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
		const disconnect = buttons(card(0))[1]!;
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
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Reconnect", "Disconnect"]);
	});

	it("offers to share a company connection that is not yet available to every agent", async () => {
		const { client } = setup([{ ...gmail, availableToAllAgents: false, activeGrantCount: 0 }]);
		await settle();
		expect(card(0).textContent).toContain("Not yet available to the company's agents.");
		const share = buttons(card(0)).find((button) => button.textContent === "Share with all agents");
		expect(share).toBeDefined();
		share!.click();
		await settle();
		expect(client.grantAllAgents).toHaveBeenCalledWith(gmail.secretId, expect.any(AbortSignal));
		expect(card(0).textContent).toContain("Available to every agent in the company");
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Reconnect", "Disconnect"]);
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
		history.replaceState(null, "", "#/?connector=slack&connection=connected");
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
