# /// script
# requires-python = ">=3.10"
# dependencies = ["PySide6"]
# ///
"""
AR Vision — Servers manager.

A small Qt GUI to start/stop and watch the two backends the AR Vision brain needs:
  - LM Studio  (vision/chat LLM)      -> `lms server start --cors --bind 0.0.0.0`
  - Whisper    (local ASR for voice)  -> `uv run asr/server.py`

Both are started bound to 0.0.0.0 with CORS, so the phone reaches them over the LAN
or Tailscale. The header shows the exact URLs to paste into the app's config.

Run:  uv run --script tools/server_manager.py
"""
from __future__ import annotations

import shutil
import socket
import subprocess
import threading
import urllib.request
from pathlib import Path

from PySide6.QtCore import Qt, QProcess, QProcessEnvironment, QTimer, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication, QComboBox, QGroupBox, QHBoxLayout, QLabel, QMainWindow,
    QPlainTextEdit, QPushButton, QSpinBox, QVBoxLayout, QWidget,
)

REPO = Path(__file__).resolve().parent.parent
ASR_SCRIPT = REPO / "asr" / "server.py"
UV = shutil.which("uv") or "/usr/bin/uv"
LMS = shutil.which("lms") or str(Path.home() / ".lmstudio" / "bin" / "lms")

LM_PORT = 1234


