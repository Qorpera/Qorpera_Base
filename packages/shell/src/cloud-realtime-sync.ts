import type { HostedPrimaryDatabase } from "@qorpera/cloud-client/hosted-primary";
import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CloudRealtimeResource = "access" | "staff" | "trail" | "company-file";
export type CloudRealtimePhase = "idle" | "connecting" | "connected" | "degraded" | "stopped";

export interface CloudRealtimeHealth {
	phase: CloudRealtimePhase;
	error?: string;
}

export interface CloudRealtimeChange {
	resource: CloudRealtimeResource;
	subjectUserId?: string;
}

export interface CloudRealtimeFilter {
	resource: CloudRealtimeResource;
	event: "*";
	schema: "public";
	table:
		| "qorpera_company_files"
		| "qorpera_profile_access_state"
		| "qorpera_profile_staff"
		| "qorpera_shared_sessions";
	filter: string;
}

export interface CloudRealtimeSubscription {
	stop(): Promise<void>;
}

export interface CloudRealtimeTransport {
	subscribe(
		profileId: string,
		onChange: (change: CloudRealtimeChange) => void,
		onHealth: (health: CloudRealtimeHealth) => void,
	): CloudRealtimeSubscription;
}

export interface CloudProfileRealtimeSyncOptions {
	profileId: string;
	transport: CloudRealtimeTransport;
	onChange: (change: CloudRealtimeChange) => void;
	onHealth?: (health: CloudRealtimeHealth) => void;
}

function requiredProfileId(profileId: string): void {
	if (!UUID_PATTERN.test(profileId)) throw new Error("Profile id must be a UUID");
}

export function cloudProfileRealtimeFilters(profileId: string): CloudRealtimeFilter[] {
	requiredProfileId(profileId);
	return [
		{
			resource: "trail",
			event: "*",
			schema: "public",
			table: "qorpera_shared_sessions",
			filter: `profile_id=eq.${profileId}`,
		},
		{
			resource: "staff",
			event: "*",
			schema: "public",
			table: "qorpera_profile_staff",
			filter: `profile_id=eq.${profileId}`,
		},
		{
			resource: "access",
			event: "*",
			schema: "public",
			table: "qorpera_profile_access_state",
			filter: `profile_id=eq.${profileId}`,
		},
		{
			resource: "company-file",
			event: "*",
			schema: "public",
			table: "qorpera_company_files",
			filter: `profile_id=eq.${profileId}`,
		},
	];
}

export class SupabaseCloudRealtimeTransport implements CloudRealtimeTransport {
	readonly #client: SupabaseClient<HostedPrimaryDatabase>;

	constructor(client: SupabaseClient<HostedPrimaryDatabase>) {
		this.#client = client;
	}

	subscribe(
		profileId: string,
		onChange: (change: CloudRealtimeChange) => void,
		onHealth: (health: CloudRealtimeHealth) => void,
	): CloudRealtimeSubscription {
		let channel: RealtimeChannel = this.#client.channel(`qorpera-profile-${profileId}`);
		for (const { resource, ...filter } of cloudProfileRealtimeFilters(profileId)) {
			channel = channel.on<Record<string, unknown>>("postgres_changes", filter, (payload) => {
				const record: Record<string, unknown> =
					payload.new && typeof payload.new === "object"
						? (payload.new as Record<string, unknown>)
						: (payload.old as Record<string, unknown>);
				const subjectUserId =
					resource === "access" && typeof record.user_id === "string" ? record.user_id : undefined;
				onChange({ resource, ...(subjectUserId && UUID_PATTERN.test(subjectUserId) ? { subjectUserId } : {}) });
			});
		}
		channel.subscribe((status, error) => {
			if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
				onHealth({ phase: "connected" });
				return;
			}
			if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
				onHealth({
					phase: "degraded",
					error:
						error?.message ??
						(status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ? "Realtime timed out" : "Realtime channel failed"),
				});
				return;
			}
			if (status === REALTIME_SUBSCRIBE_STATES.CLOSED)
				onHealth({ phase: "degraded", error: "Realtime channel closed" });
		});
		return {
			stop: async () => {
				await this.#client.removeChannel(channel);
			},
		};
	}
}

export class CloudProfileRealtimeSync {
	readonly #options: CloudProfileRealtimeSyncOptions;
	#subscription?: CloudRealtimeSubscription;
	#health: CloudRealtimeHealth = { phase: "idle" };
	#started = false;

	constructor(options: CloudProfileRealtimeSyncOptions) {
		requiredProfileId(options.profileId);
		this.#options = options;
	}

	health(): CloudRealtimeHealth {
		return { ...this.#health };
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#setHealth({ phase: "connecting" });
		try {
			this.#subscription = this.#options.transport.subscribe(
				this.#options.profileId,
				(change) => {
					if (this.#started) this.#options.onChange(change);
				},
				(health) => {
					if (this.#started) this.#setHealth(health);
				},
			);
		} catch (error) {
			this.#setHealth({
				phase: "degraded",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async stop(): Promise<void> {
		if (!this.#started && this.#health.phase === "stopped") return;
		this.#started = false;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		if (subscription) await subscription.stop();
		this.#setHealth({ phase: "stopped" });
	}

	#setHealth(health: CloudRealtimeHealth): void {
		this.#health = health;
		this.#options.onHealth?.(this.health());
	}
}
