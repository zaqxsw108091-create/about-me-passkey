// "나만 들어가기" 화면 동작
// 이 파일에는 비공개 데이터가 없습니다. 로그인한 뒤에 서버(/api/...)에서 받아와서 그릴 뿐입니다.
// 받은 글은 항상 textContent로 넣습니다(HTML로 해석하지 않음).
(function () {
  'use strict';

  var SW = window.SimpleWebAuthnBrowser; // simplewebauthn-browser.js 가 만든 전역 객체
  var $ = function (id) { return document.getElementById(id); };
  var state = { notes: 0, passkeys: 0, busy: false };

  // ─── 작은 도구 ──────────────────────────────────────────
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function when(ms) {
    return ms ? new Date(ms).toLocaleString('ko-KR') : '아직 없음';
  }
  function short(text) {
    return String(text).slice(0, 8) + '…';
  }
  function setStatus(kind, text) {
    var s = $('pz-status');
    s.className = 'pz-status ' + kind; // ok | err | info
    s.textContent = text;
    s.hidden = false;
  }
  function flowReset() {
    var f = $('pz-flow');
    f.textContent = '';
    f.hidden = true;
  }
  function flow(text) {
    var f = $('pz-flow');
    f.appendChild(el('li', '', text));
    f.hidden = false;
  }
  function setBusy(on) {
    state.busy = on;
    ['btn-login', 'btn-register', 'btn-logout'].forEach(function (id) { if ($(id)) $(id).disabled = on; });
  }

  async function api(method, path, body, opts) {
    var init = { method: method, credentials: opts && opts.omit ? 'omit' : 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var r = await fetch(path, init);
    var data = {};
    try { data = await r.json(); } catch (e) { /* 본문 없음 */ }
    return { status: r.status, ok: r.ok, data: data };
  }

  // 패스키 창에서 취소했을 때 등: 브라우저가 던진 오류를 사람 말로
  function explainError(e, what) {
    var name = (e && e.cause && e.cause.name) || (e && e.name) || '';
    var code = (e && e.code) || '';
    if (name === 'NotAllowedError' || code === 'ERROR_CEREMONY_ABORTED') {
      return what + '이(가) 취소되었거나 시간이 지나 중단되었습니다. 서버에는 아무것도 저장되지 않았습니다.';
    }
    if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
      return '이 기기에는 이 계정의 패스키가 이미 있습니다.';
    }
    return what + ' 중 문제가 생겼습니다: ' + ((e && e.message) || name || '알 수 없는 오류');
  }

  // ─── 화면 전환 ──────────────────────────────────────────
  async function refresh() {
    var r = await api('GET', '/api/session');
    var info = r.data || {};
    $('reg-invite-wrap').hidden = !info.inviteRequired;
    if (!info.loggedIn) {
      $('pz-guest').hidden = false;
      $('pz-member').hidden = true;
      return false;
    }
    $('pz-guest').hidden = true;
    $('pz-member').hidden = false;
    $('pm-name').textContent = info.account.name;
    $('pm-token').textContent = info.tokenHint;
    await Promise.all([loadNotes(), loadPasskeys(), loadEvents()]);
    return true;
  }

  // ─── 메모 ───────────────────────────────────────────────
  async function loadNotes() {
    var r = await api('GET', '/api/notes');
    if (r.status === 401) return refresh();
    var list = $('notes-list');
    list.textContent = '';
    var notes = r.data.notes || [];
    state.notes = notes.length;
    $('notes-count').textContent = '(' + notes.length + '개)';
    notes.forEach(function (n) {
      var li = el('li');
      li.appendChild(el('span', 't', n.title));
      if (n.body) li.appendChild(el('span', 'sub', n.body));
      var meta = el('span', 'sub', when(n.createdAt) + ' · id ');
      meta.appendChild(el('code', '', short(n.id)));
      li.appendChild(meta);
      var row = el('div', 'pz-row');
      var copy = el('button', 'pz-btn', 'id 복사');
      copy.type = 'button';
      copy.addEventListener('click', function () { copyId(n.id); });
      var del = el('button', 'pz-btn danger', '삭제');
      del.type = 'button';
      del.addEventListener('click', async function () {
        var d = await api('DELETE', '/api/notes/' + encodeURIComponent(n.id));
        if (!d.ok) setStatus('err', d.data.message || '삭제하지 못했습니다.');
        await Promise.all([loadNotes(), loadEvents()]);
      });
      row.appendChild(copy);
      row.appendChild(del);
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  // ─── 패스키 목록 ────────────────────────────────────────
  async function loadPasskeys() {
    var r = await api('GET', '/api/passkeys');
    if (r.status === 401) return refresh();
    var list = $('pk-list');
    list.textContent = '';
    var pks = r.data.passkeys || [];
    state.passkeys = pks.length;
    $('pk-count').textContent = '(' + pks.length + '개)';
    pks.forEach(function (p) {
      var li = el('li');
      var title = el('span', 't', p.name);
      if (p.id === r.data.currentPasskeyId) title.appendChild(el('span', 'tag', '지금 로그인에 사용'));
      li.appendChild(title);
      li.appendChild(el('span', 'sub', '만든 날 ' + when(p.createdAt)));
      li.appendChild(el('span', 'sub', '마지막 사용 ' + when(p.lastUsedAt)));
      li.appendChild(el('span', 'sub', p.backedUp ? '동기화·백업되는 패스키' : '이 기기에만 있는 패스키'));
      var meta = el('span', 'sub', 'id ');
      meta.appendChild(el('code', '', short(p.id)));
      li.appendChild(meta);
      var row = el('div', 'pz-row');
      var copy = el('button', 'pz-btn', 'id 복사');
      copy.type = 'button';
      copy.addEventListener('click', function () { copyId(p.id); });
      var del = el('button', 'pz-btn danger', '삭제');
      del.type = 'button';
      del.addEventListener('click', function () { removePasskey(p); });
      row.appendChild(copy);
      row.appendChild(del);
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  async function removePasskey(p) {
    if (!window.confirm('"' + p.name + '" 패스키를 지울까요? 이 패스키로는 더 이상 들어올 수 없습니다.')) return;
    var r = await api('DELETE', '/api/passkeys/' + encodeURIComponent(p.id));
    if (r.ok) setStatus('ok', '"' + p.name + '" 패스키를 지웠습니다. 다른 패스키로 계속 들어올 수 있습니다.');
    else setStatus('err', r.data.message || '지우지 못했습니다.');
    if (r.status === 401) return refresh();
    await Promise.all([loadPasskeys(), loadEvents()]);
  }

  // ─── 검증 기록 ──────────────────────────────────────────
  var EVENT_LABEL = {
    register_ok: '계정·패스키 등록', passkey_add: '패스키 추가', login_ok: '로그인', login_fail: '로그인 실패',
    logout: '로그아웃', register_fail: '등록 실패', passkey_delete: '패스키 삭제',
    passkey_delete_refused: '패스키 삭제 거부', access_denied: '남의 자료 요청 거부',
  };
  async function loadEvents() {
    var r = await api('GET', '/api/events');
    if (!r.ok) return;
    var list = $('ev-list');
    list.textContent = '';
    (r.data.events || []).forEach(function (e) {
      var li = el('li');
      var head = el('span', 't');
      head.appendChild(el('span', e.ok ? 'good' : 'bad', e.ok ? '성공 ' : '실패 '));
      head.appendChild(document.createTextNode(EVENT_LABEL[e.type] || e.type));
      li.appendChild(head);
      var detail = when(e.createdAt) + ' · ' + e.reason;
      if (e.tokenHint) detail += ' · 세션 ' + e.tokenHint;
      if (e.credentialHint) detail += ' · 패스키 ' + e.credentialHint;
      if (!e.mine) detail += ' · (누구인지 알 수 없는 시도)';
      li.appendChild(el('span', 'sub', detail));
      list.appendChild(li);
    });
  }

  function copyId(id) {
    var done = function () { setStatus('info', 'id를 복사했습니다. 다른 계정으로 로그인한 뒤 "직접 확인해 보기"에 붙여 넣으세요.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(done, function () { window.prompt('이 id를 복사해 두세요', id); });
    } else {
      window.prompt('이 id를 복사해 두세요', id);
    }
  }

  // ─── 등록 (새 계정 / 패스키 추가) ───────────────────────
  async function register(payload) {
    if (state.busy) return;
    setBusy(true);
    flowReset();
    try {
      flow('1. 서버에 새 챌린지를 요청합니다.');
      var o = await api('POST', '/api/register/options', payload);
      if (!o.ok) {
        setStatus('err', o.data.message || '시작하지 못했습니다.');
        return;
      }
      flow('2. 서버가 이번 요청만의 새 챌린지를 냈습니다: ' + short(o.data.options.challenge));
      flow('3. 이 기기에서 패스키를 만듭니다. (지문·얼굴·화면 잠금 확인)');
      var att;
      try {
        att = await SW.startRegistration({ optionsJSON: o.data.options });
      } catch (e) {
        flow('→ 기기 단계에서 멈췄습니다.');
        setStatus('err', explainError(e, '패스키 만들기'));
        return;
      }
      flow('4. 공개 키와 서명을 서버로 보냅니다. (개인 키는 보내지 않습니다)');
      var v = await api('POST', '/api/register/verify', { response: att });
      if (!v.ok) {
        setStatus('err', v.data.message || '서버가 패스키를 받아주지 않았습니다.');
        return;
      }
      flow('5. 서버가 서명을 확인하고 공개 키를 저장했습니다.');
      setStatus('ok', v.data.created ? '계정과 첫 패스키를 만들고 로그인했습니다.' : '"' + v.data.passkeyName + '" 패스키를 추가했습니다.');
      $('form-register').reset();
      $('form-addpk').reset();
      await refresh();
    } catch (e) {
      setStatus('err', '서버와 통신하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  // ─── 로그인 ─────────────────────────────────────────────
  async function login() {
    if (state.busy) return;
    setBusy(true);
    flowReset();
    try {
      flow('1. 서버에 새 챌린지를 요청합니다.');
      var o = await api('POST', '/api/login/options', {});
      if (!o.ok) {
        setStatus('err', o.data.message || '시작하지 못했습니다.');
        return;
      }
      flow('2. 서버가 이번 요청만의 새 챌린지를 냈습니다: ' + short(o.data.options.challenge));
      flow('3. 이 기기가 개인 키로 챌린지에 서명합니다. (지문·얼굴·화면 잠금 확인)');
      var asse;
      try {
        asse = await SW.startAuthentication({ optionsJSON: o.data.options });
      } catch (e) {
        flow('→ 기기 단계에서 멈췄습니다.');
        setStatus('err', explainError(e, '로그인'));
        return;
      }
      flow('4. 서명만 서버로 보냅니다. (개인 키는 보내지 않습니다)');
      var v = await api('POST', '/api/login/verify', { response: asse });
      if (!v.ok) {
        flow('→ 서버가 서명을 거부했습니다.');
        setStatus('err', '로그인에 실패했습니다. 지운 패스키이거나 확인되지 않은 요청일 수 있습니다.');
        return;
      }
      flow('5. 서버가 공개 키로 서명을 확인하고 새 로그인 상태를 만들었습니다.');
      setStatus('ok', '로그인했습니다.');
      await refresh();
    } catch (e) {
      setStatus('err', '서버와 통신하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (state.busy) return;
    setBusy(true);
    try {
      await api('POST', '/api/logout', {});
      flowReset();
      setStatus('ok', '로그아웃했습니다. 서버에서 이 로그인 상태를 지웠기 때문에, 예전 쿠키로는 다시 들어올 수 없습니다.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  // ─── "직접 확인해 보기" ─────────────────────────────────
  function show(lines) {
    $('chk-out').textContent = lines.join('\n');
  }
  async function counts() {
    var n = await api('GET', '/api/notes');
    var p = await api('GET', '/api/passkeys');
    return { notes: (n.data.notes || []).length, passkeys: (p.data.passkeys || []).length };
  }
  async function probe(method, path, label, omit) {
    var before = omit ? null : await counts();
    var r = await api(method, path, method === 'POST' ? {} : undefined, { omit: omit });
    var lines = [label, '→ ' + r.status + ' ' + (r.data.error || 'OK') + (r.data.message ? ' · ' + r.data.message : '')];
    if (!omit) {
      var after = await counts();
      lines.push('내 메모 ' + before.notes + '개 → ' + after.notes + '개 · 내 패스키 ' + before.passkeys + '개 → ' + after.passkeys + '개');
    }
    show(lines);
    if (!omit) await Promise.all([loadNotes(), loadPasskeys(), loadEvents()]);
  }
  function targetId() {
    var id = $('chk-id').value.trim();
    if (!id) show(['먼저 다른 계정의 id를 붙여 넣으세요.']);
    return id;
  }

  // ─── 연결 ───────────────────────────────────────────────
  function init() {
    if (!SW || !window.PublicKeyCredential) {
      setStatus('err', '이 브라우저는 패스키를 지원하지 않습니다. 최신 Chrome·Safari·Edge에서 열어 주세요.');
      $('btn-login').disabled = true;
      $('btn-register').disabled = true;
      return;
    }
    $('btn-login').addEventListener('click', login);
    $('btn-logout').addEventListener('click', logout);
    $('form-register').addEventListener('submit', function (ev) {
      ev.preventDefault();
      register({
        mode: 'new',
        accountName: $('reg-account').value,
        passkeyName: $('reg-passkey').value,
        inviteCode: $('reg-invite').value,
      });
    });
    $('form-addpk').addEventListener('submit', function (ev) {
      ev.preventDefault();
      register({ mode: 'add', passkeyName: $('addpk-name').value });
    });
    $('form-note').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var r = await api('POST', '/api/notes', { title: $('note-title').value, body: $('note-body').value });
      if (r.ok) $('form-note').reset();
      else setStatus('err', r.data.message || '메모를 저장하지 못했습니다.');
      await Promise.all([loadNotes(), loadEvents()]);
    });
    $('chk-anon').addEventListener('click', function () {
      probe('GET', '/api/notes', '로그인 쿠키 없이  GET /api/notes', true);
    });
    $('chk-note-get').addEventListener('click', function () {
      var id = targetId();
      if (id) probe('GET', '/api/notes/' + encodeURIComponent(id), 'GET /api/notes/' + short(id));
    });
    $('chk-note-del').addEventListener('click', function () {
      var id = targetId();
      if (id) probe('DELETE', '/api/notes/' + encodeURIComponent(id), 'DELETE /api/notes/' + short(id));
    });
    $('chk-pk-del').addEventListener('click', function () {
      var id = targetId();
      if (id) probe('DELETE', '/api/passkeys/' + encodeURIComponent(id), 'DELETE /api/passkeys/' + short(id));
    });
    refresh().catch(function () {
      setStatus('err', '서버에 연결하지 못했습니다.');
    });
  }

  init();
})();
