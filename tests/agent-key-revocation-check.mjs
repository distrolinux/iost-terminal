// Regression: revoking a long-lived agent key must also invalidate credentials
// derived from its key identity (for example an in-memory OAuth bearer token).
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-agent-key-revocation-test');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
process.env.IOST_DATA_DIR = SCRATCH;

const agentKeys = await import('../lib/agent-keys.js');
const created = agentKeys.createKey({ userId: 'user-1', name: 'revocation-test', scopes: ['read'] });

if (!agentKeys.isActiveKey(created.entry.id, 'user-1')) {
  console.error('FAIL  newly created agent key is not active');
  process.exit(1);
}

const revoked = agentKeys.revokeKey({ userId: 'user-1', id: created.entry.id });
if (!revoked.ok || agentKeys.isActiveKey(created.entry.id, 'user-1')) {
  console.error('FAIL  revoked agent key identity remains active');
  process.exit(1);
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log('PASS  revoked agent key identity fails closed');
