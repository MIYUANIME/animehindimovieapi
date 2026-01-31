import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function findMovieById(id) {
    const moviesDir = path.join(__dirname, 'data', 'movies');
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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ status: 'error', message: 'Method not allowed. Use GET.' });
    }

    const { id } = req.query;

    if (!id) {
        return res.status(400).json({
            status: 'error',
            message: 'Missing required parameter: id (TMDB ID)'
        });
    }

    try {
        const movie = await findMovieById(id);

        if (!movie) {
            return res.status(404).json({
                status: 'error',
                message: 'Movie not found in database',
                tmdb_id: id
            });
        }

        if (!movie.url) {
            return res.status(500).json({
                status: 'error',
                message: 'Movie entry missing provider URL',
                tmdb_id: id
            });
        }

        const { extractFromFilemoon } = await import('./extractors/filemoon.js');
        const result = await extractFromFilemoon(movie.url);

        if (!result || !result.streamUrl) {
            return res.status(502).json({
                status: 'error',
                message: 'Failed to extract stream from provider',
                provider_url: movie.url
            });
        }

        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const baseUrl = `${protocol}://${host}`;
        const referer = result.headers?.Referer || movie.url;
        const proxyUrl = `${baseUrl}/api/proxy?url=${encodeURIComponent(result.streamUrl)}&referer=${encodeURIComponent(referer)}`;

        return res.status(200).json({
            status: 'success',
            tmdb_id: id,
            title: movie.title,
            data: {
                stream_url: result.streamUrl,
                proxy_url: proxyUrl,
                headers: result.headers,
                original_url: movie.url
            }
        });
    } catch (error) {
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error',
            details: error?.message || 'Unknown error'
        });
    }
}
