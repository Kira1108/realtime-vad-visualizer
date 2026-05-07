import asyncio
import atexit
import json
import logging
import math
from dataclasses import dataclass
from enum import Enum
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

LOGGER = logging.getLogger("vad.web_demo")


HOST = "127.0.0.1"
PORT = 8000
SAMPLE_RATE = 16000
STATIC_DIR = Path(__file__).parent / "web"


analyzer_lock = Lock()
analyzer = None


def get_backend_name() -> str:
    if analyzer is None:
        return "unknown"
    return getattr(analyzer, "backend_name", "unknown")


class FallbackVADState(Enum):
    QUIET = 1
    STARTING = 2
    SPEAKING = 3
    STOPPING = 4


@dataclass
class FallbackVADParams:
    confidence: float = 0.45
    start_secs: float = 0.2
    stop_secs: float = 0.25
    min_volume: float = 0.08


class EnergyVAD:
    def __init__(self, sample_rate: int, params: FallbackVADParams | None = None):
        self.backend_name = "energy"
        self.sample_rate = sample_rate
        self.params = params or FallbackVADParams()
        self.chunk_samples = 512 if sample_rate == 16000 else 256
        self._frame_seconds = self.chunk_samples / sample_rate
        self._start_frames = max(1, round(self.params.start_secs / self._frame_seconds))
        self._stop_frames = max(1, round(self.params.stop_secs / self._frame_seconds))
        self._state = FallbackVADState.QUIET
        self._starting_count = 0
        self._stopping_count = 0

    def analyze_audio(self, audio_bytes: bytes) -> FallbackVADState:
        volume = self._calculate_volume(audio_bytes)
        confidence = min(1.0, volume * 1.75)
        speaking = (
            confidence >= self.params.confidence and volume >= self.params.min_volume
        )

        if speaking:
            match self._state:
                case FallbackVADState.QUIET:
                    self._state = FallbackVADState.STARTING
                    self._starting_count = 1
                case FallbackVADState.STARTING:
                    self._starting_count += 1
                case FallbackVADState.STOPPING:
                    self._state = FallbackVADState.SPEAKING
                    self._stopping_count = 0
        else:
            match self._state:
                case FallbackVADState.STARTING:
                    self._state = FallbackVADState.QUIET
                    self._starting_count = 0
                case FallbackVADState.SPEAKING:
                    self._state = FallbackVADState.STOPPING
                    self._stopping_count = 1
                case FallbackVADState.STOPPING:
                    self._stopping_count += 1

        if (
            self._state == FallbackVADState.STARTING
            and self._starting_count >= self._start_frames
        ):
            self._state = FallbackVADState.SPEAKING
            self._starting_count = 0

        if (
            self._state == FallbackVADState.STOPPING
            and self._stopping_count >= self._stop_frames
        ):
            self._state = FallbackVADState.QUIET
            self._stopping_count = 0

        return self._state

    @staticmethod
    def _calculate_volume(audio_bytes: bytes) -> float:
        if not audio_bytes:
            return 0.0

        sample_count = len(audio_bytes) // 2
        if sample_count == 0:
            return 0.0

        total = 0.0
        for offset in range(0, len(audio_bytes) - 1, 2):
            sample = int.from_bytes(audio_bytes[offset : offset + 2], "little", signed=True)
            normalized = sample / 32768.0
            total += normalized * normalized

        rms = math.sqrt(total / sample_count)
        return min(1.0, rms * 3.2)


def create_analyzer():
    try:
        from silero_vad import SileroVADAnalyzer
    except Exception as exc:
        LOGGER.warning("Silero VAD unavailable, falling back to EnergyVAD: %s", exc)
        LOGGER.info("Using EnergyVAD fallback backend")
        return EnergyVAD(sample_rate=SAMPLE_RATE)

    if SileroVADAnalyzer is not None:
        vad = SileroVADAnalyzer(sample_rate=SAMPLE_RATE)
        vad.set_sample_rate(SAMPLE_RATE)
        vad.backend_name = "silero"
        LOGGER.info("Using SileroVADAnalyzer backend")
        return vad
    LOGGER.info("Using EnergyVAD fallback backend")
    return EnergyVAD(sample_rate=SAMPLE_RATE)


def reset_analyzer():
    global analyzer
    with analyzer_lock:
        analyzer = create_analyzer()


def cleanup_analyzer():
    if analyzer is None or not hasattr(analyzer, "cleanup"):
        return

    try:
        asyncio.run(analyzer.cleanup())
    except Exception:
        pass


atexit.register(cleanup_analyzer)


class VADDemoHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self._serve_static("index.html", "text/html; charset=utf-8")
            return

        if self.path == "/app.js":
            self._serve_static("app.js", "application/javascript; charset=utf-8")
            return

        if self.path == "/styles.css":
            self._serve_static("styles.css", "text/css; charset=utf-8")
            return

        if self.path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "sample_rate": SAMPLE_RATE,
                    "backend": get_backend_name(),
                },
            )
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self):
        if self.path == "/reset":
            reset_analyzer()
            self._send_json(HTTPStatus.OK, {"status": "reset"})
            return

        if self.path != "/analyze":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        audio_bytes = self.rfile.read(content_length)

        if not audio_bytes:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Empty request body"})
            return

        try:
            with analyzer_lock:
                if analyzer is None:
                    raise RuntimeError("Analyzer is not initialized")

                if get_backend_name() == "silero":
                    state = asyncio.run(analyzer.analyze_audio(audio_bytes))
                else:
                    state = analyzer.analyze_audio(audio_bytes)
        except Exception as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        self._send_json(
            HTTPStatus.OK,
            {
                "state": state.name,
                "sampleRate": SAMPLE_RATE,
                "bytes": len(audio_bytes),
                "backend": get_backend_name(),
            },
        )

    def log_message(self, format, *args):
        return

    def _serve_static(self, name: str, content_type: str):
        file_path = STATIC_DIR / name
        if not file_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        body = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: HTTPStatus, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global analyzer
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    analyzer = create_analyzer()
    server = ThreadingHTTPServer((HOST, PORT), VADDemoHandler)
    LOGGER.info("Serving VAD demo at http://%s:%s", HOST, PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()