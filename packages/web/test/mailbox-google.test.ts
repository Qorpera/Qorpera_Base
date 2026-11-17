// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyMail } from "../src/app/company-mail.ts";
import { type MailboxManage, noteGoogleMailReturn, renderMailbox } from "../src/app/views/mailbox.ts";
import type { HostedConnectorReturn } from "../src/cloud/connectors.ts";
import type { EventHook } from "../src/cloud/event-hooks.ts";
import type { HostedProfileRole } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { ADDRESS, accountsFake, ada, bo, cofounder, type MailFake, mailFake, summary } from "./mail-fixtures.ts";

const GMAIL = "hello@saml-bands.example";
const SIGN_IN = "https://accounts.google.com/o/oauth2/v2/auth?state=abc";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	noteGoogleMailReturn(undefined);
	document.body.replaceChildren();
	location.hash = "";
	Reflect.deleteProperty(document, "visibilityState");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function googleAddress(google: Record<string, unknown>): Record<string, unknown> {
	return {
		address: GMAIL,
		status: "active",
		handledBy: [{ staffAgentId: bo.id, name: "Bo" }],
		routines: [],
		last7Days: 3,
		kind: "google",
		google,
	};
}

async function mailbox(setup: (fake: MailFake) => void, role: HostedProfileRole = "owner") {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	const me = { userId: userA.id, email: "a@example.invalid", displayName: "Account A", role, joinedAt: timestamp };
	const authorize = role === "owner" || role === "admin";
	controller.store.set({
		loading: false,
		staff: [cofounder, ada, bo],
		sessions: [session],
		team: {
			...team,
			role,
			capabilities: { ...team.capabilities, write: role !== "viewer", authorize },
			members: [me],
		},
	});
	cleanup.push(() => controller.stop());
	const fake = mailFake(f);
	fake.addresses = [{ ...ADDRESS, kind: "qorpera" }];
	setup(fake);
	const reader = new CompanyMail(controller, f.cloud, accountsFake(), (state) =>
		controller.store.set({ mail: state }),
	);
	cleanup.push(() => reader.dispose());
	await reader.open();
	const main = h("main");
	document.body.append(main);
	const hooks: EventHook[] = fake.addresses.map((address, n) => ({
		id: id(950 + n),
		name: `mail-${n}`,
		purpose: "Customers write here",
		proof: "mail",
		status: "active",
		email: String(address.address),
		createdAt: timestamp,
	}));
	const manage: MailboxManage = {
		hooks: {
			list: vi.fn(async () => [...hooks]),
			createHook: vi.fn(),
			createMailbox: vi.fn(),
			setStatus: vi.fn(async () => {}),
		},
		digitalPost: {
			read: vi.fn(async () => ({
				connected: false,
				status: "disconnected" as const,
				letters: 0,
				waitingForFolder: 0,
				held: 0,
			})),
			save: vi.fn(),
			disconnect: vi.fn(),
		},
		google: {
			begin: vi.fn(async () => SIGN_IN),
			finish: vi.fn(async () => GMAIL),
			pause: vi.fn(async () => {}),
			go: vi.fn(),
		},
	};
	const draw = () => renderMailbox(main, controller, "mailbox", { manage: () => manage });
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return { f, controller, fake, main, manage, google: manage.google!, hookIds: hooks.map((hook) => hook.id) };
}

const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const button = (root: ParentNode, label: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === label);
const tab = (main: HTMLElement, name: string) => button(main.querySelector(".mailbox-tabs")!, name)?.click();
const googleRow = (main: HTMLElement) => main.querySelector<HTMLElement>(".mailbox-address.is-google");
const topLine = (main: HTMLElement) => main.querySelector<HTMLElement>(".mailbox-google-line");
const cardOf = (main: HTMLElement, hookId: string) => main.querySelector<HTMLElement>(`[data-hook="${hookId}"]`);
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].at(-1)!;

async function addresses(main: HTMLElement, cards: number): Promise<void> {
	await vi.waitFor(() => expect(main.querySelector(".mailbox-tabs")).not.toBeNull());
	tab(main, "Addresses");
	await vi.waitFor(() => expect(main.querySelectorAll(".hook-card")).toHaveLength(cards));
}

