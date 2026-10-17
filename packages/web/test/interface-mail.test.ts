// @vitest-environment jsdom

import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { MAILBOX_INTERFACE } from "@qorpera/cloud-client/interface-library";
import { type InterfaceFile, parseInterfaceFile } from "@qorpera/cloud-client/interfaces";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { CompanyMail } from "../src/app/company-mail.ts";
import { interfaceBadge } from "../src/app/interface-badge.ts";
import type { InterfacePagesState } from "../src/app/interface-pages.ts";
import { companyInterfaces } from "../src/app/interfaces.ts";
import type { Route } from "../src/app/router.ts";
import { renderInterface, renderInterfaceFile } from "../src/app/views/interface.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedProfileRole, HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* Interfaces step I5c (RUNTIME-INTERFACES.md §3.2 `mail`, §4, §10): the Mailbox page the web ships, switched on (C6a),
 * drawn from the member mail read (cloud/mail.ts). The read here is a fake of its five calls on the fixture's cloud. A
 * test of an edited Mailbox draws the edited definition directly: no company can show it, but its blocks draw mail. */

const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
const bo: HostedStaffAgent = { ...staff, id: id(42), displayName: "Bo" };

/** A thread id: 43 characters, as the cloud gives them. */
const thread = (n: number) => `thread-${String(n).padStart(36, "0")}`;
/** `n` minutes before nine, so a smaller `n` is newer. */
const at = (n: number) => new Date(Date.parse("2026-10-06T09:00:00Z") - n * 60_000).toISOString();
/** `days` days before now, as the cloud writes a time: to the microsecond, with an offset. */
const cloudTime = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".123456+00:00");

const ADDRESS = {
	address: "hello@acme.example",
	status: "active",
	handledBy: [{ staffAgentId: ada.id, name: "Ada" }],
	routines: [{ routineId: id(801), title: "Morning mail", staffAgentId: ada.id }],
	last7Days: 12,
};

/** A thread as the threads call lists it. */
function summary(n: number, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		thread: thread(n),
		address: ADDRESS.address,
		fromName: `Sender ${n}`,
		fromAddress: `sender${n}@outside.example`,
		subject: `Subject ${n}`,
		lastAt: at(n),
		state: "new",
		handledBy: { staffAgentId: ada.id, name: "Ada" },
		direction: "received",
		unread: false,
		messages: 1,
		...more,
	};
}

/** A received message as the thread call gives it. */
function received(n: number, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "received",
		deliveryId: `delivery-${n}`,
		fromName: `Sender ${n}`,
		fromAddress: `sender${n}@outside.example`,
		to: [ADDRESS.address],
		subject: `Subject ${n}`,
		text: `Hello from sender ${n}.`,
		receivedAt: at(n),
		attachments: [],
		...more,
	};
}

/** A send that waits for a person, in a thread. */
function waitingSend(reviewId: string, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		reviewId,
		sessionId: session.sessionId,
		staffAgent: { staffAgentId: ada.id, name: "Ada" },
		to: ["sender1@outside.example"],
		subject: "Re: Subject 1",
		text: "Paid today.",
		attachments: [],
		createdAt: at(0),
		...more,
	};
}

interface MailFake {
	addresses: Record<string, unknown>[];
	waiting: Record<string, unknown>[];
	/** Newest first. */
	threads: Record<string, unknown>[];
	/** What the thread call answers, by thread id (an older page by `<thread> before <id>`); a thread not here has one
	 * message. */
	reads: Record<string, Record<string, unknown>>;
	/** Threads the call refuses with 22023. */
	gone: Set<string>;
	calls: { fn: string; args: Record<string, unknown> }[];
}

const older = (item: Record<string, unknown>, before: { lastAt: string; thread: string }) =>
	String(item.lastAt) < before.lastAt || (item.lastAt === before.lastAt && String(item.thread) < before.thread);

/** The member mail read on the fixture's cloud. */
function mailFake(f: ReturnType<typeof fixture>): MailFake {
	const fake: MailFake = { addresses: [], waiting: [], threads: [], reads: {}, gone: new Set(), calls: [] };
	(f.cloud.rpc as unknown as Mock).mockImplementation(async (fn: string, args: Record<string, unknown>) => {
		fake.calls.push({ fn, args });
		if (fn === "qorpera_member_mail_addresses") return fake.addresses;
		if (fn === "qorpera_member_mail_waiting") return fake.waiting;
		if (fn === "qorpera_member_mail_threads") {
			const request = args.p_request as {
				state?: string;
				address?: string;
				direction?: string;
				before?: { lastAt: string; thread: string };
				limit: number;
			};
			const { before } = request;
			const rows = fake.threads.filter(
				(item) =>
					(request.state === undefined || item.state === request.state) &&
					(request.address === undefined || item.address === request.address) &&
					(request.direction === undefined || item.direction === request.direction) &&
					(before === undefined || older(item, before)),
			);
			const page = rows.slice(0, request.limit);
			const last = page.at(-1);
			return {
				threads: page,
				nextBefore: rows.length > request.limit && last ? { lastAt: last.lastAt, thread: last.thread } : null,
			};
		}
		const threadId = String(args.p_thread);
		if (fake.gone.has(threadId))
			throw new CloudRpcError(fn, { message: "That is not a mail thread of this company.", code: "22023" }, 400);
		if (fn === "qorpera_member_mail_thread") {
			const n = Number(threadId.slice("thread-".length));
			const before = args.p_before as { id: string } | undefined;
			return (
				fake.reads[before ? `${threadId} before ${before.id}` : threadId] ?? {
					thread: threadId,
					address: ADDRESS.address,
					messages: [received(n)],
					more: false,
					waiting: [],
				}
			);
		}
		if (fn === "qorpera_mark_mail_thread_read") {
			for (const item of fake.threads) if (item.thread === threadId) item.unread = false;
			return true;
		}
		throw new Error(`Unexpected RPC ${fn}`);
	});
	return fake;
}

/** The member's one model account that can pay. */
const connections: NativeExecutionConnections = {
	computeIdentity: {
		computeIdentityId: id(882),
		ownershipKind: "member",
		ownerUserId: userA.id,
		displayName: "Member computer",
		templateKey: "member",
		templateVersion: "v1",
		capabilities: ["agent_turn"],
		policy: {},
		status: "active",
		createdAt: "2026-09-12T00:00:00Z",
		updatedAt: "2026-09-12T00:00:00Z",
	},
	connections: [
		{
			connectionId: id(880),
			clientConnectionId: id(883),
			connectionVersion: 1,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "member",
			consentVersion: "v1",
			consentedAt: "2026-09-12T00:00:00Z",
			connectionStatus: "active",
			sponsorBindingId: id(881),
			sponsorVersion: 1,
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 1 },
		},
	],
};

