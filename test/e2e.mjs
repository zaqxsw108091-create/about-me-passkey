// 자동 시험: 진짜 브라우저(Chromium)의 "가상 패스키 장치"로 등록·로그인·거부를 전부 돌려 본다.
// 실행:  npm i -D playwright  후  npm test      (개발자용 — 배포에는 필요 없음)
// 주의: 이 시험은 메모리 DB를 씁니다. 진짜 Firestore/Vercel은 배포 후 직접 확인해야 합니다.
import { createRequire } from 'node:module';

process.env.USE_MEMORY_DB = '1';
process.env.ORIGIN = 'http://localhost:3222';
process.env.INVITE_CODE = 'test-code';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire(`${process.env.PW_GLOBAL || '/home/claude/.npm-global/lib/node_modules'}/`)('playwright'));
}

// 서버가 남기는 로그를 모아서 나중에 "토큰이 가려졌는지" 검사
const serverLogs = [];
const origLog = console.log;
console.log = (...a) => {
  const line = a.join(' ');
  if (line.startsWith('{"t":')) serverLogs.push(line);
  else origLog(...a);
};

const { createDevServer } = await import('../server/dev.js');
const { getDb } = await import('../server/db.js');

const ORIGIN = process.env.ORIGIN;
const server = createDevServer().listen(3222);
const db = () => getDb()._dump();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Node에서 직접 서버로 요청 (브라우저 화면을 거치지 않는 "직접 요청")
async function raw(method, path, { cookie, origin = ORIGIN, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch { /* html 등 */ }
  return { status: r.status, data };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');

const cspViolations = [];
const pageErrors = [];
page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('dialog', (d) => d.accept());

const challenges = []; // 서버가 낸 챌린지 모음
let lastLoginVerifyBody = null;
page.on('response', async (r) => {
  const u = r.url();
  if ((u.endsWith('/api/login/options') || u.endsWith('/api/register/options')) && r.ok()) {
    try { challenges.push((await r.json()).options.challenge); } catch { /* ignore */ }
  }
});
page.on('request', (r) => { if (r.url().endsWith('/api/login/verify')) lastLoginVerifyBody = r.postData(); });

// ─── 가상 패스키 장치 다루기 ───────────────────────────────
let authId = null;
async function newDevice(credentials = []) {
  if (authId) await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authId });
  const r = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  authId = r.authenticatorId;
  for (const credential of credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId: authId, credential });
}
async function deviceCredentials() {
  return (await cdp.send('WebAuthn.getCredentials', { authenticatorId: authId })).credentials;
}

