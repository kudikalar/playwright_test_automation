/**
 * Sauce Labs configuration — the single source of truth for region, endpoints and the saucectl
 * run definition.
 *
 * Two vendor facts shape everything below:
 *
 *  1. **Playwright never connects to Sauce.** There is no `wsEndpoint` / `connectOptions` target
 *     for Sauce; the documented paths are saucectl (which bundles `rootDir`, uploads it and runs
 *     the specs on Sauce VMs) and the experimental Selenium Grid bridge over CDP. Sauce's own
 *     Playwright page still calls a native WebSocket integration something they "are actively
 *     developing", so any `wss://…saucelabs.com` endpoint found elsewhere is fabricated. The
 *     consequence for this framework: a run either happens on Sauce through saucectl, or it does
 *     not happen on Sauce at all — and linking a report back to Sauce is a REST lookup after the
 *     fact, never an in-process handle.
 *  2. **Hosts and credentials are per data centre.** An EU access key answers 401 against
 *     `api.us-west-1`, and the US UI host has no region segment at all
 *     (`app.saucelabs.com`, not `app.us-west-1.saucelabs.com`), so the naive
 *     `app.${region}.saucelabs.com` template silently produces a dead link. Region is therefore
 *     resolved once, here, and drives both the REST host and the `sauce.region` written into
 *     `.sauce/config.yml`.
 *
 * Credentials live in the environment only. Nothing in this module puts `SAUCE_USERNAME` or
 * `SAUCE_ACCESS_KEY` into a file, a URL or a log line — `.sauce/config.yml` deliberately contains
 * neither, because saucectl reads both straight from the environment.
 */

import { Buffer } from 'node:buffer';

/* ------------------------------------------------------------------ regions -- */

export type SauceRegion = 'us-west-1' | 'us-east-4' | 'eu-central-1';

export const SAUCE_REGIONS: readonly SauceRegion[] = ['us-west-1', 'us-east-4', 'eu-central-1'];

export interface SauceEndpoints {
  readonly region: SauceRegion;
  /** REST host. Basic auth, HTTPS only — plain HTTP is refused. */
  readonly apiBaseUrl: string;
  /**
   * Host of the human-facing job page (`<appBaseUrl>/tests/<jobId>`). Undefined where Sauce
   * documents the API host but not the UI host: we link nothing rather than guess a URL that
   * 404s in a report.
   */
  readonly appBaseUrl?: string;
  /** Selenium Grid / OnDemand hub, used only by the CDP bridge path. */
  readonly onDemandUrl?: string;
  /**
   * False for a data centre Sauce lists for `saucectl run --region` but not for `sauce.region`
   * in the Playwright YAML schema. Running Playwright there is undocumented, not merely untested.
   */
  readonly supportsPlaywright: boolean;
}

export const SAUCE_ENDPOINTS: Readonly<Record<SauceRegion, SauceEndpoints>> = {
  'eu-central-1': {
    region: 'eu-central-1',
    apiBaseUrl: 'https://api.eu-central-1.saucelabs.com',
    appBaseUrl: 'https://app.eu-central-1.saucelabs.com',
    onDemandUrl: 'https://ondemand.eu-central-1.saucelabs.com/wd/hub',
    supportsPlaywright: true,
  },
  'us-west-1': {
    region: 'us-west-1',
    apiBaseUrl: 'https://api.us-west-1.saucelabs.com',
    /* No region segment on the US UI host — this is the trap the template above would spring. */
    appBaseUrl: 'https://app.saucelabs.com',
    onDemandUrl: 'https://ondemand.us-west-1.saucelabs.com/wd/hub',
    supportsPlaywright: true,
  },
  'us-east-4': {
    region: 'us-east-4',
    apiBaseUrl: 'https://api.us-east-4.saucelabs.com',
    /* Data-centre docs list the API host only; the UI and OnDemand hosts stay unset on purpose. */
    supportsPlaywright: false,
  },
};

/**
 * Sauce's own default is `us-west-1`. This account lives in the EU, and because credentials are
 * per data centre a silent fallthrough to the US would surface as an unexplained 401 rather than
 * a configuration error, so the framework defaults to the EU DC and rejects anything unknown.
 */
