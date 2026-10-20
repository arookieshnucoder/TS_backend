import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Replace a file only after its complete contents are written beside the destination. */
export async function atomicWriteFile(destination: string, content: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    // Exclusive creation establishes ownership before any cleanup is permitted.
    const handle = await open(temporary, "wx", 0o600);
    try {
        try { await handle.writeFile(content, "utf8"); }
        finally { await handle.close(); }
        await rename(temporary, destination);
    } catch (error) {
        // Remove only this operation's temporary file; preserve the original error.
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}
