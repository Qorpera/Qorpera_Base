import { button, h, notice } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type AuthController, PASSWORD_MIN } from "../auth.ts";

interface PasswordEditor {
	userId: string | undefined;
	row: HTMLElement;
	feedback: HTMLElement;
}

const editors = new WeakMap<HTMLElement, PasswordEditor>();
let editorCount = 0;

export function accountPasswordEditor(auth: AuthController, container: HTMLElement): PasswordEditor {
	const existing = editors.get(container);
	if (existing && existing.userId === auth.userId) return existing;
	const userId = auth.userId;
	const id = `account-password-${++editorCount}`;
	const feedback = h("div", { class: "account-password-feedback", hidden: true });
	const input = h("input", {
		id,
		type: "password",
		class: "account-password-input",
		autocomplete: "new-password",
		minlength: PASSWORD_MIN,
		placeholder: t("New password"),
	});
	const show = (tone: "ok" | "danger", text: string) => {
		feedback.replaceChildren(notice(tone, text));
		feedback.hidden = false;
	};
	const save = button(
		t("Save password"),
		async () => {
			if (save.disabled || auth.userId !== userId) return;
			save.disabled = true;
			feedback.hidden = true;
			try {
				await auth.setPassword(input.value);
				if (auth.userId !== userId) return;
				input.value = "";
				show("ok", t("Password saved. Sign in with it next time."));
			} catch (failure) {
				if (auth.userId !== userId) return;
				show("danger", failure instanceof Error ? failure.message : t("Something went wrong. Try again."));
			} finally {
				save.disabled = false;
			}
		},
		{ small: true },
	);
	input.oninput = () => {
		feedback.hidden = true;
	};
	const row = h(
		"div",
		{ class: "settings-preference-row account-password" },
		h(
			"label",
			{ class: "settings-copy", for: id },
			h("span", null, t("Password")),
			h("small", null, t("Sign in with your email and a password, or with a code by email.")),
		),
		h("div", { class: "account-password-set" }, input, save),
	);
	const editor = { userId, row, feedback };
	editors.set(container, editor);
	return editor;
}
