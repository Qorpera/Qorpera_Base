import { CloudRpcError } from "../cloud/client.ts";

export const ONLINE_MARK_MS = 60_000;
export const ONLINE_RETRY_MS = 15_000;
export const ACTIVE_IDLE_MS = 3 * 60_000;
export const PASSIVE_FOCUS_DELAY_MS = 2_000;
export const UNFOCUSED_GRACE_MS = 15_000;

const POINTER_MOVE_THROTTLE_MS = 1_000;
const IFRAME_FOCUS_POLL_MS = 5_000;
const DIRECT_ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "input"] as const;
const POINTER_MOVE_EVENTS = ["pointermove", "mousemove"] as const;

export interface ActivitySource {
	readonly active: boolean;
	subscribe(listener: (active: boolean) => void): () => void;
}

export interface ActivityWatch extends ActivitySource {
	readonly activitySeq: number;
	onActivity(listener: () => void): () => void;
	stop(): void;
}

export interface OnlineWatch extends ActivitySource {
	mark(): void;
	stop(): void;
}

function isPageVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

function hasDocumentFocus(): boolean {
	return typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus();
}

function isFocusedInFront(): boolean {
	return isPageVisible() && hasDocumentFocus();
}

export function watchActivity(): ActivityWatch {
	let stopped = false;
	let active = false;
	let activitySeq = 0;
	let lastActivityAt = 0;
	let lastPointerMoveAt = 0;
	let lastPointerX = Number.NaN;
	let lastPointerY = Number.NaN;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let focusDwellTimer: ReturnType<typeof setTimeout> | undefined;
	let blurDeferTimer: ReturnType<typeof setTimeout> | undefined;
	let unfocusedTimer: ReturnType<typeof setTimeout> | undefined;
	let iframeFocusTimer: ReturnType<typeof setInterval> | undefined;
	const activeListeners = new Set<(active: boolean) => void>();
	const activityListeners = new Set<() => void>();

	const clearIdle = () => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const clearFocusDwell = () => {
		if (focusDwellTimer !== undefined) clearTimeout(focusDwellTimer);
		focusDwellTimer = undefined;
	};
	const clearBlurDefer = () => {
		if (blurDeferTimer !== undefined) clearTimeout(blurDeferTimer);
		blurDeferTimer = undefined;
	};
	const clearUnfocused = () => {
		if (unfocusedTimer !== undefined) clearTimeout(unfocusedTimer);
		unfocusedTimer = undefined;
	};
	const clearIframePoll = () => {
		if (iframeFocusTimer !== undefined) clearInterval(iframeFocusTimer);
		iframeFocusTimer = undefined;
	};

	const setActive = (next: boolean) => {
		if (stopped || next === active) return;
		active = next;
		if (!active) {
			clearIdle();
			clearUnfocused();
			clearIframePoll();
		}
		for (const listener of [...activeListeners]) listener(active);
	};

	const goInactive = () => {
		clearFocusDwell();
		clearBlurDefer();
		clearUnfocused();
		clearIdle();
		clearIframePoll();
		setActive(false);
	};

	const scheduleUnfocused = () => {
		clearFocusDwell();
		if (stopped || !active || unfocusedTimer !== undefined) return;
		unfocusedTimer = setTimeout(() => {
			unfocusedTimer = undefined;
			if (stopped) return;
			if (!isFocusedInFront()) goInactive();
		}, UNFOCUSED_GRACE_MS);
	};

	const syncIframePoll = () => {
		if (stopped || !active || typeof document === "undefined" || document.activeElement?.tagName !== "IFRAME") {
			clearIframePoll();
			return;
		}
		if (iframeFocusTimer !== undefined) return;
		iframeFocusTimer = setInterval(() => {
			if (stopped) return;
			if (!isPageVisible()) {
				goInactive();
				return;
			}
			if (!hasDocumentFocus()) {
				clearIframePoll();
				scheduleUnfocused();
				return;
			}
			if (document.activeElement?.tagName !== "IFRAME") clearIframePoll();
		}, IFRAME_FOCUS_POLL_MS);
	};

	const scheduleIdle = () => {
		clearIdle();
		if (stopped || !active) return;
		const remaining = lastActivityAt + ACTIVE_IDLE_MS - Date.now();
		if (remaining <= 0) {
			goInactive();
			return;
		}
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (stopped) return;
			if (!isPageVisible() || Date.now() - lastActivityAt >= ACTIVE_IDLE_MS) {
				goInactive();
				return;
			}
			scheduleIdle();
		}, remaining);
	};

	const recordActivity = () => {
		if (stopped || !isPageVisible()) return;
		clearFocusDwell();
		clearUnfocused();
		activitySeq += 1;
		lastActivityAt = Date.now();
		setActive(true);
		scheduleIdle();
		if (!hasDocumentFocus()) scheduleUnfocused();
		syncIframePoll();
		for (const listener of [...activityListeners]) listener();
	};

	const schedulePassiveFocus = () => {
		if (stopped || !isFocusedInFront()) return;
		clearUnfocused();
		if (active) {
			if (Date.now() - lastActivityAt >= ACTIVE_IDLE_MS) {
				goInactive();
			} else {
				scheduleIdle();
				return;
			}
		}
		if (focusDwellTimer !== undefined) return;
		focusDwellTimer = setTimeout(() => {
			focusDwellTimer = undefined;
			if (stopped || !isFocusedInFront()) return;
			recordActivity();
		}, PASSIVE_FOCUS_DELAY_MS);
	};

	const onDirectActivity = () => {
		if (!isPageVisible()) return;
		recordActivity();
	};

	const onPointerMove = (event: Event) => {
		if (!isFocusedInFront()) return;
		const point = event as Partial<MouseEvent>;
		if (typeof point.clientX !== "number" || typeof point.clientY !== "number") return;
		if (point.clientX === lastPointerX && point.clientY === lastPointerY) return;
		lastPointerX = point.clientX;
		lastPointerY = point.clientY;
		const now = Date.now();
		if (active && now - lastPointerMoveAt < POINTER_MOVE_THROTTLE_MS) return;
		lastPointerMoveAt = now;
		recordActivity();
	};

	const onVisibilityChange = () => {
		if (!isPageVisible()) {
			goInactive();
			return;
		}
		if (hasDocumentFocus()) schedulePassiveFocus();
	};

	const onFocus = () => {
		clearBlurDefer();
		if (isFocusedInFront()) schedulePassiveFocus();
	};

	const onBlur = () => {
		clearFocusDwell();
		clearBlurDefer();
		// WHY: Focus moving into a child iframe blurs the window first; inspect hasFocus once focus lands.
		blurDeferTimer = setTimeout(() => {
			blurDeferTimer = undefined;
			if (stopped) return;
			if (!isPageVisible()) {
				goInactive();
				return;
			}
			if (hasDocumentFocus()) {
				if (typeof document !== "undefined" && document.activeElement?.tagName === "IFRAME") recordActivity();
				return;
			}
			scheduleUnfocused();
		}, 0);
	};

	const onPageHide = () => {
		goInactive();
	};

	if (typeof window !== "undefined") {
		for (const event of DIRECT_ACTIVITY_EVENTS)
			window.addEventListener(event, onDirectActivity, { capture: true, passive: true });
		for (const event of POINTER_MOVE_EVENTS)
			window.addEventListener(event, onPointerMove, { capture: true, passive: true });
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		window.addEventListener("pagehide", onPageHide);
	}
	if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);

	if (isFocusedInFront()) schedulePassiveFocus();

	return {
		get active() {
			return active;
		},
		get activitySeq() {
			return activitySeq;
		},
		subscribe(listener) {
			activeListeners.add(listener);
			return () => {
				activeListeners.delete(listener);
			};
		},
		onActivity(listener) {
			activityListeners.add(listener);
			return () => {
				activityListeners.delete(listener);
			};
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearFocusDwell();
			clearBlurDefer();
			clearUnfocused();
			clearIdle();
			clearIframePoll();
			activeListeners.clear();
			activityListeners.clear();
			if (typeof window !== "undefined") {
				for (const event of DIRECT_ACTIVITY_EVENTS) window.removeEventListener(event, onDirectActivity, true);
				for (const event of POINTER_MOVE_EVENTS) window.removeEventListener(event, onPointerMove, true);
				window.removeEventListener("focus", onFocus);
				window.removeEventListener("blur", onBlur);
				window.removeEventListener("pagehide", onPageHide);
			}
			if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
		},
	};
}

