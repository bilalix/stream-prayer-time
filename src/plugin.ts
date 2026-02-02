import streamDeck from "@elgato/streamdeck";

import { PrayerTimeAction } from "./actions/prayer-time";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register the prayer time action.
streamDeck.actions.registerAction(new PrayerTimeAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
