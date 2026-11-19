// Supply chain (expert review, 18 Nov 2026, section 4.12): install lines name exact, published versions,
// one per package, and the CI workflows pin actions by commit SHA, npm by exact version, and checksum
// what they download. Offline: the versions themselves are checked against npm and PyPI only by
// `node deploy/pin-versions.mjs` at release time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPins, checkWorkflows, applyPins, manifestVersions, ROOT } from '../../deploy/pin-versions.mjs';

test('every install line in the docs, site and plugins is pinned to one exact version per package', () => {
  const { pins, problems } = checkPins();
  assert.deepEqual(problems, []);
  const files = new Set(pins.map((p) => p.file));
  for (const f of ['plugins/opennodes/.mcp.json', 'README.md', 'site/integrations.html', 'plugins/cursor/opennodes-quote.mdc', 'node-kit/README.md']) {
    assert.ok(files.has(f), `${f} has install lines and is checked`);
  }
});

test("a package's own README, which ships in the package, names the version it ships as", () => {
  const versions = manifestVersions();
  const read = (f) => readFileSync(join(ROOT, f), 'utf8');
  assert.ok(read('impl/packages/cli/README.md').includes(`@opennodes/cli@${versions.cli}`));
  assert.ok(read('impl/packages/registry/README.md').includes(`@opennodes/registry@${versions.registry}`));
  assert.ok(read('impl/packages/ollama-router/README.md').includes(`@opennodes/ollama-router@${versions['ollama-router']}`));
  assert.ok(read('node-kit/README.md').includes(`onp-node==${versions['onp-node']}`));
});

test('the Claude Code plugin starts an exact @opennodes/cli version', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'plugins/opennodes/.mcp.json'), 'utf8'));
  const spec = config.mcpServers.opennodes.args.find((a) => a.startsWith('@opennodes/cli'));
  assert.match(spec, /^@opennodes\/cli@\d+\.\d+\.\d+$/);
});

test('CI workflows: actions by commit SHA, exact npm, npm ci, checksummed downloads', () => {
  assert.deepEqual(checkWorkflows(), []);
});

test('publish.yml never publishes onp-node in the same run as the npm packages', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8').replace(/\r\n/g, '\n');
  const npmIf = /\n  npm:\n    if: (.+)\n/.exec(wf)?.[1];
  const pypiIf = /\n  pypi:\n(?:    #.*\n)*    if: (.+)\n/.exec(wf)?.[1];
  assert.equal(npmIf, "github.event_name == 'push' || inputs.target == 'npm'");
  assert.equal(pypiIf, "github.event_name == 'workflow_dispatch' && inputs.target == 'pypi'", 'PyPI only by hand, after the registry deploy');
  assert.match(wf, /options: \[npm, pypi\]/);
});

