import { Hono } from 'hono';
import type { Env } from './types';
import { verifySignature } from './line';
import { handleEvent } from './commands';
import { api } from './api';
import { runCron } from './cron';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('badminton-line-bot ok'));

app.post('/webhook', async (c) => {
  const body = await c.req.text();
  const signature = c.req.header('x-line-signature') ?? '';
  if (!(await verifySignature(body, signature, c.env.LINE_CHANNEL_SECRET))) {
    return c.text('invalid signature', 401);
  }
  const { events = [] } = JSON.parse(body) as { events?: Parameters<typeof handleEvent>[1][] };
  // 先回 200 給 LINE，事件在背景處理
  c.executionCtx.waitUntil(
    Promise.all(events.map((ev) => handleEvent(c.env, ev).catch((e) => console.error('event failed', ev.type, e)))),
  );
  return c.text('ok');
});

app.route('/api', api);

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
