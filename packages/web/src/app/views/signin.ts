import { h, replace } from "../../ui/dom.ts";
import type { AuthController, OAuthProvider } from "../auth.ts";
import { mountCrown } from "./crown.ts";

/* Sign-in in the current brand (Qorpera_Website `brand/final`, landing
 * styles.css, QorperaMobile SignInView): paper, ink, the approved lockup (the
 * wordmark is supplied lettering and is never set as text), a faint grid
 * floor, and the crown creature. Only the publishable key and the member's own
 * session ever live in this browser. */

function providerButton(auth: AuthController, provider: OAuthProvider, label: string, disabled: boolean): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: "auth-provider",
			disabled,
			"data-provider": provider,
			onclick: () => void auth.signInWithOAuth(provider),
		},
		h("img", { src: `./assets/provider-${provider}.svg`, alt: "", width: 18, height: 18 }),
		h("span", null, `Continue with ${label}`),
	);
}

export function renderSignIn(auth: AuthController, container: HTMLElement): void {
	const state = auth.store.get();
	const pending = Boolean(state.pendingEmail);
	const emailFocused = document.activeElement === container.querySelector("#signinEmail");
	const email = h("input", {
		id: "signinEmail",
		type: "email",
		name: "email",
		autocomplete: "email",
		placeholder: "you@company.com",
		required: true,
		value: state.pendingEmail ?? container.querySelector<HTMLInputElement>("#signinEmail")?.value ?? "",
		disabled: state.busy,
	});
	const code = h("input", {
		id: "signinCode",
		type: "text",
		name: "code",
		inputmode: "numeric",
		autocomplete: "one-time-code",
		placeholder: "6-digit code",
		maxlength: 8,
		required: true,
		disabled: state.busy,
	});
	const form = h(
		"form",
		{
			class: "auth-form",
			onsubmit: (event: Event) => {
				event.preventDefault();
				if (pending) void auth.verifyEmailCode(code.value);
				else void auth.sendEmailCode(email.value);
			},
		},
		h("label", { for: pending ? "signinCode" : "signinEmail" }, pending ? "Verification code" : "Email"),
		pending ? code : email,
		pending
			? h(
					"p",
					{ class: "auth-hint" },
					`We sent a code to ${state.pendingEmail}. Enter it here; the link in the same email works only in this browser.`,
				)
			: null,
		h(
			"button",
			{ type: "submit", class: "auth-primary", disabled: state.busy },
			pending ? "Verify and sign in" : "Continue with email",
		),
		pending
			? h(
					"button",
					{ type: "button", class: "auth-link", onclick: () => auth.resetEmail() },
					"Use a different email",
				)
			: null,
	);
	const status = h(
		"p",
		{ class: ["auth-status", state.error ? "is-error" : ""].join(" "), role: "status", "aria-live": "polite" },
		state.error ?? state.message ?? (state.busy ? "One moment…" : ""),
	);
	container.className = "auth";
	// The character persists across re-renders so its motion is never restarted
	// by a status change; it retires itself once the host leaves the document.
	let art = container.querySelector<HTMLElement>(".auth-art");
	if (!art) {
		art = h("aside", { class: "auth-art", "aria-hidden": "true" });
		const stage = h("div", { class: "crown-stage" });
		art.append(stage);
		mountCrown(stage);
	}
	replace(
		container,
		h(
			"section",
			{ class: "auth-panel", "aria-labelledby": "authTitle" },
			h(
				"header",
				{ class: "auth-brand" },
				h("img", { src: "./assets/brand/qorpera-lockup-light-800.png", alt: "Qorpera", width: 800, height: 200 }),
			),
			h(
				"div",
				{ class: "auth-body" },
				h("h1", { id: "authTitle" }, "Sign in"),
				h("p", { class: "auth-lead" }, "Your companies and agents, in one place."),
				!pending && state.oauthProviders.length > 0
					? h(
							"div",
							{ class: "auth-providers" },
							...state.oauthProviders.map((provider) =>
								providerButton(auth, provider, provider === "google" ? "Google" : "GitHub", state.busy),
							),
						)
					: null,
				!pending && state.oauthProviders.length > 0
					? h("div", { class: "auth-divider", "aria-hidden": "true" }, h("span", null, "or"))
					: null,
				form,
				status,
			),
			h(
				"footer",
				{ class: "auth-foot" },
				"Same account as the desktop app. Only your own session lives in this browser; agents run in the cloud.",
			),
		),
		art,
	);
	if (pending) code.focus();
	else if (emailFocused && !state.busy) email.focus();
}