/** The member's model accounts as the cloud gives them: it chooses that account for every conversation. */
function accountsFake() {
	return {
		listConnections: vi.fn(async (_signal?: AbortSignal) => connections),
		selectSessionAccount: vi.fn(
			async (_sessionId: string, _signal?: AbortSignal): Promise<string | undefined> => id(880),
		),
	};
}

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	// The app is in front: the mail is read again on coming back to it and while it stays there.
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	sessionStorage.clear();
	location.hash = "";
	Reflect.deleteProperty(document, "visibilityState");
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The company's pages with the Mailbox on or off. */
const mailboxOn = (on: boolean): InterfacePagesState => ({
	pages: [
		{ page: "mailbox", on },
		{ page: "members", on: false },
	],
	mayChange: true,
});

function company(role: HostedProfileRole = "owner", activity: HostedStaffExecutionActivity[] = []) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	const me = { userId: userA.id, email: "a@example.invalid", displayName: "Account A", role, joinedAt: timestamp };
	controller.store.set({
		loading: false,
		staff: [cofounder, ada, bo],
		sessions: [session],
		team: { ...team, role, capabilities: { ...team.capabilities, write: role !== "viewer" }, members: [me] },
		activity,
		interfacePages: mailboxOn(true),
	});
	cleanup.push(() => controller.stop());
	return { f, controller };
}

/** The shipped Mailbox with `edit` applied. */
function edited(edit: (text: string) => string): InterfaceFile {
	const result = parseInterfaceFile(edit(MAILBOX_INTERFACE));
	if (!result.ok) throw new Error(JSON.stringify(result.problems));
	return result.file;
}

/** The company's mail, read as the app reads it. */
async function readMail(
	controller: CompanyController,
	f: ReturnType<typeof fixture>,
	accounts: ReturnType<typeof accountsFake> = accountsFake(),
) {
	const reader = new CompanyMail(controller, f.cloud, accounts, (state) => controller.store.set({ mail: state }));
	cleanup.push(() => reader.dispose());
	await reader.open();
	return reader;
}

/** The Mailbox on screen, drawn again on every change. `setup` fills the mail before it is read; `edit` changes the
 * page's definition. */
async function mailbox(
	setup: (fake: MailFake) => void,
	role: HostedProfileRole = "owner",
	edit?: (text: string) => string,
) {
	const { f, controller } = company(role);
	const fake = mailFake(f);
	fake.addresses = [ADDRESS];
	setup(fake);
	const accounts = accountsFake();
	await readMail(controller, f, accounts);
	const main = h("main");
	document.body.append(main);
	const file = edit && edited(edit);
	const draw = () =>
		file ? renderInterfaceFile(main, controller, "mailbox", file) : renderInterface(main, controller, "mailbox");
	cleanup.push(controller.store.subscribe(draw));
	// The page keeps its view and what is open for the company while the app runs: the next test starts on the Inbox,
	// with nothing open.
	cleanup.push(() => {
		button(main, "Back")?.click();
		view(main, "Inbox");
	});
	draw();
	return { f, controller, fake, main, accounts };
}

function rail(controller: CompanyController, f: ReturnType<typeof fixture>) {
	const element = h("aside", { class: "rail" });
	document.body.append(h("div", { class: "frame" }, element));
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const route: Route = { name: "company", profileId: profileA.profileId, section: "interface", id: "mailbox" };
	renderRail(element, controller, {
		profiles: [profileA],
		user: userA,
		route,
		auth,
		invitations: 0,
		openSettings: () => {},
		openFeedback: () => {},
		agentActions: {},
	});
	return element;
}

const names = (controller: CompanyController) => companyInterfaces(controller).map((entry) => entry.name);
const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const calls = (fake: MailFake, fn: string) => fake.calls.filter((call) => call.fn === fn).map((call) => call.args);
const rows = (main: HTMLElement) => [
	...main.querySelectorAll<HTMLButtonElement>(".interface-mail-list button.interface-item"),
];
const lines = (main: HTMLElement) => texts(main, ".interface-mail-list .interface-item-copy strong");
const view = (main: HTMLElement, name: string) =>
	[...main.querySelectorAll<HTMLButtonElement>(".interface-view")].find((tab) => tab.textContent === name)?.click();
const opened = () => document.querySelector<HTMLElement>(".interface-mail.is-open");
const button = (root: ParentNode, text: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);

describe("the mail need (§3 needs)", () => {
	it("lists the Mailbox only while the company has an address, and reads its addresses again on coming back", async () => {
		const { f, controller } = company();
		const fake = mailFake(f);
		await readMail(controller, f);
		expect(names(controller)).not.toContain("mailbox");
		fake.addresses = [ADDRESS];
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(names(controller)).toContain("mailbox"));
		// Switched off, it leaves the tab with its address still there (C6a).
		controller.store.set({ interfacePages: mailboxOn(false) });
		expect(names(controller)).toEqual([]);
		controller.store.set({ interfacePages: mailboxOn(true) });
		// A cloud without the member mail read has no mail: the need is off again.
		(f.cloud.rpc as unknown as Mock).mockRejectedValue(
			new CloudRpcError("qorpera_member_mail_addresses", { message: "missing", code: "PGRST202" }, 404),
		);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() => expect(names(controller)).not.toContain("mailbox"));
	});
});

