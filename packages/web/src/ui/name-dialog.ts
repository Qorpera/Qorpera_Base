import { button, h } from "./dom.ts";
import { leave } from "./motion.ts";
import { t } from "./preferences.ts";

export interface NameDialogOptions {
	title: string;
	/** The field's accessible name. */
	label: string;
	value?: string;
	confirm: string;
	maxLength: number;
	signal?: AbortSignal;
}

/** Asks for one short name (a new section, a rename). Resolves to the trimmed
 * name, or undefined when cancelled or left unchanged. Enter saves, Escape
 * cancels, and focus goes back to where it was. */
export function nameDialog(options: NameDialogOptions): Promise<string | undefined> {
	if (options.signal?.aborted) return Promise.resolve(undefined);
	const initial = options.value?.trim() ?? "";
	return new Promise((resolve) => {
		const previousFocus = document.activeElement;
		let closed = false;
		const input = h("input", {
			type: "text",
			class: "name-dialog-input",
			value: initial,
			maxlength: String(options.maxLength),
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": options.label,
		});
		const value = () => input.value.trim().replace(/\s+/g, " ");
		const save = button(options.confirm, () => close(value()), { primary: true, disabled: true });
		const update = () => {
			save.disabled = !value() || value() === initial;
		};
		const close = (result: string | undefined) => {
			if (closed) return;
			closed = true;
			leave(dialog, "is-leaving", () => dialog.remove());
			options.signal?.removeEventListener("abort", cancel);
			window.removeEventListener("hashchange", cancel);
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
			resolve(result && result !== initial ? result : undefined);
		};
		const cancel = () => close(undefined);
		input.addEventListener("input", update);
		const dialog = h(
			"div",
			{ class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === dialog && cancel() },
			h(
				"form",
				{
					class: "modal name-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": options.title,
					onsubmit: (event: SubmitEvent) => {
						event.preventDefault();
						if (!save.disabled) close(value());
					},
				},
				h("h2", { class: "name-dialog-title" }, options.title),
				input,
				h("div", { class: "modal-actions" }, button(t("Cancel"), cancel), save),
			),
		);
		save.type = "submit";
		dialog.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				cancel();
			}
			if (event.key !== "Tab") return;
			const fields = [...dialog.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
			const first = fields[0];
			const last = fields[fields.length - 1];
			if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			}
		});
		document.body.append(dialog);
		options.signal?.addEventListener("abort", cancel, { once: true });
		window.addEventListener("hashchange", cancel);
		update();
		input.focus();
		input.select();
	});
}