export function watchOnline(
	markOnline: () => Promise<void>,
	signedIn: () => boolean,
	sharedActivity?: ActivityWatch,
): OnlineWatch {
	const ownsActivity = !sharedActivity;
	const activity = sharedActivity ?? watchActivity();
	let stopped = false;
	let markingDisabled = false;
	let busy = false;
	let lastMarkedAt = 0;
	let lastMarkedSeq = 0;
	let lastAttemptFailedAt = 0;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const clearFlush = () => {
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		flushTimer = undefined;
	};

	const scheduleFlush = (delayMs: number) => {
		clearFlush();
		if (stopped || markingDisabled || !activity.active) return;
		flushTimer = setTimeout(
			() => {
				flushTimer = undefined;
				maybeMark();
			},
			Math.max(0, delayMs),
		);
	};

	const maybeMark = () => {
		if (stopped || markingDisabled || busy || !signedIn() || !activity.active) return;
		if (activity.activitySeq <= lastMarkedSeq) return;
		const now = Date.now();
		if (lastMarkedAt > 0) {
			const wait = lastMarkedAt + ONLINE_MARK_MS - now;
			if (wait > 0) {
				scheduleFlush(wait);
				return;
			}
		}
		if (lastAttemptFailedAt > 0) {
			const retryWait = lastAttemptFailedAt + ONLINE_RETRY_MS - now;
			if (retryWait > 0) {
				scheduleFlush(retryWait);
				return;
			}
		}
		clearFlush();
		busy = true;
		const markedSeq = activity.activitySeq;
		markOnline()
			.then(() => {
				if (stopped) return;
				lastMarkedAt = Date.now();
				lastMarkedSeq = Math.max(lastMarkedSeq, markedSeq);
				lastAttemptFailedAt = 0;
			})
			.catch((error: unknown) => {
				if (error instanceof CloudRpcError && error.missing) {
					markingDisabled = true;
					clearFlush();
					return;
				}
				lastAttemptFailedAt = Date.now();
			})
			.finally(() => {
				busy = false;
				if (!stopped && !markingDisabled && activity.active) maybeMark();
			});
	};

	const unsubActive = activity.subscribe((isActive) => {
		if (!isActive) clearFlush();
		else maybeMark();
	});
	const unsubActivity = activity.onActivity(() => maybeMark());

	return {
		get active() {
			return activity.active;
		},
		subscribe: (listener) => activity.subscribe(listener),
		mark: () => {
			if (stopped || markingDisabled) return;
			lastMarkedAt = 0;
			lastMarkedSeq = 0;
			lastAttemptFailedAt = 0;
			maybeMark();
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			clearFlush();
			unsubActive();
			unsubActivity();
			if (ownsActivity) activity.stop();
		},
	};
}