describe("the Inbox list", () => {
	it("lists threads newest first, 50 at a time, and reads older ones on Show older", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = Array.from({ length: 55 }, (_, index) => summary(index + 1, { unread: index === 0 }));
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(50));
		expect(lines(main).slice(0, 2)).toEqual(["Sender 1", "Sender 2"]);
		expect(texts(main, ".interface-mail-list .interface-item-copy small").slice(0, 1)).toEqual(["Subject 1"]);
		// What came from outside carries the quiet mark; the handler's figure and the state are the company's own.
		const first = main.querySelector(".interface-mail-list li")!;
		expect(first.querySelector("strong")?.classList.contains("interface-outside")).toBe(true);
		expect(first.querySelector("small")?.classList.contains("interface-outside")).toBe(true);
		expect(first.querySelector("strong")?.getAttribute("title")).toBe("From outside the company");
		expect(first.querySelector(".interface-item-status")?.textContent).toBe("New");
		expect(first.classList.contains("is-unread")).toBe(true);
		expect(first.querySelector(".interface-unread")?.textContent).toBe("Unread");
		expect(main.querySelectorAll(".interface-mail-list li.is-unread")).toHaveLength(1);
		expect(calls(fake, "qorpera_member_mail_threads")).toEqual([
			{ p_environment_id: profileA.environmentId, p_request: { limit: 50 } },
		]);
		button(main, "Show older")!.click();
		await vi.waitFor(() => expect(rows(main)).toHaveLength(55));
		expect(lines(main).at(-1)).toBe("Sender 55");
		expect(calls(fake, "qorpera_member_mail_threads")[1]).toEqual({
			p_environment_id: profileA.environmentId,
			p_request: { before: { lastAt: at(50), thread: thread(50) }, limit: 50 },
		});
		// The last page is read: nothing older to show.
		expect(button(main, "Show older")).toBeUndefined();
	});

	it("gives each thread's time to the second, so a list's `since` reads the cloud's times", async () => {
		const { main } = await mailbox(
			(mail) => {
				mail.threads = [
					summary(1, { lastAt: cloudTime(0) }),
					summary(2, { lastAt: cloudTime(2) }),
					summary(3, { lastAt: cloudTime(9) }),
				];
			},
			"owner",
			(text) => text.replace('order = "-last_at"', 'order = "-last_at"\nsince = "-7d"'),
		);
		await vi.waitFor(() => expect(lines(main)).toEqual(["Sender 1", "Sender 2"]));
	});

	it("reads the list again every 20 seconds while the page is on screen, with the older pages it shows", async () => {
		vi.useFakeTimers();
		const { main, fake } = await mailbox((mail) => {
			mail.threads = Array.from({ length: 51 }, (_, index) => summary(index + 2));
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(50));
		button(main, "Show older")!.click();
		await vi.waitFor(() => expect(rows(main)).toHaveLength(51));
		fake.threads.unshift(summary(1, { fromName: "Newcomer", unread: true }));
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(lines(main)[0]).toBe("Newcomer"));
		expect(rows(main)).toHaveLength(52);
		expect(main.querySelectorAll(".interface-mail-list li.is-unread")).toHaveLength(1);
	});

	it("drops an older page that a fresh first page overtook, so no thread goes missing between them", async () => {
		vi.useFakeTimers();
		const { main, f, fake } = await mailbox((mail) => {
			mail.threads = Array.from({ length: 55 }, (_, index) => summary(index + 1));
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(50));
		// Show older waits in the cloud while new mail arrives and the first page is read again.
		const rpc = f.cloud.rpc as unknown as Mock;
		const answer = rpc.getMockImplementation()!;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
			const page = answer(fn, args);
			if (fn === "qorpera_member_mail_threads" && (args.p_request as { before?: unknown }).before) await held;
			return page;
		});
		button(main, "Show older")!.click();
		fake.threads.unshift(summary(0, { fromName: "Newcomer" }));
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(lines(main)[0]).toBe("Newcomer"));
		release();
		await vi.waitFor(() => expect(button(main, "Show older")?.disabled).toBe(false));
		expect(rows(main)).toHaveLength(50);
		// Show older reads on from the fresh page's end: Sender 50, which the old page would have skipped, is there.
		rpc.mockImplementation(answer);
		button(main, "Show older")!.click();
		await vi.waitFor(() => expect(rows(main)).toHaveLength(56));
		expect(lines(main)).toContain("Sender 50");
		expect((calls(fake, "qorpera_member_mail_threads").at(-1)?.p_request as { before?: unknown }).before).toEqual({
			lastAt: at(49),
			thread: thread(49),
		});
	});

	it("names a sender without a name by address, and says a list that can't be read, with a way to try again", async () => {
		const { main, fake, f } = await mailbox((mail) => {
			mail.threads = [summary(1, { fromName: null })];
		});
		await vi.waitFor(() => expect(lines(main)).toEqual(["sender1@outside.example"]));
		expect(main.querySelector(".interface-mail-list strong")?.classList.contains("interface-outside")).toBe(true);
		// A list never read that fails says why.
		const rpc = f.cloud.rpc as unknown as Mock;
		const answer = rpc.getMockImplementation()!;
		rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
			if (fn === "qorpera_member_mail_threads" && (args.p_request as { state?: string }).state === "waiting")
				throw new CloudRpcError(fn, { message: "The mail read is busy.", code: "XX000" }, 500);
			return answer(fn, args);
		});
		view(main, "Waiting for you");
		await vi.waitFor(() => expect(main.querySelector(".interface-mail-list .notice")?.textContent).toContain("busy"));
		expect(main.querySelector(".interface-mail-list .interface-empty")).toBeNull();
		rpc.mockImplementation(answer);
		fake.threads = [summary(1, { state: "waiting" })];
		button(main, "Try again")!.click();
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
	});
});

describe("the views", () => {
	it("asks the threads call for waiting threads and for sent ones", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [
				summary(1, { state: "waiting" }),
				summary(2, { direction: "sent", state: "handled", fromName: "Ada" }),
				summary(3),
			];
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(3));
		view(main, "Waiting for you");
		await vi.waitFor(() => expect(lines(main)).toEqual(["Sender 1"]));
		expect(calls(fake, "qorpera_member_mail_threads").at(-1)).toEqual({
			p_environment_id: profileA.environmentId,
			p_request: { state: "waiting", limit: 50 },
		});
		expect(main.querySelector(".interface-item-status")?.textContent).toBe("Waiting");
		// The send is answered meanwhile.
		fake.threads[0]!.state = "handled";
		const asked = calls(fake, "qorpera_member_mail_threads").length;
		view(main, "Sent");
		await vi.waitFor(() => expect(lines(main)).toEqual(["Ada"]));
		// The Sent view asks the call for sent threads itself, so it pages through all of them.
		expect(calls(fake, "qorpera_member_mail_threads").slice(asked)).toEqual([
			{ p_environment_id: profileA.environmentId, p_request: { direction: "sent", limit: 50 } },
		]);
		view(main, "Inbox");
		await vi.waitFor(() => expect(main.querySelector(".interface-item-status")?.textContent).toBe("Handled"));
		expect(rows(main)).toHaveLength(3);
		// The Inbox is read afresh as it comes back on screen.
		expect(calls(fake, "qorpera_member_mail_threads").slice(asked + 1)).toEqual([
			{ p_environment_id: profileA.environmentId, p_request: { limit: 50 } },
		]);
	});

	it("shows sent threads older than the Inbox's first page in Sent, and pages through them", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = Array.from({ length: 110 }, (_, n) =>
				summary(n + 1, n < 55 ? {} : { direction: "sent", fromName: `Sent ${n + 1}` }),
			);
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(50));
		view(main, "Sent");
		await vi.waitFor(() => expect(lines(main)).toHaveLength(50));
		expect(lines(main)[0]).toBe("Sent 56");
		button(main, "Show older")?.click();
		await vi.waitFor(() => expect(lines(main)).toHaveLength(55));
		expect(lines(main).at(-1)).toBe("Sent 110");
		expect(calls(fake, "qorpera_member_mail_threads").at(-1)).toEqual({
			p_environment_id: profileA.environmentId,
			p_request: { direction: "sent", before: { lastAt: at(105), thread: thread(105) }, limit: 50 },
		});
		expect(button(main, "Show older")).toBeUndefined();
	});

	it("takes a thread out of Sent at the next read once mail comes into it, on a page Show older read too", async () => {
		vi.useFakeTimers();
		const { main, fake } = await mailbox((mail) => {
			mail.threads = Array.from({ length: 110 }, (_, n) =>
				summary(n + 1, n < 55 ? {} : { direction: "sent", fromName: `Sent ${n + 1}` }),
			);
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(50));
		view(main, "Sent");
		await vi.waitFor(() => expect(lines(main)).toHaveLength(50));
		button(main, "Show older")!.click();
		await vi.waitFor(() => expect(lines(main)).toHaveLength(55));
		// A reply comes into the oldest sent thread: its newest message is received now, and it is the newest thread.
		const replied = fake.threads.pop()!;
		fake.threads.unshift({ ...replied, direction: "received", lastAt: at(0), fromName: "Reply" });
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(lines(main)).toHaveLength(54));
		expect(lines(main)).not.toContain("Sent 110");
		expect(lines(main).at(-1)).toBe("Sent 109");
		expect(calls(fake, "qorpera_member_mail_threads").at(-1)).toEqual({
			p_environment_id: profileA.environmentId,
			p_request: { direction: "sent", before: { lastAt: at(105), thread: thread(105) }, limit: 50 },
		});
		expect(button(main, "Show older")).toBeUndefined();
	});
});

