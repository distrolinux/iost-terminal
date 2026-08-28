// IOST Terminal auth UI — login / signup / forgot / 2FA / backup codes / reset.
// Loaded AFTER app.js. Exposes window.Auth; dispatches 'authchange' on state changes
// so app.js can gate paper-trade / autopilot controls. ARD-compliant: semantic HTML,
// ARIA labels, keyboard-accessible (Esc closes, buttons focusable), no hover-only paths.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const Auth = {
  state: { loggedIn: false, user: null, agent: false },
  modalStep: null,
  pendingEmail: null,
  pendingBackupCodes: null,
  lastFocus: null,
  closeTimer: null,

  async init() {
    // password reset link (from email): /app#reset?token=...
    if (location.hash.startsWith('#reset')) return this.showReset();
    await this.refresh();
    document.addEventListener('click', (e) => {
      const t = e.target.closest('.needs-auth');
      if (t && !this.state.loggedIn) {
        e.preventDefault(); e.stopPropagation();
        this.toast('Sign in required to trade');
        this.open('login');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      else this.trapFocus(e);
    });
  },

  async refresh() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.ok) {
        const d = await res.json();
        if (d.user) { this.state.loggedIn = true; this.state.user = d.user; this.state.agent = false; }
        else if (d.agent) { this.state.loggedIn = true; this.state.agent = true; this.state.user = null; }
        else { this.state.loggedIn = false; this.state.user = null; this.state.agent = false; }
      } else {
        this.state.loggedIn = false; this.state.user = null; this.state.agent = false;
      }
    } catch { this.state.loggedIn = false; this.state.user = null; this.state.agent = false; }
    this.renderTopbar();
    window.dispatchEvent(new CustomEvent('authchange', { detail: this.state }));
    return this.state;
  },

  toast(msg) {
    let wrap = $('#toastWrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastWrap'; wrap.className = 'toast-wrap'; wrap.setAttribute('role', 'status'); document.body.appendChild(wrap); }
    const t = document.createElement('div'); t.className = 'toast';
    t.textContent = msg; wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 4500);
  },

  // ---------------- topbar ----------------
  renderTopbar() {
    const box = $('#tbAuth'); if (!box) return;
    if (this.state.agent) {
      box.innerHTML = `<span class="auth-chip" title="Authenticated via X-API-Key">AGENT</span>`;
      return;
    }
    if (this.state.loggedIn) {
      box.innerHTML = `<span class="auth-chip" title="Signed in as ${esc(this.state.user.email)}">${esc(this.state.user.email)}</span>
        <button class="auth-chip auth-btn" id="authManage" aria-label="Manage account and two-factor authentication">2FA${this.state.user.totpEnabled ? ' ✓' : ''}</button>
        <button class="auth-chip auth-btn" id="authLogout" aria-label="Sign out">LOG OUT</button>`;
      $('#authLogout')?.addEventListener('click', () => this.logout());
      $('#authManage')?.addEventListener('click', () => this.open('account'));
    } else {
      box.innerHTML = `<button class="auth-chip auth-btn" id="authLogin" aria-label="Sign in">SIGN IN</button>`;
      $('#authLogin')?.addEventListener('click', () => this.open('login'));
    }
  },

  // ---------------- modal plumbing ----------------
  open(step) {
    const m = $('#authModal'); if (!m) return;
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    if (m.classList.contains('hidden')) this.lastFocus = document.activeElement;
    const gate = $('#gateOverlay');
    if (gate && !gate.classList.contains('hidden')) {
      gate.dataset.authCovered = '1';
      gate.classList.add('hidden');
    }
    m.classList.remove('hidden', 'closing');
    this.show(step || 'login');
  },
  close() {
    const m = $('#authModal');
    const r = $('#authReset');
    const resetWasOpen = r && !r.classList.contains('hidden');
    if (m && !m.classList.contains('hidden')) {
      if (m.classList.contains('closing')) return;
      m.classList.add('closing');
      this.closeTimer = setTimeout(() => {
        m.classList.remove('closing'); m.classList.add('hidden');
        const gate = $('#gateOverlay');
        if (gate?.dataset.authCovered === '1') {
          delete gate.dataset.authCovered;
          const dismissed = gate.dataset.dismissed === '1';
          if (!dismissed && !this.state.loggedIn) gate.classList.remove('hidden');
        }
        if (this.lastFocus?.isConnected) this.lastFocus?.focus({ preventScroll: true });
        this.lastFocus = null;
        this.closeTimer = null;
      }, 150);
    }
    if (r) r.classList.add('hidden');
    if (resetWasOpen) {
      if (this.lastFocus?.isConnected) this.lastFocus?.focus({ preventScroll: true });
      this.lastFocus = null;
    }
    this.pendingBackupCodes = null;
  },
  trapFocus(e) {
    if (e.key !== 'Tab') return;
    const modal = ['authModal', 'authReset']
      .map((id) => document.getElementById(id))
      .find((dialog) => dialog && !dialog.classList.contains('hidden'));
    if (!modal) return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hidden && el.getClientRects().length > 0);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  },
  show(step) {
    this.modalStep = step;
    const body = $('#authBody'); if (!body) return;
    const fn = { login: this.stepLogin, signup: this.stepSignup, forgot: this.stepForgot,
      totp: this.stepTotp, account: this.stepAccount, '2fa-enable': this.step2faEnable,
      '2fa-disable': this.step2faDisable, backup: this.stepBackup }[step];
    if (fn) body.innerHTML = fn.call(this);
    const labels = {
      login: 'Account sign in', signup: 'Create account', forgot: 'Reset password',
      totp: 'Two-factor verification', account: 'Manage account',
      '2fa-enable': 'Enable two-factor authentication', '2fa-disable': 'Disable two-factor authentication',
      backup: 'Save backup codes',
    };
    const label = labels[step] || 'Account';
    $('#authModal')?.setAttribute('aria-label', label);
    // ✕ close button — always present, top-right of the auth card
    if (!body.querySelector('.modal-close')) {
      body.insertAdjacentHTML('afterbegin', `<button class="modal-close" id="authCloseX" aria-label="Close ${esc(label.toLowerCase())}" style="font-size:20px;padding:2px 6px">✕</button>`);
      $('#authCloseX')?.addEventListener('click', () => this.close());
    }
    const first = body.querySelector('input, button:not(.modal-close)'); if (first) setTimeout(() => first.focus(), 30);
  },
  field(label, type, id, opts = '', autocomplete = type === 'password' ? 'current-password' : 'email') {
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" ${opts} autocomplete="${autocomplete}"></div>`;
  },
  errBox(msg) {
    return `<p class="auth-err" role="alert">${esc(msg)}</p>`;
  },
  noticeBox(msg) {
    return `<p class="auth-notice" role="status">${esc(msg)}</p>`;
  },

  async api(path, body) {
    try {
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
      const d = await res.json().catch(() => ({}));
      return { status: res.status, ...d };
    } catch {
      return { status: 0, error: 'Unable to reach the server. Check your connection and try again.' };
    }
  },

  // ---------------- steps ----------------
  stepLogin() {
    return `<div class="auth-head"><div class="auth-title">SIGN IN</div><div class="auth-sub">IOST Terminal · paper execution console</div></div>
      <form id="authForm" novalidate>
        ${this.field('Email', 'email', 'aEmail', 'required')}
        ${this.field('Password', 'password', 'aPass', 'required', 'current-password')}
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Sign in</button>
      </form>
      <div class="auth-links">
        <button type="button" class="auth-link" id="aToSignup">Create account</button>
        <button type="button" class="auth-link" id="aToForgot">Forgot password?</button>
      </div>`;
  },
  wireLogin() {
    $('#aToSignup')?.addEventListener('click', () => this.show('signup'));
    $('#aToForgot')?.addEventListener('click', () => this.show('forgot'));
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await this.api('/api/auth/login', { email: $('#aEmail').value, password: $('#aPass').value });
      if (r.totpRequired) { this.pendingEmail = $('#aEmail').value.trim().toLowerCase(); this.show('totp'); return; }
      if (r.status === 200) { await this.refresh(); this.close(); this.toast(`Welcome back, ${r.user.email}`); return; }
      $('#aErr').innerHTML = this.errBox(r.error || 'login failed');
    });
  },

  stepTotp() {
    return `<div class="auth-head"><div class="auth-title">TWO-FACTOR CODE</div><div class="auth-sub">Enter the 6-digit code from your authenticator app${this.pendingEmail ? ` (${esc(this.pendingEmail)})` : ''}</div></div>
      <form id="authForm" novalidate>
        <div class="field"><label for="aTotp">Authenticator code</label><input id="aTotp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="000000" required autocomplete="one-time-code"></div>
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Verify</button>
      </form>
      <div class="auth-links"><button type="button" class="auth-link" id="aBack">Back to sign in</button></div>`;
  },
  wireTotp() {
    $('#aBack')?.addEventListener('click', () => this.show('login'));
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await this.api('/api/auth/login/totp', { email: this.pendingEmail, totpCode: $('#aTotp').value });
      if (r.status === 200) { await this.refresh(); this.close(); this.toast(r.usedBackup ? 'Signed in with backup code' : 'Signed in'); return; }
      $('#aErr').innerHTML = this.errBox(r.error || 'invalid code');
    });
  },

  stepSignup() {
    return `<div class="auth-head"><div class="auth-title">CREATE ACCOUNT</div><div class="auth-sub">Email + password · password reset by email</div></div>
      <form id="authForm" novalidate>
        ${this.field('Email', 'email', 'aEmail', 'required')}
        ${this.field('Password (8–72 UTF-8 bytes)', 'password', 'aPass', 'required minlength="8"', 'new-password')}
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Create account</button>
      </form>
      <div class="auth-links"><button type="button" class="auth-link" id="aToLogin">Already have an account? Sign in</button></div>`;
  },
  wireSignup() {
    $('#aToLogin')?.addEventListener('click', () => this.show('login'));
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      // referral code from the shared link (/app?ref=CODE) — referee +10, referrer +50
      const ref = new URLSearchParams(location.search).get('ref') || undefined;
      const email = $('#aEmail').value.trim().toLowerCase();
      const r = await this.api('/api/auth/register', { email, password: $('#aPass').value, ref });
      if (r.status === 201) {
        await this.refresh(); this.close();
        const refMsg = r.refAward?.ok ? ` · referral applied (+${r.refAward.refereePoints} points)` : (r.refAward && !r.refAward.ok ? '' : '');
        this.toast(`Account created — welcome, ${r.user.email}${refMsg}`);
        return;
      }
      if (r.accountCreated) {
        this.show('login');
        const input = $('#aEmail'); if (input) input.value = email;
        const box = $('#aErr'); if (box) box.innerHTML = this.noticeBox('Account created. Sign in to continue.');
        $('#aPass')?.focus();
        return;
      }
      $('#aErr').innerHTML = this.errBox(r.error || 'registration failed');
    });
  },

  stepForgot() {
    return `<div class="auth-head"><div class="auth-title">RESET PASSWORD</div><div class="auth-sub">We'll email you a single-use reset link (valid 45 minutes)</div></div>
      <form id="authForm" novalidate>
        ${this.field('Email', 'email', 'aEmail', 'required')}
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Send reset link</button>
      </form>
      <div class="auth-links"><button type="button" class="auth-link" id="aBack">Back to sign in</button></div>`;
  },
  wireForgot() {
    $('#aBack')?.addEventListener('click', () => this.show('login'));
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.api('/api/auth/reset/request', { email: $('#aEmail').value });
      $('#authBody').innerHTML = `<div class="auth-head"><div class="auth-title">CHECK YOUR EMAIL</div><div class="auth-sub">If that address is registered, a reset link is on its way (45 min expiry, single use).</div></div>
        <button class="btn ghost block" id="aDone">Back to sign in</button>`;
      $('#aDone')?.addEventListener('click', () => this.show('login'));
    });
  },

  stepAccount() {
    const u = this.state.user;
    return `<div class="auth-head"><div class="auth-title">ACCOUNT</div><div class="auth-sub">${esc(u?.email || '')}</div></div>
      <div class="auth-row">
        <span>Two-factor authentication</span>
        <span class="mono">${u?.totpEnabled ? '<span class="up">ENABLED</span>' : '<span class="dim">OFF</span>'}</span>
      </div>
      <div id="aErr"></div>
      <button class="btn green block" id="a2fa">${u?.totpEnabled ? 'Disable 2FA' : 'Enable 2FA'}</button>
      <button class="btn ghost block" id="aClose2">Close</button>`;
  },
  wireAccount() {
    $('#aClose2')?.addEventListener('click', () => this.close());
    $('#a2fa')?.addEventListener('click', () => {
      if (this.state.user?.totpEnabled) this.show('2fa-disable');
      else this.show('2fa-enable');
    });
  },

  step2faEnable() {
    this._fetch2faSetup();
    return `<div class="auth-head"><div class="auth-title">ENABLE 2FA — STEP 1/2</div><div class="auth-sub">Scan the QR code with your authenticator app (Google Authenticator, 1Password, …)</div></div>
      <div class="auth-qr" id="aQr"><div class="dim">generating…</div></div>
      <div class="field"><label for="aSecret">Secret key <span class="dim">(manual entry)</span></label><input id="aSecret" type="text" readonly></div>
      <form id="authForm" novalidate>
        <div class="field"><label for="aTotp">Confirm with a 6-digit code</label><input id="aTotp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="000000" required autocomplete="one-time-code"></div>
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Enable 2FA</button>
      </form>
      <div class="auth-links"><button type="button" class="auth-link" id="aCancel">Cancel</button></div>`;
  },
  async _fetch2faSetup() {
    const r = await this.api('/api/auth/2fa/enable', {});
    if (r.qrDataUrl) {
      const qr = $('#aQr'); if (qr) qr.innerHTML = `<img src="${r.qrDataUrl}" alt="QR code to scan with your authenticator app" width="180" height="180">`;
      const sec = $('#aSecret'); if (sec) sec.value = r.secret;
    } else {
      const qr = $('#aQr'); if (qr) qr.innerHTML = this.errBox(r.error || '2FA setup failed');
    }
  },
  wire2faEnable() {
    $('#aCancel')?.addEventListener('click', () => this.show('account'));
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await this.api('/api/auth/2fa/confirm', { totpCode: $('#aTotp').value });
      if (r.ok) { this.pendingBackupCodes = r.backupCodes; await this.refresh(); this.show('backup'); return; }
      $('#aErr').innerHTML = this.errBox(r.error || 'invalid code');
    });
  },

  stepBackup() {
    const codes = this.pendingBackupCodes || [];
    return `<div class="auth-head"><div class="auth-title">SAVE YOUR BACKUP CODES</div><div class="auth-sub">Each code works once as a sign-in fallback. Store them somewhere safe — they won't be shown again.</div></div>
      <ol class="backup-codes" aria-label="One-time backup codes">${codes.map(c => `<li class="mono">${esc(c)}</li>`).join('')}</ol>
      <button class="btn green block" id="aCopy">Copy codes</button>
      <button class="btn ghost block" id="aDone">I've saved them — done</button>`;
  },
  wireBackup() {
    $('#aDone')?.addEventListener('click', () => { this.close(); this.toast('2FA enabled — backup codes saved'); });
    $('#aCopy')?.addEventListener('click', () => {
      const text = (this.pendingBackupCodes || []).join('\n');
      navigator.clipboard?.writeText(text).then(() => this.toast('Backup codes copied')).catch(() => this.toast('Copy failed — select and copy manually'));
    });
  },

  step2faDisable() {
    return `<div class="auth-head"><div class="auth-title">DISABLE 2FA</div><div class="auth-sub">Enter a current code to confirm</div></div>
      <form id="authForm" novalidate>
        <div class="field"><label for="aTotp">Authenticator code</label><input id="aTotp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="000000" required autocomplete="one-time-code"></div>
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Disable 2FA</button>
      </form>
      <div class="auth-links"><button type="button" class="auth-link" id="aCancel">Cancel</button></div>`;
  },
  wire2faDisable() {
    $('#aCancel')?.addEventListener('click', () => this.show('account'));
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await this.api('/api/auth/2fa/disable', { totpCode: $('#aTotp').value });
      if (r.ok) { await this.refresh(); this.show('account'); this.toast('2FA disabled'); return; }
      $('#aErr').innerHTML = this.errBox(r.error || 'invalid code');
    });
  },

  // ---------------- password reset view (from email link) ----------------
  async showReset() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const token = q.get('token') || '';
    const ov = $('#authReset'); if (!ov) return;
    if (ov.classList.contains('hidden')) this.lastFocus = document.activeElement;
    ov.classList.remove('hidden');
    const body = $('#authResetBody');
    if (!token) { body.innerHTML = `<div class="auth-head"><div class="auth-title">RESET PASSWORD</div><div class="auth-sub">Missing reset token — use the full link from your email.</div></div>`; return; }
    const v = await this.api('/api/auth/reset/validate', { token });
    if (v.valid !== true) { body.innerHTML = `<div class="auth-head"><div class="auth-title">LINK INVALID OR EXPIRED</div><div class="auth-sub">Reset links are single-use and expire after 45 minutes. Request a new one.</div></div>`; return; }
    body.innerHTML = `<div class="auth-head"><div class="auth-title">CHOOSE A NEW PASSWORD</div><div class="auth-sub">Use 8–72 UTF-8 bytes. All current sessions will be signed out.</div></div>
      <form id="authForm" novalidate>
        <div class="field"><label for="aPass">New password</label><input id="aPass" type="password" required minlength="8" autocomplete="new-password"></div>
        <div id="aErr"></div>
        <button class="btn green block" type="submit">Set new password</button>
      </form>
      <div class="auth-links"><button type="button" class="auth-link" id="aToLogin">Sign in instead</button></div>`;
    setTimeout(() => $('#aPass')?.focus(), 30);
    $('#aToLogin')?.addEventListener('click', () => { this.close(); this.open('login'); });
    $('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await this.api('/api/auth/reset/confirm', { token, password: $('#aPass').value });
      if (r.ok) {
        body.innerHTML = `<div class="auth-head"><div class="auth-title">PASSWORD UPDATED</div><div class="auth-sub">Sign in with your new password.</div></div>
          <button class="btn green block" id="aDone">Sign in</button>`;
        $('#aDone')?.addEventListener('click', () => { this.close(); this.open('login'); });
        return;
      }
      $('#aErr').innerHTML = this.errBox(r.error || 'reset failed');
    });
  },

  async logout() {
    const result = await this.api('/api/auth/logout', {});
    if (result.status !== 200 || !result.ok) {
      await this.refresh();
      this.toast(result.error || 'Sign out failed. Please try again.');
      return;
    }
    this.state.loggedIn = false; this.state.user = null; this.state.agent = false;
    this.close();
    await this.refresh();
    this.toast('Signed out');
  },
};

// wire step DOM after each render
const origShow = Auth.show.bind(Auth);
Auth.show = function (step) {
  origShow(step);
  const wire = { login: Auth.wireLogin, signup: Auth.wireSignup, forgot: Auth.wireForgot,
    totp: Auth.wireTotp, account: Auth.wireAccount, '2fa-enable': Auth.wire2faEnable,
    '2fa-disable': Auth.wire2faDisable, backup: Auth.wireBackup }[step];
  if (wire) wire.call(Auth);
};

window.Auth = Auth;
Auth.init();
