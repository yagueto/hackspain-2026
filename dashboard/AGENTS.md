# Dashboard

- Angular 22 standalone components with signals and lazy-loaded routes. Run commands from `dashboard/`.
- The existing development server is `ng serve` at `http://localhost:4200/`. Preserve that server and port; do not start a second instance unnecessarily.
- Verify with `npm run build`, `npm test -- --watch=false`, and `npm exec --no -- prettier --check "src/**/*.{ts,html,css}"`.
- UI text is Spanish. Keep feature templates and styles separate and use the shared icon component.
- `Home.addresses` is the string-array signal for incoming addresses. `OperationalMap` accepts `addresses` and optional coordinate-bearing `locations`. Known coordinates avoid geocoding requests.
- Leaflet uses its ESM distribution, with types re-exported in `src/leaflet.d.ts`. Tiles are provided by OpenStreetMap and must retain attribution.
- The public Nominatim endpoint is only for this low-volume, single-user demo: one request at a time, at least 1100 ms between starts, no polling or autocomplete, and session caching. Never send confidential addresses. Policy: https://operations.osmfoundation.org/policies/nominatim/ .
- Before multi-user production, move geocoding to a backend with application-wide rate limiting/caching or a suitable hosted/self-managed provider. The endpoint is configurable through the `geocoding-endpoint` meta tag in the served index and the `GEOCODING_ENDPOINT` injection token; replacement endpoints must return Nominatim-compatible results.
- Demo locations and communications are simulated, not real operational data. Future sections remain disabled until their routes and screens are implemented.
- Shared pagination uses `PaginatedList` with `ResizeObserver` and each list's `--page-row-height`; card heights must use the same variable. Reserve space for the pager even on a single page to avoid resize loops. The one-column breakpoint is 800px, with five items per page and fixed panel heights on mobile.
- The dashboard starts without an incident or resource selection. Keep the single demo indicator in the topbar; do not repeat demo disclaimers throughout the panels.