describe("an open thread", () => {
	it("draws its messages as plain text with outside marks, and marks the thread read", async () => {
		const { main, fake, controller } = await mailbox((mail) => {
			mail.threads = [summary(1, { unread: true, messages: 2 })];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [
					received(2, {
						text: '<img src="https://tracker.example/pixel.png" onerror="alert(1)"><b>Pay now</b>',
						cc: ["boss@outside.example"],
						attachments: [{ filename: "invoice.pdf", size: 1200 }],
						automated: true,
						textTruncated: true,
					}),
					{
						kind: "sent",
						mailId: "mail-1",
						fromAddress: ADDRESS.address,
						to: ["sender1@outside.example"],
						subject: "Re: Subject 1",
						text: "Thanks, paid.",
						status: "sent",
						at: at(1),
						staffAgent: { staffAgentId: ada.id },
						attachments: [],
					},
				],
				more: true,
				nextBefore: { at: at(2), kind: "received", id: id(902) },
				waiting: [],
			};
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		expect(main.querySelector(".interface-mail")?.textContent).toContain("Choose one to see it here.");
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(opened()?.querySelectorAll(".interface-mail-message")).toHaveLength(2));
		const open = opened()!;
		const subject = open.querySelector(".interface-mail-subject")!;
		expect(subject.textContent).toBe("Subject 1");
		expect(subject.classList.contains("interface-outside")).toBe(true);
		expect(open.querySelector(".interface-mail-meta")?.textContent).toBe("hello@acme.example · Handled by Ada");
		const [first, second] = open.querySelectorAll<HTMLElement>(".interface-mail-message");
		// HTML is text: its tags show, and nothing is fetched or run.
		expect(first!.querySelector(".review-email-body")?.textContent).toBe(
			'<img src="https://tracker.example/pixel.png" onerror="alert(1)"><b>Pay now</b>',
		);
		expect(open.querySelector("img, b, iframe, script")).toBeNull();
		expect(first!.querySelector(".review-email-body")?.classList.contains("interface-outside")).toBe(true);
		expect(first!.querySelector("h3")?.textContent).toBe("Sender 2 <sender2@outside.example>");
		expect(first!.querySelector("h3")?.classList.contains("interface-outside")).toBe(true);
		expect(texts(first!, ".email-draft-row")).toEqual([
			"Tohello@acme.example",
			"Ccboss@outside.example",
			"SubjectSubject 2",
			"Attachmentsinvoice.pdf",
		]);
		expect(first!.querySelector(".interface-mail-notes")?.textContent).toBe(
			"Automated email This email is longer; only its start is shown.",
		);
		// What the company sent is its own: no mark, and who sent it.
		expect(second!.querySelector(".interface-outside")).toBeNull();
		expect(second!.querySelector(".review-email-body")?.textContent).toBe("Thanks, paid.");
		expect(texts(second!, ".email-draft-status")).toEqual(["Ada", "Sent", expect.any(String)]);
		// The thread has older messages: they are a button away.
		expect(open.querySelector(".interface-mail-more button")?.textContent).toBe("Show older messages");
		await vi.waitFor(() => expect(calls(fake, "qorpera_mark_mail_thread_read")).toHaveLength(1));
		expect(calls(fake, "qorpera_mark_mail_thread_read")[0]).toEqual({
			p_environment_id: profileA.environmentId,
			p_thread: thread(1),
		});
		await vi.waitFor(() => expect(main.querySelector(".interface-mail-list li.is-unread")).toBeNull());
		// Closing it lets its read go; opening it again reads it again and marks it again.
		button(main, "Back")!.click();
		await vi.waitFor(() => expect(opened()).toBeNull());
		await vi.waitFor(() => expect(controller.store.get().mail?.threads).toEqual({}));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(calls(fake, "qorpera_mark_mail_thread_read")).toHaveLength(2));
		expect(calls(fake, "qorpera_member_mail_thread")).toHaveLength(2);
	});

	it("reads older messages a page at a time on Show older messages, and keeps them through the 20-second reads", async () => {
		vi.useFakeTimers();
		const page = (messages: number[], next?: number) => ({
			thread: thread(1),
			address: ADDRESS.address,
			messages: messages.map((n) => received(n)),
			more: next !== undefined,
			...(next === undefined ? {} : { nextBefore: { at: at(next), kind: "received", id: id(900 + next) } }),
			waiting: [],
		});
		const { main, f, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { messages: 6 })];
			// Pages of two, each oldest first: 2 and 1 are the newest, 4 and 3 come before them, 6 and 5 are the oldest.
			mail.reads[thread(1)] = page([2, 1], 2);
			mail.reads[`${thread(1)} before ${id(902)}`] = page([4, 3], 4);
			mail.reads[`${thread(1)} before ${id(904)}`] = page([6, 5]);
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		const senders = () => texts(opened()!, ".interface-mail-message h3").map((line) => line?.split(" <")[0]);
		await vi.waitFor(() => expect(senders()).toEqual(["Sender 2", "Sender 1"]));
		button(opened()!, "Show older messages")!.click();
		await vi.waitFor(() => expect(senders()).toEqual(["Sender 4", "Sender 3", "Sender 2", "Sender 1"]));
		expect(calls(fake, "qorpera_member_mail_thread").at(-1)).toEqual({
			p_environment_id: profileA.environmentId,
			p_thread: thread(1),
			p_before: { at: at(2), kind: "received", id: id(902) },
		});
		// New mail pushes message 2 out of the newest page: the 20-second read keeps it, and the older page with it.
		fake.reads[thread(1)] = page([1, 0], 1);
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() => expect(senders()).toEqual(["Sender 4", "Sender 3", "Sender 2", "Sender 1", "Sender 0"]));
		// A read that fails says so, and Try again reads the page; the oldest page offers nothing older.
		const rpc = f.cloud.rpc as unknown as Mock;
		const answer = rpc.getMockImplementation()!;
		let down = true;
		rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
			if (fn === "qorpera_member_mail_thread" && args.p_before && down) {
				down = false;
				throw new Error("The network is down.");
			}
			return answer(fn, args);
		});
		button(opened()!, "Show older messages")!.click();
		await vi.waitFor(() =>
			expect(opened()!.querySelector(".interface-mail-more [role=alert]")?.textContent).toBe(
				"Older messages can't be read.",
			),
		);
		expect(senders()).toHaveLength(5);
		button(opened()!, "Try again")!.click();
		await vi.waitFor(() => expect(senders()).toHaveLength(7));
		expect(senders()).toEqual(["Sender 6", "Sender 5", "Sender 4", "Sender 3", "Sender 2", "Sender 1", "Sender 0"]);
		expect(calls(fake, "qorpera_member_mail_thread").at(-1)?.p_before).toEqual({
			at: at(4),
			kind: "received",
			id: id(904),
		});
		expect(opened()!.querySelector(".interface-mail-more")).toBeNull();
	});

	it("reads back to the messages shown when more than a page came between two reads, so none is skipped", async () => {
		vi.useFakeTimers();
		const page = (messages: number[], next?: number) => ({
			thread: thread(1),
			address: ADDRESS.address,
			messages: messages.map((n) => received(n)),
			more: next !== undefined,
			...(next === undefined ? {} : { nextBefore: { at: at(next), kind: "received", id: id(900 + next) } }),
			waiting: [],
		});
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { messages: 4 })];
			// Pages of two, each oldest first: 4 and 3 are the newest, 6 and 5 the oldest.
			mail.reads[thread(1)] = page([4, 3], 4);
			mail.reads[`${thread(1)} before ${id(904)}`] = page([6, 5]);
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		const senders = () => texts(opened()!, ".interface-mail-message h3").map((line) => line?.split(" <")[0]);
		await vi.waitFor(() => expect(senders()).toEqual(["Sender 4", "Sender 3"]));
		button(opened()!, "Show older messages")!.click();
		await vi.waitFor(() => expect(senders()).toEqual(["Sender 6", "Sender 5", "Sender 4", "Sender 3"]));
		// Three messages come before the next read, more than its newest page holds: the page before it is read too,
		// up to message 3, the newest one shown, and no further.
		fake.reads[thread(1)] = page([1, 0], 1);
		fake.reads[`${thread(1)} before ${id(901)}`] = page([3, 2], 3);
		fake.reads[`${thread(1)} before ${id(903)}`] = page([5, 4], 5);
		const asked = calls(fake, "qorpera_member_mail_thread").length;
		await vi.advanceTimersByTimeAsync(20_000);
		await vi.waitFor(() =>
			expect(senders()).toEqual([
				"Sender 6",
				"Sender 5",
				"Sender 4",
				"Sender 3",
				"Sender 2",
				"Sender 1",
				"Sender 0",
			]),
		);
		expect(calls(fake, "qorpera_member_mail_thread").slice(asked)).toEqual([
			{ p_environment_id: profileA.environmentId, p_thread: thread(1) },
			{
				p_environment_id: profileA.environmentId,
				p_thread: thread(1),
				p_before: { at: at(1), kind: "received", id: id(901) },
			},
		]);
		expect(opened()!.querySelector(".interface-mail-more")).toBeNull();
	});

	it("shows account mail as account mail only: which account and who last used it, never its words", async () => {
		const { main } = await mailbox((mail) => {
			mail.threads = [
				summary(1, { account: { site: "bank.example", lastUsedBy: ada.id, lastUsedAt: at(30) } }),
				summary(2, { account: { unknown: true }, fromName: "Shop" }),
			];
			mail.reads[thread(1)] = {
				thread: thread(1),
				messages: [
					received(1, {
						text: "Your code is 481516.",
						subject: "Your sign-in code",
						account: { site: "bank.example", lastUsedBy: ada.id, lastUsedAt: at(30) },
					}),
				],
				more: false,
				waiting: [],
			};
			mail.reads[thread(2)] = {
				thread: thread(2),
				messages: [received(2, { text: "Reset link: https://shop.example/r/1", account: { unknown: true } })],
				more: false,
				waiting: [],
			};
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(2));
		// The list never shows its subject.
		expect(texts(main, ".interface-mail-list .interface-item-copy small")).toEqual(["Account mail", "Account mail"]);
		expect(main.textContent).not.toContain("Subject 1");
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(opened()?.querySelector(".interface-mail-message h3")).not.toBeNull());
		expect(opened()!.querySelector(".interface-mail-subject")?.textContent).toBe("Account mail");
		expect(opened()!.querySelector(".interface-mail-message h3")?.textContent).toMatch(
			/^Account mail · bank\.example · last used by Ada .+/,
		);
		expect(opened()!.querySelector(".email-draft-panel, .review-email-body")).toBeNull();
		// The cloud takes no quote of account mail, so there is no button that would put its sender in one.
		expect(button(main, "Ask Ada")).toBeUndefined();
		expect(main.textContent).not.toContain("481516");
		expect(main.textContent).not.toContain("sign-in code");
		rows(main)[1]!.click();
		await vi.waitFor(() =>
			expect(opened()?.querySelector(".interface-mail-message h3")?.textContent).toBe(
				"Account mail (unknown account)",
			),
		);
		expect(main.textContent).not.toContain("shop.example/r/1");
	});

	it("reads names and texts at the cloud's bounds in characters, where an emoji is one, and clips what is longer", async () => {
		// The cloud keeps 320 characters of a sender's name and 16,000 of a text; each emoji is two units in the page.
		const name = "😀".repeat(200);
		const text = `${"a".repeat(15_999)}😀`;
		const { main } = await mailbox((mail) => {
			mail.threads = [summary(1, { fromName: name }), summary(2, { fromName: "😀".repeat(400) })];
			mail.reads[thread(1)] = {
				thread: thread(1),
				address: ADDRESS.address,
				messages: [received(1, { fromName: name, text })],
				more: false,
				waiting: [],
			};
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(2));
		expect(lines(main)).toEqual([name, "😀".repeat(320)]);
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(opened()?.querySelector(".review-email-body")?.textContent).toBe(text));
		expect(opened()!.querySelector(".interface-mail-message h3")?.textContent).toBe(
			`${name} <sender1@outside.example>`,
		);
	});

	it("says a thread the cloud no longer has (22023) is gone, and marks nothing", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { unread: true })];
			mail.gone.add(thread(1));
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() =>
			expect(opened()?.querySelector(".interface-empty")?.textContent).toBe("This email thread is no longer here."),
		);
		expect(calls(fake, "qorpera_mark_mail_thread_read")).toEqual([]);
	});
});

