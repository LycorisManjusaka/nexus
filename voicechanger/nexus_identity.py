"""
nexus_identity.py — the voice changer's window onto Nexus's identity files.

Two files in local_data, both owned by Nexus, both read-only from here:

    user_identity.json   {"identity": "ふわふわ", "style": "あまあま"}
    character_map.json   {"rules": [{"name", "engine"?, "character"?,
                                     "defaultStyle"?}, ...],
                          "fallback": "...", "humanLabel": "..."}

Everything is a NAME. The original design stored numeric slot indices because
the voice changer predates Nexus and was driven by SPOKEN commands: speech
recognition cannot reliably hear a Japanese character name, but it can hear a
number. Nexus is now the only front-end, and indices turned out to be actively
harmful — Coeiroink and AivisSpeech renumber their entire speaker list whenever
a new voice is installed, silently repointing every saved identity at a
different character. So names are what is stored; an index is re-derived from
whatever the engine reports at the moment of synthesis and never written down.

Spoken switching commands still take a number ("三番目の人格に切り替えてください"),
because that constraint on the EAR has not changed. The number indexes the
identity list as it stands when the command is heard; only the resulting name is
persisted.

Nothing here writes character_map.json. This module writes user_identity.json
only, and only when a switch is actually requested.
"""

import json
import os
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "local_data"
USER_IDENTITY_FILE = DATA_DIR / "user_identity.json"
CHARACTER_MAP_FILE = DATA_DIR / "character_map.json"

# Separator inside a transcript speaker tag: "(Name|Style)".
LABEL_SEP = "|"

# Legacy numeric engine ids, as written by the pre-name schema. Only used when
# reading a character_map.json that has not been migrated yet.
_LEGACY_ENGINE_BY_NUM = {"0": "voicevox", "1": "coeiroink", "2": "aivisspeech"}


def _read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


class Identity:
    """One resolved identity: a display name, and optionally a voice."""

    def __init__(self, name, engine=None, character=None, default_style=None):
        self.name = name
        self.engine = engine
        self.character = character
        self.default_style = default_style

    @property
    def has_voice(self):
        return bool(self.engine and self.character)

    def __repr__(self):
        return f"<Identity {self.name} engine={self.engine} character={self.character}>"


def _normalize_rule(raw):
    """Accepts any schema generation and returns an Identity (voice may be None).

    A legacy numeric charId cannot be turned back into a name here — that needs
    the engine's speaker catalog, which the caller has and this module does not.
    Such a rule arrives as a name with no voice, which is honest: the identity
    still exists, it just cannot be spoken until it is re-picked in Nexus.
    """
    name = str((raw or {}).get("name") or "").strip()
    if not name:
        return None
    engine = raw.get("engine")
    engine = str(engine) if engine else None
    if engine in _LEGACY_ENGINE_BY_NUM:
        engine = _LEGACY_ENGINE_BY_NUM[engine]
    character = raw.get("character") or raw.get("charName") or None
    if not engine or not character:
        return Identity(name)
    style = raw.get("defaultStyle") or raw.get("styleName") or None
    return Identity(name, engine, character, style)


def load_identities():
    """Every identity in character_map.json, in file order.

    File order is the order Nexus's dropdown shows and the order the spoken
    "〇番目の人格" command counts through, so it must not be sorted here.
    """
    raw = _read_json(CHARACTER_MAP_FILE, {}) or {}
    out = []
    for rule in raw.get("rules") or []:
        ident = _normalize_rule(rule)
        if ident:
            out.append(ident)
    return out


def load_map_meta():
    raw = _read_json(CHARACTER_MAP_FILE, {}) or {}
    return {
        "fallback": raw.get("fallback") or "Anonymous",
        "humanLabel": raw.get("humanLabel") or "Human",
    }


def read_selection():
    """The raw contents of user_identity.json, or None."""
    raw = _read_json(USER_IDENTITY_FILE, None)
    if not isinstance(raw, dict):
        return None
    identity = raw.get("identity")
    if not isinstance(identity, str) or not identity.strip():
        return None
    style = raw.get("style")
    style = style.strip() if isinstance(style, str) and style.strip() else None
    return {"identity": identity.strip(), "style": style}


def write_selection(identity_name, style=None):
    """Atomic write — Nexus reads this file from another process.

    A style equal to the identity's own defaultStyle is stored as no style at
    all: absent already means exactly that, and keeping it implicit is what lets
    the transcript line read as a plain "(ふわふわ)".
    """
    body = {"identity": identity_name}
    if style:
        body["style"] = style
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DATA_DIR / f".user_identity.json.tmp-{os.getpid()}-{int(time.time() * 1000)}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        os.replace(tmp, USER_IDENTITY_FILE)
        return True
    except Exception as e:
        print(f"   [Identity] 書き込み失敗: {e}")
        try:
            tmp.unlink()
        except Exception:
            pass
        return False


def resolve():
    """Who is speaking right now.

    Returns (Identity, effective_style, style_is_override). Falls back to the
    map's configured fallback identity when the selection is missing or names an
    identity that has since been renamed or deleted — and does NOT rewrite the
    file to "fix" that, because a read with a side effect would silently
    overwrite a selection the human is in the middle of editing.
    """
    identities = load_identities()
    meta = load_map_meta()
    sel = read_selection()

    ident = None
    if sel:
        ident = next((i for i in identities if i.name == sel["identity"]), None)
    if ident is None:
        ident = next((i for i in identities if i.name == meta["fallback"]), None)
        if ident is None:
            ident = Identity(meta["fallback"])
        return ident, ident.default_style, False

    override = None
    if sel and sel["style"] and sel["style"] != ident.default_style:
        override = sel["style"]
    return ident, (override or ident.default_style), bool(override)


def speaker_label():
    """The tag written into kohai.txt: "Name", or "Name|Style" when a style
    other than the identity's default is in effect."""
    ident, style, is_override = resolve()
    if is_override and style:
        return f"{ident.name}{LABEL_SEP}{style}"
    return ident.name


def transcript_line(text, timestamp=None):
    """One kohai.txt line: "[HH:MM:SS] (Name|Style) text".

    Identical in shape to what ear_service.py writes, which is the point: with
    no state headers left, Nexus's merge parses both transcripts with one
    regex instead of two, and mixing them is trivial.
    """
    ts = timestamp or time.strftime("%H:%M:%S")
    return f"[{ts}] ({speaker_label()}) {text}\n"


# ── Spoken switching commands ─────────────────────────────────────────────────

def switch_identity_by_index(index):
    """"〇番目の人格に切り替えてください" — 1-based, as spoken.

    Switching identity clears any style override: a style belongs to one
    specific character, so carrying it across would name a style the new
    character has never heard of.

    Returns the new Identity, or None when the number names nobody.
    """
    identities = load_identities()
    if index < 1 or index > len(identities):
        return None
    target = identities[index - 1]
    if not write_selection(target.name, None):
        return None
    return target


def switch_style_by_index(index, styles):
    """"〇番目のスタイルに切り替えてください" — 1-based, into the CURRENT
    identity's character styles, which the caller supplies because only it has
    the live engine.

    Returns the chosen style name, or None when the number names nothing.
    """
    if not styles or index < 1 or index > len(styles):
        return None
    ident, _style, _is_override = resolve()
    target = styles[index - 1]
    # A pick that merely names the identity's own default is stored as no
    # override — see write_selection().
    stored = None if target == ident.default_style else target
    if not write_selection(ident.name, stored):
        return None
    return target
