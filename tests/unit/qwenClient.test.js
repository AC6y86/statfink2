/**
 * scripts/lib/qwenClient.js — OpenAI-compatible JSON client with a fake fetch.
 * No network, no env leakage (env is injected per call).
 */
const { askJson, ping, isConfigured, extractJson, config } = require('../../scripts/lib/qwenClient');

const ENV = { QWEN_BASE_URL: 'http://qwen.test:8080/v1/', QWEN_MODEL: 'qwen-test', QWEN_API_KEY: '' };

function completion(content, extra = {}) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'qwen-test-served', choices: [{ message: { role: 'assistant', content } }], ...extra }) };
}

function fakeFetch(responses) {
    const calls = [];
    const f = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
        const next = responses.shift();
        if (typeof next === 'function') return next(init);
        if (next instanceof Error) throw next;
        return next;
    };
    f.calls = calls;
    return f;
}

describe('config', () => {
    test('isConfigured needs both base url and model; trailing slash is stripped', () => {
        expect(isConfigured({})).toBe(false);
        expect(isConfigured({ QWEN_BASE_URL: 'http://x' })).toBe(false);
        expect(isConfigured(ENV)).toBe(true);
        expect(config(ENV).baseUrl).toBe('http://qwen.test:8080/v1');
    });

    test('extractJson strips <think> blocks, fences and prose', () => {
        expect(extractJson('<think>hmm</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(extractJson('Sure: {"a":1}.')).toEqual({ a: 1 });
        expect(() => extractJson('')).toThrow();
    });
});

describe('askJson', () => {
    test('happy path: posts the OpenAI shape (temperature 0, thinking off) and parses fenced JSON', async () => {
        const f = fakeFetch([completion('```json\n{"awardClass":"OFF_RECOVERY","confidence":"certain"}\n```')]);
        const r = await askJson({ system: 'JSON only', user: 'decide', schemaHint: { type: 'object' }, fetchImpl: f, env: ENV });
        expect(r.ok).toBe(true);
        expect(r.value).toEqual({ awardClass: 'OFF_RECOVERY', confidence: 'certain' });
        expect(r.model).toBe('qwen-test-served');
        expect(typeof r.latencyMs).toBe('number');
        expect(r.attempts).toBe(1);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].url).toBe('http://qwen.test:8080/v1/chat/completions');
        const body = f.calls[0].body;
        expect(body).toMatchObject({ model: 'qwen-test', temperature: 0, max_tokens: 1200, chat_template_kwargs: { enable_thinking: false } });
        expect(body.messages[0]).toMatchObject({ role: 'system' });
        expect(body.messages[0].content).toContain('JSON only');
        expect(body.messages[0].content).toContain('"type": "object"');
        expect(body.messages[1]).toEqual({ role: 'user', content: 'decide' });
        expect(f.calls[0].headers.Authorization).toBeUndefined();
    });

    test('sends a bearer token when QWEN_API_KEY is set', async () => {
        const f = fakeFetch([completion('{"ok":true}')]);
        await askJson({ user: 'x', fetchImpl: f, env: { ...ENV, QWEN_API_KEY: 'sekret' } });
        expect(f.calls[0].headers.Authorization).toBe('Bearer sekret');
    });

    test('invalid JSON then valid: exactly one retry carrying a reminder', async () => {
        const f = fakeFetch([completion('I think it is OFF_RUSH'), completion('{"awardClass":"OFF_RUSH"}')]);
        const r = await askJson({ user: 'decide', fetchImpl: f, env: ENV });
        expect(r.ok).toBe(true);
        expect(r.value).toEqual({ awardClass: 'OFF_RUSH' });
        expect(r.attempts).toBe(2);
        expect(f.calls).toHaveLength(2);
        const msgs = f.calls[1].body.messages;
        expect(msgs).toHaveLength(4);
        expect(msgs[2]).toEqual({ role: 'assistant', content: 'I think it is OFF_RUSH' });
        expect(msgs[3].role).toBe('user');
        expect(msgs[3].content).toMatch(/REMINDER.*not JSON/);
    });

    test('a validate() rejection is retried once; two failures -> ok:false with the raw text', async () => {
        const f = fakeFetch([completion('{"awardClass":"NOPE"}'), completion('{"awardClass":"STILL_NOPE"}')]);
        const validate = v => (['OFF_RUSH'].includes(v.awardClass) ? [] : ['awardClass must be OFF_RUSH']);
        const r = await askJson({ user: 'decide', validate, fetchImpl: f, env: ENV });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/invalid after retry: awardClass must be OFF_RUSH/);
        expect(r.raw).toBe('{"awardClass":"STILL_NOPE"}');
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1].body.messages[3].content).toMatch(/awardClass must be OFF_RUSH/);
    });

    test('an answer cut off at the token limit is retried once with a brevity reminder and double the budget', async () => {
        const cut = '{"awardClass":"DEF_8_FUMBLE","reasoning":"The kickoff was recovered by the kicking team which means the ball changed possession and';
        const f = fakeFetch([completion(cut, { choices: [{ message: { role: 'assistant', content: cut }, finish_reason: 'length' }] }), completion('{"awardClass":"DEF_8_FUMBLE","reasoning":"Kicking team recovered the kickoff: a takeaway."}')]);
        const r = await askJson({ user: 'decide', fetchImpl: f, env: ENV, maxTokens: 600 });
        expect(r.ok).toBe(true);
        expect(r.value.awardClass).toBe('DEF_8_FUMBLE');
        expect(f.calls).toHaveLength(2);
        expect(f.calls[0].body.max_tokens).toBe(600);
        expect(f.calls[1].body.max_tokens).toBe(1200);
        expect(f.calls[1].body.messages[3].content).toMatch(/cut off at the token limit.*three short sentences/);
    });

    test('an unterminated JSON string with no finish_reason is treated as cut off too', async () => {
        const f = fakeFetch([completion('{"awardClass":"OFF_RUSH","reasoning":"a very long story that never'), completion('{"awardClass":"OFF_RUSH","reasoning":"short"}')]);
        const r = await askJson({ user: 'decide', fetchImpl: f, env: ENV });
        expect(r.ok).toBe(true);
        expect(f.calls[1].body.max_tokens).toBe(2400);
        expect(f.calls[1].body.messages[3].content).toMatch(/cut off/);
    });

    test('network error -> ok:false, no retry', async () => {
        const f = fakeFetch([new Error('connect ECONNREFUSED')]);
        const r = await askJson({ user: 'x', fetchImpl: f, env: ENV });
        expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/network error: connect ECONNREFUSED/), raw: null });
        expect(f.calls).toHaveLength(1);
    });

    test('timeout aborts the request -> ok:false', async () => {
        const f = fakeFetch([init => new Promise((_, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); })]);
        const r = await askJson({ user: 'x', fetchImpl: f, env: ENV, timeoutMs: 20 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/timeout after 20 ms/);
    });

    test('HTTP error and malformed envelope -> ok:false', async () => {
        const f = fakeFetch([{ ok: false, status: 503, text: async () => 'busy' }]);
        const r = await askJson({ user: 'x', fetchImpl: f, env: ENV });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/HTTP 503/);
        const g = fakeFetch([{ ok: true, status: 200, text: async () => '{"choices":[]}' }]);
        const r2 = await askJson({ user: 'x', fetchImpl: g, env: ENV });
        expect(r2.ok).toBe(false);
        expect(r2.error).toMatch(/choices\[0\]\.message\.content/);
    });

    test('not configured -> ok:false without calling fetch', async () => {
        const f = fakeFetch([completion('{"ok":true}')]);
        const r = await askJson({ user: 'x', fetchImpl: f, env: {} });
        expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not configured/) });
        expect(f.calls).toHaveLength(0);
    });
});

describe('ping', () => {
    test('shape on success and on failure', async () => {
        const f = fakeFetch([completion('{"ok":true}')]);
        const r = await ping({ fetchImpl: f, env: ENV });
        expect(r).toEqual({ ok: true, model: 'qwen-test-served', latencyMs: expect.any(Number), error: null });
        expect(f.calls[0].body.max_tokens).toBe(50);
        const g = fakeFetch([new Error('ECONNREFUSED')]);
        const r2 = await ping({ fetchImpl: g, env: ENV });
        expect(r2).toEqual({ ok: false, model: 'qwen-test', latencyMs: expect.any(Number), error: expect.stringMatching(/ECONNREFUSED/) });
        const r3 = await ping({ fetchImpl: g, env: {} });
        expect(r3).toMatchObject({ ok: false, model: null, error: expect.stringMatching(/not configured/) });
    });
});
