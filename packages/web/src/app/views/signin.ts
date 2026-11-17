import { h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type AuthController, type AuthState, CODE_LENGTH, type OAuthProvider, PASSWORD_MIN } from "../auth.ts";
import { mountCrown } from "./crown.ts";

type Step = AuthState["step"];

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
		h("span", null, t("Continue with {provider}", { provider: label })),
	);
}

function kept(container: HTMLElement, id: string): string {
	return container.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
}

function field(
	container: HTMLElement,
	id: string,
	label: string,
	attributes: Record<string, string | number | boolean>,
	busy: boolean,
	value?: string,
): HTMLElement[] {
	return [
		h("label", { for: id }, label),
		h("input", { id, name: id, value: value ?? kept(container, id), disabled: busy, ...attributes }),
	];
}

function passwordField(
	container: HTMLElement,
	id: string,
	label: string,
	autocomplete: string,
	busy: boolean,
	aside?: HTMLElement,
): HTMLElement[] {
	const input = h("input", {
		id,
		name: id,
		type: "password",
		autocomplete,
		required: true,
		minlength: PASSWORD_MIN,
		value: kept(container, id),
		disabled: busy,
	});
	const shown = container.querySelector<HTMLInputElement>(`#${id}`)?.type === "text";
	if (shown) input.type = "text";
	const toggle = h(
		"button",
		{
			type: "button",
			class: "auth-show",
			"aria-controls": id,
			"aria-pressed": String(shown),
			onclick: () => {
				const show = input.type === "password";
				input.type = show ? "text" : "password";
				toggle.textContent = show ? t("Hide") : t("Show");
				toggle.setAttribute("aria-pressed", String(show));
			},
		},
		shown ? t("Hide") : t("Show"),
	);
	return [
		h("div", { class: "auth-label-row" }, h("label", { for: id }, label), aside ?? null),
		h("div", { class: "auth-password" }, input, toggle),
	];
}

function codeField(container: HTMLElement, busy: boolean, onComplete?: (code: string) => void): HTMLElement {
	const input = h("input", {
		id: "signinCode",
		name: "code",
		class: "auth-code-input",
		type: "text",
		inputmode: "numeric",
		autocomplete: "one-time-code",
		maxlength: CODE_LENGTH,
		pattern: "[0-9]*",
		"aria-label": t("{count}-digit code", { count: CODE_LENGTH }),
		value: kept(container, "signinCode"),
		disabled: busy,
	});
	const boxes = Array.from({ length: CODE_LENGTH }, () => h("span", { class: "auth-code-box" }));
	const draw = () => {
		const digits = input.value;
		const focused = document.activeElement === input;
		boxes.forEach((box, index) => {
			box.textContent = digits[index] ?? "";
			box.classList.toggle("is-next", focused && index === Math.min(digits.length, CODE_LENGTH - 1));
		});
	};
	input.oninput = () => {
		const digits = input.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
		if (digits !== input.value) input.value = digits;
		draw();
		if (digits.length === CODE_LENGTH) onComplete?.(digits);
	};
	input.onfocus = draw;
	input.onblur = draw;
	draw();
	return h(
		"div",
		{ class: "auth-code" },
		h("div", { class: "auth-code-boxes", "aria-hidden": "true" }, ...boxes),
		input,
	);
}

function countdown(auth: AuthController, resendAt: number | undefined, busy: boolean): HTMLElement {
	const holder = h("span", { class: "auth-resend" });
	const tick = () => {
		if (holder.isConnected === false && holder.dataset.started) return;
		holder.dataset.started = "1";
		const seconds = Math.ceil(((resendAt ?? 0) - Date.now()) / 1000);
		if (seconds <= 0) {
			replace(
				holder,
				h(
					"button",
					{ type: "button", class: "auth-inline", disabled: busy, onclick: () => void auth.resendCode() },
					t("send a new code"),
				),
			);
			return;
		}
		holder.textContent = t("send a new code in {time}", {
			time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
		});
		setTimeout(tick, 1000);
	};
	tick();
	return holder;
}

