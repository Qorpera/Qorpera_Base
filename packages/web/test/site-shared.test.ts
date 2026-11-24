// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	changeError,
	hasPassword,
	pressToCopy,
	shownLink,
	siteEmblem,
	stateOf,
	toClipboard,
} from "../src/app/views/site-shared.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CompanySite } from "../src/cloud/sites.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, id, timestamp } from "./fixtures.ts";

const shop: CompanySite = {
	id: id(81),
	slug: "wristband-shop",
	title: "Wristband shop",
	kind: "files",
	url: "https://wristband-shop.qorpera.com/",
	state: "live",
	source: "product/shop",
	files: 12,
	bytes: 2048,
	publishedAt: timestamp,
	publishedBy: { agentId: id(90), name: "Co-Founder" },
	createdAt: timestamp,
	passwordChangedAt: timestamp,
	machine: null,
	port: null,
};
const app: CompanySite = {
	...shop,
	id: id(83),
	slug: "saml-shop",
	kind: "app",
	url: "https://saml-shop-preview.qorpera.com/",
	machine: "shop-server",
	port: 3000,
};

afterEach(() => {
	Reflect.deleteProperty(navigator, "clipboard");
	Reflect.deleteProperty(navigator, "userAgent");
	setLanguagePreference("system");
	vi.unstubAllGlobals();
});

describe("the site pieces the cards, What's new and the address card share", () => {
	it("shows a link without https:// and its last slash", () => {
		expect(shownLink("https://sites.qorpera.com/a-b/")).toBe("sites.qorpera.com/a-b");
		expect(shownLink("https://wristband-shop.qorpera.com/")).toBe("wristband-shop.qorpera.com");
	});

	it("gives only an app link a password, and every site the globe", () => {
		expect([hasPassword(shop), hasPassword(app)]).toEqual([false, true]);
		const emblem = siteEmblem();
		expect(emblem.classList.contains("site-emblem")).toBe(true);
		expect(emblem.classList.contains("interface-emblem")).toBe(true);
	});

	it("says a site's state as a dot and a word, with when and by whom it was published as its tip", () => {
		const live = stateOf(shop, false);
		expect([live.className, live.textContent]).toEqual(["site-state is-live", "Live"]);
		expect(live.querySelector(".site-dot")?.getAttribute("aria-hidden")).toBe("true");
		expect(live.title).toMatch(/^Published .+ by Co-Founder$/);
		expect(stateOf({ ...app, state: "off" }, false).textContent).toBe("Off");
		const draft = stateOf({ ...shop, state: "publishing", publishedAt: null, publishedBy: null }, false);
		expect([draft.className, draft.textContent, draft.hasAttribute("title")]).toEqual([
			"site-state is-publishing",
			"Publishing…",
			false,
		]);
		expect(stateOf({ ...shop, publishedBy: null }, false).title).toMatch(/^Published [^·]+$/);
		const down = stateOf(shop, true);
		expect([down.className, down.textContent]).toEqual(["site-state is-down", "Taken down"]);
		setLanguagePreference("da");
		expect(stateOf(shop, true).textContent).toBe("Taget ned");
		expect(stateOf({ ...shop, state: "publishing" }, false).textContent).toBe("Udgiver…");
	});

	it("says why a change was refused, in the interface language", () => {
		const refused = (code: string) => new CloudRpcError("x", { message: "no", code }, 400);
		expect(changeError(refused("42501"), "Try again.")).toBe(
			"Only founders and admins can see passwords or take sites offline.",
		);
		expect(changeError(refused("22023"), "Try again.")).toBe("A site password is 10 to 128 characters.");
		expect(changeError(new Error("offline"), "The password could not be read. Try again.")).toBe(
			"The password could not be read. Try again.",
		);
		setLanguagePreference("da");
		expect(changeError(refused("42501"), "Try again.")).toBe(
			"Kun stiftere og administratorer kan se adgangskoder eller tage hjemmesider offline.",
		);
	});

	it("says what to press to copy by hand, by the member's computer", () => {
		Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh)" });
		expect(pressToCopy()).toBe("Press ⌘C to copy.");
		Reflect.deleteProperty(navigator, "userAgent");
		Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Windows NT 10.0)" });
		expect(pressToCopy()).toBe("Press Ctrl+C to copy.");
	});

	it("copies a text, and says false when the browser refuses or has no clipboard", async () => {
		expect(await toClipboard("abc")).toBe(false);
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		expect(await toClipboard("abc")).toBe(true);
		expect(writeText).toHaveBeenLastCalledWith("abc");
		expect(await toClipboard(Promise.resolve("later"))).toBe(true);
		expect(writeText).toHaveBeenLastCalledWith("later");
		writeText.mockRejectedValueOnce(new Error("denied"));
		expect(await toClipboard("abc")).toBe(false);
	});

	it("hands a text still being read to the clipboard as it is read, where the browser takes that", async () => {
		const items: { data: Record<string, Promise<Blob>> }[] = [];
		vi.stubGlobal(
			"ClipboardItem",
			class {
				data: Record<string, Promise<Blob>>;
				constructor(data: Record<string, Promise<Blob>>) {
					this.data = data;
					items.push(this);
				}
			},
		);
		const write = vi.fn(async () => {});
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
		const read = deferred<string>();
		const copied = toClipboard(read.promise);
		expect(write).toHaveBeenCalledTimes(1);
		read.resolve("k7mq-x2pa-9fhd");
		expect(await copied).toBe(true);
		const blob = await items[0]!.data["text/plain"];
		expect([blob?.type, blob?.size]).toEqual(["text/plain", "k7mq-x2pa-9fhd".length]);
		expect(writeText).not.toHaveBeenCalled();
		write.mockRejectedValueOnce(new Error("no promises here"));
		expect(await toClipboard(Promise.resolve("plain"))).toBe(true);
		expect(writeText).toHaveBeenLastCalledWith("plain");
	});
});
