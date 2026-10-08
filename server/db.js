// 저장소(데이터베이스) 연결.
// 실제 배포: Firebase Firestore (서버만 서비스 계정 키로 접근, 브라우저는 접근 불가)
// 로컬 시험: 메모리 DB (USE_MEMORY_DB=1 일 때만, Vercel에서는 거부)
//
// 저장되는 것 (모두 "공개 키"까지만 — 비공개 키·비밀번호는 서버에 없음)
//   accounts/{id}              계정 이름, 사용자 핸들
//   accounts/{id}/events/{id}  그 계정의 로그인·등록·거부 기록
//   passkeys/{credentialId}    공개 키, 사용 횟수, 이름, 만든 날
//   challenges/{sha256}        1회용 챌린지 (쓰면 바로 삭제)
//   sessions/{sha256(토큰)}    로그인 상태 (토큰 원문은 저장하지 않음)
//   notes/{id}                 비공개 메모
//   anon_events/{id}           누구 것인지 모르는 로그인 실패 기록

import { Firestore } from '@google-cloud/firestore';
import { sha256Hex } from './http.js';

let instance;
export function getDb() {
  if (instance) return instance;
  if (process.env.USE_MEMORY_DB === '1') {
    if (process.env.VERCEL) throw new Error('메모리 DB는 Vercel에서 쓸 수 없습니다.');
    instance = createMemoryDb();
  } else {
    instance = createFirestoreDb();
  }
  return instance;
}

// ═══ Firestore ═══════════════════════════════════════════
function createFirestoreDb() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('환경변수 FIREBASE_SERVICE_ACCOUNT 가 없습니다.');
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(json);
  const fs = new Firestore({
    projectId: sa.project_id,
    credentials: { client_email: sa.client_email, private_key: sa.private_key },
    preferRest: true,
  });
  const col = (name) => fs.collection(name);
  const data = (snap) => (snap.exists ? snap.data() : null);

  return {
    kind: 'firestore',

    async countAccounts() {
      return (await col('accounts').get()).size;
    },
    async getAccount(id) {
      return data(await col('accounts').doc(id).get());
    },
    // 계정 + 첫 패스키 + 기본 메모를 한 번에 만든다. 계정 수 제한도 같은 트랜잭션에서 확인.
    async createAccount({ account, passkey, notes, maxAccounts }) {
      await fs.runTransaction(async (t) => {
        const all = await t.get(col('accounts'));
        if (all.size >= maxAccounts) throw new Error('ACCOUNT_LIMIT');
        if (all.docs.some((d) => d.data().nameLower === account.nameLower)) throw new Error('NAME_TAKEN');
        const pkRef = col('passkeys').doc(passkey.id);
        if ((await t.get(pkRef)).exists) throw new Error('PASSKEY_EXISTS');
        t.set(col('accounts').doc(account.id), account);
        t.set(pkRef, passkey);
        for (const n of notes) t.set(col('notes').doc(n.id), n);
      });
    },

    async getPasskey(id) {
      return data(await col('passkeys').doc(id).get());
    },
    async listPasskeys(accountId) {
      const snap = await col('passkeys').where('accountId', '==', accountId).get();
      return snap.docs.map((d) => d.data()).sort((a, b) => a.createdAt - b.createdAt);
    },
    async addPasskey(passkey) {
      await fs.runTransaction(async (t) => {
        const ref = col('passkeys').doc(passkey.id);
        if ((await t.get(ref)).exists) throw new Error('PASSKEY_EXISTS');
        t.set(ref, passkey);
      });
    },
    async updatePasskeyUse(id, counter, lastUsedAt) {
      await col('passkeys').doc(id).update({ counter, lastUsedAt });
    },
    async deletePasskey(id) {
      await col('passkeys').doc(id).delete();
    },

    async putChallenge(rec) {
      await col('challenges').doc(sha256Hex(rec.challenge)).set(rec);
    },
    // 챌린지를 "꺼내면서 삭제" — 같은 챌린지를 두 번 쓸 수 없다
    async takeChallenge(challenge) {
      const ref = col('challenges').doc(sha256Hex(challenge));
      return fs.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) return null;
        t.delete(ref);
        return snap.data();
      });
    },

    async createSession(hash, rec) {
      await col('sessions').doc(hash).set(rec);
    },
    async getSession(hash) {
      return data(await col('sessions').doc(hash).get());
    },
    async deleteSession(hash) {
      await col('sessions').doc(hash).delete();
    },
    async deleteSessionsByCredential(credentialId) {
      const snap = await col('sessions').where('credentialId', '==', credentialId).get();
      const batch = fs.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    },

    async listNotes(accountId) {
      const snap = await col('notes').where('accountId', '==', accountId).get();
      return snap.docs.map((d) => d.data()).sort((a, b) => a.createdAt - b.createdAt);
    },
    async getNote(id) {
      return data(await col('notes').doc(id).get());
    },
    async addNote(note) {
      await col('notes').doc(note.id).set(note);
    },
    async deleteNote(id) {
      await col('notes').doc(id).delete();
    },

    async addEvent(ev) {
      const ref = ev.accountId
        ? col('accounts').doc(ev.accountId).collection('events').doc(ev.id)
        : col('anon_events').doc(ev.id);
      await ref.set(ev);
    },
    async listEvents(accountId, limit) {
      const own = await col('accounts').doc(accountId).collection('events').orderBy('createdAt', 'desc').limit(limit).get();
      const anon = await col('anon_events').orderBy('createdAt', 'desc').limit(10).get();
      return [...own.docs, ...anon.docs].map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
  };
}

