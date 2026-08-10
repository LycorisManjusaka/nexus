# Installer / distribution notes

`install.ps1` covers the core app: clone + `npm install` + Playwright's
Chromium. This file records what it does NOT cover yet, and why, so the gap
is a decision rather than a surprise.

## Why the container/app folder names don't matter

Nexus never hardcodes its own folder name. Every cross-project path (`local_data`,
`voicechanger`, browser profiles) is resolved as `path.resolve(process.cwd(), '..', '<name>')`
-- a SIBLING of wherever the app itself is running from. `process.cwd()` is
just wherever `npm run dev` was launched from, whatever that folder is called.

So: cloning `github.com/LycorisManjusaka/nexus.git` with a bare `git clone`
produces a folder named `nexus` (git default: strip `.git` from the URL) --
but `git clone <url> web-app` produces a folder named `web-app` regardless of
what the repo itself is called. `install.ps1` always does the latter. The
GitHub repo's own name and the local folder name are independent; only the
SIBLING relationship between the app folder and `local_data`/`voicechanger`
matters, and the installer preserves that by construction.

This is also why nesting the app under a `nexus/web-app/` path INSIDE the
repo's own tracked history (i.e. rewriting the repo so its root IS the
container and `web-app/` is a tracked subdirectory) is not needed to get the
folder layout Lizard-kun described. The installer produces that exact layout
today, with a plain `git clone <url> <dir>`, without any history rewrite.
Doing the rewrite anyway is possible (`git filter-repo` can move every
existing commit's tree under a `web-app/` prefix) but it changes the
permanent shape of the one repo two live working copies (`web-app`,
`web-app-cairn`) both depend on, on the same machine Cairn runs on -- not
something to do casually inside a single session. If it's still wanted, it
should be planned as a deliberate, supervised, backed-up operation, not
folded into a routine installer.

## voicechanger

Currently Mercurial-tracked, outside the git repo, resolved as a sibling
(`NEXUS_VOICECHANGER_DIR`, default `../voicechanger`). Two ways to fold it
into "one install pulls everything" without touching that resolution code:

1. **Convert its Mercurial history to a second Git repo** (e.g.
   `nexus-voicechanger`) and have the installer clone it as a sibling --
   `-WithVoicechanger -VoicechangerUrl <url>` is already wired for this.
   Zero application code changes.
2. Git submodule inside the main repo -- rejected for now, because a
   submodule lives INSIDE its parent repo's tree (`web-app/voicechanger`),
   which is a child, not a sibling, and would require changing every
   `../voicechanger` resolution in the code to a bare `voicechanger`. Doable,
   but it's a real code change for a convenience the separate-repo approach
   gets for free.

Not done yet: the actual hg-to-git conversion needs the real `voicechanger/.hg`
history on the machine that has it, plus a decision on whether the converted
history is worth keeping or whether a fresh `git init` snapshot is good
enough.

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
