import { createHash, randomBytes } from "node:crypto";
import type { CloudMachineCommandReceipt } from "../../packages/contracts/src/cloud-machine.ts";
import type {
	CompanyMachineAccountFill, CompanyMachineAccountFillOutcome, CompanyMachineAccountFillSeal, CompanyMachineClipboardClear,
	CompanyMachineClipboardCleared, CompanyMachineCodingValue, CompanyMachineCodingValueOutcome,
	CompanyMachineMemberAct, CompanyMachineMemberActOutcome, CompanyMachineMemberLook, CompanyMachineMemberLookOutcome,
	CompanyMachineMemberPointer, CompanyMachineMemberPointerOutcome, CompanyMachineMemberStart,
	CompanyMachineMemberStartOutcome, CompanyMachineMemberStream, CompanyMachineScreen, CompanyMachineScreenOutcome,
} from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import {
	CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA,
	type CloudMachineAccountFillAnswer,
	type CloudMachineAccountFillHttpRequest,
	CloudMachineAccountFillRefusal,
	CLOUD_MACHINE_CODING_VALUE_SCHEMA,
	CLOUD_MACHINE_SCREEN_SCHEMA,
	CLOUD_MACHINE_WAKE_WAIT_MS,
	type CloudMachineCodingValueAnswer,
	CloudMachineCodingValueRefusal,
	type CloudMachineCodingValueHttpRequest,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	type CloudMachineScreenAnswer,
	type CloudMachineScreenHttpRequest,
	CloudMachineScreenRefusal,
	type CloudMachineWakeHttpRequest,
	type CloudMemberMachineAct,
	type CloudMemberMachineActPeerRequest,
	CloudMemberMachineActRefusal,
	type CloudMemberMachinePointerMove,
	type CloudMemberMachinePointerPeerRequest,
	CloudMemberMachinePointerRefusal,
	type CloudMemberMachineScreen,
	type CloudMemberMachineScreenPeerRequest,
	CloudMemberMachineScreenRefusal,
	type CloudMemberMachineStart,
	type CloudMemberMachineStartPeerRequest,
	CloudMemberMachineStartRefusal,
	type CloudMemberMachineStreamPeerRequest,
	cloudMachineCommandRefusal,
	createHttpCloudMachineCommandGateway,
	createHttpMemberMachineScreenPeer,
	isCloudMachineAccountFillRefusal,
	isCloudMachineCodingValueRefusal,
	isCloudMachineScreenRefusal,
	isCloudMemberMachineActRefusal,
	isCloudMemberMachinePointerRefusal,
	isCloudMemberMachineStartRefusal,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import type {
	CloudMemberMachineActRequest, CloudMemberMachinePointerAnswer, CloudMemberMachinePointerRequest,
	CloudMemberMachineScreenLook, CloudMemberMachineStartRequest,
} from "../../packages/runtime/src/cloud-member-machine-screen-http.ts";
import type {
	CloudMemberMachineStreamRun, CloudMemberMachineStreamSink,
} from "../../packages/runtime/src/cloud-member-machine-stream-http.ts";
import {
	MACHINE_SCREEN_REQUEST_SCHEMA, type MachineScreenAction, parseMachineScreenHeader,
} from "../../packages/runtime/src/cloud-machine-screen.ts";
import { CloudCommandPages } from "../../packages/runtime/src/cloud-command-pages.ts";
import {
	type CloudHomeChannelKind, type CloudHomeChannelRequest, CloudHomeChannelRefused, type CloudHomeChannelSide,
	type CloudHomeSessionAuthorized,
} from "../../packages/runtime/src/cloud-home-channel.ts";
import { createCloudHomeChannel } from "../../packages/runtime/src/cloud-home-channel-client.ts";
import type { CodingCommandPeer } from "./command-routing.ts";
import type { MachineAccountFillSealRequest } from "./machine-account-fill-broker.ts";
import {
	authorizeMachineAccountFill, authorizeMachineCodingValue, authorizeMachineCommand, authorizeMachineScreen,
	authorizeMemberMachineAct, authorizeMemberMachinePointer, authorizeMemberMachineScreen, authorizeMemberMachineStart,
	type MachineAccountFillAuthority, type MachineCodingValueAuthority, type MachineCodingValueClear,
	type MachineCommandAuthority, type MachineScreenAuthority, type MemberMachineActAuthority,
	type MemberMachinePointerAuthority, type MemberMachineScreenAuthority, type MemberMachineStartAuthority,
} from "./machine-command-authority.ts";

interface MachineCommandRouterOptions {
	owner: string;
	providerId: string;
	peers: readonly CodingCommandPeer[];
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	credential(name: string): Promise<string>;
	/** This node's machines; absent when the executor carries no machines. */
	executeLocal?(request: CloudMachineCommandHttpRequest, authority: MachineCommandAuthority, signal: AbortSignal): Promise<CloudMachineCommandReceipt>;
	/** One run's channel to its home on this node's machine (slice 1): `codex exec-server` inside it (or, for kind
	 * `sftp`, OpenSSH's `sftp-server`: slice C1), as the agent's account on the boot SQL named, for as long as the run's
	 * turn. Absent when the executor carries no machines. */
	execServerLocal?(authority: { sessionId: string; placementId: string; bootId: string; kind: CloudHomeChannelKind }, signal: AbortSignal): Promise<CloudHomeChannelSide>;
	/** Asks this node's machines for a pass now; with a wait, true once a step took the machine somewhere. Absent when the executor carries no machines. */
	wakeLocal?(machineId: string, wait: boolean, signal: AbortSignal): Promise<boolean>;
	/** save_coding_value (20260930705000): runs the clipboard helper on this node's machine; absent when the executor carries no machines. */
	codingValueLocal?(authority: MachineCodingValueAuthority, signal: AbortSignal): Promise<CloudMachineCodingValueAnswer>;
	accountFillLocal?(
		request: CloudMachineAccountFillHttpRequest,
		authority: MachineAccountFillAuthority,
		signal: AbortSignal,
	): Promise<CloudMachineAccountFillAnswer>;
	/** The backstop of the clipboard clear owed after a member held the desktop (F32 to F35 of #1661): clears it on this
	 * node's machine and confirms it to SQL. Never reads it: the agent's call is answered CLIPBOARD_EMPTY whatever came of
	 * it. */
	codingValueClearLocal?(authority: MachineCodingValueClear, signal: AbortSignal): Promise<void>;
	/** machine_screen (20260930708000): runs the screen helper on this node's machine; absent when the executor carries no machines. */
	screenLocal?(authority: MachineScreenAuthority, signal: AbortSignal): Promise<CloudMachineScreenAnswer>;
	/** A member's look (20260930712000): begins it as the member (member-control.ts); absent when this executor takes no
	 * member's requests (only the node behind the member bridge does). */
	memberBegin?(token: string, look: { companyId: string; machineId: string; confirmed: boolean }, signal: AbortSignal): Promise<string>;
	/** A member's look at this node's machine; absent when the executor carries no machines. */
	memberScreenLocal?(authority: MemberMachineScreenAuthority, etag: string | null, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
	/** A member's action (20260930713000): begins it as the member, recorded without its text (member-control.ts); absent
	 * when this executor takes no member's requests. */
	memberActBegin?(token: string, act: { companyId: string; machineId: string; action: MachineScreenAction; epoch: number;
		seat: number }, signal: AbortSignal): Promise<string>;
	/** A member's shared action (20260930734000): begun as the member with no hold of theirs, recorded without its text,
	 * under the lease generation its input was made under when the page sent one (20260930738000; member-control.ts);
	 * absent when this executor takes no member's requests. */
	memberShareBegin?(token: string, share: { companyId: string; machineId: string; action: MachineScreenAction;
		generation?: number }, signal: AbortSignal): Promise<string>;
	/** A member's action on this node's machine; absent when the executor carries no machines. */
	memberActLocal?(authority: MemberMachineActAuthority, action: MachineScreenAction, signal: AbortSignal): Promise<CloudMemberMachineAct>;
	/** A member's start of the desktop (20260930714000): begins it as the member (member-control.ts); absent when this
	 * executor takes no member's requests. */
	memberStartBegin?(token: string, start: { companyId: string; machineId: string; open?: string }, signal: AbortSignal): Promise<{ startId: string }>;
	/** A member's start on this node's machine; absent when the executor carries no machines. */
	memberStartLocal?(authority: MemberMachineStartAuthority, signal: AbortSignal): Promise<CloudMemberMachineStart>;
	/** A member's pointer pass (20260930744000): begun as the member (member-control.ts); absent when this executor takes
	 * no member's requests. */
	memberPointerBegin?(token: string, begin: { companyId: string; machineId: string;
		hold: { generation: number } | { epoch: number; seat: number } }, signal: AbortSignal): Promise<string>;
	/** A member's pointer move on this node's machine; absent when the executor carries no machines. */
	memberPointerLocal?(authority: MemberMachinePointerAuthority, x: number, y: number, signal: AbortSignal): Promise<CloudMemberMachinePointerMove>;
	/** A member's live picture of this node's machine (20260930745000), until `signal` aborts or it ends (why); absent when
	 * the executor carries no machines. */
	memberStreamLocal?(stream: CompanyMachineMemberStream, sink: CloudMemberMachineStreamSink, signal: AbortSignal): Promise<string>;
	fetch?: typeof fetch;
}

/** At most this many moves a second on one pointer pass (20260930744000): the window sends fewer (one in flight); past
 * it a move is dropped, never queued. */
export const MEMBER_POINTER_MOVES_PER_SECOND = 30;
/** At most this many pointer passes are kept at once; the oldest goes first. */
const MEMBER_POINTER_PASSES = 10000;
/** A live picture's ticket (20260930745000): used once, within this, by the browser whose Origin bought it. */
const MEMBER_STREAM_TICKET_MS = 30_000;
/** At most this many tickets are kept at once; the oldest goes first. */
const MEMBER_STREAM_TICKETS = 1024;
/** Streams at once: of one member (two windows), and of one machine. */
const MEMBER_STREAMS_PER_MEMBER = 2;
const MEMBER_STREAMS_PER_MACHINE = 8;
/** How often a stream checks that its member still holds a live pointer pass of its hold. */
const MEMBER_STREAM_PASS_CHECK_MS = 1000;
/** A pointer pass's begin is the one pointer request that calls out (PostgREST, as the member): at most this many at
 * once on this executor, one per token, and at most MEMBER_POINTER_BEGINS_PER_SECOND begun in a second. Past it the
 * begin is refused at once (MEMBER_POINTER_BUSY, 503; the window asks again at its next move, at most once a second),
 * before any call: a flood of tokens that only look like a member's costs this node a hash and a counter each
 * (20260930745000, v242 release prep). A window begins about one pass in 7.5 s while its member points or watches live. */
export const MEMBER_POINTER_BEGINS_IN_FLIGHT = 16;
export const MEMBER_POINTER_BEGINS_PER_SECOND = 40;

/** A live picture's ticket, as the executor keeps it (memory only): until when, for which browser (Origin), whose
 * (the sha-256 of the token that bought it, the company, the machine, the member), and its hold (shared at a lease
 * generation, or private under an epoch in a seat). */
interface MemberStreamTicket {
	readonly until: number;
	readonly origin: string;
	readonly tokenSha256: string;
	readonly companyId: string;
	readonly machineId: string;
	readonly userId: string;
	readonly private: boolean;
	readonly generation: number;
	readonly epoch: number | null;
}

/** A pointer pass this executor holds (20260930744000), in its memory only: SQL's read of it, until when it lasts (on
 * the monotonic clock, counted from when SQL was asked: v242 release review r1 F2), the sha-256 of the member's token
 * that began it (on the executor that took the member's request; null where another executor forwards its moves), and
 * its moves in the current second. */
interface MemberPointerPass {
	readonly authority: MemberMachinePointerAuthority;
	readonly companyId: string | null;
	readonly tokenSha256: string | null;
	readonly until: number;
	second: number;
	moves: number;
}

/** How long the executor's word that the agent was told of a member's touch may take (20260930734000): it goes beside
 * the agent's answer and never holds it (review r2 F2 of #1701). */
export const MEMBER_TOUCHED_TOLD_MS = 3000;

/** True as soon as one is true, false once all said no. */
function anyTold(asked: readonly Promise<boolean>[]): Promise<boolean> {
	return new Promise((settle) => {
		for (const one of asked) void one.then((told) => { if (told) settle(true); });
		void Promise.all(asked).then(() => settle(false));
	});
}

/** Like coding commands: SQL names the machine's executor, and only an owner
 * in this deployment's peer allowlist is ever a destination. */
export class MachineCommandRouter {
	readonly #options: MachineCommandRouterOptions;
	/** What each peer said it takes for a page of a command's log (keyholes S1), learned from its answers. */
	readonly #pages = new CloudCommandPages();
	readonly #pointers = new Map<string, MemberPointerPass>();
	readonly #streamTickets = new Map<string, MemberStreamTicket>();
	readonly #streamsOpen = new Set<{ readonly userId: string; readonly machineId: string }>();
	/** The pointer begins on their way (by the sha-256 of their token), and the current second's count. */
	readonly #beginsInFlight = new Set<string>();
	#beginSecond = 0;
	#begunInSecond = 0;
	constructor(options: MachineCommandRouterOptions) {
		this.#options = { ...options, peers: options.peers.map((peer) => Object.freeze({ ...peer })) };
	}
	/** A wake goes to this node's machines and to every peer's: a machine in line has no node yet, and any executor's pass
	 * may admit it. It asks nothing of SQL: each step of that pass does. The answer comes from this node's machines when it
	 * has them, otherwise from the first peer that was told. */
	async wake(request: CloudMachineWakeHttpRequest, signal: AbortSignal, localOnly = false): Promise<boolean> {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(CLOUD_MACHINE_WAKE_WAIT_MS)]);
		const { wait } = request.input;
		const local = this.#options.wakeLocal?.(request.scope.machineId, wait, bounded);
		const peers = localOnly ? [] : this.#options.peers.map(async (peer) => {
			const gateway = createHttpCloudMachineCommandGateway({
				url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
				holder: null, fetch: this.#options.fetch,
			});
			return (await gateway.wake?.(request.scope, wait, bounded)) === true;
		}).map((asked) => asked.catch(() => false));
		const asked = local ? [local, ...peers] : peers;
		return wait ? anyTold(asked) : Promise.all(asked).then(() => false);
	}
	/**
	 * One run's channel to its home (slice 1). The ingress proved the run's holder and SQL authorized the session on
	 * the machine's placement and boot. A machine of this node is opened here; a machine another node holds is reached
	 * through that node's peer listener, exactly as a machine command is forwarded: the peer authorizes the same
	 * session again in SQL and may only open it locally, so a channel is never forwarded twice. A run's slot talks to
	 * its own node's ingress wherever its agent's machine is. The channel's kind (the exec-server's lines, or the file
	 * channel's: slice C1) travels with it, under the same session.
	 */
	async execServer(authority: CloudHomeSessionAuthorized, request: CloudHomeChannelRequest, signal: AbortSignal, localOnly = false): Promise<CloudHomeChannelSide> {
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.execServerLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			try {
				return await this.#options.execServerLocal({ ...authority, kind: request.kind }, signal);
			} catch (error) {
				// The machine's Codex is not the pinned build, or it has no sftp-server (an earlier image's disk): the run is
				// told so in words of its own, through this ingress or a forwarding one, rather than "could not be reached".
				if (error instanceof Error && (error.message === "HOME_CODEX_NOT_PINNED" || error.message === "HOME_SFTP_MISSING"))
					throw new CloudHomeChannelRefused(error.message);
				throw error;
			}
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const channel = createCloudHomeChannel({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			// The peer listener takes no holder: this executor proved the run's at its own ingress.
			holder: null,
		});
		return await channel.open({ sessionId: authority.sessionId, machineId: authority.machineId, kind: request.kind }, signal);
	}
	async execute(request: CloudMachineCommandHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineCommandReceipt> {
		const authority = await authorizeMachineCommand(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.executeLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.executeLocal(request, authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			// The peer listener takes no holder: this executor proved the guest's at its own ingress.
			holder: null, fetch: this.#options.fetch, pages: this.#pages,
		});
		// No retry: an uncertain start remains uncertain. The receiving peer has
		// its own credential, rechecks SQL and may only execute locally; its
		// refusal reaches the agent as the same refusal.
		try {
			return await (request.action === "start" ? gateway.start(request.scope, request.input, signal) :
				request.action === "read" ? gateway.read(request.scope, request.input, signal) :
				gateway.cancel(request.scope, request.input.commandId, signal));
		} catch (error) {
			const refusal = cloudMachineCommandRefusal(error);
			throw refusal ? new CloudMachineCommandRefusal(refusal, error instanceof CloudMachineCommandRefusal ? error.folderLost : undefined) : error;
		}
	}
	/** save_coding_value (20260930705000): SQL names the machine's executor, as for a command. This node runs the helper; another
	 * node's executor is sent the request once (it reads SQL again and only runs it locally): the helper clears the clipboard, so a
	 * send again would find nothing. Its refusal reaches the agent as the same refusal (a 409 with its code). */
	async codingValue(request: CloudMachineCodingValueHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineCodingValueAnswer> {
		const authority = await authorizeMachineCodingValue(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (authority.clear) {
				// A member held the desktop since its clipboard was last confirmed clear (F32 to F35): it is cleared now and nothing is
				// read. The agent hears what is true then, CLIPBOARD_EMPTY: copy the key on the site and call again
				// (DESKTOP_MEMBER_IN_CONTROL stays for a member who holds the desktop now, or took it over across a read).
				if (!this.#options.codingValueClearLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
				await this.#options.codingValueClearLocal(authority, signal);
				throw new CloudMachineCodingValueRefusal("CLIPBOARD_EMPTY");
			}
			if (!this.#options.codingValueLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.codingValueLocal(authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			holder: null, fetch: this.#options.fetch,
		});
		if (!gateway.codingValue) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return gateway.codingValue(request.scope, request.input, signal);
	}
	async accountFill(request: CloudMachineAccountFillHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineAccountFillAnswer> {
		const authority = await authorizeMachineAccountFill(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.accountFillLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.accountFillLocal(request, authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			holder: null, fetch: this.#options.fetch,
		});
		if (!gateway.accountFill) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return gateway.accountFill(request.scope, request.input, signal);
	}
	/** machine_screen (20260930708000): SQL names the machine's executor, as for a command. This node runs the helper; another
	 * node's executor is sent the request once (it reads SQL again and only runs it locally): an action is never sent twice.
	 * Its refusal reaches the agent as the same refusal (a 409 with its code). A member's touch of the shared screen
	 * (20260930734000) rides the answer, and only once that answer is ready does this executor tell SQL the agent was told
	 * (review r1 F4 of #1701): a refusal or a failure leaves it for the agent's next call. */
	async screen(request: CloudMachineScreenHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineScreenAnswer> {
		const authority = await authorizeMachineScreen(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.screenLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			const answer = await this.#options.screenLocal(authority, signal);
			this.#told(authority);
			return answer;
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			holder: null, fetch: this.#options.fetch,
		});
		if (!gateway.screen) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const answer = await gateway.screen(request.scope, request.input, signal);
		// The peer's own read says it too (and the peer tells SQL); an answer without it (a peer from before) carries this
		// read's.
		const told = authority.memberTouched && answer.memberTouched === undefined
			? { ...answer, memberTouched: { name: authority.memberTouched.name, secondsAgo: authority.memberTouched.secondsAgo } }
			: answer;
		this.#told(authority);
		return told;
	}
	/** The agent's answer carries the member's touch SQL's read gave (20260930734000): SQL hears it was told, up to that
	 * action's time. Beside the answer, never before it (review r2 F2 of #1701): the answer goes at once, and the word has
	 * MEMBER_TOUCHED_TOLD_MS of its own. When SQL does not hear it (it failed, or took longer), its next read says it
	 * again: said twice, never lost, and never a picture lost to it. */
	#told(authority: MachineScreenAuthority): void {
		const touched = authority.memberTouched;
		if (!touched) return;
		try {
			void this.#options.control
				.call("qorpera_machine_desktop_shared_told", { p_machine_id: authority.machineId, p_at: touched.at },
					AbortSignal.timeout(MEMBER_TOUCHED_TOLD_MS))
				.catch(() => undefined);
		} catch {
			// Not marked: the agent's next call says it again.
		}
	}
	/** A member's look at a desktop (20260930712000), as this executor's member listener took it: begun as the member (the
	 * database checks their token and answers a single-use id), then read again as the executor, and looked at on this
	 * node or sent once to the machine's node. */
	async memberScreen(look: CloudMemberMachineScreenLook, signal: AbortSignal): Promise<CloudMemberMachineScreen> {
		if (!this.#options.memberBegin) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const useId = await this.#options.memberBegin(look.token, { companyId: look.companyId, machineId: look.machineId,
			confirmed: look.confirmed }, signal);
		return this.#memberServe(useId, look.etag, signal, false);
	}
	/** A member's look another executor sent here (the peer listener): read again, and looked at on this node only. */
	memberScreenPeer(request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineScreen> {
		return this.#memberServe(request.useId, request.etag, signal, true);
	}
	/** SQL names the machine's executor, as for a command, and serves the use only to it, once: this node looks, or
	 * another node's executor is sent the use once (it reads SQL again, which serves it there, and never forwards). */
	async #memberServe(useId: string, etag: string | null, signal: AbortSignal, localOnly: boolean): Promise<CloudMemberMachineScreen> {
		const authority = await authorizeMemberMachineScreen(this.#options.control,
			{ useId, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
		if (authority.served) {
			if (!this.#options.memberScreenLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.memberScreenLocal(authority, etag, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return createHttpMemberMachineScreenPeer({ url: peer.origin, token: await this.#options.credential(peer.tokenCredential),
			fetch: this.#options.fetch }).memberScreen({ useId, etag }, signal);
	}
	/** A member's action on a desktop they hold (20260930713000), or on the desktop they share with the agent
	 * (20260930734000), as this executor's member listener took it: begun as the member (the database checks their token
	 * and their hold, or that no one holds it, records the action without its text and answers a single-use id), then
	 * read again as the executor, and run on this node or sent once to the machine's node. What the member typed goes only
	 * to the machine. */
	async memberAct(request: CloudMemberMachineActRequest, signal: AbortSignal): Promise<CloudMemberMachineAct> {
		if (request.shared === true) {
			// A shared action (20260930734000): no hold of the member's; SQL refuses it while anyone holds the desktop
			// privately, and serves it only while no one took it since.
			if (!this.#options.memberShareBegin) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
			// The lease generation the input was made under goes to SQL, which refuses it once someone held the desktop
			// privately since (20260930738000); a page before it sends none and is served as before.
			const actionId = await this.#options.memberShareBegin(request.token, { companyId: request.companyId,
				machineId: request.machineId, action: request.action,
				...(request.generation === undefined ? {} : { generation: request.generation }) }, signal);
			return this.#memberActServe(actionId, request.action, signal, false);
		}
		if (!this.#options.memberActBegin) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		// The epoch and the seat of the hold the page captured it under go to SQL, which runs it only under that hold (F24,
		// F26).
		const actionId = await this.#options.memberActBegin(request.token, { companyId: request.companyId,
			machineId: request.machineId, action: request.action, epoch: request.epoch, seat: request.seat }, signal);
		return this.#memberActServe(actionId, request.action, signal, false);
	}
	/** A member's action another executor sent here (the peer listener): read again, and run on this node only. */
	memberActPeer(request: CloudMemberMachineActPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineAct> {
		return this.#memberActServe(request.actionId, request.action, signal, true);
	}
	/** SQL names the machine's executor and serves the action only to it, once: this node runs it, or another node's
	 * executor is sent it once (it reads SQL again, which serves it there, and never forwards). */
	async #memberActServe(actionId: string, action: MachineScreenAction, signal: AbortSignal, localOnly: boolean): Promise<CloudMemberMachineAct> {
		const authority = await authorizeMemberMachineAct(this.#options.control,
			{ actionId, action, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
		if (authority.served) {
			if (!this.#options.memberActLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.memberActLocal(authority, action, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return createHttpMemberMachineScreenPeer({ url: peer.origin, token: await this.#options.credential(peer.tokenCredential),
			fetch: this.#options.fetch }).memberAct({ actionId, action }, signal);
	}
	/** A member turns a desktop on (20260930714000), as this executor's member listener took it: begun as the member (the
	 * database checks their token and answers a single-use id), then read again as the executor, and run on this node or
	 * sent once to the machine's node. It takes no hold and needs no run of the agent's; a member's hold of the desktop
	 * does not stop it (review r1 F1 of #1681: a hold does not prove the desktop runs, and a start of one that runs does
	 * nothing). With `open` (20260930758000) the start also opens that path of the company folder once the desktop runs:
	 * SQL keeps it on the start, and the machine's executor takes it from its own read of SQL, never from a peer. */
	async memberStart(request: CloudMemberMachineStartRequest, signal: AbortSignal): Promise<CloudMemberMachineStart> {
		if (!this.#options.memberStartBegin) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const begun = await this.#options.memberStartBegin(request.token, { companyId: request.companyId,
			machineId: request.machineId, ...(request.open === undefined ? {} : { open: request.open }) }, signal);
		return this.#memberStartServe(begun.startId, signal, false);
	}
	/** A member's start another executor sent here (the peer listener): read again, and run on this node only. */
	memberStartPeer(request: CloudMemberMachineStartPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineStart> {
		return this.#memberStartServe(request.startId, signal, true);
	}
	/** SQL names the machine's executor and serves the start only to it, once: this node runs it, or another node's
	 * executor is sent it once (it reads SQL again, which serves it there, and never forwards). */
	async #memberStartServe(startId: string, signal: AbortSignal, localOnly: boolean): Promise<CloudMemberMachineStart> {
		const authority = await authorizeMemberMachineStart(this.#options.control,
			{ startId, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
		if (authority.served) {
			if (!this.#options.memberStartLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.memberStartLocal(authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return createHttpMemberMachineScreenPeer({ url: peer.origin, token: await this.#options.credential(peer.tokenCredential),
			fetch: this.#options.fetch }).memberStart({ startId }, signal);
	}
	/**
	 * A member's pointer (20260930744000), as this executor's member listener took it. A begin asks SQL for a pass as the
	 * member, reads it again as the executor and keeps it in memory for its 10 seconds (never stored). A move checks only
	 * that pass, here: the member's token hashes to the one that began it, the machine is the pass's, it has not run out,
	 * and at most MEMBER_POINTER_MOVES_PER_SECOND in a second (past it the move is dropped). No SQL, row, receipt or log
	 * line per move. It is moved on this node, or sent to the machine's node once (a newer move replaces it).
	 */
	async memberPointer(request: CloudMemberMachinePointerRequest, signal: AbortSignal): Promise<CloudMemberMachinePointerAnswer> {
		if ("stream" in request) return this.#streamTicket(request);
		if ("begin" in request) {
			if (!this.#options.memberPointerBegin) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
			const tokenSha256 = sha256(request.token);
			const second = Math.floor(Date.now() / 1000);
			if (second !== this.#beginSecond) {
				this.#beginSecond = second;
				this.#begunInSecond = 0;
			}
			if (this.#beginsInFlight.size >= MEMBER_POINTER_BEGINS_IN_FLIGHT || this.#beginsInFlight.has(tokenSha256) ||
				this.#begunInSecond >= MEMBER_POINTER_BEGINS_PER_SECOND)
				throw new Error("MEMBER_POINTER_BUSY");
			this.#begunInSecond++;
			this.#beginsInFlight.add(tokenSha256);
			try {
				const passId = await this.#options.memberPointerBegin(request.token, { companyId: request.companyId,
					machineId: request.machineId, hold: request.begin }, signal);
				const askedAt = performance.now();
				const authority = await authorizeMemberMachinePointer(this.#options.control,
					{ passId, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
				if (authority.machineId !== request.machineId) throw new Error("MEMBER_POINTER_AUTHORITY_INVALID");
				const kept = this.#keepPointer(authority, request.companyId, tokenSha256, askedAt);
				// What is left of it now, not what SQL said before its answer travelled.
				return { pass: passId, milliseconds: Math.floor(kept.until - performance.now()) };
			} finally {
				this.#beginsInFlight.delete(tokenSha256);
			}
		}
		const kept = this.#pointerPass(request.pass);
		if (!kept || kept.tokenSha256 !== sha256(request.token) || kept.companyId !== request.companyId ||
			kept.authority.machineId !== request.machineId)
			throw new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED");
		if (!admitMove(kept)) return { moved: false };
		if (kept.authority.served) return this.#pointerLocal(kept, request.x, request.y, signal);
		const peer = this.#options.peers.find((entry) => entry.owner === kept.authority.executorOwner &&
			entry.providerId === kept.authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		try {
			return await createHttpMemberMachineScreenPeer({ url: peer.origin, token: await this.#options.credential(peer.tokenCredential),
				fetch: this.#options.fetch }).memberPointer({ passId: request.pass, x: request.x, y: request.y }, signal);
		} catch (error) {
			// The machine's node refused the pass's moves for good: it is forgotten here too, and the window begins another.
			if (error instanceof CloudMemberMachinePointerRefusal) this.#pointers.delete(request.pass);
			throw error;
		}
	}
	/** A member's pointer move another executor sent here (the peer listener): its pass read in SQL once, kept until it
	 * runs out, and the pointer moved on this node only. */
	async memberPointerPeer(request: CloudMemberMachinePointerPeerRequest, signal: AbortSignal): Promise<CloudMemberMachinePointerMove> {
		let kept = this.#pointerPass(request.passId);
		if (!kept) {
			const askedAt = performance.now();
			const authority = await authorizeMemberMachinePointer(this.#options.control,
				{ passId: request.passId, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
			if (!authority.served) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			kept = this.#keepPointer(authority, null, null, askedAt);
		}
		if (!admitMove(kept)) return { moved: false };
		return this.#pointerLocal(kept, request.x, request.y, signal);
	}
	async #pointerLocal(kept: MemberPointerPass, x: number, y: number, signal: AbortSignal): Promise<CloudMemberMachinePointerMove> {
		if (!this.#options.memberPointerLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		try {
			return await this.#options.memberPointerLocal(kept.authority, x, y, signal);
		} catch (error) {
			// The host refused the pass's moves (a private hold since, the screen off, a restart): forgotten.
			if (error instanceof CloudMemberMachinePointerRefusal) this.#pointers.delete(kept.authority.passId);
			throw error;
		}
	}
	/**
	 * A live picture's ticket (20260930745000), bought on a pointer pass this executor holds: the member's token hashes to
	 * the one that began it, the company and the machine are the pass's, and the hold asked for is the pass's (shared at
	 * its generation, or private in its seat). 32 random bytes, kept in memory only, used once within
	 * MEMBER_STREAM_TICKET_MS by the browser whose Origin bought it (admitMemberStream).
	 */
	#streamTicket(request: Extract<CloudMemberMachinePointerRequest, { stream: unknown }>): { ticket: string; seconds: number } {
		const kept = this.#pointerPass(request.stream.pass);
		const hold = request.stream.hold;
		const isPrivate = "epoch" in hold;
		if (!kept || kept.tokenSha256 !== sha256(request.token) || kept.companyId !== request.companyId ||
			kept.authority.machineId !== request.machineId || kept.authority.private !== isPrivate ||
			kept.authority.generation !== ("epoch" in hold ? hold.seat : hold.generation))
			throw new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED");
		const now = Date.now();
		for (const [ticket, asked] of this.#streamTickets) if (asked.until <= now) this.#streamTickets.delete(ticket);
		while (this.#streamTickets.size >= MEMBER_STREAM_TICKETS) {
			const oldest = this.#streamTickets.keys().next().value;
			if (oldest === undefined) break;
			this.#streamTickets.delete(oldest);
		}
		const ticket = randomBytes(32).toString("base64url");
		this.#streamTickets.set(ticket, {
			until: now + MEMBER_STREAM_TICKET_MS, origin: request.origin, tokenSha256: kept.tokenSha256 as string,
			companyId: request.companyId, machineId: request.machineId, userId: kept.authority.userId, private: isPrivate,
			generation: kept.authority.generation, epoch: "epoch" in hold ? hold.epoch : null,
		});
		return { ticket, seconds: MEMBER_STREAM_TICKET_MS / 1000 };
	}
	/**
	 * A member's stream, as the live-picture listener took it (20260930745000): the ticket is used up here, whatever comes
	 * of it; it must be live and of the browser's Origin, and the member under MEMBER_STREAMS_PER_MEMBER and the machine
	 * under MEMBER_STREAMS_PER_MACHINE open streams (else null: the listener says 404, nothing more). The stream then runs
	 * for as long as the member holds a live pointer pass of its hold on this executor (the window renews it every few
	 * seconds through the member bridge; checked every MEMBER_STREAM_PASS_CHECK_MS, else it ends POINTER_PASS_ENDED), on
	 * this node's machine or the machine's node (its peer listener, which reads the newest pass itself).
	 */
	admitMemberStream(ticket: string, origin: string): CloudMemberMachineStreamRun | null {
		const asked = this.#streamTickets.get(ticket);
		this.#streamTickets.delete(ticket);
		if (!asked || asked.until <= Date.now() || asked.origin !== origin) return null;
		const open = [...this.#streamsOpen];
		if (open.filter((one) => one.userId === asked.userId).length >= MEMBER_STREAMS_PER_MEMBER ||
			open.filter((one) => one.machineId === asked.machineId).length >= MEMBER_STREAMS_PER_MACHINE)
			return null;
		const opened = { userId: asked.userId, machineId: asked.machineId };
		// Counted from the admission on, so two at once cannot both pass the limit.
		this.#streamsOpen.add(opened);
		let ran = false;
		// A ticket admitted but never run (the browser went away first) gives its place back.
		const unused = globalThis.setTimeout(() => {
			if (!ran) this.#streamsOpen.delete(opened);
		}, 10_000);
		return async (sink, signal) => {
			ran = true;
			globalThis.clearTimeout(unused);
			const lapsed = new AbortController();
			const stop = AbortSignal.any([signal, lapsed.signal]);
			const watch = globalThis.setInterval(() => {
				if (!this.#streamPass(asked)) lapsed.abort();
			}, MEMBER_STREAM_PASS_CHECK_MS);
			try {
				if (signal.aborted) return "closed";
				const pass = this.#streamPass(asked);
				if (!pass) return "POINTER_PASS_ENDED";
				let reason: string;
				if (pass.authority.served) {
					if (!this.#options.memberStreamLocal) return "STREAM_UNAVAILABLE";
					reason = await this.#options.memberStreamLocal({ placementId: pass.authority.placementId,
						bootId: pass.authority.bootId, userId: asked.userId, generation: asked.generation, epoch: asked.epoch }, sink, stop);
				} else {
					const peer = this.#options.peers.find((entry) => entry.owner === pass.authority.executorOwner &&
						entry.providerId === pass.authority.providerId);
					if (!peer) return "STREAM_UNAVAILABLE";
					reason = await createHttpMemberMachineScreenPeer({ url: peer.origin,
						token: await this.#options.credential(peer.tokenCredential), fetch: this.#options.fetch })
						.memberStream({ passId: pass.authority.passId, epoch: asked.epoch }, sink, stop);
				}
				return lapsed.signal.aborted ? "POINTER_PASS_ENDED" : reason;
			} finally {
				globalThis.clearInterval(watch);
				this.#streamsOpen.delete(opened);
			}
		};
	}
	/** A member's live picture another executor asked of this one (its peer listener, 20260930745000): the pass read in
	 * SQL here (as a move's), served by this node, of the hold the stream is (private exactly when an epoch is named); then
	 * the desktop streamed from this node until the asking executor closes its request or it ends. */
	async memberStreamPeer(request: CloudMemberMachineStreamPeerRequest, sink: CloudMemberMachineStreamSink,
		signal: AbortSignal): Promise<string> {
		const askedAt = performance.now();
		const authority = await authorizeMemberMachinePointer(this.#options.control,
			{ passId: request.passId, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
		if (!authority.served || !this.#options.memberStreamLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		if ((request.epoch !== null) !== authority.private) throw new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED");
		// A pass with nothing left once SQL's answer came (none, or all of it gone on the way) shows nothing (as a move's:
		// v242 release review r1 F2).
		if (authority.milliseconds <= 0 || askedAt + authority.milliseconds <= performance.now())
			throw new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED");
		// WHY: Flush HTTP 200 headers as soon as the pass is authorized so peer connect timeouts do not trip on slow desktop startup or pending cycles.
		sink.ready?.();
		return this.#options.memberStreamLocal({ placementId: authority.placementId, bootId: authority.bootId,
			userId: authority.userId, generation: authority.generation, epoch: request.epoch }, sink, signal);
	}
	/** The member's newest live pointer pass of the stream's hold, on this executor; none when it ran out. */
	#streamPass(asked: MemberStreamTicket): MemberPointerPass | undefined {
		const now = performance.now();
		let newest: MemberPointerPass | undefined;
		for (const kept of this.#pointers.values())
			if (kept.until > now && kept.tokenSha256 === asked.tokenSha256 && kept.companyId === asked.companyId &&
				kept.authority.machineId === asked.machineId && kept.authority.private === asked.private &&
				kept.authority.generation === asked.generation && (!newest || kept.until > newest.until))
				newest = kept;
		return newest;
	}
	/** The pass, while it lasts. */
	#pointerPass(passId: string): MemberPointerPass | undefined {
		const kept = this.#pointers.get(passId);
		if (kept && kept.until <= performance.now()) {
			this.#pointers.delete(passId);
			return undefined;
		}
		return kept;
	}
	/**
	 * Keeps a pass for what is left of it: SQL's milliseconds counted from `askedAt`, when SQL was asked (the monotonic
	 * clock), so the time its answer took is not added to the pass (v242 release review r1 F2). A pass with nothing left
	 * (none, or all of it gone on the way) is refused before its first move: POINTER_PASS_ENDED, never kept. The passes
	 * that ran out go, and the oldest when there are too many.
	 */
	#keepPointer(authority: MemberMachinePointerAuthority, companyId: string | null, tokenSha256: string | null,
		askedAt: number): MemberPointerPass {
		const now = performance.now();
		const until = askedAt + authority.milliseconds;
		if (authority.milliseconds <= 0 || until <= now) throw new CloudMemberMachinePointerRefusal("POINTER_PASS_ENDED");
		for (const [passId, kept] of this.#pointers) if (kept.until <= now) this.#pointers.delete(passId);
		while (this.#pointers.size >= MEMBER_POINTER_PASSES) {
			const oldest = this.#pointers.keys().next().value;
			if (oldest === undefined) break;
			this.#pointers.delete(oldest);
		}
		const kept: MemberPointerPass = { authority, companyId, tokenSha256, until, second: now, moves: 0 };
		this.#pointers.set(authority.passId, kept);
		return kept;
	}
}

/** A move of this pass within MEMBER_POINTER_MOVES_PER_SECOND (counted per second); false: dropped. */
function admitMove(kept: MemberPointerPass): boolean {
	const now = performance.now();
	if (now - kept.second >= 1000) {
		kept.second = now;
		kept.moves = 0;
	}
	kept.moves++;
	return kept.moves <= MEMBER_POINTER_MOVES_PER_SECOND;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** How a router reaches this node's machines for a wake (MachineCommandRouter's `wakeLocal`). */
export function localMachineWake(host: {
	wake(): void;
	changed(machineId: string, signal: AbortSignal): Promise<boolean>;
}): (machineId: string, wait: boolean, signal: AbortSignal) => Promise<boolean> {
	return async (machineId, wait, signal) => {
		if (wait) return host.changed(machineId, signal);
		host.wake();
		return false;
	};
}

/** How a router runs save_coding_value's helper on this node's machines (MachineCommandRouter's `codingValueLocal`): the
 * host's box is the answer, a code the agent can act on its refusal, and any other code a failure. */
export function localMachineCodingValue(host: {
	codingValue(run: CompanyMachineCodingValue, signal: AbortSignal): Promise<CompanyMachineCodingValueOutcome>;
}): (authority: MachineCodingValueAuthority, signal: AbortSignal) => Promise<CloudMachineCodingValueAnswer> {
	return async (authority, signal) => {
		const outcome = await host.codingValue({ placementId: authority.placementId, bootId: authority.bootId,
			receiptId: authority.receiptId, target: authority.target, desktopGeneration: authority.desktopGeneration }, signal);
		if ("refused" in outcome) {
			if (isCloudMachineCodingValueRefusal(outcome.refused)) throw new CloudMachineCodingValueRefusal(outcome.refused);
			throw new Error("MACHINE_CODING_VALUE_FAILED");
		}
		return { schema: CLOUD_MACHINE_CODING_VALUE_SCHEMA, commandId: authority.receiptId, box: outcome.box };
	};
}

/** How a router runs fill_company_account's helper on this node's machines (MachineCommandRouter's `accountFillLocal`):
 * the helper's key goes to the vault (`seal`, the executor's broker client) with the run's call and where the helper runs;
 * typed is the answer, a code the agent can act on (or the vault's refusal, with its words) its refusal, and any other
 * code a failure. */
export function localMachineAccountFill(
	host: {
		accountFill(run: CompanyMachineAccountFill, seal: CompanyMachineAccountFillSeal, signal: AbortSignal): Promise<CompanyMachineAccountFillOutcome>;
	},
	vault: { seal(request: MachineAccountFillSealRequest, signal: AbortSignal): ReturnType<CompanyMachineAccountFillSeal> },
): (request: CloudMachineAccountFillHttpRequest, authority: MachineAccountFillAuthority, signal: AbortSignal) => Promise<CloudMachineAccountFillAnswer> {
	return async (request, authority, signal) => {
		const outcome = await host.accountFill({ placementId: authority.placementId, bootId: authority.bootId,
			receiptId: authority.receiptId, desktopGeneration: authority.desktopGeneration, target: authority.target },
		(publicKey, sealSignal) => vault.seal({ companyId: authority.companyId, binding: request.binding, receiptId: authority.receiptId,
			idempotencyKey: request.input.idempotencyKey, envelope: request.input.envelope, placementId: authority.placementId,
			bootId: authority.bootId, fillPublicKey: publicKey }, sealSignal), signal);
		if ("vaultRefused" in outcome) throw new CloudMachineAccountFillRefusal("VAULT_REFUSED", outcome.vaultRefused.message);
		if ("refused" in outcome) {
			if (isCloudMachineAccountFillRefusal(outcome.refused)) throw new CloudMachineAccountFillRefusal(outcome.refused);
			throw new Error("MACHINE_ACCOUNT_FILL_FAILED");
		}
		return { schema: CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA, commandId: authority.receiptId, filled: true };
	};
}

/** How a router does the clipboard clear owed after a member held a desktop on this node, when save_coding_value meets
 * it (MachineCommandRouter's `codingValueClearLocal`, F32 to F35 of #1661; the agent's first screen call after the hold
 * does it first): the host clears both selections with its own fixed script under the desktop's one-actor rule after
 * the fence, and confirms it to SQL at the generation SQL answered. A host that could not clear or confirm records
 * nothing (the clear stays owed); another boot, or an image without xsel, is the agent's refusal by its code, as a read's
 * would be. */
export function localMachineCodingValueClear(host: {
	clearClipboard(run: CompanyMachineClipboardClear, signal: AbortSignal): Promise<CompanyMachineClipboardCleared>;
}): (authority: MachineCodingValueClear, signal: AbortSignal) => Promise<void> {
	return async (authority, signal) => {
		const outcome = await host.clearClipboard({ placementId: authority.placementId, bootId: authority.bootId,
			desktopGeneration: authority.desktopGeneration }, signal);
		if ("refused" in outcome) throw new CloudMachineCodingValueRefusal(outcome.refused);
	};
}

/** How a router runs machine_screen's helper on this node's machines (MachineCommandRouter's `screenLocal`): the helper's
 * request as SQL authorized it; the host's header and PNG (base64) are the answer, a code the agent can act on its
 * refusal, and any other code a failure. */
export function localMachineScreen(host: {
	screen(run: CompanyMachineScreen, signal: AbortSignal): Promise<CompanyMachineScreenOutcome>;
}): (authority: MachineScreenAuthority, signal: AbortSignal) => Promise<CloudMachineScreenAnswer> {
	return async (authority, signal) => {
		const outcome = await host.screen({ placementId: authority.placementId, bootId: authority.bootId, runId: authority.runId,
			request: { schema: MACHINE_SCREEN_REQUEST_SCHEMA, receiptId: authority.receiptId, action: authority.action,
				settleMs: authority.settleMs, look: authority.look }, desktopGeneration: authority.desktopGeneration,
			clearClipboard: authority.clipboardClear }, signal);
		if ("refused" in outcome) {
			if (isCloudMachineScreenRefusal(outcome.refused)) throw new CloudMachineScreenRefusal(outcome.refused);
			throw new Error("MACHINE_SCREEN_FAILED");
		}
		return { schema: CLOUD_MACHINE_SCREEN_SCHEMA, commandId: authority.receiptId, header: parseMachineScreenHeader(outcome.header),
			png: outcome.png ? outcome.png.toString("base64") : null, ...(outcome.heldBack !== undefined ? { heldBack: outcome.heldBack } : {}),
			// A member touched the shared screen since an agent was last told (20260930734000): who and how long ago, never what.
			...(authority.memberTouched
				? { memberTouched: { name: authority.memberTouched.name, secondsAgo: authority.memberTouched.secondsAgo } }
				: {}) };
	};
}

/** How a router looks at this node's machine for a member (MachineCommandRouter's `memberScreenLocal`): the host's
 * picture and its etag, or no picture when the member has it (their etag is the picture's); the screen off, a restarted
 * machine and an image without scrot as the member's refusals; a held picture as SCREEN_HIDDEN (the machine holds a read
 * the member may not read) or SCREEN_HELD (look again), with nothing of the picture. */
export function localMemberMachineScreen(host: {
	memberLook(look: CompanyMachineMemberLook, signal: AbortSignal): Promise<CompanyMachineMemberLookOutcome>;
}): (authority: MemberMachineScreenAuthority, etag: string | null, signal: AbortSignal) => Promise<CloudMemberMachineScreen> {
	return async (authority, etag, signal) => {
		const outcome = await host.memberLook({ placementId: authority.placementId, bootId: authority.bootId,
			userId: authority.userId, keepDesktop: authority.keepDesktop, desktopGeneration: authority.desktopGeneration }, signal);
		if ("refused" in outcome) throw new CloudMemberMachineScreenRefusal(outcome.refused);
		if ("held" in outcome) throw new CloudMemberMachineScreenRefusal(outcome.held === "hidden" ? "SCREEN_HIDDEN" : "SCREEN_HELD");
		return { etag: outcome.etag, png: outcome.etag === etag ? null : outcome.png };
	};
}

/** How a router runs a member's action on this node's machines (MachineCommandRouter's `memberActLocal`): the host's
 * exit, the desktop busy, off or changed as the member's refusals, and any other code a failure. The action, a typed text
 * with it, goes to the host and nowhere else. */
export function localMemberMachineAct(host: {
	memberAct(act: CompanyMachineMemberAct, signal: AbortSignal): Promise<CompanyMachineMemberActOutcome>;
}): (authority: MemberMachineActAuthority, action: MachineScreenAction, signal: AbortSignal) => Promise<CloudMemberMachineAct> {
	return async (authority, action, signal) => {
		const outcome = await host.memberAct({ placementId: authority.placementId, bootId: authority.bootId,
			actionId: authority.actionId, action: { ...action }, seat: authority.seat, userId: authority.userId,
			// A shared action (20260930734000): the host's fence names no member, so any private hold since stops it.
			...(authority.shared ? { shared: true } : {}) }, signal);
		if ("refused" in outcome) {
			if (isCloudMemberMachineActRefusal(outcome.refused)) throw new CloudMemberMachineActRefusal(outcome.refused);
			throw new Error("MEMBER_MACHINE_ACT_FAILED");
		}
		return { exitCode: outcome.done.exitCode };
	};
}

/** How a router turns a desktop on for a member on this node's machines (MachineCommandRouter's `memberStartLocal`,
 * 20260930714000): the host's outcome, a machine too small, restarted, without a desktop or a desktop that did not start
 * as the member's refusals, and any other code a failure. A start that opens something (20260930758000) passes what SQL
 * read to the host, and its refusals (not there, no company folder, could not open) are the member's too. */
export function localMemberMachineStart(host: {
	memberStart(start: CompanyMachineMemberStart, signal: AbortSignal): Promise<CompanyMachineMemberStartOutcome>;
}): (authority: MemberMachineStartAuthority, signal: AbortSignal) => Promise<CloudMemberMachineStart> {
	return async (authority, signal) => {
		const outcome = await host.memberStart({ placementId: authority.placementId, bootId: authority.bootId,
			startId: authority.startId, ...(authority.open === undefined ? {} : { open: authority.open }) }, signal);
		if ("refused" in outcome) {
			if (isCloudMemberMachineStartRefusal(outcome.refused)) throw new CloudMemberMachineStartRefusal(outcome.refused);
			throw new Error("MEMBER_MACHINE_START_FAILED");
		}
		return { outcome: outcome.outcome };
	};
}

/** How a router moves a member's pointer on this node's machines (MachineCommandRouter's `memberPointerLocal`,
 * 20260930744000): the host's word (moved, or dropped while an action holds the desktop), its refusals as the member's,
 * and any other code a failure. */
export function localMemberMachinePointer(host: {
	memberPointer(move: CompanyMachineMemberPointer): CompanyMachineMemberPointerOutcome;
}): (authority: MemberMachinePointerAuthority, x: number, y: number, signal: AbortSignal) => Promise<CloudMemberMachinePointerMove> {
	return async (authority, x, y) => {
		const outcome = host.memberPointer({ placementId: authority.placementId, bootId: authority.bootId,
			userId: authority.userId, generation: authority.generation, private: authority.private, x, y });
		if ("refused" in outcome) {
			if (isCloudMemberMachinePointerRefusal(outcome.refused)) throw new CloudMemberMachinePointerRefusal(outcome.refused);
			throw new Error("MEMBER_MACHINE_POINTER_FAILED");
		}
		return { moved: outcome.moved };
	};
}

/** How a router streams a desktop of this node's machines (MachineCommandRouter's `memberStreamLocal`, 20260930745000). */
export function localMemberMachineStream(host: {
	memberStream(stream: CompanyMachineMemberStream, sink: CloudMemberMachineStreamSink, signal: AbortSignal): Promise<string>;
}): (stream: CompanyMachineMemberStream, sink: CloudMemberMachineStreamSink, signal: AbortSignal) => Promise<string> {
	return (stream, sink, signal) => host.memberStream(stream, sink, signal);
}

/** The machine routes of an executor's command service: its ingress (`localOnly` false), or its peer listener (true), which
 * never forwards. */
export function machineCommandRoutes(
	router: MachineCommandRouter,
	control: MachineCommandRouterOptions["control"],
	localOnly: boolean,
): {
	authorize(request: CloudMachineCommandHttpRequest, signal: AbortSignal): Promise<MachineCommandAuthority>;
	execute(request: CloudMachineCommandHttpRequest, signal: AbortSignal): Promise<CloudMachineCommandReceipt>;
	wake(request: CloudMachineWakeHttpRequest, signal: AbortSignal): Promise<boolean>;
	codingValue(request: CloudMachineCodingValueHttpRequest, signal: AbortSignal): Promise<CloudMachineCodingValueAnswer>;
	accountFill(request: CloudMachineAccountFillHttpRequest, signal: AbortSignal): Promise<CloudMachineAccountFillAnswer>;
	screen(request: CloudMachineScreenHttpRequest, signal: AbortSignal): Promise<CloudMachineScreenAnswer>;
	memberScreen?(request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
	memberAct?(request: CloudMemberMachineActPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineAct>;
	memberStart?(request: CloudMemberMachineStartPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineStart>;
	memberPointer?(request: CloudMemberMachinePointerPeerRequest, signal: AbortSignal): Promise<CloudMemberMachinePointerMove>;
	memberStream?(request: CloudMemberMachineStreamPeerRequest, sink: CloudMemberMachineStreamSink, signal: AbortSignal): Promise<string>;
} {
	return {
		authorize: (request, signal) => authorizeMachineCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal, localOnly),
		wake: (request, signal) => router.wake(request, signal, localOnly),
		codingValue: (request, signal) => router.codingValue(request, signal, localOnly),
		accountFill: (request, signal) => router.accountFill(request, signal, localOnly),
		screen: (request, signal) => router.screen(request, signal, localOnly),
		// A member's look comes from another executor only, on the peer listener; a guest's ingress has none.
		...(localOnly ? { memberScreen: (request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal) => router.memberScreenPeer(request, signal) } : {}),
		// So does a member's action (20260930713000).
		...(localOnly ? { memberAct: (request: CloudMemberMachineActPeerRequest, signal: AbortSignal) => router.memberActPeer(request, signal) } : {}),
		// And a member's start of the desktop (20260930714000).
		...(localOnly ? { memberStart: (request: CloudMemberMachineStartPeerRequest, signal: AbortSignal) => router.memberStartPeer(request, signal) } : {}),
		// And a member's pointer move (20260930744000).
		...(localOnly ? { memberPointer: (request: CloudMemberMachinePointerPeerRequest, signal: AbortSignal) => router.memberPointerPeer(request, signal) } : {}),
		// And a member's live picture (20260930745000).
		...(localOnly ? { memberStream: (request: CloudMemberMachineStreamPeerRequest, sink: CloudMemberMachineStreamSink,
			signal: AbortSignal) => router.memberStreamPeer(request, sink, signal) } : {}),
	};
}
