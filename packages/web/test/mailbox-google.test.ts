// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyMail } from "../src/app/company-mail.ts";
import {
	type ExistingGoogleAccount,
	type MailboxManage,
	noteGoogleMailReturn,
	renderMailbox,
} from "../src/app/views/mailbox.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import type { HostedConnectorReturn } from "../src/cloud/connectors.ts";
import type { EventHook } from "../src/cloud/event-hooks.ts";
import { connectExistingGoogleMailbox, pauseGoogleMailbox, reusableGoogleMailAccounts } from "../src/cloud/mail.ts";
import type { HostedProfileRole } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { ADDRESS, accountsFake, ada, bo, cofounder, type MailFake, mailFake, summary } from "./mail-fixtures.ts";

const GMAIL = "hello@saml-bands.example";
const SIGN_IN = "https://accounts.google.com/o/oauth2/v2/auth?state=abc";
let finishing: () => Promise<unknown> = async () => GMAIL;

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
	finishing = async () => GMAIL;
	sessionStorage.clear();
	document.body.replaceChildren();
	location.hash = "";
	Reflect.deleteProperty(document, "visibilityState");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function googleAddress(google: Record<string, unknown>, address = GMAIL): Record<string, unknown> {
	return {
		address,
		hookId: id(950),
		status: "active",
		handledBy: [{ staffAgentId: bo.id, name: "Bo" }],
		routines: [],
		last7Days: 3,
		kind: "google",
		google,
	};
}

