// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HooksAccess, HooksView } from "../src/app/views/settings-hooks.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { createWebEventHooks, type EventHook, parseEventHook, type WebEventHooks } from "../src/cloud/event-hooks.ts";
import { deferred, id, settle, timestamp } from "./fixtures.ts";

const PROJECT_URL = "https://project.supabase.co";
const ADDRESS = "a".repeat(43);
const HOOK_URL = `${PROJECT_URL}/functions/v1/event-intake/${ADDRESS}`;

const webhook: EventHook = {
	id: id(61),
	name: "new-orders",
	purpose: "New orders from the shop",
	proof: "address",
	status: "active",
	url: HOOK_URL,
	createdAt: timestamp,
};
// An agent made it; Settings only shows it.
const stripe: EventHook = {
	id: id(62),
	name: "stripe-payments",
	purpose: "Payments from Stripe",
	proof: "stripe",
	status: "active",
	url: `${PROJECT_URL}/functions/v1/event-intake/${"b".repeat(43)}`,
	signingSecretReady: false,
	createdAt: timestamp,
};
const mailbox: EventHook = {
	id: id(63),
	name: "mail-invoices",
	purpose: "Invoices from suppliers",
	proof: "mail",
	status: "paused",
	email: "invoices@acme.example.com",
	createdAt: timestamp,
	lastReceivedAt: timestamp,
};

type HooksClientMock = Pick<WebEventHooks, "list" | "createHook" | "createMailbox" | "setStatus">;

const admin: HooksAccess = { canManage: () => true };

let view: HooksView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, "clipboard");
	vi.restoreAllMocks();
});

function setup(hooks: EventHook[] = [], access: HooksAccess = admin, configure?: (client: HooksClientMock) => void) {
	const state = { hooks: structuredClone(hooks) };
	const client: HooksClientMock = {
		list: vi.fn(async () => structuredClone(state.hooks)),
		createHook: vi.fn(async (name: string, purpose: string) => {
			const hook: EventHook = { ...webhook, id: id(70), name, purpose };
			state.hooks.push(hook);
			return structuredClone(hook);
		}),
		createMailbox: vi.fn(async (localPart: string, purpose: string) => {
			const hook: EventHook = {
				id: id(71),
				name: `mail-${localPart}`,
				purpose,
				proof: "mail",
				status: "active",
				email: `${localPart}@acme.example.com`,
				createdAt: timestamp,
			};
			state.hooks.push(hook);
			return structuredClone(hook);
		}),
		setStatus: vi.fn(async (hookId: string, status: string) => {
			if (status === "removed") state.hooks = state.hooks.filter((hook) => hook.id !== hookId);
			else for (const hook of state.hooks) if (hook.id === hookId) hook.status = status as EventHook["status"];
		}),
	};
	configure?.(client);
	view = new HooksView(client, new AbortController().signal, { access });
	document.body.append(view.el);
	return { client, state };
}

const section = (kind: "webhook" | "mailbox") => view!.el.querySelector<HTMLElement>(`[data-hooks="${kind}"]`)!;
const cardOf = (hookId: string) => view?.el.querySelector<HTMLElement>(`[data-hook="${hookId}"]`) ?? null;
const ids = (root: HTMLElement) =>
	[...root.querySelectorAll<HTMLElement>("[data-hook]")].map((card) => card.dataset.hook);
const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const labels = (root: Element) => buttons(root).map((item) => item.textContent);
const press = (root: Element, label: string) =>
	buttons(root)
		.find((item) => item.textContent === label)!
		.click();
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].at(-1)!;

/** Opens a kind's form, fills it in and submits it. */
function add(kind: "webhook" | "mailbox", name: string, purpose: string): void {
	if (!view?.el.querySelector(`#hook-form-${kind}`))
		press(section(kind), kind === "webhook" ? "Add webhook" : "Add mailbox");
	const form = view!.el.querySelector<HTMLFormElement>(`#hook-form-${kind}`)!;
	const fields = form.querySelectorAll<HTMLInputElement>("input");
	for (const [index, value] of [name, purpose].entries()) {
		fields[index]!.value = value;
		fields[index]!.dispatchEvent(new Event("input"));
	}
	form.requestSubmit();
}

