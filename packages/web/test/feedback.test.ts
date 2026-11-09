// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { deferred, fixture, profileA, session, settle, userB } from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function open() {
	const f = fixture();
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud, f.api);
	await settle();
	await vi.advanceTimersByTimeAsync(60);
	const composer = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
	composer.value = "Unsent conversation draft";
	composer.dispatchEvent(new Event("input"));
	root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
	root.querySelector<HTMLButtonElement>('[data-account-action="feedback"]')!.click();
	const dialog = root.querySelector<HTMLDialogElement>(".feedback-dialog")!;
	return {
		...f,
		root,
		composer,
		dialog,
		form: dialog.querySelector("form")!,
		details: dialog.querySelector("textarea")!,
		submit: dialog.querySelector<HTMLButtonElement>('[type="submit"]')!,
	};
}
/** The RPCs made, besides the company's mail (with its Digital Post), offers, consents and pages reads, which run while
 * it is open (Interfaces steps I5c, I9c, C6a and C6d; RUNTIME-DIGITAL-POST.md). */
function rpcs(f: ReturnType<typeof fixture>): string[] {
	return vi
		.mocked(f.cloud.rpc)
		.mock.calls.map(([name]) => name)
		.filter(
			(name) =>
				!name.startsWith("qorpera_member_mail_") &&
				name !== "qorpera_member_digital_post" &&
				name !== "qorpera_member_interface_offers" &&
				// The apps drawer's Sites entry.
				name !== "qorpera_list_company_sites" &&
				name !== "qorpera_member_interface_supervisions" &&
				name !== "qorpera_member_interface_pages",
		);
}
function fill(details: HTMLTextAreaElement, value = "The sidebar is clearer."): void {
	details.value = value;
	details.dispatchEvent(new Event("input"));
}

describe("profile feedback", () => {
	it("opens from the profile menu, preserves the conversation, and stays out of General settings", async () => {
		const f = await open();
		expect(f.dialog.open).toBe(true);
		expect(document.activeElement).toBe(f.details);
		expect(f.root.querySelector<HTMLElement>(".account-popover")!.hidden).toBe(true);
		f.dialog.querySelector<HTMLButtonElement>(".feedback-close")!.click();
		expect(f.dialog.isConnected).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector(".account-trigger"));
		expect(f.composer.value).toBe("Unsent conversation draft");
		f.root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
		f.root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
		expect(f.root.querySelector(".settings-feedback")).toBeNull();
		expect(f.root.querySelector(".settings-dialog")?.textContent).not.toContain("Share feedback");
		// General's only RPC is the chosen company's rules list.
		expect(rpcs(f).filter((name) => name !== "qorpera_list_review_rules")).toEqual([]);
	});
	it("requires details, permits deselecting a category, and submits through the account feedback RPC only", async () => {
		const f = await open();
		expect(f.submit.disabled).toBe(true);
		fill(f.details, "   ");
		expect(f.submit.disabled).toBe(true);
		f.form.dispatchEvent(new Event("submit", { cancelable: true }));
		expect(rpcs(f)).toEqual([]);
		const bug = f.dialog.querySelector<HTMLButtonElement>(".feedback-category")!;
		bug.click();
		expect(bug.getAttribute("aria-pressed")).toBe("true");
		bug.click();
		expect(bug.getAttribute("aria-pressed")).toBe("false");
		fill(f.details, "  A useful detail.  ");
		vi.mocked(f.cloud.rpc).mockResolvedValue(undefined);
		f.submit.click();
		await settle();
		expect(f.cloud.rpc).toHaveBeenCalledWith("qorpera_submit_product_feedback", {
			p_client_feedback_id: expect.any(String),
			p_category: "other",
			p_details: "A useful detail.",
			p_include_diagnostics: false,
			p_diagnostics: {},
		});
		expect(rpcs(f)).toEqual(["qorpera_submit_product_feedback"]);
		expect(f.dialog.textContent).toContain("Feedback sent. Thank you.");
		expect(f.submit.textContent).toBe("Sent");
		await vi.advanceTimersByTimeAsync(899);
		expect(f.dialog.isConnected).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.dialog.isConnected).toBe(false);
		expect(f.composer.value).toBe("Unsent conversation draft");
	});
	it("blocks duplicate sends and dismissal while pending, then retains the draft and id for retry", async () => {
		const f = await open(),
			pending = deferred<void>();
		const send = vi.spyOn(f.api, "submitFeedback").mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
		f.dialog.querySelector<HTMLButtonElement>(".feedback-category")!.click();
		fill(f.details);
		f.submit.click();
		f.form.dispatchEvent(new Event("submit", { cancelable: true }));
		f.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
		f.dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(send).toHaveBeenCalledTimes(1);
		expect(f.dialog.isConnected).toBe(true);
		expect(f.details.disabled).toBe(true);
		pending.reject(new Error("Connection interrupted"));
		await settle();
		expect(f.dialog.textContent).toContain("Connection interrupted");
		expect(f.submit.textContent).toBe("Try again");
		expect(f.details.value).toBe("The sidebar is clearer.");
		expect(f.details.disabled).toBe(false);
		f.submit.click();
		await settle();
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
		expect(send.mock.calls[0]?.[1]).toBe("bug");
	});
	it.each(["account", "route", "dispose"])("discards late feedback completion after %s changes", async (change) => {
		const f = await open(),
			pending = deferred<void>();
		vi.spyOn(f.api, "submitFeedback").mockReturnValue(pending.promise);
		fill(f.details);
		f.submit.click();
		if (change === "account") f.auth(userB);
		else if (change === "route") {
			location.hash = "#/account";
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		} else {
			dispose?.();
			dispose = undefined;
		}
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(f.dialog.isConnected).toBe(false);
		const focus = document.activeElement;
		pending.resolve();
		await settle();
		await vi.advanceTimersByTimeAsync(1000);
		expect(document.querySelector(".feedback-dialog")).toBeNull();
		expect(document.activeElement).toBe(focus);
		expect(f.root.textContent).not.toContain("Feedback sent");
	});
});
