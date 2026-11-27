// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ADDRESS_POLL_MS,
	ADDRESS_RECHECK_GAP_MS,
	ADDRESS_SECURING_MS,
	ADDRESS_SLUG_CHECK_MS,
	type AddressMark,
	SurfaceAddress,
	type SurfaceAddressSetup,
} from "../src/app/views/surface-address-sheet.ts";
import { APPROVE_ARM_MS } from "../src/app/views/surface-session-drawer.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { h } from "../src/ui/dom.ts";
import { settle } from "./fixtures.ts";
import { fakeSiteHosting, HOSTED_SITE, type HostingWorld, siteDomain } from "./surface-fixtures.ts";

const LIVE_URL = "https://thetaband.qorpera.com/";

afterEach(() => {
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, "clipboard");
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function mount(
	world: Partial<HostingWorld> = {},
	manage = true,
	hooks: Pick<SurfaceAddressSetup, "beforePublic" | "publicChanged" | "slugChanged" | "codeSource"> = {},
	liveUrl = LIVE_URL,
) {
	const container = h("div", { class: "surface-canvas" });
	document.body.append(container);
	const controller = new AbortController();
	const hosting = fakeSiteHosting(world);
	const address = new SurfaceAddress({
		container,
		canManage: () => manage,
		changed: () => {
			const shown = container.querySelector(".surface-pill-address");
			const next = address.button();
			if (shown && next) shown.replaceWith(next);
		},
		signal: controller.signal,
		...hooks,
	});
	const target = { siteId: HOSTED_SITE, client: hosting.client };
	address.sync(true, target, liveUrl);
	container.prepend(address.button()!);
	return { address, container, controller, target, ...hosting };
}

const sheet = () => document.querySelector<HTMLElement>(".surface-address-sheet")!;
const bar = () => document.querySelector<HTMLButtonElement>(".surface-pill-address")!;
const go = () => sheet().querySelector<HTMLButtonElement>(".surface-address-go");
const name = () => sheet().querySelector(".surface-address-name")?.textContent;
const title = () => sheet().querySelector(".surface-address-title")?.textContent;
const quiet = () => [...sheet().querySelectorAll(".surface-address-quiet")].map((item) => item.textContent);
const groups = () =>
	[...sheet().querySelectorAll(".surface-address-rows")].map((group) =>
		[...group.querySelectorAll(".surface-address-row, .surface-address-row-note")].map((row) => {
			const label = row.querySelector(".surface-address-row-label")?.textContent ?? row.textContent;
			const end = row.querySelector(".surface-address-row-end")?.textContent;
			return end ? `${label} | ${end}` : label;
		}),
	);
const row = (label: string) =>
	[...sheet().querySelectorAll<HTMLElement>(".surface-address-row")].find(
		(item) => item.querySelector(".surface-address-row-label")?.textContent === label,
	)!;
const press = (label: string) => row(label).click();
const back = () => sheet().querySelector<HTMLButtonElement>(".surface-address-back")!.click();
const problem = () => sheet().querySelector(".surface-address-problem")?.textContent;
const field = () => sheet().querySelector<HTMLInputElement>(".surface-address-input");
const submit = (text: string) => {
	field()!.value = text;
	sheet()
		.querySelector("form")!
		.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
};
const records = () =>
	[...sheet().querySelectorAll(".surface-address-record")].map((item) => [
		item.querySelector(".surface-address-chip")?.textContent,
		item.querySelector(".surface-address-record-what, .surface-address-record-wrong")?.textContent,
		...[...item.querySelectorAll(".surface-address-fields > span")].map((cell) => cell.textContent).filter(Boolean),
	]);
const line = () => sheet().querySelector(".surface-address-line")?.textContent;
const hints = () => [...sheet().querySelectorAll(".surface-address-hint")].map((item) => item.textContent);
const refusal = (message: string, code = "42501") => new CloudRpcError("rpc", { message, code });
const changing = () =>
	sheet().querySelectorAll(
		".surface-address-go, .surface-address-input, .surface-address-slug-input, [data-key='edit-slug'], [data-key='add'], [data-key='remove'], [data-key='not-live']",
	).length;
const editButton = () => sheet().querySelector<HTMLButtonElement>("[data-key='edit-slug']");
const slugField = () => sheet().querySelector<HTMLInputElement>(".surface-address-slug-input");
const slugSuffix = () => sheet().querySelector<HTMLElement>(".surface-address-slug-suffix")?.textContent;
const availability = () => sheet().querySelector<HTMLElement>(".surface-address-availability");
const saveSlugButton = () => sheet().querySelector<HTMLButtonElement>("[data-key='save-slug']");

async function opened(
	world: Partial<HostingWorld> = {},
	manage = true,
	hooks: Pick<SurfaceAddressSetup, "beforePublic" | "publicChanged" | "slugChanged"> = {},
	liveUrl = LIVE_URL,
) {
	const mounted = mount(world, manage, hooks, liveUrl);
	await settle();
	mounted.address.open();
	await settle();
	return mounted;
}

async function goLive() {
	go()!.click();
	go()!.click();
	await settle();
}

describe("the address card before the site is public", () => {
	it("is only the address, Go live and Use your own domain", async () => {
		const { address } = await opened();
		expect(address.mark()).toBe<AddressMark>("private");
		expect(sheet().getAttribute("role")).toBe("dialog");
		expect(name()).toBe("thetaband.qorpera.com");
		expect(sheet().querySelector(".surface-address-name span")?.textContent).toBe(".qorpera.com");
		expect(go()?.textContent).toBe("Go live");
		expect(groups()).toEqual([["Use your own domain"]]);
		expect(quiet()).toEqual([]);
		expect(sheet().querySelector("a")).toBeNull();
		expect(sheet().textContent).not.toMatch(/password|Only you|Live\b/);
	});

	it("greys the platform's domain of an address on qorpera.site as it does on qorpera.com", async () => {
		await opened({}, true, {}, "https://thetaband.qorpera.site/");
		expect(name()).toBe("thetaband.qorpera.site");
		expect(sheet().querySelector(".surface-address-name span")?.textContent).toBe(".qorpera.site");
	});

	it("goes live only on a second press, which turns the button green and says Confirm in the same box", async () => {
		const { address, client } = await opened();
		const before = go()!;
		before.click();
		expect(client.setPublic).not.toHaveBeenCalled();
		const armed = go()!;
		expect(armed.classList.contains("is-confirming")).toBe(true);
		expect(armed.dataset.armed).toBe("true");
		expect(armed.textContent).toBe("Confirm");
		const faces = [...armed.querySelectorAll<HTMLElement>(".surface-approve-face")];
		expect(faces.map((face) => [face.textContent, face.dataset.text ?? ""])).toEqual([
			["", "Go live"],
			["Confirm", ""],
		]);
		expect(before.querySelectorAll(".surface-approve-face").length).toBe(2);
		expect(armed.className.replace(" is-confirming", "")).toBe(before.className);

		armed.click();
		expect(client.setPublic).toHaveBeenCalledTimes(1);
		expect(client.setPublic).toHaveBeenCalledWith(HOSTED_SITE, true, expect.any(AbortSignal));
		expect(address.mark()).toBe("live");
		await settle();
		expect(go()).toBeNull();
		expect(groups()).toEqual([["Open the site", "Copy link"], ["Use your own domain"], ["Make it not live"]]);
		expect(bar().classList.contains("is-live")).toBe(true);
	});

	it("waits for what must happen first, then goes public and says so; a refusal first keeps it private", async () => {
		const steps: string[] = [];
		let finish: (ready: boolean) => void = () => undefined;
		const beforePublic = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					steps.push("before");
					finish = resolve;
				}),
		);
		const publicChanged = vi.fn((isPublic: boolean) => steps.push(`changed:${isPublic}`));
		const { address, client, world } = await opened({}, true, { beforePublic, publicChanged });
		client.setPublic.mockImplementation(async (_siteId: string, isPublic: boolean) => {
			steps.push(`public:${isPublic}`);
			if (world.entry) world.entry.isPublic = isPublic;
			return isPublic;
		});
		const confirm = go()!.className;
		await goLive();
		expect(steps).toEqual(["before"]);
		expect(address.mark()).toBe("private");
		expect(address.isWriting).toBe(true);
		expect(bar().classList.contains("is-private")).toBe(true);
		const going = go()!;
		expect(going.textContent).toBe("Going live…");
		expect(going.disabled).toBe(true);
		expect(going.className).toBe(`${confirm} is-going`);
		going.click();
		address.close();
		expect(beforePublic).toHaveBeenCalledTimes(1);
		finish(true);
		await settle();
		expect(steps).toEqual(["before", "public:true", "changed:true"]);
		expect(address.mark()).toBe("live");
		expect(address.isWriting).toBe(false);
		address.open();
		await settle();
		press("Make it not live");
		await settle();
		expect(steps).toEqual(["before", "public:true", "changed:true", "public:false", "changed:false"]);
		expect(beforePublic).toHaveBeenCalledTimes(1);

		await goLive();
		finish(false);
		await settle();
		expect(client.setPublic).toHaveBeenCalledTimes(2);
		expect(publicChanged).toHaveBeenCalledTimes(2);
		expect(address.mark()).toBe("private");
		expect(problem()).toBe("The site did not go live. Try again.");
		expect(go()?.textContent).toBe("Go live");
		expect(go()?.disabled).toBe(false);
		expect(address.isWriting).toBe(false);
	});

	it("lets go of Confirm on its own after a while and on a press anywhere else", async () => {
		vi.useFakeTimers();
		const { client, address } = mount();
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		go()!.click();
		await vi.advanceTimersByTimeAsync(APPROVE_ARM_MS);
		expect(go()!.textContent).toBe("Go live");
		go()!.click();
		expect(go()!.textContent).toBe("Confirm");
		const other = row("Use your own domain");
		other.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(go()!.textContent).toBe("Go live");
		expect(row("Use your own domain")).toBe(other);
		go()!.click();
		go()!.click();
		expect(client.setPublic).toHaveBeenCalledTimes(1);
	});

	it("says a site with no row in the hosting list yet can go live once its first version is ready", async () => {
		const { address } = await opened({ entry: null });
		expect(address.mark()).toBe("private");
		expect(quiet()).toEqual(["It can go live once its first version is ready."]);
		expect(go()).toBeNull();
		expect(groups()).toEqual([]);
	});

	it("says plainly when sites cannot go live or take a domain yet, where the button or row would be", async () => {
		await opened({ publicEnabled: false });
		expect(go()).toBeNull();
		expect(quiet()).toEqual(["Sites cannot go live for everyone yet."]);
		expect(groups()).toEqual([["Use your own domain"]]);
		document.body.replaceChildren();
		await opened({ domainsEnabled: false, entry: { isPublic: true, domains: [] } });
		expect(groups()).toEqual([
			["Open the site", "Copy link"],
			["Your own domain cannot be added yet."],
			["Make it not live"],
		]);
	});
});

