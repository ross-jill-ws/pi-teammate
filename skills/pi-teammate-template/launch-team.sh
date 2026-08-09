#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# launch-team.sh — one terminal pane per pi-teammate, all on the same channel.
#
# Drop this next to the teammate folders and run it. It finds every directory
# holding a persona.yaml, splits the terminal into one pane per teammate, and
# starts a `pi` session in each with --team-channel set.
#
#   project/
#   ├── launch-team.sh
#   ├── designer/persona.yaml
#   ├── developer/persona.yaml
#   └── tester/persona.yaml
#
# Backends
# --------
# Inside tmux            -> splits the current tmux window
# iTerm2 (not in tmux)   -> splits the current iTerm2 tab via AppleScript
# Plain terminal + tmux  -> starts a new tmux session and attaches to it
#
# Layouts, by teammate count. Slot 1 is the pane you started from; slots are
# numbered in reading order (left to right, top to bottom):
#
#   1 -> 1x1        2 -> 1x2        3 -> 1x2 + 1x1
#   4 -> 2x2        5 -> 1x3 + 1x2  6 -> 3x2
#
# Channel creation
# ----------------
# The first teammate creates the channel with --team-new; the rest wait for
# ~/.pi/pi-teammate/<channel>/team.db to appear before joining. --team-new
# deletes the whole channel directory, so the wait is what stops a joiner from
# registering into a database that is about to be wiped.
#
# Usage:
#   ./launch-team.sh [key=value ...] [teammate-dir ...]
#
#   channel=<name>   team channel (default: this directory's name)
#   fresh=0          join the existing channel instead of recreating it
#   dry-run=1        print the layout and the per-pane commands, run nothing
#
#   Positional arguments override discovery and set the order — the first one
#   creates the channel and takes slot 1.
#
# Examples:
#   ./launch-team.sh
#   ./launch-team.sh channel=forex-rt
#   ./launch-team.sh dry-run=1
#   ./launch-team.sh developer designer tester
#   ./launch-team.sh fresh=0 designer
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_PANES=6
PI_CMD="${PI_CMD:-pi}"          # overridable so the launcher can be tested

CHANNEL=""
FRESH=1
DRY_RUN=0
TEAMMATES=()

for arg in "$@"; do
  case "$arg" in
    channel=*) CHANNEL="${arg#*=}" ;;
    fresh=*)   FRESH="${arg#*=}" ;;
    dry-run=*) DRY_RUN="${arg#*=}" ;;
    -h|--help|help)
      sed -n '4,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "Unknown option: $arg" >&2
      echo "Accepted: channel= fresh= dry-run= [teammate-dir ...]" >&2
      exit 1 ;;
    *) TEAMMATES+=("$arg") ;;
  esac
done

cd "$SCRIPT_DIR"
[[ -n "$CHANNEL" ]] || CHANNEL="$(basename "$SCRIPT_DIR")"

# --- Roster ----------------------------------------------------------------

