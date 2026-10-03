# Changelog

## [0.1.0] — 2026-08-27

### Fixed

- **Calendar times now speak your timezone.** Apple Calendar events return raw UTC timestamps (`...Z`), and the voice model — which reads those tool results aloud — was echoing UTC verbatim ("03:00" for an event that's actually at 06:00 in Arusha). Calendar tool results now carry pre-converted, labeled local times (`start_local: "Thu 27 Aug 2026 06:00 (UTC+3)"`), and every session's context states the user's timezone, offset, and abbreviation (e.g. `Africa/Dar_es_Salaam (UTC+3, EAT)`). Applies consistently to chat and voice — both consume the same tool-output path. Stored timestamps remain UTC; only display changes. DST and midnight-crossing conversions are handled by the platform timezone database, with 22 unit tests covering East Africa (+3), negative offsets, fractional offsets (+5:30), and DST transitions.
