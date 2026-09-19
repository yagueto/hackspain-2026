import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta
from unittest.mock import AsyncMock

import httpx
import pytest

from app.agent.llm import Review, TaskAdjustment
from app.agent.planner import Proposal
from app.config import Settings
from app.domain.models import (
    Action,
    ActionKind,
    ActionStatus,
    AgentMode,
    EventKind,
    Observation,
    ResourceStatus,
    ResourceType,
    Task,
    TaskKind,
    TaskStatus,
    now,
)
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.integrations.happyrobot import FakeHappyRobotClient, HappyRobotClient
from app.main import build_runtime
from app.runtime import Runtime
from app.store.persistence import MemoryStore, StoreError


@pytest.fixture
async def runtime() -> AsyncIterator[Runtime]:
    store = MemoryStore()
    state = WorldState()
    seed_wildfire(state)
    await store.create(state.snapshot(full=True))
    rt = build_runtime(Settings(agent_autostart=False), state=state, store=store)
    yield rt
    await rt.hr.aclose()


def observation(rt: Runtime, kind: EventKind = EventKind.note, **kwargs: object) -> Observation:
    return Observation.model_validate(
        {
            "incident_id": rt.orchestrator.incident_id,
            "kind": kind,
            "title": "informe",
            **kwargs,
        }
    )


async def test_duplicate_observation_no_duplicate_decision_or_assignment(runtime: Runtime) -> None:
    rt = runtime
    obs = observation(rt, EventKind.injured_reported, zone_id="zone_camping", payload={"count": 3})
    await rt.orchestrator.ingest(obs)
    await rt.orchestrator.tick()
    original = rt.state.snapshot(full=True)
    await rt.orchestrator.ingest(obs)
    await rt.orchestrator.tick()
    assert rt.state.zones["zone_camping"].injured == 3
    assert len(rt.state.decisions) == len(original.recent_decisions)
    assert len(rt.state.actions) == len(original.recent_actions)


async def test_simultaneous_ticks_and_approvals_never_double_reserve(runtime: Runtime) -> None:
    rt = runtime
    await asyncio.gather(*(rt.orchestrator.tick() for _ in range(4)))
    tasks = [t for t in rt.state.tasks.values() if t.resource_ids]
    ids = [rid for t in tasks for rid in t.resource_ids]
    assert len(ids) == len(set(ids))
    evacuation = next(t for t in rt.state.tasks.values() if t.kind == TaskKind.evacuate_zone)
    assert evacuation.status == TaskStatus.awaiting_approval
    assert evacuation.resource_ids == []
    results = await asyncio.gather(
        rt.orchestrator.approve(evacuation.id, True),
        rt.orchestrator.approve(evacuation.id, True),
        return_exceptions=True,
    )
    assert sum(isinstance(result, ValueError) for result in results) == 1
    assert len(rt.state.tasks[evacuation.id].resource_ids) == 1


async def test_late_and_uncorrelated_available_do_not_free_unit(runtime: Runtime) -> None:
    rt = runtime
    await rt.orchestrator.tick()
    resource = next(r for r in rt.state.resources.values() if r.assigned_task_id)
    task_id = resource.assigned_task_id
    stale = observation(
        rt,
        EventKind.resource_status,
        observed_at=now() - timedelta(hours=1),
        payload={"resource_id": resource.id, "status": "available"},
    )
    await rt.orchestrator.ingest(stale)
    await rt.orchestrator.synchronize()
    assert rt.state.resources[resource.id].assigned_task_id == task_id
    assert (
        next(
            r
            for r in await rt.store.receipts(rt.orchestrator.incident_id)
            if r.observation_id == stale.observation_id
        ).status
        == "ignored"
    )
    fresh = observation(
        rt, EventKind.resource_status, payload={"resource_id": resource.id, "status": "available"}
    )
    await rt.orchestrator.ingest(fresh)
    await rt.orchestrator.synchronize()
    assert rt.state.resources[resource.id].status == ResourceStatus.reserved
    assert rt.state.resources[resource.id].reported_status == ResourceStatus.available
    confirmed = observation(
        rt,
        EventKind.resource_status,
        payload={"resource_id": resource.id, "status": "available", "task_id": task_id},
    )
    await rt.orchestrator.ingest(confirmed)
    await rt.orchestrator.synchronize()
    assert rt.state.resources[resource.id].assigned_task_id is None
    assert rt.state.tasks[task_id].status == TaskStatus.done


