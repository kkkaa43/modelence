import { APP_SPEC_FILE_NAME, type AppResource, type AppSpec } from './appSpec';

/*
  The checks `modelence verify` makes on modelence.config.json before running
  anything: mistakes the Deploy Setup guide warns about that a local build
  would not surface (only npm is in the image, development servers, secrets
  with a literal value) or that would only show up once the app is running
  in the cloud. Each finding names the fix; errors fail the verification,
  warnings are printed and let it pass.
*/

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  message: string;
}

export interface CheckContext {
  // Major version of the Node.js running the verification.
  localNodeMajor: number;
  // The resource root's package.json scripts, to look through `npm start`.
  scripts: Record<string, string>;
}

const IMAGE_PATTERN = /^node-(\d+)(?:\.\d+\.\d+)?-[a-z0-9]+$/;
const MIN_NODE_MAJOR = 18;

// Development servers and watchers: fine locally, wrong as a production process.
const DEV_SERVER_PATTERNS: [RegExp, string][] = [
  [/^vite(?:\s+(?:dev|serve)\b|\s+-|\s*$)/, 'vite (the development server)'],
  [/^vite\s+preview\b/, 'vite preview'],
  [/^next\s+dev\b/, 'next dev'],
  [/^nodemon\b/, 'nodemon'],
  [/^ts-node-dev\b/, 'ts-node-dev'],
  [/^tsx\s+watch\b/, 'tsx watch'],
  [/^react-scripts\s+start\b/, 'react-scripts start'],
  [/^(?:nuxt|nuxi|astro|remix)\s+dev\b/, 'a framework development server'],
  [/^node\b.*\s--watch\b/, 'node --watch'],
];

const MIGRATION_PATTERN =
  /\b(?:prisma\s+migrate|prisma\s+db\s+push|knex\s+migrate|sequelize\s+db:migrate|typeorm\s+migration:run|migrate-mongo\s+up|db:migrate)\b/;

const PACKAGE_RUNNERS = /^(?:npx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bunx)\s+(?:--yes\s+|-y\s+)?/;
const SCRIPT_RUN = /^(?:npm|pnpm|yarn)\s+(?:run\s+|run-script\s+)?([\w:.-]+)\s*$/;

const INLINED_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'REACT_APP_', 'PUBLIC_', 'EXPO_PUBLIC_'];

export function checkSpec(spec: AppSpec, context: CheckContext): Finding[] {
  const findings: Finding[] = [];
  const error = (message: string) => findings.push({ severity: 'error', message });
  const warning = (message: string) => findings.push({ severity: 'warning', message });

  const resources = Object.entries(spec.resources ?? {});
  if (resources.length === 0) {
    error(`${APP_SPEC_FILE_NAME} has no resources; describe the app as one entry of "resources".`);
  } else if (resources.length > 1) {
    error(
      `${APP_SPEC_FILE_NAME} has ${resources.length} resources; exactly one is supported today.`
    );
  }
  for (const [name, resource] of resources) {
    checkResource(name, resource, context, error, warning);
  }
  checkEnv(spec, error, warning);
  return findings;
}

