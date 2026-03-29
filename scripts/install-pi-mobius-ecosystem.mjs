#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ECOSYSTEM_PACKAGES = [
  {
    id: 'pi-mobius',
    description: 'This pi-mobius package source',
    source: 'self',
  },
  {
    id: 'pi-tool-display',
    description: 'Tool rendering helpers',
    source: 'npm:pi-tool-display',
  },
  {
    id: 'pi-context',
    description: 'Context/history management tools',
    source: 'npm:pi-context',
  },
  {
    id: 'pi-web-access',
    description: 'Web research and fetch tooling',
    source: 'npm:pi-web-access',
  },
  {
    id: 'pi-mcp-adapter',
    description: 'MCP adapter package',
    source: 'npm:pi-mcp-adapter',
  },
];

export const DEFAULT_SETTINGS_PATCH = {
  theme: 'opencode-nord',
  quietStartup: true,
  collapseChangelog: true,
  editorPaddingX: 1,
  autocompleteMaxVisible: 8,
  showHardwareCursor: true,
  powerline: 'default',
};

export function detectRepoRoot(moduleUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export function expandHomePath(input, homeDir = process.env.HOME ?? '') {
  if (!input || !homeDir) return input;
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return join(homeDir, input.slice(2));
  return input;
}

export function isRemoteSource(source) {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source);
}

export function isLikelyLocalSource(source) {
  return !isRemoteSource(source);
}

