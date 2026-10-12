/** Business retrieval depends on this port, not the harness compression implementation. */
export interface TextCompressor {
    execute(input: { text: string; budget: number }, signal?: AbortSignal): Promise<string>;
}
