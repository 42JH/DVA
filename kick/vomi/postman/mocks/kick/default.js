// Local fixture from docs/kick-android-api.md. Never uses real credentials, FCM or paid synthesis.
const http = require('http');
const heldStreams = new Map();
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const body = req.body || {};
  const reply = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  };
  if (url.pathname.startsWith('/unavailable/')) {
    res.writeHead(503, { 'Content-Type': 'text/html' });
    return res.end('<html>Temporarily unavailable</html>');
  }
  if (url.pathname === '/health') {
    if (req.headers.authorization) return reply(400, { error: 'Health request must not carry session auth in this fixture' });
    return reply(200, { status: 'ok' });
  }
  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    if (req.headers.authorization) return reply(400, { error: 'Signup must not carry current session auth' });
    if (body.inviteCode !== 'fixture-invite') return reply(403, { error: 'Invalid invite code' });
    if (!body.displayName || body.displayName.length > 40) return reply(400, { error: 'Invalid name' });
    return reply(201, { id: 'fixture-created', displayName: body.displayName, token: 'fixture-created-token' });
  }
  const accountId = req.headers.authorization === 'Bearer fixture-a' ? 'kick-test-1'
    : req.headers.authorization === 'Bearer fixture-b' ? 'kick-test-2' : null;
  if (!accountId) return reply(401, { error: 'Unauthorized' });
  if (req.method === 'POST' && url.pathname === '/__fixture/stop-events') {
    const key = req.headers['x-fixture-session'] || 'default';
    for (const stream of heldStreams.get(key) || []) stream.end();
    heldStreams.delete(key);
    return reply(204);
  }
  if (req.method === 'POST' && url.pathname === '/__fixture/reset') {
    await pm.state.set('kick.calls', {});
    await pm.state.set('kick.requests', {});
    await pm.state.set('kick.active', null);
    await pm.state.set('kick.friends', [{ id: 'kick-test-2', displayName: '테스트 B' }]);
    await pm.state.set('kick.voice', 'READY');
    await pm.state.set('kick.push', null);
    return reply(204);
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts/me') return reply(200, { id: accountId, displayName: accountId === 'kick-test-1' ? '테스트 A' : '테스트 B' });
  const friends = (await pm.state.get('kick.friends')) || [];
  if (req.method === 'GET' && url.pathname === '/api/friends') return reply(200, friends);
  if (req.method === 'PUT' && url.pathname.startsWith('/api/friends/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/friends/'.length));
    const friend = { id, displayName: '새 친구' };
    if (!friends.some(item => item.id === id)) { friends.push(friend); await pm.state.set('kick.friends', friends); }
    return reply(200, friends.find(item => item.id === id));
  }
  if (req.method === 'GET' && url.pathname === '/api/voice') return reply(200, { status: (await pm.state.get('kick.voice')) || 'READY' });
  if (req.method === 'POST' && url.pathname === '/api/voice') {
    if (!(req.headers['content-type'] || '').startsWith('multipart/form-data;')) return reply(400, { error: 'Expected multipart' });
    await pm.state.set('kick.voice', 'CREATING');
    return reply(201, { status: 'CREATING' });
  }
  if (url.pathname === '/api/devices/push') {
    if (req.method === 'PUT') { if (!body.token) return reply(400, { error: 'Missing token' }); await pm.state.set('kick.push', body.token); return reply(204); }
    if (req.method === 'DELETE') { if (body.token !== await pm.state.get('kick.push')) return reply(400, { error: 'Token body mismatch' }); await pm.state.set('kick.push', null); return reply(204); }
  }
  const calls = (await pm.state.get('kick.calls')) || {};
  const activeId = await pm.state.get('kick.active');
  const active = activeId ? calls[activeId] : null;
  if (req.method === 'GET' && url.pathname === '/api/calls/active') return reply(200, { accountId, call: active || null });
  if (req.method === 'GET' && url.pathname === '/api/calls/events') {
    if (req.headers.accept !== 'text/event-stream') return reply(400, { error: 'Expected SSE Accept' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const encode = call => 'event: call\ndata: ' + JSON.stringify({ accountId, call: call || null }) + '\n\n';
    if (req.headers['x-fixture-hold-sse'] !== 'true') return res.end(encode(active));
    const streamKey = req.headers['x-fixture-session'] || 'default';
    if (!heldStreams.has(streamKey)) heldStreams.set(streamKey, new Set());
    heldStreams.get(streamKey).add(res);
    res.write(encode(active));
    let previous = JSON.stringify(active || null);
    let ticking = false;
    const timer = setInterval(async () => {
      if (ticking || res.destroyed) return;
      ticking = true;
      try {
        const callId = await pm.state.get('kick.active');
        const all = (await pm.state.get('kick.calls')) || {};
        const call = callId ? all[callId] : null;
        const value = JSON.stringify(call || null);
        if (value !== previous) { previous = value; res.write(encode(call)); }
      } finally { ticking = false; }
    }, 40);
    res.on('close', () => { clearInterval(timer); heldStreams.get(streamKey)?.delete(res); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/calls') {
    if (!body.calleeId || !body.requestId) return reply(400, { error: 'Invalid request' });
    const requests = (await pm.state.get('kick.requests')) || {};
    if (requests[body.requestId]) return reply(201, calls[requests[body.requestId]]);
    const call = { id: 'fixture-' + body.requestId, callerId: accountId, calleeId: body.calleeId, status: 'REQUESTED', requestedAt: '2026-11-13T00:00:00Z' };
    calls[call.id] = call;
    requests[body.requestId] = call.id;
    await pm.state.set('kick.calls', calls); await pm.state.set('kick.requests', requests); await pm.state.set('kick.active', call.id);
    return reply(201, call);
  }
  if (req.method === 'POST' && url.pathname === '/api/voice/speech/stream') {
    if (!body.text || body.text.length > 50) return reply(400, { error: 'Invalid text' });
    res.writeHead(200, { 'Content-Type': 'audio/pcm' });
    res.write(Buffer.from([0, 0, 1]));
    return res.end(Buffer.from([0, 2, 0]));
  }
  const match = url.pathname.match(/^\/api\/calls\/([^/]+)(\/join)?$/);
  if (match) {
    const call = calls[decodeURIComponent(match[1])];
    if (!call) return reply(404, { error: 'Not found' });
    if (req.method === 'GET' && !match[2]) return reply(200, call);
    if (req.method === 'PATCH' && !match[2]) {
      const statuses = { accept: 'ACCEPTED', reject: 'REJECTED', cancel: 'CANCELED', end: 'ENDED' };
      if (!statuses[body.action]) return reply(400, { error: 'Invalid action' });
      call.status = statuses[body.action];
      await pm.state.set('kick.calls', calls);
      if (body.action !== 'accept') await pm.state.set('kick.active', null);
      return body.action === 'cancel' ? reply(204) : reply(200, call);
    }
    if (req.method === 'POST' && match[2]) {
      if (call.status !== 'ACCEPTED') return reply(409, { error: 'Not accepted' });
      return reply(200, { url: 'wss://rtc-fixture.invalid', token: 'fixture-join-token' });
    }
  }
  return reply(501, { error: 'Endpoint outside this fixture' });
}).listen(process.env.PORT || 4018);
