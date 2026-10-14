// x402 challenge parsing and validation. Ported from Delivery Score (MIT,
// https://github.com/ttimesai-star/delivery-score, src/lib.mjs). Pure functions, no network.

// USDC contracts per network (Circle docs). Amounts are in 6-decimal base units.
export const USDC = {
    'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    'eip155:137': '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    'eip155:42161': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    'eip155:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'eip155:10': '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    'eip155:43114': '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

// x402 v1 used plain network names; v2 uses CAIP-2 ids.
export const V1_NETWORKS = {
    base: 'eip155:8453',
    'base-sepolia': 'eip155:84532',
    polygon: 'eip155:137',
    'polygon-amoy': 'eip155:80002',
    avalanche: 'eip155:43114',
    'avalanche-fuji': 'eip155:43113',
    solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    iotex: 'eip155:4689',
    sei: 'eip155:1329',
    'sei-testnet': 'eip155:1328',
    peaq: 'eip155:3338',
    xlayer: 'eip155:196',
};

export const NETWORK_NAMES = {
    'eip155:1': 'Ethereum',
    'eip155:10': 'Optimism',
    'eip155:137': 'Polygon',
    'eip155:8453': 'Base',
    'eip155:84532': 'Base Sepolia (testnet)',
    'eip155:42161': 'Arbitrum One',
    'eip155:43114': 'Avalanche C-Chain',
    'eip155:43113': 'Avalanche Fuji (testnet)',
    'eip155:80002': 'Polygon Amoy (testnet)',
    'eip155:1329': 'Sei',
    'eip155:1328': 'Sei testnet',
    'eip155:4689': 'IoTeX',
    'eip155:3338': 'peaq',
    'eip155:196': 'X Layer',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana devnet',
};

export const TESTNETS = new Set([
    'eip155:84532', 'eip155:80002', 'eip155:43113', 'eip155:1328', 'eip155:11155111',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
]);
export const KNOWN_SCHEMES = new Set(['exact', 'upto', 'batch-settlement', 'deferred', 'aggr_deferred', 'agent-pay']);

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const B58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const caip = (n) => (typeof n === 'string' && n.includes(':') ? n : V1_NETWORKS[n] ?? null);
export const family = (n) => (n?.startsWith('eip155:') ? 'evm' : n?.startsWith('solana:') ? 'solana' : n ? n.split(':')[0] : null);

function addrOk(fam, a) {
    if (typeof a !== 'string') return false;
    if (fam === 'evm') return EVM_ADDR.test(a) && !/^0x0{40}$/.test(a);
    if (fam === 'solana') return B58_ADDR.test(a);
    return a.length > 0;
}

/** True when the asset is the canonical USDC contract of a known network. */
export function isUsdc(network, asset) {
    const n = caip(network);
    const usdc = USDC[n];
    if (!usdc || typeof asset !== 'string') return false;
    return family(n) === 'evm' ? asset.toLowerCase() === usdc : asset === usdc;
}

/** Price in USD when the asset is USDC on a known network, else null. */
export function usdPrice(acc) {
    if (!isUsdc(acc.network, acc.asset) || !/^\d+$/.test(String(acc.amount ?? ''))) return null;
    return Number(acc.amount) / 1e6;
}

/** Extracts the payment challenge from a 402 response (v2 header, v1 body, or v2 body). */
export function parseChallenge(headers, bodyText) {
    const h = headers.get('payment-required');
    if (h) {
        try {
            return { source: 'header', value: JSON.parse(Buffer.from(h, 'base64').toString('utf8')) };
        } catch {
            return { source: 'header', error: 'PAYMENT-REQUIRED header is not base64 JSON' };
        }
    }
    try {
        const v = JSON.parse(bodyText);
        if (v && typeof v === 'object' && ('accepts' in v || 'x402Version' in v)) return { source: 'body', value: v };
        return { source: 'body', error: '402 body has no x402 fields' };
    } catch {
        return { source: 'none', error: 'no PAYMENT-REQUIRED header and the body is not JSON' };
    }
}

/** Validates one challenge. Returns facts (issues), never verdicts about the seller. */
export function validateChallenge(ch) {
    const issues = [];
    const v = ch.value;
    if (!v || typeof v !== 'object') return { ok: false, issues: [ch.error ?? 'challenge is not an object'], version: null, accepts: [] };
    if (![1, 2].includes(v.x402Version)) issues.push(`x402Version is ${JSON.stringify(v.x402Version)}, expected 1 or 2`);
    if (!Array.isArray(v.accepts) || v.accepts.length === 0) {
        issues.push('accepts is missing or empty');
        return { ok: false, issues, version: v.x402Version ?? null, accepts: [] };
    }
    const accepts = v.accepts.map((raw, i) => {
        const a = raw && typeof raw === 'object' ? raw : {};
        const amount = a.amount ?? a.maxAmountRequired;
        const network = caip(a.network);
        const fam = family(network);
        const p = [];
        if (!KNOWN_SCHEMES.has(a.scheme)) p.push(`accepts[${i}].scheme "${a.scheme}" is not a known x402 scheme`);
        if (!network) p.push(`accepts[${i}].network "${a.network}" is not recognised`);
        if (!addrOk(fam, a.payTo)) p.push(`accepts[${i}].payTo "${a.payTo}" is not a valid ${fam ?? '?'} address`);
        if (!addrOk(fam, a.asset)) p.push(`accepts[${i}].asset "${a.asset}" is not a valid ${fam ?? '?'} address`);
        if (!/^\d+$/.test(String(amount ?? '')) || BigInt(amount) <= 0n) p.push(`accepts[${i}].amount "${amount}" is not a positive integer`);
        if (a.maxTimeoutSeconds !== undefined && !(Number(a.maxTimeoutSeconds) > 0)) p.push(`accepts[${i}].maxTimeoutSeconds is not positive`);
        if (fam === 'evm' && a.scheme === 'exact' && isUsdc(network, a.asset) && !a.extra?.name) {
            p.push(`accepts[${i}].extra.name (EIP-712 domain) is missing`);
        }
        issues.push(...p);
        return {
            scheme: a.scheme ?? null,
            network,
            networkName: NETWORK_NAMES[network] ?? null,
            asset: a.asset ?? null,
            assetSymbol: isUsdc(network, a.asset) ? 'USDC' : null,
            amount: amount === undefined || amount === null ? null : String(amount),
            priceUsd: usdPrice({ ...a, amount, network }),
            payTo: a.payTo ?? null,
            maxTimeoutSeconds: a.maxTimeoutSeconds ?? null,
            testnet: TESTNETS.has(network),
            ok: p.length === 0,
        };
    });
    return { ok: accepts.some((a) => a.ok), issues, version: v.x402Version ?? null, accepts };
}

/** Normalises a resource URL for comparison: lower-case host, no trailing slash, no fragment. */
export function normUrl(u) {
    try {
        const x = new URL(u);
        x.hash = '';
        x.host = x.host.toLowerCase();
        let s = x.toString();
        if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
        else if (x.pathname === '/' && !x.search) s = s.slice(0, -1);
        return s;
    } catch {
        return String(u);
    }
}

/** Compares the live challenge with a catalogue listing. */
export function compareWithListing(liveAccepts, listedAccepts) {
    const key = (n, p) => `${caip(n)}|${String(p).toLowerCase()}`;
    const live = new Set(liveAccepts.map((a) => key(a.network, a.payTo)));
    const listed = (listedAccepts ?? []).map((a) => ({ ...a, amount: a.amount ?? a.maxAmountRequired }));
    return {
        payToMatch: listed.some((a) => live.has(key(a.network, a.payTo))),
        priceMatch: listed.some((a) => liveAccepts.some((b) => caip(a.network) === b.network && String(a.amount) === b.amount)),
    };
}
