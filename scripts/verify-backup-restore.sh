#!/bin/bash
# Non-destructive restore rehearsal: always restores into a temporary directory.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_FILE="${1:-}"
[ -n "$BACKUP_FILE" ] || { echo 'usage: verify-backup-restore.sh BACKUP_FILE' >&2; exit 1; }

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/iost-terminal-restore-test.XXXXXX")"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

RESTORE_TARGET="$WORK_DIR/restored-data"
"$SCRIPT_DIR/restore-encrypted-backup.sh" "$BACKUP_FILE" "$RESTORE_TARGET"
[ -d "$RESTORE_TARGET" ] || { echo 'ERROR: isolated restore target was not created' >&2; exit 1; }
find "$RESTORE_TARGET" -type f -exec test -r {} \;
echo 'PASS — encrypted backup decrypted, authenticated, hash-verified, and restored in isolation.'
