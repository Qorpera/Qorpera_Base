import { button, h, notice, replace } from "../../ui/dom.ts";
import type { AuthController } from "../auth.ts";

export function renderSignIn(auth: AuthController, container: HTMLElement): void {
	const state = auth.store.get();
	const email = h("input", {
		type: "email",
		name: "email",
		autocomplete: "email",
		placeholder: "you@company.com",
		required: true,
		value: state.pendingEmail ?? "",
		disabled: state.busy || Boolean(state.pendingEmail),
	});
	const code = h("input", {
		type: "text",
		name: "code",
		inputmode: "numeric",
		autocomplete: "one-time-code",
		placeholder: "6-digit code from the email",
		disabled: state.busy,
	});
	const form = h(
		"form",
		{
			class: "signin-form",
			onsubmit: (event: Event) => {
				event.preventDefault();
				if (state.pendingEmail) void auth.verifyEmailCode(code.value);
				else void auth.sendEmailCode(email.value);
			},
		},
		h("label", null, "Email", email),
		state.pendingEmail ? h("label", null, "Code", code) : null,
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{ type: "submit", class: "btn btn-primary", disabled: state.busy },
				state.pendingEmail ? "Verify code" : "Send sign-in email",
			),
			state.pendingEmail ? button("Use a different email", () => auth.resetEmail()) : null,
		),
	);
	replace(
		container,
		h(
			"section",
			{ class: "signin" },
			h("img", { class: "brand-mark", src: "./assets/qorpera.png", alt: "" }),
			h("h1", null, "Sign in to Qorpera"),
			h(
				"p",
				{ class: "muted" },
				"Your companies live in the cloud. Sign in with the same account you use on the desktop.",
			),
			state.error ? notice("danger", state.error) : null,
			state.message ? notice("ok", state.message) : null,
			form,
			h(
				"div",
				{ class: "oauth-row" },
				button("Continue with GitHub", () => void auth.signInWithOAuth("github"), { disabled: state.busy }),
				button("Continue with Google", () => void auth.signInWithOAuth("google"), { disabled: state.busy }),
			),
			h(
				"p",
				{ class: "fineprint" },
				"This browser holds only the publishable key and your own session token. It never runs agents, never sees provider output, and never stores secrets.",
			),
		),
	);
	if (state.pendingEmail) code.focus();
	else email.focus();
}
