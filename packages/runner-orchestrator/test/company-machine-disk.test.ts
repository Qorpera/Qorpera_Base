import { describe, expect, it } from "vitest";
import {
	COMPANY_MACHINE_DISK_KEEP_AFTER_MS,
	COMPANY_MACHINE_DISK_REPORT_MAX,
	type CompanyMachineDiskPlacement,
	CompanyMachineDiskReader,
} from "../src/company-machine-disk.ts";

// The executor's reader of its pool for the kernel's disk report (20260930757000; the coordinator's word after review of
// #1773: the report must hold with many disks). LXD stands in: each disk read and the pool read are recorded in order,
// and each moves the clock by `readMs`.

const GIB = 1024 ** 3;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const name = (n: number) => `qorpera-machine-${String(n).padStart(32, "0")}`;
/** A placement: awake, or asleep since `asleepAt` (the clock's ms). */
const placement = (n: number, asleepAt?: number): CompanyMachineDiskPlacement => ({
	placementId: id(n),
	project: "machines",
	name: name(n),
	asleepSince: asleepAt === undefined ? null : new Date(asleepAt).toISOString(),
});

function lxd(options: { readMs?: number; use?: (name: string) => number | undefined | Error } = {}) {
	const clock = { now: Date.parse("2026-11-13T20:00:00Z") };
	const calls: string[] = [];
	const used = new Map<string, number>();
	const client = {
		async readStorageVolumeUse(_pool: string, _project: string, volume: string) {
			calls.push(volume);
			clock.now += options.readMs ?? 5;
			const answer = options.use ? options.use(volume) : (used.get(volume) ?? 30 * 1024 ** 2);
			if (answer instanceof Error) throw answer;
			return answer;
		},
		async readStoragePoolSpace() {
			calls.push("pool");
			clock.now += 7;
			return { totalBytes: 1000 * GIB, usedBytes: 400 * GIB };
		},
	};
	return { clock, calls, used, client };
}
const signal = () => new AbortController().signal;

