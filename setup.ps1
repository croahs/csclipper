# csclipper bootstrap for Windows (GUIDE.md). Read it before you run it:
#   https://github.com/croahs/csclipper/blob/main/setup.ps1
# Run from Windows Terminal (Windows PowerShell 5.1 or PowerShell 7):
#   irm https://raw.githubusercontent.com/croahs/csclipper/main/setup.ps1 | iex
# What it does, in order, skipping what is already there:
#   1. git and Node (LTS, 22 or newer): installed with winget when missing. Without winget it
#      prints their official download pages and stops before installing anything.
#   2. pnpm: enabled through Node's own corepack; if that gives no pnpm, pnpm's official installer
#      (get.pnpm.io) is run. Those are the only two places anything is fetched from besides GitHub.
#   3. The repo: cloned into %USERPROFILE%\csclipper, or updated (fast-forward only) when the folder
#      is already a checkout of github.com/croahs/csclipper. Any other folder there is refused.
#   4. pnpm install, then pnpm prep (HLAE and FFmpeg downloads with sha256 checks, your two SteamIDs).
# Every step stops on failure with what to do. It changes no Windows settings, and running it again
# only updates. Everything runs inside one function, so it leaves no variables behind in your shell.
param([string]$Dir = (Join-Path $env:USERPROFILE "csclipper"))

function Invoke-CsclipperBootstrap {
  param([string]$Dir)
  $ErrorActionPreference = "Stop" # local to this function
  # PowerShell 7.4+ would otherwise turn every native non-zero exit into a terminating error; the
  # exit codes that matter are checked explicitly below. Windows PowerShell 5.1 ignores this variable.
  $PSNativeCommandUseErrorActionPreference = $false
  $Repo = "https://github.com/croahs/csclipper.git"
  $RepoKey = "github.com/croahs/csclipper"

  function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  # After an install: add the persisted PATH entries this session does not have yet, keeping the session's own.
  function Add-PersistedPath {
    $have = $env:Path -split ";"
    foreach ($scope in "Machine", "User") {
      foreach ($p in ([Environment]::GetEnvironmentVariable("Path", $scope) -split ";")) {
        if ($p -and ($have -notcontains $p)) { $env:Path += ";" + $p; $have += $p }
      }
    }
  }
  function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
  function Run($label, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE). Fix what it printed above, then run the setup line again." }
  }
  function NodeOk {
    if (-not (Have "node.exe")) { return $false }
    $v = (& node.exe --version)
    return ([int]($v.TrimStart("v").Split(".")[0]) -ge 22)
  }
  function PnpmCmd { return (Get-Command pnpm.cmd, pnpm.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source }

  # Nothing is installed when a manual install is needed anyway.
  $winget = Have "winget.exe"
  $need = @()
  if (-not (Have "git.exe")) { $need += "git: https://git-scm.com/download/win" }
  if (-not (NodeOk)) { $need += "Node (LTS, 22 or newer): https://nodejs.org/en/download" }
  if ($need.Count -gt 0 -and -not $winget) {
    Write-Host ""
    Write-Host "This PC has no winget, so these need a manual install. Download and install them from their official pages, then run the setup line again:" -ForegroundColor Yellow
    $need | ForEach-Object { Write-Host "  $_" }
    return # not exit: under `irm | iex` that would close the terminal
  }

  Step "git"
  if (Have "git.exe") { & git.exe --version }
  else {
    Run "winget install Git.Git" { winget.exe install --id Git.Git -e --accept-source-agreements --accept-package-agreements }
    Add-PersistedPath
    if (-not (Have "git.exe")) { throw "git was installed but this terminal cannot see it yet. Close the terminal, open a new one and run the setup line again." }
  }

  Step "Node"
  if (NodeOk) { & node.exe --version }
  else {
    Run "winget install OpenJS.NodeJS.LTS" { winget.exe install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
    Add-PersistedPath
    if (-not (NodeOk)) { throw "Node was installed but this terminal cannot see a Node 22 or newer yet. Close the terminal, open a new one and run the setup line again." }
  }

  Step "pnpm"
  if (-not (PnpmCmd)) {
    if (Have "corepack.cmd") { Run "corepack enable" { corepack.cmd enable }; Add-PersistedPath }
    if (-not (PnpmCmd)) {
      Write-Host "corepack did not provide pnpm; running pnpm's own installer from https://get.pnpm.io/install.ps1 (https://pnpm.io/installation)"
      Invoke-Expression (Invoke-WebRequest "https://get.pnpm.io/install.ps1" -UseBasicParsing).Content
      Add-PersistedPath
    }
    if (-not (PnpmCmd)) { throw "pnpm did not install. Install it from https://pnpm.io/installation, open a new terminal and run the setup line again." }
  }
  $pnpm = PnpmCmd
  Write-Host "pnpm $(& $pnpm --version)"

  Step "The repo in $Dir"
  if (Test-Path (Join-Path $Dir ".git")) {
    $origin = & git.exe -C $Dir config --get remote.origin.url
    if ($LASTEXITCODE -ne 0 -or -not $origin -or $origin -notmatch [regex]::Escape($RepoKey)) {
      throw "$Dir is a git checkout of something else (origin: '$origin'), not of $RepoKey. Move it away, or run this script with -Dir <another folder>."
    }
    Run "git pull" { git.exe -C $Dir pull --ff-only }
  }
  elseif ((Test-Path $Dir) -and ((Get-ChildItem -LiteralPath $Dir -Force | Measure-Object).Count -gt 0)) {
    throw "$Dir exists and is not a csclipper checkout. Move it away, or run this script with -Dir <another folder>."
  }
  else { Run "git clone" { git.exe clone $Repo $Dir } }
  Set-Location $Dir

  Step "Dependencies"
  Run "pnpm install" { & $pnpm install }

  Step "Setup (downloads HLAE and FFmpeg, asks for your two SteamIDs)"
  & $pnpm prep
  Write-Host ""
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Not ready yet: fix the MISSING lines above (GUIDE.md explains each), then run 'pnpm check' in this folder, or the setup line again." -ForegroundColor Yellow
  }
  else {
    Write-Host "Ready. Next: GUIDE.md, 'Your first clips': https://github.com/croahs/csclipper/blob/main/GUIDE.md#your-first-clips" -ForegroundColor Cyan
  }
  Write-Host "You are now in $Dir. Later, open a terminal here and run: pnpm go"
}

Invoke-CsclipperBootstrap -Dir $Dir
