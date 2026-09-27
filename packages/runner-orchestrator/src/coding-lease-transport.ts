import { performance } from "node:perf_hooks";
import { type CloudCodingCommandScope, cloudCodingSessionLayout } from "@qorpera/contracts";
import { type CodingCommandGuestPins, inspectCodingCommandGuest } from "./coding-command-transport.ts";
import { lxdCodingMachineName, lxdCodingMachinePlan } from "./coding-machine.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Trusted host only: renewing this callback must validate the current cloud
 * queue lease and exact physical admission. No provider or queue token enters
 * the guest. The hash is a generation marker, never a credential. */
export class LxdCodingLeaseTransport {
	readonly #pins: CodingCommandGuestPins;
	readonly #scope: CloudCodingCommandScope;
	readonly #authorize: (
		scope: CloudCodingCommandScope,
		leaseTokenSha256: string,
		ttlMs: number,
		signal: AbortSignal,
	) => Promise<void>;
	constructor(
		options: Omit<CodingCommandGuestPins, "workerId"> & {
			scope: CloudCodingCommandScope;
			authorize: (
				scope: CloudCodingCommandScope,
				leaseTokenSha256: string,
				ttlMs: number,
				signal: AbortSignal,
			) => Promise<void>;
		},
	) {
		const machine = lxdCodingMachinePlan(options.machine).binding;
		if (
			Object.keys(options.scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			!UUID.test(options.scope.workerId) ||
			options.scope.vmId !== machine.machineId ||
			!UUID.test(options.scope.requestId) ||
			!Number.isSafeInteger(options.scope.turn) ||
			options.scope.turn < 1
		)
			throw new Error("CODING_LEASE_SCOPE_INVALID");
		this.#scope = Object.freeze({ ...options.scope });
		this.#pins = {
			machine,
			storage: options.storage,
			workerId: options.scope.workerId,
			bootId: options.bootId,
			helperSha256: options.helperSha256,
			guestConfigSha256: options.guestConfigSha256,
			client: options.client,
		};
		this.#authorize = options.authorize;
	}
	async refresh(
		scope: CloudCodingCommandScope,
		leaseTokenSha256: string,
		ttlMs: number,
		signal: AbortSignal,
	): Promise<void> {
		if (
			Object.keys(scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			Object.entries(this.#scope).some(([key, value]) => scope[key as keyof CloudCodingCommandScope] !== value) ||
			!HASH.test(leaseTokenSha256) ||
			!Number.isSafeInteger(ttlMs) ||
			ttlMs < 1 ||
			ttlMs > 60000
		)
			throw new Error("CODING_LEASE_REFRESH_INVALID");
		signal.throwIfAborted();
		const started = performance.now();
		await this.#authorize(this.#scope, leaseTokenSha256, ttlMs, signal);
		await inspectCodingCommandGuest(this.#pins, signal);
		const name = lxdCodingMachineName(this.#pins.machine.machineId),
			project = this.#pins.machine.project,
			layout = cloudCodingSessionLayout(this.#scope.workerId);
		const path = `${layout.custodyRoot}/inbox/lease-refresh.json`;
		const clock = await this.#pins.client.readInstanceFile(project, name, "/proc/uptime", 128, signal);
		const uptime = parseLxdProcUptime(clock.content);
		if (clock.uid !== 0 || clock.gid !== 0 || clock.mode !== 0o444 || !Number.isSafeInteger(uptime) || uptime < 0)
			throw new Error("CODING_GUEST_CLOCK_UNAVAILABLE");
		// Conservatively spend admission/inspection time from the guest's TTL.
		const remaining = ttlMs - Math.ceil(performance.now() - started) - 100;
		const notAfterMonoMs = uptime + remaining;
		if (remaining < 1) throw new Error("CODING_LEASE_REFRESH_EXPIRED");
		const input = `${JSON.stringify({ schema: "qorpera.coding-guest-lease-refresh/v1", ...this.#scope, leaseTokenSha256, ttlMs: remaining, notAfterMonoMs })}\n`;
		await this.#pins.client.pushInstanceFile(project, name, path, input, 0o444, signal);
		const staged = await this.#pins.client.readInstanceFile(project, name, path, 4096, signal);
		if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o444 || !staged.content.equals(Buffer.from(input)))
			throw new Error("CODING_LEASE_STAGING_UNCONFIRMED");
		await this.#authorize(this.#scope, leaseTokenSha256, remaining, signal);
		signal.throwIfAborted();
		await this.#pins.client.execInstance(
			project,
			name,
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-command-guest.mjs", "refresh-lease", this.#scope.workerId],
			signal,
		);
		const file = await this.#pins.client.readInstanceFile(
			project,
			name,
			`${layout.runtimeRoot}/lease.json`,
			4096,
			signal,
		);
		const lease = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)) as Record<
			string,
			unknown
		>;
		if (
			file.uid !== 0 ||
			file.gid !== 0 ||
			file.mode !== 0o444 ||
			lease.schema !== "qorpera.coding-guest-lease/v1" ||
			Object.keys(lease).sort().join() !==
				"bootId,expiresAtMonoMs,leaseTokenSha256,refreshedAtMonoMs,requestId,schema,turn,vmId,workerId" ||
			Object.entries(this.#scope).some(([key, value]) => lease[key] !== value) ||
			lease.bootId !== this.#pins.bootId ||
			lease.leaseTokenSha256 !== leaseTokenSha256 ||
			!Number.isSafeInteger(lease.refreshedAtMonoMs) ||
			!Number.isSafeInteger(lease.expiresAtMonoMs) ||
			Number(lease.refreshedAtMonoMs) < 0 ||
			Number(lease.expiresAtMonoMs) - Number(lease.refreshedAtMonoMs) > remaining ||
			Number(lease.expiresAtMonoMs) <= Number(lease.refreshedAtMonoMs) ||
			Number(lease.expiresAtMonoMs) > notAfterMonoMs
		)
			throw new Error("CODING_LEASE_REFRESH_UNCONFIRMED");
		signal.throwIfAborted();
	}
}
