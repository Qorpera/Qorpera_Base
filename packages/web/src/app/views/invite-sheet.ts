import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedFriend, HostedProfileInvitation } from "../../cloud/types.ts";
import { button, h, personAvatar, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";

export type GuestRole = "founder" | "spectator";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteEmail(input: HTMLInputElement): string | undefined {
	const email = input.value.trim().toLowerCase();
	if (EMAIL.test(email)) return email;
	input.focus();
	return undefined;
}

export interface InviteSheetBody {
	readonly friends: readonly HTMLElement[] | undefined;
	readonly emailed: readonly HTMLElement[];
	readonly note?: string | undefined;
	readonly add: (input: HTMLInputElement) => void;
	readonly done: () => void;
	readonly busy?: boolean;
}

export function inviteSheetBody(body: InviteSheetBody): HTMLElement[] {
	const email: HTMLInputElement = h("input", {
		type: "email",
		class: "hero-invite-email",
		placeholder: t("Add someone by email"),
		"aria-label": t("Email"),
		disabled: body.busy === true,
		onkeydown: (event: KeyboardEvent) => {
			if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			body.add(email);
		},
	});
	return [
		h("p", { class: "hero-invite-title" }, t("Invite people")),
		...(body.friends === undefined
			? [h("p", { class: "hero-invite-note" }, t("Loading your friends"))]
			: body.friends),
		...body.emailed,
		body.note ? h("p", { class: "hero-invite-note", role: "alert" }, body.note) : null,
		h(
			"div",
			{ class: "hero-invite-add" },
			email,
			button(t("Add as spectator"), () => body.add(email), { small: true, disabled: body.busy === true }),
		),
		h("div", { class: "hero-invite-foot" }, button(t("Done"), body.done, { primary: true, small: true })),
	].filter((part) => part !== null);
}

export function inviteFriendRow(
	friend: HostedFriend,
	role: GuestRole | undefined,
	choose: (role: GuestRole) => void,
	labels: Readonly<Record<GuestRole, string>>,
	busy = false,
): HTMLElement {
	const name = friend.displayName || friend.email;
	const choice = (option: GuestRole) =>
		h(
			"button",
			{
				type: "button",
				class: "hero-invite-role",
				"aria-pressed": String(role === option),
				disabled: busy,
				onclick: () => choose(option),
			},
			labels[option],
		);
	return h(
		"div",
		{ class: "hero-invite-person" },
		personAvatar(name, friend.userId),
		h(
			"div",
			{ class: "hero-invite-who" },
			h("strong", null, name),
			h(
				"small",
				null,
				role === "founder"
					? t("Builds with you, on their own subscription.")
					: role === "spectator"
						? t("Follows the chats. No subscription.")
						: friend.email,
			),
		),
		h(
			"div",
			{ class: "hero-invite-roles", role: "group", "aria-label": t("Role for {name}", { name }) },
			choice("founder"),
			choice("spectator"),
		),
	);
}

export function inviteEmailRow(email: string, remove: () => void, busy = false): HTMLElement {
	return h(
		"div",
		{ class: "hero-invite-person" },
		personAvatar(email, email),
		h(
			"div",
			{ class: "hero-invite-who" },
			h("strong", null, email),
			h("small", null, t("Follows the chats. No subscription.")),
		),
		button(t("Remove"), remove, { small: true, disabled: busy }),
	);
}

export type InviteCalls = Pick<CloudApi, "listFriends" | "inviteMember" | "cancelInvitation">;

const roleOf = (invitation: HostedProfileInvitation): GuestRole =>
	invitation.role === "viewer" ? "spectator" : "founder";

let shownSheet: { readonly el: HTMLElement; readonly close: () => void } | undefined;

export function openInviteSheet(company: CompanyController, calls: InviteCalls, anchor: HTMLElement): void {
	shownSheet?.close();
	const profileId = company.profile.profileId;
	const lifetime = new AbortController();
	const sheet = h("div", {
		class: "hero-invite-sheet company-invite-sheet",
		role: "dialog",
		"aria-label": t("Invite people"),
	});
	let friends: HostedFriend[] | undefined;
	let note: string | undefined;
	let busy = false;
	const close = () => {
		if (lifetime.signal.aborted) return;
		lifetime.abort();
		sheet.remove();
		if (shownSheet?.el === sheet) shownSheet = undefined;
		if (anchor.isConnected) anchor.focus({ preventScroll: true });
	};
	const labels = { founder: t("Builder"), spectator: t("Spectator") } as const;
	const run = async (work: () => Promise<unknown>) => {
		if (busy) return;
		busy = true;
		note = undefined;
		draw();
		try {
			await work();
		} catch (error) {
			note = describeError(error);
		}
		await company.refreshTeam().catch(() => {});
		busy = false;
		draw();
	};
	const draw = () => {
		if (lifetime.signal.aborted) return;
		const team = company.store.get().team;
		const members = new Set(team?.members.map((member) => member.userId) ?? []);
		const invitations = team?.invitations ?? [];
		const invitationOf = (email: string) =>
			invitations.find((invitation) => invitation.email.toLowerCase() === email.toLowerCase());
		const listed = friends?.filter((friend) => friend.status === "accepted" && !members.has(friend.userId));
		const known = new Set(listed?.map((friend) => friend.email.toLowerCase()) ?? []);
		const typed = sheet.querySelector<HTMLInputElement>(".hero-invite-email");
		const typing = typed !== null && typed === document.activeElement;
		const choose = (friend: HostedFriend) => (role: GuestRole) => {
			const invited = invitationOf(friend.email);
			// WHY: The cloud never invites a founder, so a builder joins as a contributor.
			const invite = (as: GuestRole) =>
				calls.inviteMember(profileId, friend.email, as === "spectator" ? "viewer" : "contributor");
			void run(async () => {
				if (!invited) return invite(role);
				await calls.cancelInvitation(profileId, invited.id);
				if (roleOf(invited) === role) return;
				try {
					await invite(role);
				} catch (error) {
					await invite(roleOf(invited)).catch(() => {});
					throw error;
				}
			});
		};
		replace(
			sheet,
			...inviteSheetBody({
				friends: listed?.map((friend) => {
					const invited = invitationOf(friend.email);
					return inviteFriendRow(friend, invited ? roleOf(invited) : undefined, choose(friend), labels, busy);
				}),
				emailed: invitations
					.filter((invitation) => !known.has(invitation.email.toLowerCase()))
					.map((invitation) =>
						inviteEmailRow(
							invitation.email,
							() => void run(() => calls.cancelInvitation(profileId, invitation.id)),
							busy,
						),
					),
				note,
				busy,
				add: (input) => {
					const email = inviteEmail(input);
					if (!email) return;
					input.value = "";
					void run(() => calls.inviteMember(profileId, email, "viewer"));
				},
				done: close,
			}),
		);
		const field = sheet.querySelector<HTMLInputElement>(".hero-invite-email");
		if (!field || !typed) return;
		field.value = typed.value;
		if (typing) field.focus();
	};
	const place = () => {
		const box = anchor.getBoundingClientRect();
		sheet.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - sheet.offsetWidth - 8))}px`;
		sheet.style.top = `${box.bottom + 8}px`;
	};
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (!(event.target instanceof Node) || !sheet.contains(event.target)) close();
		},
		{ capture: true, signal: lifetime.signal },
	);
	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close();
		},
		{ signal: lifetime.signal },
	);
	window.addEventListener("resize", place, { signal: lifetime.signal });
	window.addEventListener("hashchange", close, { signal: lifetime.signal });
	company.signal.addEventListener("abort", close, { signal: lifetime.signal });
	draw();
	document.body.append(sheet);
	place();
	shownSheet = { el: sheet, close };
	sheet.querySelector<HTMLElement>(".hero-invite-email")?.focus();
	void calls.listFriends().then(
		(list) => {
			friends = list;
			draw();
		},
		() => {
			friends = [];
			note = t("Your friends could not be read.");
			draw();
		},
	);
}
