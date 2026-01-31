const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

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

        const extractorPath = path.resolve(__dirname, '../../api/api4/extractors/filemoon.js');
        const { extractFromFilemoon } = await import(pathToFileURL(extractorPath).href);
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
