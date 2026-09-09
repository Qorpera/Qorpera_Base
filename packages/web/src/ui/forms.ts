type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Preserve drafts and the caret across a refresh of the same view owner. */
export function preserveFormDrafts(container: HTMLElement, owner: string, preserveValues = true): () => void {
	const previous = [...container.querySelectorAll<HTMLElement>("[data-form-owner]")].find(
		(element) => element.dataset.formOwner === owner,
	);
	const drafts = new Map<string, { value: string; focused: boolean; start?: number; end?: number }>();
	for (const field of previous?.querySelectorAll<Field>("[data-draft]") ?? []) {
		drafts.set(field.dataset.draft!, {
			value: field.value,
			focused: field === document.activeElement,
			...(field instanceof HTMLSelectElement
				? {}
				: { start: field.selectionStart ?? undefined, end: field.selectionEnd ?? undefined }),
		});
	}
	return () => {
		for (const field of container.querySelectorAll<Field>("[data-draft]")) {
			const draft = drafts.get(field.dataset.draft!);
			if (!draft) continue;
			if (preserveValues) field.value = draft.value;
			if (draft.focused && !field.disabled) {
				field.focus({ preventScroll: true });
				if (!(field instanceof HTMLSelectElement) && draft.start !== undefined && draft.end !== undefined)
					field.setSelectionRange(draft.start, draft.end);
			}
		}
	};
}

export function clearSubmittedDraft(container: HTMLElement, owner: string, key: string, submitted: string): void {
	const view = [...container.querySelectorAll<HTMLElement>("[data-form-owner]")].find(
		(element) => element.dataset.formOwner === owner,
	);
	const field = [...(view?.querySelectorAll<Field>("[data-draft]") ?? [])].find(
		(element) => element.dataset.draft === key,
	);
	if (field?.value === submitted) field.value = "";
}