describe("the address card once the site is public", () => {
	it("opens the site in a new tab, copies its link, and makes it not live on one press", async () => {
		const writeText = vi.fn(async (_text: string) => undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const { client, address } = await opened({ entry: { isPublic: true, domains: [] } });
		const open = row("Open the site") as HTMLAnchorElement;
		expect(open.tagName).toBe("A");
		expect(open.href).toBe(LIVE_URL);
		expect(open.target).toBe("_blank");

		press("Copy link");
		await settle();
		expect(writeText).toHaveBeenLastCalledWith(LIVE_URL);
		expect(sheet().querySelector("[data-key='copy'] .surface-address-row-label")?.textContent).toBe("Copied");

		sheet().querySelector<HTMLElement>("[data-key='not-live']")!.click();
		expect(client.setPublic).toHaveBeenCalledWith(HOSTED_SITE, false, expect.any(AbortSignal));
		expect(address.mark()).toBe("private");
		expect(go()?.textContent).toBe("Go live");
		expect(sheet().textContent).not.toContain("Take offline");
	});

	it("says what to press when the browser refuses to copy the link", async () => {
		await opened({ entry: { isPublic: true, domains: [] } });
		press("Copy link");
		await settle();
		expect(problem()).toMatch(/^Press (⌘C|Ctrl\+C) to copy\.$/);
		expect(window.getSelection()?.toString()).toBe("thetaband.qorpera.com");
	});
});

describe("your own domain", () => {
	it("is offered before the site is public, and Connect lands on the by-hand page", async () => {
		const { client, address } = await opened();
		press("Use your own domain");
		expect(title()).toBe("Your own domain");
		expect(field()?.placeholder).toBe("yourdomain.com");
		expect(document.activeElement).not.toBe(field());
		submit("  https://WWW.Thetaband.dk/shop ");
		expect(client.addDomain).toHaveBeenCalledWith(HOSTED_SITE, "www.thetaband.dk", false, expect.any(AbortSignal));
		expect(title()).toBe("www.thetaband.dk");
		await settle();
		expect(title()).toBe("www.thetaband.dk");
		expect(line()).toBe("Open the DNS settings where you bought thetaband.dk and create these two records.");
		expect(records()).toEqual([
			["CNAME", "points www.thetaband.dk to your website", "Hostname", "www", "Value", "edge.qorpera.com"],
			["TXT", "shows the domain is yours", "Hostname", "_qorpera.www", "Value", "qorpera-verify=9f3a1c"],
		]);
		expect(hints()).toEqual(["Some shops call Hostname “Name” or “Host”. The shop adds “.thetaband.dk” by itself."]);
		expect(groups()).toEqual([["Copy as a message for someone else", "Remove www.thetaband.dk"]]);
		expect(address.mark()).toBe("private");

		back();
		expect(groups()).toEqual([["www.thetaband.dk | Add the lines"]]);
		expect(go()?.textContent).toBe("Go live");
		expect(name()).toBe("thetaband.qorpera.com");
		expect(bar().textContent).toBe("thetaband.qorpera.com");
	});

	it("names an apex domain's three lines", async () => {
		await opened({ entry: { isPublic: true, domains: [siteDomain("thetaband.dk")] } });
		press("thetaband.dk");
		expect(line()).toBe("Open the DNS settings where you bought thetaband.dk and create these three records.");
		expect(records()).toEqual([
			["A", "points thetaband.dk to your website", "Hostname", "leave empty", "Value", "203.0.113.7"],
			["AAAA", "also points thetaband.dk to your website", "Hostname", "leave empty", "Value", "2001:db8::7"],
			["TXT", "shows the domain is yours", "Hostname", "_qorpera", "Value", "qorpera-verify=9f3a1c"],
		]);
		expect(sheet().querySelectorAll(".surface-address-copy").length).toBe(4);
	});

	it("copies a line, the lines as a message, and says what to press when the browser refuses", async () => {
		await opened({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk")] } });
		press("www.thetaband.dk");
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const copies = () => [...sheet().querySelectorAll<HTMLButtonElement>(".surface-address-copy")];
		copies()[3]!.click();
		expect(writeText).toHaveBeenCalledWith("qorpera-verify=9f3a1c");
		await settle();
		expect(copies()[3]!.classList.contains("is-copied")).toBe(true);
		expect(copies()[3]!.getAttribute("aria-label")).toBe("Copy qorpera-verify=9f3a1c");
		copies()[2]!.click();
		expect(writeText).toHaveBeenLastCalledWith("_qorpera.www");

		press("Copy as a message for someone else");
		await settle();
		expect(writeText).toHaveBeenLastCalledWith(
			[
				"Could you add these lines to the DNS for www.thetaband.dk? They connect it to our website.",
				"",
				"CNAME",
				"Hostname: www",
				"Value: edge.qorpera.com",
				"",
				"TXT",
				"Hostname: _qorpera.www",
				"Value: qorpera-verify=9f3a1c",
				"",
				"Some shops call Hostname “Name” or “Host”. The shop adds “.thetaband.dk” by itself.",
			].join("\n"),
		);

		writeText.mockRejectedValueOnce(new Error("denied"));
		copies()[1]!.click();
		await settle();
		expect(problem()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
		expect(window.getSelection()?.toString()).toBe("edge.qorpera.com");
	});

	it("shows a domain that no longer points here on one row that opens its lines", async () => {
		await opened({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk", "moved")] } });
		expect(groups()[1]).toEqual(["www.thetaband.dk | No longer points here"]);
		expect(name()).toBe("thetaband.qorpera.com");
		press("www.thetaband.dk");
		expect(records().length).toBe(2);
	});

	it("gives a connected domain a small page with Add another address and Remove", async () => {
		const primary = siteDomain("www.thetaband.dk", "tls_active", { isPrimary: true });
		const { client } = await opened({ entry: { isPublic: true, domains: [primary] } });
		expect(name()).toBe("www.thetaband.dk");
		expect(bar().textContent).toBe("www.thetaband.dk");
		expect((row("Open the site") as HTMLAnchorElement).href).toBe("https://www.thetaband.dk/");
		expect(groups()[1]).toEqual(["www.thetaband.dk"]);
		expect(row("www.thetaband.dk").querySelector(".surface-address-row-end svg")).not.toBeNull();

		press("www.thetaband.dk");
		expect(title()).toBe("www.thetaband.dk");
		expect(groups()).toEqual([["Add another address", "Remove www.thetaband.dk"]]);
		press("Add another address");
		expect(title()).toBe("Your own domain");
		back();
		expect(title()).toBe("www.thetaband.dk");

		press("Remove www.thetaband.dk");
		expect(client.removeDomain).toHaveBeenCalledWith(primary.id, expect.any(AbortSignal));
		expect(title()).toBeUndefined();
		expect(groups()).toEqual([["Open the site", "Copy link"], ["Use your own domain"], ["Make it not live"]]);
		expect(name()).toBe("thetaband.qorpera.com");
	});

	it("lists two domains one row each, and the address is the one that works", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("thetaband.dk", "pending_dns", { id: "77777777-7777-4777-8777-7777777777c1" }),
					siteDomain("thetaband.com", "tls_active", {
						id: "77777777-7777-4777-8777-7777777777c2",
						isPrimary: true,
					}),
				],
			},
		});
		expect(groups()[1]).toEqual(["thetaband.dk | Add the lines", "thetaband.com"]);
		expect(name()).toBe("thetaband.com");
	});

	it("never shows a domain that is not connected in the bar or the header", async () => {
		const { address } = await opened({
			entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk"), siteDomain("x.thetaband.dk", "failed")] },
		});
		expect(address.name()).toBe("thetaband.qorpera.com");
		expect(bar().textContent).toBe("thetaband.qorpera.com");
		expect(name()).toBe("thetaband.qorpera.com");
		expect(bar().className).toBe("surface-pill-address is-live");
	});
});

describe("a connected domain becomes the address by itself", () => {
	it("makes the first connected domain primary once, and never again for the same domain", async () => {
		const ready = siteDomain("www.thetaband.dk", "dns_verified");
		const { client, address, world } = await opened({ entry: { isPublic: true, domains: [ready] } });
		expect(client.setPrimaryDomain).toHaveBeenCalledTimes(1);
		expect(client.setPrimaryDomain).toHaveBeenCalledWith(ready.id, expect.any(AbortSignal));
		expect(world.entry!.domains[0]!.isPrimary).toBe(true);
		expect(name()).toBe("www.thetaband.dk");
		expect(sheet().textContent).not.toContain("Use this address");

		world.entry!.domains = [{ ...ready, isPrimary: false }];
		client.setPrimaryDomain.mockRejectedValue(refusal("DOMAIN_NOT_VERIFIED", "22023"));
		address.close();
		address.open();
		await settle();
		address.close();
		address.open();
		await settle();
		expect(client.setPrimaryDomain).toHaveBeenCalledTimes(1);
		expect(problem()).toBeUndefined();
	});

	it("waits for another write to finish, and leaves it to members who may manage the site", async () => {
		const ready = siteDomain("www.thetaband.dk", "dns_verified");
		const held = await opened({ entry: { isPublic: false, domains: [] } });
		let finish: (value: boolean) => void = () => undefined;
		held.client.setPublic.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		await goLive();
		held.world.entry!.domains = [ready];
		held.address.close();
		held.address.open();
		await settle();
		expect(held.client.setPrimaryDomain).not.toHaveBeenCalled();
		held.world.entry!.isPublic = true;
		finish(true);
		await settle();
		expect(held.client.setPrimaryDomain).toHaveBeenCalledTimes(1);
		document.body.replaceChildren();

		const { client } = await opened({ entry: { isPublic: true, domains: [ready] } }, false);
		expect(client.setPrimaryDomain).not.toHaveBeenCalled();
		expect(name()).toBe("www.thetaband.dk");
	});
});

describe("a member who may not manage sites", () => {
	it("sees the address and the rows, with one quiet line and no changing control", async () => {
		const { client } = await opened({ entry: { isPublic: false, domains: [] } }, false);
		expect(quiet()).toEqual(["Only founders and admins can change this."]);
		expect(changing()).toBe(0);
		expect(groups()).toEqual([]);
		document.body.replaceChildren();

		await opened(
			{
				entry: {
					isPublic: true,
					domains: [
						siteDomain("www.thetaband.dk", "pending_dns", { id: "77777777-7777-4777-8777-7777777777c1" }),
						siteDomain("thetaband.com", "tls_active", {
							id: "77777777-7777-4777-8777-7777777777c2",
							isPrimary: true,
						}),
					],
				},
			},
			false,
		);
		expect(quiet()).toEqual(["Only founders and admins can change this."]);
		expect(groups()).toEqual([
			["Open the site", "Copy link"],
			["www.thetaband.dk | Add the lines", "thetaband.com"],
		]);
		expect(changing()).toBe(0);
		expect(row("thetaband.com").tagName).toBe("DIV");
		press("www.thetaband.dk");
		expect(records().length).toBe(2);
		expect(groups()).toEqual([["Copy as a message for someone else"]]);
		expect(changing()).toBe(0);
		expect(client.recheckDomain).not.toHaveBeenCalled();
	});
});

describe("the address card's refusals", () => {
	it.each([
		["PUBLIC_SITES_DISABLED", "42501", "Sites cannot go live for everyone yet."],
		[
			"SITE_CONTAINS_CREDENTIAL_INPUTS",
			"22023",
			"The site has a place to sign in or type a password, so it cannot go live yet.",
		],
		["SITE_TAKEN_DOWN", "42501", "Qorpera took this site down, so this cannot change now."],
		["Only founders and admins manage site visibility", "42501", "Only founders and admins can change this."],
		["boom", "XX000", "The site did not go live. Try again."],
	])("says %s in one plain line and stays not live", async (message, code, said) => {
		const { client, address } = await opened();
		client.setPublic.mockRejectedValueOnce(refusal(message, code));
		await goLive();
		expect(problem()).toBe(said);
		expect(sheet().textContent).not.toContain(message === "boom" ? "XX000" : message);
		expect(address.mark()).toBe("private");
		expect(go()?.textContent).toBe("Go live");
	});

	it.each([
		["CUSTOM_DOMAINS_DISABLED", "42501", "Your own domain cannot be added yet."],
		["SITE_DOMAIN_LIMIT_REACHED", "22023", "A site can have five domains at most."],
		["DOMAIN_INVALID", "22023", "That does not look like a domain."],
		["duplicate key value violates unique constraint", "23505", "That domain is already used by another site."],
	])("says %s on the field page when a domain is refused, keeping what was typed", async (message, code, said) => {
		const { client } = await opened({ entry: { isPublic: true, domains: [] } });
		client.addDomain.mockRejectedValueOnce(refusal(message, code));
		press("Use your own domain");
		submit("thetaband.dk");
		await settle();
		expect(title()).toBe("Your own domain");
		expect(problem()).toBe(said);
		expect(field()?.value).toBe("thetaband.dk");
		back();
		expect(groups()[1]).toEqual(["Use your own domain"]);
	});

	it("checks a domain before asking, and says a wrong one plainly", async () => {
		const { client } = await opened();
		press("Use your own domain");
		submit("not a domain");
		expect(client.addDomain).not.toHaveBeenCalled();
		expect(problem()).toBe("That does not look like a domain.");
		expect(title()).toBe("Your own domain");
	});
});

describe("the address card while a domain is not connected", () => {
	it("polls on a gentle interval while open, rechecks no more than once a minute, and stops on close", async () => {
		vi.useFakeTimers();
		const waiting = siteDomain("www.thetaband.dk");
		const { client, address, world } = mount({ entry: { isPublic: false, domains: [waiting] } });
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(client.read).toHaveBeenCalledTimes(2);
		expect(client.recheckDomain).toHaveBeenCalledTimes(1);
		expect(client.recheckDomain).toHaveBeenCalledWith(waiting.id, expect.any(AbortSignal));

		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(client.read).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(client.read).toHaveBeenCalledTimes(4);
		expect(client.recheckDomain).toHaveBeenCalledTimes(1);

		address.close();
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(client.recheckDomain).toHaveBeenCalledTimes(1);

		world.entry!.domains = [{ ...waiting, status: "dns_verified", isPrimary: true }];
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(groups()[0]).toEqual(["www.thetaband.dk"]);
		expect(bar().textContent).toBe("www.thetaband.dk");
		const reads = client.read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS * 4);
		expect(client.read).toHaveBeenCalledTimes(reads);

		world.entry!.domains = [waiting];
		address.close();
		vi.setSystemTime(Date.now() + ADDRESS_RECHECK_GAP_MS);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(client.recheckDomain).toHaveBeenCalledTimes(2);
		const before = client.read.mock.calls.length;
		address.close();
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS * 5);
		expect(client.read).toHaveBeenCalledTimes(before);
		expect(sheet().hidden).toBe(true);
	});

	it("turns its by-hand page into the connected page once the domain points here", async () => {
		vi.useFakeTimers();
		const waiting = siteDomain("www.thetaband.dk");
		const { address, world } = mount({ entry: { isPublic: true, domains: [waiting] } });
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		press("www.thetaband.dk");
		expect(records().length).toBe(2);
		world.entry!.domains = [{ ...waiting, status: "tls_active" }];
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(title()).toBe("www.thetaband.dk");
		expect(records()).toEqual([]);
		expect(groups()).toEqual([["Add another address", "Remove www.thetaband.dk"]]);
	});

	it("keeps a refused copy's selection through a read that changes nothing", async () => {
		vi.useFakeTimers();
		const { client, address } = mount({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk")] } });
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		press("www.thetaband.dk");
		const writeText = vi.fn(async (_text: string) => {
			throw new Error("denied");
		});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const value = sheet().querySelectorAll(".surface-address-value")[3]!;
		sheet().querySelectorAll<HTMLButtonElement>(".surface-address-copy")[3]!.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(problem()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
		expect(window.getSelection()?.toString()).toBe("qorpera-verify=9f3a1c");
		const selected = sheet().querySelectorAll(".surface-address-value")[3]!;
		expect(selected).not.toBe(value);

		const reads = client.read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(client.read).toHaveBeenCalledTimes(reads + 1);
		expect(sheet().querySelectorAll(".surface-address-value")[3]).toBe(selected);
		expect(window.getSelection()?.toString()).toBe("qorpera-verify=9f3a1c");
		expect(problem()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
	});
});

const CHECKED = "2026-11-26T08:00:00Z";
const found = () =>
	[...sheet().querySelectorAll(".surface-address-record.is-found .surface-address-chip")].map(
		(item) => item.textContent,
	);

describe("what the card says after the domain was checked", () => {
	it("keeps the lines in the shop's words when the reason is unknown, naming the shop when the name servers tell it", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("namah.dk", "pending_dns", {
						lastCheckedAt: CHECKED,
						lastError: "something_new ns=ns01.one.com",
					}),
				],
			},
		});
		press("namah.dk");
		expect(line()).toBe("Open the DNS settings at one.com and create these three records.");
		expect(found()).toEqual([]);
		expect(records().map((record) => record[0])).toEqual(["A", "AAAA", "TXT"]);
		expect(groups()).toEqual([["Copy as a message for someone else", "Remove namah.dk"]]);
	});

	it("shows what was found from today's single reason, the pointing lines as one, the rest as full boxes", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("namah.dk", "pending_dns", { lastCheckedAt: CHECKED, lastError: "txt_verification_missing" }),
				],
			},
		});
		press("namah.dk");
		expect(line()).toBe("One of two found. We look again every 30 seconds.");
		expect(found()).toEqual(["A", "AAAA"]);
		expect(records().length).toBe(2);
		expect(records()[1]).toEqual([
			"TXT",
			"shows the domain is yours",
			"Hostname",
			"_qorpera",
			"Value",
			"qorpera-verify=9f3a1c",
		]);
		expect(sheet().querySelector(".surface-address-record.is-wrong")).toBeNull();
		expect(hints()).toEqual([]);
		expect(groups()).toEqual([["Copy as a message for someone else", "Remove namah.dk"]]);
	});

	it("never calls a subdomain's TXT line found, since today's router does not look for it", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("www.namah.dk", "pending_dns", {
						lastCheckedAt: CHECKED,
						lastError: "cname_record_mismatch",
					}),
				],
			},
		});
		press("www.namah.dk");
		expect(line()).toBe("None found yet. We look again every 30 seconds.");
		expect(found()).toEqual([]);
		expect(records()[0]).toEqual([
			"CNAME",
			"points www.namah.dk to your website",
			"Hostname",
			"www",
			"Value",
			"edge.qorpera.com",
		]);
	});

	it("says plainly when the TXT line sits on the wrong name", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("namah.dk", "pending_dns", {
						lastCheckedAt: CHECKED,
						lastError: "dns_routing_and_txt_missing txt_on_wrong_name ns=ns01.one.com,ns02.one.com",
					}),
				],
			},
		});
		press("namah.dk");
		expect(line()).toBe("None found yet. We look again every 30 seconds.");
		const wrong = sheet().querySelector(".surface-address-record.is-wrong")!;
		expect(wrong.querySelector(".surface-address-record-wrong")?.textContent).toBe("Found on the wrong name");
		expect(wrong.querySelector(".surface-address-record-note")?.textContent).toBe(
			"It's on namah.dk. Put it on _qorpera instead: write _qorpera in the Hostname box.",
		);
		expect(records()[2]).toEqual([
			"TXT",
			"Found on the wrong name",
			"Hostname",
			"_qorpera",
			"Value",
			"qorpera-verify=9f3a1c",
		]);
		expect(sheet().textContent).not.toContain("txt_on_wrong_name");
		expect(sheet().textContent).not.toContain("dns_routing");
	});

	it("says a domain that is not on the internet yet must be switched on, with the lines folded", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("namah.dk", "pending_dns", {
						lastCheckedAt: CHECKED,
						lastError: "domain_not_found ns=ns01.one.com",
					}),
				],
			},
		});
		press("namah.dk");
		expect(sheet().querySelector(".surface-address-warn-title")?.textContent).toBe(
			"namah.dk isn't on the internet yet",
		);
		expect(sheet().querySelector(".surface-address-warn-text")?.textContent).toBe(
			"New .dk domains wait until the owner confirms them. Look for an email from Punktum dk and confirm with MitID. It usually takes a few minutes after that.",
		);
		expect(line()).toBe(
			"Your three lines can go in at one.com already. We'll find them as soon as the domain is on.",
		);
		expect(
			[...sheet().querySelectorAll(".surface-address-record.is-summary")].map((item) => item.textContent),
		).toEqual([
			"AHostname empty · 203.0.113.7",
			"AAAAHostname empty · 2001:db8::7",
			"TXTHostname _qorpera · qorpera-verify=9f3a1c",
		]);
		expect(sheet().querySelectorAll(".surface-address-copy").length).toBe(0);
		expect(groups()).toEqual([["Remove namah.dk"]]);
		document.body.replaceChildren();

		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("www.namah.com", "pending_dns", { lastCheckedAt: CHECKED, lastError: "domain_not_found" }),
				],
			},
		});
		press("www.namah.com");
		expect(sheet().querySelector(".surface-address-warn-text")?.textContent).toBe(
			"New domains can take a while before they are switched on. Check your email from the shop where you bought it for a confirmation step.",
		);
		expect(line()).toBe("Your two lines can go in already. We'll find them as soon as the domain is on.");
	});

	it("shows the lines again for a check that has not run or a reason it does not know", async () => {
		await opened({
			entry: {
				isPublic: true,
				domains: [siteDomain("namah.dk", "pending_dns", { lastCheckedAt: null, lastError: "domain_not_found" })],
			},
		});
		press("namah.dk");
		expect(line()).toBe("Open the DNS settings where you bought namah.dk and create these three records.");
		document.body.replaceChildren();

		await opened({
			entry: {
				isPublic: true,
				domains: [
					siteDomain("namah.dk", "pending_dns", { lastCheckedAt: CHECKED, lastError: "  ns=junk,, ok?? " }),
				],
			},
		});
		press("namah.dk");
		expect(line()).toBe("Open the DNS settings where you bought namah.dk and create these three records.");
	});

	it("shows the steps while a found domain is made secure, keeps the old address, then switches by itself", async () => {
		vi.useFakeTimers();
		const now = new Date("2026-11-26T09:00:00Z");
		vi.setSystemTime(now);
		const fresh = siteDomain("namah.dk", "dns_verified", {
			isPrimary: true,
			lastCheckedAt: now.toISOString(),
			verifiedAt: now.toISOString(),
		});
		const { address } = mount({ entry: { isPublic: true, domains: [fresh] } });
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(bar().textContent).toBe("thetaband.qorpera.com");
		expect(groups()[1]).toEqual(["namah.dk | Making it secure"]);
		press("namah.dk");
		expect(title()).toBe("namah.dk");
		expect([...sheet().querySelectorAll(".surface-address-step")].map((item) => item.textContent)).toEqual([
			"All lines found",
			"Making it secureabout a minute",
			"Open at namah.dk",
		]);
		expect(hints()).toEqual([
			"You can close this. The website keeps its thetaband.qorpera.com address until namah.dk is ready, then switches by itself.",
		]);
		expect(groups()).toEqual([["Remove namah.dk"]]);

		await vi.advanceTimersByTimeAsync(ADDRESS_SECURING_MS);
		expect(groups()).toEqual([["Add another address", "Remove namah.dk"]]);
		expect(bar().textContent).toBe("namah.dk");
	});
});

