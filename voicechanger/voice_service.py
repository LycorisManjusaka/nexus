import asyncio
import websockets
import time
import re
import json
from pathlib import Path

# ==========================================
# voice_service.py
#
# A simplified, voice-changer-FREE logger. It is to voice_changer.py what
# ear_service.py is to the "ears" pipeline:
#
#   • Listens for recognized speech over a WebSocket on port 13000 — exactly the
#     same transport voice_changer.py / ear_service.py use (recognize.exe /
#     ゆーかねすぴれこ connects and streams text lines).
#   • Does NOT change the voice: no TTS synthesis, no audio devices, no
#     clipboard, no character/engine switching commands, no quirks.
#   • Appends the recognized text to kohai.txt in the SAME format as
#     voice_changer.py's log_to_kohai(), so NEXUS's VRChat merge picks it up
#     unchanged (a "[engine-char-style]" header on an empty file, then
#     "[HH:MM:SS] text" lines).
#
# Use this when you only want the user's speech transcribed into kohai.txt
# (e.g. NEXUS VRChat mode) without running the full voice changer.
# ==========================================


class Config:
    PORT = 13000
    # See voice_changer.py's Config for the program/data split rationale.
    PROGRAM_DIR = Path(__file__).resolve().parent
    DATA_DIR = PROGRAM_DIR.parent / "local_data" / "voicechanger"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    KOHAI_TXT_PATH = DATA_DIR / "kohai.txt"
    CHARA_SETTINGS_FILE = DATA_DIR / "chara_settings.json"
    # Cached speaker catalogs — voice_service.py never loads a live engine (no
    # TTS synthesis here), so unlike voice_changer.py it has no in-memory
    # speaker list to resolve a numeric char/style index into a real name.
    # Both files are written by voice_changer.py (_load_voicevox_speakers() /
    # _load_coeiroink_speakers()); if voice_changer.py has never run on this
    # machine, these caches simply won't exist yet and resolution falls back
    # to an empty name (see get_header() below).
    VOICEVOX_SPEAKERS_FILE = DATA_DIR / "speakers.json"
    COEIROINK_SPEAKERS_FILE = DATA_DIR / "coeiroink_speakers.json"
    ENGINES = ["voicevox", "coeiroink"]


class VoiceService:
    def __init__(self):
        # Completely ignore the recognizer's well-known hallucinations, same set
        # voice_changer.py / ear_service.py drop so they never reach kohai.txt.
        self.noise_hallucinations = {"ごめん", "ありがとうございました", "ご視野", "ご視野の", "ん"}

    # ------------------------------------------------------------------
    # Header "[VOICE|engine|charName|styleName]" — same format
    # voice_changer.py writes (NEXUS's vrchatLogs.ts parses this exact
    # pattern; a numeric "[0-2-0]"-style header never matches it and silently
    # leaves the speaker on the fallback identity forever). We read the
    # current engine/char/style index from chara_settings.json, then resolve
    # that index into a real name via the speaker catalogs voice_changer.py
    # caches to disk — never a numeric slot index, since a TTS engine's
    # speaker-list order shifts whenever a new voice is installed.
    # ------------------------------------------------------------------
    def _load_speaker_catalog(self, engine):
        path = Config.VOICEVOX_SPEAKERS_FILE if engine == "voicevox" else Config.COEIROINK_SPEAKERS_FILE
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def get_header(self):
        engine = "voicevox"
        char_name = ""
        style_name = ""
        try:
            with open(Config.CHARA_SETTINGS_FILE, "r", encoding="utf-8") as f:
                settings = json.load(f)
            engine = settings.get("current_engine", "voicevox")
            if engine not in Config.ENGINES:
                engine = "voicevox"
            engine_settings = settings.get(engine, {})
            char_idx = engine_settings.get("current_character", 0)
            style_idx = engine_settings.get("character_styles", {}).get(str(char_idx), 0)

            catalog = self._load_speaker_catalog(engine)
            if catalog and 0 <= char_idx < len(catalog):
                char_data = catalog[char_idx]
                if engine == "voicevox":
                    char_name = char_data.get("name", "") or ""
                    styles = char_data.get("styles", [])
                    if 0 <= style_idx < len(styles):
                        style_name = styles[style_idx].get("name", "") or ""
                else:
                    char_name = char_data.get("speakerName", "") or ""
                    styles = char_data.get("styles", [])
                    if 0 <= style_idx < len(styles):
                        style_name = styles[style_idx].get("styleName", "") or ""
        except Exception:
            pass
        return f"[VOICE|{engine}|{char_name}|{style_name}]"

    # ------------------------------------------------------------------
    # Same write logic / format as voice_changer.py's log_to_kohai().
    # ------------------------------------------------------------------
    def log_to_kohai(self, text):
        if not text or not text.strip():
            return
        try:
            is_empty = (
                not Config.KOHAI_TXT_PATH.exists()
                or Config.KOHAI_TXT_PATH.stat().st_size == 0
            )
            content = ""
            clean_text = text.strip()
            is_header = re.match(r"^\[VOICE\|[^|]*\|[^|]*\|[^|]*\]$", clean_text) is not None

            # On an empty file, prepend the current voice-state header (unless the
            # incoming line already IS a header).
            if is_empty and not is_header:
                content += self.get_header() + "\n"

            # State-header lines get no timestamp; everything else does.
            if is_header:
                content += clean_text + "\n"
                log_print = clean_text
            else:
                timestamp = time.strftime("%H:%M:%S")
                content += f"[{timestamp}] {clean_text}\n"
                log_print = f"[{timestamp}] {clean_text}"

            with open(Config.KOHAI_TXT_PATH, "a", encoding="utf-8") as f:
                f.write(content)
            print(f"   [Kohai Log] Appended: {log_print}")
        except Exception as e:
            print(f"   [Kohai Log Error] {e}")

    def process_text(self, text):
        text = text.strip()
        if not text:
            return None

        # Strip trailing punctuation/space before matching the hallucination set.
        clean_text = re.sub(r"[。！？\s]+$", "", text)
        if clean_text in self.noise_hallucinations:
            return None

        return text

    async def handle_websocket(self, websocket):
        print(f"[Voice Service] 接続確立: {websocket.remote_address}")
        try:
            async for message in websocket:
                processed_msg = self.process_text(message)
                if processed_msg:
                    self.log_to_kohai(processed_msg)
        except websockets.exceptions.ConnectionClosed:
            print(f"[Voice Service] 切断: {websocket.remote_address}")
        except Exception as e:
            print(f"[Voice Service] エラー発生: {e}")

    async def start(self):
        print("=========================================")
        print("  Voice Service (kohai logger / no changer)")
        print(f"  Port: {Config.PORT}")
        print(f"  Log File: {Config.KOHAI_TXT_PATH.absolute()}")
        print("=========================================")
        print("『ゆーかねすぴれこ』を起動し、送信先を ws://127.0.0.1:13000 に設定してください。")

        async with websockets.serve(self.handle_websocket, "127.0.0.1", Config.PORT):
            await asyncio.Future()


if __name__ == "__main__":
    service = VoiceService()
    try:
        asyncio.run(service.start())
    except KeyboardInterrupt:
        print("\n[Voice Service] 停止しました。")
