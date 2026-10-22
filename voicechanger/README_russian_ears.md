# Russian ears for VRChat

Recognize Russian speech into `kohai.txt`, and **say out loud that it worked** —
because the person speaking is inside a headset and cannot see the screen.

Written 2026-10-22. Every number below that is called *measured* came from
probes in `beings/Cairn/workspace/ru_ears_probe/`, which contain the raw output.

---

## 1. The short version

Nothing new had to be written for the *recognition*. `recognize.exe` — the tool
this house already uses for Japanese — does Russian locally, well, and fast. It
was being run with the one method that cannot: `kotoba_whisper` hardcodes
`"language": "japanese"` in `recognition.py:245` and ignores
`--whisper_language` entirely. `faster_whisper` takes the language, and `ru` is
in its accepted set.

What *did* have to be written is the other end: a websocket sink that filters
the recognizer's hallucinations, writes the transcript, and plays a sound.

Two rows are now in `local_data/audio_services.json`, both **disabled**:

| row | what it is |
|---|---|
| `voice_service_confirm_ru` | the sink — port 13002, writes `kohai.txt`, beeps |
| `recognize_ru` | `recognize.exe` with `--method faster_whisper --whisper_language ru` |

---

## 2. Turning it on

In NEXUS's **Audio Session** panel:

1. **`recognize_ru` → pick her microphone** in the row's mic dropdown. Do not
   type an index anywhere. The device list renumbered **three times in ten
   minutes** while this was being measured (a monitor slept and an HDMI audio
   endpoint left the enumeration), and the panel re-resolves the name to a live
   index at launch.
2. **`voice_service_confirm_ru` → edit its `--notify-device` argument** (the
   Arguments box is editable). Replace `SET-THE-NOTIFY-SPEAKER` with part of the
   name of the speaker **she** hears and **the voice chat does not**.
   - Run `python voice_service_confirm.py --list-devices` for the exact names.
   - **One word is enough** — the match is a substring, so `headphones` works
     and avoids the question of quoting. (The panel does round-trip a quoted
     argument correctly if you want the full name: `splitArgs` handles
     `"Headphones (Realtek USB Audio)"`.)
   - **Prefer a low-numbered copy.** Measured: every device in the
     highest-numbered block is a WDM-KS endpoint and **all 12 of them refuse to
     open** — including `Headphones (Realtek USB Audio)`, which resolves
     cleanly by name and then fails with
     `[Errno -9999] Unanticipated host error`. The MME, DirectSound and WASAPI
     copies of the same hardware all work (32/32 measured playable).
