// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteConnectorReturn, type ServicesAccess, ServicesView } from "../src/app/views/settings-services.ts";
import { type HostedConnectorConnection, takeConnectorReturn, type WebConnectors } from "../src/cloud/connectors.ts";
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
const buttons = (cardEl: HTMLElement) => [...cardEl.querySelectorAll<HTMLButtonElement>("button")];

describe("services", () => {
	it("lists Gmail, Google Drive and GitHub with Connect, showing a connected account by its label", async () => {
		setup([gmail]);
		await settle();
		expect(cards().map((item) => item.dataset.connector)).toEqual(["gmail", "google_drive", "github"]);
		const [gmailCard, driveCard, githubCard] = [card(0), card(1), card(2)];
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

	it("shows each service's own logo", async () => {
		setup();
		await settle();
		const logos = cards().map((item) =>
			item.querySelector<HTMLImageElement>(".connection-logo")?.getAttribute("src"),
		);
		expect(logos).toEqual([
			"./assets/provider-gmail.svg",
			"./assets/provider-drive.svg",
			"./assets/provider-github.svg",
		]);
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

	it("grants all agents once team permissions arrive after a cold sign-in return", async () => {
		startedHere("github");
		history.replaceState(
			null,
			"",
			`#/c/${id(5)}/home?connector=github&connection=confirm&confirmation=${CONFIRMATION}`,
		);
		noteConnectorReturn(takeConnectorReturn());
		const fresh = {
			...gmail,
			secretId: id(93),
			connectorId: "github",
			accountLabel: "octocat",
			availableToAllAgents: false,
			activeGrantCount: 0,
		};
		let teamLoaded = false;
		const { client } = setup([fresh], undefined, {
			canManage: () => teamLoaded,
			memberName: (userId) => (teamLoaded && userId === id(1) ? "Anna Owner" : undefined),
		});
		await settle();
		expect(client.finishSignIn).toHaveBeenCalledOnce();
		expect(client.grantAllAgents).not.toHaveBeenCalled();
		teamLoaded = true;
		view?.update();
		await settle();
		expect(client.grantAllAgents).toHaveBeenCalledWith(id(93), expect.any(AbortSignal));
		expect(card(2).textContent).toContain("Connected as octocat by Anna Owner");
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

	it("says the company's services could not be read when the list fails", async () => {
		setup([], undefined, admin, (mock) => vi.mocked(mock.list).mockRejectedValue(new Error("offline")));
		await settle();
		expect(view?.el.querySelector(".service-error")?.textContent).toBe("The company's services could not be read.");
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

	it("validates a typed GitHub token locally before calling the broker, then captures and shares a valid one", async () => {
		const { client } = setup();
		await settle();
		const githubCard = card(2);
		buttons(githubCard)[1]!.click();
		const field = view?.el.querySelector<HTMLInputElement>('input[type="password"]');
		expect(field).not.toBeNull();
		expect(document.activeElement).toBe(field);
		field!.value = "not a token";
		[...card(2).querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Save token")!
			.click();
		await settle();
		expect(client.captureToken).not.toHaveBeenCalled();
		expect(card(2).querySelector(".service-outcome.is-error")?.textContent).toBe("That does not look like a token.");
		const retryField = card(2).querySelector<HTMLInputElement>('input[type="password"]')!;
		retryField.value = " github_pat_example_token_value ";
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

	it("shows company services read-only to members who are not owners or admins and updates attribution when team loads", async () => {
		const role = { manage: false, named: false };
		const { client } = setup([gmail], undefined, {
			canManage: () => role.manage,
			memberName: (userId) => (role.named && userId === id(1) ? "Anna Owner" : undefined),
		});
		await settle();
		expect(view?.el.textContent).toContain("Only founders and admins can connect or disconnect them.");
		for (const item of cards()) expect(buttons(item)).toEqual([]);
		expect(card(0).textContent).toContain("Connected as anna@example.com");
		expect(card(0).textContent).not.toContain("Anna Owner");
		expect(client.grantAllAgents).not.toHaveBeenCalled();
		role.named = true;
		view?.update();
		expect(card(0).textContent).toContain("Connected as anna@example.com by Anna Owner");
		role.manage = true;
		view?.update();
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Disconnect"]);
		expect(view?.el.textContent).not.toContain("Only founders and admins");
	});

	it("never shows a member's own secret as the company's connection", async () => {
		setup([{ ...gmail, ownerKind: "member", ownerUserId: id(2), connectedByUserId: null }]);
		await settle();
		expect(buttons(card(0)).map((button) => button.textContent)).toEqual(["Connect"]);
		expect(card(0).textContent).not.toContain("anna@example.com");
	});
});
