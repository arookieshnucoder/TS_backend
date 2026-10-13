import { loadCorpus } from "../src/modules/math/corpus.js";
import { buildIndex } from "../src/modules/math/rag.js";
import { GlmEmbeddings } from "../src/infrastructure/llm/glm-model.js";
import { mathEmbeddingConfig } from '../src/bootstrap/math-chat-agent.js';
import { loadConfig } from '../src/config/env.js';
const corpus = await loadCorpus("evals/math/corpus.json");
await buildIndex(corpus.knowledge,new GlmEmbeddings(mathEmbeddingConfig(loadConfig())),"data/math/index.json");
console.log(`Indexed ${corpus.knowledge.length} questions with embedding-3 (256 dimensions).`);
