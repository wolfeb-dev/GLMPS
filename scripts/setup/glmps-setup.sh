#!/usr/bin/env bash
#
# A wizard walks a human through a manual procedure, step by step.
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1 && tput clear 2>/dev/null; then return 0; fi
  printf '\033[2J\033[3J\033[H'
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else false; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any, with write_env's single
# quotes or a plain dotenv double-quoted value undone.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line value sq="'\\''"; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  value="${line#*=}"
  if [[ "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; value="${value//"$sq"/\'}"
  elif [[ "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
    [[ "$value" == *[\\\$\"]* ]] && return 1   # escapes, $ or ": can't decode safely; ask again
  fi
  printf '%s' "$value"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret), edited
# with Readline. Fails at EOF with no input.
ask() {
  local key="$1" prompt="$2" current input s=$'\001' e=$'\002' p rc=0
  current=$(_existing "$key" || true)
  # Readline needs the colour codes wrapped in \001..\002 to place the cursor.
  p="  $s$BOLD$e$prompt$s$RESET$e "
  [[ -n "$current" ]] && p+="$s$DIM$e[Enter keeps current]$s$RESET$e "
  read -e -r -p "$p" input || rc=1
  if (( rc )) && [[ -z "$input" ]]; then return 1; fi
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input rc=0
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || rc=1
  printf '\n'
  if (( rc )) && [[ -z "$input" ]]; then return 1; fi
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY='VALUE' into ENV_FILE (replaces any existing
# line) and sets $KEY. Idempotent. Creates ENV_FILE at mode 0600; writes through
# a symlink and keeps an existing file's mode.
write_env() {
  local key="$1" value="$2" tmp sq="'\\''"
  [[ -e "$ENV_FILE" ]] || (umask 077 && : > "$ENV_FILE")
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf "%s='%s'\n" "$key" "${value//\'/$sq}" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  printf -v "$key" '%s' "$value"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: author this section. One stage() per step the human takes.
# Replace the example below. Set TOTAL_STAGES to match the stages you write.
# Keep every stage inside run_wizard and the last line as is: bash then parses
# the whole file before the first prompt, so an edit mid-run can't break it.
# ──────────────────────────────────────────────────────────────────────────

run_wizard() {

TOTAL_STAGES=5

# This wizard stores nothing in a .env, and must never read one: point the
# library's .env lookup at /dev/null so ask/ask_secret find no "current" value.
ENV_FILE=/dev/null

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SETUP_DIR/../.." && pwd)"
# The launcher sets GLMPS_NODE to the node.exe bundled with the app, so a
# machine with no Node can still run the helper scripts.
NODE="${GLMPS_NODE:-node}"

# The launcher's -Sandbox moves every profile path into a throwaway folder;
# installs, updates and sign-ins act on the whole PC, so a sandbox skips them.
sandboxed() { [[ -n "${GLMPS_SETUP_SANDBOX:-}" ]]; }

# install_dep NAME "COMMAND": runs one confirmed install or update. graphify
# installs through the same provisionGraphify path `glmps init` uses.
install_dep() {
  if sandboxed; then note "sandbox: $1 left as is"; return 0; fi
  local name="$1" cmd="$2" rc=0
  local -a argv
  if [[ "$name" == graphify && "$cmd" == uv\ tool\ install* ]]; then
    "$NODE" "$SETUP_DIR/provision-graphify.mjs" || rc=$?
    if (( rc == 3 )) && confirm "graphify installs through uv, which is missing. Install uv with winget?"; then
      winget install --id astral-sh.uv --exact --source winget --accept-package-agreements --accept-source-agreements || return 1
      note "uv was just installed; if graphify still fails, open a new terminal and re-run this wizard."
      rc=0; "$NODE" "$SETUP_DIR/provision-graphify.mjs" || rc=$?
    fi
    return "$rc"
  fi
  read -r -a argv <<< "$cmd"
  "${argv[@]}"
}

# offer_sign_in "Tool" "status command" "login command": skip when already
# signed in unless the human asks to redo it.
offer_sign_in() {
  local tool="$1" status_cmd="$2" login_cmd="$3"
  if sandboxed; then
    say "Sandbox: skipping the $tool sign-in (its login is shared with this PC)."
    return 0
  fi
  if ! command -v "${status_cmd%% *}" >/dev/null 2>&1; then
    warn "$tool is not installed yet (or not on this terminal's PATH)."
    SKIPPED+=("$tool sign-in: open a new terminal after installing, then re-run this wizard")
    return 0
  fi
  if $status_cmd >/dev/null 2>&1; then
    say "Already signed in to $tool."
    confirm "Sign in again?" || return 0
  fi
  if ! $login_cmd; then
    warn "$tool sign-in did not finish."
    SKIPPED+=("$tool sign-in: run '$login_cmd'")
  fi
}

banner "GLMPS setup"

# Stage 1
stage "Dependencies"
say "Git, Claude Code, the GitHub CLI and graphify. Nothing installs or updates"
say "without your yes, one item at a time."
printf '\n'
if ! command -v "$NODE" >/dev/null 2>&1 && [[ ! -x "$NODE" ]]; then
  warn "Node.js was not found, and the setup helpers need it."
  if ! sandboxed && confirm "Install Node.js LTS with winget?"; then
    winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements \
      || SKIPPED+=("Node.js install failed")
    note "Open a new terminal and re-run this wizard so Node.js is on the PATH."
  else
    SKIPPED+=("Node.js: install it, then re-run this wizard")
  fi
  finish
  return 0
fi
plan=$("$NODE" "$SETUP_DIR/deps-plan.mjs") || { warn "could not read the dependency plan"; SKIPPED+=("dependency check"); plan=""; }
while IFS=$'\t' read -r -u 3 name action installed latest cmd update; do
  [[ -n "$name" ]] || continue
  if sandboxed; then
    case "$action" in
      ok) say "$name is installed ($installed)." ;;
      install) say "$name is missing (sandbox: not installed)." ;;
      update-available) say "$name $installed has a newer version ($latest) (sandbox: not updated)." ;;
    esac
    continue
  fi
  case "$action" in
    ok)
      say "$name is installed ($installed)."
      if [[ "$name" == graphify && "$update" != "-" ]] && confirm "Check graphify for a newer version?"; then
        $update || SKIPPED+=("graphify update")
      fi
      ;;
    install)
      if confirm "$name is missing. Install it now?"; then
        install_dep "$name" "$cmd" || { warn "installing $name failed"; SKIPPED+=("install $name: $cmd"); }
      else
        SKIPPED+=("install $name")
      fi
      ;;
    update-available)
      if confirm "$name $installed has a newer version ($latest). Update it now?"; then
        install_dep "$name" "$cmd" || { warn "updating $name failed"; SKIPPED+=("update $name: $cmd"); }
      fi
      ;;
  esac
done 3<<< "$plan"
note "A tool installed just now may need a new terminal before its sign-in below can find it."
pause "Continue to sign-ins?"

# Stage 2
stage "Claude Code sign-in"
say "Opens your browser to sign in to your Anthropic account."
offer_sign_in "Claude Code" "claude auth status" "claude auth login"

# Stage 3
stage "GitHub sign-in"
say "Signs the GitHub CLI in so pull requests and clones work."
offer_sign_in "GitHub CLI" "gh auth status" "gh auth login"

# Stage 4
stage "Slack tokens"
say "GLMPS talks to Slack through your own Slack app. The tokens go to the same"
say "credential store the Slack setup uses; nothing is written to a .env file."
do_slack=1
if "$NODE" "$SETUP_DIR/slack-creds.mjs" --check; then
  say "Slack tokens are already saved."
  confirm "Replace them?" || do_slack=0
fi
if (( do_slack )); then
  open_url "https://api.slack.com/apps"
  step "Open your GLMPS app. No app yet? Press Enter at the first prompt to skip,"
  note "    then finish later with: node scripts/scut-setup.mjs"
  step "OAuth & Permissions: copy the Bot User OAuth Token (starts xoxb-)."
  SETUP_BOT_TOKEN=""; SETUP_APP_TOKEN=""; SETUP_SIGNING_SECRET=""
  ask_secret SETUP_BOT_TOKEN "Bot token (input hidden, Enter to skip):" || true
  if [[ -n "$SETUP_BOT_TOKEN" ]]; then
    step "Basic Information, App-Level Tokens: copy a token with the connections:write scope (starts xapp-)."
    ask_secret SETUP_APP_TOKEN "App-level token (input hidden):" || true
    step "Basic Information, App Credentials: the Signing Secret. Optional for a Socket Mode app."
    ask_secret SETUP_SIGNING_SECRET "Signing secret (input hidden, Enter to skip):" || true
    if SETUP_BOT_TOKEN="$SETUP_BOT_TOKEN" SETUP_APP_TOKEN="$SETUP_APP_TOKEN" SETUP_SIGNING_SECRET="$SETUP_SIGNING_SECRET" \
        "$NODE" "$SETUP_DIR/slack-creds.mjs" --save; then
      :
    else
      SKIPPED+=("Slack tokens were not saved; re-run this wizard or: node scripts/scut-setup.mjs")
    fi
  else
    SKIPPED+=("Slack tokens: re-run this wizard or: node scripts/scut-setup.mjs")
  fi
  SETUP_BOT_TOKEN=""; SETUP_APP_TOKEN=""; SETUP_SIGNING_SECRET=""
fi

# Stage 5
stage "Choose repositories"
say "glmps init finds the git repos under a folder, writes glmps.profile.json in"
say "the folder you are in now ($PWD), and installs the GLMPS config and hooks."
do_init=1; init_force=()
if [[ -f glmps.profile.json ]]; then
  say "glmps.profile.json already exists here."
  if confirm "Run glmps init again and overwrite it?"; then init_force=(--force); else do_init=0; fi
fi
if (( do_init )); then
  ENGAGEMENT=""; SEARCH_DIR=""
  ask ENGAGEMENT "Engagement name (a short label for this setup):" || true
  ask SEARCH_DIR "Folder to search for git repos (Enter for your home folder):" || true
  if [[ -z "$ENGAGEMENT" ]]; then
    SKIPPED+=("glmps init: no engagement name given; run node scripts/glmps-init.mjs --engagement <name>")
  elif confirm "Run glmps init for '$ENGAGEMENT'?"; then
    "$NODE" "$ROOT/scripts/glmps-init.mjs" --engagement "$ENGAGEMENT" --search "${SEARCH_DIR:-$HOME}" ${init_force[@]+"${init_force[@]}"} \
      || SKIPPED+=("glmps init did not finish; fix the message above and re-run this wizard")
    note "Open glmps.profile.json afterwards to trim the repo list."
  else
    SKIPPED+=("glmps init")
  fi
fi

finish
}

run_wizard "$@"; exit
