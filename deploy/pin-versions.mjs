#!/usr/bin/env node
// Install lines pinned to exact versions (expert review of 18 Nov 2026, 4.12). An unpinned
// "npx @opennodes/cli" or "pipx install onp-node" runs whatever is published next, and the Claude Code
// plugin starts its MCP server with npx on every launch, without a prompt.
//
// Two kinds of line:
//   - live lines (the plugin, the site, the root and impl READMEs, docs/, the Cursor rule, and any line naming
//     another package): the latest PUBLISHED version, one per package. They are read straight from the
//     repository, so a pin to an unpublished version would break them;
//   - own lines (a package's own files naming that package, e.g. @opennodes/cli in impl/packages/cli/README.md,
//     onp-node in node-kit/README.md): the version in the package's manifest. These files ship inside the
//     package, so its npm or PyPI page names the version it is.
//
//   node deploy/pin-versions.mjs --own         after a version bump, offline: own lines to the manifest versions
//   node deploy/pin-versions.mjs               after publishing: live lines to the latest versions on npm and
//                                               PyPI (each checked there first), own lines to the manifests
//   node deploy/pin-versions.mjs cli=0.1.34    the same, naming the live versions
//   node deploy/pin-versions.mjs --check       offline: every line pinned; own lines = manifest; one version
//                                               per package for live lines; the CI workflows pinned too
//                                               (impl/test/install-pins.test.js runs it in npm test)
// See deploy/RELEASING.md.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The packages users install by name. npm ones are run with npx; onp-node is installed with pipx. `dir`: what ships in it. */
export const PACKAGES = {
  cli: { registry: 'npm', name: '@opennodes/cli', dir: 'impl/packages/cli/', manifest: 'impl/packages/cli/package.json' },
  registry: { registry: 'npm', name: '@opennodes/registry', dir: 'impl/packages/registry/', manifest: 'impl/packages/registry/package.json' },
  'ollama-router': { registry: 'npm', name: '@opennodes/ollama-router', dir: 'impl/packages/ollama-router/', manifest: 'impl/packages/ollama-router/package.json' },
  'onp-node': { registry: 'pypi', name: 'onp-node', dir: 'node-kit/', manifest: 'node-kit/pyproject.toml' },
};

// Where install lines live. Left out on purpose:
//   spec/ and requirements/  normative text and history (CHANGES.md), not install instructions;
//   impl/test/               fixtures;
//   impl/packages/registry/src/web/  the registry web app (three unpinned lines, maintained with the web app);
//   deploy/registry/Dockerfile       the hosted registry image, moved by the deploy step in RELEASING.md.
// The root Dockerfile (the MCP server image that directories such as Glama build from main) is a live line.
// impl/packages/cli/server.json (the MCP Registry entry, published by hand after npm) follows the cli manifest.
const EXTENSIONS = new Set(['.md', '.mdc', '.html', '.json', '.js', '.mjs']);
const EXTRA_FILES = ['Dockerfile'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'build']);
const SKIP_PATHS = ['spec', 'requirements', 'impl/test', 'impl/packages/registry/src/web'];
const SKIP_FILES = new Set(['deploy/pin-versions.mjs', 'impl/package-lock.json']);
export const SERVER_JSON = 'impl/packages/cli/server.json';

const NPM_NAMES = Object.entries(PACKAGES).filter(([, p]) => p.registry === 'npm').map(([k]) => k).join('|');
const VER = String.raw`[\w-]+(?:\.[\w-]+)*`;   // anything version-like, so --check can flag "0.1" and "latest" too
/**
 * The forms an install line takes. Each regex captures: 1 the text before the package, 2 the package key,
 * 3 the version if any, 4 (command lines) the spaces before a "# comment", so the comments stay aligned.
 * `sep` joins package and version.
 */
