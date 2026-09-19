"""SSE para el dashboard: cada cambio de estado se empuja como un evento."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Request
from sse_starlette import EventSourceResponse, ServerSentEvent

from app.runtime import Runtime, get_runtime

router = APIRouter(tags=["stream"])


@router.get("/stream")
async def stream(request: Request, rt: Runtime = Depends(get_runtime)) -> EventSourceResponse:
    q = rt.state.subscribe()

    async def gen() -> AsyncIterator[ServerSentEvent]:
        try:
            if rt.state.incident:
                yield ServerSentEvent(event="snapshot", data=rt.state.snapshot().model_dump_json())
            while True:
                if await request.is_disconnected():
                    break
                try:
                    change = await asyncio.wait_for(q.get(), timeout=15)
                except TimeoutError:
                    yield ServerSentEvent(comment="keepalive")
                    continue
                yield ServerSentEvent(event=change.type, data=change.model_dump_json())
        finally:
            rt.state.unsubscribe(q)

    return EventSourceResponse(gen())
