import axios from 'axios';
import crypto from 'crypto';

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

export async function extractFromFilemoon(url) {
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
