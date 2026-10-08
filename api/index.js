// 모든 /api/* 요청이 들어오는 입구 (Vercel 함수 1개)
// 하는 일: 길 찾기(어느 함수로 보낼지) → 출처(Origin) 확인 → 실행 → 오류를 JSON으로 변환
import { HttpError, getConfig, sendJson, readJsonBody, log } from '../server/http.js';
import { getDb } from '../server/db.js';
import * as auth from '../server/auth.js';
import * as priv from '../server/private.js';

// [방식, 경로] → 실행할 함수.  :id 부분은 두 번째 인자로 넘어간다.
const routes = [
  ['GET', '/api/session', auth.sessionInfo],
  ['POST', '/api/register/options', auth.registerOptions],
  ['POST', '/api/register/verify', auth.registerVerify],
  ['POST', '/api/login/options', auth.loginOptions],
  ['POST', '/api/login/verify', auth.loginVerify],
  ['POST', '/api/logout', auth.logout],
  ['GET', '/api/notes', priv.listNotes],
  ['POST', '/api/notes', priv.addNote],
  ['GET', '/api/notes/:id', priv.getNote],
  ['DELETE', '/api/notes/:id', priv.deleteNote],
  ['GET', '/api/passkeys', priv.listPasskeys],
  ['DELETE', '/api/passkeys/:id', priv.deletePasskey],
  ['GET', '/api/events', priv.listEvents],
];

function match(method, pathname) {
  let pathKnown = false;
  for (const [m, pattern, fn] of routes) {
    const a = pattern.split('/');
    const b = pathname.split('/');
    if (a.length !== b.length) continue;
    let id;
    const ok = a.every((part, i) => {
      if (part === ':id') {
        id = decodeURIComponent(b[i]);
        return id.length > 0 && id.length < 300;
      }
      return part === b[i];
    });
    if (!ok) continue;
    pathKnown = true;
    if (m === method) return { fn, id };
  }
  return { pathKnown };
}

export default async function handler(req, res) {
  try {
    const cfg = getConfig();
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const hit = match(req.method, pathname);
    if (!hit.fn) throw new HttpError(hit.pathKnown ? 405 : 404, hit.pathKnown ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', '없는 주소입니다.');

    // 데이터를 바꾸는 요청(POST/DELETE)은 우리 사이트에서 보낸 것만 받는다
    if (req.method !== 'GET' && req.headers.origin !== cfg.origin) {
      throw new HttpError(403, 'BAD_ORIGIN', '허용되지 않은 출처입니다.');
    }

    const ctx = { req, res, cfg, db: getDb(), url, body: {}, _session: undefined };
    if (req.method === 'POST') {
      try {
        ctx.body = (await readJsonBody(req)) || {};
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, 'BAD_JSON', '요청 형식이 잘못되었습니다.');
      }
      if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new HttpError(400, 'BAD_JSON', '요청 형식이 잘못되었습니다.');
    }

    const result = await hit.fn(ctx, hit.id);
    sendJson(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message });
    log('server_error', { message: String(e && e.message ? e.message : e) });
    sendJson(res, 500, { error: 'SERVER_ERROR', message: '서버에서 오류가 났습니다.' });
  }
}
