#!/usr/bin/env node
'use strict';

/**
 * Qwen client — OpenAI-compatible chat completions against a local model
 * server (mlx_lm.server / mlx-serve, Ollama, vLLM all speak the same shape).
 *
 * Config (environment, normally from .env):
 *   QWEN_BASE_URL   e.g. http://qwen-mac:8080/v1   (required)
 *   QWEN_MODEL      the model name the server expects (required)
 *   QWEN_API_KEY    optional bearer token (mlx-serve / MLX need none)
 *
 *   askJson({ system, user, schemaHint, validate, timeoutMs, fetchImpl })
 *     -> { ok: true, value, latencyMs, model, attempts }
 *     -> { ok: false, error, raw, latencyMs, model }
 *   isConfigured() -> bool
 *   ping({ fetchImpl }) -> { ok, model, latencyMs, error }
 *
 * Every request is temperature 0 and JSON-only; the response content has its
 * code fences (and any <think> block) stripped before JSON.parse. A parse or
 * validation failure is retried ONCE with a reminder; a network error, a
 * timeout, or a second failure yields ok:false. Nothing here throws.
 *
 *   node scripts/lib/qwenClient.js --ping     prints model + latency
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 1200;   // a hard play can draw a long `reasoning`; a cut-off answer is retried with a brevity reminder

function config(env = process.env) {
    return {
        baseUrl: String(env.QWEN_BASE_URL || '').trim().replace(/\/+$/, ''),
        model: String(env.QWEN_MODEL || '').trim(),
        apiKey: String(env.QWEN_API_KEY || '').trim()
    };
}

function isConfigured(env = process.env) {
    const c = config(env);
    return !!(c.baseUrl && c.model);
}

/** Strip a <think>…</think> block, markdown fences, and prose around the object; then JSON.parse. */
function extractJson(text) {
    let t = String(text === undefined || text === null ? '' : text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) t = fence[1].trim();
    if (!t.startsWith('{')) {
        const i = t.indexOf('{'), j = t.lastIndexOf('}');
        if (i >= 0 && j > i) t = t.slice(i, j + 1);
    }
    return JSON.parse(t);
}

/**
 * One chat completion. Resolves { ok, content, latencyMs, model, error, raw }; never rejects.
 */