async def test_cancel_run_does_not_release_dispatched_unit(runtime: Runtime) -> None:
    rt = runtime
    await rt.orchestrator.tick()
    task = next(t for t in rt.state.tasks.values() if t.resource_ids)
    async with rt.orchestrator.edit() as state:
        await rt.executor.bind(state).cancel_task(state.tasks[task.id], "cancelar")
    await rt.orchestrator.dispatch_pending()
    assert rt.state.resources[task.resource_ids[0]].assigned_task_id == task.id
    assert rt.state.tasks[task.id].status == TaskStatus.cancelled
    assert any(a.kind == ActionKind.internal for a in rt.state.actions.values())


async def test_observation_during_llm_review_discards_stale_plan(runtime: Runtime) -> None:
    rt = runtime

    async def review(*args: object) -> Review | None:
        if not await rt.store.receipts(rt.orchestrator.incident_id):
            await rt.orchestrator.ingest(
                observation(
                    rt,
                    EventKind.fire_spread,
                    payload={"front_id": "front_sur", "contained_pct": 100},
                )
            )
        return None

    rt.orchestrator.reviewer.review = review
    decision = await rt.orchestrator.tick()
    assert decision.trigger == "revalidated"
    assert not any(t.zone_id == "front_sur" for t in rt.state.tasks.values())


async def test_revalidation_reuses_review_when_context_unchanged(runtime: Runtime) -> None:
    rt = runtime
    calls = 0

    async def review(*args: object) -> Review:
        nonlocal calls
        calls += 1
        if calls == 1:
            # Observación que se descarta al aplicarse: no añade evento ni cambia propuestas.
            await rt.orchestrator.ingest(
                observation(
                    rt,
                    EventKind.resource_status,
                    payload={
                        "resource_id": "res_bomba1",
                        "status": ResourceStatus.available,
                        "task_id": "task_inexistente",
                    },
                )
            )
        return Review(situation_summary="plan", next_action="extinción")

    rt.orchestrator.reviewer.review = review
    decision = await rt.orchestrator.tick()
    assert decision.trigger == "revalidated"
    assert calls == 1
    assert decision.situation_summary == "plan"


async def test_revalidation_reviews_again_when_new_event_arrives(runtime: Runtime) -> None:
    rt = runtime
    calls = 0

    async def review(*args: object) -> Review:
        nonlocal calls
        calls += 1
        if calls == 1:
            await rt.orchestrator.ingest(
                observation(
                    rt,
                    EventKind.fire_spread,
                    payload={"front_id": "front_sur", "contained_pct": 100},
                )
            )
        return Review(situation_summary="plan", next_action="extinción")

    rt.orchestrator.reviewer.review = review
    decision = await rt.orchestrator.tick()
    assert decision.trigger == "revalidated"
    assert calls == 2


async def test_llm_cannot_allocate_incompatible_resource(runtime: Runtime) -> None:
    rt = runtime
    rt.orchestrator.reviewer.review = AsyncMock(
        return_value=Review(
            situation_summary="plan",
            next_action="extinción",
            tasks=[TaskAdjustment(index=0, priority=100, resource_id="res_amb1")],
        )
    )
    await rt.orchestrator.tick()
    for task in rt.state.tasks.values():
        for rid in task.resource_ids:
            assert rt.state.resources[rid].type in task.resource_types


async def test_store_failure_prevents_external_send_and_uncommitted_sse(runtime: Runtime) -> None:
    rt = runtime
    queue = rt.state.subscribe()
    rt.store.save = AsyncMock(side_effect=StoreError("offline"))
    with pytest.raises(StoreError):
        await rt.orchestrator.tick()
    assert rt.state.tasks == {}
    assert not rt.state.integrations["storage"]
    assert all(change.type != "snapshot" for change in list(queue._queue))
    assert isinstance(rt.hr, FakeHappyRobotClient)
    assert rt.hr.calls == []


