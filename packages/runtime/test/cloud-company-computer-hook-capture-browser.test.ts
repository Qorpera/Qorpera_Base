import { createHash } from "node:crypto";
import {
	CompanyComputerGuestAutomation,
	type CompanyComputerGuestCommands,
	closeCompanyComputerShowingTab,
} from "@qorpera/runtime/cloud-company-computer-guest";
import {
	CompanyHookCaptureRefusedError,
	captureCompanyHookSecret,
} from "@qorpera/runtime/cloud-company-computer-hook-capture";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerEffect,
	computerId,
	computerLease,
	computerOperation,
} from "./fixtures/company-computer.ts";

const executablePath = process.env.QORPERA_PRESENCE_TEST_BROWSER;
const address = `${"a".repeat(20)}B_-${"c".repeat(20)}`;
const hook = { address, site: "dashboard.stripe.com" };
const secret = "whsec_AbCdEfGhIjKlMnOpQrStUvWxYz012345+/=";
const timing = { revealMs: 3_000, settleMs: 100, pollMs: 20 };

const rest = secret.slice("whsec_".length);
/** The secret split in one run of a wrapper that draws no box (`display: contents`), the rest drawn by a nested open
 * shadow root through its slot. */
const nested = `<div style="display: contents"><span>whsec_</span><secret-rest>${rest}</secret-rest></div>`;
/** The secret split across two shadow roots: `whsec_` drawn by the outer one, the rest by a nested one of its own. */
const roots = "<span>whsec_</span><secret-tail></secret-tail>";
/** The review's case: the secret split across two spans in a wrapper that draws no box. */
const spans = `<div style="display: contents"><span>whsec_</span><span>${rest}</span></div>`;
/** The secret split across two flex items, the rest drawn where the first piece ends. */
const flexItems = `<div style="display: flex"><span>whsec_</span><span>${rest}</span></div>`;

/**
 * Stripe's endpoint page, in a real browser: Reveal draws `value` in an open shadow root, beside values it does not
 * draw (a `hidden` one and a `visibility: hidden` one) unless `decoys` is false. With `stays`, the reveal is kept for
 * the tab, so a reload shows it again.
 */
function endpointPage(stays: boolean, value: string, decoys: boolean): string {
	const hidden = decoys ? `<span hidden>${secret}0</span><span style="visibility: hidden">${secret}1</span>` : "";
	return `<!doctype html><title>Webhook</title>
<p>Webhook endpoint https://x.supabase.co/functions/v1/event-intake/${address}</p>
<p>Signing secret</p><stripe-secret></stripe-secret><button>Reveal</button>
<script>
customElements.define("secret-rest", class extends HTMLElement {
	connectedCallback() {
		if (!this.shadowRoot) this.attachShadow({ mode: "open" }).innerHTML = "<b><slot></slot></b>";
	}
});
customElements.define("secret-tail", class extends HTMLElement {
	connectedCallback() {
		if (!this.shadowRoot) this.attachShadow({ mode: "open" }).innerHTML = "<b>${rest}</b>";
	}
});
customElements.define("stripe-secret", class extends HTMLElement {
	connectedCallback() {
		const root = this.attachShadow({ mode: "open" });
		const show = () => {
			root.innerHTML = '<style>span { color: gray }</style>${hidden}${value}';
		};
		if (sessionStorage.getItem("shown")) show();
		document.querySelector("button").addEventListener("click", () => {
			if (${stays}) sessionStorage.setItem("shown", "1");
			show();
		});
	}
});
</script>`;
}

