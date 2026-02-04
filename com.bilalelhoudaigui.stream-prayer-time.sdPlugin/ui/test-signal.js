(() => {
	const init = () => {
		const button = document.getElementById("testSignalButton");
		const field = document.getElementById("testSignalField");

		if (!button || !field) {
			return;
		}

		button.addEventListener("click", () => {
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
