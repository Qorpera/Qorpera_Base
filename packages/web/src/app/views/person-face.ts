import { h, personAvatar } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyState } from "../company.ts";

const ONLINE_MS = 3 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function lastOnline(iso: string | null | undefined, now = Date.now()): { online: boolean; text: string } | null {
	const time = iso ? Date.parse(iso) : Number.NaN;
	if (!iso || !Number.isFinite(time)) return null;
	const ago = Math.max(0, now - time);
	if (ago < ONLINE_MS) return { online: true, text: t("Online now") };
	if (ago >= 2 * WEEK_MS) return { online: false, text: t("Last online 2+ weeks ago") };
	const words = new Intl.RelativeTimeFormat(presentationLocale(), { numeric: "always" });
	const when =
		ago < HOUR_MS
			? words.format(-Math.floor(ago / 60_000), "minute")
			: ago < DAY_MS
				? words.format(-Math.floor(ago / HOUR_MS), "hour")
				: ago < WEEK_MS
					? words.format(-Math.floor(ago / DAY_MS), "day")
					: words.format(-Math.floor(ago / WEEK_MS), "week");
	return { online: false, text: t("Last online {when}", { when }) };
}

export function personFace(name: string, userId: string, online: boolean): HTMLElement {
	return h(
		"span",
		{ class: online ? "person-face is-online" : "person-face" },
		personAvatar(name, userId),
		online ? h("span", { class: "person-online-dot", "aria-hidden": "true" }) : null,
	);
}

export function memberPresence(
	state: Pick<CompanyState, "here" | "memberChats">,
	userId: string,
	now = Date.now(),
): { online: boolean; text: string } | null {
	if (state.here?.some((member) => member.userId === userId && member.staffAgentId !== null))
		return { online: true, text: t("Online now") };
	return lastOnline(state.memberChats?.[userId]?.lastSeenAt, now);
}
