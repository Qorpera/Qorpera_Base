export type Work = (action: () => Promise<void>) => Promise<void>;
export function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
	...children: Node[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	node.append(...children);
	return node;
}
export function button(label: string, action: () => Promise<void>, work: Work): HTMLButtonElement {
	const node = element("button", label);
	node.type = "button";
	node.onclick = () => {
		void work(action);
	};
	return node;
}
export function input(label: string, value = ""): { label: HTMLLabelElement; input: HTMLInputElement } {
	const node = element("input");
	node.value = value;
	node.autocomplete = "off";
	const text = element("label", label, node);
	return { label: text, input: node };
}
export function textPreview(bytes: Uint8Array): string {
	try {
		if (bytes.length > 32768) throw new Error();
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.includes("\0")) throw new Error();
		return text;
	} catch {
		return "Binary or large file. Download and inspect the proposed file before approving.";
	}
}
