"""Cliente de la API pública de HappyRobot (v2).

Base: https://platform[.eu].happyrobot.ai/api/v2 — auth Bearer con la API key.

Usamos:
- POST /workflows/{id}/runs      -> disparar una llamada (un workflow por tipo de contacto)
- GET  /runs/{id}                -> estado de la ejecución
- POST /runs/{id}/cancel         -> abortar una conversación que ya no procede
- POST /signals/                 -> inyectar contexto nuevo en sesiones activas ("cambió el viento")

Los workflows, al terminar, llaman a nuestro webhook (POST /api/v1/webhooks/happyrobot) con las
variables extraídas de la conversación, incluidos `session_id` y `transcript`: no hace falta
leer las sesiones por nuestra cuenta.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Literal

import httpx

from app.config import Settings

log = logging.getLogger(__name__)

WorkflowKind = Literal["call_responder", "call_civilian", "notify_authority", "send_telegram"]


class HappyRobotError(RuntimeError):
    def __init__(self, message: str, *, ambiguous: bool = False, retryable: bool = False) -> None:
        super().__init__(message)
        self.ambiguous = ambiguous
        self.retryable = retryable


class HappyRobotClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._client = client or httpx.AsyncClient(
            base_url=settings.happyrobot_base_url,
            headers={
                "Authorization": f"Bearer {settings.happyrobot_api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    @property
    def configured(self) -> bool:
        return bool(self.settings.happyrobot_api_key)

    def workflow_id(self, kind: WorkflowKind) -> str:
        s = self.settings
        return {
            "call_responder": s.happyrobot_wf_call_responder,
            "call_civilian": s.happyrobot_wf_call_civilian,
            "notify_authority": s.happyrobot_wf_notify_authority,
            "send_telegram": s.happyrobot_wf_telegram,
        }[kind]

    async def _request(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        if not self.configured:
            raise HappyRobotError("HAPPYROBOT_API_KEY no configurada")
        try:
            resp = await self._client.request(method, path, **kw)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise HappyRobotError("No se pudo conectar con HappyRobot", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise HappyRobotError(
                "Respuesta de HappyRobot desconocida", ambiguous=method == "POST"
            ) from exc
        if resp.status_code >= 400:
            raise HappyRobotError(
                f"{method} {path}: {resp.status_code}",
                ambiguous=method == "POST" and resp.status_code >= 500,
                retryable=resp.status_code == 429,
            )
        try:
            data: dict[str, Any] = resp.json() if resp.content else {}
            if not isinstance(data, dict):
                raise ValueError("respuesta no es objeto")
        except ValueError as exc:
            raise HappyRobotError("Respuesta inválida", ambiguous=method == "POST") from exc
        return data

    # ------------------------------------------------------------ runs

    async def trigger_run(self, workflow_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Dispara un workflow. `payload` llega al trigger del workflow como variables."""
        if not workflow_id:
            raise HappyRobotError("workflow id vacío: configura HAPPYROBOT_WF_*")
        return await self._trigger(workflow_id, payload)

    async def _trigger(self, workflow_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {"payload": payload, "environment": self.settings.happyrobot_environment}
        return await self._request("POST", f"/workflows/{workflow_id}/runs", json=body)

    async def trigger(self, kind: WorkflowKind, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.trigger_run(self.workflow_id(kind), payload)

    async def get_run(self, run_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/runs/{run_id}")

    async def cancel_run(self, run_id: str) -> dict[str, Any]:
        return await self._request("POST", f"/runs/{run_id}/cancel")

    # --------------------------------------------------------- signals

    async def publish_signal(
        self, key: str, payload: dict[str, Any], metadata: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Empuja información nueva a las sesiones activas suscritas a `key`."""
        body: dict[str, Any] = {
            "key": key,
            "payload": payload,
            "env": self.settings.happyrobot_environment,
        }
        if metadata:
            body["metadata"] = metadata
        return await self._request("POST", "/signals/", json=body)

    async def aclose(self) -> None:
        await self._client.aclose()


class FakeHappyRobotClient(HappyRobotClient):
    """Sin API key: simula la plataforma para poder demostrar el flujo end-to-end."""

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings, client=httpx.AsyncClient(base_url="http://fake.invalid"))
        self.calls: list[dict[str, Any]] = []

    @property
    def configured(self) -> bool:
        return True

    async def trigger_run(self, workflow_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._trigger(workflow_id or "wf_fake", payload)

    async def get_run(self, run_id: str) -> dict[str, Any]:
        return {"id": run_id, "status": "running"}

    async def _request(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        self.calls.append({"method": method, "path": path, **kw})
        log.info("FAKE HappyRobot %s %s %s", method, path, kw.get("json"))
        if path.endswith("/runs") and method == "POST":
            return {"run_id": f"fake_{uuid.uuid4().hex[:10]}", "status": "queued"}
        if path == "/signals/":
            return {"status": "published", "published_at": "now"}
        return {"data": []}
