"""SSE para el dashboard: cada cambio de estado se empuja como un evento."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette import EventSourceResponse, ServerSentEvent

from app.runtime import Runtime, get_runtime

router = APIRouter(tags=["stream"])


@router.get("/stream")
async def stream(request: Request, rt: Runtime = Depends(get_runtime)) -> EventSourceResponse:
    if not rt.state.incident:
        raise HTTPException(409, "inicializa el incidente antes de abrir el stream")
    q = rt.state.subscribe()

    async def gen() -> AsyncIterator[ServerSentEvent]:
        try:
            if rt.state.incident:
                yield ServerSentEvent(
                    event="snapshot",
                    data=rt.state.snapshot().model_dump_json(),
                    id=str(rt.state.version),
                )
            while True:
                if await request.is_disconnected():
                    break
                try:
                    change = await asyncio.wait_for(q.get(), timeout=15)
                except TimeoutError:
                    yield ServerSentEvent(comment="keepalive")
                    continue
                yield ServerSentEvent(
                    event=change.type,
                    data=json.dumps(change.data)
                    if change.type == "snapshot"
                    else change.model_dump_json(),
                    id=str(change.version),
                )
        finally:
            rt.state.unsubscribe(q)

    return EventSourceResponse(gen())