describe("the address card's focus", () => {
	it("moves the focus into the card when the address had it, and Escape gives it back", async () => {
		const { address } = mount();
		await settle();
		bar().focus();
		address.open();
		expect(document.activeElement).toBe(sheet());
		expect(sheet().getAttribute("tabindex")).toBe("-1");
		await settle();
		expect(document.activeElement).toBe(sheet());
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.activeElement).toBe(bar());
	});

	it("takes the focus along from page to page and back to the row it came from", async () => {
		await opened();
		const add = row("Use your own domain");
		add.focus();
		add.click();
		expect(document.activeElement).toBe(field());
		back();
		expect(document.activeElement).toBe(row("Use your own domain"));
		go()!.focus();
		go()!.click();
		expect(document.activeElement).toBe(go());
	});

	it("leaves the focus where the member types when the address is opened with the pointer", async () => {
		const { address, container } = mount();
		await settle();
		const typing = h("textarea");
		container.append(typing);
		typing.focus();
		address.open();
		await settle();
		expect(address.isOpen).toBe(true);
		expect(document.activeElement).toBe(typing);
	});

	it("closes on a press outside and on Escape, which gives the focus back to the address", async () => {
		const { address } = await opened();
		expect(address.isOpen).toBe(true);
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(address.isOpen).toBe(false);
		expect(sheet().hidden).toBe(true);

		address.open();
		sheet().dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(address.isOpen).toBe(true);
		press("Use your own domain");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(address.isOpen).toBe(false);
		expect(document.activeElement).toBe(bar());
		address.open();
		expect(field()).toBeNull();
		expect(go()?.textContent).toBe("Go live");
	});
});

