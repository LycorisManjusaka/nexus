import asyncio
import websockets
import re
from pathlib import Path

import nexus_identity

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
#     voice_changer.py and ear_service.py:
#
#         [HH:MM:SS] (Name)        text
#         [HH:MM:SS] (Name|Style)  text
#
# There is no state header any more. There used to be one — "[VOICE|engine|char|
# style]", and before that a numeric "[0-2-0]" — because the speaker was a pair
# of slot indices inside the voice changer's own settings file, and a reader had
# to be told which. Now the speaker is a name in Nexus's user_identity.json, so
# every line can simply say who said it. That also means kohai.txt and
# ear_log.txt are the same format, and merging them is a single regex.
#
# Use this when you only want the user's speech transcribed into kohai.txt
# (e.g. NEXUS Audio Session) without running the full voice changer.
# ==========================================


class Config:
    PORT = 13000
    # See voice_changer.py's Config for the program/data split rationale.
    PROGRAM_DIR = Path(__file__).resolve().parent
    DATA_DIR = PROGRAM_DIR.parent / "local_data" / "voicechanger"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    KOHAI_TXT_PATH = DATA_DIR / "kohai.txt"


class VoiceService:
    def __init__(self):
        # Completely ignore the recognizer's well-known hallucinations, same set
        # voice_changer.py / ear_service.py drop so they never reach kohai.txt.
        self.noise_hallucinations = {"ごめん", "ありがとうございました", "ご視野", "ご視野の", "ん"}

    def log_to_kohai(self, text):
        if not text or not text.strip():
            return
        try:
            # The speaker is resolved per line, not once at startup: the human
            # can switch identity mid-session from any Nexus window, and the
            # next line must already say the new name.
            line = nexus_identity.transcript_line(text.strip())
            with open(Config.KOHAI_TXT_PATH, "a", encoding="utf-8") as f:
                f.write(line)
            print(f"   [Kohai Log] Appended: {line.rstrip()}")
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
        ident, style, is_override = nexus_identity.resolve()
        print("=========================================")
        print("  Voice Service (kohai logger / no changer)")
        print(f"  Port: {Config.PORT}")
        print(f"  Log File: {Config.KOHAI_TXT_PATH.absolute()}")
        print(f"  Identity: {ident.name}" + (f" ({style})" if style else ""))
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
