import { spawn, type ChildProcess } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { createRequire } from 'module';
import { connect as netConnect, createServer } from 'net';
import { networkInterfaces, tmpdir } from 'os';
import { dirname, join } from 'path';
import { APP_SPEC_FILE_NAME, type AppResource, type AppSpec } from './appSpec';
import { prepareSpec } from './deploySpec';
import { checkSpec, type Finding } from './verifyChecks';
import { listSourceFiles } from './source';

/*
  `modelence verify`: a local rehearsal of what Modelence Cloud does with
  modelence.config.json, so a wrong file fails here in a minute instead of
  after an upload and a remote build.

    1. Checks the file for mistakes the Deploy Setup guide warns about
       (verifyChecks.ts).
    2. Copies the files `modelence deploy` would upload — git's file list,
       minus local .env files and credentials — into a temporary directory,
       so the build cannot lean on anything that never reaches the cloud.
    3. Runs the build commands there, with only the declared build variables.
    4. Starts the app through @modelence/runtime, the same entrypoint the
       cloud container runs, on a random PORT, and probes it: it must answer
       on PORT, on every interface, without a server error, and static
       mounts must fall back to index.html for client-side routes.

  What it cannot reproduce is the image itself: the local Node.js, operating
  system and preinstalled tools are used, and differences are warned about.
*/

export interface VerifyOptions {
  inPlace?: boolean;
  keep?: boolean;
  timeout?: string;
  mongodbUri?: string;
}

// Only what a fresh container would have besides the injected variables;
// anything else from the developer's shell would hide a missing declaration.
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SystemRoot',
];

const DEFAULT_TIMEOUT_SECONDS = 60;
const PROBE_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
// A path no app defines, to see the single-page app fallback answer.
const CLIENT_ROUTE_PROBE = 'modelence-verify/client-route';
const MAX_ASSET_PROBES = 10;

type Env = Record<string, string | undefined>;

export async function verify(options: VerifyOptions): Promise<boolean> {
  const cwd = process.cwd();
  const spec = await prepareSpec(cwd);
  const entries = Object.entries(spec.resources ?? {});
  const resource: AppResource | undefined = entries.length === 1 ? entries[0][1] : undefined;
  const root = resource?.root ?? '.';

  const findings = checkSpec(spec, {
    localNodeMajor: Number(process.versions.node.split('.')[0]),
    scripts: await readScripts(join(cwd, root)),
  });
  printFindings(findings);
  if (!resource || findings.some((finding) => finding.severity === 'error')) {
    return fail('Fix the errors above, then run `modelence verify` again.');
  }

  const declared = resolveDeclaredEnv(spec);
  const workDir = options.inPlace ? cwd : await copySource(cwd, root);
  try {
    return await rehearse(resource, join(workDir, root), declared, options, findings);
  } finally {
    if (!options.inPlace && !options.keep) {
      await fs.rm(dirname(workDir), { recursive: true, force: true });
    }
  }
}

async function rehearse(
  resource: AppResource,
  appRoot: string,
  declared: DeclaredEnv,
  options: VerifyOptions,
  findings: Finding[]
): Promise<boolean> {
  const buildCommands = resource.build?.commands ?? ['npm install'];
  const buildEnv = { ...baseEnv(), ...declared.build };
  step(
    `Building (${buildCommands.length === 0 ? 'no build step' : buildCommands.length + ' command(s)'})`
  );
  for (const command of buildCommands) {
    console.log(`$ ${command}`);
    const code = await runToCompletion(command, appRoot, buildEnv);
    if (code !== 0) {
      return fail(`Build command "${command}" exited with code ${code}.`);
    }
  }

  const statics = resource.static ?? [];
  for (const mount of statics) {
    if (!existsSync(join(appRoot, mount.dir))) {
      return fail(
        `Static directory "${mount.dir}" does not exist after the build. Check the build commands and "static".`
      );
    }
  }

  const start = resource.start?.commands ?? [];
  const port = await freePort();
  const appPort = await freePort();
  const timeoutSeconds = Number(options.timeout) || DEFAULT_TIMEOUT_SECONDS;
  const mongodbUri = options.mongodbUri ?? process.env.MONGODB_URI ?? process.env.MONGO_URL;
  const siteUrl = `http://localhost:${port}`;
  const runtimeEnv: Env = {
    ...baseEnv(),
    ...declared.runtime,
    PORT: String(port),
    MODELENCE_APP_PORT: String(appPort),
    MODELENCE_APP_START_TIMEOUT: String(timeoutSeconds),
    MODELENCE_WEB: JSON.stringify({
      // The cloud runs the start commands in order as one shell line.
      start: start.length > 0 ? start.join(' && ') : null,
      static: statics,
    }),
    SITE_URL: siteUrl,
    ROOT_URL: siteUrl,
    ...(mongodbUri ? { MONGODB_URI: mongodbUri, MONGO_URL: mongodbUri } : {}),
  };

  step(`Starting through @modelence/runtime on PORT=${port}`);
  if (!mongodbUri && start.length > 0) {
    console.log(
      'MONGODB_URI is not set: the cloud provides a database, this run does not. ' +
        'Pass --mongodb-uri if the app needs one to start.'
    );
  }
  const app = spawn(process.execPath, [runtimeBinPath()], {
    cwd: appRoot,
    env: runtimeEnv,
    stdio: 'inherit',
    detached: true,
  });
  const exited = exitOf(app);
  // The runtime has its own process group, so Ctrl+C does not reach it.
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    signalGroup(app, 'SIGTERM');
  };
  process.on('SIGINT', onInterrupt);

  try {
    const opened = await Promise.race([
      waitForPort(port, '127.0.0.1', timeoutSeconds * 1000),
      exited.then(() => false),
    ]);
    if (interrupted) {
      return fail('Interrupted.');
    }
    if (!opened) {
      if (app.exitCode !== null || app.signalCode !== null) {
        return fail(
          `The app exited (${app.exitCode ?? app.signalCode}) before answering on PORT ${port}. ` +
            'Its output is above.'
        );
      }
      return fail(
        `Nothing answered on PORT ${port} within ${timeoutSeconds}s. The server must listen on ` +
          'process.env.PORT; a hard-coded port never receives traffic in the cloud.'
      );
    }

    step('Probing');
    const problems = await probe(port, statics, start.length > 0 && statics.length === 0);
    findings.push(...problems);
    printFindings(problems);
    const errors = problems.filter((finding) => finding.severity === 'error');
    if (errors.length > 0) {
      return fail('Fix the errors above, then run `modelence verify` again.');
    }

    printSummary(findings, declared.missing);
    if (options.keep) {
      console.log(`\nStill running at ${siteUrl}. Press Ctrl+C to stop.`);
      await exited;
    }
    return true;
  } finally {
    process.off('SIGINT', onInterrupt);
    await stop(app, exited);
  }
}

