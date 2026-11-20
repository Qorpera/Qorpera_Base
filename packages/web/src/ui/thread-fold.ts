import { icon } from "./dom.ts";
import { t } from "./preferences.ts";

export interface ThreadFold {
	count: number;
	text: string;
	open: boolean;
	toggle: () => void;
}

export function threadFold(fold: ThreadFold): HTMLElement {
	const row = document.createElement("button");
	row.type = "button";
	row.className = `thread-fold${fold.open ? " is-open" : ""}`;
	row.setAttribute("aria-expanded", String(fold.open));
	const mark = document.createElement("span");
	mark.className = "thread-fold-mark";
	mark.setAttribute("aria-hidden", "true");
	mark.append(icon("chevron"));
	row.append(mark);
	const many = fold.count > 1;
	if (fold.open || many) {
		const count = document.createElement("span");
		count.className = "thread-fold-count";
		count.textContent = fold.open
			? many
				? t("Hide {count} updates", { count: String(fold.count) })
				: t("Hide update")
			: t("{count} updates", { count: String(fold.count) });
		row.append(count);
	}
	if (!fold.open) {
		const text = document.createElement("span");
		text.className = "thread-fold-text";
		text.textContent = fold.text;
		row.append(text);
	}
	row.addEventListener("click", fold.toggle);
	return row;
}