if (( ${#TEAMMATES[@]} == 0 )); then
  while IFS= read -r dir; do
    [[ -n "$dir" ]] && TEAMMATES+=("$dir")
  done < <(
    find . -maxdepth 2 -name persona.yaml -not -path "*/node_modules/*" -not -path "*/.git/*" \
      | sed 's|/persona\.yaml$||; s|^\./||' | LC_ALL=C sort
  )
fi

if (( ${#TEAMMATES[@]} == 0 )); then
  echo "No teammates found: no persona.yaml under ${SCRIPT_DIR}." >&2
  echo "Create the teammate folders first, or pass their paths as arguments." >&2
  exit 1
fi

MISSING=()
for dir in "${TEAMMATES[@]}"; do
  [[ -f "${dir%/}/persona.yaml" ]] || MISSING+=("$dir")
done
if (( ${#MISSING[@]} )); then
  echo "These paths have no persona.yaml:" >&2
  for dir in "${MISSING[@]}"; do echo "  ${dir}" >&2; done
  exit 1
fi

N=${#TEAMMATES[@]}
if (( N > MAX_PANES )); then
  echo "${N} teammates, but pane layouts are defined for 1-${MAX_PANES}." >&2
  echo "Pass the ones you want, e.g.: $(basename "$0") ${TEAMMATES[0]} ${TEAMMATES[1]}" >&2
  echo "and launch the rest from another window." >&2
  exit 1
fi

# Display name for a pane title, from persona.yaml.
name_of() {
  local n
  n="$(grep -m1 '^name:' "${1%/}/persona.yaml" 2>/dev/null | sed 's/^name:[[:space:]]*//')" || true
  n="${n%\"}"; n="${n#\"}"; n="${n%\'}"; n="${n#\'}"
  printf '%s' "${n:-$1}"
}

DB_PATH="${HOME}/.pi/pi-teammate/${CHANNEL}/team.db"

# --- Pane layouts ----------------------------------------------------------
#
# One split plan per pane count, shared by both backends. Each entry is
#   <new-slot>:<parent-slot>:<h|v>:<percent-for-the-new-pane>
#   h = side-by-side split   (tmux -h / iTerm2 "split vertically")
#   v = stacked split        (tmux -v / iTerm2 "split horizontally")

split_plan() {
  case "$1" in
    1) : ;;
    2) echo "2:1:h:50" ;;
    3) echo "3:1:v:50"; echo "2:1:h:50" ;;
    4) echo "3:1:v:50"; echo "2:1:h:50"; echo "4:3:h:50" ;;
    5) echo "4:1:v:50"; echo "2:1:h:66"; echo "3:2:h:50"; echo "5:4:h:50" ;;
    6) echo "3:1:v:66"; echo "5:3:v:50"; echo "2:1:h:50"; echo "4:3:h:50"; echo "6:5:h:50" ;;
  esac
}

layout_name() {
  case "$1" in
    1) echo "1x1" ;; 2) echo "1x2" ;; 3) echo "1x2 + 1x1" ;;
    4) echo "2x2" ;; 5) echo "1x3 + 1x2" ;; 6) echo "3x2" ;;
  esac
}

# The command one pane runs. Slot 1 creates the channel; the others wait for
# its database before joining, so --team-new never wipes a live registration.
pane_cmd() {
  local i="$1" dir="${TEAMMATES[$(($1-1))]}"
  local launch="${PI_CMD} --team-channel $(printf %q "$CHANNEL")"

  if (( i == 1 )) && [[ "$FRESH" == "1" ]]; then
    launch+=" --team-new"
  fi

  if (( i == 1 )); then
    printf 'cd %s && %s' "$(printf %q "${SCRIPT_DIR}/${dir%/}")" "$launch"
  else
    printf 'cd %s && for _ in $(seq 1 300); do [ -f %s ] && break; sleep 0.2; done; %s' \
      "$(printf %q "${SCRIPT_DIR}/${dir%/}")" "$(printf %q "$DB_PATH")" "$launch"
  fi
}

# --- tmux ------------------------------------------------------------------

tmux_split() {
  local dir="$1" target="$2" pct="$3" id=""
  if id="$(tmux split-window "$dir" -d -t "$target" -l "${pct}%" -c "$SCRIPT_DIR" -P -F '#{pane_id}' 2>/dev/null)"; then
    printf '%s' "$id"; return 0
  fi
  id="$(tmux split-window "$dir" -d -t "$target" -p "$pct" -c "$SCRIPT_DIR" -P -F '#{pane_id}')"
  printf '%s' "$id"
}

# Splits from $1 (a pane id) and returns every slot's pane id in PANE_SLOTS.
tmux_build_layout() {
  local root="$1" new parent dir pct i
  PANE_SLOTS=("$root")
  for i in $(seq 2 "$N"); do PANE_SLOTS+=(""); done

  while IFS=: read -r new parent dir pct; do
    [[ -n "$new" ]] || continue
    PANE_SLOTS[$((new-1))]="$(tmux_split "-${dir}" "${PANE_SLOTS[$((parent-1))]}" "$pct")"
  done <<< "$(split_plan "$N")"

  for i in $(seq 1 "$N"); do
    tmux select-pane -t "${PANE_SLOTS[$((i-1))]}" -T "$(name_of "${TEAMMATES[$((i-1))]}")" 2>/dev/null || true
  done
}

# Inside tmux: split this window, hand slots 2..N their commands, run slot 1 here.
run_in_current_tmux() {
  local i
  tmux_build_layout "$TMUX_PANE"
  for i in $(seq 2 "$N"); do
    tmux send-keys -t "${PANE_SLOTS[$((i-1))]}" "$(pane_cmd "$i")" Enter
  done
}