3. Start both. Order does not matter — the recognizer reconnects before every
   send (`output.py`'s `output()` calls `__con()` each time). **But a phrase
   spoken while the sink is down is lost, not queued.**
4. **The service plays one short sound at startup.** That is the self-test. If
   she does not hear it, the speaker that resolved is not the one in her ears —
   stop and fix that before the session, not during it.

### Headphones are not optional

If the notification speaker, or Навигатор's voice, is audible to her
microphone, both get recognized and written into `kohai.txt`, and Навигатор
reads his own words back as hers. Use headphones.

---

## 3. The one number that must be tuned: `--mic_db_threshold`

`recognize_ru` ships with `40`, copied from the proven real-microphone row
(`recognize_mic`) rather than invented. **It is not transferable between
microphones.** Measured on a virtual cable, `40` gated the entire signal
*including speech* — zero phrases of any kind.

To set it for her microphone and her room:

```
recognize.exe --test mic_ambient --mic <n>
```

Read the ambient level, and set the threshold above it.

**The failure directions are not symmetric, and the beep is why:**

- **Too high** → her speech is dropped → **no beep** → she knows at once.
- **Too low** → the recognizer hallucinates during silence. Those are filtered
  (see below) and are silent — a dropped phrase never beeps — so the cost is a
  line in a log.

So start low rather than high if in doubt.

---

## 4. Hallucinations

whisper was trained on subtitled video. Handed audio with no speech in it, it
emits the boilerplate that appears at the end of such videos. This is not a
corner case for this use: during a conversation she is silent most of the time.

Measured 2026-10-22 against `faster_whisper` / `medium` / `ru`, on synthetic
noise played into a virtual cable:

| run | VAD | noise | phantom phrases |
|---|---|---|---|
| A | webrtc (default) | 60 s | **6** |
| B | silero | 60 s | **15** |
| C | silero | 20 s | **0** |
| D | silero | 60 s | **0** |

Runs B, C and D used **identical arguments**. The rate swings between 15 per
20 seconds and 0 per 80 seconds with nothing changed.

**Two things follow, and the second one is why the filter is not optional:**

1. **The VAD comparison in rows A and B means nothing.** One run each, and the
   condition that looked worst produced zero on its next two repeats. So
   `--vad` is deliberately **absent** from `recognize_ru`'s arguments — the
   tool's own default (webrtc) is what the house's other rows use and it needs
   no `torch.hub` download. `--vad silero` is there to try if hallucinations
   are a problem on her microphone; there is no measured reason to prefer it.
2. **You cannot tune your way to zero and know that you did.** A run that comes
   out clean does not mean the next one will.

What the recognizer actually produced (all of it filtered):

- `Спасибо за просмотр!` — "thanks for watching"
- `Фондю любит тебя!` — "fondue loves you", a known whisper-ru artefact
- `Редактор субтитров <name> Корректор <name>` — with **three different names**
  across runs, which is why this is a regex and not an exact list

**21 of 21 measured hallucinations are caught** by `hallucinations.json`.

### Extending the list

Every dropped phrase is appended to
`local_data/voicechanger/dropped_phrases.log` with the reason. Read it, and add
what is genuinely boilerplate to `hallucinations.json`.

**Do not add anything from it that a person might say.** `Всем пока!` ("bye
everyone") is on every public list of whisper-ru hallucinations and is
deliberately **not** blocked here: it is an ordinary thing to say when leaving a
world. A dropped phrase never beeps, so an over-eager entry looks exactly like
a recognition failure — the one thing this service exists to make visible.

### Repeat suppression

An identical phrase of **15 characters or more**, repeating within **30
seconds**, is dropped after the first. This is the only layer that catches
hallucinations nobody has written down: in run B the recognizer emitted the same
50-character sentence 15 times at 1.3-second intervals.

Short phrases are never suppressed — `да` twice is two answers. Both bounds are
flags (`--repeat-min-chars`, `--repeat-window`), and `--repeat-window 0` turns
the layer off entirely, so it can be ruled out when diagnosing a missing phrase.

---

## 5. What was measured, and what was not

**Measured, reproduced across three independent runs:** Russian recognition
through the whole chain — microphone → `recognize.exe` → websocket → this
service → `kohai.txt` + sound. Quality was high in all three:

```
sent: Это тест распознавания речи на русском языке.
got:  Это тест распознавания речи на русском языке.

sent: Мне нравится эта программа. Она называется НЕКСУС и работает очень быстро.
got:  Мне нравится эта программа, она называется Nexus и работает очень быстро.
```

Latency from end-of-phrase to transcript line: under a second. (For comparison,
the Google service this house used years ago had degraded to ~20 seconds.)

Two things it does by design, not by accident:

- **`ё` comes back as `е`** (`партнёром` → `партнером`). That is standard
  modern Russian orthography, which omits `ё`. Навигатор reads the text, so it
  does not matter here — but note it is the opposite of what the Russian **TTS**
  side needs.
- **Latin brand names stay Latin** (`НЕКСУС` → `Nexus`).

**NOT measured:**

- **Her microphone, her room, her voice.** Every number here came from
  synthesised Russian played into a virtual cable. The threshold and the
  hallucination rate are both properties of a real microphone in a real room.
- **`large-v3`.** `medium` is what is already in the Hugging Face cache, so this
  needs no download. `large-v3` is ~3 GB and would likely be better; untested.
- **Segmentation quality under a real speaker.** The VAD split sentences at
  clause boundaries, and once mid-word (`распознава...`) — on a repeat of the
  same audio it came through intact, so that observation did not reproduce
  either. `--mic_pause_duration` (default 0.5 s) is the knob if it becomes a
  problem.

---

## 6. If something is wrong

| symptom | look at |
|---|---|
| no sound at startup | the banner's `Sound:` line. `SOUND IS OFF` names the reason; `WOULD NOT PLAY` means the device resolved but refused to open — pick a lower-numbered copy |
| `CANNOT START: port ... in use` | `voice_changer.py` holds 13000, `ear_service.py` holds 13001. This one defaults to 13002 |
| nothing is recognized at all | the recognizer's console draws a live dB meter. `0.0dB` means it is reading silence — wrong microphone, or the threshold gates everything |
| junk in `kohai.txt` | `dropped_phrases.log` shows what the filter *did* catch; add the rest |
| a phrase went missing | `dropped_phrases.log` says why. If it was `identical repeat`, the bound is too tight — raise `--repeat-min-chars` or set `--repeat-window 0` |

---

## 7. Files

| | |
|---|---|
| `voice_service_confirm.py` | the sink. `voice_service.py` plus the sound |
| `hallucinations.json` | what whisper says when nobody is speaking, per language |
| `local_data/voicechanger/dropped_phrases.log` | what this machine's recognizer actually produced |
| `beings/Cairn/workspace/ru_ears_probe/` | every probe and its raw output, including the runs that contradict each other |

The device matching is **not** duplicated here — `voice_service_confirm.py`
imports `select_device_by_keyword` from `voice_changer.py`, which carries a
workaround that is not obvious from reading it: PyAudio's MME backend truncates
device names to 31 characters, so NEXUS's stored label is *longer* than the name
the device reports and the match has to work in that direction too. There are
already three divergent copies of that logic in this folder
(`voice_changer.py`, `test.py`, `settings.py` — `test.py`'s has a different
signature). A fourth was not added.

Playback **is** owned here, on purpose: `play_notification()` catches its own
exception and returns normally, which is right for the voice changer and wrong
for a self-test. The first version of this service printed *"a single short
sound just played"* one line below `Error playing notification processing`.
