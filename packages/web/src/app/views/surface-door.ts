import {
	type CompiledIdentityTokens,
	type PointToChangeTarget,
	parsePointToChangeTarget,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfacePreviewFrameState,
} from "@qorpera/contracts";
import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { SITE_DOOR_PASS, SITE_DOOR_READY, SITE_DOOR_SHOWN, SITE_DOOR_URL } from "./site-view.ts";

export const IDENTITY_TOKENS_CSS_MESSAGE = "qorpera:identity-tokens-css";

export function applyIdentityTokensToFrame(
	iframe: HTMLIFrameElement,
	tokens: CompiledIdentityTokens | null,
	injectStyle = true,
): void {
	const css = tokens?.css ?? "";
	const vars = tokens?.vars ?? {};
	if (injectStyle) {
		try {
			const doc = iframe.contentDocument;
			if (doc?.head) {
				let style = doc.head.querySelector<HTMLStyleElement>("style[data-qorpera-identity-tokens]");
				if (css) {
					if (!style) {
						style = doc.createElement("style");
						style.setAttribute("data-qorpera-identity-tokens", "");
						doc.head.append(style);
					}
					if (style.textContent !== css) style.textContent = css;
				} else if (style) {
					style.remove();
				}
			}
		} catch {
			/* WHY: Cross-origin preview frames block contentDocument access and receive tokens via postMessage below. */
		}
	}
	try {
		iframe.contentWindow?.postMessage({ type: IDENTITY_TOKENS_CSS_MESSAGE, css, vars }, "*");
	} catch {
		/* WHY: Detached or initializing frames ignore postMessage until ready. */
	}
}

// WHY: Matches SiteView's sandbox so previews run scripts and forms on their own origin without touching this app's page.
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

interface DoorSlot {
	readonly key: string;
	readonly iframe: HTMLIFrameElement;
	readonly action: string;
	readonly pass: string;
	readonly path: string;
	sent: boolean;
}

export interface SurfaceDoorOptions {
	readonly onPick?: (target: PointToChangeTarget) => void;
	readonly onShownChange?: () => void;
}

export function previewStatusText(frame: SurfacePreviewFrameState): string {
	switch (frame.status) {
		case "composing":
			return t("Composing preview…");
		case "building":
			return t("Building preview…");
		case "conflicted":
			return t("These changes conflict. Turn one off to preview the rest.");
		case "failed":
			return frame.errorDetail ?? t("The preview could not be built.");
		default:
			return "";
	}
}