describe("Mail at Google under Addresses", () => {
	it("shows owners and admins the row beside the addresses, and nobody else", async () => {
		for (const role of ["owner", "admin"] as const) {
			const { main } = await mailbox(() => {}, role);
			await addresses(main, 1);
			const row = googleRow(main)!;
			expect(row.querySelector("strong")?.textContent).toBe("Mail at Google");
			expect(row.querySelector("strong img.mailbox-google-mark")?.getAttribute("src")).toBe(
				"./assets/provider-gmail.svg",
			);
			expect(row.querySelector(".mailbox-muted")?.textContent).toBe("Bring your mail in. It stays at Google too.");
			expect(texts(row, "button")).toEqual(["Connect Google"]);
			for (const dispose of cleanup.splice(0).reverse()) dispose();
			document.body.replaceChildren();
		}
		for (const role of ["contributor", "viewer"] as const) {
			const { main } = await mailbox(() => {}, role);
			await addresses(main, 1);
			expect(googleRow(main)).toBeNull();
			for (const dispose of cleanup.splice(0).reverse()) dispose();
			document.body.replaceChildren();
		}
	});

	it("leaves the row out once a Google address is the company's", async () => {
		const { main } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 900, total: 900, lastWeek: 38 }));
		});
		await addresses(main, 2);
		expect(googleRow(main)).toBeNull();
	});

	it("opens in place, and its button starts the sign-in at Google", async () => {
		const { main, google } = await mailbox(() => {});
		await addresses(main, 1);
		button(googleRow(main)!, "Connect Google")!.click();
		const open = () => googleRow(main)!.querySelector(".mailbox-google-open");
		expect(open()?.querySelector("p")?.textContent).toBe(
			"You sign in at Google once. Everyone in the company and your agents can read this mail.",
		);
		expect(texts(googleRow(main)!, "button")).toEqual(["Cancel", "Sign in at Google"]);
		button(googleRow(main)!, "Cancel")!.click();
		expect(open()).toBeNull();
		expect(google.begin).not.toHaveBeenCalled();
		button(googleRow(main)!, "Connect Google")!.click();
		button(googleRow(main)!, "Sign in at Google")!.click();
		await vi.waitFor(() => expect(google.go).toHaveBeenCalledWith(SIGN_IN));
		expect(google.begin).toHaveBeenCalledTimes(1);
	});

	it("says so when the sign-in cannot be started", async () => {
		const { main, google } = await mailbox(() => {});
		vi.mocked(google.begin).mockRejectedValueOnce(new Error("broker"));
		await addresses(main, 1);
		button(googleRow(main)!, "Connect Google")!.click();
		button(googleRow(main)!, "Sign in at Google")!.click();
		await vi.waitFor(() =>
			expect(googleRow(main)!.querySelector(".mailbox-error")?.textContent).toBe(
				"The sign-in at Google could not be started. Try again.",
			),
		);
		expect(google.go).not.toHaveBeenCalled();
		expect(button(googleRow(main)!, "Sign in at Google")!.disabled).toBe(false);
	});
});

describe("coming back from Google", () => {
	const outcome = (more: Partial<HostedConnectorReturn> = {}): HostedConnectorReturn => ({
		connector: "gmail",
		connection: "confirm",
		confirmation: "c".repeat(43),
		signIn: {
			ticketId: id(20),
			connectorId: "gmail",
			companyId: profileA.profileId.toLowerCase(),
			serviceOrigin: "https://broker.example",
			browserProof: "p".repeat(43),
			startedAt: Date.now(),
		},
		...more,
	});

	it("finishes the sign-in, reads the addresses again and opens the Inbox", async () => {
		const back = outcome();
		noteGoogleMailReturn(back);
		const { main, google, fake } = await mailbox((mail) => {
			mail.threads = [summary(1)];
		});
		await vi.waitFor(() => expect(google.finish).toHaveBeenCalledWith(back, expect.any(AbortSignal)));
		await vi.waitFor(() =>
			expect(fake.calls.filter((call) => call.fn === "qorpera_member_mail_addresses").length).toBeGreaterThan(1),
		);
		expect(main.querySelector('.mailbox-tab[aria-selected="true"]')?.textContent).toBe("Inbox");
		expect(google.finish).toHaveBeenCalledTimes(1);
	});

	it("says why Google refused, on the open row", async () => {
		noteGoogleMailReturn(outcome({ connection: "failed", reason: "address_taken" }));
		const { main, google } = await mailbox(() => {});
		await vi.waitFor(() =>
			expect(googleRow(main)?.querySelector(".mailbox-error")?.textContent).toBe(
				"This address is already brought in by another company.",
			),
		);
		expect(google.finish).not.toHaveBeenCalled();
	});

	it("leaves another company's sign-in alone", async () => {
		noteGoogleMailReturn(
			outcome({
				signIn: { ...outcome().signIn, companyId: id(99) },
			}),
		);
		const { main, google } = await mailbox(() => {});
		await addresses(main, 1);
		expect(google.finish).not.toHaveBeenCalled();
	});
});

