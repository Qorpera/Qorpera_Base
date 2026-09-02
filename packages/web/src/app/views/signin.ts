import { h, replace } from "../../ui/dom.ts";
import type { AuthController, OAuthProvider } from "../auth.ts";

/* Sign-in on the public brand field the desktop uses for its own account and
 * onboarding screens (packages/shell/userland/onboarding.css): the same
 * gradient, card, provider cards, divider and email form, so the web app reads
 * as the same product. Only the publishable key and the member's own session
 * ever live in this browser. */

function providerOption(auth: AuthController, provider: OAuthProvider, label: string, disabled: boolean): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: "provider-option",
			disabled,
			"data-provider": provider,
			onclick: () => void auth.signInWithOAuth(provider),
		},
		h(
			"span",
			{ class: "provider-mark", "aria-hidden": "true" },
			h("img", { src: `./assets/provider-${provider}.svg`, alt: "" }),
		),
		h("span", { class: "provider-option-copy" }, h("strong", null, label)),
	);
}

export function renderSignIn(auth: AuthController, container: HTMLElement): void {
	const state = auth.store.get();
	const pending = Boolean(state.pendingEmail);
	const email = h("input", {
		id: "signinEmail",
		type: "email",
		name: "email",
		autocomplete: "email",
		placeholder: "you@company.com",
		required: true,
		value: state.pendingEmail ?? "",
		disabled: state.busy || pending,
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
			class: "account-email-form",
			onsubmit: (event: Event) => {
				event.preventDefault();
				if (pending) void auth.verifyEmailCode(code.value);
				else void auth.sendEmailCode(email.value);
			},
		},
		h(
			"label",
			{ for: pending ? "signinCode" : "signinEmail" },
			pending ? `Code sent to ${state.pendingEmail}` : "Email address",
		),
		h(
			"div",
			null,
			pending ? code : email,
			h("button", { type: "submit", disabled: state.busy }, pending ? "Verify" : "Continue"),
		),
		pending
			? h(
					"button",
					{ type: "button", class: "account-link", onclick: () => auth.resetEmail() },
					"Use a different email",
				)
			: null,
	);
	const status = h(
		"div",
		{ class: ["welcome-status", state.error ? "is-error" : ""].join(" "), role: "status", "aria-live": "polite" },
		state.error ?? state.message ?? (state.busy ? "One moment…" : ""),
	);
	container.className = "brand-field";
	replace(
		container,
		h(
			"section",
			{ class: "welcome-card account-card", "aria-labelledby": "accountTitle" },
			h("img", { class: "welcome-brand", src: "./assets/qorpera.png", alt: "", width: 64, height: 64 }),
			h("h1", { id: "accountTitle" }, "Qorpera"),
			h("p", null, "Sign in to keep your companies and agents connected to you."),
			h(
				"div",
				{ class: "provider-grid", "aria-label": "Sign-in providers" },
				providerOption(auth, "google", "Google", state.busy),
				providerOption(auth, "github", "GitHub", state.busy),
			),
			h("div", { class: "account-divider", "aria-hidden": "true" }, h("span", null, "or")),
			form,
			status,
		),
		h(
			"p",
			{ class: "brand-field-note" },
			"Same account as the desktop app. This browser keeps only the publishable key and your own session; agents run in the cloud.",
		),
	);
	// Focus only the code field: it appears after a member action. The email
	// field on first paint would show a focus ring nobody asked for.
	if (pending) code.focus();
}
