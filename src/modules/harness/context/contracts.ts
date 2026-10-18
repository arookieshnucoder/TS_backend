/** 受 token 预算约束的文本压缩接口，检索模块无需依赖具体宿主实现。 */
export interface TextCompressor {
    execute(input: { text: string; budget: number }, signal?: AbortSignal): Promise<string>;
}
