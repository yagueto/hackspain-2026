import argparse
import asyncio
import json

from app.config import get_settings
from app.store.twin import TwinStore


async def main(apply: bool = False) -> None:
    settings = get_settings()
    if not settings.happyrobot_api_key:
        raise RuntimeError("HAPPYROBOT_API_KEY requerida para migrar Twin")
    store = TwinStore(settings)
    try:
        tables = await store.inspect_schema()
        print(json.dumps([t.model_dump() for t in tables], ensure_ascii=False, indent=2))
        if apply:
            await store.migrate()
            await store.open()
            print("Esquema crisis v1 aplicado")
    finally:
        await store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Inspecciona Twin; --apply migra el esquema crisis"
    )
    parser.add_argument("--apply", action="store_true")
    asyncio.run(main(parser.parse_args().apply))
