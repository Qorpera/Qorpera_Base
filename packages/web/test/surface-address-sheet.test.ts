// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ADDRESS_POLL_MS,
	ADDRESS_RECHECK_GAP_MS,
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
	hooks: Pick<SurfaceAddressSetup, "beforePublic" | "publicChanged"> = {},
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
	address.sync(true, target, LIVE_URL);
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
	[...sheet().querySelectorAll(".surface-address-record")].map((item) =>
		[...item.querySelectorAll("b, span")].map((cell) => cell.textContent),
	);
const refusal = (message: string, code = "42501") => new CloudRpcError("rpc", { message, code });
const changing = () =>
	sheet().querySelectorAll(
		".surface-address-go, .surface-address-input, [data-key='add'], [data-key='remove'], [data-key='not-live']",
	).length;

async function opened(
	world: Partial<HostingWorld> = {},
	manage = true,
	hooks: Pick<SurfaceAddressSetup, "beforePublic" | "publicChanged"> = {},
) {
	const mounted = mount(world, manage, hooks);
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
		expect(sheet().querySelector(".surface-address-line")?.textContent).toBe(
			"Add these two lines where you bought www.thetaband.dk.",
		);
		expect(records()).toEqual([
			["CNAME", "www.thetaband.dk", "edge.qorpera.com"],
			["TXT", "_qorpera.www.thetaband.dk", "qorpera-verify=9f3a1c"],
		]);
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
		expect(sheet().querySelector(".surface-address-line")?.textContent).toBe(
			"Add these three lines where you bought thetaband.dk.",
		);
		expect(records()).toEqual([
			["A", "@", "203.0.113.7"],
			["AAAA", "@", "2001:db8::7"],
			["TXT", "_qorpera.thetaband.dk", "qorpera-verify=9f3a1c"],
		]);
	});

	it("copies a line, the lines as a message, and says what to press when the browser refuses", async () => {
		await opened({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk")] } });
		press("www.thetaband.dk");
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const copies = () => [...sheet().querySelectorAll<HTMLButtonElement>(".surface-address-copy")];
		copies()[1]!.click();
		expect(writeText).toHaveBeenCalledWith("qorpera-verify=9f3a1c");
		await settle();
		expect(copies()[1]!.classList.contains("is-copied")).toBe(true);
		expect(copies()[1]!.getAttribute("aria-label")).toBe("Copy qorpera-verify=9f3a1c");

		press("Copy as a message for someone else");
		await settle();
		expect(writeText).toHaveBeenLastCalledWith(
			[
				"Could you add these lines to the DNS for www.thetaband.dk? They connect it to our website.",
				"",
				"CNAME  www.thetaband.dk  edge.qorpera.com",
				"TXT  _qorpera.www.thetaband.dk  qorpera-verify=9f3a1c",
			].join("\n"),
		);

		writeText.mockRejectedValueOnce(new Error("denied"));
		copies()[0]!.click();
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
		const value = sheet().querySelectorAll(".surface-address-value")[1]!;
		sheet().querySelectorAll<HTMLButtonElement>(".surface-address-copy")[1]!.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(problem()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
		expect(window.getSelection()?.toString()).toBe("qorpera-verify=9f3a1c");
		const selected = sheet().querySelectorAll(".surface-address-value")[1]!;
		expect(selected).not.toBe(value);

		const reads = client.read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(client.read).toHaveBeenCalledTimes(reads + 1);
		expect(sheet().querySelectorAll(".surface-address-value")[1]).toBe(selected);
		expect(window.getSelection()?.toString()).toBe("qorpera-verify=9f3a1c");
		expect(problem()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
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
