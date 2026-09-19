from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_key: str = "dev-secret"
    cors_origins: str = "http://localhost:3000"
    database_path: str = "./crisis.db"
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
    agent_tick_seconds: float = 10.0
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