export function normalizeSource(source, { cwd = process.cwd(), homeDir = process.env.HOME ?? '' } = {}) {
  const expanded = expandHomePath(source, homeDir);
  if (!expanded) return expanded;
  if (isRemoteSource(expanded)) return expanded;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function settingsPathForScope(scope, { projectPath, homeDir }) {
  if (scope === 'local') {
    return resolve(projectPath, '.pi', 'settings.json');
  }
  return resolve(homeDir, '.pi', 'agent', 'settings.json');
}

export function mergeSettings(existing, patch) {
  return {
    ...existing,
    ...patch,
  };
}

export function parseArgs(argv, {
  cwd = process.cwd(),
  homeDir = process.env.HOME ?? '',
  repoRoot = detectRepoRoot(),
} = {}) {
  const options = {
    cwd,
    homeDir,
    repoRoot,
    scope: 'global',
    dryRun: false,
    help: false,
    only: undefined,
    piCommand: 'pi',
    projectPath: cwd,
    selfSource: undefined,
    skipSelf: false,
    skipSettings: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--skip-self') {
      options.skipSelf = true;
      continue;
    }

    if (arg === '--no-settings') {
      options.skipSettings = true;
      continue;
    }

    if (arg === '--scope') {
      const value = argv[i + 1];
      if (!value || !['global', 'local'].includes(value)) {
        throw new Error('Expected --scope to be followed by "global" or "local".');
      }
      options.scope = value;
      i += 1;
      continue;
    }

    if (arg === '--project') {
      const value = argv[i + 1];
      if (!value) throw new Error('Expected --project to be followed by a path.');
      options.projectPath = normalizeSource(value, { cwd, homeDir });
      i += 1;
      continue;
    }

    if (arg === '--self-source') {
      const value = argv[i + 1];
      if (!value) throw new Error('Expected --self-source to be followed by a package source.');
      options.selfSource = normalizeSource(value, { cwd, homeDir });
      i += 1;
      continue;
    }

    if (arg === '--pi-command') {
      const value = argv[i + 1];
      if (!value) throw new Error('Expected --pi-command to be followed by a command name.');
      options.piCommand = value;
      i += 1;
      continue;
    }

    if (arg === '--only') {
      const value = argv[i + 1];
      if (!value) throw new Error('Expected --only to be followed by a comma-separated package id list.');
      options.only = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function resolvePackageSource(pkg, options) {
  if (pkg.source === 'self') {
    return options.selfSource ?? options.repoRoot;
  }
  return pkg.source;
}

export function buildInstallPlan(options) {
  const requestedIds = options.only ? new Set(options.only) : undefined;
  const unknownIds = requestedIds
    ? [...requestedIds].filter((id) => !DEFAULT_ECOSYSTEM_PACKAGES.some((pkg) => pkg.id === id))
    : [];

  if (unknownIds.length > 0) {
    throw new Error(`Unknown package ids for --only: ${unknownIds.join(', ')}`);
  }

  const packages = DEFAULT_ECOSYSTEM_PACKAGES
    .filter((pkg) => !options.skipSelf || pkg.id !== 'pi-mobius')
    .filter((pkg) => !requestedIds || requestedIds.has(pkg.id))
    .map((pkg) => ({
      ...pkg,
      source: resolvePackageSource(pkg, options),
    }));

  return {
    scope: options.scope,
    projectPath: options.projectPath,
    settingsPath: settingsPathForScope(options.scope, {
      projectPath: options.projectPath,
      homeDir: options.homeDir,
    }),
    settingsPatch: options.skipSettings ? undefined : DEFAULT_SETTINGS_PATCH,
    packages,
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  if (!(await pathExists(path))) return {};
  const text = await readFile(path, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function writeJsonFile(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

async function runCommand(command, args, { cwd, dryRun }) {
  const rendered = formatCommand(command, args);
  if (dryRun) {
    console.log(`DRY RUN  ${cwd ? `[cwd=${cwd}] ` : ''}${rendered}`);
    return;
  }

  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      reject(new Error(`Failed to launch ${command}: ${error.message}`));
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      if (signal) {
        reject(new Error(`${rendered} exited via signal ${signal}.`));
        return;
      }

      reject(new Error(`${rendered} exited with code ${code}.`));
    });
  });
}

async function prepareLocalSource(source, options) {
  if (!isLikelyLocalSource(source)) return;

  const packageJsonPath = resolve(source, 'package.json');
  if (!(await pathExists(packageJsonPath))) return;

  console.log(`\n==> Preparing local package source: ${source}`);
  await runCommand('npm', ['install'], {
    cwd: source,
    dryRun: options.dryRun,
  });
}

async function applySettingsPatch(path, patch, dryRun) {
  if (!patch) return;

  const existing = await readJsonFile(path);
  const merged = mergeSettings(existing, patch);

  if (dryRun) {
    console.log(`DRY RUN  write settings patch -> ${path}`);
    console.log(JSON.stringify(merged, null, 2));
    return;
  }

  await writeJsonFile(path, merged);
}

export async function installEcosystem(options) {
  const plan = buildInstallPlan(options);
  const piCwd = options.scope === 'local' ? options.projectPath : options.cwd;

  for (const pkg of plan.packages) {
    if (pkg.id === 'pi-mobius' && isLikelyLocalSource(pkg.source)) {
      await prepareLocalSource(pkg.source, options);
    }

    console.log(`\n==> Installing ${pkg.id} (${pkg.source})`);
    await runCommand(options.piCommand, [
      'install',
      ...(options.scope === 'local' ? ['-l'] : []),
      pkg.source,
    ], {
      cwd: piCwd,
      dryRun: options.dryRun,
    });
  }

  if (plan.settingsPatch) {
    console.log(`\n==> Applying Pi settings defaults to ${plan.settingsPath}`);
    await applySettingsPatch(plan.settingsPath, plan.settingsPatch, options.dryRun);
  }

  return plan;
}

function printHelp() {
  console.log(`pi-mobius ecosystem installer

Usage:
  node scripts/install-pi-mobius-ecosystem.mjs [options]

Options:
  --scope global|local   Install into global Pi settings or a project-local .pi/settings.json
  --project <path>       Project root to target when --scope local is used (default: current working directory)
  --self-source <src>    Override the pi-mobius package source (path, git URL, or npm spec)
  --only <ids>           Comma-separated subset of package ids to install
  --skip-self            Skip pi-mobius itself and only install companion packages
  --pi-command <cmd>     Pi executable to use (default: pi)
  --no-settings          Skip writing theme/UI defaults to settings.json
  --dry-run              Print the commands and settings changes without executing them
  --help                 Show this help

Default package ids:
  ${DEFAULT_ECOSYSTEM_PACKAGES.map((pkg) => `${pkg.id} (${pkg.source})`).join('\n  ')}
`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  const plan = await installEcosystem(options);
  console.log('\nDone. Installed packages:');
  for (const pkg of plan.packages) {
    console.log(`- ${pkg.id}: ${pkg.source}`);
  }

  console.log('\nNext steps:');
  console.log(`- Restart Pi or run /reload in an existing session.`);
  console.log(`- Verify /plan status, /subagents-info, /agents, and /rtk-status.`);
  console.log(`- Optional external dependency: install RTK separately if you want bash rewriting.`);
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(`\npi-mobius ecosystem installer failed: ${error.message}`);
    process.exitCode = 1;
  });
}
