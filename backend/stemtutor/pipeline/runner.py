"""Lesson processing pipeline: turns any source into parts + grid + browser media.

Three source kinds share the tail of the pipeline:

* ``midi``  — import MIDI (exact notes/grid); optional reference audio and per-part stems.
* ``stems`` — decode stems -> analyse grid -> transcribe each stem -> render media.
* ``audio`` — fetch/upload -> decode -> separate (optional engine) -> as ``stems``.

Each stage reports progress into ``lesson.json`` so the UI can poll it.
"""

from __future__ import annotations

import logging
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..config import AppConfig
from ..importers.roles import ROLE_ORDER, refine_transcribed_role, stem_role_from_filename
from ..schemas import Lesson, Part, PartMedia, Role
from ..storage import LessonRepo, slugify
from . import ffmpeg
from .cancel import Cancelled

log = logging.getLogger("stemtutor.pipeline")

CANCELLED_MESSAGE = "Обработка отменена."

STAGE_LABELS = {
    "import_midi": "Импорт MIDI",
    "fetch": "Скачивание трека",
    "decode": "Декодирование аудио",
    "separate": "Разделение на стемы",
    "analyze": "Анализ темпа и сетки",
    "transcribe": "Распознавание нот",
    "render": "Подготовка аудио для плеера",
}


class PipelineError(RuntimeError):
    """An error with a message meant for the user."""


@dataclass
class StemFile:
    name: str
    role: Role
    wav: Path
    silent: bool = False
    part_id: str = ""


@dataclass
class Stage:
    key: str
    weight: float
    fn: Callable[["JobContext"], None]


@dataclass
class JobContext:
    repo: LessonRepo
    cfg: AppConfig
    lesson_id: str
    stages: list[Stage]
    stems: list[StemFile] = field(default_factory=list)
    reference_audio: Path | None = None
    cancelled: Callable[[], bool] | None = None
    _offsets: dict[str, tuple[float, float]] = field(default_factory=dict)
    _current: str | None = None
    _last_write: float = 0.0

    def __post_init__(self) -> None:
        total = sum(s.weight for s in self.stages) or 1.0
        acc = 0.0
        for s in self.stages:
            self._offsets[s.key] = (acc / total, s.weight / total)
            acc += s.weight

    # -- paths -------------------------------------------------------------------------
    @property
    def dir(self) -> Path:
        return self.repo.lesson_dir(self.lesson_id)

    def lesson(self) -> Lesson:
        return self.repo.get(self.lesson_id)

    def update(self, fn: Callable[[Lesson], None]) -> Lesson:
        return self.repo.update(self.lesson_id, fn)

    # -- progress ----------------------------------------------------------------------
    def check_cancel(self) -> None:
        if self.cancelled is not None and self.cancelled():
            raise Cancelled()

    def begin(self, key: str) -> None:
        self.check_cancel()
        self._current = key
        start, _ = self._offsets[key]

        def apply(lesson: Lesson) -> None:
            lesson.status = "processing"
            lesson.stage = key
            lesson.stageLabel = STAGE_LABELS.get(key, key)
            lesson.progress = round(start, 4)
            lesson.error = None

        self.update(apply)
        self._last_write = time.monotonic()

    def report(self, fraction: float, label: str | None = None) -> None:
        self.check_cancel()
        if self._current is None:
            return
        now = time.monotonic()
        # A new label (e.g. "downloading the model") is always shown; plain progress is throttled.
        if label is None and now - self._last_write < 0.3 and fraction < 1.0:
            return
        start, width = self._offsets[self._current]
        value = round(start + width * max(0.0, min(1.0, fraction)), 4)

        def apply(lesson: Lesson) -> None:
            lesson.progress = value
            if label:
                lesson.stageLabel = label

        self.update(apply)
        self._last_write = now

    def warn(self, message: str) -> None:
        self.update(lambda lesson: lesson.warnings.append(message))


# ---------------------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------------------


def _stage_import_midi(ctx: JobContext) -> None:
    from ..importers.midi_import import import_midi

    lesson = ctx.lesson()
    path = ctx.dir / str(lesson.source.midiFile)
    result = import_midi(path)

    def apply(les: Lesson) -> None:
        les.parts = result.parts
        les.grid = result.grid
        les.durationSec = max(les.durationSec, result.duration)
        les.warnings.extend(result.warnings)
        if result.title and les.prefs.get("autoTitle"):
            les.title = result.title

    ctx.update(apply)


