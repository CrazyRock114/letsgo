export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 1. 启动 AI test worker
    const { start } = await import('@/lib/ai-test-worker');
    start().catch((err: unknown) => {
      console.error('[instrumentation] Failed to start ai-test worker:', err instanceof Error ? err.message : String(err));
    });

    // 2. 后台预热 KataGo（不阻塞启动）
    const { warmupKataGo } = await import('@/app/api/go-engine/route');
    warmupKataGo().catch(() => {});
  }
}
