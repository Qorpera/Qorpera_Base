import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { type WebCompanySession, WebMemberAccount } from "./account.ts";
import { createWebAuth, loadMemberWebConfig, webOAuthDestination } from "./auth.ts";
import type { MemberWebConfig } from "./config.ts";
import { button, element, input, type Work } from "./dom.ts";
import { showFilePanel } from "./file-panel.ts";
import { showOfficePanel } from "./office-panel.ts";
import { showRecoveryPanel } from "./recovery-panel.ts";

/** The browser owns login, selection and presentation. The SDK and authenticated
 * cloud endpoints own company operations; this entry has no runtime lifecycle. */
export function mountMemberWeb(
	root: HTMLElement,
	options: {
		config: MemberWebConfig;
		client: SupabaseClient;
		clearAuth(): void;
		fetch?: typeof fetch;
		navigate?(url: string): void;
		reload?(): void;
	},
): { close(): void } {
	const { client, config } = options;
	const account = new WebMemberAccount({ config, client, fetch: options.fetch });
	const accountLabel = element("p", "Checking your account…"),
		navigation = element("nav"),
		panel = element("main"),
		message = element("p");
	message.setAttribute("role", "status");
	message.setAttribute("aria-live", "polite");
	const header = element("header", undefined, element("h1", "Qorpera"), accountLabel, navigation);
	root.replaceChildren(header, message, panel);
	let epoch = 0,
		eventRevision = 0,
		busy: symbol | undefined,
		dispose: (() => void) | undefined,
		leaveMessage: (() => string | null) | undefined;
	let closed = false,
		signingOut = false,
		initialized = false;
	const status = (text: string) => {
		message.textContent = text;
	};
	const current = (expected: number) => {
		if (closed || epoch !== expected) throw new Error("This page changed");
	};
	const clearPanel = () => {
		++epoch;
		dispose?.();
		dispose = undefined;
		leaveMessage = undefined;
		busy = undefined;
		panel.inert = false;
		panel.replaceChildren();
		status("");
	};
	const errorStatus = () =>
		status(
			"Could not confirm this action. Refresh its status or retry the same action. Your access may have changed.",
		);
	const workFor =
		(expected: number): Work =>
		async (action) => {
			if (closed || epoch !== expected || busy) return;
			const operation = Symbol();
			busy = operation;
			panel.inert = true;
			status("Working…");
			try {
				await action();
				current(expected);
				if (message.textContent === "Working…") status("");
			} catch {
				if (!closed && epoch === expected) errorStatus();
			} finally {
				if (busy === operation) {
					busy = undefined;
					panel.inert = false;
				}
			}
		};
	const mayLeave = () => {
		const warning = leaveMessage?.();
		return !warning || window.confirm(warning);
	};
	const install = async (expected: number, action: () => Promise<() => void>) => {
		const cleanup = await action();
		if (closed || epoch !== expected) cleanup();
		else dispose = cleanup;
	};
	const setNavigation = (company?: WebCompanySession) => {
		navigation.replaceChildren();
		const navButton = (label: string, action: () => void) => {
			const node = element("button", label);
			node.type = "button";
			node.onclick = () => {
				if (!closed && !signingOut && mayLeave()) action();
			};
			navigation.append(node);
		};
		navButton("Companies", home);
		if (company) {
			navButton("Files", () => openPanel(company, "files"));
			navButton("Company Computer", () => openPanel(company, "computer"));
		}
		navButton("Browser access cleanup", recovery);
		navButton("Sign out", () => {
			void signOut();
		});
	};
	function openPanel(company: WebCompanySession, kind: "files" | "computer") {
		clearPanel();
		const expected = epoch,
			work = workFor(expected);
		setNavigation(company);
		panel.append(element("h2", `${company.company.name} · ${company.company.environmentName}`));
		const content = element("div");
		panel.append(content);
		const common = {
			root: content,
			company,
			work,
			status: (text: string) => {
				current(expected);
				status(text);
			},
			current: () => current(expected),
		};
		void work(async () =>
			install(expected, () =>
				kind === "files"
					? showFilePanel({
							...common,
							beforeLeave: (check) => {
								current(expected);
								leaveMessage = check;
							},
						})
					: showOfficePanel(common),
			),
		);
	}
	function home() {
		clearPanel();
		account.leaveCompany();
		setNavigation();
		const expected = epoch,
			work = workFor(expected);
		panel.append(element("h2", "Your companies"));
		const list = element("div"),
			refresh = button(
				"Refresh companies",
				async () => {
					const companies = await account.companies();
					current(expected);
					list.replaceChildren();
					for (const company of companies) {
						const row = button(
							`${company.name} · ${company.environmentName}`,
							async () => openPanel(account.openCompany(company.environmentId), "files"),
							work,
						);
						list.append(row);
					}
					if (!companies.length) list.append(element("p", "No companies are available for this account."));
				},
				work,
			);
		panel.append(refresh, list);
		refresh.click();
	}
	function recovery() {
		clearPanel();
		account.leaveCompany();
		setNavigation();
		const expected = epoch,
			work = workFor(expected);
		void work(() =>
			install(expected, () =>
				showRecoveryPanel({ root: panel, account, work, current: () => current(expected), status }),
			),
		);
	}
	async function signOut() {
		signingOut = true;
		subscription.unsubscribe();
		account.close();
		clearPanel();
		navigation.replaceChildren();
		accountLabel.textContent = "Signing out…";
		try {
			await withCloudDeadline(
				async () => {
					await client.auth.signOut({ scope: "local" });
				},
				10000,
				new AbortController().signal,
			);
		} catch {
			/* Local credentials are cleared even when Auth is unreachable. */
		} finally {
			try {
				options.clearAuth();
			} finally {
				(options.reload ?? (() => window.location.replace(`${window.location.origin}/`)))();
			}
		}
	}
	function login() {
		clearPanel();
		navigation.replaceChildren();
		accountLabel.textContent = "Sign in to your Qorpera account";
		const expected = epoch,
			work = workFor(expected),
			redirectTo = `${window.location.origin}/`;
		for (const provider of ["google", "github"] as const)
			panel.append(
				button(
					`Continue with ${provider === "google" ? "Google" : "GitHub"}`,
					async () => {
						const { data, error } = await client.auth.signInWithOAuth({
							provider,
							options: { redirectTo, skipBrowserRedirect: true },
						});
						current(expected);
						if (error || !data.url) throw new Error("Sign-in unavailable");
						(options.navigate ?? ((url) => window.location.assign(url)))(webOAuthDestination(data.url, config));
					},
					work,
				),
			);
		const email = input("Email address");
		email.input.type = "email";
		email.input.autocomplete = "email";
		email.input.required = true;
		panel.append(
			email.label,
			button(
				"Email a sign-in link",
				async () => {
					if (!email.input.reportValidity()) return;
					const { error } = await client.auth.signInWithOtp({
						email: email.input.value.trim(),
						options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
					});
					current(expected);
					if (error) throw new Error("Sign-in unavailable");
					status("Check your email for a sign-in link. Open it in this browser.");
				},
				work,
			),
		);
	}
	function sessionChanged(session: Session | null) {
		if (closed || signingOut) return;
		++eventRevision;
		const changed = account.setSession(session);
		if (initialized && !changed) return;
		initialized = true;
		clearPanel();
		navigation.replaceChildren();
		accountLabel.textContent = session?.user.email ?? (session ? "Signed in" : "Signed out");
		const expected = epoch;
		// Auth callbacks run under the SDK's session lock. Leave that callback
		// before any catalog request can call getSession again.
		setTimeout(() => {
			if (closed || expected !== epoch) return;
			if (account.memberId) home();
			else login();
		}, 0);
	}
	const {
		data: { subscription },
	} = client.auth.onAuthStateChange((_event, session) => sessionChanged(session));
	const initialRevision = eventRevision;
	void withCloudDeadline(
		async () => {
			const { data, error } = await client.auth.getSession();
			if (!closed && !signingOut && eventRevision === initialRevision && !initialized) {
				if (error) throw error;
				sessionChanged(data.session);
			}
		},
		10000,
		new AbortController().signal,
	).catch(() => {
		if (!initialized && !closed && !signingOut) {
			login();
			status("Account restoration failed. Sign in again.");
		}
	});
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (leaveMessage?.()) {
			event.preventDefault();
			event.returnValue = "";
		}
	};
	window.addEventListener("beforeunload", beforeUnload);
	return {
		close() {
			closed = true;
			subscription.unsubscribe();
			account.close();
			clearPanel();
			window.removeEventListener("beforeunload", beforeUnload);
		},
	};
}

export async function startMemberWeb(root: HTMLElement | null): Promise<void> {
	if (!root) return;
	try {
		const config = await loadMemberWebConfig(window.location.href),
			auth = createWebAuth(config, window.localStorage);
		mountMemberWeb(root, { config, client: auth.client, clearAuth: auth.clear });
	} catch {
		root.replaceChildren(
			element("h1", "Qorpera"),
			element(
				"p",
				"This web client is not configured or browser storage is unavailable. Contact your administrator.",
			),
		);
	}
}
