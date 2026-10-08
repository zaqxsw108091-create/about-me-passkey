// 패스키 인증 핵심: 등록 · 로그인 · 로그아웃 · 로그인 상태(세션) 확인
// 사용 라이브러리: @simplewebauthn/server (서명 검증 같은 어려운 부분을 맡는다)
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { generateUserID, decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  HttpError, readCookie, cookieName, setSessionCookie, clearSessionCookie,
  newToken, newId, sha256Hex, safeEqual, maskToken, log, cleanText,
} from './http.js';

const ACCOUNT_NAME_RE = /^[0-9A-Za-z가-힣_\- ]{2,20}$/;

// ─── 기록(로그인 성공/실패 등) ───────────────────────────
// DB에도 남기고 서버 로그에도 남긴다. 토큰은 항상 가려서(앞 4글자) 남긴다.
export async function record(ctx, type, ok, reason, { accountId = null, token = '', credentialId = '' } = {}) {
  const ev = {
    id: newId(),
    accountId,
    type,
    ok,
    reason,
    tokenHint: token ? maskToken(token) : '',
    credentialHint: credentialId ? `${credentialId.slice(0, 6)}…` : '',
    createdAt: Date.now(),
  };
  log(type, { ok, reason, accountId, token: ev.tokenHint, credential: ev.credentialHint });
  try {
    await ctx.db.addEvent(ev);
  } catch (e) {
    log('event_write_failed', { message: String(e.message || e) });
  }
}

// ─── 로그인 상태(세션) ───────────────────────────────────
// 쿠키의 토큰 → 해시 → DB에서 찾기. 없거나 만료면 null.
export async function currentSession(ctx) {
  if (ctx._session !== undefined) return ctx._session;
  ctx._session = null;
  const token = readCookie(ctx.req, cookieName(ctx.cfg));
  if (!token || token.length > 200) return null;
  const hash = sha256Hex(token);
  const s = await ctx.db.getSession(hash);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    await ctx.db.deleteSession(hash);
    return null;
  }
  const account = await ctx.db.getAccount(s.accountId);
  if (!account) return null;
  ctx._session = { token, hash, accountId: s.accountId, credentialId: s.credentialId, account };
  return ctx._session;
}

// 비공개 API의 첫 관문: 로그인 상태가 아니면 여기서 401로 끝난다.
export async function requireSession(ctx) {
  const s = await currentSession(ctx);
  if (!s) throw new HttpError(401, 'LOGIN_REQUIRED', '로그인이 필요합니다.');
  return s;
}

async function startSession(ctx, accountId, credentialId) {
  const old = await currentSession(ctx); // 이미 있던 로그인은 끊고 새 토큰을 발급(세션 고정 공격 방지)
  if (old) await ctx.db.deleteSession(old.hash);
  const token = newToken();
  const now = Date.now();
  await ctx.db.createSession(sha256Hex(token), { accountId, credentialId, createdAt: now, expiresAt: now + ctx.cfg.sessionMs });
  setSessionCookie(ctx.res, ctx.cfg, token);
  ctx._session = undefined;
  return token;
}

// ─── 도우미 ──────────────────────────────────────────────
function challengeOf(response) {
  try {
    return decodeClientDataJSON(response.response.clientDataJSON).challenge || '';
  } catch {
    return '';
  }
}

// 챌린지를 꺼내면서 삭제한다. 없거나(이미 사용/가짜) 만료되면 거부.
async function takeValidChallenge(ctx, response, purposes) {
  const challenge = challengeOf(response);
  const rec = challenge ? await ctx.db.takeChallenge(challenge) : null;
  if (!rec) return { rec: null, reason: 'challenge-unknown-or-reused' };
  if (rec.expiresAt < Date.now()) return { rec: null, reason: 'challenge-expired' };
  if (!purposes.includes(rec.purpose)) return { rec: null, reason: 'challenge-wrong-purpose' };
  return { rec };
}

function seedNotes(accountId, name) {
  const now = Date.now();
  const make = (i, title, body) => ({ id: newId(), accountId, title, body, createdAt: now + i });
  return [
    make(0, `${name}의 첫 비공개 메모`, `이 글은 ${name} 계정으로 로그인했을 때만 서버가 내려줍니다.`),
    make(1, `${name}의 할 일 (예시)`, '패스키를 두 개 만들고, 하나를 지워도 들어와지는지 확인하기.'),
    make(2, `${name}의 보관함 (예시)`, '예시 글입니다. 진짜 개인정보나 비밀값은 여기에 적지 마세요.'),
  ];
}