async function mailbox(
	setup: (fake: MailFake) => void,
	role: HostedProfileRole = "owner",
	extra?: {
		existing?: () => Promise<readonly ExistingGoogleAccount[]>;
		connectExisting?: (secretId: string, signal: AbortSignal) => Promise<unknown>;
	},
) {
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
		status: address.hookPaused ? "paused" : "active",
		email: String(address.address),
		createdAt: timestamp,
	}));
	const manage: MailboxManage = {
		hooks: {
			list: vi.fn(async () => [...hooks]),
			createHook: vi.fn(),
			createMailbox: vi.fn(),
			setStatus: vi.fn(async () => {}),
			mailHandles: vi.fn(async () => ({ domain: "mail.qorpera.com", handles: ["acme"] })),
			handleStatus: vi.fn(async () => "free" as const),
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
			finish: vi.fn(() => finishing()),
			pause: vi.fn(async () => {}),
			...(extra?.existing ? { existing: vi.fn(extra.existing) } : {}),
			...(extra?.connectExisting ? { connectExisting: vi.fn(extra.connectExisting) } : {}),
			go: vi.fn(),
		},
	};
	const draw = () => renderMailbox(main, controller, "mailbox", { manage: () => manage });
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return { f, controller, fake, main, manage, google: manage.google!, hooks, hookIds: hooks.map((hook) => hook.id) };
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

	it("keeps the row for owners and admins once a Google address is the company's, for one more account", async () => {
		const { main, google } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 900, total: 900, lastWeek: 38 }));
		});
		await addresses(main, 2);
		expect(texts(googleRow(main)!, "button")).toEqual(["Connect Google"]);
		button(googleRow(main)!, "Connect Google")!.click();
		button(googleRow(main)!, "Sign in at Google")!.click();
		await vi.waitFor(() => expect(google.go).toHaveBeenCalledWith(SIGN_IN));
		for (const dispose of cleanup.splice(0).reverse()) dispose();
		document.body.replaceChildren();
		const member = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 900, total: 900, lastWeek: 38 }));
		}, "contributor");
		await addresses(member.main, 2);
		expect(googleRow(member.main)).toBeNull();
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
		expect(vi.mocked(google.begin).mock.calls).toEqual([[expect.any(AbortSignal)]]);
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

	it("offers one-click bring-in for an already-connected company Gmail account on empty Inbox and Addresses", async () => {
		const existingSecret = id(980);
		const existingAddress = "jonas.mk@qorpera.com";
		const { main, fake, google, hooks } = await mailbox(
			(mail) => {
				mail.addresses = [];
			},
			"owner",
			{
				existing: async () => [{ secretId: existingSecret, address: existingAddress }],
				connectExisting: async () => {
					const entry = googleAddress(
						{ state: "bringing_in", broughtIn: 0, total: 120, lastWeek: 0 },
						existingAddress,
					);
					fake.addresses = [entry];
					hooks.push({
						id: id(950),
						name: "mail-google-1",
						purpose: `Google mail for ${existingAddress}`,
						proof: "mail",
						status: "active",
						email: existingAddress,
						createdAt: timestamp,
					});
					return {
						outcome: "linked",
						mailboxId: id(950),
						hookId: id(950),
						address: existingAddress,
						secretId: existingSecret,
					};
				},
			},
		);
		await vi.waitFor(() => expect(button(googleRow(main)!, `Bring in ${existingAddress}`)).toBeDefined());
		expect(googleRow(main)!.textContent).toContain(
			`${existingAddress} is connected in Company connections. Everyone in the company and your agents can read this mail.`,
		);
		button(googleRow(main)!, `Bring in ${existingAddress}`)!.click();
		await vi.waitFor(() =>
			expect(google.connectExisting).toHaveBeenCalledWith(existingSecret, expect.any(AbortSignal)),
		);
		await vi.waitFor(() => expect(topLine(main)?.textContent).toBe("Bringing in your mail from Google · 0 of 120"));
		await addresses(main, 1);
		expect(googleRow(main)!.querySelector(".mailbox-google-existing")).toBeNull();
	});

	it("shows a refusal inline when bringing in an existing company Gmail account fails", async () => {
		const existingSecret = id(981);
		const existingAddress = "taken@qorpera.com";
		const { main } = await mailbox(() => {}, "owner", {
			existing: async () => [{ secretId: existingSecret, address: existingAddress }],
			connectExisting: async () => {
				throw Object.assign(new Error("refused"), { reason: "address_taken" });
			},
		});
		await addresses(main, 1);
		await vi.waitFor(() => expect(button(googleRow(main)!, `Bring in ${existingAddress}`)).toBeDefined());
		button(googleRow(main)!, `Bring in ${existingAddress}`)!.click();
		await vi.waitFor(() =>
			expect(googleRow(main)!.querySelector(".mailbox-google-existing .mailbox-error")?.textContent).toBe(
				"This address is already brought in by another company.",
			),
		);
	});

	it("maps non-retryable RPC errors when bringing in an existing company Gmail account", async () => {
		const existingSecret = id(982);
		const existingAddress = "limit@qorpera.com";
		const rpcCases: [string, string, string, boolean][] = [
			[
				"54000",
				"A company has at most 20 mailboxes",
				"This company has reached its address limit. Remove an address first.",
				false,
			],
			["0A000", "Company mail is not set up yet", "Company mail is not set up yet.", false],
			[
				"22023",
				"This company has no such Gmail connection",
				"This Google connection can no longer be used here. Sign in with Google instead.",
				true,
			],
		];
		for (const [code, message, expected, hidesOffer] of rpcCases) {
			let now = 1_000_000;
			const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
			const { main, google } = await mailbox(() => {}, "owner", {
				existing: async () => [{ secretId: existingSecret, address: existingAddress }],
				connectExisting: async () => {
					throw new CloudRpcError("qorpera_connect_existing_google_mailbox", { message, code }, 400);
				},
			});
			await addresses(main, 1);
			await vi.waitFor(() => expect(button(googleRow(main)!, `Bring in ${existingAddress}`)).toBeDefined());
			button(googleRow(main)!, `Bring in ${existingAddress}`)!.click();
			await vi.waitFor(() => expect(googleRow(main)!.querySelector(".mailbox-error")?.textContent).toBe(expected));
			if (hidesOffer) {
				expect(googleRow(main)!.querySelector(".mailbox-google-existing")).toBeNull();
				expect(googleRow(main)!.querySelector(".mailbox-google-open")).not.toBeNull();
				const callsBefore = vi.mocked(google.existing!).mock.calls.length;
				now += 31_000;
				tab(main, "Inbox");
				tab(main, "Addresses");
				await vi.waitFor(() => expect(vi.mocked(google.existing!).mock.calls.length).toBeGreaterThan(callsBefore));
				expect(googleRow(main)!.querySelector(".mailbox-google-existing")).toBeNull();
			}
			for (const dispose of cleanup.splice(0).reverse()) dispose();
			document.body.replaceChildren();
			nowSpy.mockRestore();
		}
	});
});