async function probe(
  port: number,
  statics: { path: string; dir: string }[],
  checkInterfaces: boolean
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = await request(port, '/');
  if (home.status === null) {
    findings.push({ severity: 'error', message: `GET / failed: ${home.error}.` });
  } else if (home.status >= 500) {
    findings.push({
      severity: 'error',
      message: `GET / answered ${home.status}. Check the app's output above.`,
    });
  } else {
    console.log(`GET / -> ${home.status}`);
    findings.push(...(await probeAssets(port, home.body ?? '')));
  }

  // Without a router in front, the container's own address is what the
  // load balancer connects to, not the loopback interface.
  if (checkInterfaces) {
    const address = externalAddress();
    if (address && !(await waitForPort(port, address, 2000))) {
      findings.push({
        severity: 'error',
        message:
          `The app answers on 127.0.0.1 but not on ${address}. In the cloud, traffic arrives on the ` +
          `container's address: listen on all interfaces (leave out the host argument, or use "0.0.0.0").`,
      });
    }
  }

  for (const mount of statics) {
    const path = `${mount.path.replace(/\/$/, '')}/${CLIENT_ROUTE_PROBE}`;
    const result = await request(port, path);
    const html = result.contentType?.includes('text/html');
    if (result.status === 200 && html) {
      console.log(`GET ${path} -> 200 (single-page app fallback)`);
    } else {
      findings.push({
        severity: 'warning',
        message:
          `GET ${path} answered ${result.status ?? result.error}: a client-side route under "${mount.path}" ` +
          `would not load. Fine for a multi-page site; for a single-page app, check that "${mount.dir}" has an index.html.`,
      });
    }
  }
  return findings;
}

/*
  The scripts and stylesheets the home page loads from its own origin. A page
  that renders while its assets 404 is the usual sign of build output that is
  not where the server looks: Next.js standalone without .next/static, a
  bundler `base` that does not match the static mount's path.
*/
async function probeAssets(port: number, html: string): Promise<Finding[]> {
  const assets = referencedAssets(html).slice(0, MAX_ASSET_PROBES);
  const broken: string[] = [];
  for (const path of assets) {
    const result = await request(port, path);
    if (result.status === null || result.status >= 400) {
      broken.push(`${path} (${result.status ?? result.error})`);
    }
  }
  if (broken.length === 0) {
    if (assets.length > 0) {
      console.log(`The ${assets.length} scripts and stylesheets / loads answer`);
    }
    return [];
  }
  return [
    {
      severity: 'error',
      message:
        `${broken.length} of the ${assets.length} scripts and stylesheets GET / loads do not answer, e.g. ${broken[0]}. ` +
        'The page would load without them: check where the build writes its assets and what serves them.',
    },
  ];
}

