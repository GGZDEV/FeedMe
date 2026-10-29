'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function codexExecutable(env = process.env) {
  const candidates = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'codex.exe'));
  const bundled = path.join(env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (env.LOCALAPPDATA && fs.existsSync(bundled)) for (const dir of fs.readdirSync(bundled)) candidates.push(path.join(bundled, dir, 'codex.exe'));
  return candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || null;
}

// The Claude Code CLI, if installed (npm puts claude.cmd in %APPDATA%\npm).
function claudeExecutable(env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, '.local', 'bin'));
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of dirs) for (const name of names) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return null;
}
// Claude Code renews its own expired access when it runs. `claude auth status`
// only reads the login state (no conversation, no usage), and renews it on the
// way. FeedMe never refreshes or writes those credentials itself.
function renewClaudeLogin(executable, spawnImpl = spawn, timeoutMs = 30000) {
  return new Promise(resolve => {
    let child, done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { child?.kill(); } catch { /* already gone */ } resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    try {
      // A .cmd needs a shell on Windows; the path is quoted, the arguments are fixed.
      const shell = /\.cmd$/i.test(executable);
      child = spawnImpl(shell ? `"${executable}"` : executable, ['auth', 'status'], { windowsHide: true, stdio: 'ignore', shell });
      child.on('error', finish); child.on('exit', finish);
    } catch { finish(); }
  });
}

function codexRateLimits(executable, spawnImpl = spawn, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    // No thread or inference is started. Only initialize and the quota read are sent.
    let child, buffer = '', done = false;
    const decoder = new StringDecoder('utf8');
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      child?.stdin.destroy(); child?.kill();
      error ? reject(new Error('CODEX_USAGE_UNAVAILABLE')) : resolve(value);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    try {
      child = spawnImpl(executable, ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', () => finish(true)); child.on('exit', () => finish(true));
      child.stderr.on('data', () => {}); // Never forward diagnostics or authentication data.
      child.stdin.on('error', () => finish(true));
      const send = frame => child.stdin.write(JSON.stringify(frame) + '\n');
      child.stdout.on('data', bytes => {
        if (done) return;
        buffer += decoder.write(bytes); if (buffer.length > 1024 * 1024) { finish(true); return; }
        let end;
        while (!done && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let frame; try { frame = JSON.parse(line); } catch { continue; }
          if (frame.id === 1) {
            if (frame.error) { finish(true); return; }
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (frame.id === 2) finish(!!frame.error, frame.result);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'feedme', title: 'FeedMe', version: '1.1.0' } } });
    } catch { finish(true); }
  });
}
function codexSnapshot(value, now = Date.now()) {
  const buckets = value?.rateLimitsByLimitId && Object.keys(value.rateLimitsByLimitId).length ? Object.values(value.rateLimitsByLimitId) : [value?.rateLimits];
  const windows = [];
  for (const bucket of buckets) for (const key of ['primary', 'secondary']) {
    const window = bucket?.[key]; if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
    const mins = window.windowDurationMins;
    const label = mins === 10080 ? 'Semaine' : mins > 0 && mins % 60 === 0 ? `${mins / 60} h` : mins > 0 ? `${mins} min` : key === 'primary' ? 'Limite principale' : 'Limite secondaire';
    windows.push({ label, groupLabel: buckets.length > 1 ? bucket.limitName || bucket.limitId || '' : '', usedPercent: window.usedPercent,
      resetAt: Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null });
  }
  return { updatedAt: now, providers: [{ provider: 'openai', displayName: 'ChatGPT / Codex', plan: buckets.find(b => b?.planType)?.planType || '', windows,
    ...(!windows.length ? { error: true, errorCode: 'CODEX_LOGIN_REQUIRED' } : {}) }] };
}
function claudeSnapshot(value, plan, now = Date.now()) {
  const labels = { five_hour: '5 h', seven_day: 'Semaine', seven_day_sonnet: 'Semaine · Sonnet', seven_day_opus: 'Semaine · Opus', seven_day_oauth_apps: 'Semaine · Applications' };
  const windows = Object.entries(value || {}).flatMap(([key, window]) => {
    if (!/^(five_hour|seven_day)(_[a-z0-9_]+)?$/.test(key) || !window || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return [];
    return [{ label: labels[key] || key.replaceAll('_', ' '), usedPercent: window.utilization, resetAt: Date.parse(window.resets_at) || null }];
  });
  return { updatedAt: now, providers: [{ provider: 'anthropic', displayName: 'Claude', plan, windows,
    ...(!windows.length ? { error: true, errorCode: 'CLAUDE_USAGE_UNAVAILABLE' } : {}) }] };
}
function createDirectUsage({ env = process.env, home = os.homedir(), fetchImpl = fetch, spawnImpl = spawn } = {}) {
  const failure = (provider, code) => ({ updatedAt: Date.now(), providers: [{ provider, windows: [], error: true, errorCode: code }] });
  const credentialsFile = () => path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json');
  const readOauth = () => { try { return JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')).claudeAiOauth; } catch { return null; } };
  const usable = oauth => !!oauth?.accessToken && !!oauth.scopes?.includes('user:profile') && !(Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now());
  let lastRenewal = 0;
  // At most one renewal a minute, so a broken login never loops.
  async function renew() {
    const executable = claudeExecutable(env);
    if (!executable || Date.now() - lastRenewal < 60000) return false;
    lastRenewal = Date.now();
    await renewClaudeLogin(executable, spawnImpl);
    return true;
  }
  async function claudeUsage(oauth) {
    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    return { snapshot: claudeSnapshot(await response.json(), typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : '') };
  }
  return {
    connections: () => [{ id: 'direct:codex', name: 'ChatGPT / Codex · connexion sur ce PC', kind: 'direct' },
      { id: 'direct:claude', name: 'Claude · connexion sur ce PC', kind: 'direct' }],
    async read(id) {
      if (id === 'direct:codex') {
        const executable = codexExecutable(env);
        if (!executable) return failure('openai', 'CODEX_LOGIN_REQUIRED');
        try { return codexSnapshot(await codexRateLimits(executable, spawnImpl)); }
        catch { return failure('openai', 'CODEX_LOGIN_REQUIRED'); }
      }
      if (id !== 'direct:claude') throw new Error('Source inconnue.');
      // Expired or refused access: let Claude Code renew it, then try once more.
      let oauth = readOauth();
      if (!usable(oauth)) { if (await renew()) oauth = readOauth(); }
      if (!usable(oauth)) return failure('anthropic', 'CLAUDE_LOGIN_REQUIRED');
      try {
        let result = await claudeUsage(oauth);
        if ((result.status === 401 || result.status === 403) && await renew()) {
          const renewed = readOauth();
          if (usable(renewed) && renewed.accessToken !== oauth.accessToken) result = await claudeUsage(renewed);
        }
        if (result.snapshot) return result.snapshot;
        return failure('anthropic', result.status === 401 || result.status === 403 ? 'CLAUDE_LOGIN_REQUIRED' : 'CLAUDE_USAGE_UNAVAILABLE');
      } catch { return failure('anthropic', 'CLAUDE_USAGE_UNAVAILABLE'); }
    }
  };
}
module.exports = { createDirectUsage, codexSnapshot, claudeSnapshot, codexRateLimits, claudeExecutable, renewClaudeLogin };