const PAD = String.raw`( +(?=#))?`;
const FORMS = [
  // npx [-y] @opennodes/<pkg>[@version]   (READMEs, site, Cursor rule, `claude mcp add ... -- npx -y ...`)
  { sep: '@', re: new RegExp(String.raw`(npx\s+(?:-y\s+|--yes\s+)?@opennodes/)(${NPM_NAMES})(?:@(${VER}))?(?![\w@/])` + PAD, 'g') },
  // MCP host config: "args": ["-y", "@opennodes/<pkg>[@version]", ...]
  { sep: '@', re: new RegExp(String.raw`("-y",\s*"@opennodes/)(${NPM_NAMES})(?:@(${VER}))?(?=")`, 'g') },
  // the same, URL-encoded (VS Code install link)
  { sep: '%40', re: new RegExp(String.raw`(%22-y%22%2C%22%40opennodes%2F)(${NPM_NAMES})(?:%40(${VER}))?(?=%22)`, 'g') },
  // npm install -g @opennodes/<pkg>[@version]   (the root Dockerfile)
  { sep: '@', re: new RegExp(String.raw`(npm\s+(?:install|i)\s+(?:-g|--global)\s+@opennodes/)(${NPM_NAMES})(?:@(${VER}))?(?![\w@/])` + PAD, 'g') },
  // pipx install onp-node[==version]   (pip install too; "pipx install ./node-kit" from a checkout is not matched)
  { sep: '==', re: new RegExp(String.raw`(pipx?\s+install\s+(?:-U\s+|--upgrade\s+)?)(onp-node)(?:==(${VER}))?(?![\w.=\[-])` + PAD, 'g') },
];
const EXACT = /^\d+\.\d+\.\d+$/;

/** Is this line in the package's own shipped files, naming that package? */
export const isOwnLine = (file, pkg) => file.startsWith(PACKAGES[pkg].dir);

/** The version in each package's manifest (null where the manifest is missing). */
export function manifestVersions(root = ROOT) {
  const out = {};
  for (const [pkg, p] of Object.entries(PACKAGES)) {
    const path = join(root, p.manifest);
    if (!existsSync(path)) { out[pkg] = null; continue; }
    const text = readFileSync(path, 'utf8');
    out[pkg] = p.registry === 'npm' ? JSON.parse(text).version : (/^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null);
  }
  return out;
}

/** Every file that may hold an install line, relative to the repository root with forward slashes. */
export function managedFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.includes(rel)) continue;
        walk(abs);
      } else if (EXTENSIONS.has(extname(entry.name)) && !SKIP_FILES.has(rel)) out.push(rel);
    }
  };
  walk(root);
  for (const f of EXTRA_FILES) if (existsSync(join(root, f))) out.push(f);
  return out.sort();
}

const SERVER_VERSION = /("version"\s*:\s*")([^"]*)(")/g;
/** The versions server.json names (the entry's and its npm package's), or null without the file. */
export function serverJsonVersions(root = ROOT) {
  const path = join(root, SERVER_JSON);
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return [doc.version, ...(doc.packages ?? []).filter((p) => p.identifier === PACKAGES.cli.name).map((p) => p.version)];
}

/** Every install line: { file, line, pkg, version (null when unpinned), own, text }. */
export function findPins(root = ROOT) {
  const found = [];
  for (const file of managedFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const { re } of FORMS) {
      for (const m of text.matchAll(re)) {
        found.push({ file, line: text.slice(0, m.index).split('\n').length, pkg: m[2], version: m[3] ?? null, own: isOwnLine(file, m[2]), text: m[0].trimEnd() });
      }
    }
  }
  return found;
}

/**
 * Problems with the install lines: unpinned, not an exact version, an own line that is not its package's
 * manifest version, or two versions of one package among the live lines.
 */