export function referencedAssets(html: string): string[] {
  const paths = new Set<string>();
  const pattern = /<(?:script|link)\b[^>]*?\s(?:src|href)=["'](\/(?!\/)[^"'?#]+)[^"']*["']/gi;
  for (const match of html.matchAll(pattern)) {
    if (/\.(?:m?js|css)$/.test(match[1])) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

interface DeclaredEnv {
  build: Env;
  runtime: Env;
  // Declared without a value and not set in this shell: in the cloud they
  // come from the dashboard.
  missing: string[];
}

function resolveDeclaredEnv(spec: AppSpec): DeclaredEnv {
  const result: DeclaredEnv = { build: {}, runtime: {}, missing: [] };
  for (const [name, declaration] of Object.entries(spec.env ?? {})) {
    const value = declaration?.value ?? process.env[name];
    if (value === undefined) {
      result.missing.push(name);
      continue;
    }
    const scopes = declaration?.scopes ?? ['runtime'];
    if (scopes.includes('build')) {
      result.build[name] = value;
    }
    if (scopes.includes('runtime')) {
      result.runtime[name] = value;
    }
  }
  return result;
}

// Copies the upload's file list into a fresh directory and returns it.
async function copySource(cwd: string, root: string): Promise<string> {
  const listing = await listSourceFiles(cwd);
  const dir = join(await fs.mkdtemp(join(tmpdir(), 'modelence-verify-')), 'app');
  for (const file of listing.files) {
    await fs.mkdir(dirname(join(dir, file)), { recursive: true });
    await fs.copyFile(join(cwd, file), join(dir, file));
  }
  for (const link of listing.symlinks) {
    await fs.mkdir(dirname(join(dir, link.path)), { recursive: true });
    await fs.symlink(link.target, join(dir, link.path));
  }

  step(
    `Copied the ${listing.files.length + listing.symlinks.length} files \`modelence deploy\` uploads`
  );
  console.log(dir);
  // Ignored files are not in git's list at all, so look for them directly.
  const uploaded = new Set(listing.files);
  const localEnvFiles = [
    ...new Set([
      ...listing.excludedFiles.filter((file) => /(^|\/)\.env/.test(file)),
      ...(await localEnvFilesIn(cwd, root)).filter((file) => !uploaded.has(file)),
    ]),
  ];
  if (localEnvFiles.length > 0) {
    console.log(
      `Not uploaded, so not used here either: ${localEnvFiles.join(', ')}. ` +
        'Values the app reads from them must be declared in "env" and set in the dashboard.'
    );
  }
  for (const skipped of listing.skipped) {
    console.log(`Not uploaded: ${skipped.path} (${skipped.reason})`);
  }
  return dir;
}

async function localEnvFilesIn(cwd: string, root: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of new Set(['.', root])) {
    const names = await fs.readdir(join(cwd, dir)).catch(() => [] as string[]);
    for (const name of names) {
      if (/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name)) {
        found.push(dir === '.' ? name : `${dir.replace(/\/$/, '')}/${name}`);
      }
    }
  }
  return found;
}

async function readScripts(dir: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await fs.readFile(join(dir, 'package.json'), 'utf8'));
    return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function baseEnv(): Env {
  const env: Env = {};
  for (const name of PASSTHROUGH_ENV) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

function runToCompletion(command: string, cwd: string, env: Env): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on('error', () => resolve(127));
  });
}

// The installed @modelence/runtime's executable. Its exports only carry an
// `import` condition, so the package directory is found on the lookup path.
function runtimeBinPath(): string {
  const require = createRequire(import.meta.url);
  for (const base of require.resolve.paths('@modelence/runtime') ?? []) {
    const bin = join(base, '@modelence', 'runtime', 'dist', 'bin.js');
    if (existsSync(bin)) {
      return bin;
    }
  }
  throw new Error('@modelence/runtime is not installed; reinstall the modelence package.');
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
}

// Stops the runtime and everything it started, as a container stop would.
async function stop(child: ChildProcess, exited = exitOf(child)): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), STOP_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-(child.pid ?? 0), signal);
  } catch {
    // Already gone.
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(port, host);
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function waitForPort(port: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await canConnect(port, host))) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

function externalAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}

interface ProbeResult {
  status: number | null;
  contentType?: string | null;
  // Only for HTML answers, which the asset check reads.
  body?: string;
  error?: string;
}

// Asks like a browser navigation, which is what the single-page app fallback answers.
async function request(port: number, path: string): Promise<ProbeResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      return { status: response.status, contentType, body: await response.text() };
    }
    await response.body?.cancel();
    return { status: response.status, contentType };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function step(title: string): void {
  console.log(`\n▸ ${title}`);
}

function printFindings(findings: Finding[]): void {
  for (const finding of findings) {
    console.log(`${finding.severity === 'error' ? '✗' : '!'} ${finding.message}`);
  }
}

function printSummary(findings: Finding[], missingEnv: string[]): void {
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  console.log(
    `\n✓ ${APP_SPEC_FILE_NAME} verified: the app builds and answers on PORT through the Modelence runtime` +
      (warnings > 0 ? ` (${warnings} warning${warnings > 1 ? 's' : ''} above).` : '.')
  );
  if (missingEnv.length > 0) {
    console.log(
      `Declared but not set here, so the app ran without them: ${missingEnv.join(', ')}. ` +
        'Set them in the dashboard under Environment variables before deploying.'
    );
  }
  console.log('Next: run `modelence deploy`.');
}

function fail(reason: string): false {
  console.log(`\n✗ Verification failed.\n${reason}`);
  return false;
}
