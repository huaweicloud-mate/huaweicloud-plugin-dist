import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asText } from "./lib/as-text.js";
import { asRecord } from "./lib/as-record.js";
import { redactEvidenceText } from "./safety/redact.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRulesPath = join(__dirname, '..', 'safety', 'rules', 'cloud-risk-rules.json');
const SEVERITY_RANK = {
    deny: 3,
    warn: 2,
    info: 1,
};
// Unknown severities normalize to 'info' (rank 1). The shipped JSON only emits
// deny/warn, so this branch is unreachable for valid catalogs.
function toSeverity(value) {
    return value === 'deny' || value === 'warn' || value === 'info' ? value : 'info';
}
function toCondition(value) {
    const raw = asRecord(value);
    return {
        field: typeof raw.field === 'string' ? raw.field : undefined,
        regex: typeof raw.regex === 'string' ? raw.regex : '',
    };
}
function toConditionList(value) {
    return Array.isArray(value) ? value.map((condition) => toCondition(condition)) : undefined;
}
function toMatch(value) {
    const raw = asRecord(value);
    return {
        all: toConditionList(raw.all),
        any: toConditionList(raw.any),
        none: toConditionList(raw.none),
    };
}
function toRule(value) {
    const raw = asRecord(value);
    return {
        id: typeof raw.id === 'string' ? raw.id : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        category: typeof raw.category === 'string' ? raw.category : '',
        severity: toSeverity(raw.severity),
        stages: Array.isArray(raw.stages) ? raw.stages.filter((stage) => typeof stage === 'string') : [],
        match: toMatch(raw.match),
        message: typeof raw.message === 'string' ? raw.message : '',
        remediation: typeof raw.remediation === 'string' ? raw.remediation : '',
    };
}
function toCatalog(value) {
    const raw = asRecord(value);
    return {
        version: typeof raw.version === 'string' ? raw.version : undefined,
        rules: Array.isArray(raw.rules) ? raw.rules.map((rule) => toRule(rule)) : [],
    };
}
export function loadRiskRules(options = {}) {
    const path = options.path || defaultRulesPath;
    return toCatalog(JSON.parse(readFileSync(path, 'utf8')));
}
function redactEvidence(text) {
    return redactEvidenceText(text);
}
function normalizeText(value) {
    if (typeof value === 'string')
        return value;
    return JSON.stringify(value, null, 2);
}
function evaluationContext(stage, input) {
    const record = asRecord(input);
    if (stage === 'command') {
        const command = normalizeText(record.command || record.text || '');
        return { text: command, command };
    }
    if (stage === 'artifact') {
        const path = asText(record.path || '');
        const content = normalizeText(record.content || '');
        return { text: `${path}\n${content}`, path, content };
    }
    if (stage === 'deploy_plan') {
        const plan = normalizeText(record.plan || record.text || input);
        return { text: plan, plan };
    }
    return { text: normalizeText(input) };
}
// Shell-transcribed commands and nested JSON artifacts arrive with escaped
// quotes (`\"Action\":` / `{\"privileged\":true}`) — the spelling a shell or
// an embedded JSON string actually produces. The catalog's JSON-shaped rules
// were authored against the unescaped spelling, so a backslash between the
// key and the quote made deny-severity rules (IAM administrator grants, OBS
// anonymous writes, privileged containers) silently miss. Matching therefore
// tests the raw value AND a quote-unescaped shadow; evidence/display keep the
// raw text. Only quote-adjacent backslashes are folded, so Windows paths are
// untouched.
function normalizeRuleText(text) {
    return text.replace(/\\+(["'])/g, '$1');
}
function conditionMatches(condition, context) {
    const field = condition.field || 'text';
    const value = Object.hasOwn(context, field) ? context[field] : context.text;
    const raw = String(value || '');
    const regex = new RegExp(condition.regex, 'ims');
    if (regex.test(raw))
        return true;
    const normalized = normalizeRuleText(raw);
    return normalized !== raw && regex.test(normalized);
}
function ruleMatches(rule, context) {
    const match = rule.match || {};
    const all = match.all;
    const any = match.any;
    const none = match.none;
    if (Array.isArray(all) && !all.every((condition) => conditionMatches(condition, context))) {
        return false;
    }
    if (Array.isArray(any) && !any.some((condition) => conditionMatches(condition, context))) {
        return false;
    }
    if (Array.isArray(none) && none.some((condition) => conditionMatches(condition, context))) {
        return false;
    }
    return Array.isArray(all) || Array.isArray(any);
}
function excerpt(text) {
    const compact = redactEvidence(String(text).replace(/\s+/g, ' ').trim());
    if (compact.length <= 240)
        return compact;
    return `${compact.slice(0, 237)}...`;
}
// One-property read off unknown, validated before use: only a string path is
// reported as a finding source (falling back to the stage label otherwise).
function inputPath(input) {
    if (input === null || typeof input !== 'object')
        return undefined;
    const path = input.path;
    return typeof path === 'string' ? path : undefined;
}
function evaluate(stage, inputs, options = {}) {
    const catalog = options.catalog || loadRiskRules(options);
    const items = Array.isArray(inputs) ? inputs : [inputs];
    const findings = [];
    for (const input of items) {
        const context = evaluationContext(stage, input || {});
        for (const rule of catalog.rules) {
            if (!rule.stages.includes(stage))
                continue;
            if (!ruleMatches(rule, context))
                continue;
            findings.push({
                ruleId: rule.id,
                title: rule.title,
                category: rule.category,
                severity: rule.severity,
                message: rule.message,
                remediation: rule.remediation,
                source: inputPath(input) || stage,
                evidence: excerpt(context.text),
            });
        }
    }
    findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const hasDeny = findings.some((finding) => finding.severity === 'deny');
    const hasWarn = findings.some((finding) => finding.severity === 'warn');
    return {
        decision: hasDeny ? 'deny' : hasWarn ? 'warn' : 'allow',
        findings,
    };
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function isNonEmptyContainer(value) {
    if (Array.isArray(value))
        return value.length > 0;
    if (value && typeof value === 'object')
        return Object.keys(value).length > 0;
    return false;
}
// A risk check that could not inspect its input must never report "allow"
// (fail-open) — it reports deny with an `invalid` risk and a synthetic finding
// so the reason is visible through the tool response (#564).
function invalidRiskResult(stage, reason) {
    return {
        decision: 'deny',
        risk: 'invalid',
        findings: [
            {
                ruleId: 'invalid-input',
                title: 'Invalid input for risk check',
                category: 'invalid',
                severity: 'deny',
                message: reason,
                remediation: 'Provide a valid, non-empty input before re-running the check.',
                source: stage,
                evidence: '',
            },
        ],
    };
}
export function evaluateCommandRisk(command, options = {}) {
    if (!isNonEmptyString(command)) {
        return invalidRiskResult('command', 'command must be a non-empty string.');
    }
    return evaluate('command', { command }, options);
}
export function evaluateArtifacts(artifacts, options = {}) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
        return invalidRiskResult('artifact', 'artifacts must be a non-empty array.');
    }
    return evaluate('artifact', artifacts, options);
}
export function evaluateDeployPlan(plan, options = {}) {
    const valid = isNonEmptyString(plan) || (plan != null && typeof plan === 'object' && isNonEmptyContainer(plan));
    if (!valid) {
        return invalidRiskResult('deploy_plan', 'plan must be a non-empty object, array, or string.');
    }
    return evaluate('deploy_plan', { plan }, options);
}
export function mergeRiskDecision(base, risk) {
    if (!risk || !risk.findings?.length)
        return base;
    if (risk.decision === 'deny') {
        // findings was checked non-empty at the top of this function.
        const topFinding = risk.findings[0];
        // The remediation rides the reason so every deny face that prints only the
        // reason (Node hook permissionDecisionReason, MCP assertAllowed errors)
        // still surfaces the actionable fix — the same format the py hook twin
        // emits (message + " Remediation: " + remediation).
        const reason = topFinding.remediation
            ? `${topFinding.message} Remediation: ${topFinding.remediation}`
            : topFinding.message;
        return {
            ...base,
            decision: 'deny',
            risk: topFinding.category,
            reason,
            blockedByRiskRule: true,
            findings: risk.findings,
        };
    }
    return {
        ...base,
        warnings: [...(base.warnings || []), ...risk.findings],
    };
}
