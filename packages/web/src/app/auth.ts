import type { Session, User } from "@supabase/supabase-js";
import { type Cloud, forgetStoredSession, type SessionRejection } from "../cloud/client.ts";
import { forgetMemberFiles } from "../cloud/company-files.ts";
import { t } from "../ui/preferences.ts";
import { Store } from "./state.ts";

export const CODE_MIN_LENGTH = 6;
export const CODE_LENGTH = 8;
export const PASSWORD_MIN = 8;
const RESEND_WAIT_MS = 60_000;

export type AuthStep =
	| { name: "signin" }
	| { name: "create" }
	| { name: "confirm"; email: string }
	| { name: "code"; email: string }
	| { name: "reset"; email: string; verified?: boolean };

export type AuthErrorKind = "mismatch" | "exists";

export interface AuthState {
	ready: boolean;
	session: Session | null;
	user: User | null;
	step: AuthStep;
	resendAt?: number;
	message?: string;
	error?: string;
	errorKind?: AuthErrorKind;
	busy: boolean;
	oauthProviders: OAuthProvider[];
}

export type OAuthProvider = "github" | "google";

/** What a sign-in callback carries in the address. ui/boot.ts shows no static first screen while one is finished. */
export const SIGN_IN_CALLBACK_FIELDS = [
	"code",
	"access_token",
	"refresh_token",
	"provider_token",
	"provider_refresh_token",
	"error",
	"error_code",
	"error_description",
];

export class AuthController {
	readonly store = new Store<AuthState>({
		ready: false,
		session: null,
		user: null,
		step: { name: "signin" },
		busy: false,
		oauthProviders: [],
	});
	readonly #cloud: Cloud;
	#disposed = false;
	#unsubscribe?: () => void;
	#stopRejections?: () => void;
	#providerRequest?: AbortController;
	/** A refused session is being signed out; further refusals wait for that one sign-out. */
	#signingOut = false;
	#verifyingRecovery = false;

	constructor(cloud: Cloud) {
		this.#cloud = cloud;
	}

