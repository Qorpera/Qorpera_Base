import type { Session, User } from "@supabase/supabase-js";
import type { Cloud, SessionRejection } from "../cloud/client.ts";
import { t } from "../ui/preferences.ts";
import { Store } from "./state.ts";

/* Supabase Auth in the browser (CLIENT-CONTRACT.md §1): email one-time code or
 * link, GitHub/Google OAuth with PKCE. The publishable key plus the member's
 * token is the whole credential set; nothing else is stored. */

export interface AuthState {
	ready: boolean;
	session: Session | null;
	user: User | null;
	pendingEmail?: string;
	message?: string;
	error?: string;
	busy: boolean;
	oauthProviders: OAuthProvider[];
}

export type OAuthProvider = "github" | "google";

export class AuthController {
	readonly store = new Store<AuthState>({ ready: false, session: null, user: null, busy: false, oauthProviders: [] });
	readonly #cloud: Cloud;
	#disposed = false;
	#unsubscribe?: () => void;
	#stopRejections?: () => void;
	#providerRequest?: AbortController;
	/** A refused session is being signed out; further refusals wait for that one sign-out. */
	#signingOut = false;

	constructor(cloud: Cloud) {
		this.#cloud = cloud;
	}

	async start(): Promise<void> {
		// Listen before the first cloud read, so a session refused on the first request is seen.
		this.#stopRejections = this.#cloud.onSessionRejected?.((rejection) => this.#sessionRejected(rejection));
		const original = new URL(location.href);
		const callbackFields = [
			"code",
			"access_token",
			"refresh_token",
			"provider_token",
			"provider_refresh_token",
			"error",
			"error_code",
			"error_description",
		];
		const originalFragment = new URLSearchParams(original.hash.slice(1));
		const queryCallback = callbackFields.some((key) => original.searchParams.has(key));
		const fragmentCallback =
			!original.hash.startsWith("#/") && callbackFields.some((key) => originalFragment.has(key));
		const { error: initializationError } = await this.#cloud.supabase.auth.initialize().finally(() => {
			// Let Auth consume the callback first, then remove credentials even
			// when it rejects an expired or mismatched flow. Preserve app routes.
			const url = new URL(location.href);
			const fields = [...callbackFields, "sb_flow_id", "expires_in", "expires_at", "token_type", "type"];
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
					? t("Sign-in could not be completed. Request a new email code in this browser.")
					: undefined,
		});
		if (!data.session) void this.#loadProviders();
		const {
			data: { subscription },
		} = this.#cloud.supabase.auth.onAuthStateChange((_event, session) => {
			this.store.set({ session, user: session?.user ?? null, ready: true });
			if (!session) void this.#loadProviders();
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
			// Local only: the cloud already refuses this session, so there is nothing to revoke there.
			await this.#cloud.supabase.auth.signOut({ scope: "local" });
		} catch {
			// The session is cleared from this page below either way.
		} finally {
			this.#signingOut = false;
		}
		if (this.#disposed) return;
		const current = this.store.get().session;
		// The member signed in again meanwhile: that session is a new one and stays.
		if (current && current.access_token !== session.access_token) return;
		this.store.set({
			session: null,
			user: null,
			pendingEmail: undefined,
			error: undefined,
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

	async sendEmailCode(email: string): Promise<void> {
		const normalized = email.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
			this.store.set({ error: t("Enter a valid email address.") });
			return;
		}
		this.store.set({ busy: true, error: undefined, message: undefined });
		const { error } = await this.#cloud.supabase.auth.signInWithOtp({
			email: normalized,
			options: { emailRedirectTo: this.#redirectTo(), shouldCreateUser: true },
		});
		if (error) {
			this.store.set({ busy: false, error: error.message });
			return;
		}
		this.store.set({
			busy: false,
			pendingEmail: normalized,
			message: t("Check your email. Enter the code below, or open the sign-in link on this device."),
		});
	}

	async verifyEmailCode(token: string): Promise<void> {
		const email = this.store.get().pendingEmail;
		if (!email) return;
		this.store.set({ busy: true, error: undefined });
		const { error } = await this.#cloud.supabase.auth.verifyOtp({ email, token: token.trim(), type: "email" });
		if (error) {
			this.store.set({ busy: false, error: error.message });
			return;
		}
		this.store.set({ busy: false, pendingEmail: undefined, message: undefined });
	}

	async signInWithOAuth(provider: OAuthProvider): Promise<void> {
		if (!this.store.get().oauthProviders.includes(provider)) {
			this.store.set({ error: t("This sign-in provider is unavailable. Continue with email.") });
			return;
		}
		this.store.set({ busy: true, error: undefined });
		const { error } = await this.#cloud.supabase.auth.signInWithOAuth({
			provider,
			options: { redirectTo: this.#redirectTo() },
		});
		if (error) this.store.set({ busy: false, error: error.message });
	}

	async signOut(): Promise<void> {
		await this.#cloud.supabase.auth.signOut();
		this.store.set({ session: null, user: null, pendingEmail: undefined, message: undefined, error: undefined });
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

	resetEmail(): void {
		this.store.set({ pendingEmail: undefined, message: undefined, error: undefined });
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
