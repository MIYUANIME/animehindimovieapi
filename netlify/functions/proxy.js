const axios = require('axios');

exports.handler = async (event) => {
    const headersOut = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Accept-Encoding',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Cache-Control'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: headersOut, body: '' };
    }

    const urlParam = event.queryStringParameters?.url;
    const refererParam = event.queryStringParameters?.referer;

    if (!urlParam) {
        return { statusCode: 400, headers: headersOut, body: JSON.stringify({ error: 'URL is required' }) };
    }

    const safeDecode = (value) => {
        if (!value) return value;
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };
    const sanitize = (value) => {
        if (!value) return value;
        return value.trim().replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    };
    const decodeRepeatedly = (value) => {
        let current = value;
        for (let i = 0; i < 3; i++) {
            const decoded = safeDecode(current);
            if (!decoded || decoded === current) {
                return decoded;
            }
            current = decoded;
        }
        return current;
    };

    let decodedUrl = sanitize(decodeRepeatedly(urlParam));
    let decodedRefererRaw = sanitize(decodeRepeatedly(refererParam));
    if (decodedUrl && decodedUrl.startsWith('//')) {
        decodedUrl = `https:${decodedUrl}`;
    }
    if (!decodedUrl) {
        return { statusCode: 400, headers: headersOut, body: JSON.stringify({ error: 'URL is required' }) };
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(decodedUrl);
    } catch {
        return { statusCode: 400, headers: headersOut, body: JSON.stringify({ error: 'Invalid URL' }) };
    }

    const rangeHeader = event.headers?.range;
    let decodedReferer = decodedRefererRaw || `${parsedUrl.origin}/`;
    let derivedOrigin = parsedUrl.origin;
    try {
        derivedOrigin = new URL(decodedReferer).origin;
    } catch {}

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': decodedReferer,
        'Accept': '*/*'
    };
    if (parsedUrl.hostname.endsWith('play.zephyrflick.top')) {
        decodedReferer = 'https://play.zephyrflick.top/';
        headers['Referer'] = decodedReferer;
    } else {
        headers['Origin'] = derivedOrigin;
    }
    if (rangeHeader) {
        headers['Range'] = rangeHeader;
    }

    try {
        const response = await axios({
            method: 'GET',
            url: decodedUrl,
            headers,
            responseType: 'arraybuffer',
            validateStatus: (status) => status < 500,
            timeout: 30000
        });

        const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
        const outHeaders = { ...headersOut, 'Content-Type': contentType };

        if (response.headers['content-length']) {
            outHeaders['Content-Length'] = response.headers['content-length'];
        }
        if (response.headers['content-range']) {
            outHeaders['Content-Range'] = response.headers['content-range'];
        }
        const acceptRanges = response.headers['accept-ranges'];
        outHeaders['Accept-Ranges'] = acceptRanges || 'bytes';

        if (decodedUrl.endsWith('.ts') || decodedUrl.endsWith('.m4s')) {
            outHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else if (decodedUrl.endsWith('.m3u8')) {
            outHeaders['Cache-Control'] = 'no-cache';
        }

        if (contentType.includes('mpegurl') || decodedUrl.endsWith('.m3u8')) {
            const content = Buffer.from(response.data).toString('utf-8');
            const basePath = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);
            const forwardedProto = event.headers?.['x-forwarded-proto'];
            const host = event.headers?.host || 'localhost';
            const baseUrl = `${forwardedProto || 'https'}://${host}`;
            const resolveUrl = (inputUrl) => {
                if (!inputUrl) return inputUrl;
                try {
                    const resolved = new URL(inputUrl, decodedUrl);
                    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
                        return inputUrl;
                    }
                    return resolved.toString();
                } catch {
                    return inputUrl;
                }
            };
            const toProxyUrl = (inputUrl) => {
                const resolved = resolveUrl(inputUrl);
                if (!resolved || (!resolved.startsWith('http://') && !resolved.startsWith('https://'))) {
                    return inputUrl;
                }
                const encodedUrl = encodeURIComponent(resolved);
                const encodedReferer = encodeURIComponent(decodedReferer);
                return `${baseUrl}/api/proxy?url=${encodedUrl}&referer=${encodedReferer}`;
            };

            const lines = content.split('\n');
            const newLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;
                if (line.startsWith('#')) {
                    const replacedQuoted = line.replace(/URI="([^"]+)"/g, (_, uriValue) => {
                        const proxied = toProxyUrl(uriValue);
                        return `URI="${proxied}"`;
                    });
                    const replacedUnquoted = replacedQuoted.replace(/URI=([^",\s]+)/g, (_, uriValue) => {
                        const proxied = toProxyUrl(uriValue);
                        return `URI=${proxied}`;
                    });
                    return replacedUnquoted;
                }
                let targetUrl = line;
                if (!line.startsWith('http')) {
                    targetUrl = basePath + line;
                }
                return toProxyUrl(targetUrl);
            });

            return {
                statusCode: response.status,
                headers: outHeaders,
                body: newLines.join('\n')
            };
        }

        const statusCode = response.status === 206 || response.headers['content-range'] ? 206 : response.status;
        return {
            statusCode,
            headers: outHeaders,
            body: Buffer.from(response.data).toString('base64'),
            isBase64Encoded: true
        };
    } catch (error) {
        if (error.response) {
            return {
                statusCode: error.response.status,
                headers: headersOut,
                body: `Upstream error: ${error.response.status}`
            };
        }
        return { statusCode: 500, headers: headersOut, body: `Proxy error: ${error.message}` };
    }
};