describe("the executor's disk reader (20260930757000)", () => {
	it("reads the awake disks first, then the sleeping ones the most recently asleep first, and the pool last", async () => {
		const f = lxd();
		const t = f.clock.now;
		const reader = new CompanyMachineDiskReader({ client: f.client, pool: "qorpera-vm", now: () => f.clock.now });
		const reading = await reader.read(
			[placement(1, t - 3 * 86400_000), placement(2), placement(3, t - 7200_000), placement(4)],
			signal(),
		);
		expect(f.calls).toEqual([name(2), name(4), name(3), name(1), "pool"]);
		expect(Object.keys(reading.report.placements)).toEqual([id(2), id(4), id(3), id(1)]);
		expect(reading).toMatchObject({ reads: 4, fromKept: 0, unknown: 0 });
		expect(reading.report).toMatchObject({
			schema: "qorpera.machine-executor-disk/v1",
			pool: "qorpera-vm",
			totalBytes: 1000 * GIB,
			usedBytes: 400 * GIB,
		});
	});

	it("keeps a sleeping disk's read made 60 s or more after it fell asleep, and reads it again only when it wakes or sleeps anew", async () => {
		const f = lxd();
		const t = f.clock.now;
		const reader = new CompanyMachineDiskReader({ client: f.client, pool: "qorpera-vm", now: () => f.clock.now });
		// 1 asleep for a day, 2 awake, 3 asleep for 10 s (too soon to keep: its last writes may not be counted yet).
		const listing = [placement(1, t - 86400_000), placement(2), placement(3, t - 10_000)];
		await reader.read(listing, signal());
		expect(reader.kept).toBe(1);
		f.calls.length = 0;
		f.used.set(name(1), 99 * GIB); // what LXD would say now is never asked: a sleeping disk cannot change
		const again = await reader.read(listing, signal());
		expect(f.calls).toEqual([name(2), name(3), "pool"]);
		expect(again.report.placements[id(1)]).toBe(30 * 1024 ** 2);
		expect(again).toMatchObject({ reads: 2, fromKept: 1, unknown: 0 });
		// A minute later 3 has slept long enough: read once more, then kept.
		f.clock.now = t + COMPANY_MACHINE_DISK_KEEP_AFTER_MS;
		f.calls.length = 0;
		await reader.read(listing, signal());
		expect(f.calls).toEqual([name(2), name(3), "pool"]);
		expect(reader.kept).toBe(2);
		f.calls.length = 0;
		await reader.read(listing, signal());
		expect(f.calls).toEqual([name(2), "pool"]);
		// 1 wakes, 3 sleeps anew: both are read again; one no longer listed is forgotten.
		f.calls.length = 0;
		const woken = await reader.read([placement(1), placement(3, f.clock.now)], signal());
		expect(f.calls).toEqual([name(1), name(3), "pool"]);
		expect(woken.report.placements[id(1)]).toBe(99 * GIB);
		expect(reader.kept).toBe(0);
	});

	it("sends what it has when its time is up, the pool still last, and reads the rest on later reports", async () => {
		const f = lxd({ readMs: 1000 });
		const t = f.clock.now;
		const reader = new CompanyMachineDiskReader({
			client: f.client,
			pool: "qorpera-vm",
			now: () => f.clock.now,
			readBudgetMs: 3000,
		});
		// One awake, five asleep for days (the most recent is 11).
		const listing = [
			placement(1),
			...[10, 11, 12, 13, 14].map((n) => placement(n, t - (n === 11 ? 1 : 2) * 86400_000)),
		];
		const first = await reader.read(listing, signal());
		expect(f.calls).toEqual([name(1), name(11), name(10), "pool"]);
		expect(first).toMatchObject({ reads: 3, fromKept: 0, unknown: 3 });
		expect(Object.keys(first.report.placements)).toEqual([id(1), id(11), id(10)]);
		f.calls.length = 0;
		const second = await reader.read(listing, signal());
		expect(f.calls).toEqual([name(1), name(12), name(13), "pool"]);
		expect(second).toMatchObject({ reads: 3, fromKept: 2, unknown: 1 });
		f.calls.length = 0;
		const third = await reader.read(listing, signal());
		expect(f.calls).toEqual([name(1), name(14), "pool"]);
		expect(third).toMatchObject({ reads: 2, fromKept: 4, unknown: 0 });
		f.calls.length = 0;
		await reader.read(listing, signal());
		expect(f.calls).toEqual([name(1), "pool"]);
	});

	it("names at most the kernel's limit, the awake disks first, and never throws for the count", async () => {
		const f = lxd({ readMs: 0 });
		const t = f.clock.now;
		const reader = new CompanyMachineDiskReader({ client: f.client, pool: "qorpera-vm", now: () => f.clock.now });
		const asleep = Array.from({ length: COMPANY_MACHINE_DISK_REPORT_MAX + 100 }, (_, n) =>
			placement(1000 + n, t - 86400_000 - n),
		);
		const listing = [...asleep, placement(1), placement(2)];
		const first = await reader.read(listing, signal());
		const named = Object.keys(first.report.placements);
		expect(named).toHaveLength(COMPANY_MACHINE_DISK_REPORT_MAX);
		expect(named.slice(0, 2)).toEqual([id(1), id(2)]);
		expect(first).toMatchObject({ reads: COMPANY_MACHINE_DISK_REPORT_MAX, unknown: 102 });
		// The rest are read on the next report; the report still names at most the limit, the awake first.
		const second = await reader.read(listing, signal());
		expect(Object.keys(second.report.placements)).toHaveLength(COMPANY_MACHINE_DISK_REPORT_MAX);
		expect(Object.keys(second.report.placements).slice(0, 2)).toEqual([id(1), id(2)]);
		expect(second.reads).toBe(2 + 102);
		expect(reader.kept).toBe(COMPANY_MACHINE_DISK_REPORT_MAX + 100);
	});

	it("leaves a disk whose read fails or that LXD does not have unknown, and fails only when the pool cannot be read", async () => {
		const f = lxd({
			use: (volume) =>
				volume === name(2) ? new Error("LXD request failed") : volume === name(3) ? undefined : 5 * GIB,
		});
		const reader = new CompanyMachineDiskReader({ client: f.client, pool: "qorpera-vm", now: () => f.clock.now });
		const reading = await reader.read([placement(1), placement(2), placement(3)], signal());
		expect(Object.keys(reading.report.placements)).toEqual([id(1)]);
		expect(reading).toMatchObject({ reads: 3, unknown: 2 });
		f.client.readStoragePoolSpace = async () => {
			throw new Error("LXD storage pool use is invalid");
		};
		await expect(reader.read([placement(1)], signal())).rejects.toThrow("LXD storage pool use is invalid");
		// A disk said to hold more than the whole pool is never named.
		const g = lxd({ use: () => 2000 * GIB });
		const big = await new CompanyMachineDiskReader({ client: g.client, pool: "qorpera-vm" }).read(
			[placement(1)],
			signal(),
		);
		expect(big.report.placements).toEqual({});
	});

	it("credits a disk what it held when read, and the pool counts what was written after: the room is never more than there is", async () => {
		// The disk holds 1 GiB when read; 5 GiB more are written before the pool is read (review r1 F2 of #1773).
		let written = 1 * GIB;
		const client = {
			async readStorageVolumeUse() {
				const held = written;
				written += 5 * GIB;
				return held;
			},
			async readStoragePoolSpace() {
				return { totalBytes: 1000 * GIB, usedBytes: 500 * GIB + written };
			},
		};
		const reading = await new CompanyMachineDiskReader({ client, pool: "qorpera-vm" }).read([placement(1)], signal());
		expect(reading.report.placements[id(1)]).toBe(1 * GIB);
		expect(reading.report.usedBytes).toBe(506 * GIB);
	});
});
