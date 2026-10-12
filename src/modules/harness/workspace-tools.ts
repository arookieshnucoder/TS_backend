import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringField, ToolAccessError, ToolInputError, validateFields, type RegisteredTool } from "./tool-registry.js";

const blockedDirectories = new Set([".git", ".svn", ".hg", ".ssh", ".aws", ".codex", ".npm-cache", "node_modules", "dist", "build", "coverage", "data"]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json", ".md", ".txt", ".css", ".scss", ".html", ".yml", ".yaml", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".toml", ".xml", ".sql"]);
const maxFileBytes = 1024 * 1024;
const allowedName = (name: string) => !blockedDirectories.has(name.toLowerCase()) && !name.startsWith(".") && !/[. ]$/.test(name) &&
    !/(^|[._-])(secret|secrets|credential|credentials|id_rsa|id_ed25519)([._-]|$)/i.test(name) && !name.toLowerCase().endsWith(".lock");
const readable = (name: string) => allowedName(name) && (extensions.has(extname(name).toLowerCase()) || ["Dockerfile", "LICENSE"].includes(name));

/** Bounded read-only workspace view: no shell and no model-controlled absolute paths. */
export class WorkspaceReader {
    private readonly root: string;
    private exclusions?: Promise<string[]>;
    constructor(root: string, private readonly excludedPaths: string[] = []) { this.root = resolve(root); }
    private within(root: string, path: string): boolean {
        const rel = relative(root, path);
        return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    }
    private async canonical(path: string): Promise<string> {
        try { return await realpath(path); }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT") || dirname(path) === path) throw error;
            return join(await this.canonical(dirname(path)), basename(path));
        }
    }
    private async excluded(path: string): Promise<boolean> {
        this.exclusions ??= Promise.all(this.excludedPaths.map(excluded => this.canonical(resolve(excluded))));
        return (await this.exclusions).some(excluded => this.within(excluded, path));
    }
    private async path(input: string, signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        if (isAbsolute(input) || /^[a-z]:/i.test(input) || /[:\0]/.test(input)) throw new ToolAccessError();
        const parts = input.replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
        if (parts.some(part => part === ".." || !allowedName(part))) throw new ToolAccessError();
        const root = await realpath(this.root);
        let path = root;
        for (const part of parts) {
            path = join(path, part);
            if ((await lstat(path)).isSymbolicLink()) throw new ToolAccessError();
        }
        const resolved = await realpath(path);
        if (!this.within(root, resolved) || await this.excluded(resolved)) throw new ToolAccessError();
        signal?.throwIfAborted();
        return resolved;
    }
    private async text(path: string, signal?: AbortSignal): Promise<string> {
        if (!readable(path.split(sep).at(-1)!)) throw new ToolAccessError();
        const handle = await open(path, "r");
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > maxFileBytes) throw new ToolAccessError();
            const buffer = Buffer.alloc(maxFileBytes + 1);
            let count = 0;
            while (count < buffer.length) {
                signal?.throwIfAborted();
                const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
                if (!bytesRead) break;
                count += bytesRead;
            }
            if (count > maxFileBytes || buffer.subarray(0, count).includes(0)) throw new ToolAccessError();
            return buffer.subarray(0, count).toString("utf8");
        } finally { await handle.close(); }
    }
    async list(input: string, signal?: AbortSignal): Promise<string> {
        const path = await this.path(input, signal);
        const entries: string[] = [];
        let scanned = 0, truncated = false;
        for await (const entry of await opendir(path)) {
            signal?.throwIfAborted();
            if (++scanned > 2000 || entries.length >= 200) { truncated = true; break; }
            if (!allowedName(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !readable(entry.name))) continue;
            if (await this.excluded(join(path, entry.name))) continue;
            entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
        }
        return JSON.stringify({ path: input, entries: entries.sort(), truncated });
    }
    async read(input: string, startLine: number, endLine: number, signal?: AbortSignal): Promise<string> {
        const content = await this.text(await this.path(input, signal), signal);
        const lines = content.split(/\r?\n/);
        return JSON.stringify({
            path: input, totalLines: lines.length, startLine, endLine: Math.min(endLine, lines.length),
            content: lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n")
        });
    }
    async search(input: string, query: string, signal?: AbortSignal): Promise<string> {
        const start = await this.path(input, signal);
        if (!(await lstat(start)).isDirectory()) throw new ToolInputError("path must be a directory");
        const pending = [start];
        const matches: { path: string; line: number; text: string }[] = [];
        let scanned = 0, bytes = 0, entries = 0, truncated = false;
        const root = await realpath(this.root);
        search: while (pending.length) {
            const directory = await this.path(relative(root, pending.pop()!).split(sep).join("/") || ".", signal);
            for await (const entry of await opendir(directory)) {
                signal?.throwIfAborted();
                if (++entries > 10000 || scanned >= 2000 || bytes >= 8 * maxFileBytes || matches.length >= 50) { truncated = true; break search; }
                if (!allowedName(entry.name) || entry.isSymbolicLink()) continue;
                const candidate = join(directory, entry.name);
                if (await this.excluded(candidate)) continue;
                const rel = relative(root, candidate).split(sep).join("/");
                if (entry.isDirectory()) { pending.push(candidate); continue; }
                if (!entry.isFile() || !readable(entry.name)) continue;
                scanned++;
                try {
                    const text = await this.text(await this.path(rel, signal), signal);
                    bytes += Buffer.byteLength(text);
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i]!.toLowerCase().includes(query.toLowerCase())) {
                            matches.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 500) });
                            if (matches.length >= 50) { truncated = true; break search; }
                        }
                    }
                } catch (error) {
                    signal?.throwIfAborted();
                    if (!(error instanceof ToolAccessError) && !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
                }
            }
        }
        return JSON.stringify({ query, path: input, matches, scannedFiles: scanned, truncated });
    }
}

