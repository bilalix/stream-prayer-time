import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";

// The prayer names we allow the user to select in the Property Inspector.
const PRAYER_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;
type PrayerName = (typeof PRAYER_NAMES)[number];

// Mapping from our friendly prayer names to the API timing keys.
const PRAYER_KEY_BY_NAME: Record<PrayerName, keyof Timings> = {
	Fajr: "Fajr",
	Dhuhr: "Dhuhr",
	Asr: "Asr",
	Maghrib: "Maghrib",
	Isha: "Isha",
};

const NOTIFICATION_IMAGE = "imgs/actions/prayer-time/notification-icon.png";
const SIGNAL_BLINK_MS = 500;

// Default settings that will be persisted the first time the action appears.
const DEFAULT_SETTINGS: Required<PrayerSettings> = {
	city: "Mecca",
	country: "Saudi Arabia",
	method: 4, // Umm al-Qura University (Makkah)
	madhab: 0, // 0 = Shafi (default), 1 = Hanafi
	prayer: "Fajr",
	showPrayerName: true,
	timeFormat: "24h",
	refreshMinutes: 10,
	offsetMinutes: 0,
	testSignal: "",
	signalDurationSeconds: 10,
};

// Small cache entry so multiple keys can share a single API response.
type CachedTimings = {
	dateKey: string;
	fetchedAt: number;
	timings: TimingsResult;
};

type CachedGeocode = {
	fetchedAt: number;
	result: GeocodeResult;
};

/**
 * Displays a single prayer time (e.g., Fajr) on the Stream Deck key.
 *
 * Notes:
 * - The action is a SingletonAction so one class instance handles all keys of this action type.
 * - We cache API responses for a short time to avoid flooding the API when multiple keys are present.
 * - Each key has its own refresh timer so titles stay up-to-date.
 */
@action({ UUID: "com.bilalelhoudaigui.stream-prayer-time.prayer-time" })
export class PrayerTimeAction extends SingletonAction<PrayerSettings> {
	private readonly updateTimers = new Map<string, NodeJS.Timeout>();
	private readonly signalTimers = new Map<string, NodeJS.Timeout>();
	private readonly timingsCache = new Map<string, CachedTimings>();
	private readonly geocodeCache = new Map<string, CachedGeocode>();
	private readonly signalChecksInFlight = new Set<string>();
	private readonly lastSignalKey = new Map<string, string>();
	private readonly lastTestSignalByAction = new Map<string, string>();

	override async onWillAppear(ev: WillAppearEvent<PrayerSettings>): Promise<void> {
		// Make sure we have a full settings object and persist defaults on first run.
		const settings = this.normalizeSettings(ev.payload.settings);
		await ev.action.setSettings(settings);

		// Start periodic updates and do an immediate refresh for the visible key.
		this.startOrResetTimer(ev.action.id, ev.action, settings);
		this.startOrResetSignalTimer(ev.action.id, ev.action, settings);
		await this.refreshTitle(ev.action, settings);
	}

