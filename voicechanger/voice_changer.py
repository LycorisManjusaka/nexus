import requests
import json
import os
import re
import wave
import pyaudio
import hashlib
import pyperclip
import asyncio
import websockets
from pathlib import Path

import nexus_identity

# ==========================================
# 設定・定数クラス
#
# Who is speaking is NOT decided here any more. It lives in Nexus's
# local_data/user_identity.json (see nexus_identity.py), which this process
# re-reads on every utterance — so switching identity in any Nexus window, or by
# voice here, takes effect everywhere at once with no state of our own to keep
# in sync. chara_settings.json is gone.
# ==========================================
class Config:
    # Every engine Nexus can name in character_map.json. AivisSpeech speaks the
    # VOICEVOX HTTP API, so it shares that code path entirely.
    ENGINE_URLS = {
        "voicevox": "http://127.0.0.1:50021",
        "coeiroink": "http://127.0.0.1:50032",
        "aivisspeech": "http://127.0.0.1:10101",
    }
    # Engines whose speaker catalog and synthesis calls follow VOICEVOX's shape
    # ({"name", "styles":[{"name","id"}]}, /audio_query + /synthesis).
    VOICEVOX_LIKE = {"voicevox", "aivisspeech"}

    # PROGRAM_DIR = this file's own location (git-tracked, unchanging code +
    # notification .wav assets). DATA_DIR = local_data/voicechanger (gitignored
    # per-machine state: device settings, quirks, cached speaker catalogs, live
    # transcripts). Anchored off __file__ rather than a bare relative path so
    # these resolve correctly no matter what cwd the process was launched with.
    PROGRAM_DIR = Path(__file__).resolve().parent
    DATA_DIR = PROGRAM_DIR.parent / "local_data" / "voicechanger"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    DEVICE_SETTINGS_FILE = DATA_DIR / 'device_settings.json'
    SPEAKER_CACHE_FILES = {
        "voicevox": DATA_DIR / 'speakers.json',
        "coeiroink": DATA_DIR / 'coeiroink_speakers.json',
        "aivisspeech": DATA_DIR / 'aivisspeech_speakers.json',
    }
    QUIRKS_FILE = DATA_DIR / 'quirks.json'
    AUDIO_FOLDER = DATA_DIR / 'audio'

    KOHAI_TXT_PATH = DATA_DIR / "kohai.txt"
    GAIRAIGO_FILE = DATA_DIR / "gairaigo.txt"

    NOTIFICATIONS = {
        "processing": PROGRAM_DIR / "notifications/processing.wav",
        "synthesizing": PROGRAM_DIR / "notifications/synthesizing.wav",
        "could_not_understand": PROGRAM_DIR / "notifications/could_not_understand.wav",
        "error": PROGRAM_DIR / "notifications/error.wav",
        "copy": PROGRAM_DIR / "notifications/copy.wav",
    }

