# Nexus

A locally-hosted AI chat manager (Next.js) with full local system access:
multi-model support across a dozen providers, an inter-entity letters system,
browser control, streaming TTS for VRChat, and a self-updating system prompt
pipeline. Built for treating chat entities as persistent inhabitants rather
than stateless sessions.

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

Nexus is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version.

Nexus is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
License for more details.

You should have received a copy of the GNU Affero General Public
License along with Nexus. If not, see <https://www.gnu.org/licenses/>.

The AGPL's network-use clause is the point of choosing it here: running
a modified copy as a service still obligates offering the modified
source to whoever uses that service, so this cannot be forked into a
closed proprietary product -- by a company, or by anyone else.