export class SurfaceDoorStage {
	readonly el = h("div", { class: "surface-door-stage" });
	readonly #lifetime = new AbortController();
	readonly #waitingState = h("span", { class: "surface-state is-running" });
	readonly #waitingText = h("p");
	readonly #waiting = h(
		"div",
		{ class: "surface-frame is-waiting", hidden: true },
		this.#waitingState,
		this.#waitingText,
	);
	readonly #pillText = h("span");
	readonly #pill = h(
		"div",
		{ class: "surface-preview-pill", hidden: true, role: "status" },
		h("span", { class: "surface-state is-running" }),
		this.#pillText,
	);
	readonly #options: SurfaceDoorOptions;
	#active: DoorSlot | undefined;
	#staging: DoorSlot | undefined;
	#inspectorActive = false;
	#identityTokens: CompiledIdentityTokens | null = null;
	#identityTokensCss = "";

	constructor(signal: AbortSignal, options: SurfaceDoorOptions = {}) {
		this.#options = options;
		signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.el.append(this.#waiting, this.#pill);
		window.addEventListener("message", (event) => this.#onMessage(event), { signal: this.#lifetime.signal });
	}

	get hasShown(): boolean {
		return Boolean(this.#active);
	}

	sync(frame: SurfacePreviewFrameState, title: string): void {
		if (this.#lifetime.signal.aborted) return;
		if (frame.status === "ready" && frame.doorActionUrl && frame.memberPass) {
			const path = frame.activeRoute.startsWith("/") ? frame.activeRoute : "/";
			const key = `${frame.previewId ?? ""}\0${frame.doorActionUrl}\0${frame.memberPass}\0${path}`;
			if (this.#active?.key === key) {
				this.#active.iframe.title = title;
				this.#dropStaging();
				this.#waiting.hidden = true;
				this.#pill.hidden = true;
				return;
			}
			if (this.#staging?.key === key) {
				this.#staging.iframe.title = title;
				return;
			}
			this.#dropStaging();
			const iframe = h("iframe", {
				class: "surface-frame is-staging",
				sandbox: SANDBOX,
				referrerpolicy: "no-referrer",
				title,
			});
			this.#staging = {
				key,
				iframe,
				action: frame.doorActionUrl,
				pass: frame.memberPass,
				path,
				sent: false,
			};
			this.el.append(iframe);
			iframe.src = SITE_DOOR_URL;
			this.#pill.hidden = true;
			if (this.#active) {
				this.#waiting.hidden = true;
			} else {
				this.#showWaiting("running", t("Opening preview…"));
			}
			return;
		}
		this.#dropStaging();
		if (frame.status === "composing" || frame.status === "building") {
			const words = previewStatusText(frame);
			if (this.#active) {
				this.#waiting.hidden = true;
				this.#pillText.textContent = words;
				this.#pill.hidden = false;
			} else {
				this.#pill.hidden = true;
				this.#showWaiting("running", words);
			}
			return;
		}
		this.#pill.hidden = true;
		if (frame.status === "conflicted") {
			if (this.#active) {
				this.#waiting.hidden = true;
				return;
			}
			this.#showWaiting("conflicted", previewStatusText(frame));
			return;
		}
		this.#dropActive();
		this.#showWaiting(
			frame.status === "failed" ? "failed" : "running",
			previewStatusText(frame) || t("Preview appears here when a change is ready."),
		);
	}

	setInspectorMode(active: boolean): void {
		this.#inspectorActive = active;
		this.#postInspectorMode(active);
	}

	setIdentityTokens(tokens: CompiledIdentityTokens | null): void {
		const nextCss = tokens?.css ?? "";
		if (nextCss === this.#identityTokensCss && Boolean(tokens) === Boolean(this.#identityTokens)) return;
		this.#identityTokens = tokens;
		this.#identityTokensCss = nextCss;
		this.#postIdentityTokens();
	}

	clear(): void {
		if (this.#inspectorActive) {
			this.#postInspectorMode(false);
			this.#inspectorActive = false;
		}
		this.#dropStaging();
		this.#dropActive();
		this.#waiting.hidden = true;
		this.#pill.hidden = true;
	}

	dispose(): void {
		this.clear();
		this.#lifetime.abort();
		this.el.remove();
	}

	#showWaiting(kind: "running" | "conflicted" | "failed", words: string): void {
		this.#waitingState.className = `surface-state is-${kind}`;
		this.#waitingText.textContent = words;
		this.#waiting.hidden = false;
	}

	#dropStaging(): void {
		if (!this.#staging) return;
		this.#staging.iframe.remove();
		this.#staging = undefined;
	}

	#dropActive(): void {
		if (!this.#active) return;
		this.#active.iframe.remove();
		this.#active = undefined;
		this.#options.onShownChange?.();
	}

	#postInspectorMode(active: boolean): void {
		const target = this.#active?.iframe.contentWindow;
		if (!target) return;
		target.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active }, location.origin);
	}

	#postIdentityTokens(): void {
		if (!this.#active) return;
		applyIdentityTokensToFrame(this.#active.iframe, this.#identityTokens, false);
	}

	#onMessage(event: MessageEvent): void {
		if (event.origin !== location.origin) return;
		const data = event.data as { type?: unknown; target?: unknown } | null;
		if (!data || typeof data !== "object") return;
		const staging = this.#staging;
		if (staging && event.source === staging.iframe.contentWindow) {
			if (data.type === SITE_DOOR_READY && !staging.sent) {
				staging.sent = true;
				staging.iframe.contentWindow?.postMessage(
					{
						type: SITE_DOOR_PASS,
						action: staging.action,
						pass: staging.pass,
						title: staging.iframe.title,
						path: staging.path,
					},
					location.origin,
				);
				return;
			}
			if (data.type === SITE_DOOR_SHOWN && staging.sent) {
				const previous = this.#active;
				this.#active = staging;
				this.#staging = undefined;
				staging.iframe.classList.remove("is-staging");
				staging.iframe.classList.add("is-shown");
				previous?.iframe.remove();
				this.#waiting.hidden = true;
				this.#pill.hidden = true;
				this.#options.onShownChange?.();
				if (this.#inspectorActive) this.#postInspectorMode(true);
				if (this.#identityTokens) this.#postIdentityTokens();
				return;
			}
		}
		const active = this.#active;
		if (!active || event.source !== active.iframe.contentWindow) return;
		if (data.type === SITE_DOOR_SHOWN) {
			if (this.#inspectorActive) this.#postInspectorMode(true);
			if (this.#identityTokens) this.#postIdentityTokens();
			return;
		}
		if (data.type === SURFACE_INSPECTOR_PICK_MESSAGE && this.#options.onPick) {
			try {
				this.#options.onPick(parsePointToChangeTarget(data.target));
			} catch {
				/* WHY: Ignore malformed pick payloads from preview frames. */
			}
		}
	}
}