export const DEFAULT_SAUCE_REGION: SauceRegion = 'eu-central-1';

/** Set both or the integration stays off; everything else has a documented fallback. */
export const SAUCE_REQUIRED_ENV_VARS: readonly string[] = ['SAUCE_USERNAME', 'SAUCE_ACCESS_KEY'];

/**
 * Resolves the data centre. Returns undefined — never a default — for a value that is set but
 * unrecognised, so a typo shows up as a configuration message instead of API calls against the
 * wrong continent.
 *
 * `SAUCE_REGION` is inferred as a saucectl input: it appears across the Sauce docs, but the
 * saucectl CLI reference documents only `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` and
 * `SAUCECTL_INSTALL_BINARY`. Hence {@link saucectlRunCommand} passes `--region` explicitly rather
 * than trusting environment pickup.
 */
export function resolveSauceRegion(
  raw: string | undefined = process.env['SAUCE_REGION'],
): SauceRegion | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return DEFAULT_SAUCE_REGION;
  return SAUCE_REGIONS.find((region) => region === value);
}

export function sauceEndpoints(region: SauceRegion = DEFAULT_SAUCE_REGION): SauceEndpoints {
  return SAUCE_ENDPOINTS[region];
}

/** Base URL of the Sauce REST API for a region, without a trailing slash. */
export function sauceApiBaseUrl(region: SauceRegion = DEFAULT_SAUCE_REGION): string {
  return SAUCE_ENDPOINTS[region].apiBaseUrl;
}

/**
 * The canonical job page. This is the only Sauce UI URL shape the docs define — there is no
 * documented build page — so a reporter links a job or links nothing.
 */
export function sauceJobPageUrl(region: SauceRegion, jobId: string): string | undefined {
  const appBaseUrl = SAUCE_ENDPOINTS[region].appBaseUrl;
  if (appBaseUrl === undefined || jobId.length === 0) return undefined;
  return `${appBaseUrl}/tests/${encodeURIComponent(jobId)}`;
}

/* -------------------------------------------------------------- credentials -- */

export interface SauceCredentials {
  readonly username: string;
  /** Never logged, never rendered, never interpolated into a URL. */
  readonly accessKey: string;
}

/** Reads credentials from the environment. Undefined when either half is missing. */
export function readSauceCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SauceCredentials | undefined {
  const username = env['SAUCE_USERNAME']?.trim();
  const accessKey = env['SAUCE_ACCESS_KEY']?.trim();
  if (!username || !accessKey) return undefined;
  return { username, accessKey };
}

/**
 * HTTP Basic header for the REST API. Kept as a function rather than a cached constant so the
 * key is never held longer than a request needs it, and so a test can swap the environment.
 */
export function sauceBasicAuthHeader(credentials: SauceCredentials): string {
  const encoded = Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString(
    'base64',
  );
  return `Basic ${encoded}`;
}

/**
 * One human-readable reason the Sauce integration cannot run, or undefined when it can. Shared by
 * {@link isSauceConfigured} and the notifier's `disabledReason()` so both say the same thing.
 */
export function sauceConfigurationProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const missing = SAUCE_REQUIRED_ENV_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    return `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set`;
  }
  if (resolveSauceRegion(env['SAUCE_REGION']) === undefined) {
    return `SAUCE_REGION is not a Sauce data centre (expected one of ${SAUCE_REGIONS.join(', ')})`;
  }
  return undefined;
}

export function isSauceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return sauceConfigurationProblem(env) === undefined;
}

/**
 * Framework-local, not a Sauce-defined variable: the value handed to `saucectl run --build`.
 * Grouping a CI run's jobs under one build name is the only reliable way to enumerate exactly
 * that run's jobs afterwards, which is why the notifier refuses to link anything without it.
 */
export function sauceBuildName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env['SAUCE_BUILD_NAME']?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Framework-local passthrough to `--tunnel-name`, needed only behind Sauce Connect Proxy. */
export function sauceTunnelName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env['SAUCE_TUNNEL_NAME']?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/* ------------------------------------------------- playwright version matrix -- */

