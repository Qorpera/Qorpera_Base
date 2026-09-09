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
}

export type OAuthProvider = "github" | "google";

export class AuthController {
	readonly store = new Store<AuthState>({ ready: false, session: null, user: null, busy: false });
	readonly #cloud: Cloud;
	#disposed = false;
	#unsubscribe?: () => void;

	constructor(cloud: Cloud) {
		this.#cloud = cloud;
	}

	async start(): Promise<void> {
		const { data } = await this.#cloud.supabase.auth.getSession();
		if (this.#disposed) return;
		this.store.set({ ready: true, session: data.session, user: data.session?.user ?? null });
		const {
			data: { subscription },
		} = this.#cloud.supabase.auth.onAuthStateChange((_event, session) => {
			this.store.set({ session, user: session?.user ?? null, ready: true });
		});
		this.#unsubscribe = () => subscription.unsubscribe();
		// Strip the PKCE code from the address bar once the library has consumed it.
		if (new URL(location.href).searchParams.has("code")) {
			const url = new URL(location.href);
			url.searchParams.delete("code");
			history.replaceState(null, "", `${url.pathname}${url.search}${url.hash || "#/"}`);
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe?.();
		this.store.dispose();
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
