<#
.SYNOPSIS
  Installs Nexus from a fresh clone of this repo: Node.js (if missing),
  npm dependencies, Playwright's bundled Chromium, and a starter
  local_data folder seeded with default settings.

.DESCRIPTION
  This repo's root already contains everything Nexus needs as siblings:
    web-app/       -- the Next.js app itself
    voicechanger/  -- the optional VRChat voice/STT pipeline (Python)
  local_data/ is NOT tracked in git (it holds your personal conversation
  logs, keys, and settings) -- this script creates it next to web-app/ and
  voicechanger/ and seeds it from web-app/defaults/local_data.

  This script covers the "core app" tier: Node.js + npm install +
  Playwright's Chromium + a seeded local_data/. It deliberately does NOT
  install:
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
#>

param(
  [string]$RepoRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Test-NodeAvailable {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  return [bool]$cmd
}

function Install-NodeJS {
  Write-Host "  Node.js not found. Installing automatically..." -ForegroundColor Yellow

  # Strategy 1: winget (Windows 11+, handles PATH automatically)
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host "  Trying winget..." -ForegroundColor Cyan
    & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -eq 0) {
      # Refresh PATH from registry (winget may have updated it)
      $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
      $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
      $env:Path = "$machinePath;$userPath"
      if (Test-NodeAvailable) {
        Write-Host "  Node.js installed via winget: $(node --version)" -ForegroundColor Green
        return
      }
    }
    Write-Host "  winget did not succeed or node still not on PATH, falling back to direct download." -ForegroundColor Yellow
  }

  # Strategy 2: Download standalone zip (no admin privileges needed)
  Write-Host "  Downloading Node.js LTS (standalone, no admin required)..." -ForegroundColor Cyan
  try {
    $indexJson = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing
    $ltsRelease = $indexJson | Where-Object { $_.lts -and $_.lts -ne $false } | Select-Object -First 1
    if (-not $ltsRelease) { throw "Could not determine latest LTS version from nodejs.org." }
    $version = $ltsRelease.version  # e.g. "v22.11.0"
    $ltsName = $ltsRelease.lts       # e.g. "Jod"
    $url = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"
    Write-Host "  Latest LTS: $version ($ltsName)"
    Write-Host "  Downloading from $url"

    $installDir = Join-Path $env:LOCALAPPDATA "NexusNode"
    $zipPath = Join-Path $env:TEMP "nexus-node-$version.zip"

    # Download with progress
    $ProgressPreference = 'SilentlyContinue'  # speed up Invoke-WebRequest
    Invoke-WebRequest $url -OutFile $zipPath -UseBasicParsing
    $ProgressPreference = 'Continue'

    Write-Host "  Extracting to $installDir"
    if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
    Expand-Archive $zipPath -DestinationPath $installDir -Force
    Remove-Item $zipPath -Force

    # The zip extracts to a subfolder like node-v22.11.0-win-x64/
    $nodeDir = Get-ChildItem $installDir -Directory | Select-Object -First 1
    if (-not $nodeDir) { throw "Extraction produced no directory." }
    $nodeBinDir = $nodeDir.FullName

    # Add to user PATH permanently (so future cmd windows see it too)
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$nodeBinDir*") {
      $newPath = if ($userPath) { "$nodeBinDir;$userPath" } else { $nodeBinDir }
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    }
    # Update current session
    $env:Path = "$nodeBinDir;$env:Path"

    if (Test-NodeAvailable) {
      Write-Host "  Node.js installed: $(node --version)" -ForegroundColor Green
      Write-Host "  (Added to your user PATH. New terminal windows will see it automatically.)" -ForegroundColor DarkGray
      return
    }
    throw "Node.js was extracted but 'node' is still not on PATH. The extracted directory is: $nodeBinDir"
  } catch {
    throw "Failed to install Node.js automatically: $_`n`nPlease install manually from https://nodejs.org/ (LTS recommended) and re-run INSTALL.bat."
  }
}

# ── Main ──

Write-Step "Checking prerequisites"
if (-not (Test-NodeAvailable)) {
  Install-NodeJS
}
# npm comes bundled with Node.js, so if node is there npm should be too.
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  throw "Node.js is installed but 'npm' was not found on PATH. This usually means a broken Node.js installation -- reinstall from https://nodejs.org/"
}
Write-Host "  node: $(node --version)"
Write-Host "  npm:  $(npm --version)"

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
  # Seed only files that don't already exist -- never overwrite a real local_data.
  $copied = 0
  Get-ChildItem $defaultsDataDir | ForEach-Object {
    $target = Join-Path $dataDir $_.Name
    if (-not (Test-Path $target)) {
      Copy-Item -Path $_.FullName -Destination $dataDir -Recurse
      $copied++
    }
  }
  if ($copied -gt 0) {
    Write-Host "  Seeded $copied file(s) from defaults (existing local_data files were left untouched)."
  } else {
    Write-Host "  local_data already present -- nothing seeded (existing files untouched)."
  }
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