export interface SaucePlaywrightRelease {
  readonly version: string;
  /** Node runtime baked into Sauce's image for that Playwright version. */
  readonly nodeVersion: string;
  /** ISO date after which Sauce stops running the version. */
  readonly endOfLife: string;
}

/**
 * Sauce runs a fixed list of Playwright versions; `playwright.version` must match one exactly.
 * Version skew is the classic failure here, and it is not only about the API surface: platform
 * coverage moves with the version (1.58.1+ dropped macOS 12/13 and added macOS 14/15, which need
 * `armRequired: true`; 1.60.0+ added macOS 26), so bumping the version can silently invalidate a
 * suite's `platformName`.
 */
export const SAUCE_PLAYWRIGHT_RELEASES: readonly SaucePlaywrightRelease[] = [
  { version: '1.61.1', nodeVersion: 'Node 24', endOfLife: '2027-07-09' },
  { version: '1.60.0', nodeVersion: 'Node 24', endOfLife: '2027-06-15' },
  { version: '1.58.2', nodeVersion: 'Node 22', endOfLife: '2027-03-25' },
  { version: '1.58.1', nodeVersion: 'Node 22', endOfLife: '2027-02-25' },
  { version: '1.57.0', nodeVersion: 'Node 22', endOfLife: '2027-01-23' },
  { version: '1.56.1', nodeVersion: 'Node 22', endOfLife: '2026-11-30' },
  { version: '1.55.1', nodeVersion: 'Node 22', endOfLife: '2026-10-03' },
];

export function isSaucePlaywrightVersionSupported(version: string): boolean {
  return SAUCE_PLAYWRIGHT_RELEASES.some((release) => release.version === version);
}

/**
 * Pinned, not `version: package.json`.
 *
 * `package.json` is the idiomatic value because it keeps local and cloud in lockstep — but only
 * when the locally pinned version is itself on Sauce's list, and this repo runs a newer
 * `@playwright/test` than Sauce supports. Reading it from package.json would therefore submit an
 * unsupported version and fail the whole run at upload time. Pinning the newest supported release
 * keeps the cloud run working; the local/cloud skew is real and is called out in the operator
 * notes so it is a decision rather than a surprise.
 */
export const SAUCECTL_PLAYWRIGHT_VERSION = '1.61.1';

/* ---------------------------------------------------------- saucectl schema -- */

/**
 * Suite-level browser knobs. `browserName` lives *here*, under `params` — not as a direct suite
 * field next to `platformName`. Putting it at suite level is accepted by YAML and then ignored,
 * which is the quietest way to run the wrong browser in the cloud.
 */
export interface SaucectlSuiteParams {
  readonly browserName: 'chromium' | 'firefox' | 'webkit' | 'chrome';
  /** Maps onto a `projects[].name` in playwright.config.ts. */
  readonly project?: string;
  readonly headless?: boolean;
  readonly slowMo?: number;
  readonly grep?: string;
  readonly grepInvert?: string;
}

export interface SaucectlSuite {
  readonly name: string;
  /** OS + version string, e.g. "Windows 11", "macOS 15". Valid values follow the Playwright version. */
  readonly platformName: string;
  readonly screenResolution?: string;
  /** Regular expressions, not globs. */
  readonly testMatch: readonly string[];
  /** Go duration string, e.g. "30m". */
  readonly timeout?: string;
  /** Required for macOS 14/15/26 (Apple Silicon) images. */
  readonly armRequired?: boolean;
  /** Mutually exclusive with {@link shard} — setting both is a config error. */
  readonly numShards?: number;
  readonly shard?: 'spec' | 'concurrency';
  /** Values are baked into the uploaded config, so never put a secret here. */
  readonly env?: Readonly<Record<string, string>>;
  readonly params: SaucectlSuiteParams;
}