# No tmux session yet: build one detached, fill every slot, then attach.
run_in_new_tmux() {
  local session="pi-team-${CHANNEL}" root i
  if tmux has-session -t "$session" 2>/dev/null; then
    session="${session}-$$"
  fi
  root="$(tmux new-session -d -s "$session" -c "$SCRIPT_DIR" -P -F '#{pane_id}')"
  tmux_build_layout "$root"
  for i in $(seq 1 "$N"); do
    tmux send-keys -t "${PANE_SLOTS[$((i-1))]}" "$(pane_cmd "$i")" Enter
  done
  echo "Attaching to tmux session '${session}' — detach with Ctrl-b d."
  exec tmux attach -t "$session"
}

# --- iTerm2 ----------------------------------------------------------------

as_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# iTerm2 splits 50/50 with no size argument, so a 3-pane row comes out
# 50/25/25 rather than even thirds. Drag the divider if it matters.
iterm_applescript() {
  local new parent dir pct i
  echo 'tell application "iTerm2"'
  echo '  set s1 to current session of current tab of current window'
  while IFS=: read -r new parent dir pct; do
    [[ -n "$new" ]] || continue
    if [[ "$dir" == "h" ]]; then
      echo "  tell s${parent} to set s${new} to (split vertically with same profile)"
    else
      echo "  tell s${parent} to set s${new} to (split horizontally with same profile)"
    fi
  done <<< "$(split_plan "$N")"
  for i in $(seq 2 "$N"); do
    echo "  tell s${i} to write text \"$(as_escape "$(pane_cmd "$i")")\""
  done
  echo 'end tell'
}

run_in_iterm() {
  local as_file
  as_file="$(mktemp -t pi-team-panes)"
  iterm_applescript > "$as_file"
  osascript "$as_file"
  rm -f "$as_file"
}

# --- Plan ------------------------------------------------------------------

echo "channel:   ${CHANNEL}"
echo "teammates: ${N} — layout $(layout_name "$N")"
for i in $(seq 1 "$N"); do
  printf '  slot %s  %-14s %s%s\n' "$i" "$(name_of "${TEAMMATES[$((i-1))]}")" \
    "${TEAMMATES[$((i-1))]%/}" "$( (( i == 1 )) && [[ "$FRESH" == "1" ]] && printf '   (creates the channel)'; true )"
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "DRY RUN — nothing will be executed."
  for i in $(seq 1 "$N"); do
    echo "  slot ${i}: $(pane_cmd "$i")"
  done
  if [[ "${TERM_PROGRAM:-}" == "iTerm.app" && -z "${TMUX:-}" ]]; then
    echo
    echo "iTerm2 AppleScript:"
    iterm_applescript | sed 's/^/  /'
  fi
  exit 0
fi

# --- Launch ----------------------------------------------------------------

# --team-new deletes the channel directory. Doing it here, before any pane
# starts, means a joiner can never latch onto the outgoing database.
if [[ "$FRESH" == "1" && -d "${HOME}/.pi/pi-teammate/${CHANNEL}" ]]; then
  rm -rf "${HOME}/.pi/pi-teammate/${CHANNEL}"
  echo "Removed the previous '${CHANNEL}' channel."
fi

if (( N == 1 )); then
  cd "${SCRIPT_DIR}/${TEAMMATES[0]%/}"
  exec ${PI_CMD} --team-channel "$CHANNEL" $( [[ "$FRESH" == "1" ]] && printf -- '--team-new' )
fi

if [[ -n "${TMUX:-}" ]] && command -v tmux >/dev/null 2>&1; then
  run_in_current_tmux
elif [[ "${TERM_PROGRAM:-}" == "iTerm.app" ]] && command -v osascript >/dev/null 2>&1; then
  run_in_iterm
elif command -v tmux >/dev/null 2>&1; then
  run_in_new_tmux            # never returns
else
  echo "Need tmux or iTerm2 to open panes — found neither." >&2
  echo "(TMUX='${TMUX:-}' TERM_PROGRAM='${TERM_PROGRAM:-}')" >&2
  echo "Install tmux, or start each teammate by hand:" >&2
  for i in $(seq 1 "$N"); do echo "  $(pane_cmd "$i")" >&2; done
  exit 1
fi

# Slot 1 runs here, in the pane the script was started from.
cd "${SCRIPT_DIR}/${TEAMMATES[0]%/}"
exec ${PI_CMD} --team-channel "$CHANNEL" $( [[ "$FRESH" == "1" ]] && printf -- '--team-new' )
