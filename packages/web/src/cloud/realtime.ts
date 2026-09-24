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

const FILTERS: { resource: RealtimeResource; table: string }[] = [
	{ resource: "sessions", table: "qorpera_shared_sessions" },
	{ resource: "staff", table: "qorpera_profile_staff" },
	{ resource: "access", table: "qorpera_profile_access_state" },
	{ resource: "company-file", table: "qorpera_company_files" },
];

export function subscribeProfileRealtime(
	cloud: Cloud,
	profileId: string,
	onChange: (resource: RealtimeResource) => void,
	onHealth: (phase: RealtimePhase, error?: string) => void,
): RealtimeSubscription {
	// Supabase reuses channels by topic, including ones still unsubscribing.
	// Each subscription owns its channel so stopping it cannot close another.
	let channel: RealtimeChannel = cloud.supabase.channel(`qorpera-profile-${profileId}-${crypto.randomUUID()}`);
	for (const { resource, table } of FILTERS) {
		channel = channel.on(
			"postgres_changes",
			{ event: "*", schema: "public", table, filter: `profile_id=eq.${profileId}` },
			() => onChange(resource),
		);
	}
	onHealth("connecting");
	channel.subscribe((status, error) => {
		if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) onHealth("connected");
		else if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
			onHealth("degraded", error instanceof Error ? error.message : status);
		} else if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) onHealth("stopped");
	});
	return {
		stop() {
			void cloud.supabase.removeChannel(channel);
			onHealth("stopped");
		},
	};
}

/** The company sidebar's revision row: one hint per change, however many rows it
 * moved. A separate channel: a cloud that has no sidebar tables yet fails only this
 * one, and the rail's poll still reads the sidebar. Its health is not the company's
 * live-updates badge. */
export function subscribeSidebarRealtime(cloud: Cloud, profileId: string, onChange: () => void): RealtimeSubscription {
	const channel: RealtimeChannel = cloud.supabase
		.channel(`qorpera-sidebar-${profileId}-${crypto.randomUUID()}`)
		.on(
			"postgres_changes",
			{
				event: "*",
				schema: "public",
				table: "qorpera_company_sidebar_revisions",
				filter: `profile_id=eq.${profileId}`,
			},
			onChange,
		);
	channel.subscribe();
	return {
		stop() {
			void cloud.supabase.removeChannel(channel);
		},
	};
}
