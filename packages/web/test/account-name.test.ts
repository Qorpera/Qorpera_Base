// @vitest-environment jsdom
import { AuthError, type User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController, accountName, displayName } from "../src/app/auth.ts";
import { renderAccount } from "../src/app/views/account.ts";
import { deferred, fixture, settle, userA, userB } from "./fixtures.ts";

let auth: AuthController;
let root: HTMLElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
	root = document.createElement("div");
	document.body.append(root);
	history.replaceState(null, "", "/#/");
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	auth?.dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup(named = false) {
	const f = fixture();
	f.auth(named ? userA : { ...userA, user_metadata: {} });
	const update = vi.fn(
		async ({
			data,
		}: {
			data: { display_name: string };
		}): Promise<{ data: { user: User }; error: AuthError | null }> => ({
			data: { user: { ...userA, user_metadata: { ...userA.user_metadata, ...data } } },
			error: null as AuthError | null,
		}),
	);
	Object.assign(f.cloud.supabase.auth, { updateUser: update });
	auth = new AuthController(f.cloud);
	await auth.start();
	const render = () => renderAccount(auth, root, {}, render);
	render();
	return { f, update, render, input: root.querySelector<HTMLInputElement>(".account-name-input")! };
}

describe("editable account name", () => {
	it("starts with the requested placeholder and puts email beneath it", async () => {
		const { input } = await setup();
		expect(input.value).toBe("");
		expect(input.placeholder).toBe("write your name");
		expect(input.getAttribute("aria-label")).toBe("Username");
		expect(input.nextElementSibling?.textContent).toBe(userA.email);
		expect(root.textContent).not.toContain("Signed in");
		expect(displayName(auth.store.get().user)).toBe("Member");
	});

	it("saves a trimmed name on Enter and keeps it after reopening", async () => {
		const { input, update } = await setup();
		input.value = "  Jonas  ";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(update).toHaveBeenCalledExactlyOnceWith({ data: { display_name: "Jonas" } });
		expect(displayName(auth.store.get().user)).toBe("Jonas");
		expect(auth.store.get().session?.user.user_metadata.display_name).toBe("Jonas");
		expect(auth.store.get().session?.user.user_metadata.full_name).toBe("Account A");
		const reopened = document.createElement("div");
		renderAccount(auth, reopened, {}, () => {});
		expect(reopened.querySelector<HTMLInputElement>(".account-name-input")!.value).toBe("Jonas");
	});

	it("preserves the draft, selection, and focus across account redraws", async () => {
		const { input, render, update } = await setup();
		input.focus();
		input.value = "Draft name";
		input.setSelectionRange(3, 6);
		// Real browsers blur focused inputs when they are reparented; jsdom does not.
		const append = Node.prototype.appendChild;
		vi.spyOn(Node.prototype, "appendChild").mockImplementation(function <T extends Node>(this: Node, child: T): T {
			if ((child as Node) === input && input.parentNode) input.dispatchEvent(new FocusEvent("blur"));
			return append.call(this, child) as T;
		});
		render();
		expect(root.querySelector(".account-name-input")).toBe(input);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("Draft name");
		expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
		expect(update).not.toHaveBeenCalled();
	});

	it("saves on blur and avoids duplicate requests while saving", async () => {
		const { input, update } = await setup();
		const pending = deferred<Awaited<ReturnType<typeof update>>>();
		update.mockReturnValue(pending.promise);
		input.focus();
		input.value = "Jonas";
		input.blur();
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(update).toHaveBeenCalledTimes(1);
		expect(input.readOnly).toBe(true);
		pending.resolve({
			data: { user: { ...userA, user_metadata: { full_name: "Account A", display_name: "Jonas" } } },
			error: null,
		});
		await settle();
		expect(input.readOnly).toBe(false);
		expect(input.value).toBe("Jonas");
	});

	it("cancels with Escape without closing settings or persisting the draft", async () => {
		const { input, update } = await setup(true);
		const outside = vi.fn();
		root.addEventListener("keydown", outside);
		input.focus();
		input.value = "Unwanted";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(input.value).toBe("Account A");
		expect(update).not.toHaveBeenCalled();
		expect(outside).not.toHaveBeenCalled();
	});

	it.each(["   ", "x".repeat(65), "Bad\u0000name"])("rejects invalid name %j before saving", async (value) => {
		const { update } = await setup(true);
		await expect(auth.updateName(value)).rejects.toThrow("Enter a name");
		expect(update).not.toHaveBeenCalled();
	});

	it("keeps a failed draft available for retry without changing the saved name", async () => {
		const { input, update, render } = await setup(true);
		update.mockResolvedValueOnce({ data: { user: userA }, error: new AuthError("Unavailable") });
		input.value = "Jonas";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await settle();
		render();
		expect(root.querySelector("[role=alert]")?.textContent).toContain("Your name could not be saved");
		expect(input.value).toBe("Jonas");
		expect(displayName(auth.store.get().user)).toBe("Account A");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		await settle();
		expect(root.querySelector("[role=alert]")).toBeNull();
		expect(displayName(auth.store.get().user)).toBe("Jonas");
	});

	it("does not restore the previous account after a late save response", async () => {
		const { f, update } = await setup(true);
		const pending = deferred<Awaited<ReturnType<typeof update>>>();
		update.mockReturnValue(pending.promise);
		const saving = auth.updateName("Jonas");
		f.auth(userB);
		pending.resolve({
			data: { user: { ...userA, user_metadata: { full_name: "Account A", display_name: "Jonas" } } },
			error: null,
		});
		await saving;
		expect(auth.store.get().user).toEqual(userB);
	});

	it("prefers the edited name over provider metadata", () => {
		expect(accountName({ ...userA, user_metadata: { display_name: "Jonas", full_name: "Provider name" } })).toBe(
			"Jonas",
		);
	});

	it("updates the sidebar account name after saving from settings", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		const f = fixture();
		Object.assign(f.cloud.supabase.auth, {
			updateUser: vi.fn(async () => ({
				data: { user: { ...userA, user_metadata: { display_name: "Jonas" } } },
				error: null,
			})),
		});
		dispose = mountApplication(root, f.cloud, f.api);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
		root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
		await settle();
		const input = root.querySelector<HTMLInputElement>(".account-name-input")!;
		input.value = "Jonas";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(root.querySelector(".account-trigger-name")?.textContent).toBe("Jonas");
		expect(root.querySelector(".account-trigger")?.getAttribute("aria-label")).toBe("Profile: Jonas");
	});
});