async def test_ambiguous_timeout_never_retries(runtime: Runtime) -> None:
    rt = runtime
    calls = 0

    def timeout(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("timeout después de enviar", request=request)

    client = httpx.AsyncClient(base_url="https://fake.test", transport=httpx.MockTransport(timeout))
    hr = HappyRobotClient(
        Settings(happyrobot_api_key="test", happyrobot_wf_call_civilian="call"), client
    )
    rt.executor.hr = hr
    async with rt.orchestrator.edit() as state:
        action = await rt.executor.bind(state).call(
            Task(kind=TaskKind.other, title="aviso"), state.contacts["ct_camping"]
        )
    await rt.orchestrator.dispatch_pending()
    await rt.orchestrator.dispatch_pending()
    assert calls == 1
    assert rt.state.actions[action.id].status == ActionStatus.unknown
    await hr.aclose()


async def test_known_connect_failure_retries_with_limit(runtime: Runtime) -> None:
    rt = runtime

    def unavailable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin conexión", request=request)

    client = httpx.AsyncClient(
        base_url="https://fake.test", transport=httpx.MockTransport(unavailable)
    )
    hr = HappyRobotClient(
        Settings(happyrobot_api_key="test", happyrobot_wf_call_civilian="call"), client
    )
    rt.executor.hr = hr
    async with rt.orchestrator.edit() as state:
        action = await rt.executor.bind(state).call(
            Task(kind=TaskKind.other, title="aviso"), state.contacts["ct_camping"]
        )
    for _ in range(4):
        async with rt.orchestrator.edit() as state:
            state.actions[action.id].next_attempt_at = now() - timedelta(seconds=1)
        await rt.orchestrator.dispatch_pending()
    assert rt.state.actions[action.id].attempts == 3
    assert rt.state.actions[action.id].status == ActionStatus.failed
    await hr.aclose()


async def test_pending_order_revalidated_before_send_and_pause(runtime: Runtime) -> None:
    rt = runtime
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.paused
        task = Task(kind=TaskKind.dispatch_resource, title="extinción", zone_id="front_sur")
        await rt.executor.bind(state).execute(Proposal(task, [ResourceType.fire_engine]), {})
    await rt.orchestrator.dispatch_pending()
    assert all(a.status == ActionStatus.pending for a in rt.state.actions.values())
    await rt.orchestrator.ingest(
        observation(
            rt, EventKind.fire_spread, payload={"front_id": "front_sur", "contained_pct": 100}
        )
    )
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.running
    await rt.orchestrator.dispatch_pending()
    assert all(a.status == ActionStatus.skipped for a in rt.state.actions.values())
    assert rt.state.tasks[task.id].status == TaskStatus.cancelled
    assert isinstance(rt.hr, FakeHappyRobotClient)
    assert rt.hr.calls == []


async def test_polling_operates_while_agent_paused(runtime: Runtime) -> None:
    rt = runtime
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.paused
    obs = observation(rt, EventKind.road_blocked, payload={"road_id": "road_av923"})
    await rt.store.observe(obs)
    queue = rt.state.subscribe()
    rt.orchestrator.poll_seconds = 0.01
    rt.orchestrator.start()
    try:
        change = await asyncio.wait_for(queue.get(), timeout=2)
        assert change.type == "snapshot"
        assert change.version > 1
        assert not rt.state.roads["road_av923"].open
        assert not rt.state.actions
    finally:
        await rt.orchestrator.stop()


async def test_expired_command_is_not_sent(runtime: Runtime) -> None:
    async with runtime.orchestrator.edit() as state:
        action = Action(
            kind=ActionKind.telegram,
            summary="caducada",
            workflow="send_telegram",
            expires_at=now() - timedelta(seconds=1),
        )
        state.upsert_action(action)
    await runtime.orchestrator.dispatch_pending()
    assert runtime.state.actions[action.id].status == ActionStatus.skipped
