import { closeCompanyComputerShowingTab } from "@qorpera/runtime/cloud-company-computer-guest";
import {
	CompanyHookCaptureRefusedError,
	captureCompanyHookSecret,
} from "@qorpera/runtime/cloud-company-computer-hook-capture";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const executablePath = process.env.QORPERA_PRESENCE_TEST_BROWSER;
const address = `${"a".repeat(20)}B_-${"c".repeat(20)}`;
const hook = { address, site: "dashboard.stripe.com" };
const secret = "whsec_AbCdEfGhIjKlMnOpQrStUvWxYz012345+/=";
const timing = { revealMs: 3_000, settleMs: 100, pollMs: 20 };

/**
 * Stripe's endpoint page, in a real browser: Reveal draws the secret in an open shadow root as text in a wrapper that
 * draws no box (`display: contents`), beside a value it does not draw (a `hidden` one). With `stays`, the reveal is
 * kept for the tab, so a reload shows it again.
 */
function endpointPage(stays: boolean): string {
	return `<!doctype html><title>Webhook</title>
<p>Webhook endpoint https://x.supabase.co/functions/v1/event-intake/${address}</p>
<p>Signing secret</p><stripe-secret></stripe-secret><button>Reveal</button>
<script>
customElements.define("stripe-secret", class extends HTMLElement {
	connectedCallback() {
		const root = this.attachShadow({ mode: "open" });
		const show = () => {
			root.innerHTML = '<style>span { color: gray }</style><span hidden>${secret}0</span><div style="display: contents">${secret}</div>';
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

	async function opened(stays: boolean) {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.route("https://dashboard.stripe.com/**", (route) =>
			route.fulfill({ contentType: "text/html", body: endpointPage(stays) }),
		);
		await page.goto("https://dashboard.stripe.com/test/webhooks/we_1");
		return { context, page };
	}
	const coverShown = "document.querySelector('[popover]:popover-open') !== null";

	it("reads the value a boxless wrapper in a shadow root draws, never the one it does not, and uncovers the page", async () => {
		const { context, page } = await opened(false);
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
		expect(await page.evaluate(coverShown)).toBe(false);
		await context.close();
	});

	it("keeps the cover on a page that draws the value there again after the reload, and the guest closes the tab", async () => {
		const { context, page } = await opened(true);
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
});