// ═══ 메모리(로컬 시험용) ═════════════════════════════════
function createMemoryDb() {
  const accounts = new Map();
  const passkeys = new Map();
  const challenges = new Map();
  const sessions = new Map();
  const notes = new Map();
  const events = [];
  const copy = (v) => (v ? structuredClone(v) : null);

  return {
    kind: 'memory',
    _dump: () => ({ accounts, passkeys, challenges, sessions, notes, events }), // 시험에서만 사용

    async countAccounts() {
      return accounts.size;
    },
    async getAccount(id) {
      return copy(accounts.get(id));
    },
    async createAccount({ account, passkey, notes: seed, maxAccounts }) {
      if (accounts.size >= maxAccounts) throw new Error('ACCOUNT_LIMIT');
      if ([...accounts.values()].some((a) => a.nameLower === account.nameLower)) throw new Error('NAME_TAKEN');
      if (passkeys.has(passkey.id)) throw new Error('PASSKEY_EXISTS');
      accounts.set(account.id, copy(account));
      passkeys.set(passkey.id, copy(passkey));
      for (const n of seed) notes.set(n.id, copy(n));
    },

    async getPasskey(id) {
      return copy(passkeys.get(id));
    },
    async listPasskeys(accountId) {
      return [...passkeys.values()].filter((p) => p.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt).map(copy);
    },
    async addPasskey(passkey) {
      if (passkeys.has(passkey.id)) throw new Error('PASSKEY_EXISTS');
      passkeys.set(passkey.id, copy(passkey));
    },
    async updatePasskeyUse(id, counter, lastUsedAt) {
      Object.assign(passkeys.get(id), { counter, lastUsedAt });
    },
    async deletePasskey(id) {
      passkeys.delete(id);
    },

    async putChallenge(rec) {
      challenges.set(sha256Hex(rec.challenge), copy(rec));
    },
    async takeChallenge(challenge) {
      const key = sha256Hex(challenge);
      const rec = challenges.get(key);
      challenges.delete(key);
      return copy(rec);
    },

    async createSession(hash, rec) {
      sessions.set(hash, copy(rec));
    },
    async getSession(hash) {
      return copy(sessions.get(hash));
    },
    async deleteSession(hash) {
      sessions.delete(hash);
    },
    async deleteSessionsByCredential(credentialId) {
      for (const [k, s] of sessions) if (s.credentialId === credentialId) sessions.delete(k);
    },

    async listNotes(accountId) {
      return [...notes.values()].filter((n) => n.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt).map(copy);
    },
    async getNote(id) {
      return copy(notes.get(id));
    },
    async addNote(note) {
      notes.set(note.id, copy(note));
    },
    async deleteNote(id) {
      notes.delete(id);
    },

    async addEvent(ev) {
      events.push(copy(ev));
    },
    async listEvents(accountId, limit) {
      const own = events.filter((e) => e.accountId === accountId);
      const anon = events.filter((e) => !e.accountId).slice(-10);
      return [...own, ...anon].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(copy);
    },
  };
}
