from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_key: str = "dev-secret"
    cors_origins: str = "http://localhost:3000"
    storage_backend: Literal["memory", "twin"] = "memory"
    incident_id: str = "incendio-gredos-demo"
    seed_demo: bool = True
    twin_poll_seconds: float = Field(default=2, ge=0.1)
    twin_batch_size: int = Field(default=100, ge=1, le=250)
    happyrobot_mode: Literal["simulated", "live"] = "simulated"
    public_base_url: str = "http://localhost:8000"

    happyrobot_api_key: str = ""
    happyrobot_cluster: Literal["us", "eu"] = "eu"
    happyrobot_environment: Literal["production", "staging", "development"] = "production"
    happyrobot_wf_call_responder: str = ""
    happyrobot_wf_call_civilian: str = ""
    happyrobot_wf_notify_authority: str = ""
    happyrobot_wf_sms: str = ""
    happyrobot_webhook_secret: str = ""

    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str = ""  # vacío = OpenAI; p.ej. https://api.deepseek.com
    agent_tick_seconds: float = Field(default=10.0, ge=0.1)
    agent_autostart: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def happyrobot_base_url(self) -> str:
        host = (
            "platform.eu.happyrobot.ai"
            if self.happyrobot_cluster == "eu"
            else "platform.happyrobot.ai"
        )
        return f"https://{host}/api/v2"


@lru_cache
def get_settings() -> Settings:
    return Settings()
