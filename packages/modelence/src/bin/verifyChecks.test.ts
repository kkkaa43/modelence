import { describe, expect, it } from 'vitest';
import type { AppSpec } from './appSpec';
import { checkSpec, findDevServer, segmentsOf, type CheckContext } from './verifyChecks';

const context: CheckContext = { localNodeMajor: 22, scripts: {} };

function service(resource: Record<string, unknown>, env?: AppSpec['env']): AppSpec {
  return { resources: { app: { type: 'service', ...resource } }, env };
}

function messages(spec: AppSpec, ctx = context) {
  return checkSpec(spec, ctx).map((finding) => `${finding.severity}: ${finding.message}`);
}

describe('checkSpec', () => {
  it('accepts the Express API example from the setup guide', () => {
    const spec = service({
      image: 'node-22-slim',
      build: { commands: ['npm ci'] },
      start: { commands: ['node server.js'] },
    });
    expect(checkSpec(spec, context)).toEqual([]);
  });

  it('requires exactly one resource', () => {
    expect(messages({ resources: {} })).toEqual([expect.stringMatching(/^error: .*no resources/)]);
    const two: AppSpec = {
      resources: {
        a: { type: 'service', start: { commands: ['node a.js'] } },
        b: { type: 'service', start: { commands: ['node b.js'] } },
      },
    };
    expect(messages(two)).toContainEqual(expect.stringMatching(/2 resources; exactly one/));
  });

  it('requires something to serve', () => {
    expect(messages(service({ build: { commands: [] } }))).toContainEqual(
      expect.stringMatching(/^error: .*neither start commands nor static/)
    );
  });

  it('checks the image and warns when it differs from the local Node.js', () => {
    const start = { commands: ['node .'] };
    expect(messages(service({ image: 'node22', start }))).toContainEqual(
      expect.stringMatching(/^error: .*node-<version>-<variant>/)
    );
    expect(messages(service({ image: 'node-16-slim', start }))).toContainEqual(
      expect.stringMatching(/^error: .*Node.js 16/)
    );
    expect(messages(service({ image: 'node-20.11.1-alpine', start }))).toEqual([
      expect.stringMatching(/^warning: The cloud image runs Node.js 20/),
    ]);
  });

  it('rejects pnpm and yarn unless corepack is enabled first', () => {
    const start = { commands: ['node .'] };
    expect(
      messages(service({ build: { commands: ['pnpm install --frozen-lockfile'] }, start }))
    ).toEqual([expect.stringMatching(/^error: .*runs pnpm, but only npm is preinstalled/)]);
    expect(
      checkSpec(
        service({ build: { commands: ['corepack enable && yarn install --immutable'] }, start }),
        context
      )
    ).toEqual([]);
  });

  it('rejects development servers, also behind a package script', () => {
    const scripts = { start: 'vite', serve: 'next start' };
    expect(
      messages(service({ start: { commands: ['npm start'] } }), { ...context, scripts })
    ).toEqual([expect.stringMatching(/^error: .*runs vite .*through the "start" script/)]);
    expect(
      checkSpec(service({ start: { commands: ['npm run serve'] } }), { ...context, scripts })
    ).toEqual([]);
    expect(messages(service({ start: { commands: ['npx nodemon server.js'] } }))).toEqual([
      expect.stringMatching(/^error: .*runs nodemon/),
    ]);
  });

  it('warns about migrations in the start commands', () => {
    const spec = service({
      start: { commands: ['npx prisma migrate deploy', 'node dist/server.js'] },
    });
    expect(messages(spec)).toEqual([expect.stringMatching(/^warning: .*database migrations/)]);
  });

  it('checks static mounts', () => {
    const spec = service({
      static: [
        { path: 'dist', dir: 'dist' },
        { path: '/', dir: '../outside' },
      ],
    });
    expect(messages(spec)).toEqual([
      expect.stringMatching(/static\.0\.path" must be an absolute URL prefix/),
      expect.stringMatching(/static\.1\.dir" must be a directory inside the resource root/),
    ]);
  });

  it('checks env declarations', () => {
    const spec = service(
      { start: { commands: ['node .'] } },
      {
        PORT: { value: '8080' },
        STRIPE_SECRET_KEY: { type: 'secret', value: 'sk_live_x' },
        VITE_API_URL: { value: '/api' },
        NEXT_PUBLIC_SITE: { value: 'x', scopes: ['build', 'runtime'] },
      }
    );
    expect(messages(spec)).toEqual([
      expect.stringMatching(/^error: "env.PORT": PORT and names starting with MODELENCE_/),
      expect.stringMatching(/^error: "env.STRIPE_SECRET_KEY" is a secret with a value/),
      expect.stringMatching(/^warning: "env.VITE_API_URL" .* not scoped to the build/),
    ]);
  });
});

describe('segmentsOf', () => {
  it('splits a shell line into simple commands without leading assignments', () => {
    expect(segmentsOf('cd web && NODE_ENV=production npm ci; npm run build | tee log')).toEqual([
      'cd web',
      'npm ci',
      'npm run build',
      'tee log',
    ]);
  });
});

describe('findDevServer', () => {
  it('tells production starts from development servers', () => {
    expect(findDevServer('vite build', {})).toBeNull();
    expect(findDevServer('next start', {})).toBeNull();
    expect(findDevServer('node --watch server.js', {})).toBe('node --watch');
    expect(findDevServer('vite preview --port 3000', {})).toBe('vite preview');
    expect(findDevServer('npm run dev', { dev: 'tsx watch src/index.ts' })).toMatch(/^tsx watch/);
  });
});
