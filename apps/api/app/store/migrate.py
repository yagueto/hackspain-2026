import argparse
import asyncio
import json

from app.config import get_settings
from app.store.postgres import PostgresStore


async def main(apply: bool = False) -> None:
    settings = get_settings()
    if settings.storage_backend != "postgres":
        raise RuntimeError("configura STORAGE_BACKEND=postgres y DATABASE_URL para migrar")
    store = PostgresStore(settings)
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
        description="Inspecciona el almacenamiento configurado; --apply migra el esquema crisis"
    )
    parser.add_argument("--apply", action="store_true")
    asyncio.run(main(parser.parse_args().apply))
