import type { User } from "@supabase/supabase-js";
import { describeError } from "../../cloud/client.ts";
import { type Child, h, icon, notice, personAvatar } from "../../ui/dom.ts";
import { PERSON_PICTURE_EVENT, personPictures, personPicturesEpoch } from "../../ui/person-pictures.ts";
import { choosePictureCrop } from "../../ui/picture-cropper.ts";
import { type PictureCrop, PictureFileError } from "../../ui/picture-file.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";
import { displayName } from "../auth.ts";

/* The account's picture at the head of Settings → General. Clicking it picks a
 * photo, which the member fits to the circle before it is saved; once there is
 * a picture, it opens a small menu to pick another or go back to initials.
 * Where the cloud has no member pictures yet it is the initials disc alone,
 * with nothing to click. Why the last change failed is kept by the store and
 * shown in `error` (placed under the card) until the next attempt, so a
 * redrawn page still shows it and nothing else on the page clears it. */

function failureText(error: unknown): Child[] {
	if (error instanceof PictureFileError) return [uiText(error.message)];
	// Storage refuses an upload with its policy's words; the member needs none of them.
	const refused = error as { statusCode?: unknown; message?: unknown };
	if (refused.statusCode === "403" || /row-level security/i.test(String(refused.message)))
		return [uiText("Your picture could not be saved. Try again in a moment.")];
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
	const choose = item("image", phrase("Choose a new picture"), () => {
		setOpen(false, true);
		if (!picking) input.click();
	});
	const remove = item(
		"close",
		phrase("Remove picture"),
		() => {
			setOpen(false, true);
			void run(() => store.remove(userId));
		},
		" account-picture-remove",
	);
	const menu = h(
		"div",
		// Focusable itself, so a click on its padding keeps Escape with the menu.
		{ class: "account-picture-menu", role: "menu", "aria-label": t("Profile picture"), tabindex: "-1", hidden: true },
		choose,
		remove,
	);
	const root = h("div", { class: "account-picture" }, trigger, menu, input);
	let open = false;
	/** A photo being opened or fitted; ends if the account changes meanwhile. */
	let picking: { lifetime: AbortController; epoch: number; loading: boolean } | undefined;

	const onOutside = (event: Event) => {
		if (!root.isConnected) document.removeEventListener("pointerdown", onOutside, true);
		else if (!root.contains(event.target as Node)) setOpen(false);
	};
	function setOpen(next: boolean, focusTrigger = false): void {
		// While a photo opens, nothing else starts: no menu, no second pick.
		if (next === open || (next && picking)) return;
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
		if (picking && picking.epoch !== personPicturesEpoch()) picking.lifetime.abort();
		const status = store!.status(userId);
		const saving = store!.busy(userId);
		// A big photo takes a moment to open before it can be fitted. The button stays
		// enabled meanwhile, so it keeps focus for the dialog to hand back; a second
		// pick is refused by `picking` instead.
		const opening = Boolean(picking?.loading);
		const busy = saving || opening;
		// A picture that could not be read may still exist: offer both choices.
		const menu = status === "picture" || status === "failed";
		const changeable = menu || status === "none";
		trigger.disabled = saving || !changeable;
		root.classList.toggle("is-busy", busy);
		root.classList.toggle("is-changeable", changeable);
		badge.hidden = !changeable;
		if (busy) trigger.setAttribute("aria-busy", "true");
		else trigger.removeAttribute("aria-busy");
		const label = saving
			? t("Saving your profile picture")
			: opening
				? t("Opening your picture")
				: menu
					? t("Change profile picture")
					: status === "none"
						? t("Add a profile picture")
						: t("Profile picture");
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
		if (picking) return;
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
			// From the menu itself (a click in its padding), down is the first item and up the last.
			const next =
				index < 0
					? event.key === "ArrowDown"
						? 0
						: items.length - 1
					: (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
			items[next]!.focus();
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			items[event.key === "Home" ? 0 : items.length - 1]!.focus();
		}
	};
	input.onchange = () => {
		const file = input.files?.[0];
		input.value = "";
		if (!file || picking) return;
		const pick = { lifetime: new AbortController(), epoch: personPicturesEpoch(), loading: true };
		picking = pick;
		update();
		const opened = () => {
			pick.loading = false;
			update();
		};
		void (async () => {
			let crop: PictureCrop | undefined;
			try {
				crop = await choosePictureCrop(file, pick.lifetime.signal, opened);
			} catch (error) {
				// A photo the browser cannot open never reaches the store; its reason is kept there all the same.
				if (!pick.lifetime.signal.aborted) store.fail(userId, error);
				return;
			} finally {
				picking = undefined;
				update();
			}
			if (crop && !pick.lifetime.signal.aborted) await run(() => store.choose(userId, file, crop));
		})();
	};
	avatar.addEventListener(PERSON_PICTURE_EVENT, update);
	update();
	return { picture: root, error };
}
