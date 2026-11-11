"""Lesson data model shared by the pipeline, the API and (mirrored) the web UI.

Notes use compact keys because a lesson may hold tens of thousands of them:
``p`` MIDI pitch (GM drum note for drum parts), ``s``/``e`` start/end in seconds,
``v`` velocity 1..127.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Role = Literal["drums", "bass", "chords", "melody", "vocal", "other"]
Status = Literal["queued", "processing", "ready", "failed"]
SourceKind = Literal["audio", "stems", "midi"]
GridOrigin = Literal["midi", "tracked", "manual", "default"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Note(BaseModel):
    p: int
    s: float
    e: float
    v: int = 100


class Grid(BaseModel):
    """Quarter-note beat grid. ``beats[i]`` is the time (s) of quarter note ``i``."""

    beats: list[float]
    barLength: float = 4.0  # bar length in quarter notes (6/8 -> 3.0)
    timeSig: tuple[int, int] = (4, 4)
    firstDownbeat: int = 0  # index into ``beats`` where bar 1 starts
    bpm: float = 120.0
    origin: GridOrigin = "default"


class PartMedia(BaseModel):
    stem: Optional[str] = None  # isolated audio of this part for the browser (lesson-relative)
    backing: Optional[str] = None  # everything except this part, for the browser
    stemWav: Optional[str] = None  # lossless source of ``stem`` (used for DAW exports)


class Part(BaseModel):
    id: str
    name: str
    role: Role
    isDrum: bool = False
    program: Optional[int] = None
    origin: Literal["midi", "transcribed"] = "midi"
    notes: list[Note] = Field(default_factory=list)
    media: PartMedia = Field(default_factory=PartMedia)
    silent: bool = False


class SourceInfo(BaseModel):
    kind: SourceKind
    url: Optional[str] = None  # track URL (auto) or reference URL (materials)
    audioFile: Optional[str] = None  # uploaded track (auto) or reference audio (materials)
    midiFile: Optional[str] = None
    stemFiles: list[str] = Field(default_factory=list)
    engine: Optional[str] = None  # separation engine for the auto path


class Lesson(BaseModel):
    id: str
    title: str
    artist: Optional[str] = None
    createdAt: str = Field(default_factory=now_iso)
    updatedAt: str = Field(default_factory=now_iso)
    source: SourceInfo
    status: Status = "queued"
    stage: Optional[str] = None
    stageLabel: Optional[str] = None
    progress: float = 0.0
    error: Optional[str] = None
    cancelRequested: bool = False  # saved, so a restart does not resume a cancelled lesson
    warnings: list[str] = Field(default_factory=list)
    durationSec: float = 0.0
    grid: Optional[Grid] = None
    media: dict[str, str] = Field(default_factory=dict)  # e.g. {"mix": "media/mix.mp3"}
    parts: list[Part] = Field(default_factory=list)
    thumbnail: Optional[str] = None
    prefs: dict[str, Any] = Field(default_factory=dict)  # UI-owned per-lesson preferences


class LessonSummary(BaseModel):
    id: str
    title: str
    artist: Optional[str] = None
    createdAt: str
    status: Status
    stage: Optional[str] = None
    stageLabel: Optional[str] = None
    progress: float = 0.0
    error: Optional[str] = None
    cancelRequested: bool = False
    sourceKind: SourceKind
    durationSec: float = 0.0
    bpm: Optional[float] = None
    roles: list[str] = Field(default_factory=list)
    partCount: int = 0
    thumbnail: Optional[str] = None

    @classmethod
    def of(cls, lesson: Lesson) -> "LessonSummary":
        return cls(
            id=lesson.id,
            title=lesson.title,
            artist=lesson.artist,
            createdAt=lesson.createdAt,
            status=lesson.status,
            stage=lesson.stage,
            stageLabel=lesson.stageLabel,
            progress=lesson.progress,
            error=lesson.error,
            cancelRequested=lesson.cancelRequested,
            sourceKind=lesson.source.kind,
            durationSec=lesson.durationSec,
            bpm=lesson.grid.bpm if lesson.grid else None,
            roles=[p.role for p in lesson.parts if not p.silent],
            partCount=sum(1 for p in lesson.parts if not p.silent),
            thumbnail=lesson.thumbnail,
        )


class PartPatch(BaseModel):
    id: str
    name: Optional[str] = None
    role: Optional[Role] = None


class LessonPatch(BaseModel):
    title: Optional[str] = None
    artist: Optional[str] = None
    grid: Optional[Grid] = None
    parts: Optional[list[PartPatch]] = None
    prefs: Optional[dict[str, Any]] = None


class Settings(BaseModel):
    """Global user settings (instrument choice, calibrations, UI preferences)."""

    instrumentId: str = "akai-mpk-mini-mk3"
    midiInputName: Optional[str] = None
    calibrations: dict[str, dict[str, Any]] = Field(default_factory=dict)
    ui: dict[str, Any] = Field(default_factory=dict)
