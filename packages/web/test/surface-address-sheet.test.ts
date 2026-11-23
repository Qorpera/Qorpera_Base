// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ADDRESS_POLL_MS,
	ADDRESS_RECHECK_GAP_MS,
	type AddressMark,
	SurfaceAddress,
} from "../src/app/views/surface-address-sheet.ts";
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

function mount(world: Partial<HostingWorld> = {}, manage = true, password?: () => Promise<string | null>) {
	const container = h("div", { class: "surface-canvas" });
	document.body.append(container);
	const controller = new AbortController();
	const hosting = fakeSiteHosting(world);
	const address = new SurfaceAddress({
		container,
		canManage: () => manage,
		...(password ? { password } : {}),
		changed: () => {
			const shown = container.querySelector(".surface-pill-address");
			const next = address.button();
			if (shown && next) shown.replaceWith(next);
		},
		signal: controller.signal,
	});
	const target = { siteId: HOSTED_SITE, client: hosting.client };
	address.sync(true, target, LIVE_URL);
	container.prepend(address.button()!);
	return { address, container, controller, target, ...hosting };
}

const sheet = () => document.querySelector<HTMLElement>(".surface-address-sheet")!;
const bar = () => document.querySelector<HTMLButtonElement>(".surface-pill-address")!;
const stops = () =>
	[...sheet().querySelectorAll<HTMLElement>(".surface-address-stops li")].map((item) => [
		item.textContent,
		item.className,
	]);
const lines = () => [...sheet().querySelectorAll(".surface-address-line")].map((item) => item.textContent);
const buttons = () =>
	[...sheet().querySelectorAll<HTMLButtonElement>("button:not(.surface-address-link)")].map(
		(item) => item.textContent,
	);
