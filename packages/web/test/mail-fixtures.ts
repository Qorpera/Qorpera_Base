import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { type Mock, vi } from "vitest";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { type fixture, id, session, staff, userA } from "./fixtures.ts";

/* The member mail read (cloud/mail.ts) as a fake of its five calls on the fixture's cloud, with the agents and the
 * address the Mailbox tests use (test/interface-mail.test.ts, test/mailbox.test.ts). */

export const cofounder: HostedStaffAgent = {
	...staff,
	id: id(40),
	displayName: "Co-Founder",
	templateId: "co-founder",
};
export const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
export const bo: HostedStaffAgent = { ...staff, id: id(42), displayName: "Bo" };

/** A thread id: 43 characters, as the cloud gives them. */
export const thread = (n: number) => `thread-${String(n).padStart(36, "0")}`;
/** `n` minutes before nine, so a smaller `n` is newer. */
export const at = (n: number) => new Date(Date.parse("2026-10-06T09:00:00Z") - n * 60_000).toISOString();
/** `days` days before now, as the cloud writes a time: to the microsecond, with an offset. */
export const cloudTime = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".123456+00:00");

export const ADDRESS = {
	address: "hello@acme.example",
	status: "active",
	handledBy: [{ staffAgentId: ada.id, name: "Ada" }],
	routines: [{ routineId: id(801), title: "Morning mail", staffAgentId: ada.id }],
	last7Days: 12,
};

/** A thread as the threads call lists it. */
export function summary(n: number, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		thread: thread(n),
		address: ADDRESS.address,
		fromName: `Sender ${n}`,
		fromAddress: `sender${n}@outside.example`,
		subject: `Subject ${n}`,
		lastAt: at(n),
		state: "new",
		handledBy: { staffAgentId: ada.id, name: "Ada" },
		direction: "received",
		unread: false,
		messages: 1,
		...more,
	};
}

/** A received message as the thread call gives it. */
export function received(n: number, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "received",
		deliveryId: `delivery-${n}`,
		fromName: `Sender ${n}`,
		fromAddress: `sender${n}@outside.example`,
		to: [ADDRESS.address],
		subject: `Subject ${n}`,
		text: `Hello from sender ${n}.`,
		receivedAt: at(n),
		attachments: [],
		...more,
	};
}

/** A send that waits for a person, in a thread. */
export function waitingSend(reviewId: string, more: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		reviewId,
		sessionId: session.sessionId,
		staffAgent: { staffAgentId: ada.id, name: "Ada" },
		to: ["sender1@outside.example"],
		subject: "Re: Subject 1",
		text: "Paid today.",
		attachments: [],
		createdAt: at(0),
		...more,
	};
}

export interface MailFake {
	addresses: Record<string, unknown>[];
	waiting: Record<string, unknown>[];
	/** Newest first. */
	threads: Record<string, unknown>[];
	/** What the thread call answers, by thread id (an older page by `<thread> before <id>`); a thread not here has one
	 * message. */
	reads: Record<string, Record<string, unknown>>;
	/** Threads the call refuses with 22023. */
	gone: Set<string>;
	calls: { fn: string; args: Record<string, unknown> }[];
}

export const older = (item: Record<string, unknown>, before: { lastAt: string; thread: string }) =>
	String(item.lastAt) < before.lastAt || (item.lastAt === before.lastAt && String(item.thread) < before.thread);

/** The member mail read on the fixture's cloud. */
export function mailFake(f: ReturnType<typeof fixture>): MailFake {
	const fake: MailFake = { addresses: [], waiting: [], threads: [], reads: {}, gone: new Set(), calls: [] };
	(f.cloud.rpc as unknown as Mock).mockImplementation(async (fn: string, args: Record<string, unknown>) => {
		fake.calls.push({ fn, args });
		if (fn === "qorpera_member_mail_addresses") return fake.addresses;
		if (fn === "qorpera_member_mail_waiting") return fake.waiting;
		if (fn === "qorpera_member_mail_threads") {
			const request = args.p_request as {
				state?: string;
				address?: string;
				direction?: string;
				before?: { lastAt: string; thread: string };
				limit: number;
			};
			const { before } = request;
			const rows = fake.threads.filter(
				(item) =>
					(request.state === undefined || item.state === request.state) &&
					(request.address === undefined || item.address === request.address) &&
					(request.direction === undefined || item.direction === request.direction) &&
					(before === undefined || older(item, before)),
			);
			const page = rows.slice(0, request.limit);
			const last = page.at(-1);
			return {
				threads: page,
				nextBefore: rows.length > request.limit && last ? { lastAt: last.lastAt, thread: last.thread } : null,
			};
		}
		const threadId = String(args.p_thread);
		if (fake.gone.has(threadId))
			throw new CloudRpcError(fn, { message: "That is not a mail thread of this company.", code: "22023" }, 400);
		if (fn === "qorpera_member_mail_thread") {
			const n = Number(threadId.slice("thread-".length));
			const before = args.p_before as { id: string } | undefined;
			return (
				fake.reads[before ? `${threadId} before ${before.id}` : threadId] ?? {
					thread: threadId,
					address: ADDRESS.address,
					messages: [received(n)],
					more: false,
					waiting: [],
				}
			);
		}
		if (fn === "qorpera_mark_mail_thread_read") {
			for (const item of fake.threads) if (item.thread === threadId) item.unread = false;
			return true;
		}
		throw new Error(`Unexpected RPC ${fn}`);
	});
	return fake;
}

/** The member's one model account that can pay. */
export const connections: NativeExecutionConnections = {
	computeIdentity: {
		computeIdentityId: id(882),
		ownershipKind: "member",
		ownerUserId: userA.id,
		displayName: "Member computer",
		templateKey: "member",
		templateVersion: "v1",
		capabilities: ["agent_turn"],
		policy: {},
		status: "active",
		createdAt: "2026-09-12T00:00:00Z",
		updatedAt: "2026-09-12T00:00:00Z",
	},
	connections: [
		{
			connectionId: id(880),
			clientConnectionId: id(883),
			connectionVersion: 1,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "member",
			consentVersion: "v1",
			consentedAt: "2026-09-12T00:00:00Z",
			connectionStatus: "active",
			sponsorBindingId: id(881),
			sponsorVersion: 1,
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 1 },
		},
	],
};

/** The member's model accounts as the cloud gives them: it chooses that account for every conversation. */
export function accountsFake() {
	return {
		listConnections: vi.fn(async (_signal?: AbortSignal) => connections),
		selectSessionAccount: vi.fn(
			async (_sessionId: string, _signal?: AbortSignal): Promise<string | undefined> => id(880),
		),
	};
}
