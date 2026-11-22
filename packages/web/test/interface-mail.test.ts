// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { CompanyMail } from "../src/app/company-mail.ts";
import { interfaceBadge } from "../src/app/interface-badge.ts";
import type { InterfacePagesState } from "../src/app/interface-pages.ts";
import { companyInterfaces } from "../src/app/interfaces.ts";
import type { Route } from "../src/app/router.ts";
import { renderMailbox } from "../src/app/views/mailbox.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedProfileRole, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import {
	ADDRESS,
	accountsFake,
	ada,
	at,
	bo,
	cofounder,
	type MailFake,
	mailFake,
	received,
	summary,
	thread,
	waitingSend,
} from "./mail-fixtures.ts";

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
	localStorage.clear();
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

async function mailbox(setup: (fake: MailFake) => void, role: HostedProfileRole = "owner") {
	const { f, controller } = company(role);
	const fake = mailFake(f);
	fake.addresses = [ADDRESS];
	setup(fake);
	const accounts = accountsFake();
	await readMail(controller, f, accounts);
	const main = h("main");
	document.body.append(main);
	const draw = () => renderMailbox(main, controller, "mailbox");
	cleanup.push(controller.store.subscribe(draw));
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
		openFriends: () => {},
		agentActions: {},
	});
	return element;
}

const OUTSIDE = "From outside the company";
const names = (controller: CompanyController) => companyInterfaces(controller).map((entry) => entry.name);
const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const calls = (fake: MailFake, fn: string) => fake.calls.filter((call) => call.fn === fn).map((call) => call.args);
const rows = (main: HTMLElement) => [...main.querySelectorAll<HTMLElement>(".mailbox-row")];
const lines = (main: HTMLElement) => rows(main).map((row) => row.querySelector(".mailbox-who > [title]")?.textContent);
const openRow = (main: HTMLElement, n: number) =>
	rows(main)[n]!.querySelector<HTMLButtonElement>(".mailbox-open")!.click();
const button = (root: ParentNode, label: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(each) => each.textContent?.trim() === label || each.getAttribute("aria-label") === label,
	);
const tab = (main: HTMLElement, name: string) => button(main.querySelector(".mailbox-tabs")!, name)?.click();
const opened = () => document.querySelector<HTMLElement>(".mailbox-thread");
const senders = () =>
	[...opened()!.querySelectorAll(".mailbox-message")].map(
		(message) => message.querySelector(".mailbox-from strong, .mailbox-fold strong")?.textContent,
	);

describe("the mail need (§3 needs)", () => {
	it("lists the Mailbox from the start, with or without an address, until it is switched off", async () => {
		const { f, controller } = company();
		const fake = mailFake(f);
		await readMail(controller, f);
		expect(names(controller)).toContain("mailbox");
		fake.addresses = [ADDRESS];
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(controller.store.get().mail?.addresses.length).toBe(1));
		expect(names(controller)).toContain("mailbox");
		// Switched off, it leaves the tab with its address still there (C6a).
		controller.store.set({ interfacePages: mailboxOn(false) });
		expect(names(controller)).toEqual([]);
		controller.store.set({ interfacePages: mailboxOn(true) });
		expect(names(controller)).toContain("mailbox");
	});
});

