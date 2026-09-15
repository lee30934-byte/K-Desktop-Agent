// Independent WebView2 adapter. No Electron, credentials export, clipboard, or local tool IPC.
(() => {
  if (location.origin !== 'https://chatgpt.com' || window.__kdaPort) return;
  const state = { phase: 'login-required', authenticated: false, authCheckedAt: 0,
    turnId: null, text: '', error: null, startedAt: 0, lastChange: 0, stoppingAt: 0 };
  let authPending = false;
  let baseline = new Set();
  let observedStreaming = false;
  let submitted = false;
  const visible = el => Boolean(el && el.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden');
  const find = selector => [...document.querySelectorAll(selector)].find(visible);
  const composer = () => find('#prompt-textarea, [data-testid="prompt-textarea"]');
  const active = () => ['submitting', 'streaming', 'stopping'].includes(state.phase);
  const turnNodes = () => [...document.querySelectorAll('[data-turn-id]')];
  const identity = node => node.getAttribute('data-turn-id');
  function refreshAuth() {
    if (authPending || Date.now() - state.authCheckedAt < 15000) return;
    authPending = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal: ctl.signal })
      .then(async res => {
        const u = new URL(res.url);
        if (!res.ok || u.origin !== location.origin || u.pathname !== '/api/auth/session' || !res.headers.get('content-type')?.includes('application/json')) return null;
        return res.json();
      }).then(payload => {
        state.authenticated = Boolean(payload?.user && typeof payload.user === 'object' && !Array.isArray(payload.user) && Object.keys(payload.user).length && !payload.error && (!payload.expires || Date.parse(payload.expires) > Date.now()));
      }).catch(() => { state.authenticated = false; })
      .finally(() => { clearTimeout(timer); authPending = false; state.authCheckedAt = Date.now(); });
  }
  function snapshot() {
    refreshAuth();
    if (!active() && !submitted) state.phase = state.authenticated && composer() ? 'ready' : 'login-required';
    if (active()) {
      const now = Date.now();
      const stopButton = find('[data-testid="stop-button"]');
      if (stopButton) observedStreaming = true;
      const newNodes = turnNodes().filter(n => !baseline.has(identity(n)) && n.querySelector('[data-message-author-role="assistant"]'));
      const unique = new Map();
      for (const node of newNodes) {
        const id = identity(node);
        if (unique.has(id)) { state.phase = 'failed'; state.error = 'duplicate-turn-identity'; break; }
        unique.set(id, node);
      }
      if (unique.size > 1) { state.phase = 'failed'; state.error = 'ambiguous-assistant-turn'; }
      if (active() && unique.size === 1) {
        const [id, node] = [...unique][0];
        if (state.turnId && state.turnId !== id) { state.phase = 'failed'; state.error = 'turn-identity-changed'; }
        else {
          state.turnId = id;
          const text = node.querySelector('[data-message-author-role="assistant"]')?.innerText || '';
          if (text !== state.text) { state.text = text; state.lastChange = now; }
          if (state.phase !== 'stopping') state.phase = 'streaming';
          // Require a final-message control. Silence alone is never completion.
          const finalControl = node.querySelector('[data-testid="copy-turn-action-button"]');
          if (state.phase !== 'stopping' && text && finalControl && !stopButton && now - state.lastChange > 1500) state.phase = 'completed';
        }
      }
      if (state.phase === 'stopping' && !stopButton && observedStreaming) state.phase = 'cancelled';
      if (active() && state.stoppingAt && now - state.stoppingAt > 15000) { state.phase = 'failed'; state.error = 'stop-unconfirmed-close-browser'; }
      if (active() && now - state.startedAt > 180000) { state.phase = 'failed'; state.error = 'turn-timeout-close-browser'; }
    }
    return { ...state, composer: Boolean(composer()), temporary: new URL(location.href).searchParams.get('temporary-chat') === 'true', version: 1 };
  }
  function send(prompt) {
    if (typeof prompt !== "string" || !prompt.trim() || new TextEncoder().encode(prompt).length > 120000) throw new Error("invalid-prompt");
    snapshot();
    if (submitted) throw new Error('one-submit-per-document');
    if (state.phase !== 'ready' || new URL(location.href).searchParams.get('temporary-chat') !== 'true') throw new Error('not-ready');
    const box = composer();
    if ((box.value || box.innerText || '').trim()) throw new Error('composer-has-draft');
    const existing = turnNodes().map(identity);
    if (new Set(existing).size !== existing.length || existing.some(x => !x)) throw new Error('invalid-baseline');
    const wrappers = [...document.querySelectorAll('[data-turn-id-container]')]
      .map(node => node.getAttribute('data-turn-id-container')).filter(Boolean);
    baseline = new Set([...existing, ...wrappers]);
    // A unique harmless prompt makes response attribution manually reviewable.
    submitted = true;
    state.phase = 'submitting'; state.startedAt = Date.now(); state.lastChange = Date.now();
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, prompt);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      if (!document.execCommand('insertText', false, prompt)) { state.phase = 'failed'; state.error = 'composer-insert-failed'; return snapshot(); }
    }
    const waitSend = setInterval(() => {
      if (state.phase !== 'submitting') { clearInterval(waitSend); return; }
      const button = find('[data-testid="send-button"]');
      if (button && !button.disabled) {
        clearInterval(waitSend);
        button.click(); // Exactly one attempt; timeout/reconnect must never resend.
        state.phase = 'streaming';
      } else if (Date.now() - state.startedAt > 5000) {
        clearInterval(waitSend); state.phase = 'failed'; state.error = 'send-not-ready-no-retry';
      }
    }, 100);
    return snapshot();
  }
  function stop() {
    if (!active()) return snapshot();
    state.phase = 'stopping'; state.stoppingAt = Date.now();
    const button = find('[data-testid="stop-button"]');
    if (button) { observedStreaming = true; button.click(); }
    return snapshot();
  }
  window.__kdaPort = Object.freeze({ snapshot, send, stop });
})();
