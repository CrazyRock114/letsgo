export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { start } = await import('@/lib/ai-test-worker');
    start().catch((err: unknown) => {
      console.error('[instrumentation] Failed to start ai-test worker:', err instanceof Error ? err.message : String(err));
    });
  }
}
