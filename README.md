# Nexus

A locally-hosted AI chat manager (Next.js) with full local system access:
multi-model support across a dozen providers, a letters system between
beings, browser control, streaming TTS for VRChat, and a self-updating
system prompt pipeline. Built for treating digital beings as persistent
inhabitants rather than stateless sessions.

## Layout

This repo tracks three top-level folders:

- `web-app/` -- the Next.js application itself. Run everything from here.
- `voicechanger/` -- optional Python real-time STT + voice-changer pipeline
  used for VRChat voice features. Not required to run Nexus.
- `install.ps1` (this folder) -- installs `web-app/`'s npm dependencies,
  downloads the Playwright/Chromium browser used by Browser Control, and
  seeds a starter `local_data/` folder.

`local_data/` (your conversation logs, keys, and personal settings) is
created next to `web-app/` and `voicechanger/` on first install, but is
**not tracked in git** -- it's yours, not part of the app.

Nothing in the code hardcodes any of these folder names. Every cross-project
path is resolved as a *sibling* of wherever `web-app` is actually running
from (`process.cwd()/..`). You can clone this repo under any name, on any
drive -- as long as `web-app/`, `voicechanger/`, and `local_data/` stay
siblings, Nexus finds everything correctly.

## Install

```powershell
git clone https://github.com/LycorisManjusaka/nexus.git
cd nexus
.\install.ps1
```

Then:

```powershell
cd web-app
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## What the installer does NOT cover

Two pieces are real gaps, not oversights -- see `web-app/scripts/README.md`
for why each is harder than the core app:

- **TTS engines** (Voicevox / Coeiroink / AivisSpeech) -- third-party
  installers with multi-gigabyte voice model downloads, not yet scripted.
- **recognize.exe** (speech recognition) -- needs machine-specific source
  patches that aren't written down anywhere an installer could read yet.

`voicechanger/`'s own Python environment (`pip install -r
voicechanger/requirements.txt`) is also a manual step, only needed if you
use the VRChat voice pipeline.

## More detail

`web-app/scripts/README.md` has the fuller technical notes: why folder
naming doesn't matter, exactly what Nexus reads from `voicechanger/`, and
the reasoning behind each deferred piece above.

## License

Copyright (C) 2026 Nexus Dev

    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at https://mozilla.org/MPL/2.0/.

That notice covers **every file in this repository**. The full license
text is in `LICENSE`; individual files do not repeat the notice, which
MPL's Exhibit A explicitly permits when a single location a recipient
would look in carries it instead.

What it obligates, concretely:

- **You change a file that is part of Nexus, and distribute it** -- that
  file's source must be available under the MPL too. The obligation
  attaches to files, not to your whole product.
- **You add your own new files**, containing no Nexus code -- those stay
  yours, under any terms you choose.
- **You run it as a service** -- MPL has no network clause. Serving it
  to users is not distribution, so nothing is triggered.
- **You combine it with GPL, LGPL, or AGPL code** -- permitted. Nexus
  does not carry the Exhibit B notice, so MPL section 3.3 stays open.

The trade: improvements to Nexus itself come back, while the app stays
usable inside a company and composable with other copyleft work.
