import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from app.config import Settings
from app.domain.models import ReportedLocation
from app.integrations.geocoding import NominatimGeocoder


async def test_disabled_geocoding_never_reaches_the_provider():
    handler = AsyncMock(return_value=httpx.Response(200, json=[]))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        geocoder = NominatimGeocoder(Settings(geocoding_enabled=False), client)
        result = await geocoder.search(ReportedLocation(raw_text="Lugar de prueba"))
    assert result.status == "not_requested"
    handler.assert_not_called()


async def test_configured_endpoint_replaces_the_public_demo_provider():
    """Fuera de la demo las direcciones deben poder ir a una instancia propia."""
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=[])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        geocoder = NominatimGeocoder(
            Settings(geocoding_endpoint="https://geocoder.interno/search"), client
        )
        await geocoder.search(ReportedLocation(raw_text="Calle X 1"))
    assert requests[0].url.host == "geocoder.interno"


async def test_unique_public_location_uses_cache_and_rate_limit(monkeypatch):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(
            200,
            json=[
                {
                    "lat": "40.1",
                    "lon": "-4.2",
                    "display_name": "Plaza pública de prueba",
                    "addresstype": "square",
                }
            ],
        )

    sleep = AsyncMock()
    monkeypatch.setattr("app.integrations.geocoding.asyncio.sleep", sleep)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        geocoder = NominatimGeocoder(Settings(), client)
        location = ReportedLocation(raw_text="Plaza pública de prueba")
        first = await geocoder.search(location)
        second = await geocoder.search(location)
        other = await geocoder.search(
            location.model_copy(update={"raw_text": "Otro lugar público"})
        )
    assert first.status == second.status == other.status == "resolved"
    assert first.selected.lat == 40.1
    assert len(requests) == 2
    assert requests[0].headers["User-Agent"].startswith("HackSpain")
    assert requests[0].url.params["limit"] == "3"
    sleep.assert_awaited_once()
    assert 0 < sleep.await_args.args[0] <= 1.1


@pytest.mark.parametrize(
    "results,status",
    [
        ([], "not_found"),
        ([{"lat": "40", "lon": "-4", "display_name": "Precisión desconocida"}], "ambiguous"),
        (
            [{"lat": "40", "lon": "-4", "display_name": "Ciudad", "addresstype": "city"}],
            "ambiguous",
        ),
        (
            [
                {"lat": "40", "lon": "-4", "display_name": "Plaza A"},
                {"lat": "41", "lon": "-5", "display_name": "Plaza B"},
            ],
            "ambiguous",
        ),
        ([{"lat": "NaN", "lon": "-4", "display_name": "Inválido"}], "unavailable"),
        ([{"lat": True, "lon": "-4", "display_name": "Inválido"}], "unavailable"),
    ],
)
async def test_ambiguous_coarse_and_invalid_results_never_select_a_destination(results, status):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=results))
    ) as client:
        geocoder = NominatimGeocoder(Settings(), client)
        result = await geocoder.search(ReportedLocation(raw_text="Lugar público"))
    assert result.status == status
    assert result.selected is None


async def test_provider_failure_is_bounded_and_cached():
    handler = AsyncMock(return_value=httpx.Response(429))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        geocoder = NominatimGeocoder(Settings(), client)
        location = ReportedLocation(raw_text="Lugar público")
        results = await asyncio.gather(geocoder.search(location), geocoder.search(location))
    assert all(result.status == "unavailable" for result in results)
    handler.assert_awaited_once()
