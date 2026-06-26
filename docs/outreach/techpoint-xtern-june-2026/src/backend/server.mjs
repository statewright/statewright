import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboardData } from './etl.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const publicDir = join(root, 'public');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');

  try {
    if (url.pathname === '/api/summary') {
      const { summary } = await buildDashboardData();
      return sendJson(response, summary);
    }

    if (url.pathname === '/api/incidents') {
      const { incidents } = await buildDashboardData();
      return sendJson(response, incidents);
    }

    if (url.pathname === '/api/timeline') {
      const { timeline } = await buildDashboardData();
      return sendJson(response, timeline);
    }

    if (url.pathname === '/api/events') {
      const { events } = await buildDashboardData();
      return sendJson(response, events);
    }

    return await serveStatic(url.pathname, response);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error.message }));
  }
}

function sendJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'text/plain' });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    throw error;
  }
}

export function createApp() {
  return createServer(handleRequest);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4317);
  const host = process.env.HOST ?? '127.0.0.1';
  createApp().listen(port, host, () => {
    console.log(`Incident dashboard listening on http://${host}:${port}`);
  });
}
