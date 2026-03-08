import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import type FormaDB from './db.js';

// JWT 配置
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';
const REFRESH_TOKEN_EXPIRES_IN = '30d';

// Token 载荷接口
export interface TokenPayload {
  userId: string;
  email: string;
  type: 'access' | 'refresh';
}

// 用户信息接口
export interface UserInfo {
  id: string;
  name: string;
  email: string;
  avatar: string;
}

// 生成访问令牌
export function generateAccessToken(payload: Omit<TokenPayload, 'type'>): string {
  return jwt.sign(
    { ...payload, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// 生成刷新令牌
export function generateRefreshToken(payload: Omit<TokenPayload, 'type'>): string {
  return jwt.sign(
    { ...payload, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN }
  );
}

// 验证令牌
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

// 密码哈希
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
}

// 密码验证
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// JWT 认证中间件
export function createAuthMiddleware(db: FormaDB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未提供认证令牌' });
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    if (!payload || payload.type !== 'access') {
      return res.status(401).json({ error: '无效的认证令牌' });
    }

    // 检查用户是否存在
    const user = await db.getDb().get(
      'SELECT id, name, email, avatar FROM users WHERE id = ?',
      [payload.userId]
    );

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    // 将用户信息附加到请求对象
    (req as any).user = user;
    next();
  };
}

// 可选认证中间件（不强制要求登录）
export function createOptionalAuthMiddleware(db: FormaDB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = verifyToken(token);

      if (payload && payload.type === 'access') {
        const user = await db.getDb().get(
          'SELECT id, name, email, avatar FROM users WHERE id = ?',
          [payload.userId]
        );

        if (user) {
          (req as any).user = user;
        }
      }
    }

    next();
  };
}

// 保存刷新令牌到数据库
export async function saveRefreshToken(
  db: FormaDB,
  userId: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  await db.getDb().run(
    `INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [`rt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, userId, token, expiresAt.toISOString()]
  );
}

// 验证刷新令牌
export async function validateRefreshToken(
  db: FormaDB,
  token: string
): Promise<{ userId: string; email: string } | null> {
  const payload = verifyToken(token);
  
  if (!payload || payload.type !== 'refresh') {
    return null;
  }

  // 检查数据库中是否存在且未过期
  const stored = await db.getDb().get(
    `SELECT * FROM refresh_tokens 
     WHERE token = ? AND user_id = ? AND revoked = 0 AND expires_at > datetime('now')`,
    [token, payload.userId]
  );

  if (!stored) {
    return null;
  }

  return { userId: payload.userId, email: payload.email };
}

// 撤销刷新令牌
export async function revokeRefreshToken(db: FormaDB, token: string): Promise<void> {
  await db.getDb().run(
    'UPDATE refresh_tokens SET revoked = 1 WHERE token = ?',
    [token]
  );
}

// 撤销用户的所有刷新令牌
export async function revokeAllUserRefreshTokens(db: FormaDB, userId: string): Promise<void> {
  await db.getDb().run(
    'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?',
    [userId]
  );
}

// 生成令牌对
export function generateTokenPair(userId: string, email: string): {
  accessToken: string;
  refreshToken: string;
} {
  const accessToken = generateAccessToken({ userId, email });
  const refreshToken = generateRefreshToken({ userId, email });
  
  return { accessToken, refreshToken };
}
