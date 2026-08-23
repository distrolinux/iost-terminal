// Regression: production password-reset tokens must never be printed to logs.
process.env.NODE_ENV = 'production';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { sendResetEmail } = await import('../lib/auth.js');
const token = 'sensitive-reset-token-for-regression';
const seen = [];
const originalLog = console.log;
console.log = (...args) => seen.push(args.join(' '));
let result;
try {
  result = await sendResetEmail('owner@test.local', token, 'iostcallister.com');
} finally {
  console.log = originalLog;
}

if (seen.join('\n').includes(token)) {
  console.error('FAIL  production reset token reached console output');
  process.exit(1);
}
if (result?.mode !== 'disabled') {
  console.error('FAIL  production without SMTP must fail closed', result);
  process.exit(1);
}
console.log('PASS  production reset delivery fails closed without logging tokens');