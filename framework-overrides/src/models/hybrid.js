// mc-instructor · 混合大脑 v8: NVIDIA (免费) + Agnes (免费兜底)
// 说话= nemotron 专线 | 干活= 五模型轮转 | 记忆=双线对半 | 看图= VL
import OpenAIApi from 'openai';
import fs from 'fs';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

const DEFAULTS = {
    chat_model: 'deepseek-v4-pro',
    cheap_model: 'deepseek-flash',
    free_model: 'agnes-3.0-flash',
    nv_chat_model: 'nvidia/nemotron-3-ultra-550b-a55b',
    nv_vl_model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    kilo_model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    deepseek_url: 'https://api.deepseek.com',
    agnes_url: 'http://127.0.0.1:8268/v1',
    nvidia_url: 'http://127.0.0.1:18899/v1',
    kilo_url: 'http://127.0.0.1:18901/api/gateway/v1',
    max_tokens: 1600,
    temperature: 0.85,
    reasoning_effort: 'low',
};

// ===== 全局节流阀 (令牌桶并发: 只限速率不串行, 慢请求不再堵死队列) =====
// nv: 4模型轮转 × NIM 40RPM/模型 = 160/min上限, 取64留余量
// ag: 7key × 8/min = 56/min上限, 取48
// kilo: 免费池匿名网关, ultra 2s出字, 保守取24(池子共享别打满)
const THROTTLE = {
    nv: { perMin: 64, tokens: 64, lastRefill: Date.now() },
    ag: { perMin: 48, tokens: 48, lastRefill: Date.now() },
    kilo: { perMin: 24, tokens: 24, lastRefill: Date.now() },
};
function _refill(t) {
    const now = Date.now();
    if ((now - t.lastRefill) / 60000 >= 1) { t.tokens = t.perMin; t.lastRefill = now; }
}
async function _throttled(provider, fn) {
    const t = THROTTLE[provider];
    if (!t) return fn();
    _refill(t);
    let waited = 0;
    while (t.tokens <= 0 && waited < 90000) {
        await new Promise(r => setTimeout(r, 1500)); _refill(t); waited += 1500;
    }
    if (t.tokens <= 0) throw new Error('throttle: ' + provider + ' bucket empty');
    t.tokens -= 1;
    return fn();
}

// ===== NV 模型轮转 (剔除 minimax: 实测 53-67s 且常把预算全烧思考致正文为空) =====
const NV_ROTATE = [
    'deepseek-ai/deepseek-v4.1-flash',
    'z-ai/glm-5.3-flash',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
];
let _nvTurn = 0;
function _nextNvModel() { const m = NV_ROTATE[_nvTurn % NV_ROTATE.length]; _nvTurn++; return m; }
// auto/memory: nv 优先(快 1-3s), agnes 兜底(慢 2-30s)  -- 对半翻转已禁用
function _autoPlan() { return PLAN.auto; }

const PLAN = {
    chat:   [['nv', 'chat'], ['ag', 'free']],
    auto:   [['nv', 'cheap'], ['ag', 'free']],
    memory: [['nv', 'cheap'], ['ag', 'free']],
    decide: [['nv', 'cheap'], ['ag', 'free']],
    code:   [['nv', 'cheap'], ['ag', 'free']],
    vision: [['nv', 'vl'], ['ag', 'free']],
};

