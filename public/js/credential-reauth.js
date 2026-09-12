export function requestCredentialReauth(action, post) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'credential-reauth';
    dialog.setAttribute('aria-label', 'Confirm account identity');
    dialog.innerHTML = `<form><h2>Confirm account identity</h2><p>Use your IOST account password, not your exchange secret. If account 2FA is enabled, also enter a current code or backup code.</p>
      <label>Account password<input name="password" type="password" required autocomplete="current-password" maxlength="72"></label>
      <label>2FA or backup code (when enabled)<input name="totpCode" type="password" autocomplete="one-time-code" maxlength="32"></label>
      <p role="status"></p><button type="submit">Authenticate this action</button> <button type="button" data-cancel>Cancel</button></form>`;
    const form = dialog.querySelector('form'), output = dialog.querySelector('[role=status]'), button = form.querySelector('[type=submit]');
    let closed = false;
    const cancel = () => finish();
    const finish = token => { if (closed) return; closed = true; window.removeEventListener('authchange', cancel); window.removeEventListener('hashchange', cancel); form.reset(); dialog.close(); dialog.remove(); token ? resolve(token) : reject(Error('Authentication cancelled')); };
    window.addEventListener('authchange', cancel);
    window.addEventListener('hashchange', cancel);
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    dialog.querySelector('[data-cancel]').onclick = () => finish();
    form.onsubmit = async event => {
      event.preventDefault(); button.disabled = true;
      const body = { action, password: form.elements.password.value, totpCode: form.elements.totpCode.value }; form.reset();
      try {
        const result = await post('/api/exchange-connections/reauthenticate', body);
        if (closed) return;
        if (!result.ok || !/^[a-f0-9]{64}$/.test(result.token)) throw Error('unconfirmed');
        finish(result.token);
      } catch { if (!closed) output.textContent = 'Authentication failed or unavailable. Check your password and configured 2FA; nothing was changed.'; }
      finally { body.password = ''; body.totpCode = ''; if (!closed) button.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal();
  });
}
