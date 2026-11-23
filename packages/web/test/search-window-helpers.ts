export function stubDialogs(): void {
	Element.prototype.scrollIntoView ??= () => {};
	const dialog = HTMLDialogElement.prototype;
	dialog.showModal = function (this: HTMLDialogElement) {
		this.open = true;
	};
	dialog.close = function (this: HTMLDialogElement) {
		if (!this.open) return;
		this.open = false;
		this.dispatchEvent(new Event("close"));
	};
}

export function searchWindow(): HTMLDialogElement | null {
	return document.querySelector<HTMLDialogElement>("dialog.search-window");
}

export function searchFromRail(rail: HTMLElement, query: string): string[] {
	stubDialogs();
	rail.querySelector<HTMLButtonElement>(".rail-search-toggle")!.click();
	const window = searchWindow()!;
	const input = window.querySelector<HTMLInputElement>(".search-window-input")!;
	input.value = query;
	input.dispatchEvent(new Event("input"));
	const titles = [...window.querySelectorAll(".search-window-title")].map((title) => title.textContent ?? "");
	window.close();
	return titles;
}