const status = () => page.locator('#pz-status').innerText();
async function waitMember() { await page.waitForSelector('#pz-member:not([hidden])', { timeout: 8000 }); }
async function waitGuest() { await page.waitForSelector('#pz-guest:not([hidden])', { timeout: 8000 }); }
async function waitStatus(re) {
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('pz-status').textContent), re.source, { timeout: 8000 });
}
const cookieHeader = async () => (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

async function registerNew(account, passkey, code = 'test-code') {
  await page.fill('#reg-account', account);
  await page.fill('#reg-passkey', passkey);
  await page.fill('#reg-invite', code);
  await page.click('#btn-register');
}
const accountByName = (name) => [...db().accounts.values()].find((a) => a.name === name);
const notesOf = (id) => [...db().notes.values()].filter((n) => n.accountId === id);
const passkeysOf = (id) => [...db().passkeys.values()].filter((p) => p.accountId === id);

try {
  // ═══ A. 공개 페이지 / 로그인 없이 직접 요청 ═══
  await page.goto(ORIGIN + '/');
  await waitGuest();
  check('첫 화면은 공개 소개(이름·소개 문장 보임)', (await page.locator('h1').innerText()).includes('윤대영'));
  const t0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#theme-btn');
  check('과제 1 페이지 기능(다크모드 버튼, 인라인 스크립트)이 그대로 동작', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== t0);
  await page.click('#theme-btn');
  check('과제 1의 대표 카드 3개가 그대로 있다', (await page.locator('.card-row .card').count()) === 3);
  check('비밀번호 입력칸이 없다', (await page.locator('input[type="password"]').count()) === 0);
  check('초대 코드 칸이 서버 설정에 따라 보인다', await page.locator('#reg-invite-wrap').isVisible());

  const noAuth = [
    await raw('GET', '/api/notes'), await raw('GET', '/api/passkeys'), await raw('GET', '/api/events'),
    await raw('GET', '/api/notes/abc'), await raw('DELETE', '/api/notes/abc'), await raw('DELETE', '/api/passkeys/abc'),
  ];
  check('로그인 없이 비공개 API 6개 직접 요청 → 모두 401', noAuth.every((r) => r.status === 401), noAuth.map((r) => r.status).join(','));
  const forged = [await raw('GET', '/api/notes', { cookie: 'sid=forged-token-1234' }), await raw('GET', '/api/passkeys', { cookie: 'sid=' + 'x'.repeat(43) })];
  check('가짜 토큰 쿠키 → 401', forged.every((r) => r.status === 401));

  // ═══ B. 등록 ═══
  await newDevice();

  // B-1 취소 처리: 브라우저가 NotAllowedError를 던지는 상황
  await page.evaluate(() => {
    navigator.credentials.create = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
  });
  await registerNew('테스트A', '내 노트북');
  await waitStatus(/취소/);
  check('등록 취소 → 안내 문구, 서버에 계정·패스키 저장 안 됨', db().accounts.size === 0 && db().passkeys.size === 0, await status());
  await page.reload();
  await waitGuest();

  // B-2 초대 코드 틀림
  await registerNew('테스트A', '내 노트북', 'wrong');
  await waitStatus(/초대 코드/);
  check('초대 코드가 틀리면 계정 생성 거부(403)', db().accounts.size === 0);

  // B-3 계정 A 등록 성공
  await registerNew('테스트A', '내 노트북');
  await waitMember();
  const A = accountByName('테스트A');
  check('계정 A 등록 성공 + 자동 로그인', Boolean(A) && (await page.locator('#pm-name').innerText()) === '테스트A');
  const pk1 = passkeysOf(A.id)[0];
  check('서버에는 공개 키만 저장(개인 키 필드 없음)', pk1 && typeof pk1.publicKey === 'string' && !('privateKey' in pk1) && pk1.name === '내 노트북');
  check('등록 후 비공개 메모 3개 이상 표시', (await page.locator('#notes-list li').count()) >= 3);
  const flowText = await page.locator('#pz-flow').innerText();
  check('화면에 챌린지 앞부분·"개인 키는 보내지 않음" 안내 표시', /챌린지를 냈습니다: \S{8}…/.test(flowText) && flowText.includes('개인 키는 보내지 않습니다'));

  const cookie = (await context.cookies()).find((c) => c.name === 'sid');
  check('세션 쿠키: HttpOnly + SameSite=Strict', cookie && cookie.httpOnly && cookie.sameSite === 'Strict');
  check('자바스크립트로는 쿠키가 안 보인다', (await page.evaluate(() => document.cookie)) === '');
  const storedSession = [...db().sessions.keys()][0];
  check('DB에는 토큰 원문이 아니라 해시만 저장', storedSession && storedSession !== cookie.value && storedSession.length === 64);

  // B-4 두 번째 패스키 추가 (다른 장치 흉내)
  const creds1 = await deviceCredentials();
  await newDevice();
  await page.fill('#addpk-name', '내 휴대폰');
  await page.click('#form-addpk button[type="submit"]');
  await waitStatus(/추가했습니다/);
  let creds2 = await deviceCredentials();
  await page.waitForFunction(() => document.querySelectorAll('#pk-list li').length === 2);
  check('같은 계정에 패스키 2개', passkeysOf(A.id).length === 2 && (await page.locator('#pk-list li').count()) === 2);
  const listText = await page.locator('#pk-list').innerText();
  check('목록에 이름·만든 날 표시', listText.includes('내 노트북') && listText.includes('내 휴대폰') && listText.includes('만든 날'));

  // ═══ C. 로그아웃 / 세션 무효화 ═══
  const oldCookie = await cookieHeader();
  const before = await raw('GET', '/api/notes', { cookie: oldCookie });
  await page.click('#btn-logout');
  await waitGuest();
  const after = await raw('GET', '/api/notes', { cookie: oldCookie });
  check('로그아웃 전 쿠키는 200, 후에는 같은 쿠키가 401', before.status === 200 && after.status === 401, `${before.status} → ${after.status}`);

  // ═══ D. 로그인 (새 챌린지, 서명 검증) ═══
  await page.click('#btn-login');
  await waitMember();
  check('패스키 로그인 성공(두 번째 패스키로)', (await page.locator('#pm-name').innerText()) === '테스트A');
  const loginBody = lastLoginVerifyBody;
  const replay = await raw('POST', '/api/login/verify', { body: JSON.parse(loginBody) });
  check('같은 서명 재전송(챌린지 재사용) → 401', replay.status === 401, `${replay.status}`);

  // 챌린지 만료
  const o = await raw('POST', '/api/login/options', { body: {} });
  const ch = o.data.options.challenge;
  for (const rec of db().challenges.values()) if (rec.challenge === ch) rec.expiresAt = 1;
  const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ch, origin: ORIGIN })).toString('base64url');
  const expired = await raw('POST', '/api/login/verify', { body: { response: { id: 'fake', rawId: 'fake', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: cd, authenticatorData: 'AA', signature: 'AA' } } } });
  check('만료된 챌린지 → 401', expired.status === 401);

  // ═══ E. 패스키 삭제 ═══
  const pkNow = passkeysOf(A.id);
  const p1 = pkNow.find((p) => p.name === '내 노트북');
  const p2 = pkNow.find((p) => p.name === '내 휴대폰');
  const [firstDeleteBtn] = await page.locator('#pk-list li', { hasText: '내 노트북' }).locator('button.danger').all();
  await firstDeleteBtn.click();
  await waitStatus(/지웠습니다/);
  check('패스키 하나 삭제 → 1개 남음', passkeysOf(A.id).length === 1 && passkeysOf(A.id)[0].id === p2.id);
  const last = await raw('DELETE', '/api/passkeys/' + encodeURIComponent(p2.id), { cookie: await cookieHeader() });
  check('마지막 패스키 삭제 시도 → 409(거부), 계속 1개', last.status === 409 && passkeysOf(A.id).length === 1);

  await page.click('#btn-logout');
  await waitGuest();
  creds2 = await deviceCredentials(); // 사용 횟수(signCount)까지 최신으로 보관
  // 지운 패스키만 가진 장치로 로그인 시도
  await newDevice(creds1);
  await page.click('#btn-login');
  await waitStatus(/실패/);
  check('지운 패스키로 로그인 → 거부', (await page.locator('#pz-member').isHidden()));
  check('실패 기록이 남는다(unknown-or-deleted-passkey)', db().events.some((e) => e.type === 'login_fail' && e.reason === 'unknown-or-deleted-passkey'));
  // 남은 패스키로는 계속 로그인 가능
  await newDevice(creds2);
  await page.click('#btn-login');
  await waitMember();
  check('남은 패스키로는 계속 로그인 가능', (await page.locator('#pm-name').innerText()) === '테스트A');

  // ═══ F. 두 번째 계정 B ═══
  await page.click('#btn-logout');
  await waitGuest();
  creds2 = await deviceCredentials();
  await newDevice();
  await registerNew('테스트B', 'B의 휴대폰');
  await waitMember();
  const B = accountByName('테스트B');
  check('계정 B 등록 성공', Boolean(B));
  const noteTitlesB = await page.locator('#notes-list .t').allInnerTexts();
  check('B의 비공개 메모는 A와 내용이 다르다', noteTitlesB.length >= 3 && noteTitlesB.every((t) => t.includes('테스트B')));
  const credsB = await deviceCredentials();

  // ═══ G. 계정 간 접근 (B로 로그인한 상태에서 A의 자료 요청) ═══
  const aNote = notesOf(A.id)[0];
  const aNotesBefore = notesOf(A.id).length;
  const aPkBefore = passkeysOf(A.id).length;
  const ckB = await cookieHeader();
  const cross1 = await raw('GET', '/api/notes/' + aNote.id, { cookie: ckB });
  const cross2 = await raw('DELETE', '/api/notes/' + aNote.id, { cookie: ckB });
  const cross3 = await raw('DELETE', '/api/passkeys/' + encodeURIComponent(p2.id), { cookie: ckB });
  check('B가 A의 메모 보기/삭제, A의 패스키 삭제 요청 → 모두 403', [cross1, cross2, cross3].every((r) => r.status === 403), [cross1, cross2, cross3].map((r) => r.status).join(','));
  check('거부 후 A의 자료 개수 그대로(메모·패스키)', notesOf(A.id).length === aNotesBefore && passkeysOf(A.id).length === aPkBefore, `메모 ${aNotesBefore}→${notesOf(A.id).length}, 패스키 ${aPkBefore}→${passkeysOf(A.id).length}`);
  const viaQuery = await raw('GET', `/api/notes?accountId=${A.id}&account=${A.name}`, { cookie: ckB });
  check('주소에 다른 계정을 적어도 무시(내 메모만 옴)', viaQuery.status === 200 && viaQuery.data.notes.every((n) => n.title.includes('테스트B')));
  const bNotesBefore = notesOf(B.id).length;
  await raw('POST', '/api/notes', { cookie: ckB, body: { accountId: A.id, title: '본문에 A를 적어도', body: 'B의 메모로 저장되어야 함' } });
  const planted = [...db().notes.values()].find((n) => n.title === '본문에 A를 적어도');
  check('본문에 다른 계정 id를 넣어도 무시(세션 계정에 저장)', planted && planted.accountId === B.id && notesOf(B.id).length === bNotesBefore + 1);
  check('거부 기록이 남는다(access_denied)', db().events.filter((e) => e.type === 'access_denied').length >= 3);

  // 세 번째 계정 시도는 제한
  await page.click('#btn-logout');
  await waitGuest();
  await newDevice();
  await registerNew('테스트C', 'C의 폰');
  await waitStatus(/최대 2개/);
  check('세 번째 계정은 거부(계정 최대 2개)', db().accounts.size === 2);

  // 반대 방향: A로 로그인해서 B의 자료 요청
  await newDevice(creds2);
  await page.click('#btn-login');
  await waitMember();
  check('다시 A로 로그인', (await page.locator('#pm-name').innerText()) === '테스트A');
  const bNote = notesOf(B.id)[0];
  const bBefore = { n: notesOf(B.id).length, p: passkeysOf(B.id).length };
  const rev1 = await raw('GET', '/api/notes/' + bNote.id, { cookie: await cookieHeader() });
  const rev2 = await raw('DELETE', '/api/passkeys/' + encodeURIComponent(passkeysOf(B.id)[0].id), { cookie: await cookieHeader() });
  check('반대 방향(A→B)도 403', rev1.status === 403 && rev2.status === 403);
  check('B의 자료 개수 그대로', notesOf(B.id).length === bBefore.n && passkeysOf(B.id).length === bBefore.p);

  // 화면의 "직접 확인해 보기"
  await page.fill('#chk-id', bNote.id);
  await page.click('#chk-note-del');
  await page.waitForFunction(() => document.getElementById('chk-out').textContent.includes('403'));
  const out = await page.locator('#chk-out').innerText();
  check('화면의 직접 확인 버튼: 403 + 개수 비교 표시', out.includes('NOT_YOURS') && /내 메모 \d+개 → \d+개/.test(out), out.replace(/\n/g, ' | '));
  await page.click('#chk-anon');
  await page.waitForFunction(() => document.getElementById('chk-out').textContent.includes('401'));
  check('화면의 "로그인 없이 요청" 버튼 → 401', (await page.locator('#chk-out').innerText()).includes('LOGIN_REQUIRED'));

  // ═══ H. 출처·로그·소스 ═══
  const badOrigin = await raw('POST', '/api/logout', { origin: 'https://evil.example', cookie: await cookieHeader() });
  const noOrigin = await raw('POST', '/api/logout', { origin: null, cookie: await cookieHeader() });
  check('다른 출처/출처 없는 POST → 403', badOrigin.status === 403 && noOrigin.status === 403);

  check('챌린지는 요청마다 다르다', challenges.length >= 6 && new Set(challenges).size === challenges.length, `${challenges.length}개 모두 다름`);

  const tokens = (await context.cookies()).map((c) => c.value).concat(oldCookie.split('; ').map((c) => c.split('=')[1]));
  const logText = serverLogs.join('\n');
  check('서버 로그에 세션 토큰 원문이 없다', tokens.filter(Boolean).every((t) => !logText.includes(t)));
  check('서버 로그에 성공·실패 기록이 있고 토큰은 앞 4글자+****', /"type":"login_ok".*"token":"[\w-]{4}\*{4}"/.test(logText) && /"type":"login_fail"/.test(logText));

  const sources = await Promise.all(['/', '/private.js', '/private.css'].map(async (p) => (await fetch(ORIGIN + p)).text()));
  const secrets = ['테스트A', '테스트B', '첫 비공개 메모', '내 노트북', 'B의 휴대폰'];
  check('로그인 안 한 페이지 소스(HTML/JS)에 비공개 내용이 없다', sources.every((s) => secrets.every((x) => !s.includes(x))));
  check('공개 페이지에 sw 라이브러리 외 외부 스크립트가 없다', !/<script[^>]+src="https?:/.test(sources[0]));
  check('서버 코드·package.json 이 웹에서 보이지 않는다', (await fetch(ORIGIN + '/server/db.js')).status === 404 && (await fetch(ORIGIN + '/package.json')).status === 404);

  check('CSP 위반 없음', cspViolations.length === 0, cspViolations.join(' | '));
  check('페이지 자바스크립트 오류 없음', pageErrors.length === 0, pageErrors.join(' | '));

  // 화면 캡처 (눈으로 확인용)
  const outDir = process.env.SHOT_DIR;
  if (outDir) {
    await page.locator('#private-zone').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${outDir}/member-light.png`, fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: `${outDir}/member-dark.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: `${outDir}/member-mobile.png`, fullPage: true });
  }
} catch (e) {
  check('시험 진행 중 예외 없음', false, String(e && e.stack ? e.stack : e));
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
origLog(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