// ===== 本地哈希向量 =====
function hashEmbed(text, dim = 512) {
    const v = new Float64Array(dim);
    const s = String(text || '').toLowerCase();
    for (let i = 0; i < s.length; i++) {
        const a = s.charCodeAt(i);
        if (a <= 32) continue;
        v[(a * 31 + 7) % dim] += 1;
        if (i + 1 < s.length) v[(a * 131 + s.charCodeAt(i + 1) * 17 + 3) % dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, x => x / norm);
}

export class Hybrid {
    static prefix = 'hybrid';

    constructor(model_name, url, params = {}) {
        this.name = model_name;
        this.params = { ...DEFAULTS, ...(params || {}) };
        this.ds = null; this.ag = null; this.nv = null;

        if (hasKey('NVIDIA_API_KEY')) {
            this.nv = new OpenAIApi({ apiKey: getKey('NVIDIA_API_KEY'), baseURL: this.params.nvidia_url, timeout: 90000, maxRetries: 0 });
        } else { console.warn('[hybrid] NVIDIA_API_KEY missing'); }

        if (hasKey('DEEPSEEK_API_KEY')) {
            this.ds = new OpenAIApi({ apiKey: getKey('DEEPSEEK_API_KEY'), baseURL: this.params.deepseek_url, timeout: 60000, maxRetries: 0 });
        }

        if (hasKey('OPENAI_API_KEY')) {
            this.ag = new OpenAIApi({ apiKey: getKey('OPENAI_API_KEY'), baseURL: this.params.agnes_url, timeout: 150000, maxRetries: 0 });
        } else { console.warn('[hybrid] OPENAI_API_KEY missing'); }

        // kilo 免费池: 匿名网关, 无 key, ultra 最快 2s
        this.kilo = new OpenAIApi({ apiKey: 'kilo', baseURL: this.params.kilo_url, timeout: 60000, maxRetries: 0 });
    }

    _modelFor(provider, kind) {
        if (provider === 'kilo') return this.params.kilo_model;
        if (provider === 'nv') return kind === 'chat' ? this.params.nv_chat_model : (kind === 'vl' ? this.params.nv_vl_model : _nextNvModel());
        if (provider === 'ds') return kind === 'chat' ? this.params.chat_model : this.params.cheap_model;
        return this.params.free_model;
    }

    async _call(provider, kind, turns, systemMessage, stop_seq, purpose, extraTokens = 0) {
        return _throttled(provider, () => this._callInner(provider, kind, turns, systemMessage, stop_seq, purpose, extraTokens));
    }

    async _callInner(provider, kind, turns, systemMessage, stop_seq, purpose, extraTokens = 0) {
        const client = provider === 'nv' ? this.nv : (provider === 'ds' ? this.ds : (provider === 'kilo' ? this.kilo : this.ag));
        if (!client) throw new Error(provider + ' client unavailable');
        const model = this._modelFor(provider, kind);

        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns || []));
        const pack = { model, messages, max_tokens: this.params.max_tokens + extraTokens, temperature: this.params.temperature };
        if (stop_seq) pack.stop = stop_seq;
        if (provider === 'nv') pack.enable_thinking = (purpose === 'code');   // 仅代码生成开思考, 其余关掉提速
        if (provider === 'ds') {
            if (purpose === 'chat') pack.thinking = { type: 'disabled' };
            else if (this.params.reasoning_effort) pack.reasoning_effort = 'low';
        }

        const t0 = Date.now();
        const opts = provider === 'ag' ? { timeout: purpose === 'chat' ? 15000 : (this.params.agnes_timeout || 45000) } : (provider === 'kilo' ? { timeout: 60000 } : undefined);
        const completion = opts ? await client.chat.completions.create(pack, opts) : await client.chat.completions.create(pack);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const choice = completion.choices?.[0];
        const msg = choice?.message || {};
        let content = (msg.content || '').trim();
        const reasoning = msg.reasoning_content || '';
        const u = completion.usage || {};
        const line = `[hybrid] ${new Date().toISOString().slice(11, 19)} ${purpose} -> ${provider}/${model} ${elapsed}s (in ${u.prompt_tokens || 0}, out ${u.completion_tokens || 0}, content ${content.length}B)`;
        console.log(line);
        try { fs.appendFileSync((process.env.HYBRID_LOG || 'hybrid.log'), line + String.fromCharCode(10)); } catch (e) {}

        if (!content && reasoning && extraTokens < this.params.max_tokens) {
            return await this._call(provider, kind, turns, systemMessage, stop_seq, purpose, this.params.max_tokens);
        }
        if (choice?.finish_reason === 'length' && !content && extraTokens < this.params.max_tokens) {
            return await this._call(provider, kind, turns, systemMessage, stop_seq, purpose, this.params.max_tokens);
        }
        return content;
    }

    async sendRequest(turns, systemMessage, stop_seq = '***', purpose = 'chat') {
        const plan = (purpose === 'auto' || purpose === 'memory') ? _autoPlan() : (PLAN[purpose] || PLAN.chat);
        let lastErr = null;
        for (const [provider, kind] of plan) {
            // 同路重试1次: 超时/瞬断值得再敲一次门(429是配额, 重试无意义直接落下一路)
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const res = await this._call(provider, kind, turns, systemMessage, stop_seq, purpose);
                    if (typeof res === 'string') {
                        // 空内容/穿帮兜底话不认账, 落到下一路 (不再吐出"脑子嗡了")
                        if (res.trim() && !/脑子嗡了一下/.test(res)) return res;
                        lastErr = new Error('empty response');
                        break;
                    } else {
                        lastErr = new Error('non-string response');
                        break;
                    }
                } catch (err) {
                    lastErr = err;
                    const msg = String(err?.message || err);
                    const transient = /timed out|timeout|ECONN|socket|hang up|fetch failed/i.test(msg);
                    if (attempt === 1 && transient) {
                        console.warn(`[hybrid] ${provider} attempt1 ${msg.slice(0, 80)} -> retry once`);
                        await new Promise(r => setTimeout(r, 1200));
                        continue;
                    }
                    console.warn(`[hybrid] ${provider} failed: ${msg.slice(0, 160)}`);
                    try { fs.appendFileSync((process.env.HYBRID_LOG || 'hybrid.log'), `[hybrid] FAIL ${new Date().toISOString().slice(11, 19)} ${purpose} ${provider} :: ${msg.slice(0, 220)}${String.fromCharCode(10)}`); } catch (e) {}
                    break;
                }
            }
        }
        console.error('[hybrid] all routes failed:', lastErr?.message || lastErr);
        return '(脑子嗡了一下,再说一遍嘛)';
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        if (!this.nv && !this.ds) return 'Vision 暂时看不了。';
        const imageMessages = strictFormat(messages || []).concat([{
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` } },
            ],
        }]);
        try {
            const r = await (this.nv || this.ds).chat.completions.create({
                model: this.nv ? this.params.nv_vl_model : this.params.cheap_model,
                messages: imageMessages,
                max_tokens: 900,
            });
            return r.choices?.[0]?.message?.content || '';
        } catch (err) {
            console.warn('[hybrid] vision failed:', String(err?.message || err).slice(0, 120));
            return 'Vision 暂时看不了。';
        }
    }

    async embed(text) { return hashEmbed(text); }
}