export interface SaucectlSauceBlock {
  readonly region: SauceRegion;
  readonly concurrency: number;
  /** Sauce-side job retries, independent of Playwright's own `retries`. */
  readonly retries: number;
  readonly metadata?: { readonly tags: readonly string[] };
  readonly visibility?: 'public' | 'public restricted' | 'share' | 'team' | 'private';
}

export interface SaucectlPlaywrightBlock {
  /** Exact version from Sauce's supported list, or the literal "package.json". */
  readonly version: string;
  /** Relative to rootDir. */
  readonly configFile: string;
}

/**
 * npm packages installed on the Sauce VM before the run. `node_modules` is in `.sauceignore`, so
 * anything the config, fixtures or reporter import at load time — beyond Playwright itself, which
 * Sauce provides — must be listed here or every suite dies with "Cannot find module".
 */
export interface SaucectlNpmBlock {
  readonly packages: Readonly<Record<string, string>>;
}

export interface SaucectlArtifacts {
  readonly download: {
    readonly when: 'always' | 'never' | 'pass' | 'fail';
    readonly match: readonly string[];
    readonly directory: string;
  };
}

export interface SaucectlConfig {
  /** `v1alpha` is the only value the schema accepts. */
  readonly apiVersion: 'v1alpha';
  readonly kind: 'playwright';
  readonly sauce: SaucectlSauceBlock;
  readonly playwright: SaucectlPlaywrightBlock;
  /** Everything under here is zipped and uploaded — see the .sauceignore note in the banner. */
  readonly rootDir: string;
  readonly nodeVersion?: string;
  readonly npm?: SaucectlNpmBlock;
  readonly suites: readonly SaucectlSuite[];
  readonly artifacts?: SaucectlArtifacts;
  readonly reporters?: Readonly<Record<string, { readonly enabled: boolean }>>;
}

export const SAUCECTL_CONFIG_PATH = '.sauce/config.yml';

/**
 * The suites this framework runs in the cloud.
 *
 * Deliberate omissions:
 *  - **visual** — pixel baselines are captured on the developer's machine and a Sauce VM renders
 *    with different fonts and scaling, so every comparison would fail for reasons unrelated to the
 *    build. Visual runs stay local/CI.
 *  - **webkit** — see {@link SAUCECTL_WEBKIT_SUITE}: it needs a macOS image, which the pinned
 *    Playwright version restricts to Apple Silicon platforms behind a subscription entitlement.
 *  - **mobile/tablet emulation** — Playwright device emulation adds nothing on a Sauce VM that a
 *    local Chromium run does not already give, at cloud-minute cost.
 */
/** Suite name for `saucectl run --select-suite`, used by `npm run test:sauce:demoshop`. */
export const SAUCECTL_DEMOSHOP_SUITE = 'Demoshop Chromium - Windows 11';

const SAUCECTL_SUITES: readonly SaucectlSuite[] = [
  {
    name: 'API - Windows 11',
    platformName: 'Windows 11',
    screenResolution: '1440x900',
    testMatch: ['tests/api/.*\\.spec\\.ts$'],
    timeout: '30m',
    params: {
      /*
       * The api project never opens a page, but Sauce allocates a browser per job regardless;
       * naming chromium keeps the VM image predictable rather than leaving it to a default.
       */
      browserName: 'chromium',
      project: 'api',
    },
  },
  {
    name: 'UI Chromium - Windows 11',
    platformName: 'Windows 11',
    screenResolution: '1440x900',
    testMatch: ['tests/ui/.*\\.spec\\.ts$', 'tests/hybrid/.*\\.spec\\.ts$'],
    timeout: '30m',
    params: {
      browserName: 'chromium',
      project: 'chromium',
      /*
       * Sauce records the VM screen, so a headless browser produces an empty video and the job
       * page loses its main diagnostic. This overrides the framework's CI-based default.
       */
      headless: false,
    },
  },
  {
    name: 'UI Firefox - Windows 11',
    platformName: 'Windows 11',
    screenResolution: '1440x900',
    testMatch: ['tests/ui/.*\\.spec\\.ts$', 'tests/hybrid/.*\\.spec\\.ts$'],
    timeout: '30m',
    params: { browserName: 'firefox', project: 'firefox', headless: false },
  },
  {
    /*
     * The public Tricentis Demo Web Shop. Unlike the reference app it is reachable from a Sauce VM
     * without Sauce Connect, which makes it the suite to prove the cloud path end to end.
     * TEST_ENV is not a secret, so baking it into the uploaded config is safe.
     */
    name: SAUCECTL_DEMOSHOP_SUITE,
    platformName: 'Windows 11',
    screenResolution: '1440x900',
    testMatch: ['tests/demoshop/.*\\.spec\\.ts$'],
    timeout: '30m',
    env: { TEST_ENV: 'demoshop' },
    params: { browserName: 'chromium', project: 'demoshop', headless: false },
  },
];

