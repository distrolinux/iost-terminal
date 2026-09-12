export function mountKrakenOnboarding(host, { status, post, isCurrent, refresh }) {
  if (!status?.canConnect) {
    host.textContent = status?.enabled ? 'A connection is already saved. Disconnect it before enrolling a replacement.' : 'New read-only connections are disabled until the operator enables onboarding and verifies vault setup. Live trading must stay separately gated.';
    return;
  }
  host.innerHTML = `<h3>Connect your own Kraken account — read-only</h3>
    <p>Create a dedicated read-only Kraken API key with Query Funds access. Trading, funding, withdrawal, transfer and unknown permissions are rejected. API-key 2FA is not supported by this flow. Never share keys with an agent or chat.</p>
    <form autocomplete="off"><label>Kraken API key<input type="password" name="apiKey" required minlength="16" maxlength="512" autocomplete="off" spellcheck="false"></label>
    <label>Kraken API secret<input type="password" name="apiSecret" required maxlength="258" autocomplete="off" spellcheck="false"></label>
    <label><input type="checkbox" name="consent" required> I own this key and consent to Kraken permission and balance-access checks. Nothing will be saved until I confirm.</label>
    <button class="btn" type="submit">Verify without saving</button></form>
    <p role="status" data-onboarding-result>Account connection never authorizes trading. Fee checks are not included.</p>
    <button class="btn ghost" data-save-connection disabled>Confirm encrypted save</button>
    <p>Disconnecting removes the active credential from IOST, but does not revoke it at Kraken or remove encrypted backups. Revoke the key in Kraken when no longer needed.</p>`;
  const form = host.querySelector('form'), submit = form.querySelector('button'), save = host.querySelector('[data-save-connection]'), output = host.querySelector('[data-onboarding-result]');
  let plan = null, revision = 0, timer;
  const active = r => host.isConnected && isCurrent() && r === revision;
  const invalidate = () => { revision++; plan = null; save.disabled = true; submit.disabled = false; clearTimeout(timer); };
  form.addEventListener('input', () => { invalidate(); output.textContent = 'Inputs changed. Verify again before saving.'; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); invalidate(); const r = revision;
    const body = { apiKey: form.elements.apiKey.value, apiSecret: form.elements.apiSecret.value, consent: form.elements.consent.checked };
    form.reset(); submit.disabled = true; output.textContent = 'Verifying read-only access; credentials have been cleared from the form…';
    try {
      const result = await post('/api/exchange-connections/kraken/onboarding-preview', body);
      if (!active(r)) return;
      if (!result.ok || result.profile !== 'read-only' || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw Error('unverified');
      plan = { token: result.token, expiresAt: result.expiresAt }; save.disabled = false;
      output.textContent = 'Read-only permissions and balance access verified. Not saved yet. Confirm within two minutes to store this credential encrypted; no trading permission is granted.';
      timer = setTimeout(() => { if (active(r)) { invalidate(); output.textContent = 'Verification expired. Nothing was saved; verify again.'; } }, Math.min(120000, result.expiresAt - Date.now()));
    } catch { if (active(r)) output.textContent = 'Verification failed or onboarding is unavailable. Check read-only permissions and credential format. No save was confirmed.'; }
    finally { body.apiKey = ''; body.apiSecret = ''; if (active(r)) submit.disabled = false; }
  });
  save.addEventListener('click', async () => {
    if (!plan || plan.expiresAt <= Date.now()) { invalidate(); output.textContent = 'Verification expired. Verify again.'; return; }
    if (!window.confirm('Save this verified read-only Kraken credential encrypted on IOST? This does not enable trading.')) return;
    const token = plan.token; invalidate(); const r = revision; submit.disabled = true;
    output.textContent = 'Saving the encrypted credential…';
    try {
      const result = await post('/api/exchange-connections/kraken/onboarding-commit', { token, confirmed: true });
      if (!active(r)) return;
      if (!result.ok || result.saved !== true) throw Error('unconfirmed');
      output.textContent = 'Read-only connection saved. Live trading remains separately gated.'; refresh();
    } catch { if (active(r)) output.textContent = 'Save not confirmed. Refresh connection status before retrying; do not assume the credential was saved or discarded.'; }
    finally { if (active(r)) submit.disabled = false; }
  });
}