def _stage_fetch(ctx: JobContext) -> None:
    from .fetch import fetch_audio

    lesson = ctx.lesson()
    url = lesson.source.url
    if not url:
        return
    result = fetch_audio(url, ctx.dir / "source", progress=lambda f: ctx.report(f))
    rel = result.path.relative_to(ctx.dir).as_posix()
    thumb = result.thumbnail.relative_to(ctx.dir).as_posix() if result.thumbnail else None

    def apply(les: Lesson) -> None:
        les.source.audioFile = rel
        if les.prefs.get("autoTitle") and result.title:
            les.title = result.title
        if result.artist and not les.artist:
            les.artist = result.artist
        if thumb:
            les.thumbnail = thumb

    ctx.update(apply)


def _stage_decode_track(ctx: JobContext) -> None:
    """Auto path: the full track -> work/mix.wav (input for separation)."""
    lesson = ctx.lesson()
    if not lesson.source.audioFile:
        raise PipelineError("Не указан аудиофайл или ссылка на трек.")
    src = ctx.dir / lesson.source.audioFile
    _check_length(ffmpeg.probe_duration(src))
    wav = ffmpeg.decode_to_wav(src, ctx.dir / "work" / "mix.wav")
    ctx.reference_audio = src
    duration = ffmpeg.probe_duration(wav)
    ctx.update(lambda les: setattr(les, "durationSec", round(duration, 3)))


MAX_TRACK_SECONDS = 20 * 60  # separation + analysis need ~0.5 GB of RAM per minute


def _check_length(seconds: float) -> None:
    if seconds > MAX_TRACK_SECONDS:
        raise PipelineError(
            f"Трек длиннее {MAX_TRACK_SECONDS // 60} минут ({int(seconds) // 60} мин) — возьмите отдельный трек "
            "или фрагмент, а не микс или альбом целиком."
        )


def _stage_decode_stems(ctx: JobContext) -> None:
    """Materials path: uploaded stems -> work/stems/*.wav (+ silence detection)."""
    from .audio import is_silent

    lesson = ctx.lesson()
    files = lesson.source.stemFiles
    used_ids: set[str] = set()
    for i, rel in enumerate(files):
        src = ctx.dir / rel
        name, role = stem_role_from_filename(Path(rel).name)
        base = slugify(name, "stem")
        pid = f"s{i}-{base}"
        while pid in used_ids:
            pid += "x"
        used_ids.add(pid)
        _check_length(ffmpeg.probe_duration(src))
        wav = ffmpeg.decode_to_wav(src, ctx.dir / "work" / "stems" / f"{pid}.wav")
        ctx.stems.append(StemFile(name=name, role=role, wav=wav, silent=is_silent(wav), part_id=pid))
        ctx.report((i + 1) / max(1, len(files)))
    durations = [ffmpeg.probe_duration(s.wav) for s in ctx.stems]
    if durations:
        ctx.update(lambda les: setattr(les, "durationSec", round(max(durations), 3)))
    if lesson.source.url or lesson.source.audioFile:
        _prepare_reference(ctx)


def _prepare_reference(ctx: JobContext) -> None:
    lesson = ctx.lesson()
    if lesson.source.audioFile:
        ctx.reference_audio = ctx.dir / lesson.source.audioFile


def _stage_separate(ctx: JobContext) -> None:
    from .separate import separate

    lesson = ctx.lesson()
    engine = lesson.source.engine or "auto"
    results = separate(
        engine,
        ctx.dir / "work" / "mix.wav",
        ctx.dir / "work" / "stems",
        progress=lambda f, label=None: ctx.report(f, label),
    )
    from .audio import is_silent

    for i, (name, role, wav) in enumerate(results):
        pid = f"s{i}-{slugify(name, 'stem')}"
        ctx.stems.append(StemFile(name=name, role=role, wav=wav, silent=is_silent(wav), part_id=pid))


def _stage_analyze(ctx: JobContext) -> None:
    from .analyze import analyze_grid

    lesson = ctx.lesson()
    audible = [s for s in ctx.stems if not s.silent]
    if not audible:
        raise PipelineError("Во всех стемах тишина — распознавать нечего.")
    drums = next((s.wav for s in audible if s.role == "drums"), None)
    bass = next((s.wav for s in audible if s.role == "bass"), None)
    mix = ctx.dir / "work" / "mix.wav"
    if not mix.is_file():
        mix = ffmpeg.mix_to_wav([s.wav for s in audible], mix)
    harmonic_stems = [s.wav for s in audible if s.role in ("chords", "other")]
    harmonic = (
        ffmpeg.mix_to_wav(harmonic_stems, ctx.dir / "work" / "harmonic.wav") if harmonic_stems else None
    )
    ctx.report(0.3)
    grid = analyze_grid(
        mix_wav=mix, drums_wav=drums, bass_wav=bass, duration=lesson.durationSec, harmonic_wav=harmonic
    )
    ctx.update(lambda les: setattr(les, "grid", grid))


