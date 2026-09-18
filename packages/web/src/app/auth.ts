import type { Session, User } from "@supabase/supabase-js";
import type { Cloud } from "../cloud/client.ts";
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
	#providerRequest?: AbortController;

	constructor(cloud: Cloud) {
		this.#cloud = cloud;
	}

	async start(): Promise<void> {
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
					? "Sign-in could not be completed. Request a new email code in this browser."
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
		this.#providerRequest?.abort();
		this.store.dispose();
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
			this.store.set({ error: "Enter a valid email address." });
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
			message: "Check your email. Enter the code below, or open the sign-in link on this device.",
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
			this.store.set({ error: "This sign-in provider is unavailable. Continue with email." });
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

	resetEmail(): void {
		this.store.set({ pendingEmail: undefined, message: undefined, error: undefined });
	}
}

export function displayName(user: User | null): string {
	if (!user) return "";
	const meta = user.user_metadata as Record<string, unknown> | undefined;
	const candidates = [meta?.full_name, meta?.name, meta?.user_name, meta?.preferred_username, user.email];
	const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
	return typeof value === "string" ? value : "Member";
}
