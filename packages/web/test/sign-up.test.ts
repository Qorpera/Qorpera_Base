// @vitest-environment jsdom
import { AuthError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { renderNameAsk, renderSignIn } from "../src/app/views/signin.ts";
import { fixture, settle, userA } from "./fixtures.ts";

vi.mock("../src/app/views/crown.ts", () => ({ mountCrown: () => ({ dispose() {} }) }));

let auth: AuthController;
let root: HTMLElement;
let calls: ReturnType<typeof stubAuth>;

function authError(code: string): AuthError {
	return new AuthError(`raw ${code} message`, 400, code);
}

function stubAuth(f: ReturnType<typeof fixture>) {
	const methods = {
		signUp: vi.fn(async () => ({ data: { user: { id: "u", identities: [{}] }, session: null }, error: null })),
		signInWithPassword: vi.fn(async () => ({ data: {}, error: null as AuthError | null })),
		signInWithOtp: vi.fn(async () => ({ data: {}, error: null as AuthError | null })),
		verifyOtp: vi.fn(async () => ({ data: {}, error: null as AuthError | null })),
		resend: vi.fn(async () => ({ data: {}, error: null as AuthError | null })),
		resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null as AuthError | null })),
		updateUser: vi.fn(async () => ({ data: { user: null }, error: null as AuthError | null })),
	};
	Object.assign(f.cloud.supabase.auth, methods);
	return methods;
}

async function signedOut(): Promise<ReturnType<typeof fixture>> {
	const f = fixture();
	f.auth(null);
	calls = stubAuth(f);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ external: {} })),
	);
	auth = new AuthController(f.cloud);
	auth.store.subscribe(() => renderSignIn(auth, root));
	await auth.start();
	await settle();
	renderSignIn(auth, root);
	return f;
}

function type(id: string, value: string): void {
	const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
	input.value = value;
	input.dispatchEvent(new Event("input"));
}

function submit(): void {
	root.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
}

function click(text: string): void {
	const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
	if (!button) throw new Error(`No button "${text}"`);
	button.click();
}

