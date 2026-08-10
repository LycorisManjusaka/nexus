# Installer / distribution notes

`install.ps1` (repo root, one level up from this file) covers the core app:
`npm install` + Playwright's Chromium + a seeded `local_data/`. This file
records what it does NOT cover yet, and why, so the gap is a decision rather
than a surprise.

## Why the container/app folder names don't matter

Nexus never hardcodes its own folder name. Every cross-project path (`local_data`,
`voicechanger`, browser profiles) is resolved as `path.resolve(process.cwd(), '..', '<name>')`
-- a SIBLING of wherever the app itself is running from. `process.cwd()` is
just wherever `npm run dev` was launched from, whatever that folder is called.

So: this repo's root can be cloned as `nexus`, `chat-manager`, or anything
else -- as long as `web-app/`, `voicechanger/`, and (after install)
`local_data/` stay siblings inside it, the app finds everything correctly.
The repo's tracked layout already puts `web-app/` and `voicechanger/` at that
sibling relationship; `install.ps1` only needs to add `local_data/` next to
them, which it does.

## voicechanger

Tracked directly in this repo as a sibling folder of `web-app/`, resolved via
`NEXUS_VOICECHANGER_DIR` (default `../voicechanger` relative to `web-app`).
It's a separate Python project (real-time STT + VRChat voice changer) that
Nexus only reads a handful of files from at runtime (`chara_settings.json`,
`speakers.json`, `kohai.txt`, `ear_log.txt` -- see `src/lib/voicechangerPaths.ts`).
Its own Python dependencies (`voicechanger/requirements.txt`) and any
machine-specific setup are not installed by `install.ps1` -- see
`voicechanger/README.md`. `kohai.txt` and `ear_log.txt` are not tracked in
git; both files are opened in append mode (`open(path, 'a')`) by the Python
scripts that write them, so they're created automatically on first run if
missing.

## TTS engines (Voicevox / Coeiroink / AivisSpeech)

Not automated. Each ships as its own third-party installer/zip with
multi-gigabyte voice model downloads, and their release URLs/asset naming
aren't verified here (would need live internet access to check current
release pages before scripting a downloader, and the ergonomics of "silently
grab several GB on first run" deserve an explicit yes from whoever runs the
installer, not a default). A `-WithTtsEngines` extension is plausible once
the three exact download URLs are confirmed; until then this stays a
documented manual step.

## recognize.exe / recognize-main

Not automated, and not just because it's slow (20-30 min build from source).
The harder problem: it sometimes needs machine-specific Python source
patches, and right now those patches exist only as Lizard-kun's own
un-recorded knowledge ("I know what and where to change"). An installer can't
apply a correction that isn't written down anywhere. Before this can be
automated honestly, the patches need to become an actual artifact -- e.g. a
`.patch` file (or small set of them, keyed by whatever condition decides
which one applies) checked in somewhere versioned. Once that exists, cloning
+ building + applying the right patch is a normal scripting problem; until
then, automating "and also apply my corrections" would be promising
something this script can't actually do.