describe("the Inbox list", () => {
	it("lists threads newest first, 50 at a time, and reads older ones on Show older", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = Array.from({ length: 55 }, (_, index) => summary(index + 1, { unread: index === 0 }));
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(50));
		expect(lines(main).slice(0, 2)).toEqual(["Sender 1", "Sender 2"]);
		expect(texts(main, ".mailbox-row .mailbox-subject").slice(0, 1)).toEqual(["Subject 1"]);
		const first = rows(main)[0]!;
		expect(first.querySelector(".mailbox-who > [title]")?.getAttribute("title")).toBe(OUTSIDE);
		expect(first.querySelector(".mailbox-subject")?.getAttribute("title")).toBe(OUTSIDE);
		expect(first.querySelector(".mailbox-state")?.textContent).toBe("New");
		expect(first.classList.contains("is-unread")).toBe(true);
		expect(first.querySelector(".mailbox-open .visually-hidden")?.textContent).toBe("Unread");
		expect(main.querySelectorAll(".mailbox-row.is-unread")).toHaveLength(1);
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
		expect(main.querySelectorAll(".mailbox-row.is-unread")).toHaveLength(1);
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
		expect(rows(main)[0]!.querySelector(".mailbox-who > [title]")?.getAttribute("title")).toBe(OUTSIDE);
		// A list never read that fails says why.
		const rpc = f.cloud.rpc as unknown as Mock;
		const answer = rpc.getMockImplementation()!;
		rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
			if (fn === "qorpera_member_mail_threads" && (args.p_request as { direction?: string }).direction === "sent")
				throw new CloudRpcError(fn, { message: "The mail read is busy.", code: "XX000" }, 500);
			return answer(fn, args);
		});
		tab(main, "Sent");
		await vi.waitFor(() => expect(main.querySelector(".mailbox-list .notice")?.textContent).toContain("busy"));
		expect(main.querySelector(".mailbox-none")).toBeNull();
		rpc.mockImplementation(answer);
		fake.threads = [summary(1, { direction: "sent" })];
		button(main, "Try again")!.click();
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
	});
});

