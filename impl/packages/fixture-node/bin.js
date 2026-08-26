import { startFixtureNode } from './src/node.js';

const node = await startFixtureNode({
  port: Number(process.env.PORT ?? 4310),
  acceptAnyChallenge: process.env.ACCEPT_ANY_CHALLENGE === '1',
});
console.log(`fixture node listening at ${node.origin}`);
console.log(`card: ${node.origin}/.well-known/open-node.json`);
