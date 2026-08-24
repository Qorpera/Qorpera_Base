(function setupProductFeedback() {
	const backdrop = document.getElementById("feedbackModal");
	const form = document.getElementById("feedbackForm");
	const closeButton = document.getElementById("feedbackClose");
	const details = document.getElementById("feedbackDetails");
	const diagnostics = document.getElementById("feedbackDiagnostics");
	const status = document.getElementById("feedbackStatus");
	const submit = document.getElementById("feedbackSubmit");
	const categories = [...document.querySelectorAll(".feedback-category")];
	let selectedCategory = null;
	let clientFeedbackId = null;
	let submitting = false;
	let previousFocus = null;

	function updateSubmitState() {
		submit.disabled = submitting || !details.value.trim();
	}

	function selectCategory(button) {
		selectedCategory = button?.dataset.feedbackCategory ?? null;
		for (const category of categories) {
			category.setAttribute("aria-pressed", String(category === button));
		}
	}

	function close() {
		if (submitting || backdrop.hidden) return;
		backdrop.hidden = true;
		const focusTarget =
			previousFocus?.isConnected && !previousFocus.closest?.("[hidden]")
				? previousFocus
				: document.getElementById("companySwitcherButton");
		previousFocus = null;
		focusTarget?.focus?.();
	}

	function open(returnFocus = document.activeElement) {
		previousFocus = returnFocus;
		clientFeedbackId = crypto.randomUUID();
		submitting = false;
		form.reset();
		diagnostics.checked = true;
		selectCategory(null);
		status.textContent = "";
		status.dataset.state = "";
		submit.textContent = "Submit";
		backdrop.hidden = false;
		updateSubmitState();
		details.focus();
	}

	for (const category of categories) {
		category.addEventListener("click", () =>
			selectCategory(category.dataset.feedbackCategory === selectedCategory ? null : category),
		);
	}
	details.addEventListener("input", updateSubmitState);
	closeButton.addEventListener("click", close);
	backdrop.addEventListener("click", (event) => {
		if (event.target === backdrop) close();
	});
	backdrop.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = [...backdrop.querySelectorAll("button:not(:disabled), textarea, input:not(:disabled)")];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first?.focus();
		}
	});
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (submitting || !clientFeedbackId || !details.value.trim()) return;
		submitting = true;
		status.textContent = "";
		status.dataset.state = "";
		submit.textContent = "Sending…";
		form.setAttribute("aria-busy", "true");
		updateSubmitState();
		try {
			const result = await window.qorpera.submitFeedback({
				clientFeedbackId,
				category: selectedCategory ?? "other",
				details: details.value,
				includeDiagnostics: diagnostics.checked,
			});
			if (!result?.ok) throw new Error(result?.error ?? "Feedback could not be sent.");
			status.dataset.state = "success";
			status.textContent = "Feedback sent. Thank you.";
			submit.textContent = "Sent";
			setTimeout(() => {
				submitting = false;
				close();
			}, 900);
		} catch (error) {
			submitting = false;
			status.textContent = error instanceof Error ? error.message : "Feedback could not be sent.";
			submit.textContent = "Try again";
			updateSubmitState();
		} finally {
			form.removeAttribute("aria-busy");
		}
	});

	window.qorperaFeedback = Object.freeze({ open });
	if (location.hash === "#feedback-preview") {
		if (!window.qorpera) {
			window.qorpera = Object.freeze({
				submitFeedback: async () => ({ ok: true, feedbackId: crypto.randomUUID() }),
			});
		}
		open();
	}
})();
