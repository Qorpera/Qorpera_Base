import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import { presentationLocale, t } from "./preferences.ts";

export interface ComputerViewer {
	close(): Promise<void>;
}
export interface ComputerViewerOptions {
	/** Keep the viewer inside a conversation surface; omitted for standalone views. */
	mount?: HTMLElement;
	/** A delayed attachment must not interrupt typing outside its surface. */
	autofocus?: boolean;
	/** Keep the host's expanded fallback in sync with entered and mini screen states. */
	onExpandedChange?(expanded: boolean): void;
	binding: CompanyComputerScreenBinding;
	title: string;
	canControl: boolean;
	sharedControl?: boolean;
	requestConnection(input: {
		binding: CompanyComputerScreenBinding;
		mode: "watch" | "shared" | "control";
		signal: AbortSignal;
	}): Promise<CompanyComputerMemberView>;
	releaseConnection(input: { connectionId: string }): Promise<void>;
	onClosed(): void;
}

/** The bundled renderer receives an authenticated channel, never a ticket URL. */
export function openComputerViewer(options: ComputerViewerOptions): ComputerViewer {
	const renderer = (
		window as unknown as { qorperaScreenViewer?: { open(options: ComputerViewerOptions): ComputerViewer } }
	).qorperaScreenViewer;
	if (!renderer) throw new Error("Screen viewing is unavailable.");
	const translation = translateViewer(options.mount ?? document.body);
	const viewer = renderer.open({
		...options,
		onClosed: () => {
			translation?.disconnect();
			options.onClosed();
		},
	});
	return {
		close: async () => {
			try {
				await viewer.close();
			} finally {
				translation?.disconnect();
			}
		},
	};
}

const VIEWER_ATTRIBUTES = ["aria-label", "title"];

/** The renderer is the desktop's, copied unchanged (member-web/ui/SOURCE.json),
 * so its fixed English is translated here as it appears: only inside its own
 * overlay, and never the heading, which carries the computer's title. */
function translateViewer(scope: HTMLElement): MutationObserver | undefined {
	if (presentationLocale() !== "da") return undefined;
	const text = new Map<string, string>([
		["Back to thread", t("Back to thread")],
		["Checking your private sign-in access", t("Checking your private sign-in access")],
		["Close screen viewer", t("Close screen viewer")],
		[
			"Cloud screen unavailable. Reconnect to check access again.",
			t("Cloud screen unavailable. Reconnect to check access again."),
		],
		["Connecting to cloud desktop", t("Connecting to cloud desktop")],
		["Connecting", t("Connecting")],
		["Disconnected", t("Disconnected")],
		["Enter", t("Enter")],
		["Full screen unavailable", t("Full screen unavailable")],
		[
			"Private sign-in · Closing this view leaves the office private",
			t("Private sign-in · Closing this view leaves the office private"),
		],
		["Reconnect", t("Reconnect")],
		["Release control", t("Release control")],
		["Shared with the agent", t("Shared with the agent")],
		["Starting the screen and connecting…", t("Starting the screen and connecting…")],
		["Take control", t("Take control")],
		[
			"Waiting for the cloud screen to release agent control",
			t("Waiting for the cloud screen to release agent control"),
		],
		["Watching only", t("Watching only")],
		["You control this cloud screen", t("You control this cloud screen")],
	]);
	const inViewer = (element: Element | null) =>
		Boolean(element?.closest(".screen-viewer-overlay")) && !element?.closest(".screen-viewer-heading");
	const visit = (node: Node): void => {
		if (node instanceof Text) {
			const danish = inViewer(node.parentElement) ? text.get(node.data) : undefined;
			if (danish) node.data = danish;
			return;
		}
		if (!(node instanceof Element)) return;
		if (inViewer(node))
			for (const name of VIEWER_ATTRIBUTES) {
				const danish = text.get(node.getAttribute(name) ?? "");
				if (danish) node.setAttribute(name, danish);
			}
		for (const child of node.childNodes) visit(child);
	};
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "childList") for (const node of record.addedNodes) visit(node);
			else visit(record.target);
		}
	});
	observer.observe(scope, {
		subtree: true,
		childList: true,
		characterData: true,
		attributes: true,
		attributeFilter: VIEWER_ATTRIBUTES,
	});
	return observer;
}
