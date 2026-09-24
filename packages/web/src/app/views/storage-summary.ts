import type { HostedCompanyFile } from "../../cloud/types.ts";
import { fmtBytes, h } from "../../ui/dom.ts";
import { t, uiText } from "../../ui/preferences.ts";

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
			text: error ? uiText("Storage information unavailable") : uiText("Loading storage…"),
			meter: null,
		};
	const limited = file.storageLimitBytes > 0;
	return {
		text: limited
			? uiText("{used} used of {total}", {
					used: fmtBytes(file.storageUsedBytes),
					total: fmtBytes(file.storageLimitBytes),
				})
			: uiText("{used} used", { used: fmtBytes(file.storageUsedBytes) }),
		meter: limited ? meter(file.storageUsedBytes, file.storageLimitBytes, t("Company storage used")) : null,
	};
}
