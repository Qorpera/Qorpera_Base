// @vitest-environment jsdom
import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSubscriptionsView } from "../src/app/views/settings-ai-subscriptions.ts";
import { ProviderSignIns } from "../src/app/views/settings-connections.ts";
import type {
	WebAccountLogin,
	WebAccountLogins,
	WebNativeProviderLoginInput,
	WebNativeSubscription,
} from "../src/cloud/native-subscription.ts";
import type { HostedProfile } from "../src/cloud/types.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { id, profileA, profileB, settle, timestamp, userA } from "./fixtures.ts";

const WATCH_MS = 2000;
/** The member's account login, linked into Company B as connection 81 (20260930548000). */
const login: WebAccountLogin = {
	loginId: id(90),
	status: "active",
	providerAccountEmail: "member@example.com",
	companies: 2,
	connectionIds: [id(81)],
};
const linked: NativeMemberConnection = {
	connectionId: id(81),
	clientConnectionId: id(181),
	connectionVersion: 1,
	provider: "openai",
	nativeHarness: "codex-cli",
	authorizationState: "active",
	maxNativeConcurrency: 1,
	providerAccountReference: "codex-cli:opaque-account",
	providerAccountEmail: "member@example.com",
	billingSource: "member",
	consentVersion: "v1",
	consentedAt: timestamp,
	connectionStatus: "active",
	policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 3 },
	sponsorBindingId: id(82),
	sponsorVersion: 1,
	providerAccountUsage: {
		observedAt: new Date().toISOString(),
		windows: [{ id: "primary", label: "5-hour limit", usedPercent: 25 }],
	},
};
/** Company B's own login of the member, not an account login: never shown, enabled or changed from here. */
const companyLogin: NativeMemberConnection = {
	...linked,
	connectionId: id(83),
	clientConnectionId: id(183),
	providerAccountEmail: "other@example.com",
	sponsorBindingId: undefined,
	sponsorVersion: undefined,
};
function observed(...items: NativeMemberConnection[]): NativeExecutionConnections {
	return {
		computeIdentity: {
			computeIdentityId: id(80),
			ownershipKind: "member",
			ownerUserId: userA.id,
			displayName: "My computer",
			templateKey: "member",
			templateVersion: "v1",
			capabilities: ["agent_turn"],
			policy: {},
			status: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		connections: items,
	};
}

/** One company's client: whether its sign-ins are account sign-ins, the account logins and its connections. */
function company(enabled: boolean, logins: WebAccountLogin[] = [login], connections = observed(linked, companyLogin)) {
	const state = { enabled, logins, connections };
	const client = {
		state,
		onboardingAvailable: true,
		listAccountLogins: vi.fn(
			async (): Promise<WebAccountLogins> => structuredClone({ enabled, logins: state.logins }),
		),
		listConnections: vi.fn(async () => structuredClone(state.connections)),
		revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
		createMemberSponsor: vi.fn(async () => ({ bindingId: id(84), version: 1 })),
		signOutEverywhere: vi.fn(async () => undefined),
	};
	const begin = vi.fn(async (input: WebNativeProviderLoginInput) => ({
		loginId: input.clientLoginId,
		clientConnectionId: input.clientConnectionId,
		status: "awaiting_member" as const,
		interactionUrl: "https://auth.openai.com/device",
		userCode: "ABCD-EFGH",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	}));
	return { client, begin, signIns: new ProviderSignIns() };
}

let view: AccountSubscriptionsView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function setup(companies: Map<HostedProfile, ReturnType<typeof company>>) {
	const lifetime = new AbortController();
	const opened: string[] = [];
	view = new AccountSubscriptionsView(
		[...companies.keys()],
		(profile) => {
			opened.push(profile.profileId);
			const found = companies.get(profile)!;
			return {
				client: found.client as unknown as WebNativeSubscription,
				signIns: found.signIns,
				begin: found.begin,
			};
		},
		lifetime.signal,
	);
	document.body.append(view.el);
	await settle();
	await settle();
	return { opened, lifetime };
}
const cards = () => [...view!.el.querySelectorAll<HTMLElement>(".connection-card")];
const buttons = (card: HTMLElement) => [...card.querySelectorAll("button")].map((button) => button.textContent);
const add = () => view!.el.querySelector<HTMLButtonElement>(".connection-add")!;

describe("AI subscriptions with no company open", () => {
	it("reads through the first company by id whose sign-ins are account sign-ins, and shows only account logins", async () => {
		const a = company(false),
			b = company(true);
		// Listed B first: the order is the companies' ids, A before B.
		const { opened } = await setup(
			new Map([
				[profileB, b],
				[profileA, a],
			]),
		);
		expect(opened).toEqual([profileA.profileId, profileB.profileId]);
		expect(a.client.listConnections).not.toHaveBeenCalled();
		expect(b.client.listConnections).toHaveBeenCalled();
		expect(cards()).toHaveLength(1);
		const card = cards()[0]!;
		expect(card.dataset.loginId).toBe(id(90));
		expect(card.textContent).toContain("member@example.com");
		expect(card.textContent).toContain("Used in all your companies");
		// Usage is read through Company B's link; "Stop using here" needs an open company.
		expect(card.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("75");
		expect(buttons(card)).toEqual(["Sign out everywhere"]);
		expect(view!.el.textContent).not.toContain("other@example.com");
		expect(view!.el.querySelector(".connection-note")?.textContent).toBe(
			"A ChatGPT subscription you add here is used in all your companies.",
		);
		// Company B's own login is not enabled from here.
		expect(b.client.createMemberSponsor).not.toHaveBeenCalled();
	});

	it("shows a login Company B does not use, without usage", async () => {
		const b = company(true, [{ ...login, connectionIds: [] }], observed());
		await setup(new Map([[profileB, b]]));
		expect(cards()).toHaveLength(1);
		expect(cards()[0]!.textContent).toContain("Usage unavailable");
		expect(buttons(cards()[0]!)).toEqual(["Sign out everywhere"]);
	});

	it("adds a ChatGPT subscription at once, with no provider picker, and lists it once signed in", async () => {
		vi.useFakeTimers();
		const b = company(true, [], observed());
		await setup(new Map([[profileB, b]]));
		expect(view!.el.textContent).toContain("No model accounts connected.");
		expect(add().textContent).toBe("Add ChatGPT subscription");
		expect(view!.el.querySelector(".connection-provider-picker")).toBeNull();
		add().click();
		await settle();
		expect(b.begin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "openai" }));
		expect(view!.el.querySelector(".connection-attempt")?.textContent).toContain("Open OpenAI sign-in");
		expect(add().disabled).toBe(true);
		// The vault completes it as an account login, linked into Company B with the sign-in's own connection id.
		const clientConnectionId = b.begin.mock.calls[0]![0].clientConnectionId;
		b.client.state.connections = observed({ ...linked, clientConnectionId });
		b.client.state.logins = [login];
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		await settle();
		expect(view!.el.querySelector(".connection-attempt")).toBeNull();
		expect(cards().map((card) => card.dataset.loginId)).toEqual([id(90)]);
		expect(view!.el.querySelector('[role="status"]')?.textContent ?? "").not.toContain("only");
	});

	it("says so when a sign-in was kept for its company only", async () => {
		vi.useFakeTimers();
		const b = company(true, [], observed());
		await setup(new Map([[profileB, b]]));
		add().click();
		await settle();
		const clientConnectionId = b.begin.mock.calls[0]![0].clientConnectionId;
		b.client.state.connections = observed({ ...companyLogin, clientConnectionId });
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		await settle();
		expect(cards()).toHaveLength(0);
		expect(view!.el.textContent).toContain(
			"This subscription was added to Company B only. Open that company to see it.",
		);
	});

	it("signs out everywhere and reads the logins again", async () => {
		const b = company(true);
		await setup(new Map([[profileB, b]]));
		const reads = b.client.listAccountLogins.mock.calls.length;
		b.client.state.logins = [];
		cards()[0]!.querySelector("button")!.click();
		await settle();
		expect(b.client.signOutEverywhere).toHaveBeenCalledExactlyOnceWith(id(90), expect.any(AbortSignal));
		expect(b.client.revokeConnection).not.toHaveBeenCalled();
		expect(b.client.listAccountLogins.mock.calls.length).toBeGreaterThan(reads);
		expect(cards()).toHaveLength(0);
	});

	it("asks to create or join a company first when the member has none", async () => {
		await setup(new Map());
		expect(view!.el.textContent).toBe(
			"Create or join a company first. Then you can add a ChatGPT subscription here.",
		);
		expect(view!.el.querySelector(".connection-add")).toBeNull();
	});

	it("says so when none of the member's companies shares a subscription", async () => {
		const a = company(false),
			b = company(false);
		await setup(
			new Map([
				[profileA, a],
				[profileB, b],
			]),
		);
		expect(view!.el.textContent).toBe(
			"Your companies can't share an AI subscription yet. Open a company to add one there.",
		);
		expect(a.client.listConnections).not.toHaveBeenCalled();
		expect(b.client.listConnections).not.toHaveBeenCalled();
	});

	it("says when the companies could not be read, and tries again", async () => {
		const a = company(true),
			b = company(false);
		a.client.listAccountLogins.mockRejectedValueOnce(new Error("offline"));
		await setup(
			new Map([
				[profileA, a],
				[profileB, b],
			]),
		);
		expect(view!.el.textContent).toContain("Your AI subscriptions could not be read.");
		[...view!.el.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
		await settle();
		await settle();
		expect(cards().map((card) => card.dataset.loginId)).toEqual([id(90)]);
		expect(a.client.listConnections).toHaveBeenCalled();
	});

	it("stops reading when Settings close", async () => {
		const b = company(true);
		const { lifetime } = await setup(new Map([[profileB, b]]));
		lifetime.abort();
		expect(view!.el.isConnected).toBe(false);
	});

	it("speaks Danish", async () => {
		setLanguagePreference("da");
		try {
			const b = company(true);
			await setup(new Map([[profileB, b]]));
			expect(add().textContent).toBe("Tilføj ChatGPT-abonnement");
			expect(buttons(cards()[0]!)).toEqual(["Log ud overalt"]);
			expect(view!.el.querySelector(".connection-note")?.textContent).toBe(
				"Et ChatGPT-abonnement, du tilføjer her, bruges i alle dine virksomheder.",
			);
		} finally {
			setLanguagePreference("en");
		}
	});
});
