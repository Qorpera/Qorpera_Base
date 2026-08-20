import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseCloudPresenceTransport } from "../src/cloud-presence.ts";
import type { HostedPrimaryDatabase, QorperaHostedPrimary } from "../src/hosted-primary.ts";

type ChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

class FakeChannel {
	readonly sent: Array<Record<string, unknown>> = [];
	readonly tracked: Array<Record<string, unknown>> = [];
	state: Record<string, Array<{ staff_agent_id?: unknown }>> = {};
	#status?: (status: ChannelStatus, error?: Error) => void;
	#presence?: () => void;
	readonly #broadcasts = new Map<string, (value: { payload: unknown }) => void>();

	on(kind: string, filter: { event?: string }, callback: (value: { payload: unknown }) => void): this {
		if (kind === "presence") this.#presence = callback as () => void;
		else if (kind === "broadcast" && filter.event) this.#broadcasts.set(filter.event, callback);
		return this;
	}

	subscribe(callback: (status: ChannelStatus, error?: Error) => void): this {
		this.#status = callback;
		return this;
	}

	presenceState(): typeof this.state {
		return this.state;
	}

	track(value: Record<string, unknown>): Promise<"ok"> {
		this.tracked.push(value);
		return Promise.resolve("ok");
	}

	send(value: Record<string, unknown>): Promise<"ok"> {
		this.sent.push(value);
		return Promise.resolve("ok");
	}

	emitStatus(status: ChannelStatus, error?: Error): void {
		this.#status?.(status, error);
	}

	emitPresence(): void {
		this.#presence?.();
	}

	emitBroadcast(event: string, payload: unknown): void {
		this.#broadcasts.get(event)?.({ payload });
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("cloud presence", () => {
	it("clears stale members, reconnects a closed channel, and carries agent activity", async () => {
		vi.useFakeTimers();
		const channels: FakeChannel[] = [];
		const removed: FakeChannel[] = [];
		const client = {
			channel: () => {
				const channel = new FakeChannel();
				channels.push(channel);
				return channel as unknown as RealtimeChannel;
			},
			removeChannel: (channel: RealtimeChannel) => {
				removed.push(channel as unknown as FakeChannel);
				return Promise.resolve("ok");
			},
		} as unknown as SupabaseClient<HostedPrimaryDatabase>;
		const members: Array<Array<{ clientId: string; userId: string }>> = [];
		const activities: string[] = [];
		const health: string[] = [];
		const remoteOwner = "10000000-0000-4000-8000-000000000001";
		const remoteTeammate = "10000000-0000-4000-8000-000000000002";
		const registerPresenceDevice = vi.fn(async (_profileId: string, clientId: string) => ({
			clientId,
			userId: "owner",
			name: "Owner",
		}));
		const listPresenceDevices = vi.fn(async (_profileId: string, clientIds: string[]) =>
			clientIds.flatMap((clientId) => {
				if (clientId === remoteOwner) return [{ clientId, userId: "owner", name: "Owner" }];
				if (clientId === remoteTeammate) return [{ clientId, userId: "teammate", name: "Teammate" }];
				return [];
			}),
		);
		const unregisterPresenceDevice = vi.fn(async () => undefined);
		const primary = {
			registerPresenceDevice,
			listPresenceDevices,
			unregisterPresenceDevice,
		} as unknown as QorperaHostedPrimary;
		const handle = new SupabaseCloudPresenceTransport(client, primary).join(
			"9ec79fc8-a1a7-4eb6-a764-4bc704d4103f",
			(value) => members.push(value),
			() => undefined,
			(event) => activities.push(`${event.staffAgentId}:${event.activity}`),
			(value) => health.push(value.phase),
		);

		await vi.waitFor(() => expect(channels).toHaveLength(1));
		channels[0].emitStatus("SUBSCRIBED");
		handle.setOpenThread("legal-agent");
		handle.sendActivity("legal-agent", "working");
		expect(channels[0].tracked.at(-1)).toEqual({ staff_agent_id: "legal-agent" });
		expect(channels[0].sent.at(-1)).toMatchObject({ event: "agent_activity" });
		const sentPayload = channels[0].sent.at(-1)?.payload as { client_id?: unknown };
		expect(typeof sentPayload.client_id).toBe("string");
		channels[0].state = {
			[String(sentPayload.client_id)]: [{ staff_agent_id: "legal-agent" }],
			[remoteOwner]: [{ staff_agent_id: "legal-agent" }],
			[remoteTeammate]: [{ staff_agent_id: "legal-agent" }],
		};
		channels[0].emitPresence();
		await vi.waitFor(() =>
			expect(members.at(-1)).toMatchObject([
				{ clientId: remoteOwner, userId: "owner" },
				{ clientId: remoteTeammate, userId: "teammate" },
			]),
		);

		channels[0].emitStatus("CLOSED");
		expect(members.at(-1)).toEqual([]);
		expect(health.at(-1)).toBe("degraded");
		await vi.advanceTimersByTimeAsync(1_000);
		await Promise.resolve();
		expect(channels).toHaveLength(2);
		expect(removed).toContain(channels[0]);
		channels[1].emitStatus("SUBSCRIBED");
		expect(channels[1].tracked.at(-1)).toMatchObject({ staff_agent_id: "legal-agent" });
		channels[1].emitBroadcast("agent_activity", {
			client_id: sentPayload.client_id,
			user_id: "spoofed",
			name: "Spoofed",
			staff_agent_id: "legal-agent",
			activity: "working",
		});
		channels[1].emitBroadcast("agent_activity", {
			client_id: remoteOwner,
			user_id: "spoofed",
			name: "Spoofed",
			staff_agent_id: "legal-agent",
			activity: "working",
		});
		channels[1].emitBroadcast("agent_activity", {
			client_id: remoteTeammate,
			user_id: "spoofed",
			name: "Spoofed",
			staff_agent_id: "legal-agent",
			activity: "writing",
		});
		await vi.waitFor(() => expect(activities).toEqual(["legal-agent:working", "legal-agent:writing"]));

		await handle.stop();
		expect(unregisterPresenceDevice).toHaveBeenCalledOnce();
		expect(health.at(-1)).toBe("stopped");
	});
});
