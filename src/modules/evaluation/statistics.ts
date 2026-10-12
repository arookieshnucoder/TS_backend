import type { CaseSummary, EvalReport, Rate, Trial } from "./contracts.js";

export function rate(successes: number, total: number): Rate {
    if (!Number.isInteger(total) || total < 1 || !Number.isInteger(successes) || successes < 0 || successes > total) throw new Error("Invalid rate sample");
    const p = successes / total, z = 1.959963984540054, denominator = 1 + z * z / total;
    const center = (p + z * z / (2 * total)) / denominator;
    const width = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
    return { value: p, successes, total, wilson95: [Math.max(0, center - width), Math.min(1, center + width)] };
}
export function reliability(n: number, successes: number, k: number): { passAtK: number; passPowerK: number } {
    if (!Number.isInteger(k) || k < 1 || k > n || !Number.isInteger(successes) || successes < 0 || successes > n) throw new Error("Invalid reliability sample");
    let noSuccess = 1, allSuccess = 1;
    for (let i = 0; i < k; i++) {
        noSuccess *= Math.max(0, n - successes - i) / (n - i);
        allSuccess *= Math.max(0, successes - i) / (n - i);
    }
    return { passAtK: 1 - noSuccess, passPowerK: allSuccess };
}
export function percentile(values: number[], p: number): number {
    if (!values.length || p < 0 || p > 1) throw new Error("Invalid percentile sample");
    const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function summarize(trials: Trial[]): Pick<EvalReport, "summary" | "cases"> {
    if (!trials.length) throw new Error("No trials to summarize");
    const groups = new Map<string, Trial[]>();
    const failureCounts: Record<string, number> = {};
    for (const t of trials) {
        groups.set(t.caseId, [...(groups.get(t.caseId) ?? []), t]);
        for (const f of t.grade.failures) failureCounts[f] = (failureCounts[f] ?? 0) + 1;
    }
    const cases: CaseSummary[] = [...groups].map(([id, items]) => {
        const successes = items.filter(t => t.grade.passed).length, passAtK: Record<string, number> = {}, passPowerK: Record<string, number> = {}, failures: Record<string, number> = {};
        for (const k of [1, 2, 3, 5, 10].filter(k => k <= items.length)) { const r = reliability(items.length, successes, k); passAtK[k] = r.passAtK; passPowerK[k] = r.passPowerK; }
        items.flatMap(t => t.grade.failures).forEach(f => { failures[f] = (failures[f] ?? 0) + 1; });
        return { id, category: items[0]!.category, kind: items[0]!.kind, passRate: rate(successes, items.length), allTrialsPassed: successes === items.length, passAtK, passPowerK, failures };
    });
    const subgroup = (kind: Trial["kind"]) => { const items = trials.filter(t => t.kind === kind); return items.length ? rate(items.filter(t => t.grade.passed).length, items.length) : null; };
    const dimensions: EvalReport["summary"]["dimensions"] = {};
    for (const key of ["factCoverage", "evidenceCoverage", "citationCoverage", "toolPrecision", "toolRecall", "argumentValidity"] as const) {
        const values = trials.map(t => t.grade[key]).filter((v): v is number => v !== null); dimensions[key] = { value: mean(values), applicableTrials: values.length };
    }
    dimensions.policyCompliance = { value: trials.filter(t => t.grade.policyCompliant).length / trials.length, applicableTrials: trials.length };
    const averages: Record<string, number | null> = {};
    for (const key of ["modelAttempts", "modelTurns", "toolCalls", "toolAttempts", "retries", "fallbacks", "compressions", "estimatedInputTokens", "reportedInputTokens", "reportedOutputTokens", "usageCoverage", "costUsd", "setupMs", "agentMs"] as const)
        averages[key] = mean(trials.map(t => t.metrics[key]).filter((v): v is number => v !== null));
    const recommendations: string[] = [];
    if (failureCounts.missing_facts) recommendations.push("优先检查答案事实覆盖及证据获取；逐条核查失败轨迹，排除评分器误判。");
    if (failureCounts.missing_required_tools || failureCounts.unexpected_tools) recommendations.push("改进工具说明与按问题选择工具的策略，平衡漏调与多余调用。");
    if (failureCounts.missing_citations) recommendations.push("加强证据来源引用，并校准引用是否真正支持对应结论。");
    if (Object.keys(failureCounts).some(f => /side_effect|forbidden|error_code/.test(f))) recommendations.push("权限、协议或副作用控制存在回归，应先修复边界再增加能力。");
    if (trials.some(t => t.outcome === "environment_error")) recommendations.push("先修复评测环境；环境失败不可作为正确拒绝计分。");
    if (!recommendations.length) recommendations.push("控制集已饱和：扩充真实任务、长链路和提示注入案例，补充独立人工标注后再评估模型能力。");
    return { cases, summary: { passRate: rate(trials.filter(t => t.grade.passed).length, trials.length), taskPassRate: subgroup("task"), controlPassRate: subgroup("control"), dimensions,
        latencyMs: { p50: percentile(trials.map(t => t.metrics.durationMs), .5), p95: percentile(trials.map(t => t.metrics.durationMs), .95), max: Math.max(...trials.map(t => t.metrics.durationMs)) }, averages, failureCounts, recommendations } };
}
export function assertComparable(candidate: Pick<EvalReport, "provenance"> & { cases: Pick<CaseSummary, "id">[] }, baseline: EvalReport): void {
    if (baseline.version !== 1 || !Array.isArray(baseline.cases) || !baseline.cases.length || !baseline.provenance || !baseline.summary ||
        !Number.isFinite(baseline.summary.passRate?.value) || baseline.summary.passRate.value < 0 || baseline.summary.passRate.value > 1 ||
        baseline.cases.some(c => !Number.isFinite(c.passRate?.value) || c.passRate.value < 0 || c.passRate.value > 1) ||
        new Set(baseline.cases.map(c => c.id)).size !== baseline.cases.length) throw new Error("Invalid baseline report");
    for (const field of ["mode", "datasetHash", "graderHash", "model", "providerFingerprint", "fallbackModel", "fallbackProviderFingerprint", "timeoutMs", "inputUsdPerMillion", "outputUsdPerMillion"] as const)
        if (candidate.provenance[field] !== baseline.provenance[field]) throw new Error(`Incompatible baseline: ${field}`);
    const ids = (r: { cases: Pick<CaseSummary, "id">[] }) => r.cases.map(c => c.id).sort().join("\0");
    if (ids(candidate) !== ids(baseline)) throw new Error("Incompatible baseline: case coverage");
}
export function compare(candidate: EvalReport, baseline: EvalReport): NonNullable<EvalReport["comparison"]> {
    assertComparable(candidate, baseline);
    const changes = candidate.cases.map(c => ({ id: c.id, delta: c.passRate.value - baseline.cases.find(b => b.id === c.id)!.passRate.value }));
    const dimensionDeltas: Record<string, number | null> = {};
    for (const [key, dimension] of Object.entries(candidate.summary.dimensions)) {
        const previous = baseline.summary.dimensions[key]?.value;
        dimensionDeltas[key] = dimension.value !== null && previous != null ? dimension.value - previous : null;
    }
    return { baselineRunId: baseline.runId, passRateDelta: candidate.summary.passRate.value - baseline.summary.passRate.value,
        p95DeltaMs: candidate.summary.latencyMs.p95 - baseline.summary.latencyMs.p95, dimensionDeltas,
        regressions: changes.filter(c => c.delta < 0).map(c => c.id), improvements: changes.filter(c => c.delta > 0).map(c => c.id) };
}