describe("Google mail's states", () => {
	it("says in the Inbox how much has come in, with Google's total and without", async () => {
		const { main, fake, controller } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "bringing_in", broughtIn: 1240, total: 4212, lastWeek: 0 }));
			mail.threads = [summary(1)];
		});
		await vi.waitFor(() => expect(topLine(main)).not.toBeNull());
		expect(topLine(main)!.textContent).toBe("Bringing in your mail from Google · 1,240 of 4,212");
		expect(topLine(main)!.querySelector(".mailbox-google-count")?.textContent).toBe("1,240");
		expect(topLine(main)!.querySelector("img.mailbox-google-mark")).not.toBeNull();
		expect(topLine(main)!.classList.contains("is-waiting")).toBe(false);
		fake.addresses[0] = googleAddress({ state: "bringing_in", broughtIn: 1240, total: null, lastWeek: 0 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(topLine(main)!.textContent).toBe("Bringing in your mail from Google · 1,240"));
		tab(main, "Sent");
		await vi.waitFor(() => expect(main.querySelector(".mailbox-search")).not.toBeNull());
		expect(topLine(main)).toBeNull();
	});

	it("says nothing in the Inbox once the mail is in", async () => {
		const { main } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 4212, total: 4212, lastWeek: 38 }));
			mail.threads = [summary(1)];
		});
		await vi.waitFor(() => expect(main.querySelectorAll(".mailbox-row")).toHaveLength(1));
		expect(topLine(main)).toBeNull();
	});

	it("draws a Google address as an address line with its mark and its week", async () => {
		const { main, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 4212, total: 4212, lastWeek: 38 }));
		});
		await addresses(main, 2);
		const card = cardOf(main, hookIds[0]!)!;
		expect(card.querySelector(".settings-copy strong")?.textContent).toBe(GMAIL);
		expect(card.querySelector(".settings-copy strong img.mailbox-google-mark")).not.toBeNull();
		expect(card.querySelector(".settings-copy small")?.textContent).toBe("Customers write here");
		expect(card.querySelector(".hook-state")).toBeNull();
		expect(card.querySelector(".mailbox-google-week")?.textContent).toBe("38 in the last 7 days");
		expect(texts(card, ".connection-actions button")).toEqual(["Pause", "Remove"]);
		const other = cardOf(main, hookIds[1]!)!;
		expect(other.querySelector("img.mailbox-google-mark, .mailbox-google-week")).toBeNull();
	});

	it("pauses and resumes bringing mail in through Google's own call", async () => {
		const { main, manage, google, fake, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 10, total: 10, lastWeek: 1 }));
		});
		await addresses(main, 2);
		const card = () => cardOf(main, hookIds[0]!)!;
		vi.mocked(google.pause).mockImplementation(async () => {
			fake.addresses[0] = googleAddress({ state: "paused", broughtIn: 10, total: 10, lastWeek: 1 });
		});
		button(card(), "Pause")!.click();
		await vi.waitFor(() => expect(google.pause).toHaveBeenCalledWith(hookIds[0], true));
		await vi.waitFor(() => expect(texts(card(), ".connection-actions button")).toEqual(["Resume", "Remove"]));
		expect(card().querySelector(".hook-state")?.textContent).toBe("Paused");
		button(card(), "Resume")!.click();
		await vi.waitFor(() => expect(google.pause).toHaveBeenLastCalledWith(hookIds[0], false));
		expect(manage.hooks.setStatus).not.toHaveBeenCalled();
	});

	it("says when pausing failed", async () => {
		const { main, google, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 10, total: 10, lastWeek: 1 }));
		});
		vi.mocked(google.pause).mockRejectedValueOnce(new Error("down"));
		await addresses(main, 2);
		button(cardOf(main, hookIds[0]!)!, "Pause")!.click();
		await vi.waitFor(() =>
			expect(cardOf(main, hookIds[0]!)!.querySelector(".service-outcome")?.textContent).toBe(
				"It could not be changed. Try again.",
			),
		);
	});

	it("removes a Google address as any other, after asking", async () => {
		const { main, manage, google, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 10, total: 10, lastWeek: 1 }));
		});
		await addresses(main, 2);
		button(cardOf(main, hookIds[0]!)!, "Remove")!.click();
		await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
		expect(dialog().textContent).toContain(`Remove the mailbox ${GMAIL}?`);
		button(dialog(), "Remove")!.click();
		await vi.waitFor(() =>
			expect(manage.hooks.setStatus).toHaveBeenCalledWith(hookIds[0], "removed", expect.any(AbortSignal)),
		);
		expect(google.pause).not.toHaveBeenCalled();
	});

	it("asks for a new sign-in when Google wants one, and starts it from the line", async () => {
		const { main, google, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "sign_in_again", broughtIn: 10, total: 10, lastWeek: 1 }));
			mail.threads = [summary(1)];
		});
		await vi.waitFor(() => expect(topLine(main)).not.toBeNull());
		expect(topLine(main)!.textContent).toBe("Mail from Google is paused until you sign in again.");
		expect(topLine(main)!.classList.contains("is-waiting")).toBe(true);
		await addresses(main, 2);
		const card = cardOf(main, hookIds[0]!)!;
		const note = card.querySelector(".settings-copy small.hook-note");
		expect(note?.textContent).toBe("Google asked you to sign in again");
		expect(texts(card, ".settings-copy small")).toEqual(["Google asked you to sign in again"]);
		expect(texts(card, ".connection-actions button")).toEqual(["Sign in", "Remove"]);
		expect(card.querySelector(".mailbox-google-week")).toBeNull();
		expect(button(card, "Sign in")!.classList.contains("hook-add")).toBe(true);
		button(card, "Sign in")!.click();
		await vi.waitFor(() => expect(google.go).toHaveBeenCalledWith(SIGN_IN));
		expect(google.begin).toHaveBeenCalledTimes(1);
		expect(google.pause).not.toHaveBeenCalled();
	});

	it("shows a member who is no owner or admin the waiting line, without the sign-in", async () => {
		const { main, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "sign_in_again", broughtIn: 10, total: 10, lastWeek: 1 }));
		}, "contributor");
		await addresses(main, 2);
		const card = cardOf(main, hookIds[0]!)!;
		expect(card.querySelector(".hook-note")?.textContent).toBe("Google asked you to sign in again");
		expect(card.querySelector(".connection-actions button")).toBeNull();
	});

	it("says the newest 50,000 messages are here only when Google has more", async () => {
		const { main, fake, controller, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 50_000, total: 61_250, lastWeek: 4 }));
		});
		await addresses(main, 2);
		const state = () => cardOf(main, hookIds[0]!)!.querySelector(".hook-state")?.textContent ?? null;
		expect(state()).toBe("The newest 50,000 messages are here.");
		fake.addresses[0] = googleAddress({ state: "live", broughtIn: 50_000, total: 50_000, lastWeek: 4 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(state()).toBeNull());
		fake.addresses[0] = googleAddress({ state: "bringing_in", broughtIn: 20_000, total: 61_250, lastWeek: 4 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(state()).toBeNull());
	});
});

describe("answering Google mail", () => {
	it("replies from the Google address, as from any other", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 10, total: 10, lastWeek: 1 }));
			mail.threads = [summary(1, { address: GMAIL })];
		});
		await vi.waitFor(() => expect(main.querySelectorAll(".mailbox-row")).toHaveLength(1));
		main.querySelector<HTMLButtonElement>(".mailbox-row .mailbox-open")!.click();
		await vi.waitFor(() => expect(button(main, "Reply")).toBeDefined());
		button(main, "Reply")!.click();
		const reply = main.querySelector<HTMLFormElement>(".mailbox-reply-box")!;
		expect(reply.querySelector(".mailbox-from-address")?.textContent).toBe(`from ${GMAIL}`);
		const text = reply.querySelector("textarea")!;
		text.value = "Yes, the date can be woven in.";
		text.dispatchEvent(new Event("input", { bubbles: true }));
		reply.requestSubmit();
		await vi.waitFor(() =>
			expect(fake.calls.filter((call) => call.fn === "qorpera_send_member_mail")).toHaveLength(1),
		);
		const sent = fake.calls.find((call) => call.fn === "qorpera_send_member_mail")!.args.p_request as {
			from: string;
		};
		expect(sent.from).toBe(GMAIL);
	});
});