describe("a send that waits for a person", () => {
	const reviewed = (fake: MailFake, ...waiting: Record<string, unknown>[]) => {
		fake.threads = [summary(1, { state: "waiting" })];
		fake.reads[thread(1)] = {
			thread: thread(1),
			address: ADDRESS.address,
			messages: [received(1)],
			more: false,
			waiting,
		};
	};

	it("is answered through its conversation's card when it names one; without one it only waits", async () => {
		const { main, f, fake, accounts } = await mailbox((mail) =>
			reviewed(
				mail,
				waitingSend(id(901)),
				waitingSend(id(902), { sessionId: null, staffAgent: { staffAgentId: bo.id } }),
			),
		);
		const answer = vi.spyOn(f.api, "answerActionReview").mockImplementation(async (reviewId, _input, given) => {
			const read = fake.reads[thread(1)]!;
			read.waiting = (read.waiting as { reviewId: string }[]).filter((item) => item.reviewId !== reviewId);
			return { reviewId, answer: given, inputId: id(950), savedRuleId: null, woke: true };
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(opened()?.querySelectorAll(".interface-mail-waiting")).toHaveLength(2));
		const [withConversation, without] = opened()!.querySelectorAll<HTMLElement>(".interface-mail-waiting");
		expect(withConversation!.querySelector("h3")?.textContent).toBe("Ada wants to send this email");
		expect(withConversation!.querySelector(".review-email-body")?.textContent).toBe("Paid today.");
		expect(texts(withConversation!, ".email-draft-actions button")).toEqual(["Send email", "Don't send"]);
		expect(without!.querySelector("h3")?.textContent).toBe("Bo wants to send this email");
		expect(without!.querySelector("button")).toBeNull();
		expect(without!.querySelector(".review-waiting")?.textContent).toBe(
			"This send waits for someone who can answer it.",
		);
		// There is no "Always allow" here, and no answer button among the block's own.
		expect(opened()!.textContent).not.toContain("Always");
		expect(texts(opened()!, ".interface-mail-head button")).toEqual(["Ask Ada"]);
		const waitingReads = calls(fake, "qorpera_member_mail_waiting").length;
		button(withConversation!, "Send email")!.click();
		await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
		// On the model account the cloud chooses for the conversation, as its thread would: the answer may wake Ada.
		expect(accounts.selectSessionAccount).toHaveBeenCalledWith(session.sessionId, expect.any(AbortSignal));
		expect(answer).toHaveBeenCalledWith(id(901), expect.any(String), "allow_once", undefined, {
			sponsorBindingId: id(881),
			sponsorVersion: 1,
		});
		// The thread and the waiting sends are read again: the answered send is no longer there.
		await vi.waitFor(() => expect(opened()?.querySelectorAll(".interface-mail-waiting")).toHaveLength(1));
		expect(calls(fake, "qorpera_member_mail_waiting").length).toBeGreaterThan(waitingReads);
	});

	it("shows why an answer is refused, on the card, and keeps its buttons", async () => {
		const { main, f } = await mailbox((mail) => reviewed(mail, waitingSend(id(901))));
		vi.spyOn(f.api, "answerActionReview").mockRejectedValue(
			new CloudRpcError(
				"qorpera_answer_action_review",
				{ message: "Only an owner can answer this send.", code: "42501" },
				403,
			),
		);
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(button(main, "Don't send")).toBeDefined());
		button(main, "Don't send")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".interface-mail-waiting .email-draft-error")?.textContent).toBe(
				"Only an owner can answer this send.",
			),
		);
		expect(main.querySelector(".email-draft-error")?.getAttribute("role")).toBe("alert");
		expect(button(main, "Send email")?.disabled).toBe(false);
		expect(main.querySelector(".interface-mail-thread")).toBeNull();
	});

	it("points to the agent's thread when the answer needs a model account the cloud can't choose here", async () => {
		const { main, f, fake, accounts, controller } = await mailbox((mail) => reviewed(mail, waitingSend(id(901))));
		accounts.selectSessionAccount.mockResolvedValue(undefined);
		// Ada no longer waits: the answer wakes her, and the cloud refuses a wake without the member's account.
		const answer = vi
			.spyOn(f.api, "answerActionReview")
			.mockImplementation(async (reviewId, _input, given, _rule, sponsor) => {
				if (!sponsor)
					throw new CloudRpcError(
						"qorpera_answer_action_review",
						{ code: "42501", message: "Room sponsor is unavailable" },
						403,
					);
				fake.reads[thread(1)]!.waiting = [];
				return { reviewId, answer: given, inputId: id(950), savedRuleId: null, woke: true };
			});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(button(main, "Send email")).toBeDefined());
		button(main, "Send email")!.click();
		await vi.waitFor(() => expect(main.querySelector(".interface-mail-thread")).not.toBeNull());
		expect(answer).toHaveBeenCalledWith(id(901), expect.any(String), "allow_once", undefined, undefined);
		expect(accounts.listConnections).not.toHaveBeenCalled();
		expect(main.querySelector(".interface-mail-waiting .email-draft-error")?.textContent).toBe(
			"This answer needs your model account. Answer it in Ada's thread, where you can choose one.",
		);
		const link = main.querySelector<HTMLAnchorElement>(".interface-mail-thread")!;
		expect(link.textContent).toBe("Open Ada's thread");
		expect(link.getAttribute("href")).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`);
		// Once the conversation has its account (chosen in the thread), the same answer goes, on that account.
		accounts.selectSessionAccount.mockResolvedValue(id(880));
		expect(controller.conversation(session.sessionId, false).get().executionSponsor).toBeUndefined();
		button(main, "Send email")!.click();
		await vi.waitFor(() => expect(main.querySelector(".interface-mail-waiting")).toBeNull());
		expect(answer).toHaveBeenLastCalledWith(id(901), expect.any(String), "allow_once", undefined, {
			sponsorBindingId: id(881),
			sponsorVersion: 1,
		});
	});

	it("keeps the account of a conversation with a message on its way", async () => {
		const { main, f, accounts, controller } = await mailbox((mail) => reviewed(mail, waitingSend(id(901))));
		const kept = {
			connectionId: id(884),
			provider: "openai",
			nativeHarness: "codex-cli",
			sponsorBindingId: id(885),
			sponsorVersion: 2,
			computeIdentityId: id(882),
			workerClass: "managed_sandbox",
		} as const;
		controller.conversation(session.sessionId, false).set({ sending: true, executionSponsor: kept });
		const answer = vi.spyOn(f.api, "answerActionReview").mockResolvedValue({
			reviewId: id(901),
			answer: "allow_once",
			inputId: id(950),
			savedRuleId: null,
			woke: false,
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(button(main, "Send email")).toBeDefined());
		button(main, "Send email")!.click();
		await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
		expect(accounts.selectSessionAccount).not.toHaveBeenCalled();
		expect(answer).toHaveBeenCalledWith(id(901), expect.any(String), "allow_once", undefined, {
			sponsorBindingId: id(885),
			sponsorVersion: 2,
		});
		expect(controller.conversation(session.sessionId, false).get().executionSponsor).toBe(kept);
	});

	it("can't be answered by a member who can't write", async () => {
		const { main } = await mailbox((mail) => reviewed(mail, waitingSend(id(901))), "viewer");
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(main.querySelector(".interface-mail-waiting")).not.toBeNull());
		expect(button(main, "Send email")).toBeUndefined();
		expect(main.querySelector(".interface-mail-waiting .review-waiting")).not.toBeNull();
	});
});

describe("the message buttons", () => {
	it("asks the thread's handler about it, with the outside words as quotes of the thread", async () => {
		const { main, controller } = await mailbox((mail) => {
			mail.threads = [summary(1, { subject: "Invoice 42", fromName: "Jane" })];
		});
		const open = vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(button(main, "Ask Ada")).toBeDefined());
		// Its label fills in no outside words, so it is not marked.
		expect(button(main, "Ask Ada")!.querySelector(".interface-outside")).toBeNull();
		button(main, "Ask Ada")!.click();
		await vi.waitFor(() => expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`));
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: ada.id }));
		const draft = controller.conversation(session.sessionId).get().draft ?? "";
		expect(draft).toBe('About the email "«Invoice 42»" from «Jane»: ');
		const quote = (words: string) => ({
			start: draft.indexOf(words),
			end: draft.indexOf(words) + words.length,
			source: "mail",
			ref: thread(1),
		});
		expect(controller.draftQuotes(session.sessionId)).toEqual([quote("Invoice 42"), quote("Jane")]);
	});

	it("lists the addresses, and asks the Co-Founder to change who handles one", async () => {
		const { main, controller, fake } = await mailbox(() => {});
		const open = vi
			.spyOn(controller, "openCofounderConversation")
			.mockResolvedValue({ sessionId: session.sessionId });
		await vi.waitFor(() => expect(calls(fake, "qorpera_member_mail_threads")).toHaveLength(1));
		view(main, "Addresses");
		await vi.waitFor(() => expect(main.querySelector(".interface-table")).not.toBeNull());
		expect(texts(main, ".interface-table th")).toEqual([
			"Address",
			"Handled by",
			"Routine",
			"Last 7 days",
			"Actions",
		]);
		const cells = texts(main, ".interface-table tbody td");
		expect(cells.slice(0, 4)).toEqual(["hello@acme.example", "Ada", "Morning mail", "12"]);
		// The company's own address is not outside content.
		expect(main.querySelector(".interface-table .interface-outside")).toBeNull();
		button(main, "Ask to change…")!.click();
		await vi.waitFor(() => expect(location.hash).toBe(`#/c/${profileA.profileId}`));
		expect(open).toHaveBeenCalledOnce();
		expect(controller.conversation(session.sessionId).get().draft).toBe(
			"Please have another agent handle hello@acme.example: ",
		);
		expect(controller.draftQuotes(session.sessionId)).toEqual([]);
	});
});

