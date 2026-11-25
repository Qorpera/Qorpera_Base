import {
	CLOUD_MEMBER_DATA_AT_LIST,
	type CloudMemberDataAtValue,
	type CloudMemberDataTable,
} from "@qorpera/cloud-client/cloud-member-data";
import { withAbortScopes } from "../../cloud/abort-scope.ts";
import type { CompanyDataCalls } from "../company-data.ts";

export interface DataLink {
	readonly column: string;
	readonly table: string;
	readonly to: string;
}

export interface DataLinkedRow {
	readonly columns: readonly string[];
	readonly key: readonly string[];
	readonly values: readonly unknown[];
	readonly seen: string;
}

const isPlain = (value: unknown): value is CloudMemberDataAtValue =>
	typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

const valueKey = (value: unknown) => JSON.stringify(value);

export function tableLinks(
	table: CloudMemberDataTable | undefined,
	tables: readonly CloudMemberDataTable[],
): Map<string, DataLink> {
	const links = new Map<string, DataLink>();
	for (const reference of table?.references ?? []) {
		const [column, ...more] = reference.columns;
		const [to] = reference.to;
		const target = tables.find((one) => one.name === reference.table);
		if (column === undefined || to === undefined || more.length > 0 || links.has(column)) continue;
		if (!target?.columns.some((one) => one.name === to)) continue;
		links.set(column, { column, table: reference.table, to });
	}
	return links;
}

export class DataLinked {
	readonly #calls: () => CompanyDataCalls;
	readonly #signal: AbortSignal;
	readonly #arrived: () => void;
	readonly #rows = new Map<string, Map<string, DataLinkedRow | null>>();
	#stop = new AbortController();

	constructor(calls: () => CompanyDataCalls, signal: AbortSignal, arrived: () => void) {
		this.#calls = calls;
		this.#signal = signal;
		this.#arrived = arrived;
	}

	forget(): void {
		this.#stop.abort();
		this.#stop = new AbortController();
		this.#rows.clear();
	}

	drop(database: string, table: string): void {
		for (const place of [...this.#rows.keys()])
			if (place.startsWith(`${database}/${table}/`)) this.#rows.delete(place);
	}

	row(database: string, link: DataLink, value: unknown): DataLinkedRow | undefined {
		return this.#rows.get(`${database}/${link.table}/${link.to}`)?.get(valueKey(value)) ?? undefined;
	}

	want(database: string, link: DataLink, values: readonly unknown[]): void {
		const place = `${database}/${link.table}/${link.to}`;
		let known = this.#rows.get(place);
		if (!known) {
			known = new Map();
			this.#rows.set(place, known);
		}
		const missing = new Map<string, CloudMemberDataAtValue>();
		for (const value of values) {
			const key = valueKey(value);
			if (isPlain(value) && !known.has(key)) missing.set(key, value);
		}
		const asked = [...missing.values()];
		for (const key of missing.keys()) known.set(key, null);
		for (let from = 0; from < asked.length; from += CLOUD_MEMBER_DATA_AT_LIST)
			void this.#read(database, link, known, asked.slice(from, from + CLOUD_MEMBER_DATA_AT_LIST));
	}

	async #read(
		database: string,
		link: DataLink,
		known: Map<string, DataLinkedRow | null>,
		values: readonly CloudMemberDataAtValue[],
	): Promise<void> {
		const askAgain = (left: Iterable<CloudMemberDataAtValue>) => {
			for (const value of left) if (known.get(valueKey(value)) === null) known.delete(valueKey(value));
		};
		await withAbortScopes([this.#stop.signal, this.#signal], async (signal) => {
			try {
				const page = await this.#calls().rows(
					{ database, table: link.table, at: { [link.to]: values }, limit: CLOUD_MEMBER_DATA_AT_LIST },
					signal,
				);
				if (signal.aborted) return askAgain(values);
				const at = page.columns.indexOf(link.to);
				if (at < 0) return;
				let found = false;
				for (const row of page.rows) {
					if (row.values === null) continue;
					known.set(valueKey(row.values[at]), {
						columns: page.columns,
						key: page.key,
						values: row.values,
						seen: row.seen,
					});
					found = true;
				}
				if (page.more) askAgain(values);
				if (found) this.#arrived();
			} catch (error) {
				const status = (error as { status?: unknown }).status;
				if (status !== 400 && status !== 403 && status !== 404) askAgain(values);
			}
		});
	}
}