export function checkPins(root = ROOT) {
  const pins = findPins(root);
  const manifests = manifestVersions(root);
  const problems = [];
  for (const p of pins) {
    if (!p.version) problems.push(`${p.file}:${p.line}: unpinned: ${p.text}`);
    else if (!EXACT.test(p.version)) problems.push(`${p.file}:${p.line}: not an exact version: ${p.text}`);
    else if (p.own && manifests[p.pkg] && p.version !== manifests[p.pkg]) {
      problems.push(`${p.file}:${p.line}: ships in ${PACKAGES[p.pkg].name} ${manifests[p.pkg]}, so it names that version: ${p.text} (node deploy/pin-versions.mjs --own)`);
    }
  }
  for (const pkg of Object.keys(PACKAGES)) {
    const live = pins.filter((p) => p.pkg === pkg && p.version && !(p.own && manifests[pkg]));
    const versions = [...new Set(live.map((p) => p.version))];
    if (versions.length > 1) problems.push(`${PACKAGES[pkg].name} is pinned to ${versions.join(' and ')}: run node deploy/pin-versions.mjs`);
  }
  const server = serverJsonVersions(root);
  if (server && manifests.cli && server.some((v) => v !== manifests.cli)) {
    problems.push(`${SERVER_JSON} names ${[...new Set(server)].join(' and ')}; @opennodes/cli is ${manifests.cli} (node deploy/pin-versions.mjs --own)`);
  }
  return { pins, problems };
}

/**
 * The CI workflows: every action pinned by a full commit SHA (with its tag in a comment), npm installed at
 * an exact version, dependencies installed with npm ci, and any downloaded tool pinned and checksummed.
 */
export function checkWorkflows(root = ROOT) {
  const dir = join(root, '.github', 'workflows');
  const problems = [];
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `.github/workflows/${name}:${i + 1}`;
      const uses = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(#.*)?$/.exec(line);
      if (uses && !uses[1].startsWith('./')) {
        if (!/@[0-9a-f]{40}$/.test(uses[1])) problems.push(`${where}: action not pinned by commit SHA: ${uses[1]}`);
        else if (!/#\s*v\d/.test(uses[2] ?? '')) problems.push(`${where}: say which tag the SHA is in a comment (# vX.Y.Z)`);
      }
      if (/npm(?:\s+\S+)*\s+(?:i|install)\s+(?:-g\s+|--global\s+)?npm@(?!\d+\.\d+\.\d+\b)/.test(line)) problems.push(`${where}: npm must be installed at an exact version`);
      if (/^\s*(?:-\s+)?run:\s*npm\s+(?:i|install)\s*$/.test(line)) problems.push(`${where}: use npm ci (installs exactly the lockfile)`);
      if (/releases\/latest\/download/.test(line)) problems.push(`${where}: download a pinned release, not latest`);
      if (/curl[^|]*\|\s*(?:tar|sh|bash)\b/.test(line)) problems.push(`${where}: download to a file and check its SHA-256 before using it`);
    });
    const text = lines.join('\n');
    if (/releases\/download\//.test(text) && !/sha256sum\s+(?:-c|--check)/.test(text)) problems.push(`.github/workflows/${name}: a downloaded release is not checked with sha256sum -c`);
  }
  return problems;
}

/* ------------------------------------------------------------------ pinning */

async function published(pkg, version) {
  const p = PACKAGES[pkg];
  const url = p.registry === 'npm'
    ? `https://registry.npmjs.org/${p.name}/${version}`
    : `https://pypi.org/pypi/${p.name}/${version}/json`;
  const res = await fetch(url);
  return res.ok;
}

async function latest(pkg) {
  const p = PACKAGES[pkg];
  if (p.registry === 'npm') {
    const res = await fetch(`https://registry.npmjs.org/${p.name}/latest`);
    if (!res.ok) throw new Error(`${p.name}: npm answered ${res.status}`);
    return (await res.json()).version;
  }
  const res = await fetch(`https://pypi.org/pypi/${p.name}/json`);
  if (!res.ok) throw new Error(`${p.name}: PyPI answered ${res.status}`);
  return (await res.json()).info.version;
}

