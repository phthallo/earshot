# Venue Locator (Android)

Wifi fingerprint client for the venue map. It signs in with the pair code from the web app, scans nearby access points every 10 s and posts them to the bridge, which places the person in a zone on the map. Learn mode lets a volunteer label zones to build the training set.

Android only. iOS has no public wifi scan API, so this cannot be ported.

## Build

1. Open the `android` folder in Android Studio (Ladybug or newer).
2. Let it sync. The Gradle wrapper jar is not committed, so either accept Android Studio's offer to create the wrapper, or run `gradle wrapper --gradle-version 8.9` in this folder first.
3. Enable USB debugging on the phone, plug it in, press Run.

## On the phone

- Developer options > Networking > Wi-Fi scan throttling: off. Otherwise Android allows 4 scans per 2 minutes and the app shows a throttling notice.
- Location: on. Android 10+ returns an empty scan list when location is off.
- Open the app, set the bridge URL (default `http://10.0.0.2:8080`, plain http is allowed), enter the pair code from the web app, sign in.
- Turn on Tracking. Grant the location permission (and nearby devices / notifications on Android 13+). A persistent notification shows while scanning.
- Learn mode: pick a zone, press Record here to send 3 labelled scans. Long press or the trash icon deletes a zone's samples.

## Bridge API

`POST /api/fp/login`, `GET /api/fp/zones`, `POST /api/fp/learn`, `POST /api/fp/locate`, `POST /api/fp/forget`. See `Api.kt`.
