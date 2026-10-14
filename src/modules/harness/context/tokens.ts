import { getEncoding } from "js-tiktoken";
import type { ContextConfig } from "./config.js";

const encodings = new Map<string, ReturnType<typeof getEncoding>>();

export class TokenBudget {
    private readonly encoding;
    constructor(private readonly config: ContextConfig) {
        if (!encodings.has(config.tokenizer)) encodings.set(config.tokenizer, getEncoding(config.tokenizer));
        this.encoding = encodings.get(config.tokenizer)!;
    }
    count(text: string): number {
        // Bound tokenizer work on adversarial long runs; boundary splits conservatively overcount.
        let count = 0;
        for (let i=0;i<text.length;) {
            let end=Math.min(i+512,text.length);
            if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
            count+=this.encoding.encode(text.slice(i,end)).length;i=end;
        }
        return Math.ceil(count * this.config.tokenSafetyFactor);
    }
    truncate(text: string, budget: number): string {
        if (budget <= 0) return "";
        // Slice Unicode characters rather than token bytes to avoid broken multibyte text.
        const chars = Array.from(text);
        let lo = 0, hi = chars.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (this.count(chars.slice(0, mid).join("")) <= budget) lo = mid;
            else hi = mid - 1;
        }
        return chars.slice(0, lo).join("");
    }
    chunks(text: string, size = this.config.chunkTokens, overlap = this.config.overlapRatio): string[] {
        if (!Number.isInteger(size) || size < 1 || overlap < 0 || overlap > .15) throw new Error("Invalid chunk settings");
        const result: string[] = [];
        let remaining = text;
        while (remaining) {
            const chunk = this.truncate(remaining, size);
            if (!chunk) throw new Error("Chunk size cannot encode a character");
            result.push(chunk);
            if (chunk.length === remaining.length) break;
            const chars = Array.from(chunk);
            const reversed = chars.reverse().join("");
            let suffix = Array.from(this.truncate(reversed, Math.floor(size * overlap))).reverse().join("");
            while (this.count(suffix) > Math.floor(size * overlap)) suffix = Array.from(suffix).slice(1).join("");
            remaining = remaining.slice(Math.max(1, chunk.length - suffix.length));
        }
        return result;
    }
}