def _stage_transcribe(ctx: JobContext) -> None:
    from .drums import transcribe_drums
    from .melodic import transcribe_melodic

    audible = [s for s in ctx.stems if not s.silent]
    parts: list[Part] = []
    for i, stem in enumerate(ctx.stems):
        if stem.silent:
            parts.append(
                Part(id=stem.part_id, name=stem.name, role=stem.role, isDrum=stem.role == "drums",
                     origin="transcribed", silent=True)
            )
            continue
        ctx.report(i / max(1, len(ctx.stems)), f"Распознавание: {stem.name}")
        if stem.role == "drums":
            notes = transcribe_drums(stem.wav)
            role: Role = "drums"
        else:
            notes = transcribe_melodic(stem.wav, stem.role)
            role = refine_transcribed_role(stem.role, notes)
        parts.append(
            Part(id=stem.part_id, name=stem.name, role=role, isDrum=role == "drums",
                 origin="transcribed", notes=notes, silent=not notes)
        )
    if not any(p.notes for p in parts) and audible:
        ctx.warn("Не удалось распознать ни одной ноты — проверьте стемы.")
    parts.sort(key=lambda p: (p.silent, ROLE_ORDER.get(p.role, 9)))

    # Put the tracked grid exactly on the transcribed kicks (attack-compensated), so notes,
    # bar lines and the DAW-aligned audio exports agree to the millisecond.
    from .analyze import align_grid_to_hits

    kicks = [n.s for p in parts if p.isDrum for n in p.notes if n.p in (35, 36)]
    lesson = ctx.lesson()
    aligned = align_grid_to_hits(lesson.grid, kicks) if lesson.grid else None

    def apply(les: Lesson) -> None:
        les.parts = parts
        if aligned is not None:
            les.grid = aligned

    ctx.update(apply)


def _stage_render(ctx: JobContext) -> None:
    """Browser media: each stem, a backing ("everything but this part") and the full mix."""
    media_dir = ctx.dir / "media"
    audible = [s for s in ctx.stems if not s.silent]
    total = max(1, 2 * len(audible) + 1)
    done = 0
    stem_media: dict[str, PartMedia] = {}
    # Quiet stems are not worth learning, but they stay in every backing and export so that
    # "backing" really is the track minus one part (a short piano intro, bleed, ambience).
    for stem in ctx.stems:
        if stem.silent:
            stem_media[stem.part_id] = PartMedia(stemWav=stem.wav.relative_to(ctx.dir).as_posix())
    for stem in audible:
        stem_out = ffmpeg.encode_for_browser(stem.wav, media_dir / f"stem_{stem.part_id}.ogg")
        done += 1
        ctx.report(done / total)
        others = [s.wav for s in ctx.stems if s is not stem]
        backing_rel = None
        if others:
            backing = ffmpeg.mix_for_browser(others, media_dir / f"backing_{stem.part_id}.ogg")
            backing_rel = backing.relative_to(ctx.dir).as_posix()
        done += 1
        ctx.report(done / total)
        stem_media[stem.part_id] = PartMedia(
            stem=stem_out.relative_to(ctx.dir).as_posix(),
            backing=backing_rel,
            stemWav=stem.wav.relative_to(ctx.dir).as_posix(),
        )

    mix_rel = None
    mix_wav = ctx.dir / "work" / "mix.wav"
    mix_src: Path | None = mix_wav if mix_wav.is_file() else None
    if ctx.reference_audio and ctx.reference_audio.is_file():
        mix_rel = ffmpeg.encode_for_browser(ctx.reference_audio, media_dir / "mix.ogg").relative_to(ctx.dir).as_posix()
        mix_src = ctx.reference_audio
    elif audible:
        mix_rel = ffmpeg.mix_for_browser([s.wav for s in audible], media_dir / "mix.ogg").relative_to(ctx.dir).as_posix()
    ctx.report(1.0)
    mix_src_rel = mix_src.relative_to(ctx.dir).as_posix() if mix_src else None

    def apply(les: Lesson) -> None:
        if mix_rel:
            les.media["mix"] = mix_rel
        if mix_src_rel:
            les.media["mixWav"] = mix_src_rel
        for part in les.parts:
            if part.id in stem_media:
                part.media = stem_media[part.id]

    ctx.update(apply)


