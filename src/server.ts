import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '5001', 10);

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
  server.once('error', err => {
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${
        dev ? 'development' : process.env.COZE_PROJECT_ENV
      }`,
    );

    // 预热KataGo引擎：后台加载模型，避免首个用户请求冷启动
    import('@/app/api/go-engine/route').then(goEngine => {
      goEngine.warmupKataGo().catch((err: unknown) => {
        console.error('[server] KataGo warmup error:', err instanceof Error ? err.message : String(err));
      });
    });

    // 启动AI测试Worker（常驻后台对弈）
    if (process.env.ENABLE_AI_TEST_WORKER !== 'false') {
      import('@/lib/ai-test-worker').then(worker => {
        worker.start().catch((err: unknown) => {
          console.error('[server] Failed to start ai-test worker:', err instanceof Error ? err.message : String(err));
        });
      });
    }
  });
});
