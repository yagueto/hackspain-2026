from fastapi import Depends, Header, HTTPException, status

from app.runtime import Runtime, get_runtime


def require_api_key(
    rt: Runtime = Depends(get_runtime),
    x_api_key: str | None = Header(default=None),
) -> None:
    if rt.settings.api_key and x_api_key != rt.settings.api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "X-API-Key inválida")