/**
 * Runtime imports outside Playwright (config/environment.config.ts → dotenv; the api fixture,
 * which every spec loads through `@fixtures/index`, → ajv + ajv-formats). Versions track
 * package.json.
 */
const SAUCECTL_NPM_PACKAGES: Readonly<Record<string, string>> = {
  dotenv: '^17.2.3',
  ajv: '^8.17.1',
  'ajv-formats': '^3.0.1',
};

/**
 * Opt-in WebKit suite, kept out of the default config on purpose.
 *
 * WebKit needs a macOS image. The pinned Playwright version no longer offers macOS 12/13, and the
 * macOS 14+ images are Apple Silicon (`armRequired: true`) and gated behind an account
 * entitlement. Appending this suite on an account without that entitlement fails the run, so the
 * operator opts in knowingly instead of discovering it in CI.
 */
export const SAUCECTL_WEBKIT_SUITE: SaucectlSuite = {
  name: 'UI WebKit - macOS 15',
  platformName: 'macOS 15',
  screenResolution: '1440x900',
  testMatch: ['tests/ui/.*\\.spec\\.ts$', 'tests/hybrid/.*\\.spec\\.ts$'],
  timeout: '30m',
  armRequired: true,
  params: { browserName: 'webkit', project: 'webkit', headless: false },
};

/** The configuration serialised into {@link SAUCECTL_CONFIG_PATH}. */
export const SAUCECTL_CONFIG: SaucectlConfig = {
  apiVersion: 'v1alpha',
  kind: 'playwright',
  sauce: {
    region: DEFAULT_SAUCE_REGION,
    concurrency: 5,
    /* Playwright already retries inside the run; a Sauce-level retry would double-count results. */
    retries: 0,
    metadata: { tags: ['playwright', 'enterprise-framework'] },
  },
  playwright: {
    version: SAUCECTL_PLAYWRIGHT_VERSION,
    configFile: 'playwright.config.ts',
  },
  rootDir: './',
  npm: { packages: SAUCECTL_NPM_PACKAGES },
  suites: SAUCECTL_SUITES,
  artifacts: {
    download: {
      when: 'fail',
      match: ['*.mp4', '*.log', '*.xml', '*.json'],
      directory: './reports/sauce/',
    },
  },
  reporters: { junit: { enabled: true } },
};

/**
 * The command that matches this config. Region is passed explicitly because environment pickup of
 * `SAUCE_REGION` by saucectl is inferred rather than documented, and the documented default is the
 * US data centre. Credentials never appear: saucectl reads them from the environment itself.
 */
export function saucectlRunCommand(env: NodeJS.ProcessEnv = process.env): string {
  const region = resolveSauceRegion(env['SAUCE_REGION']) ?? DEFAULT_SAUCE_REGION;
  const parts = ['saucectl run', `--region ${region}`, `--config ${SAUCECTL_CONFIG_PATH}`];
  const build = sauceBuildName(env);
  if (build !== undefined) parts.push(`--build "${build}"`);
  const tunnel = sauceTunnelName(env);
  if (tunnel !== undefined) parts.push(`--tunnel-name "${tunnel}"`);
  return parts.join(' ');
}

/* ------------------------------------------------------------ yaml emitter -- */

const YAML_INDENT = '  ';

