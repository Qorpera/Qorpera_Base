import { h, notice } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type AuthController, accountName } from "../auth.ts";

interface NameEditor {
	userId: string | undefined;
	input: HTMLInputElement;
	error: HTMLElement;
	refresh: () => void;
	preserveDraft: (render: () => void) => void;
}

const editors = new WeakMap<HTMLElement, NameEditor>();
let editorCount = 0;

/** Keep the draft and save feedback when the rest of General is redrawn. */
export function accountNameEditor(auth: AuthController, container: HTMLElement): NameEditor {
	const existing = editors.get(container);
	if (existing && existing.userId === auth.userId) {
		existing.refresh();
		return existing;
	}
	const userId = auth.userId;
	let saved = accountName(auth.store.get().user);
	let saving = false;
	let moving = false;
	const errorId = `account-name-error-${++editorCount}`;
	const error = h("div", { id: errorId, class: "account-name-error", hidden: true });
	const input = h("input", {
		type: "text",
		class: "account-name-input",
		value: saved,
		maxlength: "64",
		autocomplete: "nickname",
		spellcheck: "false",
		"aria-describedby": errorId,
	});
	const clearError = () => {
		error.hidden = true;
		error.replaceChildren();
		input.removeAttribute("aria-invalid");
	};
	const save = async () => {
		if (saving || auth.userId !== userId) return;
		const name = input.value.trim();
		if (name === saved) {
			input.value = saved;
			return;
		}
		clearError();
		saving = true;
		input.readOnly = true;
		input.setAttribute("aria-busy", "true");
		try {
			await auth.updateName(name);
			if (auth.userId !== userId) return;
			saved = accountName(auth.store.get().user);
			input.value = saved;
		} catch (failure) {
			if (auth.userId !== userId) return;
			error.replaceChildren(
				notice(
					"danger",
					failure instanceof Error ? failure.message : t("Your name could not be saved. Try again."),
				),
			);
			error.hidden = false;
			input.setAttribute("aria-invalid", "true");
		} finally {
			saving = false;
			input.readOnly = false;
			input.removeAttribute("aria-busy");
		}
	};
	input.onblur = () => {
		if (!moving) void save();
	};
	input.oninput = clearError;
	input.onkeydown = (event) => {
		if (event.isComposing) return;
		if (event.key === "Enter") {
			event.preventDefault();
			void save();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			if (saving) return;
			input.value = saved;
			clearError();
			input.blur();
		}
	};
	const editor: NameEditor = {
		userId,
		input,
		error,
		preserveDraft: (render) => {
			// Reparenting a focused input fires blur in browsers. It is a redraw,
			// not a decision to finish editing, so leave the draft unsaved.
			moving = true;
			try {
				render();
			} finally {
				moving = false;
			}
		},
		refresh: () => {
			input.placeholder = t("write your name");
			input.setAttribute("aria-label", t("Username"));
			if (!saving && document.activeElement !== input && input.value === saved) {
				saved = accountName(auth.store.get().user);
				input.value = saved;
			}
		},
	};
	editor.refresh();
	editors.set(container, editor);
	return editor;
}
