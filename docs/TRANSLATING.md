# Translating Moondog

Moondog replies in English, Spanish, and Simplified Chinese.
This page explains how a reply picks its language, and how to add another one.

## How a reply picks its language

The model writes its own replies in whatever language you use.
Moondog itself writes the text it must vouch for: Spotify receipts, confirmations, errors, and safety notes.
That text comes from message catalogs, one file per language.

For each message, Moondog decides the reply language in this order:

1. An explicit request, such as "reply in Spanish", "responde en inglés", or "用中文回答".
2. The message's script: Han characters mean Chinese.
3. Common words and commands, such as "pon", "quiero", "the", or "play", scored per language.
4. Your chosen language, from `/language`, then `MOONDOG_LANGUAGE`, then your system's `LANG`.

Quoted titles and track metadata are removed before any of this, because song names travel across languages.

## Where the pieces live

| File | What it holds |
| --- | --- |
| `src/i18n/index.mjs` | Supported languages, language detection, and the translator. |
| `src/i18n/messages/en.mjs` | The English source catalog. Every key starts here. |
| `src/i18n/messages/<code>.mjs` | One catalog per language, with the same keys. |
| `src/i18n/preferences.mjs` | The saved `/language` choice. |
| `src/core/spotify-listening-intent.mjs` | Words Moondog reads itself: "cancel", "retry", "the third one", "another version". |
| `src/integrations/spotify/service.mjs` | Device words such as "altavoz" or "手机". |

## Adding a language

1. Copy `src/i18n/messages/en.mjs` to `src/i18n/messages/<code>.mjs`, using the two-letter ISO 639-1 code.
2. Translate every value.
   Keep each key and each parameter name.
   Functions may reorder parameters and handle plurals however the language needs.
3. Register the language in `LOCALES` and `CATALOGS` in `src/i18n/index.mjs`.
4. Add its name to `LANGUAGE_NAMES`, and, for a Latin-script language, its common words and commands to `WORDS` and `COMMANDS`.
   A language with its own script only needs a script check in `messageLocale`.
5. Add the words Moondog must understand on its own: cancelling a queue, retrying, choosing a numbered result, asking for another version, and device names.
   These are safety rails, so a stop phrase in your language must never be missed.
6. Add cases to `tests/core/i18n.test.mjs`, and a conversation test like the Spanish ones in `tests/runtime/pi-open-world-listening.test.mjs`.

The catalog test fails if a language is missing a key or changes a value's shape.
A missing key falls back to English at runtime, so a partial translation still works.

## Style

Write the way a friend who knows records would talk: plain, warm, and exact.
Use the informal "you" where the language has one, such as "tú" in Spanish.
Keep artist, album, song, and playlist names exactly as they are.
Use plain hyphens, never em dashes.
Say exactly what happened on Spotify; receipts must never overstate an action.

## Not translated yet

Menus, the import guide, and other screen text are still English.
They move into the same catalogs next.
