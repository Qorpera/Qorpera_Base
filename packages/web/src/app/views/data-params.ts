import { h, replace } from "../../ui/dom.ts";

export class DataParams {
	readonly el = h("div", { class: "data-params", hidden: true });
	#shown: string | undefined;

	show(
		place: string | undefined,
		names: readonly string[],
		values: Readonly<Record<string, string>>,
		label: (name: string) => string,
		set: (name: string, value: string) => void,
	): void {
		this.el.hidden = place === undefined || names.length === 0;
		const shown = place === undefined ? undefined : JSON.stringify([place, names]);
		if (shown === this.#shown) return;
		this.#shown = shown;
		if (place === undefined) {
			replace(this.el);
			return;
		}
		replace(
			this.el,
			...names.map((name, index) => {
				const id = `data-param-${index}`;
				const field = h("input", {
					type: "text",
					class: "data-param-input",
					id,
					value: values[name] ?? "",
					autocomplete: "off",
					enterkeyhint: index === names.length - 1 ? "done" : "next",
					dataset: { focusKey: `param:${name}` },
				});
				field.addEventListener("change", () => set(name, field.value));
				field.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || event.isComposing) return;
					event.preventDefault();
					set(name, field.value);
					const next = this.el.querySelectorAll<HTMLInputElement>(".data-param-input")[index + 1];
					if (next && next.value.trim() === "") next.focus();
				});
				return h(
					"label",
					{ class: "data-param", for: id },
					h("span", { class: "data-param-label" }, label(name)),
					field,
				);
			}),
		);
	}
}
