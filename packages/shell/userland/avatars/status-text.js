"use strict";

(() => {
	const rendered = new WeakMap();
	const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

	function render(element, lead, detail, message) {
		const previous = rendered.get(element);
		if (previous?.lead === message.lead && previous?.detail === message.detail && previous.leadNode === lead && previous.detailNode === detail) return;
		rendered.set(element, { ...message, leadNode: lead, detailNode: detail });
		// Assistive technology gets one intact tooltip, not individual letters.
		element.setAttribute("aria-label", message.lead + message.detail);
		let index = 0;
		for (const [container, text] of [[lead, message.lead], [detail, message.detail]]) {
			container.replaceChildren();
			container.setAttribute("aria-hidden", "true");
			for (const part of text.split(/(\s+)/u)) {
				if (!part) continue;
				if (/^\s+$/u.test(part)) {
					container.append(document.createTextNode(part));
					index += part.length;
					continue;
				}
				const word = document.createElement("span");
				word.className = "status-wave-word";
				for (const { segment } of graphemes.segment(part)) {
					const letter = document.createElement("span");
					letter.className = "status-wave-letter";
					letter.textContent = segment;
					letter.style.setProperty("--wave-delay", `${(index++ * 37.5) % 1400 - 1400}ms`);
					word.append(letter);
				}
				container.append(word);
			}
		}
	}

	window.QORPERA_STATUS_TEXT = Object.freeze({ render });
})();