def tailscale_ip() -> str | None:
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=2)
        ip = out.stdout.strip().splitlines()
        return ip[0] if ip else None
    except Exception:
        return None


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def http_ok(url: str, timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 500
    except Exception:
        return False


class Dot(QLabel):
    """A small colored status pill."""
    def __init__(self) -> None:
        super().__init__()
        self.set(False)

    def set(self, up: bool) -> None:
        self.setText("● running" if up else "○ stopped")
        color = "#2ecc71" if up else "#888"
        self.setStyleSheet(f"color: {color}; font-weight: 600;")


class Manager(QMainWindow):
    status_ready = Signal(bool, bool)  # (lm_up, whisper_up) — emitted from poller thread

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("AR Vision — Servers")
        self.resize(620, 540)

        self.lms_proc: QProcess | None = None
        self.whisper_proc: QProcess | None = None

        self.ts = tailscale_ip()
        self.lan = lan_ip()
        host = self.ts or self.lan

        root = QVBoxLayout()

        # ── Header: the URLs to paste into the app ─────────────────────────────
        header = QLabel(
            f"<b>Use these in the app config</b> (host = "
            f"{'Tailscale' if self.ts else 'LAN'} {host}):<br>"
            f"&nbsp;&nbsp;LM Studio IP &nbsp;→ <code>{host}</code> : {LM_PORT}<br>"
            f"&nbsp;&nbsp;Whisper URL &nbsp;→ <code>http://{host}:{{port}}/v1/audio/transcriptions</code>"
        )
        header.setTextFormat(Qt.RichText)
        header.setTextInteractionFlags(Qt.TextSelectableByMouse)
        header.setWordWrap(True)
        header.setStyleSheet("background:#1e1e1e;color:#ddd;padding:10px;border-radius:6px;")
        root.addWidget(header)

        # ── LM Studio panel ────────────────────────────────────────────────────
        lm_box = QGroupBox("LM Studio  (LLM — vision & chat)")
        lm_l = QVBoxLayout()
        row = QHBoxLayout()
        self.lm_dot = Dot()
        self.lm_start = QPushButton("Start (--cors --bind 0.0.0.0)")
        self.lm_stop = QPushButton("Stop")
        self.lm_start.clicked.connect(self.start_lms)
        self.lm_stop.clicked.connect(self.stop_lms)
        row.addWidget(self.lm_dot); row.addStretch(1)
        row.addWidget(self.lm_start); row.addWidget(self.lm_stop)
        lm_l.addLayout(row)
        lm_box.setLayout(lm_l)
        root.addWidget(lm_box)

        # ── Whisper panel ──────────────────────────────────────────────────────
        w_box = QGroupBox("Whisper  (local ASR — voice chat)")
        w_l = QVBoxLayout()
        cfg = QHBoxLayout()
        cfg.addWidget(QLabel("model:"))
        self.w_model = QComboBox()
        self.w_model.addItems(["tiny", "base", "small", "medium", "large-v3"])
        self.w_model.setCurrentText("small")
        cfg.addWidget(self.w_model)
        cfg.addWidget(QLabel("port:"))
        self.w_port = QSpinBox()
        self.w_port.setRange(1, 65535)
        self.w_port.setValue(8000)
        cfg.addWidget(self.w_port)
        cfg.addWidget(QLabel("lang:"))
        self.w_lang = QComboBox()
        self.w_lang.addItems(["auto", "it", "en"])
        cfg.addWidget(self.w_lang)
        cfg.addStretch(1)
        w_l.addLayout(cfg)
        row = QHBoxLayout()
        self.w_dot = Dot()
        self.w_start = QPushButton("Start")
        self.w_stop = QPushButton("Stop")
        self.w_start.clicked.connect(self.start_whisper)
        self.w_stop.clicked.connect(self.stop_whisper)
        row.addWidget(self.w_dot); row.addStretch(1)
        row.addWidget(self.w_start); row.addWidget(self.w_stop)
        w_l.addLayout(row)
        w_box.setLayout(w_l)
        root.addWidget(w_box)

        # ── Log ────────────────────────────────────────────────────────────────
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setFont(QFont("monospace", 9))
        root.addWidget(self.log, 1)

        central = QWidget()
        central.setLayout(root)
        self.setCentralWidget(central)

        self.status_ready.connect(self._apply_status)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.poll_status)
        self.timer.start(3000)
        self.poll_status()
        self._log(f"Repo: {REPO}\nuv: {UV}\nlms: {LMS}")

    # ── logging ────────────────────────────────────────────────────────────────
    def _log(self, text: str) -> None:
        self.log.appendPlainText(text.rstrip())

    def _wire(self, proc: QProcess, tag: str) -> None:
        proc.readyReadStandardOutput.connect(
            lambda: self._log(f"[{tag}] " + bytes(proc.readAllStandardOutput()).decode(errors="replace")))
        proc.readyReadStandardError.connect(
            lambda: self._log(f"[{tag}] " + bytes(proc.readAllStandardError()).decode(errors="replace")))

    # ── LM Studio ────────────────────────────────────────────────────────────────
    def start_lms(self) -> None:
        self._log("→ lms server start --cors --bind 0.0.0.0")
        p = QProcess(self)
        self._wire(p, "lms")
        p.finished.connect(lambda *_: self._log("[lms] start command finished"))
        p.start(LMS, ["server", "start", "--cors", "--bind", "0.0.0.0"])
        self.lms_proc = p

    def stop_lms(self) -> None:
        self._log("→ lms server stop")
        p = QProcess(self)
        self._wire(p, "lms")
        p.start(LMS, ["server", "stop"])

    # ── Whisper ──────────────────────────────────────────────────────────────────
    def start_whisper(self) -> None:
        if self.whisper_proc and self.whisper_proc.state() != QProcess.NotRunning:
            self._log("[whisper] already running")
            return
        if not ASR_SCRIPT.exists():
            self._log(f"[whisper] ERROR: {ASR_SCRIPT} not found")
            return
        env = QProcessEnvironment.systemEnvironment()
        env.insert("WHISPER_MODEL", self.w_model.currentText())
        env.insert("WHISPER_PORT", str(self.w_port.value()))
        lang = self.w_lang.currentText()
        env.insert("WHISPER_LANGUAGE", "" if lang == "auto" else lang)
        p = QProcess(self)
        p.setProcessEnvironment(env)
        self._wire(p, "whisper")
        p.finished.connect(lambda *_: self._log("[whisper] process exited"))
        self._log(f"→ uv run --script asr/server.py  (model={self.w_model.currentText()}, port={self.w_port.value()})")
        p.start(UV, ["run", "--script", str(ASR_SCRIPT)])
        self.whisper_proc = p

    def stop_whisper(self) -> None:
        p = self.whisper_proc
        if not p or p.state() == QProcess.NotRunning:
            self._log("[whisper] not running")
            return
        self._log("→ stopping whisper")
        p.terminate()
        if not p.waitForFinished(3000):
            p.kill()

    # ── status polling (HTTP, off the UI thread) ─────────────────────────────────
    def poll_status(self) -> None:
        port = self.w_port.value()
        threading.Thread(target=self._poll_worker, args=(port,), daemon=True).start()

    def _poll_worker(self, whisper_port: int) -> None:
        lm = http_ok(f"http://127.0.0.1:{LM_PORT}/v1/models")
        wh = http_ok(f"http://127.0.0.1:{whisper_port}/")
        self.status_ready.emit(lm, wh)

    def _apply_status(self, lm_up: bool, wh_up: bool) -> None:
        self.lm_dot.set(lm_up)
        self.w_dot.set(wh_up)

    # ── teardown ─────────────────────────────────────────────────────────────────
    def closeEvent(self, event) -> None:  # noqa: N802
        # Don't orphan the Whisper child; leave LM Studio (it's a daemon) running.
        if self.whisper_proc and self.whisper_proc.state() != QProcess.NotRunning:
            self.whisper_proc.terminate()
            self.whisper_proc.waitForFinished(2000)
        event.accept()


def main() -> None:
    app = QApplication([])
    win = Manager()
    win.show()
    app.exec()


if __name__ == "__main__":
    main()
