import { sameOriginMutation } from '../lib/auth-routes.js';

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

function probe({ method = 'POST', origin = null, fetchSite = null } = {}) {
  const headers = { origin, 'sec-fetch-site': fetchSite };
  const req = { method, get: (name) => headers[String(name).toLowerCase()] || undefined };
  let status = 200, body = null, next = false;
  const res = { status(n) { status = n; return this; }, json(v) { body = v; return this; } };
  sameOriginMutation('https://iostcallister.com')(req, res, () => { next = true; });
  return { status, body, next };
}

ok('same-origin browser mutation allowed', probe({ origin: 'https://iostcallister.com', fetchSite: 'same-origin' }).next);
ok('cross-site Fetch Metadata rejected', probe({ origin: 'https://iostcallister.com', fetchSite: 'cross-site' }).status === 403);
ok('foreign Origin rejected', probe({ origin: 'https://evil.example', fetchSite: 'same-site' }).status === 403);
ok('malformed Origin rejected', probe({ origin: 'not a url' }).status === 403);
ok('GET remains unaffected', probe({ method: 'GET', origin: 'https://evil.example', fetchSite: 'cross-site' }).next);
ok('non-browser client without provenance headers remains compatible', probe({}).next);

console.log(failures === 0 ? '\nALL PASS ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
