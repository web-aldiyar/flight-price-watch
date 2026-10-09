// Builds the bot into Vercel's Build Output API format (.vercel/output):
//   static/              a small landing page
//   functions/api.func   one Node.js function serving /api/*
// Runs as the Vercel build command (see vercel.json). Docs: https://vercel.com/docs/build-output-api
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = '.vercel/output';
const fn = `${out}/functions/api.func`;

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });
mkdirSync(`${out}/static`, { recursive: true });

await build({
  entryPoints: ['deploy/vercel.ts'],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Only used for local development without DATABASE_URL.
  external: ['@electric-sql/pglite'],
  // Lets bundled CommonJS dependencies call require() inside the ESM bundle.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify(
    { runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 },
    null,
    2,
  ),
);

writeFileSync(
  `${out}/static/index.html`,
  `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flight Price Watch</title>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
<h1>✈️ Flight Price Watch</h1>
<p>Telegram-бот, который следит за ценами на авиабилеты. Откройте бота в Telegram и отправьте <code>/start</code>.</p>
</body>
</html>
`,
);

writeFileSync(
  `${out}/config.json`,
  JSON.stringify({ version: 3, routes: [{ src: '^/api(?:/.*)?$', dest: '/api' }, { handle: 'filesystem' }] }, null, 2),
);

console.log(`Vercel output written to ${out}`);
