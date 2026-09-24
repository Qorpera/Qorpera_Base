import type { User } from "@supabase/supabase-js";
import { describeError } from "../../cloud/client.ts";
import { type Child, h, icon, notice, personAvatar } from "../../ui/dom.ts";
import { PERSON_PICTURE_EVENT, personPictures } from "../../ui/person-pictures.ts";
import { PictureFileError } from "../../ui/picture-file.ts";
import { uiText } from "../../ui/preferences.ts";
import { displayName } from "../auth.ts";

/* The account's picture at the head of Settings → General. Clicking it picks a
 * photo; once there is one, it opens a small menu to pick another or go back to
 * initials. Where the cloud has no member pictures yet it is the initials disc
 * alone, with nothing to click. Why the last change failed is kept by the store
 * and shown in `error` (placed under the card) until the next attempt, so a
 * redrawn page still shows it and nothing else on the page clears it. */

function failureText(error: unknown): Child[] {
	if (error instanceof PictureFileError) return [uiText(error.message)];
	return [uiText("Your picture could not be changed."), " ", describeError(error)];
}

export function accountPicture(user: User | null): { picture: HTMLElement; error: HTMLElement } {
	const avatar = personAvatar(displayName(user), user?.id ?? "");
	const store = personPictures();
	const error = h("div", { class: "account-picture-error", hidden: true });
	if (!store || !user) return { picture: h("span", { class: "account-picture" }, avatar), error };
	const userId = user.id;
	const input = h("input", {
		type: "file",
		accept: "image/*",
		hidden: true,
		tabindex: "-1",
		"aria-hidden": "true",
	});
	const badge = h("span", { class: "account-picture-badge", "aria-hidden": "true" }, icon("camera"));
	const trigger = h("button", { type: "button", class: "account-picture-button" }, avatar, badge);
	const item = (iconName: string, label: string, action: () => void, extra = "") =>
		h(
			"button",
			{ type: "button", role: "menuitem", class: `account-picture-item${extra}`, tabindex: "-1", onclick: action },
			icon(iconName),
			h("span", null, uiText(label)),
		);
	const choose = item("image", "Choose a new picture", () => {
		setOpen(false, true);
		input.click();
	});
	const remove = item(
		"close",
		"Remove picture",
		() => {
			setOpen(false, true);
			void run(() => store.remove(userId));
		},
		" account-picture-remove",
	);
	const menu = h(
		"div",
		// Focusable itself, so a click on its padding keeps Escape with the menu.
		{ class: "account-picture-menu", role: "menu", "aria-label": "Profile picture", tabindex: "-1", hidden: true },
		choose,
		remove,
	);
	const root = h("div", { class: "account-picture" }, trigger, menu, input);
	let open = false;

	const onOutside = (event: Event) => {
		if (!root.isConnected) document.removeEventListener("pointerdown", onOutside, true);
		else if (!root.contains(event.target as Node)) setOpen(false);
	};
	function setOpen(next: boolean, focusTrigger = false): void {
		if (next === open) return;
		open = next;
		menu.hidden = !next;
		trigger.setAttribute("aria-expanded", String(next));
		if (next) {
			document.addEventListener("pointerdown", onOutside, true);
			choose.focus();
		} else {
			document.removeEventListener("pointerdown", onOutside, true);
			if (focusTrigger) trigger.focus();
		}
	}

	async function run(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch {
			// The store keeps the failure; update() shows it.
		}
	}

	function update(): void {
		const status = store!.status(userId);
		const busy = store!.busy(userId);
		// A picture that could not be read may still exist: offer both choices.
		const menu = status === "picture" || status === "failed";
		const changeable = menu || status === "none";
		trigger.disabled = busy || !changeable;
		root.classList.toggle("is-busy", busy);
		root.classList.toggle("is-changeable", changeable);
		badge.hidden = !changeable;
		if (busy) trigger.setAttribute("aria-busy", "true");
		else trigger.removeAttribute("aria-busy");
		const label = busy
			? "Saving your profile picture"
			: menu
				? "Change profile picture"
				: status === "none"
					? "Add a profile picture"
					: "Profile picture";
		trigger.setAttribute("aria-label", label);
		trigger.title = changeable ? label : "";
		if (menu) {
			trigger.setAttribute("aria-haspopup", "menu");
			trigger.setAttribute("aria-expanded", String(open));
		} else {
			trigger.removeAttribute("aria-haspopup");
			trigger.removeAttribute("aria-expanded");
		}
		if (open && (busy || !menu)) setOpen(false);
		const failure = store!.failure(userId);
		error.hidden = failure === undefined;
		if (failure === undefined) error.replaceChildren();
		else error.replaceChildren(notice("danger", ...failureText(failure)));
	}

	const hasMenu = () => ["picture", "failed"].includes(store.status(userId));
	trigger.onclick = () => {
		if (hasMenu()) setOpen(!open);
		else input.click();
	};
	trigger.onkeydown = (event: KeyboardEvent) => {
		if (event.key === "ArrowDown" && hasMenu()) {
			event.preventDefault();
			setOpen(true);
		}
	};
	menu.onkeydown = (event: KeyboardEvent) => {
		const items = [choose, remove];
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === "Escape") {
			// Settings closes on Escape; a menu inside it closes first.
			event.preventDefault();
			event.stopPropagation();
			setOpen(false, true);
		} else if (event.key === "Tab") setOpen(false);
		else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]!.focus();
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			items[event.key === "Home" ? 0 : items.length - 1]!.focus();
		}
	};
	input.onchange = () => {
		const file = input.files?.[0];
		input.value = "";
		if (file) void run(() => store.choose(userId, file));
	};
	avatar.addEventListener(PERSON_PICTURE_EVENT, update);
	update();
	return { picture: root, error };
}
