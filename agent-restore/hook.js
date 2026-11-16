// The two hook scripts, as text. The mod writes one of them into the folder
// that carries the label, with the core it reports through and the label it
// reports under filled in.
//
// The scripts are the patch's own files, copied as they were. The placeholders
// stay in, so one text serves every installation.

import { LABEL_PREFIX } from "./decide.js";

// The shell's own `${...}` and `\n` are escaped in the two scripts below: each
// is one JavaScript string, and the shell must read it as it was written.

/** The shipped POSIX hook. */
export const SH_SCRIPT = `#!/bin/sh
# installed by Herdr
# managed by Herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
#
# Reports this agent's session to the terminal it runs in, so Herdr can resume
# it after a restart. Outside Herdr it does nothing.

set -eu

[ -n "\${HC_TERMINAL_ID:-}" ] || exit 0

ACTION="\${1:-session}"
HC="{{HC}}"
LABEL="{{LABEL}}"

# The terminal's own core, so a terminal in a named session is labelled on the
# core that owns it.
if [ -n "\${HC_TERMINAL_SOCKET:-}" ]; then
    HC_SOCKET="$HC_TERMINAL_SOCKET"
    export HC_SOCKET
fi

if [ "$ACTION" = "end" ]; then
    "$HC" label "$HC_TERMINAL_ID" "$LABEL=" >/dev/null 2>&1 || true
    exit 0
fi

# The payload as one line: a label value is one line, and a raw newline inside
# a JSON string is not valid JSON anyway.
PAYLOAD=$(cat | tr '\\n' ' ')
[ -n "$PAYLOAD" ] || exit 0

"$HC" label "$HC_TERMINAL_ID" "$LABEL=$PAYLOAD" >/dev/null 2>&1 || true
exit 0
`;

/** The shipped PowerShell hook. */
export const PS1_SCRIPT = `# installed by Herdr
# managed by Herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
#
# Reports this agent's session to the terminal it runs in, so Herdr can resume
# it after a restart. Outside Herdr it does nothing.

param([string]$Action = "session")

if ([string]::IsNullOrWhiteSpace($env:HC_TERMINAL_ID)) { exit 0 }

$hc = "{{HC}}"
$label = "{{LABEL}}"

# The terminal's own core, so a terminal in a named session is labelled on the
# core that owns it.
if (-not [string]::IsNullOrWhiteSpace($env:HC_TERMINAL_SOCKET)) {
    $env:HC_SOCKET = $env:HC_TERMINAL_SOCKET
}

if ($Action -eq "end") {
    & $hc label $env:HC_TERMINAL_ID "$label=" 2>$null | Out-Null
    exit 0
}

# Read the payload as raw bytes so UTF-8 decodes even when the console code
# page is not UTF-8.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$payload = $reader.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
# A label value is one line, and a raw newline inside a JSON string is not
# valid JSON anyway.
$payload = $payload.Trim() -replace "[\\r\\n]+", " "

& $hc label $env:HC_TERMINAL_ID "$label=$payload" 2>$null | Out-Null
exit 0
`;

/** The hook script for this platform, with the core and the label filled in. */
export function scriptText(platform, hcPath, agent) {
  const script = platform === "ps1" ? PS1_SCRIPT : SH_SCRIPT;
  return script.split("{{HC}}").join(hcPath).split("{{LABEL}}").join(LABEL_PREFIX + agent);
}