	async start(): Promise<void> {
		// Listen before the first cloud read, so a session refused on the first request is seen.
		this.#stopRejections = this.#cloud.onSessionRejected?.((rejection) => this.#sessionRejected(rejection));
		const original = new URL(location.href);
		const originalFragment = new URLSearchParams(original.hash.slice(1));
		const queryCallback = SIGN_IN_CALLBACK_FIELDS.some((key) => original.searchParams.has(key));
		const fragmentCallback =
			!original.hash.startsWith("#/") && SIGN_IN_CALLBACK_FIELDS.some((key) => originalFragment.has(key));
		const { error: initializationError } = await this.#cloud.supabase.auth.initialize().finally(() => {
			// Let Auth consume the callback first, then remove credentials even
			// when it rejects an expired or mismatched flow. Preserve app routes.
			const url = new URL(location.href);
			const fields = [...SIGN_IN_CALLBACK_FIELDS, "sb_flow_id", "expires_in", "expires_at", "token_type", "type"];
			if (queryCallback) {
				for (const key of fields) {
					if (JSON.stringify(original.searchParams.getAll(key)) === JSON.stringify(url.searchParams.getAll(key)))
						url.searchParams.delete(key);
				}
			}
			if (fragmentCallback && url.hash === original.hash) {
				for (const key of fields) originalFragment.delete(key);
				url.hash = originalFragment.toString() || "/";
			}
			if (url.href !== location.href)
				history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
		});
		const { data, error } = await this.#cloud.supabase.auth.getSession();
		if (this.#disposed) return;
		this.store.set({
			ready: true,
			session: data.session,
			user: data.session?.user ?? null,
			error:
				!data.session && (initializationError || error || queryCallback || fragmentCallback)
					? t("Sign-in could not be completed. Try again.")
					: undefined,
		});
		if (!data.session) void this.#loadProviders();
		const {
			data: { subscription },
		} = this.#cloud.supabase.auth.onAuthStateChange((_event, session) => {
			this.store.set({ session, user: session?.user ?? null, ready: true });
			const step = this.store.get().step;
			const resetUnproven = step.name === "reset" && !step.verified && !this.#verifyingRecovery;
			if (session) {
				if (resetUnproven) this.store.set({ step: { name: "signin" }, error: undefined, errorKind: undefined });
				return;
			}
			if (step.name === "reset")
				this.store.set({ step: { name: "signin" }, error: undefined, errorKind: undefined });
			// Signed out, however it came about: no file read as the member stays in this tab.
			forgetMemberFiles();
			void this.#loadProviders();
		});
		this.#unsubscribe = () => subscription.unsubscribe();
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#stopRejections?.();
		this.#providerRequest?.abort();
		this.store.dispose();
	}

	/* A session the cloud no longer accepts (new signing keys, a revoked or expired token)
	 * is a signed-out member: clear it in this browser and show sign-in, once. Only a refusal
	 * of the token this browser holds now counts; a late answer to a request sent with an
	 * earlier token, a permission refusal or a network failure leaves the member signed in. */
	#sessionRejected(rejection: SessionRejection): void {
		const session = this.store.get().session;
		if (this.#disposed || !session || this.#signingOut) return;
		const refused =
			rejection.accessToken !== undefined
				? rejection.accessToken === session.access_token
				: rejection.refreshToken !== undefined && rejection.refreshToken === session.refresh_token;
		if (!refused) return;
		this.#signingOut = true;
		void this.#signOutRejected(session);
	}

	async #signOutRejected(session: Session): Promise<void> {
		try {
			// A refresh may have replaced the refused token while this waited for Auth's lock: that session stays.
			const { data } = await this.#cloud.supabase.auth.getSession();
			if (data.session && data.session.access_token !== session.access_token) return;
			// Local only: the cloud already refuses this session, so there is nothing to revoke there.
			const { error } = await this.#cloud.supabase.auth.signOut({ scope: "local" });
			// Auth keeps a session it could not load (a refresh that failed on the network): forget it here.
			if (error) forgetStoredSession();
		} catch {
			forgetStoredSession();
		} finally {
			this.#signingOut = false;
		}
		if (this.#disposed) return;
		const current = this.store.get().session;
		// The member signed in again meanwhile: that session is a new one and stays.
		if (current && current.access_token !== session.access_token) return;
		// Auth may not have said it signed out (its sign-out failed): no file read as the member stays in this tab.
		forgetMemberFiles();
		this.store.set({
			session: null,
			user: null,
			step: { name: "signin" },
			resendAt: undefined,
			error: undefined,
			errorKind: undefined,
			message: t("You were signed out. Sign in again."),
		});
		if (current) void this.#loadProviders();
	}

	async #loadProviders(): Promise<void> {
		if (this.#disposed || this.#providerRequest) return;
		const request = new AbortController();
		this.#providerRequest = request;
		const timeout = setTimeout(() => request.abort(), 5000);
		try {
			// Public Auth settings expose enabled providers without a member or admin token.
			const response = await fetch(`${this.#cloud.config.projectUrl}/auth/v1/settings`, {
				headers: { apikey: this.#cloud.config.publishableKey },
				credentials: "omit",
				signal: request.signal,
			});
			if (!response.ok) throw new Error("Auth settings unavailable");
			const settings: unknown = await response.json();
			const external =
				settings && typeof settings === "object" && "external" in settings ? settings.external : undefined;
			const providers: OAuthProvider[] = ["google", "github"];
			const oauthProviders = providers.filter(
				(provider) =>
					external && typeof external === "object" && (external as Record<string, unknown>)[provider] === true,
			);
			if (!this.#disposed) this.store.set({ oauthProviders });
		} catch {
			// Email remains usable when discovery fails; never advertise an unverified provider.
			if (!this.#disposed) this.store.set({ oauthProviders: [] });
		} finally {
			clearTimeout(timeout);
			this.#providerRequest = undefined;
		}
	}

	get accessToken(): string | undefined {
		return this.store.get().session?.access_token;
	}

	get userId(): string | undefined {
		return this.store.get().user?.id;
	}

	#redirectTo(): string {
		return `${location.origin}${location.pathname}`;
	}

	showStep(name: "signin" | "create"): void {
		this.store.set({
			step: { name },
			resendAt: undefined,
			error: undefined,
			errorKind: undefined,
			message: undefined,
		});
	}

	back(): void {
		this.showStep(this.store.get().step.name === "confirm" ? "create" : "signin");
	}

	async signInWithPassword(email: string, password: string): Promise<void> {
		const address = normalEmail(email);
		if (!address) return this.#fail(t("Enter a valid email address."));
		if (!password) return this.#fail(t("Enter your password."));
		await this.#run(async () => {
			const { error } = await this.#cloud.supabase.auth.signInWithPassword({ email: address, password });
			if (!error) return;
			if (authCode(error) === "email_not_confirmed") {
				const resent = await this.#cloud.supabase.auth.resend({
					type: "signup",
					email: address,
					options: { emailRedirectTo: this.#redirectTo() },
				});
				if (resent.error) throw resent.error;
				this.#waitForCode(
					{ name: "confirm", email: address },
					t("Confirm your email first. We sent you a new code."),
				);
				return;
			}
			throw error;
		});
	}

	async createAccount(name: string, email: string, password: string): Promise<void> {
		const displayName = name.trim();
		const address = normalEmail(email);
		if (!displayName || displayName.length > 64 || /[\u0000-\u001f\u007f]/.test(displayName))
			return this.#fail(t("Enter a name between 1 and 64 characters."));
		if (!address) return this.#fail(t("Enter a valid email address."));
		if (password.length < PASSWORD_MIN) return this.#fail(t("Use at least 8 characters for your password."));
		await this.#run(async () => {
			const { data, error } = await this.#cloud.supabase.auth.signUp({
				email: address,
				password,
				options: { data: { display_name: displayName, password_set: true }, emailRedirectTo: this.#redirectTo() },
			});
			if (error) throw error;
			// WHY: Auth answers an address that already has a proven account with a user without identities, and sends nothing.
			if (data.user && data.user.identities?.length === 0) {
				this.store.set({ error: t("There's already an account with this email."), errorKind: "exists" });
				return;
			}
			if (data.session) return;
			this.#waitForCode({ name: "confirm", email: address });
		});
	}

	async sendEmailCode(email: string): Promise<void> {
		const address = normalEmail(email);
		if (!address) return this.#fail(t("Enter a valid email address."));
		await this.#run(async () => {
			const { error } = await this.#cloud.supabase.auth.signInWithOtp({
				email: address,
				options: { emailRedirectTo: this.#redirectTo(), shouldCreateUser: false },
			});
			if (error) throw error;
			this.#waitForCode({ name: "code", email: address });
		});
	}

	async forgotPassword(email: string): Promise<void> {
		const address = normalEmail(email);
		if (!address) return this.#fail(t("Type your email first, then choose Forgot password."));
		await this.#run(async () => {
			const { error } = await this.#cloud.supabase.auth.resetPasswordForEmail(address, {
				redirectTo: this.#redirectTo(),
			});
			if (error) throw error;
			this.#waitForCode({ name: "reset", email: address });
		});
	}

	async verifyEmailCode(token: string): Promise<void> {
		const step = this.store.get().step;
		if (step.name !== "confirm" && step.name !== "code") return;
		const code = token.replace(/\D/g, "");
		if (code.length < CODE_MIN_LENGTH || code.length > CODE_LENGTH)
			return this.#fail(t("Enter the code from the email."));
		await this.#run(async () => {
			const { error } = await this.#cloud.supabase.auth.verifyOtp({ email: step.email, token: code, type: "email" });
			if (error) throw error;
			this.store.set({ step: { name: "signin" }, resendAt: undefined, message: undefined });
		});
	}

	async resetPassword(token: string, password: string): Promise<void> {
		const step = this.store.get().step;
		if (step.name !== "reset") return;
		const code = token.replace(/\D/g, "");
		if (!step.verified && (code.length < CODE_MIN_LENGTH || code.length > CODE_LENGTH))
			return this.#fail(t("Enter the code from the email."));
		if (password.length < PASSWORD_MIN) return this.#fail(t("Use at least 8 characters for your password."));
		await this.#run(async () => {
			if (!step.verified) {
				this.#verifyingRecovery = true;
				try {
					const verified = await this.#cloud.supabase.auth.verifyOtp({
						email: step.email,
						token: code,
						type: "recovery",
					});
					if (verified.error) throw verified.error;
				} finally {
					this.#verifyingRecovery = false;
				}
				this.store.set({ step: { name: "reset", email: step.email, verified: true } });
			}
			const { error } = await this.#cloud.supabase.auth.updateUser({ password, data: { password_set: true } });
			if (error) throw error;
			this.store.set({ step: { name: "signin" }, resendAt: undefined, message: undefined });
		});
	}

	async resendCode(): Promise<void> {
		const { step, resendAt } = this.store.get();
		if (step.name !== "confirm" && step.name !== "code" && step.name !== "reset") return;
		if (resendAt && Date.now() < resendAt) return;
		await this.#run(async () => {
			const auth = this.#cloud.supabase.auth;
			const options = { emailRedirectTo: this.#redirectTo() };
			const { error } =
				step.name === "confirm"
					? await auth.resend({ type: "signup", email: step.email, options })
					: step.name === "code"
						? await auth.signInWithOtp({ email: step.email, options: { ...options, shouldCreateUser: false } })
						: await auth.resetPasswordForEmail(step.email, { redirectTo: this.#redirectTo() });
			if (error) throw error;
			this.store.set({ resendAt: Date.now() + RESEND_WAIT_MS, message: t("We sent a new code.") });
		});
	}

	async setPassword(password: string, options: { currentCounts?: boolean } = {}): Promise<void> {
		if (password.length < PASSWORD_MIN) throw new Error(t("Use at least 8 characters for your password."));
		const userId = this.userId;
		if (!userId) throw new Error(t("Sign in to change your password."));
		const auth = this.#cloud.supabase.auth;
		let { data, error } = await auth.updateUser({ password, data: { password_set: true } });
		if (error && options.currentCounts && authCode(error) === "same_password")
			({ data, error } = await auth.updateUser({ data: { password_set: true } }));
		if (error) throw new Error(authErrorText(error).text);
		if (this.#disposed || this.userId !== userId || !data.user || data.user.id !== userId) return;
		const user = data.user;
		this.store.set((current) => ({ user, session: current.session ? { ...current.session, user } : null }));
	}

	#waitForCode(step: AuthStep, message?: string): void {
		this.store.set({ step, resendAt: Date.now() + RESEND_WAIT_MS, message, error: undefined, errorKind: undefined });
	}

	#fail(error: string): void {
		this.store.set({ error, errorKind: undefined, message: undefined });
	}

	async #run(operation: () => Promise<void>): Promise<void> {
		if (this.store.get().busy) return;
		this.store.set({ busy: true, error: undefined, errorKind: undefined, message: undefined });
		try {
			await operation();
		} catch (failure) {
			if (this.#disposed) return;
			const { text, kind } = authErrorText(failure);
			this.store.set({ error: text, errorKind: kind });
		} finally {
			if (!this.#disposed) this.store.set({ busy: false });
		}
	}

	async signInWithOAuth(provider: OAuthProvider): Promise<void> {
		if (!this.store.get().oauthProviders.includes(provider)) {
			this.store.set({
				error: t("This sign-in method is unavailable. Use your email instead."),
				errorKind: undefined,
			});
			return;
		}
		this.store.set({ busy: true, error: undefined });
		const { error } = await this.#cloud.supabase.auth.signInWithOAuth({
			provider,
			options: { redirectTo: this.#redirectTo() },
		});
		if (error) this.store.set({ busy: false, ...errorState(error) });
	}

	async signOut(): Promise<void> {
		await this.#cloud.supabase.auth.signOut();
		forgetMemberFiles();
		this.store.set({
			session: null,
			user: null,
			step: { name: "signin" },
			resendAt: undefined,
			message: undefined,
			error: undefined,
			errorKind: undefined,
		});
	}

	async updateName(value: string): Promise<void> {
		const name = value.trim();
		if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name))
			throw new Error(t("Enter a name between 1 and 64 characters."));
		const userId = this.userId;
		if (!userId) throw new Error(t("Sign in to change your name."));
		// Keep an explicitly chosen name separate from OAuth-managed profile fields.
		const { data, error } = await this.#cloud.supabase.auth.updateUser({ data: { display_name: name } });
		if (error) throw new Error(t("Your name could not be saved. Try again."));
		if (this.#disposed || this.userId !== userId) return;
		if (!data.user || data.user.id !== userId) throw new Error(t("Your name could not be saved. Try again."));
		this.store.set((current) => ({
			user: data.user,
			session: current.session ? { ...current.session, user: data.user! } : null,
		}));
	}
}

