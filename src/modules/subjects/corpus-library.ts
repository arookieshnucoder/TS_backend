/** 题库加载器需要的最小结构；来源和题目分类仍由各学科定义。 */
interface QuestionCorpus {
    passages: { id: string }[];
    knowledge: { id: string; passageId: string }[];
}

/** 统一延迟加载和并发复用；失败后清空缓存，让下一次请求能够重试。 */
export class CorpusLibrary<C extends QuestionCorpus, T> {
    private pending?: Promise<C>;

    constructor(
        private readonly load: () => Promise<C>,
        private readonly project: (passage: C["passages"][number], question: C["knowledge"][number]) => T,
        private readonly unavailable: () => Error,
    ) {}

    corpus(): Promise<C> {
        return this.pending ??= this.load().catch(() => {
            this.pending = undefined;
            throw this.unavailable();
        });
    }

    async question(id: string): Promise<T | undefined> {
        const corpus = await this.corpus();
        const question = corpus.knowledge.find(item => item.id === id);
        if (!question) return undefined;
        const passage = corpus.passages.find(item => item.id === question.passageId);
        if (!passage) throw new Error(`Question references missing passage: ${question.passageId}`);
        return this.project(passage, question);
    }
}
