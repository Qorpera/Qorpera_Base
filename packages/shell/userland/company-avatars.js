(() => {
	const avatars = [
		{ id: "agent-halo", label: "Halo", className: "company-agent-avatar-halo" },
		{ id: "agent-bloom", label: "Bloom", className: "company-agent-avatar-bloom" },
		{ id: "agent-folio", label: "Folio", className: "company-agent-avatar-folio" },
		{ id: "agent-pebble", label: "Pebble", className: "company-agent-avatar-pebble" },
	];
	const defaultAvatarId = avatars[0].id;
	const avatarById = new Map(avatars.map((avatar) => [avatar.id, avatar]));
	const normalizedAvatarId = (iconId) => (iconId === "anonymous" ? defaultAvatarId : iconId);

	const baseMakeCompanyIcon = makeCompanyIcon;
	makeCompanyIcon = (iconId, label, className = "") => {
		const avatar = avatarById.get(normalizedAvatarId(iconId));
		if (!avatar) return baseMakeCompanyIcon(iconId, label, className);
		const shell = document.createElement("span");
		shell.className = `company-icon ${className}`.trim();
		const agentAvatar = document.createElement("span");
		agentAvatar.className = `company-agent-avatar ${avatar.className}`;
		agentAvatar.setAttribute("aria-hidden", "true");
		shell.appendChild(agentAvatar);
		if (label) shell.setAttribute("aria-label", `${label} company`);
		return shell;
	};

	function renderAvatarChoices(container, selectedIconId, onSelect) {
		const selected = normalizedAvatarId(selectedIconId);
		container.replaceChildren();
		for (const avatar of avatars) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "company-avatar-option";
			button.setAttribute("aria-label", `${avatar.label} agent avatar`);
			button.setAttribute("aria-pressed", String(avatar.id === selected));
			button.appendChild(makeCompanyIcon(avatar.id, ""));
			button.onclick = () => onSelect(avatar.id, button);
			container.appendChild(button);
		}
	}

	const creatorPicker = $("companyAvatarPicker");
	function syncCreatorPicker() {
		renderAvatarChoices(creatorPicker, companyCreatorIcon, (avatarId) => {
			companyCreatorIcon = avatarId;
			renderCompanyPicturePreview();
		});
	}

	const baseRenderCompanyPicturePreview = renderCompanyPicturePreview;
	renderCompanyPicturePreview = () => {
		baseRenderCompanyPicturePreview();
		syncCreatorPicker();
	};

	const baseOpenCompanyModal = openCompanyModal;
	openCompanyModal = async () => {
		await baseOpenCompanyModal();
		if (companyCreatorIcon === "anonymous") {
			companyCreatorIcon = defaultAvatarId;
			renderCompanyPicturePreview();
		}
	};

	$("companyPictureAnonymous").onclick = () => {
		companyCreatorIcon = defaultAvatarId;
		renderCompanyPicturePreview();
	};
	syncCreatorPicker();

	const baseRenderCompanyTab = renderCompanyTab;
	renderCompanyTab = (content, info) => {
		baseRenderCompanyTab(content, info);
		if (!info.profile?.team) return;
		const section = document.createElement("section");
		section.className = "company-avatar-settings";
		const heading = document.createElement("div");
		heading.className = "company-avatar-settings-heading";
		const title = document.createElement("strong");
		title.textContent = "Company avatar";
		const upload = document.createElement("button");
		upload.type = "button";
		upload.className = "secondary-button";
		upload.textContent = "Upload picture";
		heading.append(title, upload);
		const picker = document.createElement("div");
		picker.className = "company-avatar-picker company-avatar-picker-settings";
		picker.setAttribute("role", "group");
		picker.setAttribute("aria-label", "Choose a company agent avatar");

		const paint = () => {
			renderAvatarChoices(picker, currentCompanyIcon, async (avatarId, button) => {
				for (const choice of picker.querySelectorAll("button")) choice.disabled = true;
				if (await saveCurrentCompanyIcon(avatarId)) paint();
				else for (const choice of picker.querySelectorAll("button")) choice.disabled = false;
				button.blur();
			});
		};
		upload.onclick = () =>
			chooseCompanyPicture(async (picture) => {
				if (await saveCurrentCompanyIcon(picture)) paint();
			});
		paint();
		section.append(heading, picker);
		const people = content.querySelector(".company-people");
		if (people) content.insertBefore(section, people);
		else content.appendChild(section);
	};
})();