function alert(auth: AuthController, state: AuthState, email: () => string): HTMLElement | null {
	if (!state.error) return null;
	const ways =
		state.errorKind === "mismatch"
			? h(
					"span",
					null,
					t("Check for a typo, "),
					h(
						"button",
						{ type: "button", class: "auth-inline", onclick: () => void auth.forgotPassword(email()) },
						t("reset your password"),
					),
					t(", or "),
					h(
						"button",
						{ type: "button", class: "auth-inline", onclick: () => auth.showStep("create") },
						t("create an account"),
					),
					".",
				)
			: state.errorKind === "exists"
				? h(
						"span",
						null,
						h(
							"button",
							{ type: "button", class: "auth-inline", onclick: () => auth.showStep("signin") },
							t("Sign in instead"),
						),
						t(", or "),
						h(
							"button",
							{ type: "button", class: "auth-inline", onclick: () => void auth.forgotPassword(email()) },
							t("reset your password"),
						),
						".",
					)
				: null;
	return h("div", { class: "auth-alert", role: "alert" }, h("strong", null, state.error), ways);
}

function providers(auth: AuthController, state: AuthState): HTMLElement[] {
	if (state.oauthProviders.length === 0) return [];
	return [
		h(
			"div",
			{ class: "auth-providers" },
			...state.oauthProviders.map((provider) =>
				providerButton(auth, provider, provider === "google" ? "Google" : "GitHub", state.busy),
			),
		),
		h("div", { class: "auth-divider", "aria-hidden": "true" }, h("span", null, t("or"))),
	];
}

function switchLine(question: string, action: string, onclick: () => void): HTMLElement {
	return h(
		"p",
		{ class: "auth-switch" },
		question,
		" ",
		h("button", { type: "button", class: "auth-inline", onclick }, action),
	);
}

function signInBody(auth: AuthController, state: AuthState, container: HTMLElement): HTMLElement[] {
	const [emailLabel, email] = field(
		container,
		"signinEmail",
		t("Email"),
		{ type: "email", autocomplete: "email", placeholder: t("you@company.com"), required: true },
		state.busy,
	) as [HTMLElement, HTMLInputElement];
	const forgot = h(
		"button",
		{ type: "button", class: "auth-inline auth-forgot", onclick: () => void auth.forgotPassword(email.value) },
		t("Forgot password?"),
	);
	const password = passwordField(container, "signinPassword", t("Password"), "current-password", state.busy, forgot);
	return [
		h("h1", { id: "authTitle" }, t("Welcome back")),
		h("p", { class: "auth-lead" }, t("Sign in to your companies.")),
		...providers(auth, state),
		h(
			"form",
			{
				class: "auth-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					const input = container.querySelector<HTMLInputElement>("#signinPassword");
					void auth.signInWithPassword(email.value, input?.value ?? "");
				},
			},
			alert(auth, state, () => email.value),
			emailLabel,
			email,
			...password,
			h("button", { type: "submit", class: "auth-primary", disabled: state.busy }, t("Sign in")),
			h(
				"button",
				{
					type: "button",
					class: "auth-link",
					disabled: state.busy,
					onclick: () => void auth.sendEmailCode(email.value),
				},
				t("Email me a code instead"),
			),
		),
		switchLine(t("New to Qorpera?"), t("Create an account"), () => auth.showStep("create")),
	];
}

