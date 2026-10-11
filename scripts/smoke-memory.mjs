// Run on stdin inside the backend container: node --input-type=module.
// Uses the real Elasticsearch service and deterministic local embeddings, never a paid model API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadContextConfig } from './dist/modules/harness/context/config.js';
import { TokenBudget } from './dist/modules/harness/context/tokens.js';
import { ElasticsearchMemorySearch } from './dist/infrastructure/llm/memory-search.js';

let embeddings = 0;
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const { input } = JSON.parse(raw);
  embeddings++;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ data: [{ embedding: input.includes('memory') ? [1, 0, 0] : [0, 1, 0] }] }));
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const index = `ragagent-smoke-${Date.now()}`;
try {
  const config = loadContextConfig({
    ELASTICSEARCH_URL: process.env.ELASTICSEARCH_URL,
    ELASTICSEARCH_INDEX: index,
    EMBEDDING_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    EMBEDDING_MODEL: 'deterministic-smoke-embedding', EMBEDDING_DIMENSIONS: '3',
  });
  const tokens = new TokenBudget(config);
  const sessions = ['memory', 'garden'].map(topic => ({
    id: topic, requestId: topic, title: `${topic} session`, createdAt: new Date(), updatedAt: new Date(),
    sessionStatus: 'finished', sessionError: null,
    messages: [{ id: 'one', role: 'user', content: `${topic} fixture content` }],
  }));
  const search = new ElasticsearchMemorySearch(tokens, config);
  const signal = AbortSignal.timeout(30000);
  await search.sync(sessions, signal);
  const count = embeddings;
  await new ElasticsearchMemorySearch(tokens, config).sync(sessions, signal);
  assert.equal(embeddings, count, 'existing documents must not be re-embedded');
  assert.deepEqual(await search.titles('memory', ['memory', 'garden'], signal), ['memory']);
  const chunks = await search.search('memory', ['memory'], 8, signal);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].sessionId, 'memory');
  assert.match(chunks[0].text, /memory fixture/);
  assert.deepEqual(await search.search('memory', [], 8, signal), []);
  console.log(`Real Elasticsearch BM25 + kNN + RRF + embedding reuse passed; retained test index: ${index}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
