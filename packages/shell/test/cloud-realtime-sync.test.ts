import { describe, expect, it, vi } from "vitest";
import {
	CloudProfileRealtimeSync,
	type CloudRealtimeChange,
	type CloudRealtimeHealth,
	type CloudRealtimeSubscription,
	type CloudRealtimeTransport,
	cloudProfileRealtimeFilters,
} from "../src/cloud-realtime-sync.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";

class FakeRealtimeTransport implements CloudRealtimeTransport {
	profileId?: string;
	onChange?: (change: CloudRealtimeChange) => void;
	onHealth?: (health: CloudRealtimeHealth) => void;
	readonly stop = vi.fn(async () => {});

	subscribe(
		requestedProfileId: string,
		onChange: (change: CloudRealtimeChange) => void,
		onHealth: (health: CloudRealtimeHealth) => void,
	): CloudRealtimeSubscription {
		this.profileId = requestedProfileId;
		this.onChange = onChange;
		this.onHealth = onHealth;
		return { stop: this.stop };
	}
}

describe("cloud profile realtime synchronization", () => {
	it("subscribes only to lightweight profile-scoped invalidation rows", () => {
		expect(cloudProfileRealtimeFilters(profileId)).toEqual([
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
		]);
		expect(() => cloudProfileRealtimeFilters("not-a-profile")).toThrow("UUID");
	});

	it("wakes durable channels while connected and removes the subscription on stop", async () => {
		const transport = new FakeRealtimeTransport();
		const changes: CloudRealtimeChange[] = [];
		const health: CloudRealtimeHealth[] = [];
		const realtime = new CloudProfileRealtimeSync({
			profileId,
			transport,
			onChange: (change) => changes.push(change),
			onHealth: (current) => health.push(current),
		});

		realtime.start();
		realtime.start();
		expect(transport.profileId).toBe(profileId);
		expect(health).toEqual([{ phase: "connecting" }]);
		transport.onHealth?.({ phase: "connected" });
		transport.onChange?.({ resource: "trail" });
		transport.onChange?.({ resource: "staff" });
		transport.onChange?.({ resource: "access", subjectUserId: "c98d600e-654a-40da-a07f-f1d54f93cc6c" });
		transport.onChange?.({ resource: "company-file" });
		expect(realtime.health()).toEqual({ phase: "connected" });
		expect(changes).toEqual([
			{ resource: "trail" },
			{ resource: "staff" },
			{ resource: "access", subjectUserId: "c98d600e-654a-40da-a07f-f1d54f93cc6c" },
			{ resource: "company-file" },
		]);

		await realtime.stop();
		expect(transport.stop).toHaveBeenCalledOnce();
		expect(realtime.health()).toEqual({ phase: "stopped" });
		transport.onChange?.({ resource: "trail" });
		expect(changes).toEqual([
			{ resource: "trail" },
			{ resource: "staff" },
			{ resource: "access", subjectUserId: "c98d600e-654a-40da-a07f-f1d54f93cc6c" },
			{ resource: "company-file" },
		]);
	});
});
