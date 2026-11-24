export const DEFAULT_TOOL_JSON_MAX_BYTES = 64 * 1024;

export function cloudToolJsonText(value: unknown, limit = DEFAULT_TOOL_JSON_MAX_BYTES): string {
	let nodes = 0;
	let remainingBytes = limit;
	const account = (text: string): string => {
		remainingBytes -= Buffer.byteLength(text);
		if (remainingBytes < 0) throw new Error("Tool JSON exceeds its byte limit");
		return text;
	};
	const ancestors = new Set<object>();
	const encode = (item: unknown, depth: number): string => {
		if (++nodes > 10_000 || depth > 32) throw new Error("Invalid tool JSON");
		if (typeof item === "string" && Buffer.byteLength(item) > limit)
			throw new Error("Tool JSON exceeds its byte limit");
		if (item === null || typeof item === "boolean" || typeof item === "string") return account(JSON.stringify(item));
		if (typeof item === "number" && Number.isFinite(item)) return account(JSON.stringify(item));
		if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error("Invalid tool JSON");
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				if (item.length > 10_000 || Object.keys(item).length !== item.length) throw new Error("Invalid tool JSON");
				account(`[]${",".repeat(Math.max(0, item.length - 1))}`);
				const entries: string[] = [];
				for (let index = 0; index < item.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(item, index);
					if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid tool JSON");
					entries.push(encode(descriptor.value, depth + 1));
				}
				return `[${entries.join(",")}]`;
			}
			if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
				throw new Error("Invalid tool JSON");
			}
			const keys = Object.keys(item);
			if (keys.length > 10_000) throw new Error("Invalid tool JSON");
			account(`{}${",".repeat(Math.max(0, keys.length - 1))}`);
			return `{${keys
				.sort()
				.map((key) => {
					const descriptor = Object.getOwnPropertyDescriptor(item, key);
					if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid tool JSON");
					return `${account(`${JSON.stringify(key)}:`)}${encode(descriptor.value, depth + 1)}`;
				})
				.join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	};
	return encode(value, 0);
}