const SAUCECTL_YAML_BANNER = [
  '# saucectl configuration for the Playwright Enterprise Framework.',
  '#',
  '# GENERATED from src/integrations/sauce/SauceConfig.ts (SAUCECTL_CONFIG). Edit the TypeScript',
  '# object and re-emit with toSaucectlYaml() rather than hand-editing this file: the region here',
  '# and the region the REST lookups use must never drift apart.',
  '#',
  '# NO CREDENTIALS LIVE HERE. saucectl reads SAUCE_USERNAME and SAUCE_ACCESS_KEY from the',
  '# environment, and environment values take precedence over ~/.sauce/credentials.yml. Per-run',
  '# values (build name, tunnel, TEST_ENV) are passed as flags -- `--build`, `--tunnel-name`,',
  '# `--env KEY=value` -- because anything written into a suite here is uploaded with the bundle.',
  '#',
  '# rootDir is the whole repository, so .sauceignore MUST exclude .env, storage/auth and reports',
  '# before the first run; otherwise local secrets are shipped to the cloud.',
].join('\n');

/**
 * Escapes a string for a double-quoted YAML scalar.
 *
 * Control characters matter as much as the quote and the backslash: a raw newline inside a
 * double-quoted scalar is *folded to a space* on read rather than rejected, so a multi-line value
 * — a `grep` expression, a suite name pasted from a terminal — would reach Sauce silently altered.
 * Walking the code points keeps the escaping exhaustive without a control-character regex.
 */
function escapeYamlString(value: string): string {
  let escaped = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') escaped += '\\\\';
    else if (char === '"') escaped += '\\"';
    else if (char === '\n') escaped += '\\n';
    else if (char === '\r') escaped += '\\r';
    else if (char === '\t') escaped += '\\t';
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, '0')}`;
    else escaped += char;
  }
  return escaped;
}

function renderYamlScalar(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return `"${escapeYamlString(value)}"`;
  }
  return String(value);
}

function renderYamlEntries(record: Record<string, unknown>, depth: number): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    /* An absent optional field is absent from the YAML — never `key: null`, which saucectl reads
       as an explicit empty value rather than "use the default". */
    if (value === undefined || value === null) continue;
    lines.push(...renderYamlKey(key, value, depth));
  }
  return lines;
}

function renderYamlKey(key: string, value: unknown, depth: number): string[] {
  const pad = YAML_INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    const items = value.flatMap((item: unknown) => renderYamlSequenceItem(item, depth + 1));
    return [`${pad}${key}:`, ...items];
  }
  if (typeof value === 'object') {
    const nested = renderYamlEntries(value as Record<string, unknown>, depth + 1);
    return nested.length === 0 ? [`${pad}${key}: {}`] : [`${pad}${key}:`, ...nested];
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [`${pad}${key}: ${renderYamlScalar(value)}`];
  }
  /* Functions and symbols cannot appear in a config object; dropping them beats emitting junk. */
  return [];
}

function renderYamlSequenceItem(item: unknown, depth: number): string[] {
  const pad = YAML_INDENT.repeat(depth);
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const nested = renderYamlEntries(item as Record<string, unknown>, depth + 1);
    if (nested.length === 0) return [`${pad}- {}`];
    /* The first key of a map item shares the dash's line; the rest keep their own indent. */
    const [first = '', ...rest] = nested;
    return [`${pad}- ${first.trimStart()}`, ...rest];
  }
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
    return [`${pad}- ${renderYamlScalar(item)}`];
  }
  return [];
}

/**
 * Serialises the saucectl config to YAML by hand — the framework takes no YAML dependency for one
 * generated file. Only the subset saucectl needs is covered: nested maps, sequences of maps,
 * sequences of scalars, and quoted scalars (quoting everything keeps regex `testMatch` values and
 * version strings like `1.61.1` from being reinterpreted as numbers or dates).
 */
export function toSaucectlYaml(config: SaucectlConfig = SAUCECTL_CONFIG): string {
  const root: Record<string, unknown> = { ...config };
  return `${SAUCECTL_YAML_BANNER}\n${renderYamlEntries(root, 0).join('\n')}\n`;
}
