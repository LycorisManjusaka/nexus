<#
.SYNOPSIS
  Installs Nexus from a fresh clone of this repo: Node dependencies for the
  web app, Playwright's bundled Chromium (Browser Control), and a starter
  local_data folder seeded with default settings.

.DESCRIPTION
  This repo's root already contains everything Nexus needs as siblings:
    web-app/       -- the Next.js app itself
    voicechanger/  -- the optional VRChat voice/STT pipeline (Python)
  local_data/ is NOT tracked in git (it holds your personal conversation
  logs, keys, and settings) -- this script creates it next to web-app/ and
  voicechanger/ and seeds it from web-app/defaults/local_data.

  This script covers the "core app" tier: `npm install` + Playwright's
  Chromium + a seeded local_data/. It deliberately does NOT install:
    - TTS engines (Voicevox / Coeiroink / AivisSpeech) -- large third-party
      binary/model downloads, not yet automated; see web-app/scripts/README.md
    - recognize.exe / voicechanger's Python environment -- needs
      machine-specific setup; see voicechanger/README.md and
      web-app/scripts/README.md
  Those are real gaps, not oversights.

  Nexus resolves local_data and voicechanger as SIBLING folders of wherever
  web-app itself runs from (process.cwd()/..). Nothing in the code cares
  what the repo's own root folder is named -- only that local_data/,
  voicechanger/, and web-app/ stay siblings, which cloning this repo
  preserves automatically.

.EXAMPLE
  git clone https://github.com/LycorisManjusaka/nexus.git
  cd nexus
  .\install.ps1

.EXAMPLE
  # Run from an existing checkout, anywhere:
  .\install.ps1 -RepoRoot C:\dev\nexus
#>

param(
  [string]$RepoRoot = $PSScriptRoot
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
Require-Command node "Install Node.js LTS: https://nodejs.org/"
Require-Command npm  "Comes with Node.js -- reinstall Node if missing."
Write-Host "  node: $(node --version)"

$RepoRoot = (Resolve-Path $RepoRoot).Path
$appDir = Join-Path $RepoRoot "web-app"
if (-not (Test-Path $appDir)) {
  throw "$appDir not found. Run this script from the root of a checkout of the Nexus repo (it should contain web-app/ and voicechanger/ as siblings)."
}

Write-Step "Seeding local_data/ from web-app/defaults/local_data (sibling of web-app)"
$dataDir = Join-Path $RepoRoot "local_data"
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
Write-Host "  Installed to: $RepoRoot"
Write-Host "  Start Nexus:  cd `"$appDir`"; npm run dev"
Write-Host ""
Write-Host "  Still manual (see web-app/scripts/README.md for why):" -ForegroundColor Yellow
Write-Host "    - TTS engines: Voicevox / Coeiroink / AivisSpeech"
Write-Host "    - recognize.exe (speech recognition)"
Write-Host "    - voicechanger's Python environment (pip install -r voicechanger/requirements.txt, if you use VRChat voice features)"
