// Regression: successful credentials must not become a successful login when
// the session store cannot regenerate the session. No production stores or
// network services are used.
import assert from 'node:assert/strict';
import { completeLoginSession, completeRegistrationSession, savePendingTotp } from '../lib/auth-routes.js';

function failingRequest() {
  return {
    session: {
      regenerate(callback) {
        callback(new Error('simulated session-store failure'));
      },
    },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const user = { id: 'test-user' };
const publicUser = { id: 'test-user', email: 'user@test.local' };

for (const [path, successBody] of [
  ['/login', { user: publicUser }],
  ['/login/totp', { user: publicUser, usedBackup: false }],
]) {
  const res = responseRecorder();
  await completeLoginSession(failingRequest(), res, user, successBody);

  assert.equal(res.statusCode, 503, `${path} must fail closed`);
  assert.deepEqual(res.body, { error: 'sign-in temporarily unavailable' });
  assert.equal('user' in res.body, false, `${path} must not expose user data`);
}

{
  const res = responseRecorder();
  await completeRegistrationSession(failingRequest(), res, user, { user: publicUser });
  assert.equal(res.statusCode, 503, 'registration must report an automatic sign-in failure');
  assert.deepEqual(res.body, {
    error: 'Account created, but automatic sign-in is temporarily unavailable',
    accountCreated: true,
  });
  assert.equal('user' in res.body, false, 'failed automatic sign-in must not return a signed-in user');
}

{
  const req = { session: { save(callback) { callback(new Error('simulated save failure')); } } };
  const saved = await savePendingTotp(req, user);
  assert.equal(saved, false, '2FA challenge must fail closed when pending state cannot be saved');
}

console.log('Auth session-regeneration failure checks passed');
