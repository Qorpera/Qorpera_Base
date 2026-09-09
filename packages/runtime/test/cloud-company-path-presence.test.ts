import { createHash } from "node:crypto";
import type { CompanyPresenceIdentity } from "@qorpera/cloud-client/company-path-presence";
import { PresenceSignatures } from "@qorpera/cloud-client/presence-signatures";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "../src/cloud-company-path-gateway.ts";
import { CloudNativeCompanyPresence } from "../src/cloud-company-path-presence.ts";
import type { CloudNativeToolBinding } from "../src/cloud-native-tool-authority.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
function fixture() {
	const first = nativeToolAuthorityFixture(),
		secondSource = nativeToolAuthorityFixture();
	const second = {
		...secondSource,
		authority: {
			...secondSource.authority,
			identity: {
				...secondSource.authority.identity,
				companyId: first.authority.identity.companyId,
				environmentId: first.authority.identity.environmentId,
			},
		},
	};
	const identities = [first, second];
	const registrations = new Map<string, CompanyPresenceIdentity>();
	const channels: Channel[] = [];
	const hidden = new Set<string>();
	const revoked = new Set<string>();
	const scope = (paths: string[]) =>
		paths.map((path) => {
			const parts = path ? path.split("/") : [];
			const prefixes = Array.from({ length: parts.length + 1 }, (_, index) => parts.slice(0, index).join("/"));
			return {
				path,
				routes: prefixes.map((prefix) => ({
					path: prefix,
					token: createHash("sha256").update(`fixture:${prefix}`).digest("hex"),
				})),
			};
		});
	const call = vi.fn(
		async (method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
			signal.throwIfAborted();
			const binding = args.p_binding as CloudNativeToolBinding | undefined;
			if (method === "qorpera_native_presence_forget") {
				registrations.delete(args.p_client_id as string);
				return null;
			}
			if (method === "qorpera_native_presence_subject") {
				const identity = registrations.get(args.p_client_id as string);
				return !identity || revoked.has(identity.runId)
					? null
					: {
							schema: "qorpera.native-presence-subject/v1",
							identity: { ...identity },
							paths: scope(args.p_paths as string[]),
						};
			}
			const source = identities.find((item) => item.binding.runId === binding?.runId)!;
			if (!source || revoked.has(source.binding.runId)) throw new Error("fixture authority denied");
			if (method === "qorpera_native_presence_register") {
				const value: CompanyPresenceIdentity = {
					schema: "qorpera.native-presence-identity/v1",
					companyId: source.authority.identity.companyId,
					environmentId: source.authority.identity.environmentId,
					clientId: args.p_client_id as string,
					publicKey: args.p_public_key as string,
					runId: source.binding.runId,
					staffAgentId: source.authority.identity.staffAgentId,
					expiresAt: Date.now() + 30000,
				};
				registrations.set(value.clientId, value);
				return value;
			}
			if (method === "qorpera_company_presence_scope") {
				if (hidden.has(source.binding.runId)) throw new Error("fixture path denied");
				return {
					schema: "qorpera.company-presence-scope/v1",
					companyId: source.authority.identity.companyId,
					environmentId: source.authority.identity.environmentId,
					paths: scope(args.p_paths as string[]),
				};
			}
			throw new Error(`Unexpected fixture RPC: ${method}`);
		},
	);
	const control: CloudCompanyPathControl = { call };
	class Channel {
		readonly id: string;
		readonly topic: string;
		readonly private: boolean;
		data: Record<string, unknown> | undefined;
		removed = false;
		status: (value: "SUBSCRIBED" | "CLOSED") => void = () => {};
		listener: () => void = () => {};
		constructor(topic: string, options: { config: { private: boolean; presence: { key: string } } }) {
			this.id = options.config.presence.key;
			this.topic = topic;
			this.private = options.config.private;
		}
		on(_kind: string, _filter: unknown, listener: () => void) {
			this.listener = listener;
			return this;
		}
		subscribe(status: Channel["status"]) {
			this.status = status;
			queueMicrotask(() => status("SUBSCRIBED"));
			return this;
		}
		presenceState() {
			return Object.fromEntries(
				channels
					.filter((c) => !c.removed && c.data)
					.map((c) => [c.id, [{ ...c.data, presence_ref: "transport-only" }]]),
			);
		}
		async track(data: Record<string, unknown>) {
			this.data = data;
			for (const c of channels) if (!c.removed) c.listener();
			return "ok";
		}
	}
	const client = {
		channel: (topic: string, options: ConstructorParameters<typeof Channel>[1]) => {
			const c = new Channel(topic, options);
			const run = registrations.get(c.id)!.runId;
			channels[identities.findIndex((item) => item.binding.runId === run)] = c;
			return c as unknown as RealtimeChannel;
		},
		removeChannel: async (value: RealtimeChannel) => {
			(value as unknown as Channel).removed = true;
			for (const c of channels) if (!c.removed) c.listener();
			return "ok" as const;
		},
	} as Pick<SupabaseClient, "channel" | "removeChannel">;
	const controller = new AbortController();
	const agents = identities.map(
		(source) =>
			new CloudNativeCompanyPresence({
				binding: source.binding,
				identity: source.authority.identity,
				control,
				client,
				signal: controller.signal,
			}),
	);
	const signal = new AbortController().signal;
	const publish = async (
		index: number,
		path: string,
		extent: "object" | "subtree" = "object",
		activity: "reading" | "writing" = "reading",
	) => {
		await agents[index].observe(path, extent, activity, signal);
		await vi.waitFor(() => expect(channels.filter(Boolean)).toHaveLength(2));
		await vi.waitFor(() =>
			expect((channels[index]?.data?.routes as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0),
		);
	};
	return {
		identities,
		agents,
		channels,
		call,
		registrations,
		hidden,
		revoked,
		signal,
		publish,
		close: () => Promise.all(agents.map((agent) => agent.close())),
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("native Company File presence", () => {
	it("authenticates signed overlap across two independent native run clients without exposing path tokens to the model", async () => {
		const f = fixture();
		try {
			await f.publish(1, "projects/report.md", "object", "writing");
			const view = await f.agents[0].observe("projects/report.md", "object", "reading", f.signal);
			expect(view).toMatchObject({
				state: "available",
				paths: [
					{
						path: "projects/report.md",
						participants: [
							{
								runId: f.identities[1].binding.runId,
								staffAgentId: f.identities[1].authority.identity.staffAgentId,
								activity: "writing",
								overlap: "same_object",
							},
						],
					},
				],
			});
			expect(
				f.channels.every(
					(c) => c.private && c.topic === `qorpera-presence-${f.identities[0].authority.identity.companyId}`,
				),
			).toBe(true);
			expect(JSON.stringify(f.channels[1].data)).not.toContain("projects/report.md");
			expect(JSON.stringify(f.channels[1].data)).not.toContain(f.identities[1].binding.leaseId);
			expect(JSON.stringify(view)).not.toContain("token");
			expect(JSON.stringify(view)).not.toContain("publicKey");
		} finally {
			await f.close();
		}
		expect(f.registrations.size).toBe(0);
		expect(f.channels.every((c) => c.removed)).toBe(true);
	});
	it("distinguishes siblings from work within a subtree and work on an ancestor subtree", async () => {
		const f = fixture();
		try {
			await f.publish(1, "projects/a.md");
			expect(
				(await f.agents[0].observe("projects/b.md", "object", "reading", f.signal)).paths[0].participants,
			).toEqual([]);
			expect((await f.agents[0].observe("projects", "subtree", "reading", f.signal)).paths[0].participants).toEqual([
				expect.objectContaining({ overlap: "within_subtree" }),
			]);
			await f.publish(1, "projects", "subtree", "writing");
			expect(
				(await f.agents[0].observe("projects/b.md", "object", "reading", f.signal)).paths[0].participants,
			).toEqual([expect.objectContaining({ overlap: "ancestor_subtree", activity: "writing" })]);
		} finally {
			await f.close();
		}
	});
	it("does not release forged, expired or revoked publisher state", async () => {
		const f = fixture();
		try {
			await f.publish(1, "note.md");
			const good = structuredClone(f.channels[1].data!);
			f.channels[1].data!.signature = `${"A".repeat(86)}==`;
			f.channels[0].listener();
			expect((await f.agents[0].observe("note.md", "object", "reading", f.signal)).paths[0].participants).toEqual(
				[],
			);
			f.channels[1].data = good;
			f.channels[0].listener();
			f.revoked.add(f.identities[1].binding.runId);
			expect((await f.agents[0].observe("note.md", "object", "reading", f.signal)).paths[0].participants).toEqual(
				[],
			);
			f.revoked.clear();
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + 31000);
			expect((await f.agents[0].observe("note.md", "object", "reading", f.signal)).paths[0].participants).toEqual(
				[],
			);
		} finally {
			await f.close();
		}
	});
	it("does not revive an old signed path claim when a newer statement moved elsewhere", async () => {
		const f = fixture();
		try {
			await f.publish(1, "projects/a.md");
			const old = structuredClone(f.channels[1].data!);
			await f.publish(1, "projects/b.md");
			const current = structuredClone(f.channels[1].data!);
			expect(current.sequence).toBeGreaterThan(old.sequence as number);
			vi.spyOn(f.channels[0], "presenceState").mockReturnValue({
				[f.channels[1].id]: [
					{ ...old, presence_ref: "old-replay" },
					{ ...current, presence_ref: "current" },
				],
			});
			f.channels[0].listener();
			expect(
				(await f.agents[0].observe("projects/a.md", "object", "reading", f.signal)).paths[0].participants,
			).toEqual([]);
		} finally {
			await f.close();
		}
	});
	it("rechecks receiver path grants after publisher verification", async () => {
		const f = fixture();
		const gate = deferred<boolean>();
		try {
			await f.publish(1, "note.md");
			const verifying = vi.spyOn(PresenceSignatures, "verify").mockReturnValueOnce(gate.promise);
			const pending = f.agents[0].observe("note.md", "object", "reading", f.signal);
			await vi.waitFor(() => expect(verifying).toHaveBeenCalled());
			f.hidden.add(f.identities[0].binding.runId);
			gate.resolve(true);
			const value = await pending;
			expect(value.state).toBe("unavailable");
			expect(value.paths[0].participants).toEqual([]);
		} finally {
			gate.resolve(false);
			await f.close();
		}
	});
	it("cannot restore presence after stop while verification is pending", async () => {
		const f = fixture();
		const gate = deferred<boolean>();
		try {
			await f.publish(1, "note.md");
			const verifying = vi.spyOn(PresenceSignatures, "verify").mockReturnValueOnce(gate.promise);
			const pending = f.agents[0].observe("note.md", "object", "reading", f.signal);
			await vi.waitFor(() => expect(verifying).toHaveBeenCalled());
			await f.agents[0].close();
			gate.resolve(true);
			expect(await pending).toMatchObject({ state: "unavailable", paths: [{ participants: [] }] });
		} finally {
			gate.resolve(false);
			await f.close();
		}
	});
	it.each(["error", "timed out"])("treats a %s publish acknowledgement as unavailable", async (status) => {
		const f = fixture();
		try {
			await f.publish(0, "note.md");
			const channel = f.channels[0];
			vi.spyOn(channel, "track").mockResolvedValue(status);
			await expect(f.agents[0].observe("note.md", "object", "writing", f.signal)).resolves.toMatchObject({
				state: "unavailable",
				paths: [{ participants: [] }],
			});
			expect(channel.removed).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("clears a disconnected channel and fails lossy path observation without failing the run", async () => {
		const f = fixture();
		try {
			await f.publish(1, "note.md");
			f.channels[0].status("CLOSED");
			f.revoked.add(f.identities[0].binding.runId);
			await expect(f.agents[0].observe("note.md", "object", "reading", f.signal)).resolves.toMatchObject({
				state: "unavailable",
				paths: [{ participants: [] }],
			});
			await expect(f.agents[0].observe("../private", "object", "reading", f.signal)).resolves.toMatchObject({
				state: "unavailable",
			});
		} finally {
			await f.close();
		}
	});
});
