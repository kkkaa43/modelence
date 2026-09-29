import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { referencedAssets, verify } from './verify';

/*
  These run the real thing: the copy, the build commands and
  @modelence/runtime as a child process, against tiny projects without
  dependencies so no install is needed.
*/

let dir: string;
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'modelence-verify-test-'));
  logged = [];
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logged.push(String(line));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function project(files: Record<string, string>, spec: object) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await writeFile(join(dir, 'modelence.config.json'), JSON.stringify(spec));
}

function api(start: string, extra: Record<string, unknown> = {}) {
  return {
    resources: {
      api: {
        type: 'service',
        image: `node-${process.versions.node.split('.')[0]}-slim`,
        build: { commands: [] },
        start: { commands: [start] },
        ...extra,
      },
    },
  };
}

const server = (listen: string) =>
  `require('http').createServer((q, s) => s.end('<h1>ok</h1>')).listen(${listen});`;

function output() {
  return logged.join('\n');
}

describe('verify', () => {
  it('passes an app that listens on PORT', async () => {
    await project({ 'server.js': server('Number(process.env.PORT)') }, api('node server.js'));
    expect(await verify({ timeout: '10' })).toBe(true);
    expect(output()).toContain('GET / -> 200');
    expect(output()).toContain('modelence.config.json verified');
  }, 20_000);

  it('fails an app that ignores PORT', async () => {
    await project({ 'server.js': server('0') }, api('node server.js'));
    expect(await verify({ timeout: '2' })).toBe(false);
    expect(output()).toMatch(/Nothing answered on PORT \d+ within 2s/);
  }, 20_000);

  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal);
  it.skipIf(!address)(
    'fails an app that only listens on the loopback interface',
    async () => {
      await project(
        { 'server.js': server("Number(process.env.PORT), '127.0.0.1'") },
        api('node server.js')
      );
      expect(await verify({ timeout: '10' })).toBe(false);
      expect(output()).toContain('answers on 127.0.0.1 but not on');
    },
    20_000
  );

  it('builds from the uploaded files only, without local .env files', async () => {
    await project(
      {
        '.env': 'API_KEY=local',
        'server.js':
          "if (!require('fs').existsSync('.env')) { console.error('no .env'); process.exit(3); }\n" +
          server('Number(process.env.PORT)'),
      },
      api('node server.js')
    );
    expect(await verify({ timeout: '10' })).toBe(false);
    expect(output()).toContain('Not uploaded, so not used here either: .env');
    expect(output()).toMatch(/The app exited \(3\) before answering on PORT/);
  }, 20_000);

  it('passes environment variables declared in the file, and only those', async () => {
    vi.stubEnv('FROM_SHELL', 'leaked');
    vi.stubEnv('DECLARED_ONLY', 'from-shell');
    await project(
      {
        'server.js':
          "if (process.env.FROM_SHELL || process.env.GREETING !== 'hi' || process.env.DECLARED_ONLY !== 'from-shell') process.exit(4);\n" +
          server('Number(process.env.PORT)'),
      },
      { ...api('node server.js'), env: { GREETING: { value: 'hi' }, DECLARED_ONLY: {} } }
    );
    expect(await verify({ timeout: '10' })).toBe(true);
    vi.unstubAllEnvs();
  }, 20_000);

  it('serves a static site with single-page app fallback and checks its assets', async () => {
    const spec = {
      resources: {
        web: {
          type: 'service',
          image: `node-${process.versions.node.split('.')[0]}-slim`,
          build: {
            commands: ['mkdir -p dist/assets && cp index.html dist/ && cp app.js dist/assets/'],
          },
          static: [{ path: '/', dir: 'dist' }],
        },
      },
    };
    await project(
      {
        'index.html': '<script type="module" src="/assets/app.js"></script>',
        'app.js': 'console.log(1)',
      },
      spec
    );
    expect(await verify({ timeout: '10' })).toBe(true);
    expect(output()).toContain('single-page app fallback');
    expect(output()).toContain('The 1 scripts and stylesheets / loads answer');

    // The same site with its assets built somewhere the mount does not serve.
    spec.resources.web.build.commands = ['mkdir -p dist && cp index.html dist/'];
    await writeFile(join(dir, 'modelence.config.json'), JSON.stringify(spec));
    logged = [];
    expect(await verify({ timeout: '10' })).toBe(false);
    expect(output()).toContain('1 of the 1 scripts and stylesheets GET / loads do not answer');
  }, 30_000);

  it('fails when a build command fails or a static directory is missing', async () => {
    await project({}, api('node server.js', { build: { commands: ['exit 7'] } }));
    expect(await verify({})).toBe(false);
    expect(output()).toContain('Build command "exit 7" exited with code 7.');

    await project(
      {},
      {
        resources: {
          web: { type: 'service', build: { commands: [] }, static: [{ path: '/', dir: 'dist' }] },
        },
      }
    );
    logged = [];
    expect(await verify({})).toBe(false);
    expect(output()).toContain('Static directory "dist" does not exist after the build.');
  }, 20_000);

  it('stops before building when the file has errors', async () => {
    await project({}, api('npx nodemon server.js', { build: { commands: ['pnpm install'] } }));
    expect(await verify({})).toBe(false);
    expect(output()).toContain('runs pnpm, but only npm is preinstalled');
    expect(output()).toContain('runs nodemon');
    expect(output()).not.toContain('Building');
  });
});

describe('referencedAssets', () => {
  it('lists same-origin scripts and stylesheets', () => {
    const html = `
      <link rel="stylesheet" href="/assets/index-1.css">
      <link rel="icon" href="/favicon.svg">
      <script type="module" crossorigin src="/assets/index-2.js?v=1"></script>
      <script src="https://cdn.example.com/lib.js"></script>
      <script src="//cdn.example.com/other.js"></script>`;
    expect(referencedAssets(html)).toEqual(['/assets/index-1.css', '/assets/index-2.js']);
  });
});