async function chat(messages, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, maxTokens = DEFAULT_MAX_TOKENS, env = process.env } = {}) {
    const c = config(env);
    const f = fetchImpl || globalThis.fetch;
    const started = Date.now();
    if (!c.baseUrl || !c.model) return { ok: false, content: null, latencyMs: 0, model: c.model || null, error: 'Qwen not configured (QWEN_BASE_URL / QWEN_MODEL)', raw: null };
    if (typeof f !== 'function') return { ok: false, content: null, latencyMs: 0, model: c.model, error: 'no fetch implementation available', raw: null };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, timeoutMs);
    if (timer.unref) timer.unref();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
    const body = {
        model: c.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        // Qwen3 emits its reasoning as text unless thinking is switched off; servers
        // that do not know the field ignore it.
        chat_template_kwargs: { enable_thinking: false }
    };
    try {
        const res = await f(`${c.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller ? controller.signal : undefined });
        const latencyMs = Date.now() - started;
        let text = '';
        try { text = await res.text(); } catch (_) { text = ''; }
        if (!res.ok) return { ok: false, content: null, latencyMs, model: c.model, error: `HTTP ${res.status} from ${c.baseUrl}/chat/completions: ${String(text).slice(0, 200)}`, raw: text };
        let json;
        try { json = JSON.parse(text); } catch (e) { return { ok: false, content: null, latencyMs, model: c.model, error: `response is not JSON: ${e.message}`, raw: text }; }
        const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
        const content = choice && choice.message ? choice.message.content : (choice && choice.text) || null;
        if (typeof content !== 'string') return { ok: false, content: null, latencyMs, model: json.model || c.model, error: 'response has no choices[0].message.content', raw: text };
        const finishReason = choice && choice.finish_reason ? String(choice.finish_reason) : null;
        return { ok: true, content, latencyMs, model: json.model || c.model, error: null, raw: text, finishReason, truncated: finishReason === 'length' };
    } catch (e) {
        const latencyMs = Date.now() - started;
        const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
        const cause = e && e.cause ? ` (${e.cause.code || ''}${e.cause.code && e.cause.message ? ': ' : ''}${e.cause.message || ''})` : '';
        return { ok: false, content: null, latencyMs, model: c.model, error: timedOut ? `timeout after ${timeoutMs} ms` : `network error: ${e && e.message ? e.message : String(e)}${cause}`, raw: null };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Ask for one JSON object. `validate(value) -> string[]` (empty = valid) is
 * optional; a parse or validation failure is retried once with a reminder.
 */
async function askJson({ system, user, schemaHint, validate, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, maxTokens = DEFAULT_MAX_TOKENS, env = process.env } = {}) {
    if (!isConfigured(env)) return { ok: false, error: 'Qwen not configured (QWEN_BASE_URL / QWEN_MODEL)', raw: null, latencyMs: 0, model: null };
    const sys = [system || 'You answer with exactly one JSON object and nothing else: no prose, no markdown fences, no reasoning text.', schemaHint ? `OUTPUT JSON SCHEMA:\n${typeof schemaHint === 'string' ? schemaHint : JSON.stringify(schemaHint, null, 1)}` : null].filter(Boolean).join('\n\n');
    const messages = [{ role: 'system', content: sys }, { role: 'user', content: String(user || '') }];
    let totalLatency = 0;
    let lastRaw = null;
    let lastError = null;
    let model = null;
    let budget = maxTokens;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await chat(messages, { timeoutMs, fetchImpl, maxTokens: budget, env });
        totalLatency += r.latencyMs || 0;
        model = r.model || model;
        if (!r.ok) return { ok: false, error: r.error, raw: r.raw, latencyMs: totalLatency, model };
        lastRaw = r.content;
        let value;
        try { value = extractJson(r.content); } catch (e) { lastError = `not JSON: ${e.message}`; }
        if (value !== undefined) {
            const errors = typeof validate === 'function' ? (validate(value) || []) : [];
            if (!errors.length) return { ok: true, value, latencyMs: totalLatency, model, attempts: attempt };
            lastError = errors.join('; ');
        }
        // A cut-off answer (token limit) is a length problem, not a judgement
        // problem: retry with twice the budget and ask for brief reasoning.
        const cutOff = r.truncated || (value === undefined && /unterminated|unexpected end/i.test(lastError || ''));
        if (cutOff) { lastError = `answer cut off at the ${budget}-token limit (${lastError})`; budget *= 2; }
        if (attempt === 1) {
            messages.push({ role: 'assistant', content: String(r.content).slice(0, 4000) });
            messages.push({ role: 'user', content: cutOff
                ? `REMINDER: your previous answer was cut off at the token limit. Answer again with the SAME JSON object, but keep "reasoning" to at most three short sentences (the possession fact and the rule it triggers). Output ONLY the JSON object.`
                : `REMINDER: your previous output was not valid (${lastError}). Output ONLY the JSON object, with every required field, and nothing else.` });
        }
    }
    return { ok: false, error: `invalid after retry: ${lastError}`, raw: lastRaw, latencyMs: totalLatency, model };
}

/** Round trip with a trivial JSON request. */
async function ping({ fetchImpl, timeoutMs = 15000, env = process.env } = {}) {
    if (!isConfigured(env)) return { ok: false, model: null, latencyMs: 0, error: 'Qwen not configured (QWEN_BASE_URL / QWEN_MODEL)' };
    const r = await askJson({ user: 'Reply with the JSON {"ok":true}', validate: v => (v && v.ok === true ? [] : ['expected {"ok":true}']), timeoutMs, fetchImpl, maxTokens: 50, env });
    return { ok: r.ok, model: r.model || config(env).model, latencyMs: r.latencyMs, error: r.ok ? null : r.error };
}

if (require.main === module) {
    try { require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') }); } catch (_) { /* dotenv optional */ }
    if (process.argv.includes('--ping')) {
        ping().then(r => {
            if (r.ok) console.log(`qwen ok: model ${r.model}, ${r.latencyMs} ms (${config().baseUrl})`);
            else console.log(`qwen FAILED: ${r.error}${config().baseUrl ? ` (${config().baseUrl})` : ''}`);
            process.exit(r.ok ? 0 : 1);
        });
    } else {
        console.log('Usage: node scripts/lib/qwenClient.js --ping');
        console.log(`configured: ${isConfigured()} (QWEN_BASE_URL=${config().baseUrl || '<unset>'}, QWEN_MODEL=${config().model || '<unset>'})`);
    }
}

module.exports = { askJson, chat, ping, isConfigured, extractJson, config, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOKENS };
