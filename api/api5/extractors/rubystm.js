import axios from 'axios';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function normalizeHtml(html) {
    if (!html) return '';
    return html
        .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/\\u0026/g, '&');
}

function resolveStreamUrl(candidate, baseUrl) {
    if (!candidate) return null;
    if (candidate.startsWith('//')) {
        return `https:${candidate}`;
    }
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        return candidate;
    }
    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
}

function extractM3u8Urls(html, baseUrl) {
    const normalized = normalizeHtml(html);
    const urls = new Set();
    const absoluteRegex = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/g;
    const protocolRelativeRegex = /(\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/g;
    const quotedRegex = /"(?:file|source|src|url)"\s*:\s*"([^"]+\.m3u8[^"]*)"/g;
    const unquotedRegex = /(?:file|source|src|url)\s*:\s*'([^']+\.m3u8[^']*)'/g;
    const playerSrcRegex = /player\.src\(\s*[{[]?\s*(?:src\s*:\s*)?["']([^"']+\.m3u8[^"']*)["']/g;

    const collectMatches = (regex) => {
        let match;
        while ((match = regex.exec(normalized)) !== null) {
            const resolved = resolveStreamUrl(match[1], baseUrl);
            if (resolved) urls.add(resolved);
        }
    };

    let match;
    while ((match = absoluteRegex.exec(normalized)) !== null) {
        const resolved = resolveStreamUrl(match[1], baseUrl);
        if (resolved) urls.add(resolved);
    }

    while ((match = protocolRelativeRegex.exec(normalized)) !== null) {
        const resolved = resolveStreamUrl(match[1], baseUrl);
        if (resolved) urls.add(resolved);
    }

    collectMatches(quotedRegex);
    collectMatches(unquotedRegex);
    collectMatches(playerSrcRegex);

    return Array.from(urls);
}

function unpackPacker(p, a, c, k) {
    let result = p;
    const kArr = k.split('|');
    for (let i = c - 1; i >= 0; i--) {
        if (kArr[i]) {
            const re = new RegExp(`\\b${i.toString(a)}\\b`, 'g');
            result = result.replace(re, kArr[i]);
        }
    }
    return result;
}

function unpackPackedScript(html) {
    const match = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)\)\)/);
    if (!match) return null;
    const payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    const base = parseInt(match[2], 10);
    const count = parseInt(match[3], 10);
    const dict = match[4].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    if (!base || !count || !dict || count > 5000) return null;
    return unpackPacker(payload, base, count, dict);
}

function extractRubystmCode(playerUrl) {
    const match = playerUrl.match(/\/(?:e|d|v|embed)\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

function getOrigin(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function extractCookieHeader(setCookie) {
    if (!setCookie) return null;
    const items = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookies = items.map((entry) => String(entry).split(';')[0]).filter(Boolean);
    return cookies.length ? cookies.join('; ') : null;
}

export async function extractFromRubystm(playerUrl) {
    try {
        const userAgent = getRandomUserAgent();
        const headers = {
            'User-Agent': userAgent,
            'Referer': playerUrl,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        };

        const response = await axios.get(playerUrl, {
            headers,
            timeout: 8000,
            maxRedirects: 5
        });

        const html = response.data;
        const finalUrl = response?.request?.res?.responseUrl || playerUrl;
        const origin = getOrigin(finalUrl) || getOrigin(playerUrl);
        if (!origin) return null;
        const cookieHeader = extractCookieHeader(response.headers?.['set-cookie']);

        const directCandidates = extractM3u8Urls(html, origin);
        if (directCandidates.length > 0) {
            return {
                streamUrl: directCandidates[0],
                headers: {
                    'User-Agent': userAgent,
                    'Referer': `${origin}/`,
                    'Origin': origin
                }
            };
        }

        const code = extractRubystmCode(finalUrl);
        if (code) {
            const form = new URLSearchParams({
                op: 'embed',
                file_code: code,
                auto: '1',
                referer: ''
            });
            const dlResponse = await axios.post(`${origin}/dl`, form.toString(), {
                headers: {
                    'User-Agent': userAgent,
                    'Referer': playerUrl,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': origin,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
                },
                timeout: 8000,
                maxRedirects: 5
            });

            const dlHtml = String(dlResponse.data || '');
            const dlCandidates = extractM3u8Urls(dlHtml, origin);
            if (dlCandidates.length > 0) {
                return {
                    streamUrl: dlCandidates[0],
                    headers: {
                        'User-Agent': userAgent,
                        'Referer': `${origin}/`,
                        'Origin': origin
                    }
                };
            }

            const unpacked = unpackPackedScript(dlHtml);
            if (unpacked) {
                const unpackedCandidates = extractM3u8Urls(unpacked, origin);
                if (unpackedCandidates.length > 0) {
                    return {
                        streamUrl: unpackedCandidates[0],
                        headers: {
                            'User-Agent': userAgent,
                            'Referer': `${origin}/`,
                            'Origin': origin
                        }
                    };
                }
            }
        }

        return null;
    } catch {
        return null;
    }
}
