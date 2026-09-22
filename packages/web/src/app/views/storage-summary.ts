import type { HostedCompanyFile } from "../../cloud/types.ts";
import { fmtBytes, h } from "../../ui/dom.ts";
import { uiText } from "../../ui/preferences.ts";

/** A bar of what is used against what is included. */
export function meter(value: number, max: number, label: string): HTMLElement {
	return h("progress", { max, value: Math.min(value, max), "aria-label": label });
}

/** One line for a company's storage, shared by the Company File card and the
 * Plan & usage tab so the two never disagree, plus its meter when the company
 * has a limit. */
export function storageSummary(
	file: HostedCompanyFile | undefined,
	error: string | undefined,
): { text: HTMLElement; meter: HTMLElement | null } {
	if (!file)
		return {
			text: uiText(error ? "Storage information unavailable" : "Loading storage…"),
			meter: null,
		};
	const limited = file.storageLimitBytes > 0;
	return {
		text: h(
			"span",
			null,
			`${fmtBytes(file.storageUsedBytes)} `,
			uiText("used"),
			limited ? [" ", uiText("of"), ` ${fmtBytes(file.storageLimitBytes)}`] : null,
		),
		meter: limited ? meter(file.storageUsedBytes, file.storageLimitBytes, "Company storage used") : null,
	};
}
