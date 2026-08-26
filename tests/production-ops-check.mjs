import { readFileSync } from 'node:fs';

let failed = 0;
function ok(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failed++;
}

const backup = readFileSync(new URL('../scripts/backup-encrypted.sh', import.meta.url), 'utf8');
const restore = readFileSync(new URL('../scripts/restore-encrypted-backup.sh', import.meta.url), 'utf8');
const monitor = readFileSync(new URL('../scripts/monitor-production.sh', import.meta.url), 'utf8');
const verify = readFileSync(new URL('../scripts/verify-backup-restore.sh', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../docs/PRODUCTION_OPERATIONS.md', import.meta.url), 'utf8');

ok('backup runs fail-closed with a restrictive umask and an exclusive lock',
  /set -Eeuo pipefail/.test(backup) && /umask 077/.test(backup) && /flock -n 9/.test(backup));
ok('backup passphrase comes from a permission-checked file, never a CLI secret',
  /BACKUP_PASSPHRASE_FILE/.test(backup) && /stat -c '%a'/.test(backup)
  && /--passphrase-file "\$BACKUP_PASSPHRASE_FILE"/.test(backup)
  && !/--passphrase ["']?\$/.test(backup));
ok('backup pauses the sole writer only around the snapshot and always unpauses on exit',
  /docker_cmd pause "\$PROD_CONTAINER"/.test(backup)
  && /cp -a "\$DATA_DIR\/\."/.test(backup)
  && /docker_cmd unpause "\$PROD_CONTAINER"/.test(backup)
  && /trap cleanup EXIT/.test(backup));
ok('backup rejects links and special files before authenticated encryption',
  /snapshot contains a symbolic link/.test(backup)
  && /snapshot contains a special file/.test(backup)
  && /--cipher-algo AES256/.test(backup)
  && /sha256sum/.test(backup));
ok('restore verifies transport checksum, archive paths, payload hashes and special-file policy',
  /sha256sum -c/.test(restore) && /unsafe archive path/.test(restore)
  && /SHA256SUMS/.test(restore) && /restored payload contains a symbolic link/.test(restore));
ok('restore cannot overwrite a target and production restore needs an explicit stopped-container gate',
  /restore target must be empty/.test(restore)
  && /ALLOW_PRODUCTION_RESTORE:-NO/.test(restore)
  && /production container must be stopped/.test(restore));
ok('monitor checks container, public revision, disk and backup freshness',
  /State.Health.Status/.test(monitor) && /PUBLIC_HEALTH_URL/.test(monitor)
  && /expected revision/.test(monitor) && /DISK_MAX_PERCENT/.test(monitor)
  && /BACKUP_MAX_AGE_HOURS/.test(monitor));
ok('monitor deduplicates incidents and emits a recovery notification',
  /ALERT_AFTER_FAILURES/.test(monitor) && /previous_status/.test(monitor)
  && /IOST Terminal RECOVERED/.test(monitor));
ok('restore verifier always uses an isolated temporary target',
  /mktemp -d/.test(verify) && /restore-encrypted-backup\.sh/.test(verify));
ok('runbook keeps deployment separate and documents off-host copies plus restore rehearsal',
  /do(?:es)? not deploy/i.test(runbook) && /off-host/i.test(runbook)
  && /restore rehearsal/i.test(runbook) && /PREFLIGHT_ONLY=1/.test(runbook));

if (failed) process.exit(1);
console.log('production operations contract checks passed');
