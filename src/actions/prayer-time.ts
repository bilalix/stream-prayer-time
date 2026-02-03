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
};

// Small cache entry so multiple keys can share a single API response.
type CachedTimings = {
	dateKey: string;
	fetchedAt: number;
	timings: Timings;
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
	private readonly timingsCache = new Map<string, CachedTimings>();
	private readonly geocodeCache = new Map<string, CachedGeocode>();

	override async onWillAppear(ev: WillAppearEvent<PrayerSettings>): Promise<void> {
		// Make sure we have a full settings object and persist defaults on first run.
		const settings = this.normalizeSettings(ev.payload.settings);
		await ev.action.setSettings(settings);

		// Start periodic updates and do an immediate refresh for the visible key.
		this.startOrResetTimer(ev.action.id, ev.action, settings);
		await this.refreshTitle(ev.action, settings);
	}

	override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<PrayerSettings>,
	): Promise<void> {
		// When the user changes settings in the Property Inspector, refresh immediately.
		const settings = this.normalizeSettings(ev.payload.settings);
		this.startOrResetTimer(ev.action.id, ev.action, settings);
		await this.refreshTitle(ev.action, settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<PrayerSettings>): void {
		// Clean up any timers when the key is removed or the user switches pages.
		const timer = this.updateTimers.get(ev.action.id);
		if (timer) {
			clearInterval(timer);
			this.updateTimers.delete(ev.action.id);
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

			const timings = await this.getTimings(settings);
			const prayerKey = PRAYER_KEY_BY_NAME[settings.prayer];
			const rawTime = timings[prayerKey];

			if (!rawTime) {
				throw new Error(`Missing timing for ${settings.prayer}`);
			}

			const formattedTime = this.formatTime(rawTime, settings.timeFormat);
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
	private async getTimings(settings: Required<PrayerSettings>): Promise<Timings> {
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
	): Promise<Timings> {
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

		return data.data.timings;
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
	private formatTime(rawTime: string, format: TimeFormat): string {
		// Some APIs append timezone data like "05:13 (AST)"; we only want HH:MM.
		const [timePart] = rawTime.split(" ");
		const [hh, mm] = timePart.split(":").map((value) => Number(value));

		if (Number.isNaN(hh) || Number.isNaN(mm)) {
			return timePart;
		}

		if (format === "24h") {
			return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
		}

		const hour12 = ((hh + 11) % 12) + 1;
		const suffix = hh >= 12 ? "PM" : "AM";
		return `${hour12}:${mm.toString().padStart(2, "0")} ${suffix}`;
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
};

type Timings = {
	Fajr: string;
	Dhuhr: string;
	Asr: string;
	Maghrib: string;
	Isha: string;
};

type AladhanResponse = {
	code: number;
	status: string;
	data?: {
		timings?: Timings;
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