// ═══ 1) 등록: 챌린지 받기 ═════════════════════════════════
// POST /api/register/options
//   mode:'new'  → 새 계정 + 첫 패스키 (로그인 전)
//   mode:'add'  → 내 계정에 패스키 추가 (로그인 필요)
export async function registerOptions(ctx) {
  const { cfg, db, body } = ctx;
  const mode = body.mode === 'add' ? 'add' : 'new';
  const passkeyName = cleanText(body.passkeyName, 30, { min: 1 });
  if (!passkeyName) throw new HttpError(400, 'BAD_PASSKEY_NAME', '패스키 이름을 1~30자로 적어 주세요.');

  const sess = await currentSession(ctx);
  let rec;
  let userName;
  let userID;
  let exclude = [];

  if (mode === 'add') {
    if (!sess) throw new HttpError(401, 'LOGIN_REQUIRED', '패스키를 추가하려면 먼저 로그인해야 합니다.');
    const mine = await db.listPasskeys(sess.accountId);
    if (mine.length >= cfg.maxPasskeys) throw new HttpError(409, 'PASSKEY_LIMIT', `패스키는 계정당 최대 ${cfg.maxPasskeys}개입니다.`);
    userName = sess.account.name;
    userID = isoBase64URL.toBuffer(sess.account.userHandle);
    exclude = mine.map((p) => ({ id: p.id, transports: p.transports }));
    rec = { purpose: 'register-add', accountId: sess.accountId, passkeyName };
  } else {
    if (sess) throw new HttpError(409, 'ALREADY_LOGGED_IN', '이미 로그인되어 있습니다. 로그아웃 후 새 계정을 만드세요.');
    const accountName = cleanText(body.accountName, 20, { min: 2 });
    if (!ACCOUNT_NAME_RE.test(accountName)) throw new HttpError(400, 'BAD_ACCOUNT_NAME', '계정 이름은 2~20자의 한글·영문·숫자·_-·공백만 쓸 수 있습니다.');
    if (cfg.inviteCode && !safeEqual(body.inviteCode || '', cfg.inviteCode)) {
      await record(ctx, 'register_fail', false, 'bad-invite-code');
      throw new HttpError(403, 'BAD_INVITE', '초대 코드가 맞지 않습니다.');
    }
    if ((await db.countAccounts()) >= cfg.maxAccounts) {
      await record(ctx, 'register_fail', false, 'account-limit');
      throw new HttpError(403, 'ACCOUNT_LIMIT', `이 사이트는 계정을 최대 ${cfg.maxAccounts}개까지만 만듭니다.`);
    }
    userName = accountName;
    userID = await generateUserID();
    rec = { purpose: 'register-new', accountName, passkeyName };
  }

  // 챌린지는 라이브러리가 요청마다 새 무작위 값으로 만든다
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName,
    userDisplayName: userName,
    userID,
    attestationType: 'none',
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    timeout: 60_000,
  });
  await db.putChallenge({ ...rec, challenge: options.challenge, userHandle: options.user.id, expiresAt: Date.now() + cfg.challengeMs });
  return { options };
}

// ═══ 2) 등록: 서명 확인 후 공개 키 저장 ══════════════════
// POST /api/register/verify
export async function registerVerify(ctx) {
  const { cfg, db, body } = ctx;
  const response = body.response;
  if (!response || typeof response !== 'object' || !response.response) throw new HttpError(400, 'BAD_REQUEST', '잘못된 요청입니다.');

  const { rec, reason } = await takeValidChallenge(ctx, response, ['register-new', 'register-add']);
  if (!rec) {
    await record(ctx, 'register_fail', false, reason);
    throw new HttpError(400, 'CHALLENGE_INVALID', '챌린지가 없거나 이미 사용되었거나 만료되었습니다. 처음부터 다시 시도하세요.');
  }

  let info;
  try {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: rec.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      requireUserVerification: true,
    });
    if (!v.verified) throw new Error('not verified');
    info = v.registrationInfo;
  } catch (e) {
    await record(ctx, 'register_fail', false, 'attestation-invalid');
    throw new HttpError(400, 'VERIFY_FAILED', '패스키 확인에 실패했습니다.');
  }

  const now = Date.now();
  const credential = info.credential;
  const passkey = {
    id: credential.id,
    accountId: '', // 아래에서 채움
    publicKey: isoBase64URL.fromBuffer(credential.publicKey), // 저장되는 건 "공개 키"뿐
    counter: credential.counter,
    transports: Array.isArray(response.response.transports) ? response.response.transports.slice(0, 6).map(String) : [],
    name: rec.passkeyName,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    createdAt: now,
    lastUsedAt: null,
  };

  let accountId;
  try {
    if (rec.purpose === 'register-new') {
      accountId = newId();
      passkey.accountId = accountId;
      const account = { id: accountId, name: rec.accountName, nameLower: rec.accountName.toLowerCase(), userHandle: rec.userHandle, createdAt: now };
      await db.createAccount({ account, passkey, notes: seedNotes(accountId, rec.accountName), maxAccounts: cfg.maxAccounts });
    } else {
      const sess = await currentSession(ctx);
      if (!sess || sess.accountId !== rec.accountId) throw new HttpError(403, 'NOT_YOURS', '다른 계정의 요청입니다.');
      accountId = sess.accountId;
      passkey.accountId = accountId;
      await db.addPasskey(passkey);
    }
  } catch (e) {
    if (e instanceof HttpError) {
      await record(ctx, 'register_fail', false, 'session-mismatch');
      throw e;
    }
    const map = { ACCOUNT_LIMIT: [403, '계정 수 제한에 도달했습니다.'], NAME_TAKEN: [409, '이미 있는 계정 이름입니다.'], PASSKEY_EXISTS: [409, '이미 등록된 패스키입니다.'] };
    const [status, message] = map[e.message] || [500, '저장 중 오류가 났습니다.'];
    await record(ctx, 'register_fail', false, String(e.message));
    throw new HttpError(status, map[e.message] ? e.message : 'SERVER_ERROR', message);
  }

  const token = await startSession(ctx, accountId, passkey.id);
  const kind = rec.purpose === 'register-new' ? 'register_ok' : 'passkey_add';
  await record(ctx, kind, true, 'verified', { accountId, token, credentialId: passkey.id });
  return { ok: true, created: rec.purpose === 'register-new', passkeyName: passkey.name };
}

