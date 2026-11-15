// The site door (index.html beside it): waits for one pass from the app that framed it, checks it, and posts it to the
// site's own host in this document, so the frame becomes the site. It says once that it is ready; it takes only a
// message from its parent, of this same origin, and only one.
(() => {
	const app = window.parent;
	if (app === window) return;
	const READY = "qorpera-site-door-ready";
	const PASS = "qorpera-site-door";
	// A site's own host (never a next host), the one path that takes a pass, a pass of base64url, a path of the site.
	const ACTION = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.qorpera\.com\/__qorpera\/member$/;
	const PASS_TEXT = /^[A-Za-z0-9_-]{43}$/;
	const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,511}$/;
	let used = false;
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (used || event.source !== app || event.origin !== location.origin) return;
		if (typeof data !== "object" || data === null || data.type !== PASS) return;
		const { action, pass, path } = data;
		if (typeof action !== "string" || !ACTION.test(action) || typeof pass !== "string" || !PASS_TEXT.test(pass)) return;
		if (path !== undefined && (typeof path !== "string" || !PATH.test(path))) return;
		used = true;
		const form = document.createElement("form");
		form.method = "post";
		form.action = action;
		const field = (name, value) => {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = name;
			input.value = value;
			form.append(input);
		};
		field("pass", pass);
		if (path !== undefined) field("path", path);
		document.body.append(form);
		form.submit();
	});
	const ready = () => app.postMessage({ type: READY }, location.origin);
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
	else ready();
})();
