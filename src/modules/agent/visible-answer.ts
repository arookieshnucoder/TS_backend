/** Provider-neutral handling of legacy visible think tags; hidden reasoning is never used as an answer. */
export function visibleAnswer(content: string, errorCode = "VISIBLE_ANSWER_MISSING"): string {
    const end = content.lastIndexOf("</think>");
    if (end < 0 && content.trimStart().startsWith("<think>")) throw new Error(errorCode);
    const visible = end < 0 ? content : content.slice(end + "</think>".length);
    if (!visible.trim()) throw new Error(errorCode);
    return visible.trim();
}