// ═══ 3) 로그인: 챌린지 받기 ═══════════════════════════════
// POST /api/login/options  (아이디를 묻지 않는다 — 기기가 알려 준다)
export async function loginOptions(ctx) {
  const { cfg, db } = ctx;
  const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required' });
  await db.putChallenge({ purpose: 'login', challenge: options.challenge, expiresAt: Date.now() + cfg.challengeMs });
  return { options };
}

// ═══ 4) 로그인: 서명 확인 후 세션 발급 ═══════════════════
// POST /api/login/verify
export async function loginVerify(ctx) {
  const { cfg, db, body } = ctx;
  const response = body.response;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.response) {
    throw new HttpError(400, 'BAD_REQUEST', '잘못된 요청입니다.');
  }
  const fail = async (reason, extra) => {
    await record(ctx, 'login_fail', false, reason, { credentialId: response.id, ...extra });
    throw new HttpError(401, 'LOGIN_FAILED', '로그인에 실패했습니다.');
  };

  const { rec, reason } = await takeValidChallenge(ctx, response, ['login']);
  if (!rec) return fail(reason); // 같은 서명을 다시 보내면 여기서 거부

  const passkey = await db.getPasskey(response.id);
  if (!passkey) return fail('unknown-or-deleted-passkey'); // 지운 패스키는 여기서 거부
  const account = await db.getAccount(passkey.accountId);
  if (!account) return fail('account-missing');
  if (response.response.userHandle && response.response.userHandle !== account.userHandle) {
    return fail('user-handle-mismatch', { accountId: account.id });
  }

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: rec.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });
  } catch (e) {
    return fail('signature-invalid', { accountId: account.id });
  }
  if (!result.verified) return fail('signature-invalid', { accountId: account.id });

  await db.updatePasskeyUse(passkey.id, result.authenticationInfo.newCounter, Date.now());
  const token = await startSession(ctx, account.id, passkey.id);
  await record(ctx, 'login_ok', true, 'verified', { accountId: account.id, token, credentialId: passkey.id });
  return { ok: true };
}

// ═══ 5) 로그아웃 ═════════════════════════════════════════
// POST /api/logout — 서버에서 세션을 지운다. 예전 쿠키를 다시 보내도 401.
export async function logout(ctx) {
  const sess = await currentSession(ctx);
  if (sess) {
    await ctx.db.deleteSession(sess.hash);
    await record(ctx, 'logout', true, 'session-deleted', { accountId: sess.accountId, token: sess.token });
  }
  clearSessionCookie(ctx.res, ctx.cfg);
  return { ok: true };
}

// 로그인 여부 확인(공개) — 비로그인이어도 200으로 {loggedIn:false}
export async function sessionInfo(ctx) {
  const sess = await currentSession(ctx);
  const base = { inviteRequired: Boolean(ctx.cfg.inviteCode), maxAccounts: ctx.cfg.maxAccounts };
  if (!sess) return { loggedIn: false, ...base };
  return { loggedIn: true, account: { name: sess.account.name }, tokenHint: maskToken(sess.token), ...base };
}
