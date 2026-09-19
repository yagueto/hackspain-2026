from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

import httpx

from app.config import Settings

_sending = ContextVar("telegram_webhook_request", default=False)


class _RedactWebhook(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if _sending.get():
            record.msg = "Telegram webhook HTTP request (URL redacted)"
            record.args = ()
        return True


logging.getLogger("httpx").addFilter(_RedactWebhook())


class TelegramError(RuntimeError):
    def __init__(self, message: str, *, ambiguous: bool = False, retryable: bool = False) -> None:
        super().__init__(message)
        self.ambiguous = ambiguous
        self.retryable = retryable


class TelegramWebhookClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._url = settings.telegram_webhook_url.get_secret_value()
        if settings.telegram_mode == "live":
            try:
                url = httpx.URL(self._url)
                valid = (
                    url.scheme == "https"
                    and bool(url.host)
                    and not url.userinfo
                    and not url.fragment
                )
            except httpx.InvalidURL:
                valid = False
            if not valid:
                raise ValueError("TELEGRAM_WEBHOOK_URL debe ser una URL HTTPS sin credenciales")
        self._client = client or httpx.AsyncClient(timeout=15, follow_redirects=False)
        self.calls: list[dict[str, Any]] = []

    @property
    def configured(self) -> bool:
        return self.settings.telegram_mode == "simulated" or bool(self._url)

    async def send(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.settings.telegram_mode == "simulated":
            self.calls.append(dict(payload))
            return {"status": "accepted", "simulated": True, "delivery_confirmed": False}
        headers = {"Idempotency-Key": str(payload["command_id"])}
        if secret := self.settings.telegram_webhook_secret.get_secret_value():
            headers["X-Webhook-Secret"] = secret
        token = _sending.set(True)
        try:
            response = await self._client.post(
                self._url, json=payload, headers=headers, follow_redirects=False
            )
        except (httpx.ConnectError, httpx.ConnectTimeout):
            raise TelegramError("No se pudo conectar al webhook Telegram", retryable=True) from None
        except httpx.HTTPError:
            raise TelegramError(
                "Resultado del webhook Telegram desconocido", ambiguous=True
            ) from None
        finally:
            _sending.reset(token)
        if not 200 <= response.status_code < 300:
            raise TelegramError(
                f"Webhook Telegram devolvió HTTP {response.status_code}",
                ambiguous=response.status_code >= 500,
                retryable=response.status_code == 429,
            )
        return {
            "status": "accepted",
            "status_code": response.status_code,
            "delivery_confirmed": False,
        }

    async def aclose(self) -> None:
        await self._client.aclose()
