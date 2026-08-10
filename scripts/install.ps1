<#
.SYNOPSIS
  Installs Nexus into a fresh container folder: clones the repo as `web-app`
  (regardless of what the GitHub repo itself is named), installs Node
  dependencies, and downloads the bundled Playwright/Chromium browser used
  by Browser Control.

.DESCRIPTION
  This covers the "core app" tier only: Next.js + its npm dependencies +
  Playwright's Chromium. It deliberately does NOT touch:
    - voicechanger (separate project, separate history -- see -WithVoicechanger)
    - TTS engines (Voicevox / Coeiroink / AivisSpeech -- large third-party
      binary/model downloads, not yet automated; see scripts/README.md)
    - recognize-main (needs machine-specific source patches that are not yet
      written down anywhere this script can read -- see scripts/README.md)
  Those three are real gaps, not oversights -- see the project-restructuring
  notes for why each one is harder than the core app.

  Nexus resolves local_data, voicechanger, and browser profiles as SIBLING
  folders of wherever its own app folder lives (process.cwd()/..). Nothing
  in the code cares what the container folder or the app folder are named --
  the only thing that matters is that they stay siblings. So this script's
  choice to always name the app folder "web-app" is a convention for
  clarity, not a requirement; you can rename it as long as you also update
  NEXUS_VOICECHANGER_DIR / local_data's own relationship on machines where
  you've moved things around.

.PARAMETER InstallDir
  The container folder to create (e.g. "C:\nexus"). Everything else goes
  inside it: <InstallDir>\web-app, <InstallDir>\local_data, etc.

.PARAMETER RepoUrl
  Git URL to clone. Defaults to the private Nexus repo. Override for a fork
  or a different remote.

.PARAMETER WithVoicechanger
  Also clone the voicechanger repo as a sibling (<InstallDir>\voicechanger).
  Requires -VoicechangerUrl (no default -- there isn't a public one yet; see
  scripts/README.md for the Mercurial-to-Git migration this depends on).

.EXAMPLE
  .\install.ps1 -InstallDir C:\nexus

.EXAMPLE
  .\install.ps1 -InstallDir C:\nexus -WithVoicechanger -VoicechangerUrl https://github.com/you/nexus-voicechanger.git
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,

  [string]$RepoUrl = "https://github.com/LycorisManjusaka/nexus.git",

  [switch]$WithVoicechanger,

  [string]$VoicechangerUrl = ""
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Require-Command($name, $hint) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Required tool '$name' was not found on PATH. $hint"
  }
}

Write-Step "Checking prerequisites"
Require-Command git  "Install Git for Windows: https://git-scm.com/download/win"
Require-Command node "Install Node.js LTS: https://nodejs.org/"
Require-Command npm  "Comes with Node.js -- reinstall Node if missing."

$nodeVersion = (node --version)
Write-Host "  git:  $(git --version)"
Write-Host "  node: $nodeVersion"

Write-Step "Creating container folder: $InstallDir"
if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$InstallDir = (Resolve-Path $InstallDir).Path

$appDir = Join-Path $InstallDir "web-app"
if (Test-Path $appDir) {
  throw "$appDir already exists. Remove it (or pick a different -InstallDir) and re-run."
}

Write-Step "Cloning repo into web-app/ (repo name on GitHub is irrelevant -- the target directory is explicit)"
git clone $RepoUrl $appDir
if ($LASTEXITCODE -ne 0) { throw "git clone failed." }

if ($WithVoicechanger) {
  if (-not $VoicechangerUrl) {
    Write-Host "  -WithVoicechanger was set but -VoicechangerUrl was not -- skipping." -ForegroundColor Yellow
  } else {
    Write-Step "Cloning voicechanger into voicechanger/ (sibling of web-app)"
    $vcDir = Join-Path $InstallDir "voicechanger"
    git clone $VoicechangerUrl $vcDir
    if ($LASTEXITCODE -ne 0) { throw "voicechanger clone failed." }
  }
}

Write-Step "Seeding local_data/ from web-app/defaults/local_data (sibling of web-app)"
$dataDir = Join-Path $InstallDir "local_data"
$defaultsDataDir = Join-Path $appDir "defaults\local_data"
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
if (Test-Path $defaultsDataDir) {
  Copy-Item -Path (Join-Path $defaultsDataDir "*") -Destination $dataDir -Recurse -Force
  Write-Host "  Copied starter character_map.json / user_settings.json."
} else {
  Write-Host "  No defaults/local_data found in the repo -- local_data left empty. Nexus creates" -ForegroundColor Yellow
  Write-Host "  what it needs on first run, but you'll want to set up character_map.json by hand." -ForegroundColor Yellow
}

Write-Step "Installing npm dependencies (this can take a few minutes)"
Push-Location $appDir
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

  Write-Step "Downloading Playwright's bundled Chromium (Browser Control feature, ~150 MB)"
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Chromium download failed or was skipped. Browser Control will report a clear" -ForegroundColor Yellow
    Write-Host "  error until you run 'npx playwright install chromium' manually inside web-app/." -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}

Write-Step "Done"
Write-Host "  Installed to: $InstallDir"
Write-Host "  Start Nexus:  cd `"$appDir`"; npm run dev"
Write-Host ""
Write-Host "  Still manual (see scripts/README.md for why):" -ForegroundColor Yellow
Write-Host "    - TTS engines: Voicevox / Coeiroink / AivisSpeech"
Write-Host "    - recognize.exe (speech recognition)"
if (-not $WithVoicechanger) {
  Write-Host "    - voicechanger (VRChat voice pipeline)"
}
