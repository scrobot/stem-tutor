"""Command line entry point: ``stemtutor serve`` / ``stemtutor doctor``."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

from . import __version__
from .config import DEFAULT_HOST, DEFAULT_PORT, load_config


def _quiet_connection_resets(record: logging.LogRecord) -> bool:
    """Browsers abort media range requests when seeking; on Windows asyncio logs each as a
    scary ConnectionResetError traceback (WinError 10054). It is harmless — drop it."""
    exc = record.exc_info[1] if record.exc_info else None
    return not isinstance(exc, ConnectionResetError) and "WinError 10054" not in record.getMessage()


def _lock_data_dir(data_dir: Path):
    """One server per data folder. A second one would resume the first one's lessons and
    rewrite the files it is encoding. The OS drops the lock when the process ends."""
    data_dir.mkdir(parents=True, exist_ok=True)
    fh = open(data_dir / ".lock", "a+b")  # noqa: SIM115 - held for the process lifetime
    try:
        if os.name == "nt":
            import msvcrt

            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh


def _is_stemtutor(url: str) -> bool:
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(url + "api/health", timeout=2) as resp:  # noqa: S310 - local URL
            return "engines" in json.loads(resp.read().decode("utf-8"))
    except Exception:
        return False


def _serve(args: argparse.Namespace) -> int:
    import socket

    import uvicorn

    from .server import create_app

    logging.getLogger("asyncio").addFilter(_quiet_connection_resets)

    cfg = load_config(args.data)
    url = f"http://{args.host}:{args.port}/"
    url_file = cfg.data_dir / ".url"  # where the running instance listens (the lock file is locked)
    lock = _lock_data_dir(cfg.data_dir)
    if lock is None:
        try:
            url = url_file.read_text(encoding="utf-8").strip() or url
        except OSError:
            pass
        print(f"StemTutor уже запущен (данные: {cfg.data_dir}) — открываю его: {url}", flush=True)
        if args.open:
            webbrowser.open(url)
        return 0
    # Bind before the app starts its job runner: uvicorn runs the lifespan first and only then
    # finds out that the port is taken.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name != "nt":
        # POSIX: allow a restart while old connections sit in TIME_WAIT. On Windows the same
        # option would let a second server share the port, so the default stays there.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((args.host, args.port))
    except OSError as exc:
        sock.close()
        if _is_stemtutor(url):
            print(f"StemTutor уже запущен на {url} (с другой папкой данных) — открываю его.", flush=True)
            if args.open:
                webbrowser.open(url)
            return 0
        print(
            f"[!] Порт {args.port} занят другой программой ({exc.strerror or exc}). Закройте её или запустите "
            f"StemTutor на другом порту: start.bat --port {args.port + 1}",
            flush=True,
        )
        return 1

    try:
        url_file.write_text(url, encoding="utf-8")
    except OSError:
        pass
    app = create_app(cfg)
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port, log_level="warning"))
    print(f"StemTutor {__version__}: {url}  (данные: {cfg.data_dir})", flush=True)
    if args.open:

        def open_when_ready() -> None:  # only once the server really answers
            for _ in range(600):
                if server.started:
                    webbrowser.open(url)
                    return
                if server.should_exit:
                    return
                time.sleep(0.1)

        threading.Thread(target=open_when_ready, name="stemtutor-open", daemon=True).start()
    if os.name == "nt":
        import signal

        # Ctrl+Break: stop gracefully like Ctrl+C instead of the CRT's exit code 3, which
        # start.bat would report as a crash.
        signal.signal(signal.SIGBREAK, signal.default_int_handler)
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:  # uvicorn re-raises the signal after its graceful shutdown
        pass
    finally:
        lock.close()
    return 0 if server.started else 1


def _doctor(args: argparse.Namespace) -> int:
    import importlib.util

    from .pipeline.ffmpeg import ffmpeg_exe

    cfg = load_config(args.data)
    ok = True
    print(f"StemTutor {__version__}")
    print(f"  данные:         {cfg.data_dir}")
    print(f"  веб-интерфейс:  {'собран' if (cfg.frontend_dist / 'index.html').is_file() else 'НЕ собран'}")
    exe = ffmpeg_exe()
    print(f"  ffmpeg:         {exe or 'НЕ найден'}")
    ok &= exe is not None
    try:
        import onnxruntime

        print(f"  onnxruntime:    {onnxruntime.__version__}")
    except Exception as exc:  # pragma: no cover - environment specific
        print(f"  onnxruntime:    ОШИБКА {exc}")
        ok = False
    has_demucs = importlib.util.find_spec("demucs") is not None
    print(f"  разделение:     {'Demucs установлен' if has_demucs else 'не установлено (опционально)'}")
    if has_demucs:
        try:
            import torch

            dev = f"CUDA ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else "CPU"
            print(f"  устройство:     {dev}, torch {torch.__version__}")
        except Exception as exc:  # pragma: no cover
            print(f"  torch:          ОШИБКА {exc}")
            ok = False
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # "root" is the root logger itself (libraries' stray logging.warning calls); the app's own
    # loggers are switched back on explicitly so their INFO/WARNING lines still reach the console.
    for noisy in ("numba", "matplotlib", "root", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    logging.getLogger("stemtutor").setLevel(logging.INFO)
    parser = argparse.ArgumentParser(prog="stemtutor", description="StemTutor")
    parser.add_argument("--data", help="папка данных (по умолчанию %%LOCALAPPDATA%%\\StemTutor\\data)")
    sub = parser.add_subparsers(dest="cmd")
    p_serve = sub.add_parser("serve", help="запустить приложение")
    p_serve.add_argument("--host", default=DEFAULT_HOST)
    p_serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    p_serve.add_argument("--open", action="store_true", help="открыть браузер")
    sub.add_parser("doctor", help="проверить окружение")
    args = parser.parse_args(argv)
    if args.cmd == "doctor":
        return _doctor(args)
    if args.cmd in (None, "serve"):
        if args.cmd is None:
            args.host, args.port, args.open = DEFAULT_HOST, DEFAULT_PORT, True
        return _serve(args)
    parser.print_help()
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
