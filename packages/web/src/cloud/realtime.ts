import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import type { Cloud } from "./client.ts";

/* Durable-lane invalidation hints (CLIENT-CONTRACT.md §3, SESSIONS.md). The
 * channel carries no bodies; every hint makes the client re-read through RPCs.
 * Polling remains the recovery path when Realtime is degraded. */

export type RealtimeResource = "sessions" | "staff" | "access" | "company-file" | "sidebar";
export type RealtimePhase = "connecting" | "connected" | "degraded" | "stopped";

export interface RealtimeSubscription {
	stop(): void;
}

/** A channel's health. `recovered`: this subscription replaces a channel that failed, so hints may have been missed,
 * also when the failure was never reported (it came while the page was hidden, and the grace covered it). */
export type RealtimeHealth = (phase: RealtimePhase, error?: string, recovered?: boolean) => void;

const FILTERS: { resource: RealtimeResource; table: string }[] = [
	{ resource: "sessions", table: "qorpera_shared_sessions" },
	{ resource: "staff", table: "qorpera_profile_staff" },
	{ resource: "access", table: "qorpera_profile_access_state" },
	{ resource: "company-file", table: "qorpera_company_files" },
];

/** The wait before each new try after a channel fails: 1 s, 2 s, 5 s, 10 s, then every 30 s. */
export const RESUBSCRIBE_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** How long a channel that failed while the page was hidden (or frozen) has to subscribe again once the page is back,
 * before it counts as degraded. A tab Chrome froze sends no heartbeats, so Realtime drops its socket; on return the
 * channel reports "transport failure" for the second it takes to come back (3 Nov 2026: the badge flashed). */
export const RESUME_GRACE_MS = 5_000;

