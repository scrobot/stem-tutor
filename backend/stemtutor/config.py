"""Paths and runtime configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = PACKAGE_DIR.parent
PROJECT_DIR = BACKEND_DIR.parent

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def default_data_dir() -> Path:
    """Short, per-user location on Windows (deep paths break DLL loading and some tools)."""
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return Path(local) / "StemTutor" / "data"
    return PROJECT_DIR / "data"


@dataclass(frozen=True)
class AppConfig:
    data_dir: Path
    frontend_dist: Path

    @property
    def lessons_dir(self) -> Path:
        return self.data_dir / "lessons"

    @property
    def settings_file(self) -> Path:
        return self.data_dir / "settings.json"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def ai_file(self) -> Path:
        """The user's OpenRouter key and model for the AI producer (never sent to the UI)."""
        return self.data_dir / "ai.json"


def load_config(data_dir: Path | str | None = None) -> AppConfig:
    data = Path(data_dir or os.environ.get("STEMTUTOR_DATA") or default_data_dir())
    dist = Path(os.environ.get("STEMTUTOR_FRONTEND") or (PROJECT_DIR / "frontend" / "dist"))
    cfg = AppConfig(data_dir=data.resolve(), frontend_dist=dist.resolve())
    cfg.lessons_dir.mkdir(parents=True, exist_ok=True)
    cfg.models_dir.mkdir(parents=True, exist_ok=True)
    return cfg