describe("webhooks and mailboxes", () => {
	it("lists webhooks and mailboxes apart, and shows an owner each webhook's address to copy", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		setup([webhook, stripe, mailbox]);
		await settle();
		expect(ids(section("webhook"))).toEqual([webhook.id, stripe.id]);
		expect(ids(section("mailbox"))).toEqual([mailbox.id]);

		const shop = cardOf(webhook.id)!;
		expect(shop.querySelector("strong")?.textContent).toBe("new-orders");
		expect(shop.textContent).toContain("New orders from the shop");
		expect(shop.querySelector(".hook-state")?.textContent).toBe("Active · No events yet");
		expect(shop.querySelector("code")?.textContent).toBe(HOOK_URL);
		expect(shop.textContent).toContain("Anyone with this address can send to it.");
		expect(labels(shop)).toEqual(["Pause", "Remove", "Copy"]);

		// A signed webhook (an agent's) waits for its sender's secret; its address alone proves nothing.
		const payments = cardOf(stripe.id)!;
		expect(payments.querySelector(".hook-state")?.textContent).toBe(
			"Waiting for its signing secret · No events yet · Signed by Stripe",
		);
		expect(payments.textContent).not.toContain("Anyone with this address");

		// A mailbox goes by its email address and has no URL.
		const invoices = cardOf(mailbox.id)!;
		expect(invoices.querySelector("strong")?.textContent).toBe("invoices@acme.example.com");
		expect(invoices.querySelector(".hook-state")?.textContent).toMatch(/^Paused · Last email /);
		expect(invoices.querySelector("code")).toBeNull();
		expect(labels(invoices)).toEqual(["Resume", "Remove"]);

		press(shop, "Copy");
		await settle();
		expect(writeText).toHaveBeenCalledWith(HOOK_URL);
		expect(cardOf(webhook.id)?.textContent).toContain("The address is copied.");
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`hook-copy:${webhook.id}`);

		writeText.mockRejectedValueOnce(new Error("denied"));
		press(cardOf(webhook.id)!, "Copy");
		await settle();
		expect(cardOf(webhook.id)?.textContent).toContain("The address could not be copied. Select it and copy it.");
	});

	it("shows other members names, purposes and states, without addresses or actions", async () => {
		const role = { manage: false };
		setup([webhook, mailbox], { canManage: () => role.manage });
		await settle();
		expect(section("webhook").textContent).toContain("Only founders and admins can add, pause or remove them.");
		expect(buttons(view!.el)).toEqual([]);
		expect(view!.el.querySelector("code")).toBeNull();
		expect(cardOf(webhook.id)?.textContent).toContain("New orders from the shop");
		expect(cardOf(mailbox.id)?.textContent).toContain("invoices@acme.example.com");

		// The role arrives (or changes) after the page: it redraws with the actions.
		role.manage = true;
		view?.update();
		expect(labels(cardOf(webhook.id)!)).toEqual(["Pause", "Remove", "Copy"]);
		expect(labels(section("mailbox"))).toContain("Add mailbox");
		expect(view!.el.textContent).not.toContain("Only founders and admins");
	});

	it("reads the list again when a member becomes an owner or admin, for each webhook's address", async () => {
		const role = { manage: false };
		// The kernel sends a webhook's address only to an owner or admin.
		const { url: _, ...unaddressed } = webhook;
		const { client, state } = setup([unaddressed, mailbox], { canManage: () => role.manage });
		await settle();
		expect(client.list).toHaveBeenCalledTimes(1);

		state.hooks = structuredClone([webhook, mailbox]);
		role.manage = true;
		view?.update();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(cardOf(webhook.id)?.querySelector("code")?.textContent).toBe(HOOK_URL);
		expect(labels(cardOf(webhook.id)!)).toEqual(["Pause", "Remove", "Copy"]);
	});

	it("pauses and resumes a hook, keeping focus on its button", async () => {
		const { client } = setup([webhook]);
		await settle();
		const pause = buttons(cardOf(webhook.id)!).find((item) => item.textContent === "Pause")!;
		pause.focus();
		pause.click();
		expect(labels(cardOf(webhook.id)!)).toContain("Working…");
		await settle();
		expect(client.setStatus).toHaveBeenCalledWith(webhook.id, "paused", expect.any(AbortSignal));
		expect(cardOf(webhook.id)?.querySelector(".hook-state")?.textContent).toBe("Paused · No events yet");
		expect(document.activeElement?.textContent).toBe("Resume");

		press(cardOf(webhook.id)!, "Resume");
		await settle();
		expect(client.setStatus).toHaveBeenLastCalledWith(webhook.id, "active", expect.any(AbortSignal));
		expect(cardOf(webhook.id)?.querySelector(".hook-state")?.textContent).toBe("Active · No events yet");
	});

	it("removes a hook only after the member confirms", async () => {
		const { client } = setup([webhook, mailbox]);
		await settle();
		press(cardOf(webhook.id)!, "Remove");
		expect(dialog().textContent).toContain(
			"Remove the webhook new-orders? Anything sent to its address afterwards is turned away.",
		);
		press(dialog(), "Cancel");
		await settle();
		expect(client.setStatus).not.toHaveBeenCalled();
		expect(cardOf(webhook.id)).not.toBeNull();

		press(cardOf(webhook.id)!, "Remove");
		press(dialog(), "Remove");
		await settle();
		expect(client.setStatus).toHaveBeenCalledWith(webhook.id, "removed", expect.any(AbortSignal));
		expect(cardOf(webhook.id)).toBeNull();
		expect(section("webhook").textContent).toContain("No webhooks yet.");
		expect(cardOf(mailbox.id)).not.toBeNull();
		expect(document.activeElement?.textContent).toBe("Add webhook");
	});

	it("says why a change was refused, and lets a hook removed elsewhere drop out", async () => {
		const { client, state } = setup([webhook, stripe]);
		await settle();
		vi.mocked(client.setStatus).mockRejectedValueOnce(
			new CloudRpcError("qorpera_set_event_hook_status", { message: "denied", code: "42501" }),
		);
		press(cardOf(webhook.id)!, "Pause");
		await settle();
		expect(cardOf(webhook.id)?.textContent).toContain("Only founders and admins can add, pause or remove them.");

		state.hooks = state.hooks.filter((hook) => hook.id !== stripe.id);
		vi.mocked(client.setStatus).mockRejectedValueOnce(
			new CloudRpcError("qorpera_set_event_hook_status", { message: "This hook was removed", code: "55000" }),
		);
		press(cardOf(stripe.id)!, "Pause");
		await settle();
		expect(cardOf(stripe.id)).toBeNull();
		expect(view!.el.querySelector(".service-outcome")).toBeNull();
	});

	it("adds an address-proven webhook and shows its address at once", async () => {
		const { client } = setup();
		await settle();
		expect(section("webhook").textContent).toContain("No webhooks yet.");
		press(section("webhook"), "Add webhook");
		const nameField = view!.el.querySelector<HTMLInputElement>("#hook-form-webhook input")!;
		expect(document.activeElement).toBe(nameField);
		add("webhook", " New-Orders ", " New orders from the shop ");
		expect(labels(section("webhook"))).toContain("Adding…");
		await settle();
		expect(client.createHook).toHaveBeenCalledWith("new-orders", "New orders from the shop", expect.any(AbortSignal));
		const created = cardOf(id(70))!;
		expect(created.textContent).toContain(
			"The webhook is ready. Give its address to the service that sends the events.",
		);
		expect(created.querySelector("code")?.textContent).toBe(HOOK_URL);
		expect(view!.el.querySelector("#hook-form-webhook")).toBeNull();
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`hook-copy:${id(70)}`);
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it("reads once more after a change made while a read was out, so the change shows", async () => {
		const { client, state } = setup([webhook]);
		await settle();
		// The read after adding a webhook is still out when the member pauses another one: it saw the hook active.
		const read = deferred<EventHook[]>();
		vi.mocked(client.list).mockImplementationOnce(() => read.promise);
		add("webhook", "forms", "Form posts");
		await settle();
		const before = structuredClone(state.hooks);
		press(cardOf(webhook.id)!, "Pause");
		await settle();
		expect(client.setStatus).toHaveBeenCalledWith(webhook.id, "paused", expect.any(AbortSignal));
		read.resolve(before);
		await settle();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(3);
		expect(cardOf(webhook.id)?.querySelector(".hook-state")?.textContent).toBe("Paused · No events yet");
		expect(cardOf(id(70))).not.toBeNull();
	});

	it("checks a webhook's name and purpose before asking, and says why the kernel refused", async () => {
		const { client } = setup([], admin, (client) => {
			vi.mocked(client.createHook).mockRejectedValueOnce(
				new CloudRpcError("qorpera_create_event_hook", {
					message: "A hook with this name already exists",
					code: "23505",
				}),
			);
		});
		await settle();
		const form = () => view!.el.querySelector<HTMLElement>("#hook-form-webhook")!;

		const fields = () => [...form().querySelectorAll<HTMLInputElement>("input")];

		add("webhook", "mail-orders", "Orders");
		await settle();
		expect(form().textContent).toContain("Names beginning with mail- belong to mailboxes.");
		expect(document.activeElement).toBe(fields()[0]);

		add("webhook", "9-orders", "Orders");
		await settle();
		expect(form().textContent).toContain(
			"A webhook name is lowercase letters, digits and hyphens, and starts with a letter.",
		);

		add("webhook", "orders", "  ");
		await settle();
		expect(form().textContent).toContain("Say what it is for, in one line.");
		expect(document.activeElement).toBe(fields()[1]);
		expect(client.createHook).not.toHaveBeenCalled();

		add("webhook", "orders", "Orders");
		await settle();
		expect(client.createHook).toHaveBeenCalledWith("orders", "Orders", expect.any(AbortSignal));
		expect(form().textContent).toContain("A webhook with this name already exists.");
		// The form stays open with what was typed.
		expect(fields().map((field) => field.value)).toEqual(["orders", "Orders"]);

		press(form(), "Cancel");
		expect(view!.el.querySelector("#hook-form-webhook")).toBeNull();
		expect(document.activeElement?.textContent).toBe("Add webhook");
	});

	it("adds a mailbox at the company's mail domain, and says when company mail is not set up", async () => {
		const { client } = setup([mailbox], admin, (client) => {
			vi.mocked(client.createMailbox)
				.mockRejectedValueOnce(
					new CloudRpcError("qorpera_create_company_mailbox", {
						message: "Company mail is not set up yet",
						code: "0A000",
					}),
				)
				.mockRejectedValueOnce(
					new CloudRpcError("qorpera_create_company_mailbox", {
						message: "This mailbox name is reserved",
						code: "22023",
					}),
				);
		});
		await settle();
		press(section("mailbox"), "Add mailbox");
		expect(view!.el.querySelector("#hook-form-mailbox .hook-domain")?.textContent).toBe("@acme.example.com");

		add("mailbox", "orders", "Orders by email");
		await settle();
		expect(section("mailbox").textContent).toContain("Company mail is not set up yet.");

		add("mailbox", "postmaster", "Bounces");
		await settle();
		expect(section("mailbox").textContent).toContain("This mailbox name is reserved. Choose another.");

		add("mailbox", "a..b", "Orders by email");
		await settle();
		expect(section("mailbox").textContent).toContain(
			"A mailbox name is lowercase letters, digits, dots, hyphens and underscores, and starts and ends with a letter or digit.",
		);
		expect(client.createMailbox).toHaveBeenCalledTimes(2);

		add("mailbox", "orders", "Orders by email");
		await settle();
		expect(client.createMailbox).toHaveBeenLastCalledWith("orders", "Orders by email", expect.any(AbortSignal));
		expect(ids(section("mailbox"))).toEqual([mailbox.id, id(71)]);
		expect(cardOf(id(71))?.textContent).toContain("The mailbox is ready.");
		expect(cardOf(id(71))?.querySelector("strong")?.textContent).toBe("orders@acme.example.com");
	});

	it("shows a failed read with a way to try again", async () => {
		const { client } = setup([webhook], admin, (client) => {
			vi.mocked(client.list).mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		expect(view!.el.querySelector('[role="alert"]')?.textContent).toContain(
			"The company's webhooks and mailboxes could not be read.",
		);
		expect(view!.el.querySelector("[data-hooks]")).toBeNull();
		press(view!.el, "Try again");
		expect(section("webhook").textContent).toContain("Checking…");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(view!.el.querySelector('[role="alert"]')).toBeNull();
		expect(ids(section("webhook"))).toEqual([webhook.id]);
	});
});

describe("event hook client", () => {
	const profile = { profileId: id(10), environmentId: id(11) };
	const descriptor = (extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.event-hook/v1",
		id: id(61),
		companyId: id(10),
		environmentId: id(11),
		name: "new-orders",
		purpose: "New orders from the shop",
		proof: "address",
		status: "active",
		path: `/functions/v1/event-intake/${ADDRESS}`,
		maxBodyBytes: 262144,
		perMinute: 60,
		createdAt: timestamp,
		lastReceivedAt: null,
		...extra,
	});
	function cloudWith(rpc: (name: string, args: Record<string, unknown>) => unknown) {
		return {
			config: { projectUrl: PROJECT_URL },
			rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)),
		} as unknown as Cloud & { rpc: ReturnType<typeof vi.fn> };
	}

	it("reads a webhook's URL from its path under the project, and a mailbox's email only", () => {
		expect(parseEventHook(descriptor(), PROJECT_URL)).toEqual(webhook);
		expect(parseEventHook(descriptor({ path: "/functions/v1/other/abc" }), PROJECT_URL).url).toBeUndefined();
		// A member's list has no path at all.
		expect(parseEventHook(descriptor({ path: undefined }), PROJECT_URL)).not.toHaveProperty("url");
		const mail = parseEventHook(
			descriptor({ proof: "mail", email: "invoices@acme.example.com", lastReceivedAt: timestamp }),
			PROJECT_URL,
		);
		expect(mail).toMatchObject({ email: "invoices@acme.example.com", lastReceivedAt: timestamp });
		expect(mail).not.toHaveProperty("url");
		expect(parseEventHook(descriptor({ email: "x@example.com" }), PROJECT_URL)).not.toHaveProperty("email");
		expect(
			parseEventHook(
				descriptor({
					proof: "stripe",
					signingSecret: { connectorId: "stripe", secretName: "webhook", ready: false },
				}),
				PROJECT_URL,
			).signingSecretReady,
		).toBe(false);
		expect(() => parseEventHook(descriptor({ status: "removed" }), PROJECT_URL)).toThrow("Invalid hook.");
		expect(() => parseEventHook(descriptor({ schema: "qorpera.event-hook/v2" }), PROJECT_URL)).toThrow(
			"Invalid hook.",
		);
	});

	it("lists, adds address-proven webhooks and mailboxes, and changes a hook's status", async () => {
		const cloud = cloudWith((name) =>
			name === "qorpera_list_event_hooks"
				? [descriptor()]
				: name === "qorpera_set_event_hook_status"
					? null
					: descriptor(),
		);
		const hooks = createWebEventHooks(cloud, profile);
		expect(await hooks.list()).toEqual([webhook]);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_list_event_hooks", {
			p_profile_id: id(10),
			p_environment_id: id(11),
		});
		await hooks.createHook("new-orders", "New orders from the shop");
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_create_event_hook", {
			p_profile_id: id(10),
			p_environment_id: id(11),
			p_name: "new-orders",
			p_purpose: "New orders from the shop",
			p_proof: "address",
		});
		await hooks.createMailbox("invoices", "Invoices from suppliers");
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_create_company_mailbox", {
			p_profile_id: id(10),
			p_environment_id: id(11),
			p_local_part: "invoices",
			p_purpose: "Invoices from suppliers",
		});
		await hooks.setStatus(id(61), "removed");
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_set_event_hook_status", {
			p_hook_id: id(61),
			p_status: "removed",
		});
		cloud.rpc.mockClear();
		await expect(hooks.setStatus("not-a-hook", "paused")).rejects.toThrow("Invalid hook.");
		expect(cloud.rpc).not.toHaveBeenCalled();
	});

	it("refuses a malformed list and a malformed company", async () => {
		await expect(
			createWebEventHooks(
				cloudWith(() => ({})),
				profile,
			).list(),
		).rejects.toThrow("Invalid hooks.");
		expect(() =>
			createWebEventHooks(
				cloudWith(() => []),
				{ ...profile, environmentId: "main" },
			),
		).toThrow("Invalid company for hooks.");
	});
});