describe("outside words in the page's other blocks (§4)", () => {
	it("marks a list's status, a detail's title and fields, and a button's label where they fill in outside words", async () => {
		// The Inbox edited: its list shows the subject as its status and opens a detail block.
		const detail = [
			"[[view.block]]",
			'id = "info"',
			'kind = "detail"',
			'from = "mail"',
			'title = "{subject}"',
			'fields = ["from_name", "address", "state"]',
			'buttons = ["ask-handler"]',
			'width = "two-thirds"',
			"",
			"[[view.block]]",
			'id = "thread"',
		].join("\n");
		const { main } = await mailbox(
			(mail) => {
				mail.threads = [summary(1, { subject: "Invoice 42", fromName: "Jane" })];
			},
			"owner",
			(text) =>
				text
					.replace('status = "state"', 'status = "subject"')
					.replace('opens = "thread"', 'opens = "info"')
					.replace('[[view.block]]\nid = "thread"', detail)
					.replace('label = "Ask {handled_by}"', 'label = "Ask about {subject}"'),
		);
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		const status = main.querySelector(".interface-item-status")!;
		expect(status.textContent).toBe("Invoice 42");
		expect(status.classList.contains("interface-outside")).toBe(true);
		rows(main)[0]!.click();
		await vi.waitFor(() => expect(main.querySelector(".interface-detail.is-open")).not.toBeNull());
		const open = main.querySelector<HTMLElement>(".interface-detail.is-open")!;
		expect(open.querySelector("h2")?.textContent).toBe("Invoice 42");
		expect(open.querySelector("h2 .interface-outside")?.textContent).toBe("Invoice 42");
		expect(texts(open, "dd")).toEqual(["Jane", "hello@acme.example", "New"]);
		// The company's own address and the thread's state are not outside content.
		expect(texts(open, "dd .interface-outside")).toEqual(["Jane"]);
		const ask = button(open, "Ask about Invoice 42")!;
		expect(ask.querySelector(".interface-outside")?.textContent).toBe("Ask about Invoice 42");
		expect(button(open, "Back")!.querySelector(".interface-outside")).toBeNull();
	});

	it("marks a table's cells, the one that opens a thread too, and reads its mail as a list does", async () => {
		// The Inbox edited: a table of the threads instead of the list.
		const table = [
			'id = "threads"',
			'kind = "table"',
			'from = "mail"',
			'order = "-last_at"',
			'columns = ["subject", "from_name", "state"]',
			'opens = "thread"',
			'width = "third"',
		].join("\n");
		const { main, fake, f } = await mailbox(
			(mail) => {
				mail.threads = Array.from({ length: 55 }, (_, index) =>
					summary(index + 1, index === 0 ? { subject: "Invoice 42", fromName: "Jane" } : {}),
				);
			},
			"owner",
			(text) => text.replace(/id = "threads"[\s\S]*?width = "third"/, table),
		);
		const block = () => main.querySelector<HTMLElement>(".interface-table-block")!;
		const tableRows = () => [...block().querySelectorAll("tbody tr")];
		// Being read, the table says so instead of being empty.
		expect(block().querySelector(".interface-empty")).toBeNull();
		await vi.waitFor(() => expect(tableRows()).toHaveLength(50));
		const cells = [...tableRows()[0]!.querySelectorAll("td")];
		expect(cells.map((cell) => cell.textContent)).toEqual(["Invoice 42", "Jane", "New"]);
		expect(cells[0]!.querySelector("button.interface-row-open")?.textContent).toBe("Invoice 42");
		expect(cells.map((cell) => cell.classList.contains("interface-outside"))).toEqual([true, true, false]);
		button(block(), "Show older")!.click();
		await vi.waitFor(() => expect(tableRows()).toHaveLength(55));
		expect(button(block(), "Show older")).toBeUndefined();
		// A table never read that fails says why, with a way to try again.
		const rpc = f.cloud.rpc as unknown as Mock;
		const answer = rpc.getMockImplementation()!;
		rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
			if (fn === "qorpera_member_mail_threads" && (args.p_request as { state?: string }).state === "waiting")
				throw new CloudRpcError(fn, { message: "The mail read is busy.", code: "XX000" }, 500);
			return answer(fn, args);
		});
		view(main, "Waiting for you");
		await vi.waitFor(() => expect(block().querySelector(".notice")?.textContent).toContain("busy"));
		expect(block().querySelector(".interface-empty")).toBeNull();
		rpc.mockImplementation(answer);
		fake.threads = [summary(1, { state: "waiting" })];
		button(block(), "Try again")!.click();
		await vi.waitFor(() => expect(tableRows()).toHaveLength(1));
	});

	it("draws no text, numbers or calendar block from mail, which is read a page at a time", async () => {
		// The Inbox edited: a numbers block, a calendar and a text block from `mail` above the list, and a numbers
		// block from the addresses, which is drawn.
		const blocks = [
			"[[view.block]]",
			'kind = "numbers"',
			'from = "mail"',
			'value = "subject"',
			"",
			"[[view.block]]",
			'kind = "calendar"',
			'from = ["routines", "mail"]',
			"",
			"[[view.block]]",
			'kind = "text"',
			'from = "mail"',
			"",
			"[[view.block]]",
			'kind = "numbers"',
			'from = "mail_addresses"',
			'value = "last_7_days"',
			"",
			"[[view.block]]",
			'id = "threads"',
		].join("\n");
		const { main } = await mailbox(
			(mail) => {
				mail.threads = [summary(1, { subject: "Invoice 42", lastAt: new Date().toISOString() })];
			},
			"owner",
			(text) => text.replace('[[view.block]]\nid = "threads"', blocks),
		);
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		expect(texts(main, ".interface-numbers .interface-number-value")).toEqual(["12"]);
		expect(main.querySelector(".interface-calendar")).toBeNull();
		expect(main.querySelector(".interface-text")).toBeNull();
	});
});

