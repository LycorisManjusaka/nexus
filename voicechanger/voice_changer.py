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
import time  # <-- 新規追加: タイムスタンプ用
from pathlib import Path

# ==========================================
# 設定・定数クラス
# ==========================================
class Config:
    VOICEVOX_URL = "http://127.0.0.1:50021"
    COEIROINK_URL = "http://127.0.0.1:50032"
    ENGINES = ["voicevox", "coeiroink"]

    # PROGRAM_DIR = this file's own location (git-tracked, unchanging code +
    # notification .wav assets). DATA_DIR = local_data/voicechanger (gitignored
    # per-machine state: character selection, device settings, quirks, cached
    # speaker catalog, live transcripts). Anchored off __file__ rather than a
    # bare relative path so these resolve correctly no matter what cwd the
    # process was launched with.
    PROGRAM_DIR = Path(__file__).resolve().parent
    DATA_DIR = PROGRAM_DIR.parent / "local_data" / "voicechanger"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    DEVICE_SETTINGS_FILE = DATA_DIR / 'device_settings.json'
    VOICEVOX_SPEAKERS_FILE = DATA_DIR / 'speakers.json'
    COEIROINK_SPEAKERS_FILE = DATA_DIR / 'coeiroink_speakers.json'
    CHARA_SETTINGS_FILE = DATA_DIR / 'chara_settings.json'
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
# キャラクター特有の言い回し管理 (アップデート版)
# ==========================================
class QuirksManager:
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

    def apply(self, text, engine, char_idx):
        key = f"{engine}_{char_idx}"
        if key not in self.quirks:
            return text
        
        for pattern, repl in self.quirks[key].items():
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
            with open(Config.DEVICE_SETTINGS_FILE, 'r') as f:
                settings = json.load(f)
        except FileNotFoundError:
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
class EngineManager:
    def __init__(self, audio_manager):
        self.audio_manager = audio_manager
        self.speakers_data = {"voicevox": [], "coeiroink": []}
        
        Config.AUDIO_FOLDER.mkdir(exist_ok=True)
        self._load_settings()
        self._load_voicevox_speakers()
        self._load_coeiroink_speakers()

    def _get_default_settings(self):
        return {
            "current_engine": "voicevox",
            "voicevox": {"current_character": 1, "character_styles": {"1": 0}},
            "coeiroink": {"current_character": 0, "character_styles": {"0": 0}}
        }

    def _load_settings(self):
        try:
            with open(Config.CHARA_SETTINGS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if "voicevox" in data and "current_character" not in data["voicevox"]:
                    print("Updating chara_settings.json to the new format...")
                    new_data = self._get_default_settings()
                    new_data["current_engine"] = data.get("current_engine", "voicevox")
                    for eng in ["voicevox", "coeiroink"]:
                        if eng in data:
                            old_c = data[eng].get("character_index", 0)
                            old_s = data[eng].get("style_index", 0)
                            new_data[eng]["current_character"] = old_c
                            new_data[eng]["character_styles"][str(old_c)] = old_s
                    self.settings = new_data
                    self.save_settings()
                else:
                    self.settings = data
        except (FileNotFoundError, json.JSONDecodeError):
            self.settings = self._get_default_settings()
            self.save_settings()

    def save_settings(self):
        with open(Config.CHARA_SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.settings, f, ensure_ascii=False, indent=2)

    @property
    def current_engine(self): return self.settings["current_engine"]
    
    @current_engine.setter
    def current_engine(self, val): self.settings["current_engine"] = val

    @property
    def char_idx(self): return self.settings[self.current_engine]["current_character"]
    
    @char_idx.setter
    def char_idx(self, val): 
        self.settings[self.current_engine]["current_character"] = val
        if str(val) not in self.settings[self.current_engine]["character_styles"]:
            self.settings[self.current_engine]["character_styles"][str(val)] = 0

    @property
    def style_idx(self): 
        return self.settings[self.current_engine]["character_styles"].get(str(self.char_idx), 0)
    
    @style_idx.setter
    def style_idx(self, val): 
        self.settings[self.current_engine]["character_styles"][str(self.char_idx)] = val

    def _load_voicevox_speakers(self):
        try:
            response = requests.get(f"{Config.VOICEVOX_URL}/speakers", timeout=5)
            if response.status_code == 200:
                self.speakers_data["voicevox"] = response.json()
                with open(Config.VOICEVOX_SPEAKERS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(self.speakers_data["voicevox"], f, ensure_ascii=False, indent=2)
        except requests.exceptions.RequestException:
            try:
                with open(Config.VOICEVOX_SPEAKERS_FILE, 'r', encoding='utf-8') as f:
                    self.speakers_data["voicevox"] = json.load(f)
            except Exception: pass

    def _load_coeiroink_speakers(self):
        # Mirrors _load_voicevox_speakers()'s live-fetch-then-cache-to-disk
        # pattern. Previously this only lived in memory for the lifetime of
        # this process, so nothing else (e.g. voice_service.py, which never
        # loads a live engine) could resolve a coeiroink char/style index into
        # a real name.
        try:
            response = requests.get(f"{Config.COEIROINK_URL}/v1/speakers")
            if response.status_code == 200:
                self.speakers_data["coeiroink"] = response.json()
                with open(Config.COEIROINK_SPEAKERS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(self.speakers_data["coeiroink"], f, ensure_ascii=False, indent=2)
        except requests.exceptions.RequestException:
            try:
                with open(Config.COEIROINK_SPEAKERS_FILE, 'r', encoding='utf-8') as f:
                    self.speakers_data["coeiroink"] = json.load(f)
            except Exception: pass

    def get_character_info(self):
        data = self.speakers_data[self.current_engine]
        if not data or self.char_idx >= len(data): return None, None
        
        char_data = data[self.char_idx]
        if self.current_engine == "voicevox":
            return char_data["name"], char_data["styles"][self.style_idx]["name"] if self.style_idx < len(char_data["styles"]) else None
        else:
            return char_data["speakerName"], char_data["styles"][self.style_idx]["styleName"] if self.style_idx < len(char_data["styles"]) else None

    def switch_engine(self, engine_index):
        if engine_index is not None and 0 <= engine_index < len(Config.ENGINES):
            new_engine = Config.ENGINES[engine_index]
            if not self.speakers_data[new_engine]: return f"エンジンが利用できません"
            self.current_engine = new_engine
            self.save_settings()
            return f"エンジン変更成功"
        return "無効なエンジン番号です"

    def switch_character_style(self, c_idx=None, s_idx=None):
        data = self.speakers_data[self.current_engine]
        if not data: return "キャラクターが読み込まれていません"

        if c_idx is not None:
            if 0 <= c_idx < len(data):
                self.char_idx = c_idx
            else: return "キャラクター番号が範囲外です"

        if s_idx is not None:
            styles = data[self.char_idx].get("styles", [])
            if 0 <= s_idx < len(styles):
                self.style_idx = s_idx
            else: return "スタイル番号が範囲外です"

        char_name, style_name = self.get_character_info()
        if char_name and style_name:
            self.save_settings()
            return f"{char_name}の{style_name}に変更成功"
        return "認識に失敗しました"

    def generate_hashed_filename(self, text, identifier):
        return hashlib.sha256(f"{text}_{self.current_engine}_{identifier}".encode('utf-8')).hexdigest()[:16]

    def synthesize_speech(self, text):
        cleaned_text = self.audio_manager.clean_text(text)
        if not cleaned_text.strip(): return None

        if self.current_engine == "coeiroink":
            return self._synthesize_coeiroink(cleaned_text)
        elif self.current_engine == "voicevox":
            return self._synthesize_voicevox(cleaned_text)

    def _synthesize_coeiroink(self, text):
        data = self.speakers_data["coeiroink"]
        if not data: return None
        try:
            char_data = data[self.char_idx]
            style_id = char_data["styles"][self.style_idx]["styleId"]
            speaker_uuid = char_data["speakerUuid"]
            output_path = Config.AUDIO_FOLDER / f"{self.generate_hashed_filename(text, f'uuid_{speaker_uuid}_style_{style_id}')}.wav"
            
            if output_path.exists(): return str(output_path)
            
            self.audio_manager.play_notification("synthesizing")
            payload = {
                "speakerUuid": speaker_uuid, "styleId": style_id, "text": text,
                "speedScale": 1.0, "volumeScale": 1.0, "pitchScale": 0.0,
                "intonationScale": 1.0, "prePhonemeLength": 0.1, "postPhonemeLength": 0.1,
                "outputSamplingRate": 24000,
            }
            res = requests.post(f"{Config.COEIROINK_URL}/v1/synthesis", json=payload, timeout=20)
            if res.status_code == 200:
                output_path.write_bytes(res.content)
                return str(output_path)
        except Exception: pass
        return None

    def _synthesize_voicevox(self, text):
        data = self.speakers_data["voicevox"]
        if not data: return None
        try:
            speaker_id = data[self.char_idx]["styles"][self.style_idx]["id"]
            output_path = Config.AUDIO_FOLDER / f"{self.generate_hashed_filename(text, speaker_id)}.wav"
            
            if output_path.exists(): return str(output_path)
            
            self.audio_manager.play_notification("synthesizing")
            query_res = requests.post(f"{Config.VOICEVOX_URL}/audio_query", params={"text": text, "speaker": speaker_id})
            if query_res.status_code != 200: return None
            
            synth_res = requests.post(f"{Config.VOICEVOX_URL}/synthesis", params={"speaker": speaker_id}, json=query_res.json())
            if synth_res.status_code == 200:
                output_path.write_bytes(synth_res.content)
                return str(output_path)
        except Exception: pass
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


    def _build_voice_header(self):
        # NEXUS's kohai.txt reader (vrchatLogs.ts) resolves speaker identity by
        # NAME, not by numeric slot index — a TTS engine's speaker-list index
        # for a given character shifts whenever a new voice is installed
        # (confirmed on Coeiroink and AivisSpeech), so only names survive that.
        # current_engine is already a name string ("voicevox"/"coeiroink");
        # get_character_info() already resolves char_idx/style_idx into real
        # name strings via the loaded speaker catalog.
        char_name, style_name = self.engine.get_character_info()
        return f"[VOICE|{self.engine.current_engine}|{char_name or ''}|{style_name or ''}]"

    def log_to_kohai(self, text):
        if not text or not text.strip(): return
        try:
            is_empty = not Config.KOHAI_TXT_PATH.exists() or Config.KOHAI_TXT_PATH.stat().st_size == 0
            content = ""

            if is_empty:
                header = self._build_voice_header()
                if text.strip() != header:
                    content += header + "\n"

            # --- NEW LOGIC: タイムスタンプ付与 ---
            timestamp = time.strftime('%H:%M:%S')
            clean_text = text.strip()

            # テキストが [VOICE|engine|char|style] のような状態ヘッダーの場合はタイムスタンプを付けない
            if re.match(r'^\[VOICE\|[^|]*\|[^|]*\|[^|]*\]$', clean_text):
                content += clean_text + "\n"
                log_print = clean_text
            else:
                content += f"[{timestamp}] {clean_text}\n"
                log_print = f"[{timestamp}] {clean_text}"

            with open(Config.KOHAI_TXT_PATH, 'a', encoding='utf-8') as f:
                f.write(content)
            print(f"   [Kohai Log] Appended: {log_print}")
        except Exception as e:
            print(f"   [Kohai Log Error] {e}")

    def japanese_text_to_number(self, text):
        num_map = {"ゼロ":0, "一":1, "二":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9, "十":10, 
                   "十一":11, "十二":12, "十三":13, "十四":14, "十五":15, "十六":16, "十七":17, "十八":18, "十九":19, 
                   "二十":20, "二十一":21, "二十二":22, "二十三":23, "二十四":24, "二十五":25, "二十六":26, "二十九":29}
        for kanji, num in num_map.items():
            if kanji in text: return num
        try: return int(re.findall(r'\d+', text)[0])
        except (ValueError, IndexError): return None

    async def handle_websocket(self, websocket):
        print(f"Connection established from {websocket.remote_address}")
        try:
            async for message in websocket:
                text = message.strip()
                if not text: continue
                print(f"Received: {text}")

                # コマンド処理
                if "に切り替えて" in text:
                    eng_match = re.search(r"([0-9一二三四五六七八九十ゼロ]+)番目のエンジン", text)
                    char_match = re.search(r"([0-9一二三四五六七八九十ゼロ]+)番目のキャラ", text)
                    style_match = re.search(r"([0-9一二三四五六七八九十ゼロ]+)番目のスタイル", text)
                    res_msg = ""
                    
                    if eng_match:
                        res_msg = self.engine.switch_engine(self.japanese_text_to_number(eng_match.group(1)))
                    elif char_match or style_match:
                        c_num = self.japanese_text_to_number(char_match.group(1)) if char_match else None
                        s_num = self.japanese_text_to_number(style_match.group(1)) if style_match else None
                        if c_num is not None or s_num is not None:
                            res_msg = self.engine.switch_character_style(c_num, s_num)
                        else: res_msg = "コマンドの番号を認識できませんでした"

                    if res_msg:
                        print(f"   [Command Result] {res_msg}")
                        self.log_to_kohai(self._build_voice_header())
                        
                        out_path = self.engine.synthesize_speech(res_msg)
                        if out_path: self.audio.play_audio(out_path, [self.audio.output_device_2])
                        continue

                # --- 新規追加: ハルシネーション（幻覚）の完全無視フィルター ---
                # 末尾の句読点や空白を消して純粋なテキストにする
                clean_text = re.sub(r'[。！？\s]+$', '', text)
                
                # リストと完全に一致した場合のみ、以降の処理をすべてスキップ（無視）する
                if clean_text in self.noise_hallucinations:
                    print(f"   [System] ゴミ認識を完全に無視しました: '{text}'")
                    continue

                # 通常のテキスト処理
                text = text.replace("疑問", "？").replace("ぎまん", "？").replace("ぎもん", "？").replace("ギモン", "？")
                if text.endswith("疑"): text = text[:-1] + "？"
                
                text = self.quirks.apply(text, self.engine.current_engine, self.engine.char_idx)

                pyperclip.copy(text)

                out_path = self.engine.synthesize_speech(text)
                if out_path:
                    # Synthesize and play first; play_audio is synchronous and
                    # blocks until the buffer is fully drained. Only write to
                    # kohai.txt AFTER playback completes, so any consumer (Nexus
                    # Live Session) tailing the file sees the line at the moment
                    # the audio truly finished — preventing the AI from
                    # responding before the user's voice has been spoken.
                    self.audio.play_audio(out_path, [self.audio.output_device_1, self.audio.output_device_2])

                self.log_to_kohai(text)

        except websockets.exceptions.ConnectionClosed:
            print(f"Connection closed from {websocket.remote_address}")
        except Exception as e:
            print(f"Error in websocket handler: {e}")

    async def start(self):
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