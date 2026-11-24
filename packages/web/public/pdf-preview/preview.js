(() => {
	const app = window.parent;
	if (app === window) return;
	const READY = "qorpera-pdf-preview-ready";
	const DATA = "qorpera-pdf-preview-data";
	let blobUrl = null;
	let shown = false;
	const revoke = () => {
		if (!blobUrl) return;
		URL.revokeObjectURL(blobUrl);
		blobUrl = null;
	};
	window.addEventListener("pagehide", revoke);
	window.addEventListener("message", (event) => {
		if (shown || event.source !== app || event.origin !== location.origin) return;
		const data = event.data;
		if (!data || typeof data !== "object" || data.type !== DATA) return;
		const tag = Object.prototype.toString.call(data.bytes);
		if (tag !== "[object Uint8Array]" && tag !== "[object ArrayBuffer]") return;
		shown = true;
		revoke();
		// WHY: Pin the Blob MIME type to application/pdf so untrusted bytes never render as active HTML.
		blobUrl = URL.createObjectURL(new Blob([data.bytes], { type: "application/pdf" }));
		document.documentElement.style.cssText = "height:100%";
		document.body.style.cssText = "margin:0;height:100%;overflow:hidden";
		const frame = document.createElement("iframe");
		if (typeof data.title === "string" && data.title.length <= 200) frame.title = data.title;
		frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#fff";
		frame.src = blobUrl;
		document.body.replaceChildren(frame);
	});
	const ready = () => app.postMessage({ type: READY }, location.origin);
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
	else ready();
})();