describe.skipIf(!executablePath)("a Stripe hook's signing secret read in Chromium (E3c-3)", () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await chromium.launch({ executablePath, headless: true });
	});
	afterAll(async () => {
		await browser?.close();
	});

	async function opened(stays: boolean, value: string, decoys = true) {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.route("https://dashboard.stripe.com/**", (route) =>
			route.fulfill({ contentType: "text/html", body: endpointPage(stays, value, decoys) }),
		);
		await page.goto("https://dashboard.stripe.com/test/webhooks/we_1");
		return { context, page };
	}
	const coverShown = "document.querySelector('[popover]:popover-open') !== null";

	/** The office's guest on this browser, with what it publishes and a desktop capture that only counts its calls. */
	function guest(context: BrowserContext) {
		const commands = {
			run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
			// A PNG header the size of the desktop, as the guest checks a desktop picture (not a real picture).
			capturePng: vi.fn(async () => {
				const bytes = Buffer.alloc(33);
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
				bytes.writeUInt32BE(13, 8);
				bytes.write("IHDR", 12);
				bytes.writeUInt32BE(1920, 16);
				bytes.writeUInt32BE(1200, 20);
				return new Uint8Array(bytes);
			}),
		} satisfies CompanyComputerGuestCommands;
		const publish = vi.fn(async (bytes: Uint8Array) => ({
			assetId: computerId(50),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			mediaType: "image/png" as const,
		}));
		const automation = new CompanyComputerGuestAutomation({
			binding: computerBinding(),
			layout: {
				workbenchRoot: "/srv/workbench",
				desktopHome: "/srv/desktop",
				screenStateRoot: "/srv/screens",
				browserProfilesRoot: "/srv/profiles",
			},
			boundary: { assertReady: async () => undefined },
			browser: {
				binding: computerBinding(),
				grant: { profileId: computerId(40), grantId: computerId(41), version: 1 },
				context,
				assertActive: async () => undefined,
				close: async () => undefined,
			},
			commands,
			screenshots: { publish },
		});
		const picture = (surface: "browser" | "desktop") =>
			automation.perform({ kind: "screenshot", surface }, computerLease(), computerEffect(), {
				...computerOperation(),
				tool: "computer_screenshot",
				arguments: { kind: "screenshot", surface },
			});
		return { commands, publish, picture };
	}

	it.each([
		["across a nested shadow root's slot", nested],
		["across two shadow roots", roots],
		["across two flex items that touch", flexItems],
	])(
		"reads the value a shadow root draws split %s, never the ones it does not draw, and uncovers the page",
		async (_, value) => {
			const { context, page } = await opened(false, value);
			const seen: string[] = [];
			await expect(
				captureCompanyHookSecret(
					page,
					page.getByRole("button", { name: "Reveal" }),
					hook,
					(v) => seen.push(v),
					timing,
				),
			).resolves.toBe(secret);
			expect(seen).not.toContain(`${secret}0`);
			expect(seen).not.toContain(`${secret}1`);
			expect(await page.evaluate(coverShown)).toBe(false);
			await context.close();
		},
	);

	it("keeps the cover on a page that draws the value split across two spans again after the reload, and the guest closes the tab", async () => {
		const { context, page } = await opened(true, spans);
		const seen: string[] = [];
		const refused = await captureCompanyHookSecret(
			page,
			page.getByRole("button", { name: "Reveal" }),
			hook,
			(v) => seen.push(v),
			timing,
		).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CompanyHookCaptureRefusedError);
		expect((refused as CompanyHookCaptureRefusedError).reason).toBe("VAULT_CAPTURE_NOT_HIDDEN");
		expect(seen).toContain(secret);
		// The reloaded page still shows the value, under the cover.
		expect(await page.evaluate("document.querySelector('stripe-secret').shadowRoot.textContent")).toContain(secret);
		expect(await page.evaluate(coverShown)).toBe(true);
		expect(await closeCompanyComputerShowingTab(context, page)).toBeUndefined();
		expect(page.isClosed()).toBe(true);
		expect(context.pages()).toHaveLength(1);
		await context.close();
	});

	it("takes no browser or desktop picture once an ordinary click draws the value split across two shadow roots", async () => {
		// No hidden values beside it: each root's own text shows a piece of the value only.
		const { context, page } = await opened(false, roots, false);
		const office = guest(context);
		const screenshot = vi.spyOn(page, "screenshot");
		// Before the click the page shows no value: both pictures are taken.
		await expect(office.picture("browser")).resolves.toMatchObject({ kind: "json", value: { surface: "browser" } });
		await expect(office.picture("desktop")).resolves.toMatchObject({ kind: "json", value: { surface: "desktop" } });
		expect(screenshot).toHaveBeenCalledOnce();
		expect(office.commands.capturePng).toHaveBeenCalledOnce();
		expect(office.publish).toHaveBeenCalledTimes(2);
		await page.getByRole("button", { name: "Reveal" }).click();
		expect(await page.evaluate("document.querySelector('stripe-secret').shadowRoot.textContent")).not.toContain(
			secret,
		);
		for (const surface of ["browser", "desktop"] as const)
			await expect(office.picture(surface), surface).rejects.toThrow("PRIVATE_FIELD_ON_SCREEN");
		// Refused before the capture: neither picture is taken again, and nothing is published.
		expect(screenshot).toHaveBeenCalledOnce();
		expect(office.commands.capturePng).toHaveBeenCalledOnce();
		expect(office.publish).toHaveBeenCalledTimes(2);
		await context.close();
	});
});
