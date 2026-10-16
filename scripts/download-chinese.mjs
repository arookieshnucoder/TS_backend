import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Bounded importer for public Zhongkao reading exercises. No login, OCR or model-generated answers.
const pages = Number(process.argv[2] ?? 16);
if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error('pages must be 1..100');
const root = 'data/chinese/source';
await mkdir(root, { recursive: true });
const digest = text => createHash('sha256').update(text).digest('hex');
const entities = { nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', hellip: '…', middot: '·', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", bull: '•', times: '×' };
function text(html) {
    return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?\s*>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, name) => name[0] === '#' ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : entities[name] ?? all)
        .split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
}
async function fetchPage(url) {
    const path = join(root, `${digest(url)}.html`);
    try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'TSpj educational research importer' } });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const data = await response.arrayBuffer();
    const prefix = new TextDecoder().decode(data.slice(0, 2500));
    const charset = prefix.match(/charset\s*=\s*["']?([^\s"'>]+)/i)?.[1] ?? 'utf-8';
    const html = new TextDecoder(charset).decode(data);
    await writeFile(path, html);
    return html;
}
function links(html) {
    return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(match => ({ url: match[1].replace(/^http:\/\/www\.zhongkao\.com\//, 'https://www.zhongkao.com/'), title: text(match[2]) }));
}
function article(html) {
    const start = html.search(/<div class="content ft14">/);
    if (start < 0) return '';
    let body = html.slice(start).split(/编辑推荐|<div class="pages">/)[0];
    body = body.replace(/<div class="focusBox[^"]*">[\s\S]*?<\/div>/g, '');
    return text(body);
}
async function allPages(url) {
    const first = await fetchPage(url);
    const base = url.replace(/\.shtml$/, '');
    const extra = [...new Set(links(first).map(link => new URL(link.url, url).href).filter(link => link.startsWith(`${base}_`) && /_\d+\.shtml$/.test(link)))]
        .sort((a, b) => Number(a.match(/_(\d+)\.shtml$/)[1]) - Number(b.match(/_(\d+)\.shtml$/)[1]));
    const bodies = [article(first)];
    for (const next of extra.slice(0, 9)) bodies.push(article(await fetchPage(next)));
    return { body: bodies.join('\n'), urls: [url, ...extra.slice(0, 9)] };
}
const entries = new Map();
for (let page = 1; page <= pages; page++) {
    const url = `https://www.zhongkao.com/czyw/ytxfd/ydt/${page === 1 ? '' : `index_${page}.shtml`}`;
    let html;
    try { html = await fetchPage(url); } catch (error) {
        if (error.message === 'HTTP_404') { console.log(JSON.stringify({ phase: 'index-end', page })); break; }
        throw error;
    }
    for (const link of links(html)) {
        if (/^https:\/\/www\.zhongkao\.com\/e\//.test(link.url) && /阅读|现代文/.test(link.title) &&
            !/方法|公式|题型|技巧|考点|指导|题解|术语|书目|汇总|大全|分类|得分|提分|真题汇编|审题|诀窍/.test(link.title)) entries.set(link.url, link.title);
    }
    if (page % 4 === 0) console.log(JSON.stringify({ phase: 'index', pages: page, entries: entries.size }));
}
await writeFile(join(root, 'inventory.json'), JSON.stringify([...entries].map(([url, title]) => ({ url, title })), null, 2));
const groups = new Map();
for (const [url, title] of entries) {
    const key = title.replace(/(?:参考)?答案|试题|题目|解析|及/g, '').replace(/练习题/g, '练习').replace(/\(\d+\)|（\d+）/g, '').trim();
    const group = groups.get(key) ?? { title: key };
    if (/及答案|含答案|附答案/.test(title)) group.question = group.answer = url;
    else if (/答案/.test(title)) group.answer = url; else group.question = url;
    groups.set(key, group);
}
// Many older pages contain passage, questions and answers together; importer verifies the answer boundary later.
const candidates = [...groups.values()].filter(group => group.question).map(group => ({ ...group, answer: group.answer ?? group.question }));
const imported = [], excluded = [];
let cursor = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < candidates.length) {
        const group = candidates[cursor++];
        try {
            const question = await allPages(group.question), answer = await allPages(group.answer);
            imported.push({ ...group, questionText: question.body, answerText: answer.body, questionUrls: question.urls, answerUrls: answer.urls,
                questionHash: digest(question.body), answerHash: digest(answer.body) });
        } catch (error) { excluded.push({ title: group.title, reason: error.message }); }
        if ((imported.length + excluded.length) % 20 === 0) console.log(JSON.stringify({ phase: 'articles', completed: imported.length + excluded.length, total: candidates.length }));
    }
}));
imported.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
await writeFile(join(root, 'public-reading-pages.json'), JSON.stringify({ source: 'https://www.zhongkao.com/czyw/ytxfd/ydt/', accessedAt: new Date().toISOString(),
    rights: 'Publicly accessible exam-preparation content; no blanket redistribution license is asserted. Raw pages and corpus remain local research assets.', imported, excluded }, null, 2));
console.log(JSON.stringify({ phase: 'complete', pairs: imported.length, excluded: excluded.length }));