/**
 * Rewrite the install lines: own lines to `own[pkg]`, live lines to `live[pkg]`; a package missing from
 * a map keeps its lines as they are. Returns the files changed.
 */
export function applyPins({ live = {}, own = {} } = {}, root = ROOT) {
  const changed = [];
  for (const file of managedFiles(root)) {
    const abs = join(root, file);
    const before = readFileSync(abs, 'utf8');
    let after = before;
    for (const { re, sep: s } of FORMS) {
      after = after.replace(re, (all, prefix, pkg, _version, pad) => {
        const version = isOwnLine(file, pkg) && own[pkg] ? own[pkg] : live[pkg];
        if (!version) return all;
        const pinned = `${prefix}${pkg}${s}${version}`;
        if (typeof pad !== 'string') return pinned;
        // keep a following "# comment" in its column: take the growth out of the spaces before it
        const grown = pinned.length - (all.length - pad.length);
        return pinned + ' '.repeat(Math.max(1, pad.length - grown));
      });
    }
    if (after !== before) { writeFileSync(abs, after); changed.push(file); }
  }
  // server.json follows the cli's manifest version (its two "version" fields), formatting kept
  const serverPath = join(root, SERVER_JSON);
  if (own.cli && existsSync(serverPath)) {
    const before = readFileSync(serverPath, 'utf8');
    const after = before.replace(SERVER_VERSION, (all, a, _v, b) => `${a}${own.cli}${b}`);
    if (after !== before) {
      JSON.parse(after);   // still valid JSON
      writeFileSync(serverPath, after);
      changed.push(SERVER_JSON);
    }
  }
  return changed;
}

async function main(argv) {
  const own = manifestVersions();
  const report = (changed) => console.log(changed.length ? `updated:\n  ${changed.join('\n  ')}` : 'nothing to change');
  const finish = () => {
    const { problems } = checkPins();
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  };
  if (argv.includes('--check')) {
    const { pins, problems } = checkPins();
    problems.push(...checkWorkflows());
    for (const pkg of Object.keys(PACKAGES)) {
      const lines = pins.filter((p) => p.pkg === pkg);
      const live = [...new Set(lines.filter((p) => !p.own).map((p) => p.version ?? 'unpinned'))];
      const mine = [...new Set(lines.filter((p) => p.own).map((p) => p.version ?? 'unpinned'))];
      console.log(`${PACKAGES[pkg].name}: ${live.join(', ') || '-'} (${lines.filter((p) => !p.own).length} live lines)` +
        `${mine.length ? `; its own files: ${mine.join(', ')} (${lines.filter((p) => p.own).length})` : ''}`);
    }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('every install line and workflow step is pinned');
    return;
  }
  if (argv.includes('--own')) {
    for (const [pkg, v] of Object.entries(own)) console.log(`${PACKAGES[pkg].name}: its own files name ${v}`);
    report(applyPins({ own }));
    return finish();
  }
  const live = {};
  for (const arg of argv) {
    const [pkg, version] = arg.split('=');
    if (!PACKAGES[pkg] || !EXACT.test(version ?? '')) throw new Error(`usage: node deploy/pin-versions.mjs [--check | --own] [${Object.keys(PACKAGES).join('|')}=X.Y.Z ...]`);
    live[pkg] = version;
  }
  for (const pkg of Object.keys(PACKAGES)) {
    live[pkg] ??= await latest(pkg);
    if (!(await published(pkg, live[pkg]))) throw new Error(`${PACKAGES[pkg].name}@${live[pkg]} is not published: publish first, then pin`);
    console.log(`${PACKAGES[pkg].name}: live lines ${live[pkg]}; its own files ${own[pkg]}${own[pkg] !== live[pkg] ? ' (not published yet?)' : ''}`);
  }
  report(applyPins({ live, own }));
  finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
}
