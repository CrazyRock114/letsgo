import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_EXPIRES_IN = '7d';

// JWT_SECRET 延迟验证：不在模块加载时检查（避免 Next.js build 阶段抛错），
// 在首次使用 JWT 的函数调用时检查。
let _jwtSecret: string | undefined;

function getJwtSecret(): string {
  if (!_jwtSecret) {
    _jwtSecret = process.env.JWT_SECRET;
    if (!_jwtSecret) {
      throw new Error('JWT_SECRET environment variable is required');
    }
  }
  return _jwtSecret;
}

export interface JWTPayload {
  userId: number;
  nickname: string;
  isAdmin: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as JWTPayload;
  } catch {
    return null;
  }
}

export function getUserFromAuthHeader(authHeader: string | null): JWTPayload | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}
