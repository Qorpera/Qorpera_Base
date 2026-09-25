import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	type ComputerUsageRegistry,
	type ComputerUsageSample,
	parseComputerUsageSample,
} from "./computer-usage-sample.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import { checkDirectory, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

/** Immutable, fsynced samples survive a lost reply or process restart. The
 * directory is installed by systemd, never created through a member path. */
export class ComputerUsageOutbox {
	readonly #root: string;
	constructor(root: string) {
		this.#root = root;
	}
	async enqueue(sample: ComputerUsageSample): Promise<void> {
		await checkDirectory(this.#root);
		const value = parseComputerUsageSample(sample);
		const bytes = Buffer.from(JSON.stringify(value));
		const name = `${value.observationId}.json`;
		const names = await readdir(this.#root);
		if (!names.includes(name) && names.filter((item) => item.endsWith(".json")).length >= 4096)
			throw new Error("COMPUTER_USAGE_OUTBOX_FULL");
		if (
			!(await publish(this.#root, name, bytes)) &&
			!(await readRecord(join(this.#root, name), 4096)).bytes.equals(bytes)
		)
			throw new Error("COMPUTER_USAGE_OUTBOX_CONFLICT");
	}
	async flush(registry: ComputerUsageRegistry, signal: AbortSignal): Promise<void> {
		await checkDirectory(this.#root);
		const names = (await readdir(this.#root)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name));
		const records = await Promise.all(
			names.slice(0, 4096).map(async (name) => {
				const sample = parseComputerUsageSample((await readRecord(join(this.#root, name), 4096)).value);
				if (name !== `${sample.observationId}.json`) throw new Error("COMPUTER_USAGE_OUTBOX_ID_DIFFERS");
				return { name, sample };
			}),
		);
		records.sort((a, b) => a.sample.observedAt.localeCompare(b.sample.observedAt) || a.name.localeCompare(b.name));
		for (const { name, sample } of records) {
			signal.throwIfAborted();
			const result = officeRecord(
				await registry.call("qorpera_observe_computer_usage", { p_sample: sample }, signal),
				["observationId", "recorded", "charged", "reason"],
			);
			if (
				result.observationId !== sample.observationId ||
				result.charged !== false ||
				!(
					(result.recorded === true && result.reason === "observed") ||
					(result.recorded === false && (result.reason === "allocation_released" || result.reason === "excluded"))
				)
			)
				throw new Error("COMPUTER_USAGE_RECEIPT_UNCONFIRMED");
			await unlink(join(this.#root, name));
			await syncDirectory(this.#root);
		}
	}
}
