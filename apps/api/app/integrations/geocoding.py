import asyncio
import time

import httpx

from app.config import Settings
from app.domain.models import GeocodedPlace, LocationResolution, ReportedLocation

COARSE_PLACES = {
    "city",
    "town",
    "village",
    "municipality",
    "county",
    "state",
    "country",
    "region",
    "postcode",
}


class NominatimGeocoder:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.enabled = settings.nominatim_demo_enabled and settings.seed_demo
        self._client = client or httpx.AsyncClient(timeout=8)
        self._lock = asyncio.Lock()
        self._last_start = 0.0
        self._cache: dict[str, tuple[float, LocationResolution]] = {}

    async def close(self) -> None:
        await self._client.aclose()

    async def search(self, location: ReportedLocation) -> LocationResolution:
        if not self.enabled or not location.public_search_allowed:
            return LocationResolution()
        query = (
            ", ".join(
                filter(
                    None,
                    [" ".join(filter(None, [location.street, location.number])), location.city],
                )
            )
            if location.street and location.city
            else location.raw_text or ""
        ).strip()
        if not query or len(query) > 500:
            return LocationResolution(
                status="not_found", error="Indica una dirección pública más concreta."
            )
        key = " ".join(query.casefold().split())
        async with self._lock:
            cached = self._cache.get(key)
            if cached and cached[0] > time.monotonic():
                return cached[1].model_copy(deep=True)
            delay = 1.1 - (time.monotonic() - self._last_start)
            if delay > 0:
                await asyncio.sleep(delay)
            self._last_start = time.monotonic()
            try:
                response = await self._client.get(
                    "https://nominatim.openstreetmap.org/search",
                    params={
                        "q": query,
                        "format": "jsonv2",
                        "limit": "3",
                        "countrycodes": "es",
                        "accept-language": "es",
                    },
                    headers={
                        "User-Agent": "HackSpain2026-Demo/0.1 (single-user development)",
                        "Accept": "application/json",
                    },
                )
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, list):
                    raise ValueError("respuesta no válida")
                candidates = []
                for item in data[:3]:
                    if (
                        not isinstance(item, dict)
                        or isinstance(item.get("lat"), bool)
                        or isinstance(item.get("lon"), bool)
                    ):
                        raise ValueError("coordenadas no válidas")
                    candidate = GeocodedPlace(
                        lat=float(item["lat"]),
                        lng=float(item["lon"]),
                        label=item["display_name"],
                        kind=item.get("addresstype", ""),
                    )
                    if candidate not in candidates:
                        candidates.append(candidate)
                selected = (
                    candidates[0]
                    if len(candidates) == 1
                    and candidates[0].kind
                    and candidates[0].kind not in COARSE_PLACES
                    else None
                )
                result = LocationResolution(
                    status="resolved" if selected else "ambiguous" if candidates else "not_found",
                    candidates=candidates,
                    selected=selected,
                )
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                result = LocationResolution(
                    status="unavailable",
                    error=(
                        "No se pudo consultar OpenStreetMap. "
                        "Reintenta más tarde o confirma coordenadas manualmente."
                    ),
                )
            ttl = 30 if result.status == "unavailable" else 3600
            self._cache[key] = (time.monotonic() + ttl, result.model_copy(deep=True))
            if len(self._cache) > 200:
                self._cache.pop(next(iter(self._cache)))
            return result
