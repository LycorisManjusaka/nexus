import argparse
import asyncio
import json
import queue
import re
import threading
import time
from pathlib import Path

import pyaudio
import websockets

import nexus_identity
# The device-matching and notification playback live in voice_changer.py and are
# USED FROM THERE, not copied. That file's select_device_by_keyword carries a
# workaround that cannot be re-derived from reading it casually: PyAudio's MME
# backend truncates device names to 31 characters, so Nexus's stored label is
# LONGER than the name the device reports, and the match has to work in that
# direction too. There are already three divergent copies of this logic in this
# folder (voice_changer.py, test.py, settings.py -- test.py's has a different
# signature), which is what copying it a fourth time would have become.
# Importing is safe: voice_changer.py has no module-level statements outside its
# classes, and its run is behind `if __name__ == "__main__"` (verified).
from voice_changer import AudioManager, Config as VcConfig

# ==========================================
# voice_service_confirm.py
#
# voice_service.py, plus ONE difference: it says out loud that it heard you.
#
# WHY THAT DIFFERENCE IS THE WHOLE POINT
# In VRChat the person speaking is inside a headset and is not looking at a
# screen. voice_service.py's only evidence that a phrase landed is a line
# scrolling past in a console window that, from in there, does not exist. So a
# phrase that was recognized and a phrase that was never heard look identical:
# nothing happens. This service plays a short sound on a speaker the other
# people in the voice chat cannot hear, so the two cases stop looking the same.
#
# WHY THE SOUND MUST NOT FIRE ON A DROPPED PHRASE
# The recognizer hallucinates when it is handed audio with no speech in it --
# measured on 2026-10-22, 6 to 15 phantom phrases per 60 seconds of noise,
# depending on the VAD (see hallucinations.json). A beep on one of those is
# worse than no beep at all: it is a signpost pointing at a road that is not
# there. She would believe a sentence had registered, and move on. So the
# filter runs FIRST and the sound only ever follows a line that was actually
# written to kohai.txt.
#
# WHY THE SOUND ALSO PLAYS ONCE AT STARTUP
# The notification device is resolved by keyword, and the keyword can be empty
# or name a speaker that is not plugged in -- in which case voice_changer.py's
# play_notification() does nothing at all, silently, by design. For this service
# silence IS the failure mode, so "the beep is not configured" must not be
# discoverable only by not hearing something. One beep at startup is the
# self-test, delivered to the one person who needs the answer.
#
# WHAT IT DOES NOT DO
# No voice changing, no TTS, no clipboard, no spoken switching commands. The
# recognition happens in recognize.exe, which connects here as a websocket
# client -- exactly the transport voice_service.py and ear_service.py use. The
# language is recognize.exe's --whisper_language; this process only chooses
# which hallucination set to filter with.
# ==========================================


class Config:
    PROGRAM_DIR = Path(__file__).resolve().parent
    DATA_DIR = PROGRAM_DIR.parent / "local_data" / "voicechanger"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    KOHAI_TXT_PATH = DATA_DIR / "kohai.txt"
    # Program dir: the knowledge of what whisper hallucinates belongs with the
    # code, is git-tracked, and improves for everyone.
    HALLUCINATIONS_FILE = PROGRAM_DIR / "hallucinations.json"
    # Data dir: what THIS machine's recognizer actually produced. Per-machine
    # observation, not shared knowledge.
    DROP_LOG = DATA_DIR / "dropped_phrases.log"
    DEVICE_SETTINGS_FILE = VcConfig.DEVICE_SETTINGS_FILE

    DEFAULT_PORT = 13002
    # Sentence-final punctuation only. Commas are NOT stripped: trimming them
    # would make "Спасибо, за просмотр" match a blocklist entry it is not.
    TRAILING_PUNCT = re.compile(r"[。．.!?！？…\s]+$")