def _stage_midi_media(ctx: JobContext) -> None:
    """MIDI lessons: optional reference track and stems attached to parts by role."""
    lesson = ctx.lesson()
    media_dir = ctx.dir / "media"
    if lesson.source.stemFiles:
        _stage_decode_stems(ctx)
    ref = ctx.dir / lesson.source.audioFile if lesson.source.audioFile else None
    mix_rel = None
    if ref and ref.is_file():
        mix_rel = ffmpeg.encode_for_browser(ref, media_dir / "mix.ogg").relative_to(ctx.dir).as_posix()
        ref_dur = ffmpeg.probe_duration(ref)
        ctx.update(lambda les: setattr(les, "durationSec", round(max(les.durationSec, ref_dur), 3)))
    attached: dict[str, PartMedia] = {}
    audible = [s for s in ctx.stems if not s.silent]
    if audible:
        parts = ctx.lesson().parts
        for stem in audible:
            target = next((p for p in parts if p.role == stem.role and p.id not in attached), None)
            if target is None:
                continue
            stem_out = ffmpeg.encode_for_browser(stem.wav, media_dir / f"stem_{target.id}.ogg")
            others = [s.wav for s in ctx.stems if s is not stem]
            backing = (
                ffmpeg.mix_for_browser(others, media_dir / f"backing_{target.id}.ogg").relative_to(ctx.dir).as_posix()
                if others else None
            )
            attached[target.id] = PartMedia(
                stem=stem_out.relative_to(ctx.dir).as_posix(),
                backing=backing,
                stemWav=stem.wav.relative_to(ctx.dir).as_posix(),
            )
        if not mix_rel:
            mix_rel = ffmpeg.mix_for_browser([s.wav for s in audible], media_dir / "mix.ogg").relative_to(ctx.dir).as_posix()
    mix_src_rel = ref.relative_to(ctx.dir).as_posix() if ref and ref.is_file() else None

    def apply(les: Lesson) -> None:
        if mix_rel:
            les.media["mix"] = mix_rel
        if mix_src_rel:
            les.media["mixWav"] = mix_src_rel
        for part in les.parts:
            if part.id in attached:
                part.media = attached[part.id]

    ctx.update(apply)


# ---------------------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------------------


def _plan(lesson: Lesson) -> list[Stage]:
    kind = lesson.source.kind
    if kind == "midi":
        stages = [Stage("import_midi", 1, _stage_import_midi)]
        if lesson.source.url and not lesson.source.audioFile:
            stages.append(Stage("fetch", 4, _stage_fetch))
        if lesson.source.url or lesson.source.audioFile or lesson.source.stemFiles:
            stages.append(Stage("render", 3, _stage_midi_media))
        return stages
    if kind == "stems":
        stages = []
        if lesson.source.url and not lesson.source.audioFile:
            stages.append(Stage("fetch", 3, _stage_fetch))
        stages += [
            Stage("decode", 1, _stage_decode_stems),
            Stage("analyze", 2, _stage_analyze),
            Stage("transcribe", 6, _stage_transcribe),
            Stage("render", 3, _stage_render),
        ]
        return stages
    stages = []
    if lesson.source.url and not lesson.source.audioFile:
        stages.append(Stage("fetch", 4, _stage_fetch))
    stages += [
        Stage("decode", 1, _stage_decode_track),
        Stage("separate", 10, _stage_separate),
        Stage("analyze", 2, _stage_analyze),
        Stage("transcribe", 6, _stage_transcribe),
        Stage("render", 3, _stage_render),
    ]
    return stages


def process_lesson(
    repo: LessonRepo, cfg: AppConfig, lesson_id: str, cancelled: Callable[[], bool] | None = None
) -> None:
    lesson = repo.get(lesson_id)
    ctx = JobContext(repo=repo, cfg=cfg, lesson_id=lesson_id, stages=_plan(lesson), cancelled=cancelled)
    try:
        for stage in ctx.stages:
            ctx.begin(stage.key)
            stage.fn(ctx)

        def done(les: Lesson) -> None:
            les.status = "ready"
            les.stage = None
            les.stageLabel = None
            les.progress = 1.0
            les.error = None
            les.cancelRequested = False  # a cancel that came after the last check is moot

        ctx.update(done)
    except Cancelled:
        log.info("Lesson %s cancelled", lesson_id)

        def stopped(les: Lesson) -> None:
            les.status = "failed"
            les.error = CANCELLED_MESSAGE
            les.stage = None
            les.stageLabel = None
            les.cancelRequested = False

        ctx.update(stopped)
    except Exception as exc:  # report to the UI, keep a traceback for debugging
        tb = traceback.format_exc()
        log.error("Lesson %s failed: %s\n%s", lesson_id, exc, tb)
        try:
            (ctx.dir / "work").mkdir(parents=True, exist_ok=True)
            (ctx.dir / "work" / "error.log").write_text(tb, encoding="utf-8")
        except OSError:
            pass
        from .fetch import FetchError
        from .separate import SeparationFailed, SeparationUnavailable

        user_facing = (PipelineError, ffmpeg.FfmpegError, ValueError, FetchError, SeparationUnavailable, SeparationFailed)
        message = str(exc) if isinstance(exc, user_facing) else f"Внутренняя ошибка: {type(exc).__name__}: {exc}"

        def failed(les: Lesson) -> None:
            les.status = "failed"
            les.error = message
            les.cancelRequested = False

        ctx.update(failed)