describe("Google mailbox client helpers", () => {
	it("parses connected responses and throws structured refusal errors", async () => {
		const cloud = {
			rpc: vi
				.fn()
				.mockResolvedValueOnce({
					schema: "qorpera.google-mailbox-connected/v1",
					outcome: "linked",
					mailboxId: id(950),
					hookId: id(951),
					address: GMAIL,
					secretId: id(952),
				})
				.mockResolvedValueOnce({
					schema: "qorpera.google-mailbox-refused/v1",
					reason: "address_taken",
					message: "This address is already brought in by another company.",
				}),
		} as unknown as Cloud;
		await expect(connectExistingGoogleMailbox(cloud, id(11), id(952))).resolves.toEqual({
			outcome: "linked",
			mailboxId: id(950),
			hookId: id(951),
			address: GMAIL,
			secretId: id(952),
		});
		await expect(connectExistingGoogleMailbox(cloud, id(11), id(952))).rejects.toMatchObject({
			reason: "address_taken",
		});
	});

	it("filters reusable company Gmail accounts and excludes mailbox-owned, member, revoked, and non-email entries", () => {
		const accounts = reusableGoogleMailAccounts([
			{
				secretId: id(1),
				ownerKind: "company",
				connectorId: "gmail",
				status: "active",
				secretName: "primary",
				accountLabel: "jonas.mk@qorpera.com",
			},
			{
				secretId: id(2),
				ownerKind: "company",
				connectorId: "gmail",
				status: "active",
				secretName: "mailbox-a1b2c3d4e5",
				accountLabel: "hello@qorpera.com",
			},
			{
				secretId: id(3),
				ownerKind: "member",
				connectorId: "gmail",
				status: "active",
				secretName: "primary",
				accountLabel: "member@qorpera.com",
			},
			{
				secretId: id(4),
				ownerKind: "company",
				connectorId: "google_drive",
				status: "active",
				secretName: "primary",
				accountLabel: "drive@qorpera.com",
			},
			{
				secretId: id(5),
				ownerKind: "company",
				connectorId: "gmail",
				status: "revoked",
				secretName: "primary",
				accountLabel: "revoked@qorpera.com",
			},
			{
				secretId: id(6),
				ownerKind: "company",
				connectorId: "gmail",
				status: "active",
				secretName: "secondary",
				accountLabel: null,
			},
			{
				secretId: id(7),
				ownerKind: "company",
				connectorId: "gmail",
				status: "active",
				secretName: "label-only",
				accountLabel: "not-an-email",
			},
		]);
		expect(accounts).toEqual([{ secretId: id(1), address: "jonas.mk@qorpera.com" }]);
	});

	it("forwards abort signals on pauseGoogleMailbox and stops before calling rpc when aborted", async () => {
		const cloud = { rpc: vi.fn(async () => null) } as unknown as Cloud & { rpc: ReturnType<typeof vi.fn> };
		const live = new AbortController();
		await pauseGoogleMailbox(cloud, id(950), true, live.signal);
		expect(cloud.rpc).toHaveBeenCalledWith(
			"qorpera_pause_google_mailbox",
			{ p_mailbox_id: id(950), p_paused: true },
			live.signal,
		);
		const stopped = new AbortController();
		stopped.abort();
		await expect(pauseGoogleMailbox(cloud, id(950), false, stopped.signal)).rejects.toThrow();
		expect(cloud.rpc).toHaveBeenCalledTimes(1);
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
			target: "mailbox",
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

	const refusal = (main: HTMLElement) =>
		main.querySelector(".mailbox-google-open .mailbox-error, .mailbox-addresses .notice")?.textContent ?? null;
	const close = () => {
		for (const dispose of cleanup.splice(0).reverse()) dispose();
		document.body.replaceChildren();
	};

	it("says the broker's confirm refusals, wrong_account with the address the answer names", async () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ reason: "wrong_account", address: GMAIL }, `Sign in with ${GMAIL}.`],
			[{ reason: "wrong_account" }, "Sign in with the Google account this address belongs to."],
			[{ reason: "address_taken" }, "This address is already brought in by another company."],
		];
		for (const [answer, words] of cases) {
			finishing = async () => {
				throw Object.assign(new Error("The sign-in could not be finished."), answer);
			};
			noteGoogleMailReturn(outcome());
			const { main, google } = await mailbox((mail) => {
				mail.addresses.unshift(googleAddress({ state: "sign_in_again", broughtIn: 10, total: 10, lastWeek: 1 }));
			});
			await vi.waitFor(() => expect(refusal(main)).toBe(words));
			expect(google.finish).toHaveBeenCalledTimes(1);
			expect(main.querySelector('.mailbox-tab[aria-selected="true"]')?.textContent).toBe("Addresses");
			close();
		}
	});

	it("says each of the broker's refusals in the Mailbox's words", async () => {
		const cases: [HostedConnectorReturn, string][] = [
			[
				outcome({ connection: "failed", reason: "wrong_account" }),
				"Sign in with the Google account this address belongs to.",
			],
			[
				outcome({ connection: "failed", reason: "not_allowed" }),
				"Only founders and admins can add, pause or remove them.",
			],
			[
				outcome({ connection: "failed", reason: "declined" }),
				"Google was not given access. Nothing was brought in.",
			],
			[outcome({ connection: "failed", reason: "expired" }), "The sign-in took too long. Try again."],
			[
				outcome({ connection: "failed", reason: "somewhere_else" }),
				"Google mail could not be brought in. Try again.",
			],
		];
		for (const [back, words] of cases) {
			noteGoogleMailReturn(back);
			const { main } = await mailbox(() => {});
			await vi.waitFor(() => expect(refusal(main)).toBe(words));
			close();
		}
	});

	it("keeps the generic message when a fresh sign-in return fails with 22023", async () => {
		finishing = async () => {
			throw new CloudRpcError(
				"qorpera_complete_google_mailbox_capture",
				{ message: "bad ticket", code: "22023" },
				400,
			);
		};
		noteGoogleMailReturn(outcome());
		const { main } = await mailbox(() => {});
		await vi.waitFor(() => expect(refusal(main)).toBe("Google mail could not be brought in. Try again."));
		close();
	});

	it("says only owners and admins connect Google when the cloud refuses the start", async () => {
		const { main, google } = await mailbox(() => {});
		vi.mocked(google.begin).mockRejectedValueOnce(
			new CloudRpcError("qorpera_begin_google_mailbox", { message: "not_allowed", code: "42501" }, 403),
		);
		await addresses(main, 1);
		button(googleRow(main)!, "Connect Google")!.click();
		button(googleRow(main)!, "Sign in at Google")!.click();
		await vi.waitFor(() => expect(refusal(main)).toBe("Only founders and admins can add, pause or remove them."));
		expect(google.go).not.toHaveBeenCalled();
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
		fake.addresses[0] = googleAddress({ state: "bringing_in", broughtIn: 1240, total: 61_250, lastWeek: 0 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() =>
			expect(topLine(main)!.textContent).toBe("Bringing in your mail from Google · 1,240 of 50,000"),
		);
		fake.addresses[0] = googleAddress({ state: "bringing_in", broughtIn: 50_012, total: 61_250, lastWeek: 0 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(topLine(main)!.textContent).toBe("Bringing in your mail from Google · 50,012"));
		fake.addresses[0] = googleAddress({ state: "bringing_in", broughtIn: 3400, total: 201, lastWeek: 0 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(topLine(main)!.textContent).toBe("Bringing in your mail from Google · 3,400"));
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
		expect(fake.addresses[0]!.hookId).toBe(hookIds[0]);
		await vi.waitFor(() =>
			expect(google.pause).toHaveBeenCalledWith(fake.addresses[0]!.hookId, true, expect.any(AbortSignal)),
		);
		await vi.waitFor(() => expect(texts(card(), ".connection-actions button")).toEqual(["Resume", "Remove"]));
		expect(card().querySelector(".hook-state")?.textContent).toBe("Paused");
		button(card(), "Resume")!.click();
		await vi.waitFor(() => expect(google.pause).toHaveBeenLastCalledWith(hookIds[0], false, expect.any(AbortSignal)));
		expect(manage.hooks.setStatus).not.toHaveBeenCalled();
	});

	it("shows a Google mailbox paused at its hook as paused, with the hook's own Resume", async () => {
		const { main, manage, google, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift({
				...googleAddress({ state: "bringing_in", broughtIn: 10, total: 900, lastWeek: 1 }),
				status: "paused",
				hookPaused: true,
			});
			mail.threads = [summary(1)];
		});
		await vi.waitFor(() => expect(main.querySelectorAll(".mailbox-row")).toHaveLength(1));
		expect(topLine(main)).toBeNull();
		await addresses(main, 2);
		const card = () => cardOf(main, hookIds[0]!)!;
		expect(card().querySelector(".hook-state")?.textContent).toBe("Paused");
		expect(texts(card(), ".connection-actions button")).toEqual(["Resume", "Remove"]);
		button(card(), "Resume")!.click();
		await vi.waitFor(() =>
			expect(manage.hooks.setStatus).toHaveBeenCalledWith(hookIds[0], "active", expect.any(AbortSignal)),
		);
		expect(google.pause).not.toHaveBeenCalled();
	});

	it("keeps Sign in on a Google line paused at its hook while Google wants a new sign-in", async () => {
		const { main, google, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift({
				...googleAddress({ state: "sign_in_again", broughtIn: 10, total: 10, lastWeek: 1 }),
				status: "paused",
				hookPaused: true,
			});
		});
		await addresses(main, 2);
		const card = cardOf(main, hookIds[0]!)!;
		expect(card.querySelector(".hook-note")?.textContent).toBe("Google asked you to sign in again");
		expect(card.querySelector(".hook-state")?.textContent).toBe("Paused");
		expect(texts(card, ".connection-actions button")).toEqual(["Sign in", "Remove"]);
		button(card, "Sign in")!.click();
		await vi.waitFor(() => expect(google.go).toHaveBeenCalledWith(SIGN_IN));
		expect(vi.mocked(google.begin).mock.calls).toEqual([[expect.any(AbortSignal), hookIds[0]]]);
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
		expect(dialog().textContent).toContain(
			`Remove ${GMAIL}? Mail stops coming in from Google. The mail already brought in stays.`,
		);
		expect(dialog().textContent).not.toContain("Email sent to it afterwards");
		button(dialog(), "Remove")!.click();
		await vi.waitFor(() =>
			expect(manage.hooks.setStatus).toHaveBeenCalledWith(hookIds[0], "removed", expect.any(AbortSignal)),
		);
		expect(google.pause).not.toHaveBeenCalled();
	});

	it("keeps the usual question for removing an address that is not Google's", async () => {
		const { main, manage, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 10, total: 10, lastWeek: 1 }));
		});
		await addresses(main, 2);
		button(cardOf(main, hookIds[1]!)!, "Remove")!.click();
		await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
		expect(dialog().textContent).toContain(`Remove the mailbox ${ADDRESS.address}?`);
		expect(dialog().textContent).not.toContain("Mail stops coming in from Google");
		button(dialog(), "Remove")!.click();
		await vi.waitFor(() =>
			expect(manage.hooks.setStatus).toHaveBeenCalledWith(hookIds[1], "removed", expect.any(AbortSignal)),
		);
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
		expect(vi.mocked(google.begin).mock.calls).toEqual([[expect.any(AbortSignal), hookIds[0]]]);
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

	it("says the newest 50,000 messages are here exactly while a live mailbox is capped", async () => {
		const { main, fake, controller, hookIds } = await mailbox((mail) => {
			mail.addresses.unshift(
				googleAddress({ state: "live", broughtIn: 50_000, total: 61_250, lastWeek: 4, capped: true }),
			);
		});
		await addresses(main, 2);
		const state = () => cardOf(main, hookIds[0]!)!.querySelector(".hook-state")?.textContent ?? null;
		expect(state()).toBe("The newest 50,000 messages are here.");
		fake.addresses[0] = googleAddress({
			state: "live",
			broughtIn: 50_001,
			total: 61_000,
			lastWeek: 4,
			capped: false,
		});
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(state()).toBeNull());
		fake.addresses[0] = googleAddress({ state: "live", broughtIn: 2_000, total: 900, lastWeek: 4, capped: true });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(state()).toBe("The newest 50,000 messages are here."));
		fake.addresses[0] = googleAddress({ state: "live", broughtIn: 50_000, total: 61_250, lastWeek: 4 });
		await CompanyMail.of(controller)?.reread();
		await vi.waitFor(() => expect(state()).toBeNull());
		fake.addresses[0] = googleAddress({
			state: "bringing_in",
			broughtIn: 20_000,
			total: 61_250,
			lastWeek: 4,
			capped: true,
		});
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

	it("offers no files in a reply from a Google address, and says a refusal in the cloud's own words", async () => {
		const { main, fake } = await mailbox((mail) => {
			mail.addresses.unshift(googleAddress({ state: "live", broughtIn: 10, total: 10, lastWeek: 1 }));
			mail.threads = [summary(1, { address: GMAIL })];
			mail.sendError = { message: "Email sent from a Google address carries no attached files", code: "0A000" };
		});
		await vi.waitFor(() => expect(main.querySelectorAll(".mailbox-row")).toHaveLength(1));
		main.querySelector<HTMLButtonElement>(".mailbox-row .mailbox-open")!.click();
		await vi.waitFor(() => expect(button(main, "Reply")).toBeDefined());
		button(main, "Reply")!.click();
		const reply = main.querySelector<HTMLFormElement>(".mailbox-reply-box")!;
		expect(reply.querySelector('input[type="file"], [data-focus-key*="attach"]')).toBeNull();
		const text = reply.querySelector("textarea")!;
		text.value = "The photo follows by post.";
		text.dispatchEvent(new Event("input", { bubbles: true }));
		reply.requestSubmit();
		await vi.waitFor(() =>
			expect(main.querySelector(".mailbox-reply-box .mailbox-write-error")?.textContent).toBe(
				"Email sent from a Google address carries no attached files",
			),
		);
		expect(fake.calls.filter((call) => call.fn === "qorpera_send_member_mail")).toHaveLength(1);
	});
});
