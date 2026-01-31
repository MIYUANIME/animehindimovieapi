const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

function ft(e) {
    let t = e.replace(/-/g, "+").replace(/_/g, "/");
    let r = 0 === t.length % 4 ? 0 : 4 - t.length % 4;
    let n = t + "=".repeat(r);
    return Buffer.from(n, 'base64');
}

function xn(e) {
    let t = e.map(part => ft(part));
    return Buffer.concat(t);
}

async function extractFromFilemoon(url) {
    try {
        const match = url.match(/\/(?:e|d)\/([0-9a-zA-Z]+)/);
        if (!match) {
            throw new Error('Invalid Filemoon URL format');
        }

        const mediaId = match[1];
        const parsedUrl = new URL(url);
        const host = parsedUrl.host;
        const apiUrl = `https://${host}/api/videos/${mediaId}/embed/playback`;

        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": url,
            "X-Requested-With": "XMLHttpRequest"
        };

        const response = await axios.get(apiUrl, { headers, timeout: 10000 });
        const data = response.data;

        let sources = null;

        if (data?.sources) {
            sources = data.sources;
        }

        if (!sources && data?.playback) {
            const pd = data.playback;
            try {
                const iv = ft(pd.iv);
                const key = xn(pd.key_parts);
                const payload = ft(pd.payload);

                const tagLength = 16;
                const ciphertext = payload.subarray(0, payload.length - tagLength);
                const tag = payload.subarray(payload.length - tagLength);

                const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
                decipher.setAuthTag(tag);
                let decrypted = decipher.update(ciphertext);
                decrypted = Buffer.concat([decrypted, decipher.final()]);

                const ct = JSON.parse(decrypted.toString('utf8'));
                sources = ct.sources;
            } catch {}
        }

        if (sources && sources.length > 0) {
            const source = sources.find(s => (s.file || s.url) && (s.file || s.url).includes('.m3u8')) || sources[0];
            const fileUrl = source.file || source.url;

            if (!fileUrl) {
                throw new Error("No valid file in sources");
            }

            return {
                streamUrl: fileUrl,
                headers: {
                    "User-Agent": headers["User-Agent"],
                    "Referer": `https://${host}/`
                }
            };
        }

        throw new Error('No video sources found');
    } catch {
        return null;
    }
}

async function findMovieById(id) {
    const moviesDir = path.resolve(__dirname, '../../api/api4/data/movies');
    const entries = await fs.readdir(moviesDir);
    const jsonFiles = entries.filter(file => file.endsWith('.json'));

    for (const file of jsonFiles) {
        const filePath = path.join(moviesDir, file);
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const movies = JSON.parse(content);
            if (!Array.isArray(movies)) {
                continue;
            }
            const found = movies.find(m => String(m.tmdb_id) === String(id));
            if (found) {
                return found;
            }
        } catch {
            continue;
        }
    }

    return null;
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Cache-Control': 's-maxage=300, stale-while-revalidate'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ status: 'error', message: 'Method not allowed. Use GET.' })
        };
    }

    const id = event.queryStringParameters?.id;
    if (!id) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ status: 'error', message: 'Missing required parameter: id (TMDB ID)' })
        };
    }

    try {
        const movie = await findMovieById(id);
        if (!movie) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ status: 'error', message: 'Movie not found in database', tmdb_id: id })
            };
        }
        if (!movie.url) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ status: 'error', message: 'Movie entry missing provider URL', tmdb_id: id })
            };
        }

        const result = await extractFromFilemoon(movie.url);

        if (!result || !result.streamUrl) {
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ status: 'error', message: 'Failed to extract stream from provider', provider_url: movie.url })
            };
        }

        const protocol = event.headers?.['x-forwarded-proto'] || 'https';
        const host = event.headers?.host || 'localhost';
        const baseUrl = `${protocol}://${host}`;
        const referer = result.headers?.Referer || movie.url;
        const proxyUrl = `${baseUrl}/api/proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(referer)}`;

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: 'success',
                tmdb_id: id,
                title: movie.title,
                data: {
                    stream_url: result.streamUrl,
                    proxy_url: proxyUrl,
                    headers: result.headers,
                    original_url: movie.url
                }
            })
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                status: 'error',
                message: 'Internal server error',
                details: error?.message || 'Unknown error'
            })
        };
    }
};
