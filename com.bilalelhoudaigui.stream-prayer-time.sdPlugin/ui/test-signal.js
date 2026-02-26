(() => {
	const toBoolean = (value) => {
		if (typeof value === "boolean") {
			return value;
		}

		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			if (normalized === "false" || normalized === "0" || normalized === "off" || normalized === "unchecked") {
				return false;
			}
			return normalized === "true" || normalized === "1" || normalized === "on" || normalized === "checked";
		}

		return Boolean(value);
	};

	const isNotificationsEnabled = (notificationsToggle) => {
		if (!notificationsToggle) {
			return true;
		}

		if (typeof notificationsToggle.checked === "boolean") {
			return notificationsToggle.checked;
		}

		const checkedAttr = notificationsToggle.getAttribute("checked");
		if (checkedAttr !== null) {
			return true;
		}

		const rawValue = notificationsToggle.value ?? notificationsToggle.getAttribute("value");
		if (rawValue === null || typeof rawValue === "undefined" || rawValue === "") {
			return true;
		}
		return toBoolean(rawValue);
	};

	const init = () => {
		const button = document.getElementById("testSignalButton");
		const field = document.getElementById("testSignalField");
		const notificationsToggle = document.getElementById("notificationsEnabledToggle");

		if (!button || !field) {
			return;
		}

		const syncButtonState = () => {
			const enabled = isNotificationsEnabled(notificationsToggle);
			button.disabled = !enabled;
			button.setAttribute("aria-disabled", String(!enabled));
		};

		syncButtonState();
		notificationsToggle?.addEventListener("input", syncButtonState);
		notificationsToggle?.addEventListener("change", syncButtonState);
		notificationsToggle?.addEventListener("click", () => {
			setTimeout(syncButtonState, 0);
		});

		button.addEventListener("click", () => {
			if (button.disabled) {
				return;
			}
			field.value = String(Date.now());
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
		});
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init, { once: true });
	} else {
		init();
	}
})();
