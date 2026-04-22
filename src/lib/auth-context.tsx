'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface UserInfo {
  userId: number;
  nickname: string;
  points: number;
  totalGames: number;
  wins: number;
  isAdmin?: boolean;
}

interface AuthContextType {
  user: UserInfo | null;
  loading: boolean;
  token: string | null;
  login: (nickname: string, password: string) => Promise<{ success: boolean; error?: string; dailyBonusAwarded?: boolean; dailyBonusAmount?: number }>;
  register: (nickname: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  deductPoints: (amount: number) => void;
}

// 从 JWT token 中解析 payload（不验证签名，仅用于客户端一致性检查）
function parseTokenPayload(token: string): { userId?: number; nickname?: string; isAdmin?: boolean } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 从 localStorage 恢复登录状态，并验证 token-user 一致性
  useEffect(() => {
    const savedToken = localStorage.getItem('letsgo_token');
    const savedUserStr = localStorage.getItem('letsgo_user');
    if (savedToken && savedUserStr) {
      try {
        const savedUser = JSON.parse(savedUserStr) as UserInfo;
        const payload = parseTokenPayload(savedToken);

        // 一致性验证：token 中的 userId 必须与 savedUser 中的 userId 匹配
        if (payload && payload.userId !== undefined && payload.userId !== savedUser.userId) {
          console.error(
            `[auth] MISMATCH DETECTED: token.userId=${payload.userId} (${payload.nickname}) ` +
            `!= savedUser.userId=${savedUser.userId} (${savedUser.nickname}). Clearing auth state.`
          );
          localStorage.removeItem('letsgo_token');
          localStorage.removeItem('letsgo_user');
          setToken(null);
          setUser(null);
        } else {
          setToken(savedToken);
          setUser(savedUser);
          console.log(`[auth] Restored session: userId=${savedUser.userId}, nickname=${savedUser.nickname}`);
        }
      } catch (e) {
        console.error('[auth] Failed to restore session:', e);
        localStorage.removeItem('letsgo_token');
        localStorage.removeItem('letsgo_user');
      }
    }
    setLoading(false);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('letsgo_token');
    localStorage.removeItem('letsgo_user');
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    try {
      const payload = parseTokenPayload(token);
      console.log(`[auth] refreshUser: calling /api/auth/me, tokenUserId=${payload?.userId}, tokenNick=${payload?.nickname}`);
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`[auth] refreshUser: /api/auth/me returned userId=${data.user.id}, nickname=${data.user.nickname}, isAdmin=${data.user.isAdmin}`);
        const userInfo: UserInfo = {
          userId: data.user.id,
          nickname: data.user.nickname,
          points: data.user.points,
          totalGames: data.user.total_games,
          wins: data.user.wins,
          isAdmin: data.user.isAdmin,
        };
        // 如果返回的 userId 和 token 中的不一致，记录错误并登出
        if (payload && payload.userId !== undefined && payload.userId !== userInfo.userId) {
          console.error(`[auth] refreshUser MISMATCH: token says userId=${payload.userId} but API returned userId=${userInfo.userId}. Logging out.`);
          logout();
          return;
        }
        setUser(userInfo);
        localStorage.setItem('letsgo_user', JSON.stringify(userInfo));
      } else {
        const errData = await res.json().catch(() => ({ error: 'unknown' }));
        console.warn(`[auth] refreshUser: /api/auth/me failed with ${res.status}: ${errData.error}`);
        // Token 过期或无效
        logout();
      }
    } catch (e) {
      console.warn('[auth] refreshUser: network error', e);
      // 网络错误，保持当前状态
    }
  }, [token, logout]);

  // 定期刷新用户信息（积分可能变化）
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(refreshUser, 30000); // 每30秒刷新
    return () => clearInterval(interval);
  }, [token, refreshUser]);

  const login = async (nickname: string, password: string): Promise<{ success: boolean; error?: string; dailyBonusAwarded?: boolean; dailyBonusAmount?: number }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, password }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || '登录失败' };

      setToken(data.token);
      const userInfo: UserInfo = {
        userId: data.user.id,
        nickname: data.user.nickname,
        points: data.user.points,
        totalGames: data.user.total_games,
        wins: data.user.wins,
        isAdmin: data.user.isAdmin,
      };
      setUser(userInfo);
      localStorage.setItem('letsgo_token', data.token);
      localStorage.setItem('letsgo_user', JSON.stringify(userInfo));
      return {
        success: true,
        dailyBonusAwarded: data.dailyBonusAwarded || false,
        dailyBonusAmount: data.dailyBonusAmount || 0,
      };
    } catch {
      return { success: false, error: '网络错误' };
    }
  };

  const register = async (nickname: string, password: string) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, password }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || '注册失败' };

      setToken(data.token);
      const userInfo: UserInfo = {
        userId: data.user.id,
        nickname: data.user.nickname,
        points: data.user.points,
        totalGames: data.user.total_games,
        wins: data.user.wins,
        isAdmin: data.user.isAdmin,
      };
      setUser(userInfo);
      localStorage.setItem('letsgo_token', data.token);
      localStorage.setItem('letsgo_user', JSON.stringify(userInfo));
      return { success: true };
    } catch {
      return { success: false, error: '网络错误' };
    }
  };

  const deductPoints = useCallback((amount: number) => {
    setUser(prev => {
      if (!prev) return prev;
      const updated = { ...prev, points: Math.max(0, prev.points - amount) };
      localStorage.setItem('letsgo_user', JSON.stringify(updated));
      return updated;
    });
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, token, login, register, logout, refreshUser, deductPoints }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