class PhraseFilter:
    """Decides whether a recognized phrase is speech or recognizer noise.

    Three layers, cheapest first:
      1. empty / whitespace
      2. the language's hallucination set (exact strings and regexes)
      3. repeat suppression

    Layer 3 is the only one that catches hallucinations nobody has written down
    yet. It exists because of a measured shape: with silero VAD on 20 seconds of
    mains hum the recognizer emitted the SAME 50-character sentence 15 times at
    1.3-second intervals. People do not do that with long sentences -- but they
    do repeat short ones ("да", "ага", "что?"), so the rule is bounded by length
    as well as by time. A repeat that is suppressed is logged, so the bound can
    be checked against reality rather than defended from an armchair.
    """

    def __init__(self, lang, repeat_window=30.0, repeat_min_chars=15):
        self.lang = lang
        self.repeat_window = float(repeat_window)
        self.repeat_min_chars = int(repeat_min_chars)
        self.exact = set()
        self.patterns = []
        self.load_errors = []
        self._recent = {}  # normalized text -> last kept timestamp
        self._load()

    def _load(self):
        try:
            raw = json.loads(Config.HALLUCINATIONS_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.load_errors.append("%s not found" % Config.HALLUCINATIONS_FILE.name)
            return
        except Exception as e:
            self.load_errors.append("%s unreadable: %r" % (Config.HALLUCINATIONS_FILE.name, e))
            return
        block = raw.get(self.lang)
        if not isinstance(block, dict):
            # Not an error: a language with no known boilerplate is a real
            # state, and the right behaviour is to filter nothing rather than to
            # fall back to another language's list.
            self.load_errors.append("no entry for language '%s' -- nothing will be filtered by name" % self.lang)
            return
        for s in block.get("exact") or []:
            if isinstance(s, str) and s.strip():
                self.exact.add(self._norm(s))
        for p in block.get("regex") or []:
            try:
                self.patterns.append(re.compile(p))
            except Exception as e:
                self.load_errors.append("bad regex %r: %r" % (p, e))

    def _norm(self, text):
        return Config.TRAILING_PUNCT.sub("", text.strip())

    def check(self, raw_text):
        """Returns (text_to_log or None, reason_when_dropped)."""
        text = (raw_text or "").strip()
        if not text:
            return None, "empty"

        norm = self._norm(text)
        if not norm:
            return None, "punctuation only"

        if norm in self.exact:
            return None, "hallucination (exact)"
        for pat in self.patterns:
            if pat.match(norm):
                return None, "hallucination (regex %s)" % pat.pattern

        if self.repeat_window <= 0:
            # The knob's OFF position has to actually be off. Without this
            # early return, window=0 still suppressed: the prune test is
            # `now - t > window`, and `0.0 > 0.0` is false, so nothing was
            # pruned and every repeat matched. Caught by test_filter.py --
            # which exists because a knob whose off position silently does
            # nothing is worse than no knob: it cannot be ruled out while
            # diagnosing a phrase that went missing.
            return text, None

        now = time.time()
        # Prune first so the dict cannot grow without bound across a long
        # session.
        for k in [k for k, t in self._recent.items() if now - t > self.repeat_window]:
            del self._recent[k]
        if len(norm) >= self.repeat_min_chars and norm in self._recent:
            age = now - self._recent[norm]
            # Refresh the stamp: a phrase repeating every second must stay
            # suppressed for as long as it keeps repeating, not come back after
            # the window happens to roll over.
            self._recent[norm] = now
            return None, "identical repeat within %.0fs (%.1fs ago, %d chars)" % (
                self.repeat_window, age, len(norm))
        self._recent[norm] = now
        return text, None


class Beeper:
    """Plays the confirmation sound without blocking the websocket loop.

    WHY THIS OPENS THE STREAM ITSELF INSTEAD OF CALLING play_notification()
    It did call it, and the startup self-test printed "a single short sound
    just played" while the console one line above read

        Error playing notification processing:
            [Errno -9999] Unanticipated host error

    voice_changer.py's play_notification() catches its own exception, prints
    it, and returns normally -- which is right for the voice changer, where a
    missed beep is cosmetic, and wrong here, where the beep IS the product. A
    self-test that cannot fail is not a test. So the division is: the knowledge
    stays shared (select_device_by_keyword carries the MME 31-character
    truncation workaround, which is not re-derivable by reading it), and the
    eight lines that must report their own failure are owned here.

    The queue plus one daemon thread keeps the asyncio loop free -- a
    synchronous stream write would stall every phrase behind the previous
    phrase's sound. The queue is bounded so a flood drops BEEPS rather than
    building a backlog of sounds that arrive after the speaker has moved on.
    """

    def __init__(self, audio_manager, sound_key, device_index, maxsize=4):
        self.am = audio_manager
        self.sound_key = sound_key
        self.device_index = device_index
        self.q = queue.Queue(maxsize=maxsize)
        self.dropped = 0
        self.played = 0
        self.failed = 0
        self.last_error = None
        sound = audio_manager.notification_sounds.get(sound_key)
        if sound is None:
            raise RuntimeError("notifications/%s.wav missing or unreadable" % sound_key)
        self.params = sound["params"]
        self.frames = sound["frames"]
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _play(self):
        """Raises on failure. That is the entire reason it is not inherited."""
        p = pyaudio.PyAudio()
        try:
            stream = p.open(format=p.get_format_from_width(self.params.sampwidth),
                            channels=self.params.nchannels,
                            rate=self.params.framerate,
                            output=True,
                            output_device_index=self.device_index)
            try:
                stream.write(self.frames)
                stream.stop_stream()
            finally:
                stream.close()
        finally:
            p.terminate()

    def _run(self):
        while True:
            self.q.get()
            try:
                self._play()
                self.played += 1
            except Exception as e:
                self.failed += 1
                self.last_error = repr(e)
                # Every failure, not just the first: a device that works and
                # then stops (headset powered off mid-session) is the case
                # where knowing matters most.
                print("   [Beep] FAILED (%d): %r" % (self.failed, e), flush=True)

    def beep(self):
        try:
            self.q.put_nowait(1)
        except queue.Full:
            self.dropped += 1

    def beep_blocking(self):
        """Startup self-test: play on this thread, and let the exception out."""
        self._play()
        self.played += 1


class ConfirmService:
    def __init__(self, args):
        self.args = args
        self.filter = PhraseFilter(args.lang, args.repeat_window, args.repeat_min_chars)
        self.am = AudioManager()
        self.notify_name = None
        self.notify_reason = None
        self.notify_index = None
        self.beeper = None
        self.selftest_error = None
        self.kept = 0
        self.dropped = 0

    # ── device resolution ────────────────────────────────────────────────────

    def resolve_notify_device(self):
        if self.args.no_notify:
            self.notify_reason = "disabled with --no-notify"
            return
        devices = self.am.list_devices()
        keyword = (self.args.notify_device or "").strip()
        source = "--notify-device"
        if not keyword:
            try:
                settings = json.loads(Config.DEVICE_SETTINGS_FILE.read_text(encoding="utf-8"))
            except Exception:
                settings = {}
            keyword = (settings.get("notification_speaker_keyword") or "").strip()
            source = "device_settings.json: notification_speaker_keyword"
        if not keyword:
            self.notify_reason = (
                "no speaker configured -- pass --notify-device \"<part of the "
                "speaker name>\", or set the notification speaker in Nexus "
                "(Settings -> voice changer devices)")
            return
        idx, name = self.am.select_device_by_keyword(devices, keyword, is_output=True)
        if idx is None:
            # Deliberately does not guess WHY. The same symptom covers "still
            # the placeholder", "unplugged", and "spelled differently", and
            # naming one of them would send the reader down the wrong road.
            self.notify_reason = (
                "no output device matches %r (from %s).\n"
                "  !! Run with --list-devices for the exact names. Measured on"
                " 2026-10-22: the\n"
                "  !! highest-numbered duplicates are WDM-KS endpoints and"
                " every one of them\n"
                "  !! refuses to open -- including 'Headphones (Realtek USB"
                " Audio)'. Pick a\n"
                "  !! lower-numbered copy of the same device."
                % (keyword, source))
            return
        # Kept in sync so anything that still reaches for the voice changer's
        # own field sees the same device this service chose.
        self.am.output_device_2 = idx
        self.notify_index = idx
        self.notify_name = "%s (index %d, from %s)" % (name, idx, source)

    # ── logging ─────────────────────────────────────────────────────────────

    @property
    def kohai_path(self):
        return Path(self.args.kohai) if self.args.kohai else Config.KOHAI_TXT_PATH

    def log_to_kohai(self, text):
        # The speaker is resolved per line, not once at startup: the human can
        # switch identity mid-session from any Nexus window and the next line
        # must already say the new name. Same contract as voice_service.py.
        line = nexus_identity.transcript_line(text)
        with open(self.kohai_path, "a", encoding="utf-8") as f:
            f.write(line)
        return line

    @property
    def drop_log_path(self):
        # When the transcript is redirected, the drop log follows it. Otherwise
        # the end-to-end test would leave fixture sentences in the real log that
        # a human later reads to decide what to add to hallucinations.json --
        # and "Это довольно длинное предложение для теста повторов" would look
        # like something the recognizer invented.
        if self.args.kohai:
            return self.kohai_path.with_suffix(".drops.log")
        return Config.DROP_LOG

    def log_drop(self, text, reason):
        try:
            with open(self.drop_log_path, "a", encoding="utf-8") as f:
                f.write("[%s] (%s) %s\t%s\n"
                        % (time.strftime("%Y-%m-%d %H:%M:%S"), reason,
                           text.replace("\t", " "), self.args.lang))
        except Exception as e:
            print("   [Drop log error] %r" % (e,), flush=True)

    # ── websocket ───────────────────────────────────────────────────────────

    async def handle(self, websocket):
        print("[Confirm] recognizer connected: %s" % (websocket.remote_address,), flush=True)
        try:
            async for message in websocket:
                text, reason = self.filter.check(message)
                if text is None:
                    self.dropped += 1
                    self.log_drop((message or "").strip(), reason)
                    print("   [DROP %d] %s  <- %s" % (self.dropped, reason, (message or "").strip()), flush=True)
                    continue
                try:
                    line = self.log_to_kohai(text)
                except Exception as e:
                    # Do NOT beep: the sound means "it is written down".
                    print("   [Kohai Log Error] %r" % (e,), flush=True)
                    continue
                self.kept += 1
                if self.beeper:
                    self.beeper.beep()
                print("   [KEEP %d] %s" % (self.kept, line.rstrip()), flush=True)
        except websockets.exceptions.ConnectionClosed:
            print("[Confirm] recognizer disconnected: %s" % (websocket.remote_address,), flush=True)
        except Exception as e:
            print("[Confirm] error: %r" % (e,), flush=True)

    # ── startup ─────────────────────────────────────────────────────────────

    def banner(self):
        ident, style, _ovr = nexus_identity.resolve()
        print("=========================================")
        print("  Voice Service + audible confirmation")
        print("  Port:      %d  (point recognize.exe at ws://127.0.0.1:%d)"
              % (self.args.port, self.args.port))
        print("  Log file:  %s%s"
              % (self.kohai_path, "   <-- NOT the live kohai.txt" if self.args.kohai else ""))
        print("  Identity:  %s%s" % (ident.name, (" (%s)" % style) if style else ""))
        print("  Language:  %s  (filter set; the recognizer decides the actual language)"
              % self.args.lang)
        print("  Filter:    %d exact, %d patterns, repeat>=%dch within %.0fs"
              % (len(self.filter.exact), len(self.filter.patterns),
                 self.args.repeat_min_chars, self.args.repeat_window))
        for e in self.filter.load_errors:
            print("  !! filter:  %s" % e)
        if self.notify_name and not self.selftest_error:
            print("  Sound:     %s -> %s" % (self.args.notify_sound, self.notify_name))
            print("             (it just played once -- that was the self-test)")
        elif self.notify_name:
            # Resolved but unplayable. This is a real, measured state: the
            # WASAPI endpoint 'Headphones (Realtek USB Audio)' resolves fine on
            # this machine and then refuses to open with
            # [Errno -9999] Unanticipated host error. Saying "configured" here
            # would be the lie the self-test exists to prevent.
            print("  !! SOUND RESOLVED BUT WOULD NOT PLAY: %s" % self.notify_name)
            print("  !! %s" % self.selftest_error)
            print("  !! Try a different speaker: --list-devices, then")
            print("  !! --notify-device \"<part of the name>\". Low-numbered (MME)")
            print("  !! endpoints play where high-numbered (WASAPI) ones often do not.")
        else:
            # Loud, because for THIS service a silent beep is the failure the
            # whole thing exists to prevent.
            print("  !! SOUND IS OFF: %s" % self.notify_reason)
            print("  !! Phrases will still be logged, but nothing will be audible.")
        print("=========================================")

    def check_port_free(self):
        """Fail on a taken port BEFORE anything else happens.

        The first version resolved the speaker, played the self-test, printed
        the whole banner, and only then raised

            OSError: [Errno 10048] error while attempting to bind ...

        from inside websockets.serve -- so a run that never served anything
        announced that the sound was working. A port conflict makes every other
        line of the banner moot, and it is the likely one: voice_changer.py
        holds 13000 and ear_service.py 13001, so starting this on either while
        that one runs is an ordinary mistake, not an exotic one.
        """
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", self.args.port))
        except OSError as e:
            print("=========================================")
            print("  CANNOT START: port %d is already in use" % self.args.port)
            print("  %r" % (e,))
            print("  voice_changer.py uses 13000 and ear_service.py uses 13001.")
            print("  Pass --port with a free one, or stop the service holding it.")
            print("=========================================")
            return False
        finally:
            s.close()
        return True

    async def start(self):
        if not self.check_port_free():
            return
        self.resolve_notify_device()
        if self.notify_name:
            try:
                self.beeper = Beeper(self.am, self.args.notify_sound, self.notify_index)
            except Exception as e:
                self.selftest_error = "beeper could not be built: %r" % (e,)
        # The self-test runs BEFORE the banner on purpose. The first version
        # printed the banner first and then played, so the banner announced
        # "a single short sound just played" one line under the host error that
        # said it had not. The banner may only report what already happened.
        if self.beeper:
            try:
                self.beeper.beep_blocking()
            except Exception as e:
                self.selftest_error = "%r" % (e,)
        self.banner()
        if self.beeper and not self.selftest_error:
            print("If you did NOT hear that sound, the speaker that resolved is not the one")
            print("in your ears -- see --list-devices and --notify-device.")
            print("今の音が聞こえなければ、選ばれたスピーカーが耳元のものではありません。")
        print("recognize.exe を起動してください（--out yukacone --out_yukacone %d）。"
              % self.args.port, flush=True)

        async with websockets.serve(self.handle, "127.0.0.1", self.args.port):
            await asyncio.Future()


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Append recognized speech to kohai.txt and confirm it with a sound.")
    p.add_argument("--port", type=int, default=Config.DEFAULT_PORT,
                   help="websocket port recognize.exe connects to (default %d; "
                        "voice_changer.py uses 13000 and ear_service.py 13001)"
                        % Config.DEFAULT_PORT)
    p.add_argument("--lang", default="ru",
                   help="which hallucination set in hallucinations.json to use (default ru)")
    p.add_argument("--notify-device", default="",
                   help="part of the output device name to play the sound on. "
                        "Overrides device_settings.json's notification speaker, so "
                        "this service can beep into headphones while the voice "
                        "changer keeps its own devices.")
    p.add_argument("--notify-sound", default="processing",
                   choices=sorted(VcConfig.NOTIFICATIONS.keys()),
                   help="which file in notifications/ to play (default processing)")
    p.add_argument("--no-notify", action="store_true",
                   help="log only, play nothing (for testing on a machine with no speaker)")
    p.add_argument("--repeat-window", type=float, default=30.0,
                   help="seconds an identical phrase stays suppressed (default 30)")
    p.add_argument("--repeat-min-chars", type=int, default=15,
                   help="shorter phrases are never repeat-suppressed, so 'да' twice "
                        "is kept twice (default 15)")
    p.add_argument("--list-devices", action="store_true",
                   help="print the output devices and exit")
    p.add_argument("--kohai", default="",
                   help="write the transcript somewhere other than the kohai.txt "
                        "Nexus reads. Used by the end-to-end test so it does not "
                        "put fixture sentences into the live Audio Session.")
    return p.parse_args(argv)


def main():
    args = parse_args()
    if args.list_devices:
        am = AudioManager()
        print("index | outputs | name")
        for idx, name, _ins, outs in am.list_devices():
            if outs > 0:
                print("%5d | %7d | %s" % (idx, outs, name))
        return 0
    service = ConfirmService(args)
    try:
        asyncio.run(service.start())
    except KeyboardInterrupt:
        print("\n[Confirm] stopped. kept=%d dropped=%d%s"
              % (service.kept, service.dropped,
                 (" beeps_dropped=%d" % service.beeper.dropped) if service.beeper else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
