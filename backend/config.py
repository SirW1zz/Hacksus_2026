import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

# Load .env from project root (one level up)
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    gemini_api_key: str = ""
    deepgram_api_key: str = ""
    mongodb_uri: str = ""
    mongodb_db_name: str = "interview_agent"
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000


settings = Settings()