function checkResource(
  name: string,
  resource: AppResource,
  context: CheckContext,
  error: (message: string) => void,
  warning: (message: string) => void
): void {
  const at = `resources.${name}`;
  if (resource.type !== 'service') {
    error(`"${at}.type" must be "service".`);
  }

  const image = resource.image ?? 'node-22-slim';
  const imageMatch = IMAGE_PATTERN.exec(image);
  if (!imageMatch) {
    error(`"${at}.image" is "${image}"; expected node-<version>-<variant>, e.g. "node-22-slim".`);
  } else {
    const major = Number(imageMatch[1]);
    if (major < MIN_NODE_MAJOR) {
      error(
        `"${at}.image" uses Node.js ${major}; Modelence Cloud needs ${MIN_NODE_MAJOR} or newer.`
      );
    } else if (major !== context.localNodeMajor) {
      warning(
        `The cloud image runs Node.js ${major}, but this verification ran on Node.js ${context.localNodeMajor}. ` +
          `A difference between them will not show up here.`
      );
    }
  }

  const build = resource.build?.commands ?? ['npm install'];
  const start = resource.start?.commands ?? [];
  const statics = resource.static ?? [];

  if (start.length === 0 && statics.length === 0) {
    error(
      `"${at}" has neither start commands nor static directories, so there is nothing to serve.`
    );
  }

  const usesCorepack = build.some((command) => /\bcorepack\s+enable\b/.test(command));
  for (const command of build) {
    for (const segment of segmentsOf(command)) {
      const manager = /^(pnpm|yarn)\b/.exec(segment)?.[1];
      if (manager && !usesCorepack) {
        error(
          `Build command "${command}" runs ${manager}, but only npm is preinstalled in the image. ` +
            `Run "corepack enable" first, e.g. "corepack enable && ${segment}".`
        );
      }
    }
  }

  for (const command of start) {
    for (const segment of segmentsOf(command)) {
      const devServer = findDevServer(segment, context.scripts);
      if (devServer) {
        error(
          `Start command "${command}" runs ${devServer}. Use a production start instead ` +
            `(for example "node dist/server.js" or "next start"), or serve the build output as a static directory.`
        );
      }
      if (MIGRATION_PATTERN.test(expandScript(segment, context.scripts))) {
        warning(
          `Start command "${command}" looks like it runs database migrations. Every container runs the ` +
            `start commands, several at once during a rollout; run migrations against the database before deploying instead.`
        );
      }
    }
  }

  for (const [index, mount] of statics.entries()) {
    const mountAt = `${at}.static.${index}`;
    if (typeof mount?.path !== 'string' || !mount.path.startsWith('/')) {
      error(`"${mountAt}.path" must be an absolute URL prefix such as "/" or "/docs".`);
    }
    if (
      typeof mount?.dir !== 'string' ||
      mount.dir.startsWith('/') ||
      mount.dir.split(/[\\/]/).includes('..')
    ) {
      error(`"${mountAt}.dir" must be a directory inside the resource root, such as "dist".`);
    }
  }
}

function checkEnv(
  spec: AppSpec,
  error: (message: string) => void,
  warning: (message: string) => void
): void {
  for (const [name, declaration] of Object.entries(spec.env ?? {})) {
    const at = `env.${name}`;
    if (name === 'PORT' || name.startsWith('MODELENCE_')) {
      error(`"${at}": PORT and names starting with MODELENCE_ are reserved by the platform.`);
    }
    if (declaration?.type === 'secret' && declaration.value !== undefined) {
      error(
        `"${at}" is a secret with a value committed in ${APP_SPEC_FILE_NAME}. ` +
          `Remove the value and set it in the dashboard under Environment variables.`
      );
    }
    const scopes = declaration?.scopes ?? ['runtime'];
    if (INLINED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !scopes.includes('build')) {
      warning(
        `"${at}" looks like a variable a bundler inlines while building, but it is not scoped to the build. ` +
          `Add "scopes": ["build", "runtime"] or the built frontend will not see it.`
      );
    }
  }
}

// The simple commands inside a shell line: `cd web && npm ci; npm run build`.
export function segmentsOf(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
    .filter((segment) => segment.length > 0);
}

// `npm start` is only as good as the script it runs, so one level of package
// scripts is looked through.
function expandScript(segment: string, scripts: Record<string, string>): string {
  const script = SCRIPT_RUN.exec(segment)?.[1];
  return script && scripts[script] ? scripts[script] : segment;
}

export function findDevServer(segment: string, scripts: Record<string, string>): string | null {
  const script = SCRIPT_RUN.exec(segment)?.[1];
  const candidates =
    script && scripts[script]
      ? segmentsOf(scripts[script]).map((inner) => ({ inner, via: `the "${script}" script` }))
      : [{ inner: segment, via: null }];
  for (const { inner, via } of candidates) {
    const bare = inner.replace(PACKAGE_RUNNERS, '');
    for (const [pattern, label] of DEV_SERVER_PATTERNS) {
      if (pattern.test(bare)) {
        return via ? `${label} through ${via} ("${scripts[script!]}")` : label;
      }
    }
  }
  return null;
}