function createBody(auth: AuthController, state: AuthState, container: HTMLElement): HTMLElement[] {
	const [nameLabel, name] = field(
		container,
		"signinName",
		t("Your name"),
		{ type: "text", autocomplete: "name", placeholder: t("First and last name"), required: true, maxlength: 64 },
		state.busy,
	) as [HTMLElement, HTMLInputElement];
	const [emailLabel, email] = field(
		container,
		"signinEmail",
		t("Email"),
		{ type: "email", autocomplete: "email", placeholder: t("you@company.com"), required: true },
		state.busy,
	) as [HTMLElement, HTMLInputElement];
	const password = passwordField(container, "signinPassword", t("Password"), "new-password", state.busy);
	return [
		h("h1", { id: "authTitle" }, t("Create your account")),
		h("p", { class: "auth-lead" }, t("Start a company and meet your Co-Founder.")),
		...providers(auth, state),
		h(
			"form",
			{
				class: "auth-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					const input = container.querySelector<HTMLInputElement>("#signinPassword");
					void auth.createAccount(name.value, email.value, input?.value ?? "");
				},
			},
			alert(auth, state, () => email.value),
			nameLabel,
			name,
			emailLabel,
			email,
			...password,
			h("p", { class: "auth-hint" }, t("At least 8 characters.")),
			h("button", { type: "submit", class: "auth-primary", disabled: state.busy }, t("Create account")),
		),
		switchLine(t("Already have an account?"), t("Sign in"), () => auth.showStep("signin")),
	];
}

function codeBody(
	auth: AuthController,
	state: AuthState,
	container: HTMLElement,
	step: Extract<Step, { name: "confirm" | "code" }>,
): HTMLElement[] {
	const code = codeField(container, state.busy, (digits) => void auth.verifyEmailCode(digits));
	const lead =
		step.name === "confirm"
			? t("We sent a 6-digit code to {email}. Type it here to finish your account.", { email: step.email })
			: t("We sent a 6-digit code to {email}. Type it here to sign in.", { email: step.email });
	return [
		h("h1", { id: "authTitle" }, t("Check your email")),
		h("p", { class: "auth-lead" }, lead),
		h(
			"form",
			{
				class: "auth-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void auth.verifyEmailCode(container.querySelector<HTMLInputElement>("#signinCode")?.value ?? "");
				},
			},
			alert(auth, state, () => step.email),
			code,
			h("button", { type: "submit", class: "auth-primary", disabled: state.busy }, t("Continue")),
		),
		h(
			"p",
			{ class: "auth-muted" },
			t("Didn't get it? Look in spam, or "),
			countdown(auth, state.resendAt, state.busy),
			".",
		),
		h(
			"p",
			{ class: "auth-muted" },
			h("button", { type: "button", class: "auth-inline", onclick: () => auth.back() }, t("Wrong email? Go back")),
		),
	];
}

function resetBody(
	auth: AuthController,
	state: AuthState,
	container: HTMLElement,
	step: Extract<Step, { name: "reset" }>,
): HTMLElement[] {
	const code = step.verified ? null : codeField(container, state.busy);
	const password = passwordField(container, "signinNewPassword", t("New password"), "new-password", state.busy);
	const parts: (HTMLElement | null)[] = [
		h("h1", { id: "authTitle" }, t("Choose a new password")),
		h(
			"p",
			{ class: "auth-lead" },
			step.verified
				? t("Pick a new password for {email}.", { email: step.email })
				: t("We sent a 6-digit code to {email}. Type it, then pick a new password.", { email: step.email }),
		),
		h(
			"form",
			{
				class: "auth-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void auth.resetPassword(
						container.querySelector<HTMLInputElement>("#signinCode")?.value ?? "",
						container.querySelector<HTMLInputElement>("#signinNewPassword")?.value ?? "",
					);
				},
			},
			alert(auth, state, () => step.email),
			code,
			...password,
			h("p", { class: "auth-hint" }, t("At least 8 characters.")),
			h("button", { type: "submit", class: "auth-primary", disabled: state.busy }, t("Save and sign in")),
		),
		step.verified
			? null
			: h(
					"p",
					{ class: "auth-muted" },
					t("Didn't get it? Look in spam, or "),
					countdown(auth, state.resendAt, state.busy),
					".",
				),
		h(
			"p",
			{ class: "auth-muted" },
			h("button", { type: "button", class: "auth-inline", onclick: () => auth.back() }, t("Back to sign in")),
		),
	];
	return parts.filter((part): part is HTMLElement => part !== null);
}