	override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<PrayerSettings>,
	): Promise<void> {
		// When the user changes settings in the Property Inspector, refresh immediately.
		const settings = this.normalizeSettings(ev.payload.settings);
		this.startOrResetTimer(ev.action.id, ev.action, settings);
		this.startOrResetSignalTimer(ev.action.id, ev.action, settings);

		const testSignal = ev.payload.settings.testSignal;
		if (typeof testSignal === "string" && testSignal.trim() !== "") {
			if (this.lastTestSignalByAction.get(ev.action.id) !== testSignal) {
				this.lastTestSignalByAction.set(ev.action.id, testSignal);
				await this.startBlink(ev.action, settings.signalDurationSeconds);
			}

			const clearedSettings = { ...settings, testSignal: "" };
			await ev.action.setSettings(clearedSettings);
		}
		await this.refreshTitle(ev.action, settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<PrayerSettings>): void {
		// Clean up any timers when the key is removed or the user switches pages.
		const timer = this.updateTimers.get(ev.action.id);
		if (timer) {
			clearInterval(timer);
			this.updateTimers.delete(ev.action.id);
		}

		const signalTimer = this.signalTimers.get(ev.action.id);
		if (signalTimer) {
			clearInterval(signalTimer);
			this.signalTimers.delete(ev.action.id);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<PrayerSettings>): Promise<void> {
		// Treat a key press as a manual refresh: clear cache for this location and update.
		const settings = this.normalizeSettings(ev.payload.settings);
		const location = await this.geocode(settings);
		this.timingsCache.delete(this.buildCacheKey(settings, location));
		await this.refreshTitle(ev.action, settings);
	}

	/**
	 * Starts or resets the per-key update timer.
	 */
	private startOrResetTimer(
		context: string,
		action: WillAppearEvent<PrayerSettings>["action"],
		settings: Required<PrayerSettings>,
	): void {
		const existing = this.updateTimers.get(context);
		if (existing) {
			clearInterval(existing);
		}

		const minutes = Math.max(1, settings.refreshMinutes);
		const intervalMs = minutes * 60 * 1000;

		// Store the interval so we can clean it up on disappear.
		const timer = setInterval(() => {
			void this.refreshTitle(action, settings);
		}, intervalMs);
		this.updateTimers.set(context, timer);
	}

	/**
	 * Fetches timings (with caching) and updates the key title.
	 */
	private async refreshTitle(
		action: WillAppearEvent<PrayerSettings>["action"],
		settings: Required<PrayerSettings>,
	): Promise<void> {
		try {
			// Show a transient "Loading" state in case the API is slow.
			await action.setTitle("Loading...");

			const result = await this.getTimings(settings);
			const prayerKey = PRAYER_KEY_BY_NAME[settings.prayer];
			const rawTime = result.timings[prayerKey];

			if (!rawTime) {
				throw new Error(`Missing timing for ${settings.prayer}`);
			}

			const formattedTime = this.formatTime(
				rawTime,
				settings.timeFormat,
				settings.offsetMinutes,
			);
			const title = settings.showPrayerName
				? `${settings.prayer}\n${formattedTime}`
				: formattedTime;

			await action.setTitle(title);
		} catch (error) {
			// If anything goes wrong, display a short error and log details for debugging.
			await action.setTitle("Err");
			streamDeck.logger.error(`Failed to update prayer time: ${String(error)}`);
		}
	}

	/**
	 * Gets timings from the cache if still fresh; otherwise calls the API.
	 */
	private async getTimings(settings: Required<PrayerSettings>): Promise<TimingsResult> {
		const location = await this.geocode(settings);
		const cacheKey = this.buildCacheKey(settings, location);
		const now = Date.now();
		const dateKey = this.getLocalDateKey();

		const cached = this.timingsCache.get(cacheKey);
		const maxAgeMs = settings.refreshMinutes * 60 * 1000;

		if (cached && cached.dateKey === dateKey && now - cached.fetchedAt < maxAgeMs) {
			return cached.timings;
		}

		const timings = await this.fetchTimings(settings, location);
		this.timingsCache.set(cacheKey, { dateKey, fetchedAt: now, timings });
		return timings;
	}

	/**
	 * Calls the Aladhan API for prayer timings by latitude and longitude.
	 * Docs: https://aladhan.com/prayer-times-api
	 */
	private async fetchTimings(
		settings: Required<PrayerSettings>,
		location: GeocodeResult,
	): Promise<TimingsResult> {
		const url = new URL("https://api.aladhan.com/v1/timings");
		url.searchParams.set("latitude", location.lat);
		url.searchParams.set("longitude", location.lon);
		url.searchParams.set("method", String(settings.method));
		url.searchParams.set("school", String(settings.madhab));
		streamDeck.logger.info(`Fetching prayer timings from API: ${url.toString()}`);

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`API request failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as AladhanResponse;
		if (data.code !== 200 || !data.data?.timings) {
			throw new Error(`API response missing timings`);
		}

		streamDeck.logger.info(`Fetched new prayer timings for ${settings.city}, ${settings.country}`);

		streamDeck.logger.info(`API response: ${JSON.stringify(data)}`);

		return {
			timings: data.data.timings,
			timezone: data.data.meta?.timezone,
		};
	}

	/**
	 * Resolves city/country to coordinates using Nominatim.
	 * We cache results to avoid repeated geocoding calls.
	 */
	private async geocode(settings: Required<PrayerSettings>): Promise<GeocodeResult> {
		const cacheKey = this.buildGeocodeKey(settings);
		const cached = this.geocodeCache.get(cacheKey);
		const now = Date.now();
		const maxAgeMs = 24 * 60 * 60 * 1000; // 24h cache for geocoding

		if (cached && now - cached.fetchedAt < maxAgeMs) {
			return cached.result;
		}

		const url = new URL("https://nominatim.openstreetmap.org/search");
		url.searchParams.set("format", "json");
		url.searchParams.set("limit", "1");
		url.searchParams.set("city", settings.city);
		url.searchParams.set("country", settings.country);

		const response = await fetch(url, {
			headers: {
				// Nominatim requires a valid User-Agent identifying the application.
				"User-Agent": "stream-prayer-time/0.1 (Stream Deck plugin)",
			},
		});

		if (!response.ok) {
			throw new Error(`Geocode request failed: ${response.status} ${response.statusText}`);
		}

		const results = (await response.json()) as NominatimResult[];
		const match = results[0];
		if (!match?.lat || !match?.lon) {
			throw new Error("Geocode failed: city/country not found");
		}

		const location: GeocodeResult = {
			lat: match.lat,
			lon: match.lon,
			displayName: match.display_name ?? `${settings.city}, ${settings.country}`,
		};

		this.geocodeCache.set(cacheKey, { fetchedAt: now, result: location });
		return location;
	}

	/**
	 * Converts an API time string (e.g., "05:13") to 24h or 12h format.
	 */
	private formatTime(rawTime: string, format: TimeFormat, offsetMinutes: number): string {
		// Some APIs append timezone data like "05:13 (AST)"; we only want HH:MM.
		const [timePart] = rawTime.split(" ");
		const [hh, mm] = timePart.split(":").map((value) => Number(value));

		if (Number.isNaN(hh) || Number.isNaN(mm)) {
			return timePart;
		}

		const totalMinutes = hh * 60 + mm + offsetMinutes;
		const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
		const hours = Math.floor(wrapped / 60);
		const minutes = wrapped % 60;

		if (format === "24h") {
			return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
		}

		const hour12 = ((hours + 11) % 12) + 1;
		const suffix = hours >= 12 ? "PM" : "AM";
		return `${hour12}:${minutes.toString().padStart(2, "0")} ${suffix}`;
	}

	/**
	 * Starts or resets a short interval that checks when the prayer time hits, then signals.
	 */
	private startOrResetSignalTimer(
		context: string,
		action: WillAppearEvent<PrayerSettings>["action"],
		settings: Required<PrayerSettings>,
	): void {
		const existing = this.signalTimers.get(context);
		if (existing) {
			clearInterval(existing);
		}

		const timer = setInterval(() => {
			void this.checkAndSignal(context, action, settings);
		}, 30 * 1000);

		this.signalTimers.set(context, timer);
	}

	/**
	 * Checks if the current time matches the configured prayer time and blinks the key image.
	 */
	private async checkAndSignal(
		context: string,
		action: WillAppearEvent<PrayerSettings>["action"],
		settings: Required<PrayerSettings>,
	): Promise<void> {
		if (this.signalChecksInFlight.has(context)) {
			return;
		}

		this.signalChecksInFlight.add(context);
		try {
			const result = await this.getTimings(settings);
			const prayerKey = PRAYER_KEY_BY_NAME[settings.prayer];
			const rawTime = result.timings[prayerKey];
			if (!rawTime) {
				return;
			}

			const targetMinutes = this.parseTimeToMinutes(rawTime, settings.offsetMinutes);
			if (targetMinutes === null) {
				return;
			}

			const now = this.getCurrentMinutes(result.timezone);
			if (now === null) {
				return;
			}

			if (now === targetMinutes) {
				const dateKey = this.getDateKey(result.timezone);
				const signalKey = `${dateKey}|${settings.prayer}|${targetMinutes}`;
				if (this.lastSignalKey.get(context) === signalKey) {
					return;
				}

				this.lastSignalKey.set(context, signalKey);
				await this.startBlink(action, settings.signalDurationSeconds);
			}
		} catch (error) {
			streamDeck.logger.error(`Failed to signal prayer time: ${String(error)}`);
		} finally {
			this.signalChecksInFlight.delete(context);
		}
	}

	private async startBlink(
		action: WillAppearEvent<PrayerSettings>["action"],
		durationSeconds: number,
	): Promise<void> {
		if (!action.isKey()) {
			return;
		}

		const durationMs = Math.max(1, durationSeconds) * 1000;
		let showNotification = false;
		const interval = setInterval(() => {
			showNotification = !showNotification;
			void action.setImage(showNotification ? NOTIFICATION_IMAGE : undefined);
		}, SIGNAL_BLINK_MS);

		setTimeout(() => {
			clearInterval(interval);
			void action.setImage(undefined);
		}, durationMs);
	}

	/**
	 * Parses the API time string into total minutes, applying an offset.
	 */
	private parseTimeToMinutes(rawTime: string, offsetMinutes: number): number | null {
		const [timePart] = rawTime.split(" ");
		const [hh, mm] = timePart.split(":").map((value) => Number(value));
		if (Number.isNaN(hh) || Number.isNaN(mm)) {
			return null;
		}

		const totalMinutes = hh * 60 + mm + offsetMinutes;
		return ((totalMinutes % 1440) + 1440) % 1440;
	}

	/**
	 * Returns the current minutes since midnight for the given timezone (or local if missing).
	 */
	private getCurrentMinutes(timezone?: string): number | null {
		try {
			const formatter = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			const parts = formatter.formatToParts(new Date());
			const hourPart = parts.find((part) => part.type === "hour")?.value;
			const minutePart = parts.find((part) => part.type === "minute")?.value;
			const hours = Number(hourPart);
			const minutes = Number(minutePart);
			if (Number.isNaN(hours) || Number.isNaN(minutes)) {
				return null;
			}
			return hours * 60 + minutes;
		} catch {
			const now = new Date();
			return now.getHours() * 60 + now.getMinutes();
		}
	}

	private getDateKey(timezone?: string): string {
		try {
			const formatter = new Intl.DateTimeFormat("en-CA", {
				timeZone: timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			});
			const parts = formatter.formatToParts(new Date());
			const year = parts.find((part) => part.type === "year")?.value ?? "0000";
			const month = parts.find((part) => part.type === "month")?.value ?? "00";
			const day = parts.find((part) => part.type === "day")?.value ?? "00";
			return `${year}-${month}-${day}`;
		} catch {
			return this.getLocalDateKey();
		}
	}

	/**
	 * Generates a cache key so identical locations/methods share the same timings.
	 */
	private buildCacheKey(settings: Required<PrayerSettings>, location: GeocodeResult): string {
		return [
			location.lat,
			location.lon,
			settings.method,
			settings.madhab,
		].join("|");
	}

	/**
	 * Cache key for geocoding requests.
	 */
	private buildGeocodeKey(settings: Required<PrayerSettings>): string {
		return [settings.city.toLowerCase(), settings.country.toLowerCase()].join("|");
	}

	/**
	 * Returns a local date key (YYYY-MM-DD) so we refresh when the day changes.
	 */
	private getLocalDateKey(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}

	/**
	 * Ensures all settings are present by filling in defaults.
	 */
	private normalizeSettings(settings: PrayerSettings): Required<PrayerSettings> {
		// SDPI controls often return string values, so parse numbers defensively.
		const method = this.toNumber(settings.method, DEFAULT_SETTINGS.method);
		const madhab = this.toNumber(settings.madhab, DEFAULT_SETTINGS.madhab);
		const refreshMinutes = this.toNumber(settings.refreshMinutes, DEFAULT_SETTINGS.refreshMinutes);
		const offsetMinutes = this.toNumber(settings.offsetMinutes, DEFAULT_SETTINGS.offsetMinutes);

		return {
			city: settings.city?.trim() || DEFAULT_SETTINGS.city,
			country: settings.country?.trim() || DEFAULT_SETTINGS.country,
			method,
			madhab,
			prayer: PRAYER_NAMES.includes(settings.prayer as PrayerName)
				? (settings.prayer as PrayerName)
				: DEFAULT_SETTINGS.prayer,
			showPrayerName:
				typeof settings.showPrayerName === "boolean"
					? settings.showPrayerName
					: DEFAULT_SETTINGS.showPrayerName,
			timeFormat: settings.timeFormat === "12h" ? "12h" : DEFAULT_SETTINGS.timeFormat,
			refreshMinutes: Math.max(1, refreshMinutes),
			offsetMinutes: Math.max(-30, Math.min(30, offsetMinutes)),
			testSignal: typeof settings.testSignal === "string" ? settings.testSignal : "",
			signalDurationSeconds: this.clampNumber(
				settings.signalDurationSeconds,
				DEFAULT_SETTINGS.signalDurationSeconds,
				1,
				300,
			),
		};
	}

	/**
	 * Converts SDPI string/number values into a number, with a safe fallback.
	 */
	private toNumber(value: unknown, fallback: number): number {
		const numeric =
			typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
		return Number.isFinite(numeric) ? numeric : fallback;
	}

	private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
		const numeric = this.toNumber(value, fallback);
		return Math.max(min, Math.min(max, numeric));
	}
}

type TimeFormat = "24h" | "12h";

type PrayerSettings = {
	city?: string;
	country?: string;
	method?: number;
	madhab?: number;
	prayer?: PrayerName;
	showPrayerName?: boolean;
	timeFormat?: TimeFormat;
	refreshMinutes?: number;
	offsetMinutes?: number;
	testSignal?: string;
	signalDurationSeconds?: number;
};

type Timings = {
	Fajr: string;
	Dhuhr: string;
	Asr: string;
	Maghrib: string;
	Isha: string;
};

type TimingsResult = {
	timings: Timings;
	timezone?: string;
};

type AladhanResponse = {
	code: number;
	status: string;
	data?: {
		timings?: Timings;
		meta?: {
			timezone?: string;
		};
	};
};

type GeocodeResult = {
	lat: string;
	lon: string;
	displayName: string;
};

type NominatimResult = {
	lat: string;
	lon: string;
	display_name?: string;
};
