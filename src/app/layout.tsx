import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '小围棋乐园 - AI围棋对弈与教学',
    template: '%s | 小围棋乐园',
  },
  description:
    '专为儿童设计的围棋AI对弈与教学平台，通过有趣的AI互动学习围棋，体验快乐下棋的乐趣。',
  keywords: [
    '围棋',
    '儿童围棋',
    '围棋学习',
    '围棋AI',
    '围棋对弈',
    '围棋教学',
    '围棋入门',
  ],
  // icons: {
  //   icon: '',
  // },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        <AuthProvider>
          {children}
          <Toaster />
        </AuthProvider>
      </body>
    </html>
  );
}