function brand(): HTMLElement {
	return h(
		"header",
		{ class: "auth-brand" },
		h("img", {
			class: "lockup-on-light",
			loading: "lazy",
			src: "./assets/brand/qorpera-lockup-light-800.png",
			alt: "Qorpera",
			width: 800,
			height: 200,
		}),
		h("img", {
			class: "lockup-on-dark",
			loading: "lazy",
			src: "./assets/brand/qorpera-lockup-dark-800.png",
			alt: "Qorpera",
			width: 800,
			height: 200,
		}),
	);
}

function crown(container: HTMLElement): HTMLElement {
	const existing = container.querySelector<HTMLElement>(".auth-crown");
	if (existing) return existing;
	const holder = h("div", { class: "auth-crown", "aria-hidden": "true" });
	const stage = h("div", { class: "crown-stage" });
	holder.append(stage);
	mountCrown(stage, { gaze: "form" });
	return holder;
}

function bodyFor(auth: AuthController, state: AuthState, container: HTMLElement): HTMLElement[] {
	const step = state.step;
	if (step.name === "create") return createBody(auth, state, container);
	if (step.name === "confirm" || step.name === "code") return codeBody(auth, state, container, step);
	if (step.name === "reset") return resetBody(auth, state, container, step);
	return signInBody(auth, state, container);
}

export function renderSignIn(auth: AuthController, container: HTMLElement): void {
	const state = auth.store.get();
	const focusedId = container.contains(document.activeElement) ? document.activeElement?.id : undefined;
	const drawnStep = container.dataset.step;
	const status = h(
		"p",
		{ class: "auth-status", role: "status", "aria-live": "polite" },
		state.message ?? (state.busy ? t("One moment…") : ""),
	);
	container.className = "auth";
	container.dataset.step = state.step.name;
	const art = crown(container);
	replace(
		container,
		brand(),
		h(
			"section",
			{ class: "auth-body", "aria-labelledby": "authTitle" },
			art,
			...bodyFor(auth, state, container),
			status,
		),
	);
	const refocus = focusedId ? container.querySelector<HTMLElement>(`#${focusedId}`) : null;
	if (refocus && !state.busy) refocus.focus();
	else if (drawnStep !== state.step.name) {
		const first = container.querySelector<HTMLInputElement>(
			state.step.name === "signin" || state.step.name === "create" ? "input:not([type=hidden])" : "#signinCode",
		);
		if (drawnStep !== undefined) first?.focus();
	}
}

export function renderNameAsk(auth: AuthController, container: HTMLElement, onDone: () => void): void {
	const error = h("p", { class: "auth-status is-error", role: "alert" });
	const input = h("input", {
		id: "accountNameAsk",
		type: "text",
		autocomplete: "name",
		placeholder: t("First and last name"),
		maxlength: 64,
		required: true,
		value: kept(container, "accountNameAsk"),
	});
	const submit = h("button", { type: "submit", class: "auth-primary" }, t("Continue"));
	container.className = "auth";
	container.dataset.step = "name";
	replace(
		container,
		brand(),
		h(
			"section",
			{ class: "auth-body", "aria-labelledby": "authTitle" },
			crown(container),
			h("h1", { id: "authTitle" }, t("What should we call you?")),
			h(
				"p",
				{ class: "auth-lead" },
				t("Your agents and teammates see this name. You can change it later in Settings."),
			),
			h(
				"form",
				{
					class: "auth-form",
					onsubmit: async (event: Event) => {
						event.preventDefault();
						submit.disabled = true;
						error.textContent = "";
						try {
							await auth.updateName(input.value);
							onDone();
						} catch (failure) {
							error.textContent =
								failure instanceof Error ? failure.message : t("Your name could not be saved. Try again.");
							submit.disabled = false;
						}
					},
				},
				h("label", { for: "accountNameAsk" }, t("Your name")),
				input,
				submit,
				error,
			),
		),
	);
	input.focus();
}