# ==========================================
# キャラクター特有の言い回し管理
# ==========================================
class QuirksManager:
    """Per-speaker text rewrites (「私」→「わし」 and friends).

    Keys are tried in order of how specific they are:

        "おじいちゃん"        the Nexus identity — survives everything
        "voicevox_春日部つむぎ"  engine + character name
        "voicevox_15"          legacy engine + slot index

    The legacy index key is only a reader concession: it points at whatever
    character sits in that slot today, which is exactly the instability the rest
    of this rewrite removes. Renaming the key to the identity is a one-line edit
    in quirks.json and makes it permanent.
    """

    def __init__(self):
        self.file_path = Config.QUIRKS_FILE
        self.quirks = self._load()

    def _load(self):
        if not self.file_path.exists():
            default = {
                "coeiroink_3": {
                    "(?<![公滅無営])私(?![物有生立鉄事信欲服邸見営利怨心])": "あたし",
                    "でしょう": "っしょ",
                    "でしょ": "っしょ"
                },
                "voicevox_24": {
                    "//": "ふわふわ姉ちゃん用（変更なしならこのまま）"
                },
                "voicevox_4": {
                    "(?<![公滅無営])私(?![物有生立鉄事信欲服邸見営利怨心])": "あたくし"
                },
                "voicevox_15": {
                    "(?<![公滅無営])私(?![物有生立鉄事信欲服邸見営利怨心])": "わし",
                    "の([？\\?]*)$": "のう\\1"
                }
            }
            with open(self.file_path, 'w', encoding='utf-8') as f:
                json.dump(default, f, ensure_ascii=False, indent=2)
            return default

        with open(self.file_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def apply(self, text, keys):
        rules = None
        for key in keys:
            if key and key in self.quirks:
                rules = self.quirks[key]
                break
        if not rules:
            return text

        for pattern, repl in rules.items():
            if pattern.startswith("//"):
                continue
            try:
                text = re.sub(pattern, repl, text)
            except re.error as e:
                print(f"Regex error for pattern '{pattern}': {e}")
        return text

# ==========================================
# 音声・デバイス管理クラス
# ==========================================
class AudioManager:
    def __init__(self):
        self.output_device_1 = None
        self.output_device_2 = None
        self.notification_sounds = {}
        self.english_to_japanese = {}

        self._load_gairaigo_dict()
        self._preload_notifications()

    def list_devices(self):
        p = pyaudio.PyAudio()
        device_list = []
        for i in range(p.get_device_count()):
            device = p.get_device_info_by_index(i)
            device_list.append((i, device['name'], device['maxInputChannels'], device['maxOutputChannels']))
        p.terminate()
        return device_list

    def select_device_by_keyword(self, device_list, keyword, is_output=False):
        if not keyword: return None, None
        keyword_lower = keyword.lower().strip()
        for index, name, input_channels, output_channels in device_list:
            if keyword_lower in name.lower():
                if (is_output and output_channels > 0) or (not is_output and input_channels > 0):
                    return index, name
        return None, None

    def setup_devices(self):
        try:
            with open(Config.DEVICE_SETTINGS_FILE, 'r', encoding='utf-8') as f:
                settings = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            settings = {
                "mic_keyword": "steam streaming microphone",
                "voice_speaker_keyword": "usb pnp sound device",
                "notification_speaker_keyword": "vb-audio virtual cable"
            }

        device_list = self.list_devices()
        print("--- Audio Device Setup ---")
        self.output_device_1, speaker1_name = self.select_device_by_keyword(device_list, settings.get("voice_speaker_keyword", ""), is_output=True)
        self.output_device_2, speaker2_name = self.select_device_by_keyword(device_list, settings.get("notification_speaker_keyword", ""), is_output=True)
        print(f"  🔊 Voice Speaker:   '{speaker1_name}' (Index: {self.output_device_1})")
        print(f"  🔔 Notif. Speaker: '{speaker2_name}' (Index: {self.output_device_2})")
        print("--------------------------")

    def _preload_notifications(self):
        for key, file_path in Config.NOTIFICATIONS.items():
            if file_path.exists():
                with wave.open(str(file_path), 'rb') as wf:
                    self.notification_sounds[key] = {
                        "params": wf.getparams(),
                        "frames": wf.readframes(wf.getnframes())
                    }

    def play_notification(self, notification_type):
        if notification_type in self.notification_sounds and self.output_device_2 is not None:
            sound_data = self.notification_sounds[notification_type]
            try:
                p = pyaudio.PyAudio()
                stream = p.open(format=p.get_format_from_width(sound_data["params"].sampwidth),
                                channels=sound_data["params"].nchannels,
                                rate=sound_data["params"].framerate,
                                output=True,
                                output_device_index=self.output_device_2)
                stream.write(sound_data["frames"])
                stream.stop_stream()
                stream.close()
                p.terminate()
            except Exception as e:
                print(f"Error playing notification {notification_type}: {e}")

    def play_audio(self, file_path, device_indices):
        indices = [idx for idx in device_indices if idx is not None]
        if not indices or not os.path.exists(file_path): return

        with wave.open(file_path, 'rb') as wf:
            p = pyaudio.PyAudio()
            try:
                streams = [p.open(format=p.get_format_from_width(wf.getsampwidth()), channels=wf.getnchannels(), rate=wf.getframerate(), output=True, output_device_index=idx) for idx in indices]
                data = wf.readframes(1024)
                while data:
                    for stream in streams: stream.write(data)
                    data = wf.readframes(1024)
                for stream in streams:
                    stream.stop_stream()
                    stream.close()
            except Exception as e:
                print(f"Error playing audio: {e}")
            finally:
                p.terminate()

    def _load_gairaigo_dict(self):
        try:
            with open(Config.GAIRAIGO_FILE, 'r', encoding='utf-8') as file:
                for line in file:
                    if line.strip():
                        parts = line.strip().split(maxsplit=1)
                        if len(parts) == 2:
                            self.english_to_japanese[parts[0].lower()] = parts[1]
        except FileNotFoundError:
            pass

    def clean_text(self, text):
        def replace(match):
            word = match.group(0)
            return self.english_to_japanese.get(word.lower(), word)
        pattern = re.compile(r'\b([a-zA-Z0-9\-]+)\b')
        modified_text = pattern.sub(replace, text)
        return re.sub(r'\s+(?=[ぁ-んァ-ン一-龯])|(?<=[ぁ-んァ-ン一-龯])\s+', '', modified_text)

# ==========================================
# 音声合成エンジン管理クラス
# ==========================================
class VoiceTarget:
    """A fully resolved "speak this as" — the engine's own objects, looked up by
    name at the moment of synthesis and thrown away afterwards."""

    def __init__(self, identity, engine, char_data, style_data):
        self.identity = identity
        self.engine = engine
        self.char_data = char_data
        self.style_data = style_data

    @property
    def char_name(self):
        return self.char_data.get("name") or self.char_data.get("speakerName") or ""

    @property
    def style_name(self):
        if not self.style_data:
            return ""
        return self.style_data.get("name") or self.style_data.get("styleName") or ""


class EngineManager:
    """Speaker catalogs, and synthesis for whoever is currently selected.

    It holds no notion of "the current character": that question is answered by
    nexus_identity.resolve() every time it is asked. The only state here is the
    catalog of what each engine can say, which is a property of the engines.
    """

    def __init__(self, audio_manager):
        self.audio_manager = audio_manager
        self.speakers_data = {name: [] for name in Config.ENGINE_URLS}

        Config.AUDIO_FOLDER.mkdir(exist_ok=True)
        for engine in Config.ENGINE_URLS:
            self.load_speakers(engine)

    # ── Catalogs ──────────────────────────────────────────────────────────────
    def load_speakers(self, engine):
        """Live fetch, cached to disk. The cache is what lets a name still
        resolve when the engine isn't running — and what lets other processes
        (Nexus, voice_service.py) resolve the same names without an engine."""
        url = Config.ENGINE_URLS.get(engine)
        cache = Config.SPEAKER_CACHE_FILES.get(engine)
        if not url or not cache:
            return
        path = "/speakers" if engine in Config.VOICEVOX_LIKE else "/v1/speakers"
        try:
            response = requests.get(f"{url}{path}", timeout=5)
            if response.status_code == 200:
                self.speakers_data[engine] = response.json()
                with open(cache, 'w', encoding='utf-8') as f:
                    json.dump(self.speakers_data[engine], f, ensure_ascii=False, indent=2)
                return
        except requests.exceptions.RequestException:
            pass
        try:
            with open(cache, 'r', encoding='utf-8') as f:
                self.speakers_data[engine] = json.load(f)
        except Exception:
            pass

    def find_character(self, engine, character_name):
        for c in self.speakers_data.get(engine) or []:
            if (c.get("name") or c.get("speakerName")) == character_name:
                return c
        return None

    def styles_for(self, char_data):
        """Style NAMES for a catalog entry, in the engine's own order — which is
        the order 「〇番目のスタイル」 counts through."""
        out = []
        for s in (char_data or {}).get("styles") or []:
            name = s.get("name") or s.get("styleName")
            if name:
                out.append(name)
        return out

    # ── Resolution ────────────────────────────────────────────────────────────
    def resolve_target(self):
        """The currently selected identity, turned into engine objects.

        Returns (VoiceTarget|None, reason). `reason` explains a None so the
        caller can say something useful instead of failing silently — an
        identity with no voice is normal, an unreachable engine is not.
        """
        identity, style, _is_override = nexus_identity.resolve()
        if not identity.has_voice:
            return None, f"「{identity.name}」に声は設定されていません"

        catalog = self.speakers_data.get(identity.engine)
        if not catalog:
            return None, f"エンジン「{identity.engine}」が利用できません"

        char_data = self.find_character(identity.engine, identity.character)
        if not char_data:
            return None, f"「{identity.character}」が{identity.engine}に見つかりません"

        styles = char_data.get("styles") or []
        style_data = None
        if style:
            style_data = next(
                (s for s in styles if (s.get("name") or s.get("styleName")) == style), None
            )
        # A named style that the engine no longer has falls through to the
        # engine's own first style rather than refusing to speak: the identity is
        # still right, only the flavour is stale.
        if style_data is None and styles:
            style_data = styles[0]

        return VoiceTarget(identity, identity.engine, char_data, style_data), None

    # ── Synthesis ─────────────────────────────────────────────────────────────
    def generate_hashed_filename(self, text, engine, identifier):
        return hashlib.sha256(f"{text}_{engine}_{identifier}".encode('utf-8')).hexdigest()[:16]

    def synthesize_speech(self, text, target=None):
        cleaned_text = self.audio_manager.clean_text(text)
        if not cleaned_text.strip():
            return None

        if target is None:
            target, reason = self.resolve_target()
            if target is None:
                print(f"   [Voice] {reason}")
                return None

        if target.engine in Config.VOICEVOX_LIKE:
            return self._synthesize_voicevox_like(cleaned_text, target)
        if target.engine == "coeiroink":
            return self._synthesize_coeiroink(cleaned_text, target)
        return None

    def _synthesize_coeiroink(self, text, target):
        try:
            style_id = target.style_data["styleId"]
            speaker_uuid = target.char_data["speakerUuid"]
            name = self.generate_hashed_filename(text, target.engine, f"uuid_{speaker_uuid}_style_{style_id}")
            output_path = Config.AUDIO_FOLDER / f"{name}.wav"

            if output_path.exists(): return str(output_path)

            self.audio_manager.play_notification("synthesizing")
            payload = {
                "speakerUuid": speaker_uuid, "styleId": style_id, "text": text,
                "speedScale": 1.0, "volumeScale": 1.0, "pitchScale": 0.0,
                "intonationScale": 1.0, "prePhonemeLength": 0.1, "postPhonemeLength": 0.1,
                "outputSamplingRate": 24000,
            }
            res = requests.post(f"{Config.ENGINE_URLS['coeiroink']}/v1/synthesis", json=payload, timeout=20)
            if res.status_code == 200:
                output_path.write_bytes(res.content)
                return str(output_path)
        except Exception as e:
            print(f"   [Voice] coeiroink 合成失敗: {e}")
        return None

    def _synthesize_voicevox_like(self, text, target):
        url = Config.ENGINE_URLS[target.engine]
        try:
            speaker_id = target.style_data["id"]
            name = self.generate_hashed_filename(text, target.engine, speaker_id)
            output_path = Config.AUDIO_FOLDER / f"{name}.wav"

            if output_path.exists(): return str(output_path)

            self.audio_manager.play_notification("synthesizing")
            query_res = requests.post(f"{url}/audio_query", params={"text": text, "speaker": speaker_id})
            if query_res.status_code != 200: return None

            synth_res = requests.post(f"{url}/synthesis", params={"speaker": speaker_id}, json=query_res.json())
            if synth_res.status_code == 200:
                output_path.write_bytes(synth_res.content)
                return str(output_path)
        except Exception as e:
            print(f"   [Voice] {target.engine} 合成失敗: {e}")
        return None

# ==========================================
# メインアプリケーション（サーバー）クラス
# ==========================================
class VoiceChangerApp:
    def __init__(self):
        self.audio = AudioManager()
        self.engine = EngineManager(self.audio)
        self.quirks = QuirksManager()
        self.audio.setup_devices()
        self.noise_hallucinations = {"ごめん", "ありがとうございました", "ご視野", "ご視野の"}

    def log_to_kohai(self, text):
        """One line, "[HH:MM:SS] (Name|Style) text" — the same shape
        ear_service.py writes, so Nexus merges both transcripts with one regex.

        There is no state header any more: the speaker's name is on every line.
        """
        if not text or not text.strip(): return
        try:
            line = nexus_identity.transcript_line(text.strip())
            with open(Config.KOHAI_TXT_PATH, 'a', encoding='utf-8') as f:
                f.write(line)
            print(f"   [Kohai Log] Appended: {line.rstrip()}")
        except Exception as e:
            print(f"   [Kohai Log Error] {e}")

    def japanese_text_to_number(self, text):
        num_map = {"ゼロ":0, "一":1, "二":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9, "十":10,
                   "十一":11, "十二":12, "十三":13, "十四":14, "十五":15, "十六":16, "十七":17, "十八":18, "十九":19,
                   "二十":20, "二十一":21, "二十二":22, "二十三":23, "二十四":24, "二十五":25, "二十六":26, "二十九":29}
        # Longest first: "十五" must not match on "十".
        for kanji in sorted(num_map, key=len, reverse=True):
            if kanji in text: return num_map[kanji]
        try: return int(re.findall(r'\d+', text)[0])
        except (ValueError, IndexError): return None

    # ── Spoken switching ──────────────────────────────────────────────────────
    #
    # The commands survive the move to names, because the reason they took a
    # NUMBER has not changed: speech recognition cannot reliably hear a Japanese
    # character name, but it can always hear a number. What changed is what the
    # number counts:
    #
    #   「〇番目の人格に切り替えてください」  → position in character_map.json's
    #                                          identity list (Nexus's own order)
    #   「〇番目のスタイルに切り替えてください」→ position in the CURRENT identity's
    #                                          character styles
    #
    # The number is resolved the moment it is heard and only the resulting NAME
    # is written to user_identity.json — so a renumbered engine can no longer
    # repoint a saved selection at a stranger.
    def handle_switch_command(self, text):
        """Returns a spoken reply, or None when this wasn't a switch command."""
        num_pat = r"([0-9０-９一二三四五六七八九十ゼロ]+)"

        identity_match = re.search(num_pat + r"\s*番目の(?:人格|アイデンティティ)", text)
        if identity_match:
            n = self.japanese_text_to_number(identity_match.group(1))
            if n is None:
                return "コマンドの番号を認識できませんでした"
            target = nexus_identity.switch_identity_by_index(n)
            if target is None:
                return f"{n}番目の人格はありません"
            return f"{target.name}に切り替えました"

        style_match = re.search(num_pat + r"\s*番目のスタイル", text)
        if style_match:
            n = self.japanese_text_to_number(style_match.group(1))
            if n is None:
                return "コマンドの番号を認識できませんでした"
            target, reason = self.engine.resolve_target()
            if target is None:
                return reason
            styles = self.engine.styles_for(target.char_data)
            chosen = nexus_identity.switch_style_by_index(n, styles)
            if chosen is None:
                return f"{n}番目のスタイルはありません"
            return f"{chosen}に切り替えました"

        # The old 「〇番目のエンジン」/「〇番目のキャラ」 commands are gone: an engine
        # and a character are now properties OF an identity, chosen once in
        # Nexus, so there is nothing left for them to switch independently.
        # Saying so is more use than ignoring it.
        if re.search(num_pat + r"\s*番目の(?:エンジン|キャラ)", text):
            return "エンジンとキャラクターは人格に含まれます。人格番号で切り替えてください"

        return None

    async def handle_websocket(self, websocket):
        print(f"Connection established from {websocket.remote_address}")
        try:
            async for message in websocket:
                text = message.strip()
                if not text: continue
                print(f"Received: {text}")

                # コマンド処理
                if "に切り替えて" in text:
                    res_msg = self.handle_switch_command(text)
                    if res_msg:
                        print(f"   [Command Result] {res_msg}")
                        # Spoken back on the notification device only: the
                        # confirmation is for the human at the keyboard, not for
                        # whoever is listening in VRChat. Synthesized in the NEW
                        # voice, which is itself the clearest confirmation that
                        # the switch took.
                        out_path = self.engine.synthesize_speech(res_msg)
                        if out_path: self.audio.play_audio(out_path, [self.audio.output_device_2])
                        continue

                # --- ハルシネーション（幻覚）の完全無視フィルター ---
                # 末尾の句読点や空白を消して純粋なテキストにする
                clean_text = re.sub(r'[。！？\s]+$', '', text)

                # リストと完全に一致した場合のみ、以降の処理をすべてスキップ（無視）する
                if clean_text in self.noise_hallucinations:
                    print(f"   [System] ゴミ認識を完全に無視しました: '{text}'")
                    continue

                # 通常のテキスト処理
                text = text.replace("疑問", "？").replace("ぎまん", "？").replace("ぎもん", "？").replace("ギモン", "？")
                if text.endswith("疑"): text = text[:-1] + "？"

                # Resolved once per utterance — the human may have switched
                # identity in a Nexus window since the last line.
                target, reason = self.engine.resolve_target()
                if target is None:
                    print(f"   [Voice] {reason}")

                quirk_keys = []
                if target:
                    quirk_keys = [target.identity.name, f"{target.engine}_{target.char_name}"]
                    legacy_idx = next(
                        (i for i, c in enumerate(self.engine.speakers_data.get(target.engine) or [])
                         if (c.get("name") or c.get("speakerName")) == target.char_name),
                        None,
                    )
                    if legacy_idx is not None:
                        quirk_keys.append(f"{target.engine}_{legacy_idx}")
                else:
                    identity, _style, _ovr = nexus_identity.resolve()
                    quirk_keys = [identity.name]
                text = self.quirks.apply(text, quirk_keys)

                pyperclip.copy(text)

                if target:
                    out_path = self.engine.synthesize_speech(text, target)
                    if out_path:
                        # Synthesize and play first; play_audio is synchronous and
                        # blocks until the buffer is fully drained. Only write to
                        # kohai.txt AFTER playback completes, so any consumer (Nexus
                        # Live Session) tailing the file sees the line at the moment
                        # the audio truly finished — preventing the AI from
                        # responding before the user's voice has been spoken.
                        self.audio.play_audio(out_path, [self.audio.output_device_1, self.audio.output_device_2])

                # Logged whether or not it was spoken: an identity with no voice
                # is still an identity, and its words still belong in the
                # transcript.
                self.log_to_kohai(text)

        except websockets.exceptions.ConnectionClosed:
            print(f"Connection closed from {websocket.remote_address}")
        except Exception as e:
            print(f"Error in websocket handler: {e}")

    async def start(self):
        identity, style, _ovr = nexus_identity.resolve()
        print("=========================================")
        print("  Voice Changer")
        print(f"  Identity: {identity.name}" + (f" ({style})" if style else ""))
        if identity.has_voice:
            print(f"  Voice:    {identity.engine} / {identity.character}")
        else:
            print("  Voice:    (none — text will be logged, not spoken)")
        print("=========================================")
        async with websockets.serve(self.handle_websocket, "127.0.0.1", 13000):
            print("Python WebSocket server started on ws://127.0.0.1:13000")
            print("Please start 'recognize.exe' from the launcher now.")
            await asyncio.Future()

if __name__ == "__main__":
    app = VoiceChangerApp()
    try:
        asyncio.run(app.start())
    except KeyboardInterrupt:
        print("\nServer stopped by user.")
