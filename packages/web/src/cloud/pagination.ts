export interface PageCursor {
	time: string;
	id: string;
}

/** A missing/repeated continuation is a failed read, never a complete list. */
export async function collectPages<T>(
	read: (cursor: PageCursor | undefined) => Promise<{
		items: T[];
		hasMore: boolean;
		nextTime?: string;
		nextId?: string;
	}>,
): Promise<T[]> {
	const items: T[] = [];
	const seen = new Set<string>();
	let cursor: PageCursor | undefined;
	for (;;) {
		const page = await read(cursor);
		items.push(...page.items);
		if (!page.hasMore) return items;
		if (!page.items.length || !page.nextTime || !page.nextId)
			throw new Error("The cloud returned an incomplete page without a continuation.");
		const key = `${page.nextTime}/${page.nextId}`;
		if (seen.has(key)) throw new Error("The cloud page cursor did not advance.");
		seen.add(key);
		cursor = { time: page.nextTime, id: page.nextId };
	}
}
