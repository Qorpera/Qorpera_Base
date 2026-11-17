// @vitest-environment jsdom
import { AuthError, type User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { renderAccount } from "../src/app/views/account.ts";
import { fixture, settle, userA } from "./fixtures.ts";

vi.mock("../src/app/views/crown.ts", () => ({ mountCrown: () => ({ dispose() {} }) }));

let root: HTMLElement;
let dispose: (() => void) | undefined;
let auth: AuthController | undefined;

beforeEach(() => {
	root = document.createElement("div");
	document.body.append(root);
	history.replaceState(null, "", "/#/");
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ external: {} })),
	);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	auth?.dispose();
	auth = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function drawn(): Promise<void> {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}

function type(id: string, value: string): void {
	const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
	input.value = value;
	input.dispatchEvent(new Event("input"));
}

describe("the app's sign-in gate", () => {
	it("keeps what the member typed when the sign-in page is drawn again", async () => {
		const f = fixture();
		f.auth(null);
		const signInWithPassword = vi.fn(async () => ({
			data: {},
			error: new AuthError("raw", 400, "invalid_credentials"),
		}));
		Object.assign(f.cloud.supabase.auth, { signInWithPassword });
		dispose = mountApplication(root, f.cloud, f.api);
		await drawn();
		const page = root.querySelector(".auth");
		type("signinEmail", "mette@lerhave.dk");
		type("signinPassword", "forkert1");
		root.querySelector<HTMLFormElement>("form.auth-form")!.requestSubmit();
		await drawn();
		expect(signInWithPassword).toHaveBeenCalledOnce();
		expect(root.querySelector(".auth")).toBe(page);
		expect(root.querySelector(".auth-alert")!.textContent).toContain("don't match an account");
		expect(root.querySelector<HTMLInputElement>("#signinEmail")!.value).toBe("mette@lerhave.dk");
	});

	it("asks a member without a name once, then opens the app", async () => {
		const f = fixture();
		f.auth({ ...userA, user_metadata: {} });
		const updateUser = vi.fn(async ({ data }: { data: Record<string, string> }) => ({
			data: { user: { ...userA, user_metadata: data } as User },
			error: null,
		}));
		Object.assign(f.cloud.supabase.auth, { updateUser });
		dispose = mountApplication(root, f.cloud, f.api);
		await drawn();
		expect(root.querySelector("h1")!.textContent).toBe("What should we call you?");
		expect(root.querySelector(".frame")).toBeNull();
		const screen = root.querySelector(".auth");
		type("accountNameAsk", "Mette Hansen");
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		await drawn();
		expect(root.querySelector(".auth")).toBe(screen);
		expect(root.querySelector<HTMLInputElement>("#accountNameAsk")!.value).toBe("Mette Hansen");
		root.querySelector<HTMLFormElement>("form.auth-form")!.requestSubmit();
		await drawn();
		expect(updateUser).toHaveBeenCalledWith({ data: { display_name: "Mette Hansen" } });
		expect(root.querySelector('.auth[data-step="name"]')).toBeNull();
		expect(root.querySelector(".frame")).not.toBeNull();
	});

	it("draws sign-in in place of the name question when the member signs out", async () => {
		const f = fixture();
		f.auth({ ...userA, user_metadata: {} });
		dispose = mountApplication(root, f.cloud, f.api);
		await drawn();
		expect(root.querySelector('.auth[data-step="name"]')).not.toBeNull();
		f.auth(null);
		await drawn();
		expect(root.querySelector('.auth[data-step="name"]')).toBeNull();
		expect(root.querySelector("h1")!.textContent).toBe("Welcome back");
	});
});

describe("the password row in Settings", () => {
	async function settings(result: { error: AuthError | null }) {
		vi.useRealTimers();
		const f = fixture();
		const updateUser = vi.fn(async () => ({ data: { user: userA }, error: result.error }));
		Object.assign(f.cloud.supabase.auth, { updateUser });
		auth = new AuthController(f.cloud);
		await auth.start();
		const render = () => renderAccount(auth!, root, {}, render);
		render();
		const input = root.querySelector<HTMLInputElement>(".account-password-input")!;
		const save = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
			(b) => b.textContent === "Save password",
		)!;
		return { updateUser, input, save, render };
	}

	it("saves a new password and says so", async () => {
		const { updateUser, input, save } = await settings({ error: null });
		input.value = "nytkodeord1";
		save.click();
		await settle();
		expect(updateUser).toHaveBeenCalledWith({ password: "nytkodeord1" });
		expect(input.value).toBe("");
		expect(root.querySelector(".account-password-feedback")!.textContent).toContain("Password saved.");
	});

	it("says a refusal in plain words and keeps the field across redraws", async () => {
		const { input, save, render } = await settings({ error: new AuthError("raw", 422, "same_password") });
		input.value = "gammelkode1";
		save.click();
		await settle();
		const feedback = root.querySelector(".account-password-feedback")!;
		expect(feedback.textContent).toContain("That's your current password.");
		expect(feedback.textContent).not.toContain("raw");
		render();
		expect(root.querySelector(".account-password-input")).toBe(input);
	});

	it("refuses a short password before asking Auth", async () => {
		const { updateUser, input, save } = await settings({ error: null });
		input.value = "kort";
		save.click();
		await settle();
		expect(updateUser).not.toHaveBeenCalled();
		expect(root.querySelector(".account-password-feedback")!.textContent).toContain("at least 8 characters");
	});
});