test('the check catches unpinned, partial and mixed versions in every form; applyPins fixes them and keeps comments aligned', () => {
  const root = mkdtempSync(join(tmpdir(), 'onp-pins-'));
  try {
    mkdirSync(join(root, 'plugins'));
    mkdirSync(join(root, 'impl', 'packages', 'registry', 'src', 'web'), { recursive: true });
    mkdirSync(join(root, 'impl', 'packages', 'cli'), { recursive: true });
    // the cli's own README ships in the package: it names the manifest version, other packages the live one
    writeFileSync(join(root, 'impl', 'packages', 'cli', 'package.json'), '{ "name": "@opennodes/cli", "version": "0.1.34" }');
    writeFileSync(join(root, 'impl', 'packages', 'cli', 'README.md'), 'npx @opennodes/cli@0.1.33 gateway\nnpx @opennodes/registry@0.1.52');
    writeFileSync(join(root, 'README.md'), [
      'npx @opennodes/cli mcp --print-config',
      'npx -y @opennodes/ollama-router@latest',
      'npx @opennodes/registry@0.1.50   # run your own',
      'pipx install onp-node            # the Node Kit',
      'pipx install ./node-kit',
      'import { x } from "@opennodes/core"; see @opennodes/cli on npm',
    ].join('\n'));
    writeFileSync(join(root, 'plugins', '.mcp.json'), '{ "args": ["-y", "@opennodes/cli@0.1", "mcp"] }');
    writeFileSync(join(root, 'page.html'), '<a href="vscode:mcp/install?%7B%22args%22%3A%5B%22-y%22%2C%22%40opennodes%2Fcli%22%5D%7D">x</a> npx @opennodes/registry@0.1.51');
    writeFileSync(join(root, 'impl', 'packages', 'registry', 'src', 'web', 'index.html'), 'npx @opennodes/cli gateway');   // left to the web app

    const { pins, problems } = checkPins(root);
    assert.equal(pins.length, 9, 'npx, npx -y, JSON args, URL-encoded args and pipx; not imports, prose or ./node-kit');
    assert.ok(problems.some((p) => /^README\.md:1: unpinned/.test(p)));
    assert.ok(problems.some((p) => /not an exact version: npx -y @opennodes\/ollama-router@latest/.test(p)));
    assert.ok(problems.some((p) => /not an exact version: "-y", "@opennodes\/cli@0\.1/.test(p)));
    assert.ok(problems.some((p) => /page\.html:1: unpinned: %22-y%22/.test(p)));
    const mixed = problems.find((p) => p.startsWith('@opennodes/registry is pinned to'));
    for (const v of ['0.1.50', '0.1.51', '0.1.52']) assert.ok(mixed?.includes(v), `${v} in "${mixed}": another package in a shipped file is a live line`);
    assert.ok(problems.some((p) => /impl\/packages\/cli\/README\.md:1: ships in @opennodes\/cli 0\.1\.34/.test(p)));
    assert.ok(!problems.some((p) => p.includes('src/web')), 'the registry web app is not checked');

    const changed = applyPins({ live: { cli: '0.1.33', registry: '0.1.53', 'ollama-router': '0.1.27', 'onp-node': '0.1.10' }, own: manifestVersions(root) }, root);
    assert.deepEqual(changed.sort(), ['README.md', 'impl/packages/cli/README.md', 'page.html', 'plugins/.mcp.json']);
    assert.deepEqual(checkPins(root).problems, []);
    assert.equal(readFileSync(join(root, 'impl', 'packages', 'cli', 'README.md'), 'utf8'), 'npx @opennodes/cli@0.1.34 gateway\nnpx @opennodes/registry@0.1.53');
    const readme = readFileSync(join(root, 'README.md'), 'utf8').split('\n');
    assert.equal(readme[2], 'npx @opennodes/registry@0.1.53   # run your own', 'same length: comment stays put');
    assert.equal(readme[3], 'pipx install onp-node==0.1.10    # the Node Kit', 'longer: the comment keeps its column');
    assert.equal(readme[4], 'pipx install ./node-kit');
    assert.match(readFileSync(join(root, 'page.html'), 'utf8'), /%22%40opennodes%2Fcli%400\.1\.33%22/);
    assert.equal(JSON.parse(readFileSync(join(root, 'plugins', '.mcp.json'), 'utf8')).args[1], '@opennodes/cli@0.1.33');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('server.json follows the cli manifest; the root Dockerfile is a live line', () => {
  const root = mkdtempSync(join(tmpdir(), 'onp-srv-'));
  try {
    mkdirSync(join(root, 'impl', 'packages', 'cli'), { recursive: true });
    writeFileSync(join(root, 'impl', 'packages', 'cli', 'package.json'), '{ "name": "@opennodes/cli", "version": "0.1.34" }');
    writeFileSync(join(root, 'impl', 'packages', 'cli', 'server.json'), '{\r\n  "name": "x",\r\n  "version": "0.1.14",\r\n  "packages": [\r\n    { "identifier": "@opennodes/cli", "version": "0.1.14" }\r\n  ]\r\n}\r\n');
    writeFileSync(join(root, 'Dockerfile'), 'FROM node:24-alpine\nRUN npm install -g @opennodes/cli@0.1.14 && npm cache clean --force\n');
    writeFileSync(join(root, 'README.md'), 'npx @opennodes/cli@0.1.33 mcp');
    const { problems } = checkPins(root);
    assert.ok(problems.some((p) => /server\.json names 0\.1\.14; @opennodes\/cli is 0\.1\.34/.test(p)));
    assert.ok(problems.some((p) => /@opennodes\/cli is pinned to 0\.1\.14 and 0\.1\.33|0\.1\.33 and 0\.1\.14/.test(p)), 'the Dockerfile is checked with the live lines');
    const changed = applyPins({ live: { cli: '0.1.33' }, own: manifestVersions(root) }, root);
    assert.deepEqual(changed.sort(), ['Dockerfile', 'impl/packages/cli/server.json']);
    assert.deepEqual(checkPins(root).problems, []);
    const server = readFileSync(join(root, 'impl', 'packages', 'cli', 'server.json'), 'utf8');
    assert.equal(server, '{\r\n  "name": "x",\r\n  "version": "0.1.34",\r\n  "packages": [\r\n    { "identifier": "@opennodes/cli", "version": "0.1.34" }\r\n  ]\r\n}\r\n', 'formatting kept');
    assert.match(readFileSync(join(root, 'Dockerfile'), 'utf8'), /npm install -g @opennodes\/cli@0\.1\.33 &&/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the workflow check catches tag-pinned actions, npm@latest, npm install and an unchecked download', () => {
  const root = mkdtempSync(join(tmpdir(), 'onp-wf-'));
  try {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'x.yml'), [
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      '      - uses: ./local-action',
      '      - run: npm install -g npm@latest && npm --version',
      '      - run: npm install',
      '      - run: curl -sL "https://github.com/o/r/releases/latest/download/t.tar.gz" | tar xz t',
    ].join('\n'));
    const problems = checkWorkflows(root);
    assert.equal(problems.length, 6, problems.join('\n'));
    assert.match(problems.join('\n'), /x\.yml:2: action not pinned by commit SHA: actions\/checkout@v4/);
    assert.match(problems.join('\n'), /x\.yml:3: say which tag/);
    assert.match(problems.join('\n'), /x\.yml:5: npm must be installed at an exact version/);
    assert.match(problems.join('\n'), /x\.yml:6: use npm ci/);
    assert.match(problems.join('\n'), /x\.yml:7: download a pinned release/);
    assert.match(problems.join('\n'), /x\.yml:7: download to a file and check its SHA-256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