function pageHidden(): boolean {
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Keeps one channel subscribed. When Realtime restarts or drops an idle connection the channel
 * can fail for good (CHANNEL_ERROR "transport failure", TIMED_OUT, or CLOSED by the server), and
 * only a new tab used to recover. Here a failed channel is replaced by a fresh one after the next
 * of RESUBSCRIBE_DELAYS_MS, with Realtime's token refreshed first (it may have expired while the
 * connection was down); while the socket itself is down, a try reopens it and waits again instead.
 * A subscription resets the waits; the window regaining focus or the browser coming back online
 * tries at once. `open` makes a new channel each time (its own topic).
 *
 * A failure while the page is hidden or frozen is not reported: when the page is back it tries at once, and says
 * degraded only if the channel has not subscribed again within RESUME_GRACE_MS. The same grace covers a failure that
 * arrives just after the page came back (the closed socket's news, held while the tab was frozen).
 */
function keepSubscribed(cloud: Cloud, open: () => RealtimeChannel, onHealth: RealtimeHealth): RealtimeSubscription {
	let channel: RealtimeChannel | undefined;
	/** The current channel failed and has not been replaced yet. */
	let failed = false;
	/** The current channel is subscribed. */
	let subscribed = false;
	/** A channel failed since the last subscription, reported or held: hints may have been missed meanwhile. */
	let missed = false;
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let renewing = false;
	let stopped = false;
	const listening = new AbortController();
	/** Until then a failure waits for the grace instead of showing (the page came back just now). */
	let quietUntil = 0;
	/** A failure not reported yet: shown when the grace ends if the channel still is not subscribed. */
	let unreported: string | undefined;
	let grace: ReturnType<typeof setTimeout> | undefined;

	const report = (error: string): void => {
		if (!pageHidden() && Date.now() >= quietUntil) {
			unreported = undefined;
			onHealth("degraded", error);
			return;
		}
		unreported = error;
		// While hidden the grace starts when the page is back (resumed).
		if (!pageHidden()) holdReport(quietUntil - Date.now());
	};
	const holdReport = (wait: number): void => {
		clearTimeout(grace);
		grace = setTimeout(
			() => {
				grace = undefined;
				// Hidden again before the grace ended: still held, until the page is back.
				if (stopped || subscribed || unreported === undefined || pageHidden()) return;
				const error = unreported;
				unreported = undefined;
				onHealth("degraded", error);
			},
			Math.max(0, wait),
		);
	};
	const resumed = (): void => {
		if (stopped || pageHidden()) return;
		quietUntil = Date.now() + RESUME_GRACE_MS;
		if (unreported !== undefined) holdReport(RESUME_GRACE_MS);
		tryNow();
	};

	const subscribe = (): void => {
		const current = open();
		channel = current;
		failed = false;
		subscribed = false;
		current.subscribe((status, error) => {
			if (stopped || current !== channel) return;
			if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
				failed = false;
				subscribed = true;
				failures = 0;
				clearTimeout(timer);
				timer = undefined;
				clearTimeout(grace);
				grace = undefined;
				unreported = undefined;
				const recovered = missed;
				missed = false;
				onHealth("connected", undefined, recovered);
			} else if (
				status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
				status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
				status === REALTIME_SUBSCRIBE_STATES.CLOSED
			) {
				failed = true;
				subscribed = false;
				missed = true;
				report(error instanceof Error ? error.message : status);
				schedule();
			}
		});
	};

	const schedule = (): void => {
		if (stopped || renewing || timer !== undefined) return;
		const delay = RESUBSCRIBE_DELAYS_MS[Math.min(failures, RESUBSCRIBE_DELAYS_MS.length - 1)];
		failures++;
		timer = setTimeout(() => {
			timer = undefined;
			void renew();
		}, delay);
	};

	const renew = async (): Promise<void> => {
		if (stopped || renewing) return;
		const realtime = cloud.supabase.realtime;
		if (realtime && !realtime.isConnected() && channel && channel.state !== "closed") {
			// While the socket is down a new channel's join (and the old one's leave) would only wait in the client's
			// send buffer and all go out at once on reconnect. Bring the socket back instead: the SDK rejoins a failed
			// channel when it opens. A closed channel has no rejoin, so it is replaced even then.
			try {
				realtime.connect();
			} catch {
				// No socket to open (no WebSocket here): the next wait tries again.
			}
			schedule();
			return;
		}
		renewing = true;
		// The failed channel's late answers no longer count.
		const old = channel;
		channel = undefined;
		try {
			// No argument: Realtime asks Auth for the session's current token (refreshed if it expired).
			await cloud.supabase.realtime?.setAuth();
		} catch {
			// The join itself says whether the token still works.
		}
		renewing = false;
		if (!stopped) subscribe();
		// Removed once the new channel exists, so the client never goes without a channel.
		if (old) void cloud.supabase.removeChannel(old).catch(() => {});
	};

	const tryNow = (): void => {
		if (stopped || renewing || !failed) return;
		clearTimeout(timer);
		timer = undefined;
		void renew();
	};
	if (typeof window !== "undefined") {
		window.addEventListener("focus", tryNow, { signal: listening.signal });
		window.addEventListener("online", tryNow, { signal: listening.signal });
		window.addEventListener("pageshow", resumed, { signal: listening.signal });
	}
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", resumed, { signal: listening.signal });
		// Chrome's frozen tab: `resume` comes before it is shown again.
		document.addEventListener("resume", resumed, { signal: listening.signal });
	}

	onHealth("connecting");
	subscribe();
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			timer = undefined;
			clearTimeout(grace);
			grace = undefined;
			listening.abort();
			if (channel) void cloud.supabase.removeChannel(channel);
			channel = undefined;
			onHealth("stopped");
		},
	};
}

export function subscribeProfileRealtime(
	cloud: Cloud,
	profileId: string,
	onChange: (resource: RealtimeResource) => void,
	onHealth: RealtimeHealth,
): RealtimeSubscription {
	return keepSubscribed(
		cloud,
		() => {
			// Supabase reuses channels by topic, including ones still unsubscribing.
			// Each channel gets its own topic so removing one cannot close another.
			let channel: RealtimeChannel = cloud.supabase.channel(`qorpera-profile-${profileId}-${crypto.randomUUID()}`);
			for (const { resource, table } of FILTERS) {
				channel = channel.on(
					"postgres_changes",
					{ event: "*", schema: "public", table, filter: `profile_id=eq.${profileId}` },
					() => onChange(resource),
				);
			}
			return channel;
		},
		onHealth,
	);
}

/** The company sidebar's revision row: one hint per change, however many rows it
 * moved. A separate channel: a cloud that has no sidebar tables yet fails only this
 * one, and the rail's poll still reads the sidebar. Its health is not the company's
 * live-updates badge, but it resubscribes the same way. */
export function subscribeSidebarRealtime(cloud: Cloud, profileId: string, onChange: () => void): RealtimeSubscription {
	return keepSubscribed(
		cloud,
		() =>
			cloud.supabase.channel(`qorpera-sidebar-${profileId}-${crypto.randomUUID()}`).on(
				"postgres_changes",
				{
					event: "*",
					schema: "public",
					table: "qorpera_company_sidebar_revisions",
					filter: `profile_id=eq.${profileId}`,
				},
				onChange,
			),
		() => {},
	);
}
