(() => {
	const STEP = 5;
	const MIN = -30;
	const MAX = 30;

	const clamp = (value) => Math.max(MIN, Math.min(MAX, value));

	const parseValue = (raw) => {
		const numeric = typeof raw === "number" ? raw : Number(raw);
		return Number.isFinite(numeric) ? numeric : 0;
	};

	const updateInput = (input, value) => {
		const clamped = clamp(value);
		input.value = String(clamped);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const init = () => {
		const input = document.getElementById("offsetInput");
		const minus = document.getElementById("offsetMinus");
		const plus = document.getElementById("offsetPlus");
		const reset = document.getElementById("offsetReset");

		if (!input || !minus || !plus || !reset) {
			return;
		}

		minus.addEventListener("click", () => {
			updateInput(input, parseValue(input.value) - STEP);
		});

		plus.addEventListener("click", () => {
			updateInput(input, parseValue(input.value) + STEP);
		});

		reset.addEventListener("click", () => {
			updateInput(input, 0);
		});
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init, { once: true });
	} else {
		init();
	}
})();
