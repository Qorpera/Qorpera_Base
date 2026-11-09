import type { HostedCompanyFile } from "../../cloud/types.ts";
import { fmtBytes } from "../../ui/dom.ts";
import { uiText } from "../../ui/preferences.ts";

/** One line for a company's storage: what it holds in total. Shared by the Storage card in Settings and Storage's
 * navigation so the two never disagree. */
export function storageSummary(file: HostedCompanyFile | undefined, error: string | undefined): HTMLElement {
	if (!file) return error ? uiText("Storage information unavailable") : uiText("Loading storage…");
	return uiText("{used} in total", { used: fmtBytes(file.storageUsedBytes) });
}
