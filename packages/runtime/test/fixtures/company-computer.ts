import type {
	CompanyComputerEffectContext,
	CompanyComputerOperation,
	CompanyComputerRun,
	CompanyComputerScope,
	CompanyComputerScreenBinding,
	CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { COMPANY_COMPUTER_TOOL_VERSION } from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerScreenRegistry } from "@qorpera/runtime/cloud-company-computer-state";

export function computerId(number: number): string {
	return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

export function computerScope(): CompanyComputerScope {
	return {
		companyId: computerId(1),
		environmentId: computerId(2),
		companyComputerId: computerId(3),
		logicalComputerId: computerId(4),
	};
}

export function computerBinding(): CompanyComputerScreenBinding {
	return {
		...computerScope(),
		computerGeneration: 1,
		screenId: computerId(6),
		screenOrdinal: 1,
		screenGeneration: 1,
		staffAgentId: computerId(5),
	};
}

export function computerLease(): CompanyComputerScreenLease {
	return {
		binding: computerBinding(),
		leaseId: computerId(9),
		epoch: 1,
		driver: { kind: "agent", runId: computerId(7), staffAgentId: computerId(5) },
		validForMs: 30_000,
	};
}

export function computerRun(signal: AbortSignal = new AbortController().signal): CompanyComputerRun {
	return {
		identity: {
			companyId: computerId(1),
			environmentId: computerId(2),
			staffAgentId: computerId(5),
			runId: computerId(7),
			requesterUserId: computerId(8),
		},
		signal,
		assertActive: async (checked) => {
			signal.throwIfAborted();
			checked.throwIfAborted();
		},
	};
}

export function computerEffect(signal: AbortSignal = new AbortController().signal): CompanyComputerEffectContext {
	return { identity: computerRun().identity, receiptId: computerId(10), idempotencyKey: "a".repeat(64), signal };
}

export function computerOperation(): CompanyComputerOperation {
	return {
		tool: "computer_browser",
		toolVersion: COMPANY_COMPUTER_TOOL_VERSION,
		logicalOperationKey: "test:1",
		arguments: { kind: "browser", action: "snapshot" },
		target: { realm: "company_computer", binding: { ...computerBinding() }, resources: {} },
		requiresCompanyRevision: false,
	};
}

export function computerRegistry(): CompanyComputerScreenRegistry {
	return {
		scope: computerScope(),
		computerGeneration: 1,
		revision: 1,
		lifecycle: "active",
		maxScreens: 4,
		screens: [
			{
				screenId: computerId(6),
				ordinal: 1,
				generation: 1,
				staffAgentId: computerId(5),
				status: "active",
				power: "open",
				epoch: 0,
				touchedAt: 0,
				lease: null,
				takeover: null,
				viewers: [],
			},
		],
	};
}

export function computerDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Synthetic RFB packets for framing tests, not a captured/rendered cloud desktop. */
export function computerRfbServerHello(): Buffer {
	const name = Buffer.from("Test cloud screen");
	const init = Buffer.alloc(24);
	init.writeUInt16BE(1920, 0);
	init.writeUInt16BE(1200, 2);
	init[4] = 32;
	init[5] = 24;
	init[7] = 1;
	for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
	init[14] = 16;
	init[15] = 8;
	init.writeUInt32BE(name.length, 20);
	return Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1, 0, 0, 0, 0]), init, name]);
}

export function computerRfbRectangle(
	encoding: number,
	width: number,
	height: number,
	body: Buffer = Buffer.alloc(0),
): Buffer {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(width, 4);
	header.writeUInt16BE(height, 6);
	header.writeInt32BE(encoding, 8);
	return Buffer.concat([header, body]);
}

export function computerRfbUpdate(rectangles: Buffer[], count = rectangles.length): Buffer {
	const header = Buffer.alloc(4);
	header.writeUInt16BE(count, 2);
	return Buffer.concat([header, ...rectangles]);
}

export function computerRfbServerClipboard(text: string, extended = false): Buffer {
	const body = Buffer.from(text);
	const header = Buffer.alloc(8);
	header[0] = 3;
	header.writeInt32BE(extended ? -body.length : body.length, 4);
	return Buffer.concat([header, body]);
}