describe("editing the platform subdomain", () => {
	it("shows the locked suffix, checks availability with available/unavailable indicators, and saves", async () => {
		vi.useFakeTimers();
		const slugChanged = vi.fn();
		const { client, address } = mount(
			{
				entry: { slug: "thetaband-website", isPublic: true, domains: [] },
				hostsDomain: "qorpera.site",
				takenSlugs: ["taken-site"],
			},
			true,
			{ slugChanged },
			"https://thetaband-website.qorpera.site/",
		);
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);

		expect(editButton()).not.toBeNull();
		editButton()!.click();
		expect(title()).toBe("Edit address");
		expect(slugField()?.value).toBe("thetaband-website");
		expect(slugSuffix()).toBe(".qorpera.site");
		expect(document.activeElement).toBe(slugField());
		expect(saveSlugButton()?.disabled).toBe(true);
		expect(availability()?.hidden).toBe(true);

		slugField()!.value = "taken-site";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(client.checkSlug).toHaveBeenCalledWith(HOSTED_SITE, "taken-site", expect.any(AbortSignal));
		expect(availability()?.hidden).toBe(false);
		expect(availability()?.classList.contains("is-unavailable")).toBe(true);
		expect(availability()?.textContent).toBe("Unavailable");
		expect(saveSlugButton()?.disabled).toBe(true);

		slugField()!.value = "shop";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(client.checkSlug).toHaveBeenCalledTimes(1);
		expect(availability()?.classList.contains("is-unavailable")).toBe(true);
		expect(availability()?.textContent).toBe("Unavailable");
		expect(saveSlugButton()?.disabled).toBe(true);

		slugField()!.value = "ab";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(availability()?.classList.contains("is-invalid")).toBe(true);
		expect(availability()?.textContent).toBe("At least 3 characters.");
		expect(saveSlugButton()?.disabled).toBe(true);

		slugField()!.value = "bad--name";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(availability()?.classList.contains("is-invalid")).toBe(true);
		expect(availability()?.textContent).toBe("Use lowercase letters, numbers, and single hyphens.");

		slugField()!.value = "ThetaBand";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(client.checkSlug).toHaveBeenLastCalledWith(HOSTED_SITE, "thetaband", expect.any(AbortSignal));
		expect(availability()?.classList.contains("is-available")).toBe(true);
		expect(availability()?.textContent).toBe("Available");
		expect(saveSlugButton()?.disabled).toBe(false);

		sheet()
			.querySelector("form")!
			.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(client.setSlug).toHaveBeenCalledWith(HOSTED_SITE, "thetaband", expect.any(AbortSignal));
		expect(slugChanged).toHaveBeenCalledWith({
			siteId: HOSTED_SITE,
			slug: "thetaband",
			url: "https://thetaband.qorpera.site/",
		});
		expect(title()).toBeUndefined();
		expect(name()).toBe("thetaband.qorpera.site");
		expect(bar().textContent).toBe("thetaband.qorpera.site");
		expect((row("Open the site") as HTMLAnchorElement).href).toBe("https://thetaband.qorpera.site/");
		expect(document.activeElement).toBe(editButton());
	});

	it("shows Checking while an availability request is in flight and discards stale responses", async () => {
		vi.useFakeTimers();
		let resolveFirst: (value: {
			siteId: string;
			slug: string;
			available: boolean;
			reason: "available" | "taken";
		}) => void = () => undefined;
		let resolveSecond: (value: {
			siteId: string;
			slug: string;
			available: boolean;
			reason: "available" | "taken";
		}) => void = () => undefined;
		const { client, address } = mount(
			{ entry: { slug: "thetaband", isPublic: false, domains: [] }, hostsDomain: "qorpera.site" },
			true,
			{},
			"https://thetaband.qorpera.site/",
		);
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		editButton()!.click();

		client.checkSlug
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve;
					}),
			);

		slugField()!.value = "first-pick";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(availability()?.classList.contains("is-checking")).toBe(true);
		expect(availability()?.textContent).toBe("Checking…");
		expect(saveSlugButton()?.disabled).toBe(true);

		slugField()!.value = "second-pick";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		resolveFirst({ siteId: HOSTED_SITE, slug: "first-pick", available: true, reason: "available" });
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(availability()?.textContent).toBe("Checking…");
		expect(saveSlugButton()?.disabled).toBe(true);

		resolveSecond({ siteId: HOSTED_SITE, slug: "second-pick", available: false, reason: "taken" });
		await vi.advanceTimersByTimeAsync(0);
		expect(availability()?.classList.contains("is-unavailable")).toBe(true);
		expect(availability()?.textContent).toBe("Unavailable");
		expect(saveSlugButton()?.disabled).toBe(true);
	});

	it("marks Unavailable on a save race and shows plain refusal lines on other errors", async () => {
		vi.useFakeTimers();
		const { client, address } = mount(
			{ entry: { slug: "thetaband", isPublic: true, domains: [] }, hostsDomain: "qorpera.site" },
			true,
			{},
			"https://thetaband.qorpera.site/",
		);
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		editButton()!.click();

		slugField()!.value = "raced-name";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(saveSlugButton()?.disabled).toBe(false);

		client.setSlug.mockRejectedValueOnce(refusal("SITE_SLUG_TAKEN", "23505"));
		sheet()
			.querySelector("form")!
			.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(title()).toBe("Edit address");
		expect(slugField()?.value).toBe("raced-name");
		expect(availability()?.classList.contains("is-unavailable")).toBe(true);
		expect(availability()?.textContent).toBe("Unavailable");
		expect(saveSlugButton()?.disabled).toBe(true);

		slugField()!.value = "other-name";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		client.setSlug.mockRejectedValueOnce(refusal("SITE_TAKEN_DOWN", "42501"));
		sheet()
			.querySelector("form")!
			.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(problem()).toBe("Qorpera took this site down, so this cannot change now.");
	});

	it("hides the edit control when a verified custom domain is active, hosts are off, or the member cannot manage sites", async () => {
		const primary = siteDomain("www.thetaband.dk", "tls_active", { isPrimary: true });
		await opened({ entry: { isPublic: true, domains: [primary] } });
		expect(editButton()).toBeNull();
		document.body.replaceChildren();

		await opened(
			{ entry: { isPublic: true, domains: [] }, hostsDomain: "qorpera.com", hostsEnabled: false },
			true,
			{},
			"https://sites.qorpera.com/thetaband/",
		);
		expect(editButton()).toBeNull();
		document.body.replaceChildren();

		await opened({ entry: { isPublic: true, domains: [] } }, false);
		expect(editButton()).toBeNull();
	});

	it("shows takedown refusal directly from the availability check", async () => {
		vi.useFakeTimers();
		const { client, address } = mount(
			{ entry: { slug: "thetaband", isPublic: true, domains: [] }, hostsDomain: "qorpera.site" },
			true,
			{},
			"https://thetaband.qorpera.site/",
		);
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		editButton()!.click();

		client.checkSlug.mockRejectedValueOnce(refusal("SITE_TAKEN_DOWN", "42501"));
		slugField()!.value = "after-takedown";
		slugField()!.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.advanceTimersByTimeAsync(ADDRESS_SLUG_CHECK_MS);
		expect(problem()).toBe("Qorpera took this site down, so this cannot change now.");
		expect(saveSlugButton()?.disabled).toBe(true);
	});

	it("returns focus to the edit button when going back", async () => {
		await opened();
		editButton()!.click();
		expect(title()).toBe("Edit address");
		back();
		expect(title()).toBeUndefined();
		expect(document.activeElement).toBe(editButton());
	});

	it("lets owners and admins switch code source repository, subfolder, and branch from the address sheet", async () => {
		const saved: { repositoryKey: string; repositorySubpath?: string | null; defaultBranch?: string | null }[] = [];
		const listRepositories = vi.fn().mockResolvedValue([
			{
				repositoryKey: "qorpera/qorpera_base",
				owner: "qorpera",
				name: "qorpera_base",
				mainSha: "a".repeat(40),
				sourceBranch: "master",
				sourceUrl: "https://github.com/Qorpera/Qorpera_Base",
				boundSurfaceSlugs: [],
				createdAt: "2026-11-27T00:00:00.000Z",
				updatedAt: "2026-11-27T00:00:00.000Z",
			},
			{
				repositoryKey: "surfaces/web-app",
				owner: "surfaces",
				name: "web-app",
				mainSha: null,
				sourceBranch: "main",
				sourceUrl: null,
				boundSurfaceSlugs: ["web-app"],
				createdAt: "2026-11-27T00:00:00.000Z",
				updatedAt: "2026-11-27T00:00:00.000Z",
			},
		]);
		let current = {
			repositoryKey: "surfaces/web-app",
			repositorySubpath: null as string | null,
			defaultBranch: "main",
		};
		const { address } = mount({ entry: { isPublic: true, domains: [] } }, true, {
			codeSource: () => ({
				repositoryKey: current.repositoryKey,
				repositorySubpath: current.repositorySubpath,
				defaultBranch: current.defaultBranch,
				listRepositories,
				save: async (input) => {
					saved.push(input);
					current = {
						repositoryKey: input.repositoryKey,
						repositorySubpath: input.repositorySubpath ?? null,
						defaultBranch: input.defaultBranch ?? "main",
					};
					return true;
				},
			}),
		});
		await settle();
		address.open();
		await settle();

		const sourceRow = sheet().querySelector<HTMLButtonElement>('[data-key="code-source"]')!;
		expect(sourceRow.textContent).toContain("Code source");
		expect(sourceRow.textContent).toContain("surfaces/web-app");
		sourceRow.click();
		await settle();
		expect(title()).toBe("Code source");
		expect(listRepositories).toHaveBeenCalledTimes(1);

		const select = sheet().querySelector<HTMLSelectElement>('[data-key="source-repo-select"]')!;
		const subpath = sheet().querySelector<HTMLInputElement>('[data-key="source-subpath"]')!;
		const branch = sheet().querySelector<HTMLInputElement>('[data-key="source-branch"]')!;
		select.value = "qorpera/qorpera_base";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		expect(branch.value).toBe("master");

		subpath.value = "../bad";
		sheet()
			.querySelector("form")!
			.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		expect(problem()).toBe("Use a relative subfolder like packages/web.");
		expect(saved).toHaveLength(0);

		subpath.value = "/packages/web/";
		sheet()
			.querySelector("form")!
			.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await settle();

		expect(saved).toEqual([
			{
				repositoryKey: "qorpera/qorpera_base",
				repositorySubpath: "packages/web",
				defaultBranch: "master",
			},
		]);
		expect(title()).toBeUndefined();
		expect(sheet().querySelector('[data-key="code-source"]')?.textContent).toContain(
			"qorpera/qorpera_base/packages/web",
		);
	});
});