describe("the views", () => {
	it("asks the threads call for sent threads in Sent, and reads the Inbox afresh as it comes back", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [
				summary(1, { state: "waiting" }),
				summary(2, { direction: "sent", state: "handled", fromName: "Ada" }),
				summary(3),
			];
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(3));
		const asked = calls(fake, "qorpera_member_mail_threads").length;
		tab(main, "Sent");
		await vi.waitFor(() => expect(lines(main)).toEqual(["Ada"]));
		// The Sent view asks the call for sent threads itself, so it pages through all of them.
		expect(calls(fake, "qorpera_member_mail_threads").slice(asked)).toEqual([
			{ p_environment_id: profileA.environmentId, p_request: { direction: "sent", limit: 50 } },
		]);
		tab(main, "Inbox");
		await vi.waitFor(() => expect(rows(main)).toHaveLength(3));
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
		tab(main, "Sent");
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
		tab(main, "Sent");
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
		expect(rows(main)[0]!.classList.contains("is-unread")).toBe(true);
		openRow(main, 0);
		await vi.waitFor(() => expect(opened()?.querySelectorAll(".mailbox-message")).toHaveLength(2));
		const subject = opened()!.querySelector(".mailbox-thread-head h1")!;
		expect(subject.textContent).toBe("Subject 1");
		expect(subject.getAttribute("title")).toBe(OUTSIDE);
		expect(opened()!.querySelector(".mailbox-thread-head .mailbox-label")?.textContent).toBe("hello@acme.example");
		expect(opened()!.querySelector(".mailbox-handled")?.textContent).toContain("Ada handles it");
		opened()!.querySelector<HTMLButtonElement>(".mailbox-message.is-folded .mailbox-fold")!.click();
		const [first, second] = opened()!.querySelectorAll<HTMLElement>(".mailbox-message");
		expect(first!.classList.contains("is-folded")).toBe(false);
		// HTML is text: its tags show, and nothing is fetched or run.
		const body = first!.querySelector(".mailbox-text-body")!;
		expect(body.textContent).toBe('<img src="https://tracker.example/pixel.png" onerror="alert(1)"><b>Pay now</b>');
		expect(body.getAttribute("title")).toBe(OUTSIDE);
		expect(opened()!.querySelector(".mailbox-message-body img, .mailbox-message-body b, iframe, script")).toBeNull();
		const from = first!.querySelector(".mailbox-from strong")!;
		expect(from.textContent).toBe("Sender 2");
		expect(from.getAttribute("title")).toBe(OUTSIDE);
		expect(first!.querySelector(".mailbox-from .mailbox-muted")?.textContent).toBe("<sender2@outside.example>");
		expect(first!.querySelector(".mailbox-to")?.textContent).toBe("to hello@acme.example");
		expect(first!.querySelector(".mailbox-files [title]")?.textContent).toBe("invoice.pdf");
		expect(first!.querySelector(".mailbox-note")?.textContent).toBe(
			"Automated email This email is longer; only its start is shown.",
		);
		// What the company sent is its own: no mark, and who sent it.
		expect(second!.querySelector(".mailbox-text-body")?.textContent).toBe("Thanks, paid.");
		expect(second!.querySelector(".mailbox-text-body")?.getAttribute("title")).toBeNull();
		expect(second!.querySelector(".mailbox-from strong")?.textContent).toBe("Ada");
		expect(second!.querySelector(".mailbox-from strong")?.getAttribute("title")).toBeNull();
		expect(second!.querySelector(".mailbox-status")?.textContent).toBe("Sent");
		// The thread has older messages: they are a button away.
		expect(opened()!.querySelector(".mailbox-older button")?.textContent).toBe("Show older messages");
		await vi.waitFor(() => expect(calls(fake, "qorpera_mark_mail_thread_read")).toHaveLength(1));
		expect(calls(fake, "qorpera_mark_mail_thread_read")[0]).toEqual({
			p_environment_id: profileA.environmentId,
			p_thread: thread(1),
		});
		// Closing it lets its read go; opening it again reads it again and marks it again.
		button(main, "Back to Inbox")!.click();
		await vi.waitFor(() => expect(opened()).toBeNull());
		await vi.waitFor(() => expect(controller.store.get().mail?.threads).toEqual({}));
		expect(main.querySelector(".mailbox-row.is-unread")).toBeNull();
		openRow(main, 0);
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
		openRow(main, 0);
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
			expect(opened()!.querySelector(".mailbox-older [role=alert]")?.textContent).toBe(
				"Older messages can't be read.",
			),
		);
		expect(senders()).toHaveLength(5);
		button(opened()!, "Show older messages")!.click();
		await vi.waitFor(() => expect(senders()).toHaveLength(7));
		expect(senders()).toEqual(["Sender 6", "Sender 5", "Sender 4", "Sender 3", "Sender 2", "Sender 1", "Sender 0"]);
		expect(calls(fake, "qorpera_member_mail_thread").at(-1)?.p_before).toEqual({
			at: at(4),
			kind: "received",
			id: id(904),
		});
		expect(opened()!.querySelector(".mailbox-older")).toBeNull();
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
		openRow(main, 0);
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
		expect(opened()!.querySelector(".mailbox-older")).toBeNull();
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
		expect(texts(main, ".mailbox-row .mailbox-who")).toEqual(["Account mail", "Account mail"]);
		expect(texts(main, ".mailbox-row .mailbox-subject")).toEqual(["bank.example", "unknown account"]);
		expect(main.textContent).not.toContain("Subject 1");
		openRow(main, 0);
		await vi.waitFor(() => expect(opened()?.querySelector(".mailbox-message.is-account")).not.toBeNull());
		expect(opened()!.querySelector(".mailbox-thread-head h1")?.textContent).toBe("Account mail · bank.example");
		expect(opened()!.querySelector(".mailbox-message.is-account")?.textContent).toContain("Ada used the account");
		expect(opened()!.querySelector(".mailbox-text-body")).toBeNull();
		expect(button(main, "Reply")).toBeUndefined();
		expect(main.textContent).not.toContain("481516");
		expect(main.textContent).not.toContain("sign-in code");
		button(main, "Back to Inbox")!.click();
		openRow(main, 1);
		await vi.waitFor(() =>
			expect(opened()?.querySelector(".mailbox-message.is-account")?.textContent).toContain(
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
		openRow(main, 0);
		await vi.waitFor(() => expect(opened()?.querySelector(".mailbox-text-body")?.textContent).toBe(text));
		expect(opened()!.querySelector(".mailbox-from strong")?.textContent).toBe(name);
		expect(opened()!.querySelector(".mailbox-from .mailbox-muted")?.textContent).toBe("<sender1@outside.example>");
	});

	it("says a thread the cloud no longer has (22023) is gone, and marks nothing", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.threads = [summary(1, { unread: true })];
			mail.gone.add(thread(1));
		});
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		openRow(main, 0);
		await vi.waitFor(() =>
			expect(opened()?.querySelector(".mailbox-none")?.textContent).toBe("This email thread is no longer here."),
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
	const drafts = () => [...(opened()?.querySelectorAll<HTMLElement>(".mailbox-draft") ?? [])];
	const draft = () => drafts()[0];
	async function openWaiting(main: HTMLElement): Promise<void> {
		await vi.waitFor(() => expect(rows(main)).toHaveLength(1));
		openRow(main, 0);
		await vi.waitFor(() => expect(draft()).toBeDefined());
	}

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
		await openWaiting(main);
		await vi.waitFor(() => expect(drafts()).toHaveLength(2));
		const [withConversation, without] = drafts();
		expect(withConversation!.querySelector("strong")?.textContent).toBe("Ada wants to send this");
		expect(withConversation!.querySelector(".mailbox-text-body")?.textContent).toBe("Paid today.");
		expect(texts(withConversation!, ".mailbox-draft-actions button")).toEqual(["Send", "Don't send"]);
		expect(without!.querySelector("strong")?.textContent).toBe("Bo wants to send this");
		expect(without!.querySelector("button")).toBeNull();
		expect(without!.querySelector(".mailbox-note")?.textContent).toBe(
			"This send waits for someone who can answer it.",
		);
		expect(opened()!.textContent).not.toContain("Always");
		const waitingReads = calls(fake, "qorpera_member_mail_waiting").length;
		button(withConversation!, "Send")!.click();
		await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
		// On the model account the cloud chooses for the conversation, as its thread would: the answer may wake Ada.
		expect(accounts.selectSessionAccount).toHaveBeenCalledWith(session.sessionId, expect.any(AbortSignal));
		expect(answer).toHaveBeenCalledWith(id(901), expect.any(String), "allow_once", undefined, {
			sponsorBindingId: id(881),
			sponsorVersion: 1,
		});
		// The thread and the waiting sends are read again: the answered send is no longer there.
		await vi.waitFor(() => expect(drafts()).toHaveLength(1));
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
		await openWaiting(main);
		button(draft()!, "Don't send")!.click();
		await vi.waitFor(() =>
			expect(draft()!.querySelector(".mailbox-error")?.textContent).toBe("Only an owner can answer this send."),
		);
		expect(draft()!.querySelector(".mailbox-error")?.getAttribute("role")).toBe("alert");
		expect(button(draft()!, "Send")?.disabled).toBe(false);
		expect(draft()!.querySelector(".mailbox-error a")).toBeNull();
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
		await openWaiting(main);
		button(draft()!, "Send")!.click();
		await vi.waitFor(() => expect(draft()?.querySelector(".mailbox-error a")).toBeTruthy());
		expect(answer).toHaveBeenCalledWith(id(901), expect.any(String), "allow_once", undefined, undefined);
		expect(accounts.listConnections).not.toHaveBeenCalled();
		expect(draft()!.querySelector(".mailbox-error")?.firstChild?.textContent).toBe(
			"This answer needs your model account. Answer it in Ada's thread, where you can choose one.",
		);
		const link = draft()!.querySelector<HTMLAnchorElement>(".mailbox-error a")!;
		expect(link.textContent?.trim()).toBe("Open Ada's thread");
		expect(link.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/staff/${ada.id}`);
		// Once the conversation has its account (chosen in the thread), the same answer goes, on that account.
		accounts.selectSessionAccount.mockResolvedValue(id(880));
		expect(controller.conversation(session.sessionId, false).get().executionSponsor).toBeUndefined();
		button(draft()!, "Send")!.click();
		await vi.waitFor(() => expect(drafts()).toHaveLength(0));
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
		await openWaiting(main);
		button(draft()!, "Send")!.click();
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
		await openWaiting(main);
		expect(button(draft()!, "Send")).toBeUndefined();
		expect(draft()!.querySelector(".mailbox-note")?.textContent).toBe(
			"This send waits for someone who can answer it.",
		);
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
		const row = [...element.querySelectorAll<HTMLElement>(".rail-app")].find(
			(candidate) => candidate.querySelector(".rail-app-name")?.textContent === "Mailbox",
		)!;
		expect(row.querySelector(".rail-count")?.textContent).toBe("2");
		expect(row.querySelector(".rail-count")?.getAttribute("aria-hidden")).toBe("true");
		expect(row.getAttribute("aria-label")).toBe("Mailbox, 2 waiting");
		// The Mailbox's page opened the drawer, so the four windows carry no dot; closed, they do, and say what waits.
		const apps = element.querySelector<HTMLButtonElement>(".rail-apps")!;
		expect(apps.classList.contains("has-waiting")).toBe(false);
		apps.click();
		expect(apps.classList.contains("has-waiting")).toBe(true);
		expect(apps.getAttribute("aria-label")).toBe("Apps, 2 waiting");
		// Answered sends leave the count.
		fake.waiting = [];
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(interfaceBadge(controller, file!)).toBe(0));
	});

	it("stops multi-page list polling when disposed between pages", async () => {
		const { f, controller } = company();
		const fake = mailFake(f);
		fake.addresses = [ADDRESS];
		fake.threads = Array.from({ length: 80 }, (_, index) => summary(index + 1));
		const mail = new CompanyMail(controller, f.cloud, accountsFake(), (state) =>
			controller.store.set({ mail: state }),
		);
		cleanup.push(() => mail.dispose());
		await mail.open();
		mail.watch([{}], [], () => true);
		await vi.waitFor(() => expect(controller.store.get().mail?.lists["[null,null,null]"]?.threads).toHaveLength(50));
		mail.older("[null,null,null]");
		await vi.waitFor(() => expect(controller.store.get().mail?.lists["[null,null,null]"]?.pages).toBe(2));

		let listCalls = 0;
		let releaseFirstPage: (() => void) | undefined;
		const rpcMock = vi.mocked(f.cloud.rpc);
		const origRpc = rpcMock.getMockImplementation()!;
		rpcMock.mockImplementation(async (name: string, args?: Record<string, unknown>, signal?: AbortSignal) => {
			if (name === "qorpera_member_mail_threads") {
				listCalls += 1;
				if (listCalls === 1) {
					await new Promise<void>((resolve) => {
						releaseFirstPage = resolve;
					});
				}
			}
			return origRpc(name, args, signal);
		});
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(releaseFirstPage).toBeDefined());
		mail.dispose();
		releaseFirstPage!();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(listCalls).toBe(1);
	});

	it("stops multi-page thread polling when unwatched between pages", async () => {
		const { f, controller } = company();
		const fake = mailFake(f);
		const threadId = thread(1);
		fake.addresses = [ADDRESS];
		fake.threads = [summary(1, { messages: 2 })];
		fake.reads[threadId] = {
			thread: threadId,
			address: ADDRESS.address,
			messages: [received(2)],
			more: true,
			nextBefore: { at: at(2), kind: "received", id: id(902) },
			waiting: [],
		};
		fake.reads[`${threadId} before ${id(902)}`] = {
			thread: threadId,
			address: ADDRESS.address,
			messages: [received(1)],
			more: false,
			waiting: [],
		};
		const mail = new CompanyMail(controller, f.cloud, accountsFake(), (state) =>
			controller.store.set({ mail: state }),
		);
		cleanup.push(() => mail.dispose());
		await mail.open();
		mail.watch([{}], [threadId], () => true);
		await vi.waitFor(() => expect(controller.store.get().mail?.threads[threadId]?.status).toBe("ready"));
		mail.olderMessages(threadId);
		await vi.waitFor(() => {
			const entry = controller.store.get().mail?.threads[threadId];
			expect(entry?.status === "ready" ? entry.pages : 0).toBe(2);
		});

		fake.reads[threadId] = {
			thread: threadId,
			address: ADDRESS.address,
			messages: [received(3)],
			more: true,
			nextBefore: { at: at(3), kind: "received", id: id(903) },
			waiting: [],
		};
		let threadCalls = 0;
		let releaseFirstPage: (() => void) | undefined;
		const rpcMock = vi.mocked(f.cloud.rpc);
		const origRpc = rpcMock.getMockImplementation()!;
		rpcMock.mockImplementation(async (name: string, args?: Record<string, unknown>, signal?: AbortSignal) => {
			if (name === "qorpera_member_mail_thread") {
				threadCalls += 1;
				if (threadCalls === 1) {
					await new Promise<void>((resolve) => {
						releaseFirstPage = resolve;
					});
				}
			}
			return origRpc(name, args, signal);
		});
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(releaseFirstPage).toBeDefined());
		mail.watch([{}], [], () => true);
		releaseFirstPage!();
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(threadCalls).toBe(1);
	});
});
