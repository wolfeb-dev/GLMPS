# scripts/setup/glmps-setup.ps1 - first-install launcher for the GLMPS setup wizard.
# Finds Git for Windows (the wizard is a bash script), offers to install it
# when it is missing, then runs scripts/setup/glmps-setup.sh in this console.
# Interactive and gated per item: it installs nothing without a yes.
# -Sandbox runs the wizard against a throwaway profile under %TEMP% so a
# machine that already runs GLMPS can try the first-run flow without touching
# its hooks, state, Slack tokens or config; -CleanSandbox deletes that folder.
param([switch]$Sandbox, [switch]$CleanSandbox)
$ErrorActionPreference = 'Stop'

$sandboxRoot = Join-Path $env:TEMP 'glmps-setup-sandbox'
if ($CleanSandbox) {
  if (Test-Path -LiteralPath $sandboxRoot) { Remove-Item -LiteralPath $sandboxRoot -Recurse -Force; Write-Host "Deleted $sandboxRoot" }
  else { Write-Host "No sandbox at $sandboxRoot" }
  exit 0
}

function Find-GitBash {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs')) | Where-Object { $_ }
  foreach ($root in $roots) {
    $candidate = Join-Path $root 'Git\bin\bash.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  # git.exe on PATH sits in <Git>\cmd or <Git>\mingw64\bin; <Git>\bin\bash.exe is the Git bash, unlike the WSL stub in System32.
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) {
    $dir = Split-Path -Parent $git.Source
    foreach ($up in @('..', '..\..')) {
      $candidate = [System.IO.Path]::GetFullPath((Join-Path $dir "$up\bin\bash.exe"))
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  return $null
}

$bash = Find-GitBash
if (-not $bash) {
  Write-Host 'Git for Windows is not installed. The GLMPS setup wizard needs its bash.'
  $answer = Read-Host 'Install Git for Windows now with winget? [y/N]'
  if ($answer -notmatch '^[Yy]') {
    Write-Host 'Install Git for Windows, then run this again.'
    exit 1
  }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Write-Host 'winget was not found. Install Git for Windows from its website, then run this again.'
    exit 1
  }
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  $bash = Find-GitBash
  if (-not $bash) {
    Write-Host 'Git was installed but its bash.exe was not found. Open a new terminal and run this again.'
    exit 1
  }
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bundledNode = Join-Path $root 'node.exe'
if (Test-Path -LiteralPath $bundledNode) { $env:GLMPS_NODE = $bundledNode }

$workDir = $HOME
if ($Sandbox) {
  # Child-process environment only: the GLMPS app already running keeps its own.
  # GLMPS_STATE_DIR and GLMPS_CLAUDE_DIR are the installer's override pair and must move together.
  $sbHome = Join-Path $sandboxRoot 'home'
  $paths = @{
    USERPROFILE = $sbHome; HOME = $sbHome
    APPDATA = Join-Path $sbHome 'AppData\Roaming'; LOCALAPPDATA = Join-Path $sbHome 'AppData\Local'
    GLMPS_STATE_DIR = Join-Path $sbHome '.glmps2'; GLMPS_CLAUDE_DIR = Join-Path $sbHome '.claude'
    CLAUDE_CONFIG_DIR = Join-Path $sbHome '.claude'; GH_CONFIG_DIR = Join-Path $sbHome 'gh'
  }
  foreach ($k in $paths.Keys) { New-Item -ItemType Directory -Force -Path $paths[$k] | Out-Null; Set-Item -Path "Env:$k" -Value $paths[$k] }
  $env:GLMPS_CONFIG_FILE = Join-Path $sbHome 'kernel-config.json'
  $env:GLMPS_SETUP_SANDBOX = '1'
  foreach ($k in 'SCUT_CREDS_FILE', 'SCUT_BOT_TOKEN', 'SCUT_APP_TOKEN', 'SCUT_SIGNING_SECRET', 'GH_TOKEN', 'GITHUB_TOKEN') { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
  Write-Host "Sandbox: everything the wizard writes goes under $sbHome"
  Write-Host 'Installs, updates and sign-ins are skipped: they act on the whole PC.'
  $workDir = $sbHome
}

Set-Location -LiteralPath $workDir
& $bash (Join-Path $PSScriptRoot 'glmps-setup.sh')
$code = $LASTEXITCODE
if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive) { Read-Host 'Press Enter to close' | Out-Null }
exit $code