describe("the Mailbox's badge (§3 badge)", () => {
	it("counts the mail sends that wait, once each, beside the agent's own wait", async () => {
		// Ada waits for the member's answer, a review; her send is counted under mail only.
		const needsYou: HostedStaffExecutionActivity = {
			staffAgentId: ada.id,
			runId: id(81),
			sourceKind: "session_turn",
			activity: "needs_attention",
			jobStatus: "leased",
			updatedAt: "2026-10-06T09:00:00Z",
		};
		const { f, controller } = company("owner", [needsYou]);
		const fake = mailFake(f);
		fake.addresses = [ADDRESS];
		fake.waiting = [
			{
				reviewId: id(901),
				thread: thread(1),
				sessionId: session.sessionId,
				staffAgent: { staffAgentId: ada.id },
				to: [],
				subject: "Re: Subject 1",
				createdAt: at(1),
			},
			// Its address is Bo's own `from` argument, only shown: a malformed one fails nothing.
			{
				reviewId: id(902),
				thread: thread(2),
				address: { local: "bo" },
				staffAgent: { staffAgentId: bo.id },
				to: [],
				createdAt: at(2),
			},
		];
		await readMail(controller, f);
		const file = companyInterfaces(controller).find((entry) => entry.name === "mailbox")?.file;
		expect(file).toBeTruthy();
		expect(interfaceBadge(controller, file!)).toBe(2);
		const element = rail(controller, f);
		const row = [...element.querySelectorAll<HTMLElement>(".rail-row-interface")].find(
			(candidate) => candidate.querySelector("strong")?.textContent === "Mailbox",
		)!;
		expect(row.querySelector(".rail-count")?.textContent).toBe("2");
		expect(row.querySelector(".rail-count")?.getAttribute("aria-hidden")).toBe("true");
		expect(row.getAttribute("aria-label")).toBe("Mailbox, 2 waiting");
		// Answered sends leave the count.
		fake.waiting = [];
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(interfaceBadge(controller, file!)).toBe(0));
	});

	it("reads a waiting send's time as the cloud gives it, so a badge's `since` counts it", async () => {
		const { f, controller } = company();
		const fake = mailFake(f);
		fake.addresses = [ADDRESS];
		fake.waiting = [
			{
				reviewId: id(901),
				thread: thread(1),
				staffAgent: { staffAgentId: ada.id },
				to: [],
				createdAt: cloudTime(1),
			},
			{
				reviewId: id(902),
				thread: thread(2),
				staffAgent: { staffAgentId: bo.id },
				to: [],
				createdAt: cloudTime(10),
			},
		];
		await readMail(controller, f);
		const file = edited((text) =>
			text.replace(
				'badge = { from = "waiting", where = { kind = "mail" } }',
				'badge = { from = "waiting", where = { kind = "mail" }, since = "-7d" }',
			),
		);
		expect(file.badge?.query.since).toBe("-7d");
		expect(interfaceBadge(controller, file)).toBe(1);
	});
});