beforeEach(() => {
	root = document.createElement("div");
	document.body.append(root);
	history.replaceState(null, "", "/");
});
afterEach(() => {
	auth?.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("creating an account", () => {
	it("sends the name with the account and waits for the email's code", async () => {
		await signedOut();
		click("Create an account");
		await settle();
		expect(root.querySelector("h1")!.textContent).toBe("Create your account");
		type("signinName", " Mette Hansen ");
		type("signinEmail", "Mette@Lerhave.dk");
		type("signinPassword", "hemmeligt1");
		submit();
		await settle();
		expect(calls.signUp).toHaveBeenCalledWith({
			email: "mette@lerhave.dk",
			password: "hemmeligt1",
			options: { data: { display_name: "Mette Hansen", password_set: true }, emailRedirectTo: expect.any(String) },
		});
		expect(auth.store.get().step).toEqual({ name: "confirm", email: "mette@lerhave.dk" });
		expect(root.querySelector("h1")!.textContent).toBe("Check your email");
		expect(root.querySelectorAll(".auth-code-box")).toHaveLength(8);
	});

	it("refuses a short password before asking Auth", async () => {
		await signedOut();
		auth.showStep("create");
		await settle();
		type("signinName", "Mette");
		type("signinEmail", "mette@lerhave.dk");
		type("signinPassword", "short");
		submit();
		await settle();
		expect(calls.signUp).not.toHaveBeenCalled();
		expect(root.querySelector(".auth-alert")!.textContent).toContain("at least 8 characters");
	});

	it("says an address already has an account, with the ways out", async () => {
		await signedOut();
		calls.signUp.mockResolvedValueOnce({ data: { user: { id: "u", identities: [] }, session: null }, error: null });
		auth.showStep("create");
		await settle();
		type("signinName", "Mette");
		type("signinEmail", "mette@lerhave.dk");
		type("signinPassword", "hemmeligt1");
		submit();
		await settle();
		expect(auth.store.get().step.name).toBe("create");
		const alert = root.querySelector(".auth-alert")!;
		expect(alert.textContent).toContain("There's already an account with this email.");
		click("Sign in instead");
		expect(auth.store.get().step.name).toBe("signin");
	});

	it("proves the email when the last digit is typed and rejects shorter codes", async () => {
		await signedOut();
		auth.store.set({ step: { name: "confirm", email: "mette@lerhave.dk" } });
		await settle();
		type("signinCode", "48 20a71 93");
		await settle();
		expect(calls.verifyOtp).toHaveBeenCalledWith({ email: "mette@lerhave.dk", token: "48207193", type: "email" });

		calls.verifyOtp.mockClear();
		auth.store.set({ step: { name: "code", email: "mette@lerhave.dk" } });
		await settle();
		type("signinCode", "482071");
		submit();
		await settle();
		expect(calls.verifyOtp).not.toHaveBeenCalled();
		expect(root.querySelector(".auth-alert")!.textContent).toContain("Enter the 8-digit code from the email.");
	});
});

describe("signing in", () => {
	it("uses the password, and answers a mismatch in plain words with the ways out", async () => {
		await signedOut();
		calls.signInWithPassword.mockResolvedValueOnce({ data: {}, error: authError("invalid_credentials") });
		type("signinEmail", "mette@lerhave.dk");
		type("signinPassword", "forkert");
		submit();
		await settle();
		expect(calls.signInWithPassword).toHaveBeenCalledWith({ email: "mette@lerhave.dk", password: "forkert" });
		const alert = root.querySelector(".auth-alert")!.textContent!;
		expect(alert).toContain("That email and password don't match an account.");
		expect(alert).not.toContain("raw");
		click("create an account");
		await settle();
		expect(auth.store.get().step.name).toBe("create");
		expect(root.querySelector<HTMLInputElement>("#signinEmail")!.value).toBe("mette@lerhave.dk");
	});

	it("sends a code to an existing account only, then signs in with it", async () => {
		await signedOut();
		type("signinEmail", "mette@lerhave.dk");
		click("Email me a code instead");
		await settle();
		expect(calls.signInWithOtp).toHaveBeenCalledWith({
			email: "mette@lerhave.dk",
			options: { emailRedirectTo: expect.any(String), shouldCreateUser: false },
		});
		expect(auth.store.get().step).toEqual({ name: "code", email: "mette@lerhave.dk" });
		expect(root.querySelector(".auth-resend")!.textContent).toMatch(/send a new code in 1:00|0:59/);
	});

	it("sends a new email code for an account whose email was never proven", async () => {
		await signedOut();
		calls.signInWithPassword.mockResolvedValueOnce({ data: {}, error: authError("email_not_confirmed") });
		type("signinEmail", "mette@lerhave.dk");
		type("signinPassword", "hemmeligt1");
		submit();
		await settle();
		expect(calls.resend).toHaveBeenCalledWith({
			type: "signup",
			email: "mette@lerhave.dk",
			options: { emailRedirectTo: expect.any(String) },
		});
		expect(auth.store.get().step.name).toBe("confirm");
	});
});

describe("a new password", () => {
	it("asks for the email first", async () => {
		await signedOut();
		click("Forgot password?");
		await settle();
		expect(calls.resetPasswordForEmail).not.toHaveBeenCalled();
		expect(root.querySelector(".auth-alert")!.textContent).toContain("Type your email first");
	});

	it("takes the code and the new password together", async () => {
		await signedOut();
		type("signinEmail", "mette@lerhave.dk");
		click("Forgot password?");
		await settle();
		expect(calls.resetPasswordForEmail).toHaveBeenCalledWith("mette@lerhave.dk", { redirectTo: expect.any(String) });
		expect(root.querySelector("h1")!.textContent).toBe("Choose a new password");
		type("signinCode", "48207193");
		await settle();
		expect(calls.verifyOtp).not.toHaveBeenCalled();
		type("signinNewPassword", "nytkodeord1");
		submit();
		await settle();
		expect(calls.verifyOtp).toHaveBeenCalledWith({ email: "mette@lerhave.dk", token: "48207193", type: "recovery" });
		expect(calls.updateUser).toHaveBeenCalledWith({ password: "nytkodeord1", data: { password_set: true } });
		expect(auth.store.get().step.name).toBe("signin");
	});

	it("says a wrong or old code in plain words", async () => {
		await signedOut();
		calls.verifyOtp.mockResolvedValueOnce({ data: {}, error: authError("otp_expired") });
		auth.store.set({ step: { name: "reset", email: "mette@lerhave.dk" } });
		await settle();
		type("signinCode", "48207193");
		type("signinNewPassword", "nytkodeord1");
		submit();
		await settle();
		expect(calls.updateUser).not.toHaveBeenCalled();
		expect(root.querySelector(".auth-alert")!.textContent).toContain("That code is wrong or too old.");
	});
});

describe("a new password that is refused after the code signed in", () => {
	it("keeps the reset screen with the reason, and tries the password again without the used code", async () => {
		const f = await signedOut();
		calls.verifyOtp.mockImplementationOnce(async () => {
			f.auth(userA);
			return { data: {}, error: null };
		});
		calls.updateUser.mockResolvedValueOnce({ data: { user: null }, error: authError("same_password") });
		auth.store.set({ step: { name: "reset", email: "mette@lerhave.dk" } });
		await settle();
		type("signinCode", "48207193");
		type("signinNewPassword", "gammelkode1");
		submit();
		await settle();
		expect(auth.store.get().session).not.toBeNull();
		expect(auth.store.get().step).toEqual({ name: "reset", email: "mette@lerhave.dk", verified: true });
		expect(root.querySelector("#signinCode")).toBeNull();
		expect(root.querySelector(".auth-alert")!.textContent).toContain("That's your current password.");
		type("signinNewPassword", "nytkodeord1");
		submit();
		await settle();
		expect(calls.verifyOtp).toHaveBeenCalledOnce();
		expect(calls.updateUser).toHaveBeenLastCalledWith({ password: "nytkodeord1", data: { password_set: true } });
		expect(auth.store.get().step.name).toBe("signin");
	});

	it("never takes a session from elsewhere for the reset's code", async () => {
		const f = await signedOut();
		auth.store.set({ step: { name: "reset", email: "mette@lerhave.dk" } });
		await settle();
		f.auth(userA);
		await settle();
		expect(auth.store.get().step.name).toBe("signin");
		await auth.resetPassword("12345678", "nytkodeord1");
		expect(calls.verifyOtp).not.toHaveBeenCalled();
		expect(calls.updateUser).not.toHaveBeenCalled();
	});

	it("asks for the code when the reset has a session it did not make", async () => {
		const f = await signedOut();
		f.auth(userA);
		auth.store.set({ step: { name: "reset", email: "mette@lerhave.dk" } });
		await settle();
		type("signinCode", "48207193");
		type("signinNewPassword", "nytkodeord1");
		submit();
		await settle();
		expect(calls.verifyOtp).toHaveBeenCalledWith({ email: "mette@lerhave.dk", token: "48207193", type: "recovery" });
		expect(calls.verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(calls.updateUser.mock.invocationCallOrder[0]!);
	});

	it("lets the reset step go when the member is signed out", async () => {
		const f = await signedOut();
		f.auth(userA);
		auth.store.set({ step: { name: "reset", email: "mette@lerhave.dk" }, error: "old" });
		f.auth(null);
		await settle();
		expect(auth.store.get().step.name).toBe("signin");
		expect(auth.store.get().error).toBeUndefined();
	});
});

describe("a member without a name", () => {
	it("is asked once and goes on when it is saved", async () => {
		const f = fixture();
		f.auth({ ...userA, user_metadata: {} });
		calls = stubAuth(f);
		auth = new AuthController(f.cloud);
		const done = vi.fn();
		const updateName = vi.spyOn(auth, "updateName").mockResolvedValue();
		renderNameAsk(auth, root, done);
		expect(root.querySelector("h1")!.textContent).toBe("What should we call you?");
		type("accountNameAsk", "Mette Hansen");
		submit();
		await settle();
		expect(updateName).toHaveBeenCalledWith("Mette Hansen");
		expect(done).toHaveBeenCalledOnce();
	});
});
