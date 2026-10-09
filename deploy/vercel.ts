/** Vercel function entry: adapts Node's req/res to the fetch-style handler in src/app.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, createHttpHandler } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { connect } from '../src/database.ts';

let handler: Promise<(request: Request) => Promise<Response>> | undefined;

async function init() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('Environment variable DATABASE_URL is required');
  if (!config.cronSecret) throw new Error('Environment variable CRON_SECRET is required');
  const app = createApp(config, { query: await connect(config.databaseUrl) });
  return createHttpHandler(app, config.cronSecret);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
  return new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse) {
  try {
    const handle = await (handler ??= init().catch((error: unknown) => {
      handler = undefined;
      throw error;
    }));
    const response = await handle(await toRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal Server Error');
  }
}
