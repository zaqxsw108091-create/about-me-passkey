// 서버 공통 도구: 설정, 응답 보내기, 쿠키, 로그, 토큰 가리기
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ─── 설정 ────────────────────────────────────────────────
// 패스키는 "주소(도메인)"에 묶입니다. 그래서 ORIGIN / RP_ID를 한 곳에서만 정합니다.
// Vercel에서는 환경변수를 안 넣어도 프로젝트의 대표 주소(VERCEL_PROJECT_PRODUCTION_URL)를 씁니다.
export function getConfig() {
  const prodUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const origin = process.env.ORIGIN || (prodUrl ? `https://${prodUrl}` : 'http://localhost:3000');
  const rpID = process.env.RP_ID || new URL(origin).hostname;
  return {
    origin,
    rpID,
    rpName: process.env.RP_NAME || '윤대영 소개',
    secureCookie: origin.startsWith('https://'),
    maxAccounts: Number(process.env.MAX_ACCOUNTS || 2), // 계정은 최대 2개
    maxPasskeys: 5, // 계정당 패스키 최대 개수
    maxNotes: 30, // 계정당 메모 최대 개수
    inviteCode: process.env.INVITE_CODE || '', // 비어 있으면 초대 코드 없이 계정 생성 가능
    sessionMs: 12 * 60 * 60 * 1000, // 로그인 유지 12시간
    challengeMs: 5 * 60 * 1000, // 챌린지 유효 5분 (한 번 쓰면 바로 삭제)
  };
}

// ─── 오류 ────────────────────────────────────────────────
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// ─── 응답 ────────────────────────────────────────────────
export function sendJson(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

// Vercel은 JSON 본문을 미리 읽어 req.body에 넣어 줍니다. 로컬 서버에서는 직접 읽습니다.
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) throw new HttpError(413, 'TOO_LARGE', '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// ─── 쿠키(로그인 표식) ───────────────────────────────────
export function cookieName(cfg) {
  return cfg.secureCookie ? '__Host-sid' : 'sid'; // __Host- 접두사는 https에서만 쓸 수 있음
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export function setSessionCookie(res, cfg, token) {
  const parts = [
    `${cookieName(cfg)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly', // 자바스크립트가 못 읽음
    'SameSite=Strict', // 다른 사이트에서 보낸 요청에는 안 붙음
    `Max-Age=${Math.floor(cfg.sessionMs / 1000)}`,
  ];
  if (cfg.secureCookie) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res, cfg) {
  const parts = [`${cookieName(cfg)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (cfg.secureCookie) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ─── 토큰·해시·비교 ──────────────────────────────────────
export function newToken() {
  return randomBytes(32).toString('base64url');
}
export function newId() {
  return randomBytes(16).toString('base64url');
}
export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

// 로그에는 토큰 전체를 절대 남기지 않습니다. 앞 4글자만 보이게 가립니다.
export function maskToken(token) {
  if (!token) return '(없음)';
  return `${String(token).slice(0, 4)}****`;
}

// 서버 로그(Vercel Logs에서 볼 수 있음) — 한 줄짜리 JSON
export function log(type, fields = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), type, ...fields }));
}

// ─── 입력 정리 ───────────────────────────────────────────
// 이름 같은 짧은 글: 문자열인지, 길이, 제어문자 제거
export function cleanText(value, max, { min = 0 } = {}) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (text.length < min || text.length > max) return '';
  return text;
}
