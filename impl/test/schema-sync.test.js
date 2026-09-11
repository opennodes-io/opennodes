// The normative schema (schemas/) and the copy shipped inside @opennodes/core must be identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('packaged schema matches the normative schemas/open-node.schema.json', () => {
  const repo = readFileSync(fileURLToPath(new URL('../../schemas/open-node.schema.json', import.meta.url)), 'utf8');
  const pkg = readFileSync(fileURLToPath(new URL('../packages/core/schema/open-node.schema.json', import.meta.url)), 'utf8');
  assert.equal(pkg, repo, 'run: cp schemas/open-node.schema.json impl/packages/core/schema/');
});
