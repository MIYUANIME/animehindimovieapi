import axios from 'axios';
import { extractFromRubystm } from './extractors/rubystm.js';

function buildToonstreamUrl({ id, type, season, episode }) {
    if (type === 'tv') {
        return `https://toonstream.world/episode/${id}-${season}x${episode}/`;
    }
    return `https://toonstream.world/movies/${id}/`;
}

function normalizeHtml(html) {
    if (!html) return '';
    return html
        .replace(/\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/\u0026/g, '&');
}

function findRubystmUrl(html) {
    const normalized = normalizeHtml(html);
    const regex = /https:\/\/rubystm\.com\/(?:e|embed|d|v)\/[a-zA-Z0-9]+[^\s"'<>]*/g;
    const matches = normalized.match(regex) || [];
    return matches.length > 0 ? matches[0] : null;
}

export default async function handler(req, res) {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
        res.setHeader('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        if (req.method !== 'GET') {
            return res.status(405).json({
                status: 'error',
                message: 'Method not allowed. Use GET.'
            });
        }

        const query = req.query || {};
        const { id, type, season, episode } = query;

        if (!id || !type) {
            return res.status(400).json({
                status: 'error',
                message: 'Missing required parameters',
                required: {
                    id: 'Anime/Movie ID (e.g., summer-time-rendering-season-1-117933)',
                    type: "'tv' or 'movie'",
                    season: 'Required for TV (e.g., 1)',
                    episode: 'Required for TV (e.g., 2)'
                },
                examples: {
                    tv: '/api5?id=summer-time-rendering-season-1-117933&type=tv&season=1&episode=2',
                    movie: '/api5?id=your-name-123456&type=movie'
                }
            });
        }

        if (type !== 'tv' && type !== 'movie') {
            return res.status(400).json({
                status: 'error',
                message: "Type must be 'tv' or 'movie'"
            });
        }

        if (type === 'tv' && (!season || !episode)) {
            return res.status(400).json({
                status: 'error',
                message: 'TV episodes require season and episode parameters',
                example: '/api5?id=summer-time-rendering-season-1-117933&type=tv&season=1&episode=2'
            });
        }

        const toonUrl = buildToonstreamUrl({ id, type, season, episode });
        const response = await axios.get(toonUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 8000
        });

        const html = response.data || '';
        const rubystmUrl = findRubystmUrl(html);

        if (!rubystmUrl) {
            return res.status(404).json({
                status: 'error',
                message: 'No rubystream source found on the page',
                toonUrl
            });
        }

        const rubystmData = await extractFromRubystm(rubystmUrl);
        if (!rubystmData) {
            return res.status(500).json({
                status: 'error',
                message: 'Failed to extract HLS stream from rubystream source',
                source: rubystmUrl
            });
        }

        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
        const baseUrl = `${protocol}://${host}`;
        const proxiedUrl = `${baseUrl}/api/proxy?url=${encodeURIComponent(rubystmData.streamUrl)}&referer=${encodeURIComponent(rubystmData.headers?.Referer || rubystmUrl)}`;

        return res.status(200).json({
            status: 'success',
            toonUrl,
            data: {
                rubystream: {
                    original: rubystmUrl,
                    hls: rubystmData.streamUrl,
                    proxied: proxiedUrl,
                    headers: rubystmData.headers
                }
            }
        });
    } catch (error) {
        return res.status(500).json({
            status: 'error',
            message: error?.message || 'Internal server error',
            details: 'Failed to extract rubystm stream. The page might be unavailable or the format has changed.'
        });
    }
}