const links = () => [...sheet().querySelectorAll(".surface-address-links > *")].map((item) => item.textContent);
const press = (label: string) =>
	[...sheet().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!.click();
const problem = () => sheet().querySelector(".surface-address-problem")?.textContent;
const field = () => sheet().querySelector<HTMLInputElement>(".surface-address-input");
const submit = (text: string) => {
	field()!.value = text;
	sheet()
		.querySelector("form")!
		.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
};
const refusal = (message: string, code = "42501") => new CloudRpcError("rpc", { message, code });

async function opened(world: Partial<HostingWorld> = {}, manage = true, password?: () => Promise<string | null>) {
	const mounted = mount(world, manage, password);
	await settle();
	mounted.address.open();
	await settle();
	return mounted;
}

describe("the address sheet's stops", () => {
	it("says a site with no row yet stays with only you, and offers no way live", async () => {
		const { address } = await opened({ entry: null });
		expect(address.mark()).toBe<AddressMark>("private");
		expect(sheet().hidden).toBe(false);
		expect(sheet().getAttribute("role")).toBe("dialog");
		expect(sheet().querySelector(".surface-address-name")?.textContent).toBe("thetaband.qorpera.com");
		expect(sheet().querySelector(".surface-address-name span")?.textContent).toBe(".qorpera.com");
		expect(stops()).toEqual([
			["Only you", "is-now"],
			["Live", ""],
			["Your domain", ""],
		]);
		expect(lines()).toEqual([
			"It can go live once its first version is ready. Until then only your team can open it.",
		]);
		expect(buttons()).toEqual([]);
		const open = sheet().querySelector<HTMLAnchorElement>(".surface-address-open")!;
		expect(open.href).toBe(LIVE_URL);
		expect(open.target).toBe("_blank");
		expect(open.textContent).toBe("Open the site");
	});

	it("puts a private site live on one press and takes it back the same way", async () => {
		const { address, client } = await opened();
		expect(address.mark()).toBe("private");
		expect(lines()).toEqual(["Only you and your team can open it."]);
		expect(buttons()).toEqual(["Put it live"]);

		press("Put it live");
		expect(client.setPublic).toHaveBeenCalledWith(HOSTED_SITE, true, expect.any(AbortSignal));
		expect(stops()).toEqual([
			["Only you", "is-done"],
			["Live", "is-now is-done"],
			["Your domain", ""],
		]);
		expect(address.mark()).toBe("live");
		await settle();
		expect(lines()).toEqual(["Anyone can open it. What you approve goes live here."]);
		expect(field()?.placeholder).toBe("yourdomain.com");
		expect(buttons()).toEqual(["Use it", "Back to only you"]);

		press("Back to only you");
		expect(client.setPublic).toHaveBeenLastCalledWith(HOSTED_SITE, false, expect.any(AbortSignal));
		expect(stops()[0]).toEqual(["Only you", "is-now"]);
		await settle();
		expect(buttons()).toEqual(["Put it live"]);
	});

	it("adds a domain from one field, then waits in one quiet line with its lines shown only when asked", async () => {
		const { address, client } = await opened({ entry: { isPublic: true, domains: [] } });
		submit("  https://WWW.Thetaband.dk/shop ");
		expect(client.addDomain).toHaveBeenCalledWith(HOSTED_SITE, "www.thetaband.dk", false, expect.any(AbortSignal));
		expect(lines()).toEqual(["Waiting for www.thetaband.dk to point here."]);
		expect(address.mark()).toBe("waiting");
		expect(address.name()).toBe("www.thetaband.dk");
		await settle();
		expect(stops()).toEqual([
			["Only you", "is-done"],
			["Live", "is-done"],
			["Your domain", "is-now is-waiting"],
		]);
		expect(sheet().querySelector(".surface-address-records")).toBeNull();
		expect(buttons()).toEqual([
			"Show the two lines to paste where you bought it",
			"Remove www.thetaband.dk",
			"Back to only you",
		]);
		expect(bar().classList.contains("is-waiting")).toBe(true);
		expect(bar().textContent).toBe("www.thetaband.dk");
		expect(sheet().querySelector(".surface-address-name span")?.textContent).toBe(".dk");

		press("Show the two lines to paste where you bought it");
		const rows = [...sheet().querySelectorAll(".surface-address-record")].map((row) =>
			[...row.querySelectorAll("b, span")].map((cell) => cell.textContent),
		);
		expect(rows).toEqual([
			["CNAME", "www.thetaband.dk", "edge.qorpera.com"],
			["TXT", "_qorpera.www.thetaband.dk", "qorpera-verify=9f3a1c"],
		]);
		press("Hide the lines");
		expect(sheet().querySelector(".surface-address-records")).toBeNull();
	});

	it("names an apex domain's three lines", async () => {
		await opened({ entry: { isPublic: true, domains: [siteDomain("thetaband.dk")] } });
		press("Show the three lines to paste where you bought it");
		const rows = [...sheet().querySelectorAll(".surface-address-record")].map((row) =>
			[...row.querySelectorAll("b, span")].map((cell) => cell.textContent),
		);
		expect(rows).toEqual([
			["A", "@", "203.0.113.7"],
			["AAAA", "@", "2001:db8::7"],
			["TXT", "_qorpera.thetaband.dk", "qorpera-verify=9f3a1c"],
		]);
	});

	it("copies a line inside the press, and says what to press when the browser refuses", async () => {
		await opened({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk")] } });
		press("Show the two lines to paste where you bought it");
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const copies = () => [...sheet().querySelectorAll<HTMLButtonElement>(".surface-address-copy")];
		copies()[1]!.click();
		expect(writeText).toHaveBeenCalledWith("qorpera-verify=9f3a1c");
		await settle();
		expect(copies()[1]!.classList.contains("is-copied")).toBe(true);
		expect(copies()[1]!.getAttribute("aria-label")).toBe("Copy qorpera-verify=9f3a1c");

		writeText.mockRejectedValueOnce(new Error("denied"));
		copies()[0]!.click();
		await settle();
		expect(problem()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
		expect(window.getSelection()?.toString()).toBe("edge.qorpera.com");
	});

	it("copies the site's link from under its name, and its password while only the team can open it", async () => {
		const writeText = vi.fn(async (_text: string) => undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const password = vi.fn(async () => "nordic-pass-42");
		const { client } = await opened({}, true, password);
		expect(password).toHaveBeenCalledTimes(1);
		expect(links()).toEqual(["Open the site", "Copy link", "Copy password"]);

		press("Copy link");
		await settle();
		expect(writeText).toHaveBeenLastCalledWith(LIVE_URL);
		expect(links()).toEqual(["Open the site", "Copied", "Copy password"]);
		press("Copy password");
		await settle();
		expect(writeText).toHaveBeenLastCalledWith("nordic-pass-42");

		press("Put it live");
		await settle();
		expect(client.setPublic).toHaveBeenCalledWith(HOSTED_SITE, true, expect.any(AbortSignal));
		expect(links()).toEqual(["Open the site", "Copy link"]);
		expect(password).toHaveBeenCalledTimes(1);
	});

	it("offers no password to a member who cannot read one, and says what to press when a copy is refused", async () => {
		const { address } = await opened({}, false, async () => null);
		expect(links()).toEqual(["Open the site", "Copy link"]);
		press("Copy link");
		await settle();
		expect(problem()).toMatch(/^Press (⌘C|Ctrl\+C) to copy\.$/);
		expect(window.getSelection()?.toString()).toBe("thetaband.qorpera.com");
		address.close();
		document.body.replaceChildren();

		await opened();
		expect(links()).toEqual(["Open the site", "Copy link"]);
	});

	it("offers a verified domain as the address on one press, and removes a domain", async () => {
		const ready = siteDomain("www.thetaband.dk", "dns_verified");
		const { address, client } = await opened({ entry: { isPublic: true, domains: [ready] } });
		expect(address.mark()).toBe("live");
		expect(lines()).toEqual(["www.thetaband.dk points here."]);
		expect(stops()[2]).toEqual(["Your domain", "is-now is-done"]);
		press("Use this address");
		expect(client.setPrimaryDomain).toHaveBeenCalledWith(ready.id, expect.any(AbortSignal));
		expect(lines()).toEqual(["Live at www.thetaband.dk. The lock follows in a few minutes."]);
		expect(sheet().querySelector<HTMLAnchorElement>(".surface-address-open")?.href).toBe("https://www.thetaband.dk/");
		await settle();
		expect(buttons()).toEqual(["Remove www.thetaband.dk", "Back to only you"]);

		press("Remove www.thetaband.dk");
		expect(client.removeDomain).toHaveBeenCalledWith(ready.id, expect.any(AbortSignal));
		expect(lines()).toEqual(["Anyone can open it. What you approve goes live here."]);
		await settle();
		expect(field()).not.toBeNull();
	});

	it("says a primary domain with its lock is live there", async () => {
		await opened({
			entry: { isPublic: true, domains: [siteDomain("thetaband.dk", "tls_active", { isPrimary: true })] },
		});
		expect(lines()).toEqual(["Live at thetaband.dk, with the lock."]);
		expect(bar().textContent).toBe("thetaband.dk");
		expect(bar().classList.contains("is-live")).toBe(true);
	});

	it("shows a member who may not manage sites the stops and addresses, read-only, with no buttons", async () => {
		const { client } = await opened({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk")] } }, false);
		expect(stops()[2]).toEqual(["Your domain", "is-now is-waiting"]);
		expect(lines()).toEqual(["Waiting for www.thetaband.dk to point here."]);
		expect(buttons()).toEqual([]);
		expect(field()).toBeNull();
		expect(sheet().querySelector(".surface-address-quiet")?.textContent).toBe(
			"Only founders and admins can change this.",
		);
		expect(sheet().querySelector(".surface-address-open")).not.toBeNull();
		expect(client.recheckDomain).not.toHaveBeenCalled();
	});

	it("keeps a private site's verified primary domain for when the site is live", async () => {
		const primary = siteDomain("thetaband.dk", "tls_active", { isPrimary: true });
		const { address } = await opened({ entry: { isPublic: false, domains: [primary] } });
		expect(address.mark()).toBe("private");
		expect(address.name()).toBe("thetaband.qorpera.com");
		expect(bar().classList.contains("is-private")).toBe(true);
		expect(bar().querySelector(".surface-address-lock")).not.toBeNull();
		expect(stops()[0]).toEqual(["Only you", "is-now"]);
		expect(lines()).toEqual([
			"Only you and your team can open it.",
			"thetaband.dk is kept for when the site is live.",
		]);
		expect(sheet().textContent).not.toContain("Live at");
		expect(buttons()).toEqual(["Put it live", "Remove thetaband.dk"]);
		expect(sheet().querySelector<HTMLAnchorElement>(".surface-address-open")?.href).toBe(LIVE_URL);
	});

	it("words a live site's domains as kept once it goes back to only you, with no lines and no recheck", async () => {
		const primary = siteDomain("thetaband.dk", "tls_active", { isPrimary: true });
		const { client } = await opened({ entry: { isPublic: true, domains: [primary] } });
		expect(lines()).toEqual(["Live at thetaband.dk, with the lock."]);
		press("Back to only you");
		expect(lines()).toEqual([
			"Only you and your team can open it.",
			"thetaband.dk is kept for when the site is live.",
		]);
		await settle();
		expect(bar().classList.contains("is-private")).toBe(true);
		expect(bar().textContent).toBe("thetaband.qorpera.com");
		document.body.replaceChildren();

		const waiting = await opened({ entry: { isPublic: false, domains: [siteDomain("www.thetaband.dk")] } });
		expect(lines()).toEqual([
			"Only you and your team can open it.",
			"www.thetaband.dk is kept for when the site is live.",
		]);
		expect(buttons()).toEqual(["Put it live", "Remove www.thetaband.dk"]);
		expect(waiting.client.recheckDomain).not.toHaveBeenCalled();
		expect(client.recheckDomain).not.toHaveBeenCalled();
	});

	it("says plainly when sites cannot go live or take a domain yet", async () => {
		await opened({ publicEnabled: false });
		expect(buttons()).toEqual([]);
		expect(lines()).toEqual(["Only you and your team can open it.", "Sites cannot go live for everyone yet."]);
		document.body.replaceChildren();
		await opened({ domainsEnabled: false, entry: { isPublic: true, domains: [] } });
		expect(field()).toBeNull();
		expect(lines()).toContain("Your own domain cannot be added yet.");
	});
});

describe("the address sheet's refusals", () => {
	it.each([
		["PUBLIC_SITES_DISABLED", "42501", "Sites cannot go live for everyone yet."],
		[
			"SITE_CONTAINS_CREDENTIAL_INPUTS",
			"22023",
			"The site has a place to sign in or type a password, so it stays with only you for now.",
		],
		["SITE_TAKEN_DOWN", "42501", "Qorpera took this site down, so this cannot change now."],
		["Only founders and admins manage site visibility", "42501", "Only founders and admins can change this."],
		["boom", "XX000", "The site did not go live. Try again."],
	])("says %s in one plain line and stays with only you", async (message, code, said) => {
		const { client, address } = await opened();
		client.setPublic.mockRejectedValueOnce(refusal(message, code));
		press("Put it live");
		await settle();
		expect(problem()).toBe(said);
		expect(sheet().textContent).not.toContain(message === "boom" ? "XX000" : message);
		expect(address.mark()).toBe("private");
		expect(buttons()).toEqual(["Put it live"]);
	});

	it.each([
		["CUSTOM_DOMAINS_DISABLED", "42501", "Your own domain cannot be added yet."],
		["SITE_DOMAIN_LIMIT_REACHED", "22023", "A site can have five domains at most."],
		["DOMAIN_INVALID", "22023", "That does not look like a domain."],
		["duplicate key value violates unique constraint", "23505", "That domain is already used by another site."],
	])("says %s when a domain is refused, keeping what was typed", async (message, code, said) => {
		const { client } = await opened({ entry: { isPublic: true, domains: [] } });
		client.addDomain.mockRejectedValueOnce(refusal(message, code));
		submit("thetaband.dk");
		await settle();
		expect(problem()).toBe(said);
		expect(field()?.value).toBe("thetaband.dk");
		expect(lines()).toEqual(["Anyone can open it. What you approve goes live here."]);
	});

	it("checks a domain before asking, and says a wrong one plainly", async () => {
		const { client } = await opened({ entry: { isPublic: true, domains: [] } });
		submit("not a domain");
		expect(client.addDomain).not.toHaveBeenCalled();
		expect(problem()).toBe("That does not look like a domain.");
	});

	it("says a domain that does not point here yet cannot be the address", async () => {
		const ready = siteDomain("www.thetaband.dk", "dns_verified");
		const { client } = await opened({ entry: { isPublic: true, domains: [ready] } });
		client.setPrimaryDomain.mockRejectedValueOnce(refusal("DOMAIN_NOT_VERIFIED", "22023"));
		press("Use this address");
		await settle();
		expect(problem()).toBe("The domain does not point here yet.");
		expect(lines()).toEqual(["www.thetaband.dk points here."]);
	});
});

describe("the address sheet while a domain waits", () => {
	it("polls on a gentle interval while open, rechecks no more than once a minute, and stops on close", async () => {
		vi.useFakeTimers();
		const waiting = siteDomain("www.thetaband.dk");
		const { client, address, world } = mount({ entry: { isPublic: true, domains: [waiting] } });
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

		world.entry!.domains = [{ ...waiting, status: "dns_verified" }];
		await vi.advanceTimersByTimeAsync(ADDRESS_POLL_MS);
		expect(lines()).toEqual(["www.thetaband.dk points here."]);
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

	it("keeps a refused copy's selection through a read that changes nothing", async () => {
		vi.useFakeTimers();
		const { client, address } = mount({ entry: { isPublic: true, domains: [siteDomain("www.thetaband.dk")] } });
		await vi.advanceTimersByTimeAsync(0);
		address.open();
		await vi.advanceTimersByTimeAsync(0);
		press("Show the two lines to paste where you bought it");
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

	it("moves the focus into the sheet when the address had it, and Escape gives it back", async () => {
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
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(address.isOpen).toBe(false);
		expect(document.activeElement).toBe(bar());
	});
});
