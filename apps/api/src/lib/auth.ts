import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import type { Role } from '@agenda/shared';

export interface TokenClaims {
  sub: string; // user id
  tid: string; // tenant id
  role: Role;
  /** Issued at (seconds), set when verifying */
  iat?: number;
}

const TOKEN_TTL = '7d';

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (min 32 chars)');
  return new TextEncoder().encode(s);
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export async function signToken(claims: TokenClaims): Promise<string> {
  return new SignJWT({ tid: claims.tid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret());
}

export async function verifyToken(token: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string') {
    throw new Error('invalid token claims');
  }
  return { sub: payload.sub, tid: payload.tid, role: payload.role as Role, iat: payload.iat };
}

/** Turns "Clínica Nutrición Sana" into "clinica-nutricion-sana". */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