/**
 * 定义了三个简易的工具函数分别是，list_directory、read_file 和 search_workspace。
 * list_directory：列出工作区中可访问的源文件和目录，最多返回 200 个条目。
 * read_file：读取文本源文件的最多 200 行内容；返回行号以便引用。
 * search_workspace：使用不区分大小写的字面查询搜索源文本；返回路径和行号。扫描有界；如果被截断，请缩小路径范围。
 * @param root 工作区的根目录路径。
 * @param excludedPaths 要排除的路径列表。
 * @returns 已注册的只读工作区工具数组。
 */
export function createWorkspaceTools(root: string, excludedPaths: string[] = []): RegisteredTool[] {
    const reader = new WorkspaceReader(root, excludedPaths);
    const pathProperty = { type: "string", minLength: 1, maxLength: 500, description: "Workspace-relative path; use . for the root." };
    const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
        ({ name, description, parameters: { type: "object", properties, required, additionalProperties: false } });

    return [
        {
            readonly: true,
            definition: definition("list_directory", "List accessible source files and directories (up to 200 entries).", { path: pathProperty }, ["path"]),
            validate(input) { validateFields(input, ["path"]); stringField(input, "path", 500); },
            execute: (input, signal) => reader.list(input.path as string, signal)
        },

        {
            readonly: true,
            definition: definition("read_file", "Read up to 200 lines from a text source file; returns line numbers for citations.",
                { path: pathProperty, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["path", "startLine", "endLine"]),
            validate(input) {
                validateFields(input, ["path", "startLine", "endLine"]); stringField(input, "path", 500);
                const start = input.startLine, end = input.endLine;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 1 || (end as number) < (start as number) || (end as number) - (start as number) >= 200)
                    throw new ToolInputError("startLine/endLine must specify 1..200 lines, starting at line 1 or later");
            }, execute: (input, signal) => reader.read(input.path as string, input.startLine as number, input.endLine as number, signal)
        },

        {
            readonly: true,
            definition: definition("search_workspace", "Search source text using a case-insensitive literal query; returns paths and line numbers. Bounded scan; narrow path if truncated.",
                { query: { type: "string", minLength: 1, maxLength: 500 }, path: pathProperty }, ["query", "path"]),
            validate(input) { validateFields(input, ["query", "path"]); stringField(input, "query", 500); stringField(input, "path", 500); },
            execute: (input, signal) => reader.search(input.path as string, input.query as string, signal)
        },
    ];
}