function normalEmail(email: string): string | undefined {
	const address = email.trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : undefined;
}

function authCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function errorState(error: unknown): Pick<AuthState, "error" | "errorKind"> {
	const { text, kind } = authErrorText(error);
	return { error: text, errorKind: kind };
}

export function authErrorText(error: unknown): { text: string; kind?: AuthErrorKind } {
	switch (authCode(error)) {
		case "invalid_credentials":
			return { text: t("That email and password don't match an account."), kind: "mismatch" };
		case "user_already_exists":
		case "email_exists":
			return { text: t("There's already an account with this email."), kind: "exists" };
		case "otp_expired":
			return { text: t("That code is wrong or too old. Check it, or send a new one.") };
		case "weak_password":
			return { text: t("Choose a stronger password: at least 8 characters, and not a common one.") };
		case "same_password":
			return { text: t("That's your current password. Choose a new one.") };
		case "otp_disabled":
		case "signup_disabled":
		case "user_not_found":
			return { text: t("We couldn't send a code to that email. Check it, or create an account.") };
		case "over_email_send_rate_limit":
		case "over_request_rate_limit":
			return { text: t("Too many tries. Wait a minute, then try again.") };
		case "reauthentication_needed":
		case "session_not_found":
			return { text: t("Sign in again, then change your password.") };
		case "email_address_invalid":
			return { text: t("Enter a valid email address.") };
		default:
			return { text: t("Something went wrong. Try again.") };
	}
}

export function displayName(user: User | null): string {
	if (!user) return "";
	return accountName(user) || t("Member");
}

/** The editable name excludes the email fallback used by authentication. */
export function accountName(user: User | null): string {
	if (!user) return "";
	const meta = user.user_metadata as Record<string, unknown> | undefined;
	const candidates = [meta?.display_name, meta?.full_name, meta?.name, meta?.user_name, meta?.preferred_username];
	const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
	return typeof value === "string" ? value.trim() : "";
}

export function needsPassword(user: User | null): boolean {
	if (!user) return false;
	const providers = user.app_metadata?.providers;
	const usesEmail = Array.isArray(providers) ? providers.includes("email") : user.app_metadata?.provider === "email";
	return usesEmail && user.user_metadata?.password_set !== true;
}
