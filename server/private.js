// 비공개 영역 API: 메모 · 패스키 목록/삭제 · 기록
// 규칙 1) 모든 함수는 requireSession()으로 시작한다 → 로그인 안 했으면 401
// 규칙 2) "누구의 것인지"는 세션에서만 정한다. 주소(URL)나 본문(body)에 적힌 계정 값은 읽지 않는다.
// 규칙 3) 남의 자료 id를 요청하면 ownedBy()에서 403으로 거부한다 (없는 id도 같은 403 — 존재 여부를 알려주지 않음)
import { HttpError, newId, cleanText } from './http.js';
import { requireSession, record } from './auth.js';

// ★ 거부 코드는 여기 한 곳에 모여 있습니다
function ownedBy(item, accountId) {
  if (!item || item.accountId !== accountId) {
    throw new HttpError(403, 'NOT_YOURS', '내 계정의 자료가 아닙니다.');
  }
  return item;
}

const publicNote = (n) => ({ id: n.id, title: n.title, body: n.body, createdAt: n.createdAt });
const publicPasskey = (p) => ({
  id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
  deviceType: p.deviceType, backedUp: p.backedUp,
}); // 공개 키·카운터는 화면에 내려주지 않는다

// ─── 메모 ────────────────────────────────────────────────
export async function listNotes(ctx) {
  const s = await requireSession(ctx);
  const notes = await ctx.db.listNotes(s.accountId); // accountId는 세션에서만 온다 (?accountId= 는 무시)
  return { notes: notes.map(publicNote) };
}

export async function getNote(ctx, id) {
  const s = await requireSession(ctx);
  const note = await ctx.db.getNote(id);
  if (!note || note.accountId !== s.accountId) {
    await record(ctx, 'access_denied', false, 'note-get-not-yours', { accountId: s.accountId, token: s.token });
  }
  return { note: publicNote(ownedBy(note, s.accountId)) };
}

export async function addNote(ctx) {
  const s = await requireSession(ctx);
  const title = cleanText(ctx.body.title, 60, { min: 1 });
  const body = cleanText(ctx.body.body, 500);
  if (!title) throw new HttpError(400, 'BAD_NOTE', '제목을 1~60자로 적어 주세요.');
  const mine = await ctx.db.listNotes(s.accountId);
  if (mine.length >= ctx.cfg.maxNotes) throw new HttpError(409, 'NOTE_LIMIT', `메모는 최대 ${ctx.cfg.maxNotes}개입니다.`);
  const note = { id: newId(), accountId: s.accountId, title, body, createdAt: Date.now() };
  await ctx.db.addNote(note);
  return { note: publicNote(note) };
}

export async function deleteNote(ctx, id) {
  const s = await requireSession(ctx);
  const note = await ctx.db.getNote(id);
  if (!note || note.accountId !== s.accountId) {
    await record(ctx, 'access_denied', false, 'note-delete-not-yours', { accountId: s.accountId, token: s.token });
  }
  ownedBy(note, s.accountId);
  await ctx.db.deleteNote(id);
  return { ok: true };
}

// ─── 패스키 ──────────────────────────────────────────────
export async function listPasskeys(ctx) {
  const s = await requireSession(ctx);
  const list = await ctx.db.listPasskeys(s.accountId);
  return { passkeys: list.map(publicPasskey), currentPasskeyId: s.credentialId };
}

export async function deletePasskey(ctx, id) {
  const s = await requireSession(ctx);
  const passkey = await ctx.db.getPasskey(id);
  if (!passkey || passkey.accountId !== s.accountId) {
    await record(ctx, 'access_denied', false, 'passkey-delete-not-yours', { accountId: s.accountId, token: s.token });
  }
  ownedBy(passkey, s.accountId);

  // 마지막 패스키는 지울 수 없다 (지우면 이 계정으로 영영 못 들어옴)
  const mine = await ctx.db.listPasskeys(s.accountId);
  if (mine.length <= 1) {
    await record(ctx, 'passkey_delete_refused', false, 'last-passkey', { accountId: s.accountId, token: s.token });
    throw new HttpError(409, 'LAST_PASSKEY', '마지막 패스키는 지울 수 없습니다. 먼저 다른 패스키를 추가하세요.');
  }

  await ctx.db.deletePasskey(id);
  await ctx.db.deleteSessionsByCredential(id); // 그 패스키로 만든 로그인 상태도 함께 끊는다
  ctx._session = undefined;
  await record(ctx, 'passkey_delete', true, 'deleted', { accountId: s.accountId, token: s.token, credentialId: id });
  const left = await ctx.db.listPasskeys(s.accountId);
  return { ok: true, passkeys: left.map(publicPasskey) };
}

// ─── 기록 ────────────────────────────────────────────────
export async function listEvents(ctx) {
  const s = await requireSession(ctx);
  const events = await ctx.db.listEvents(s.accountId, 30);
  return {
    events: events.map((e) => ({
      type: e.type, ok: e.ok, reason: e.reason, tokenHint: e.tokenHint, credentialHint: e.credentialHint,
      createdAt: e.createdAt, mine: e.accountId === s.accountId,
    })),
  };
}
