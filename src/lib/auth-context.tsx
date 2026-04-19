'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface UserInfo {
  userId: number;
  nickname: string;
  points: number;
  totalGames: number;
  wins: number;
}

interface AuthContextType {
  user: UserInfo | null;
  loading: boolean;
  token: string | null;
  login: (nickname: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (nickname: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  deductPoints: (amount: number) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 从 localStorage 恢复登录状态
  useEffect(() => {
    const savedToken = localStorage.getItem('letsgo_token');
    const savedUser = localStorage.getItem('letsgo_user');
    if (savedToken && savedUser) {
      try {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
      } catch {
        localStorage.removeItem('letsgo_token');
        localStorage.removeItem('letsgo_user');
      }
    }
    setLoading(false);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const userInfo: UserInfo = {
          userId: data.user.id,
          nickname: data.user.nickname,
          points: data.user.points,
          totalGames: data.user.total_games,
          wins: data.user.wins,
        };
        setUser(userInfo);
        localStorage.setItem('letsgo_user', JSON.stringify(userInfo));
      } else {
        // Token 过期或无效
        logout();
      }
    } catch {
      // 网络错误，保持当前状态
    }
  }, [token]);

  // 定期刷新用户信息（积分可能变化）
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(refreshUser, 30000); // 每30秒刷新
    return () => clearInterval(interval);
  }, [token, refreshUser]);

  const login = async (nickname: string, password: string) => {
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
      };
      setUser(userInfo);
      localStorage.setItem('letsgo_token', data.token);
      localStorage.setItem('letsgo_user', JSON.stringify(userInfo));
      return { success: true };
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
      };
      setUser(userInfo);
      localStorage.setItem('letsgo_token', data.token);
      localStorage.setItem('letsgo_user', JSON.stringify(userInfo));
      return { success: true };
    } catch {
      return { success: false, error: '网络错误' };
    }
  };

  // eslint-disable-next-line react-hooks/immutability
  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('letsgo_token');
    localStorage.removeItem('letsgo_user');
  }, []);

  const deductPoints = useCallback((amount: number) => { // eslint-disable-line react-hooks/immutability
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
