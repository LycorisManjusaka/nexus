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
    KOHAI_TXT_PATH = Path("kohai.txt")
    CHARA_SETTINGS_FILE = Path("chara_settings.json")
    ENGINES = ["voicevox", "coeiroink"]


class VoiceService:
    def __init__(self):
        # Completely ignore the recognizer's well-known hallucinations, same set
        # voice_changer.py / ear_service.py drop so they never reach kohai.txt.
        self.noise_hallucinations = {"ごめん", "ありがとうございました", "ご視野", "ご視野の", "ん"}

    # ------------------------------------------------------------------
    # Header "[engine_idx-char_idx-style_idx]" — identical to the one
    # voice_changer.py writes. We read it straight from chara_settings.json
    # (without loading speakers or synthesizing anything) so the speaker still
    # resolves correctly through NEXUS's character_map.json.
    # ------------------------------------------------------------------
    def get_header(self):
        try:
            with open(Config.CHARA_SETTINGS_FILE, "r", encoding="utf-8") as f:
                settings = json.load(f)
            engine = settings.get("current_engine", "voicevox")
            engine_idx = Config.ENGINES.index(engine) if engine in Config.ENGINES else 0
            char_idx = settings[engine]["current_character"]
            style_idx = settings[engine]["character_styles"].get(str(char_idx), 0)
            return f"[{engine_idx}-{char_idx}-{style_idx}]"
        except Exception:
            # Fallback mirrors voice_changer.py's default (voicevox / char 1 / style 0).
            return "[0-1-0]"

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
            is_header = re.match(r"^\[\d+-\d+-\d+\]$", clean_text) is not None

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
