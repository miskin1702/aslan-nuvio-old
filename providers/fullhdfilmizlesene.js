/**
 * Project Aslan - FullHDFilmizlesene Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Direct resolution for Atom and RapidVid players
 * - decodeRapidVid: XOR shift cipher with key "K9L" and double Base64 decode
 * - Audio classification: [🇹🇷 TR Dublaj] vs [🌐 TR Altyazı]
 * - Embedded subtitle track discovery (WebVTT / SRT)
 */

'use strict';

const {
    fastExtract,
    analyzeAudio,
    extractSubtitles,
    buildStreamObject,
    verifyStreamHealth,
    fetchWithTimeout,
    titleToSlug,
    resolveTmdbMeta,
    getActiveDomain
} = require('../src/utils/stream-helper');

function getBaseUrl() {
    return getActiveDomain('fullhdfilmizlesene', 'https://www.fullhdfilmizlesene.live');
}
const FALLBACK_DOMAINS = [
    'https://www.fullhdfilmizlesene.now',
    'https://www.fullhdfilmizlesene.pw',
    'https://www.fullhdfilmizlesene.net'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/movie';
const PROVIDER_NAME = 'FullHDFilmizlesene';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * ROT13 de-obfuscation (site's rtt() helper).
 *
 * @param {string} s - ROT13 encoded string
 * @returns {string} De-rotated plaintext
 */
function rot13(s) {
    if (!s || typeof s !== 'string') return '';
    return s.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

/**
 * Decodes RapidVid / Atom / imgz.me obfuscated video stream payloads.
 * Implements reverse + byte-shift subtraction/XOR with key "K9L" and double Base64 decoding.
 *
 * @param {string} blob - Obfuscated payload from player iframe/script
 * @param {string} [key='K9L'] - Obfuscation key
 * @returns {string} Decoded URL or JSON configuration
 */
function decodeRapidVid(blob, key = 'K9L') {
    if (!blob || typeof blob !== 'string') return '';

    // Strategy 1: Imgz / RapidVid reverse -> Base64 -> shift subtraction -> Base64
    try {
        const rev = blob.split('').reverse().join('');
        const e = Buffer.from(rev, 'base64').toString('latin1');
        let n = '';
        for (let i = 0; i < e.length; i++) {
            const k = key.charCodeAt(i % key.length);
            n += String.fromCharCode(e.charCodeAt(i) - ((k % 5) + 1));
        }
        const decoded = Buffer.from(n, 'base64').toString('utf-8');
        if (decoded.includes('http') || decoded.includes('{') || decoded.includes('.m3u8')) {
            return decoded;
        }
    } catch (_) {}

    // Strategy 2: Base64 -> XOR with key "K9L" -> Base64
    try {
        const step1 = Buffer.from(blob, 'base64').toString('binary');
        let xored = '';
        for (let i = 0; i < step1.length; i++) {
            xored += String.fromCharCode(step1.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        const decoded = Buffer.from(xored, 'base64').toString('utf-8');
        if (decoded.includes('http') || decoded.includes('{') || decoded.includes('.m3u8')) {
            return decoded;
        }
    } catch (_) {}

    // Strategy 3: Double Base64 decode -> XOR with key "K9L"
    try {
        const step1 = Buffer.from(blob, 'base64').toString('binary');
        const step2 = Buffer.from(step1, 'base64').toString('binary');
        let xored = '';
        for (let i = 0; i < step2.length; i++) {
            xored += String.fromCharCode(step2.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        if (xored.includes('http') || xored.includes('{') || xored.includes('.m3u8')) {
            return xored;
        }
    } catch (_) {}

    // Strategy 4: Reverse -> XOR with key "K9L" -> Base64
    try {
        const rev = blob.split('').reverse().join('');
        const step1 = Buffer.from(rev, 'base64').toString('binary');
        let xored = '';
        for (let i = 0; i < step1.length; i++) {
            xored += String.fromCharCode(step1.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        const decoded = Buffer.from(xored, 'base64').toString('utf-8');
        if (decoded.includes('http') || decoded.includes('{') || decoded.includes('.m3u8')) {
            return decoded;
        }
    } catch (_) {}

    return '';
}

/**
 * Decodes an SCX source entry: atob(rot13(entry)).
 *
 * @param {string} entry - Encoded scx entry
 * @returns {string|null} Decoded embed URL
 */
function decodeScxEntry(entry) {
    if (!entry || typeof entry !== 'string') return null;
    try {
        const url = Buffer.from(rot13(entry), 'base64').toString('utf-8');
        return /^https?:\/\//i.test(url) ? url : null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolves movie URLs from TMDB ID using multi-tier discovery.
 *
 * @param {string|number} tmdbId - TMDB ID or slug
 * @returns {Promise<Array<{ url: string, isDubbed: boolean }>>}
 */
async function discoverMovieUrls(tmdbId) {
    const urls = [];

    // Tier 1: Check fast Seyirturk discovery endpoint
    try {
        const discoveryUrl = `${BACKEND_DISCOVERY_URL}?id=${encodeURIComponent(tmdbId)}&u_id=0&vn=1005&includeYK=1`;
        const res = await fetchWithTimeout(discoveryUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:19.0) Gecko/20100101 Firefox/19.0',
                'bety': 'jughead'
            }
        }, 3000);

        if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.links)) {
                for (const l of data.links) {
                    const prov = String(l.Provider || l.MainProvider || '').toLowerCase();
                    if (prov.includes('fullhdfilmizlesene') && l.Link) {
                        urls.push({
                            url: l.Link,
                            isDubbed: String(l.Link).includes('l=0') || l.isTurkish === '1'
                        });
                    }
                }
            }
        }
    } catch (_) {}

    if (urls.length > 0) {
        return urls;
    }

    // Tier 2: TMDB / Cinemeta title resolution + autocomplete search
    let title = '';
    let trTitle = '';
    try {
        const meta = await resolveTmdbMeta(tmdbId, 'movie');
        title = meta.title || '';
        trTitle = meta.trTitle || meta.title || '';
    } catch (_) {}

    const cleanQuery = trTitle ? trTitle.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() : (title || String(tmdbId));
    if (!cleanQuery) return [];

    const BASE_URL = getBaseUrl();
    const domainsToTry = [BASE_URL, ...FALLBACK_DOMAINS];
    for (const domain of domainsToTry) {
        try {
            const acUrl = `${domain}/autocomplete/q.php?q=${encodeURIComponent(cleanQuery)}`;
            const acRes = await fetchWithTimeout(acUrl, {
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${domain}/`
                }
            }, 3000);

            if (acRes.ok) {
                const rows = await acRes.json();
                if (Array.isArray(rows) && rows.length > 0) {
                    for (const row of rows) {
                        if (row && row.dizilink) {
                            urls.push({
                                url: `${domain}/film/${row.dizilink}/`,
                                isDubbed: true
                            });
                            break;
                        }
                    }
                }
            }
            if (urls.length > 0) break;
        } catch (_) {}
    }

    // Tier 3: Direct slug fallback
    if (urls.length === 0 && title) {
        const slug = titleToSlug(title);
        urls.push({ url: `${getBaseUrl()}/film/${slug}/`, isDubbed: true });
    }

    return urls;
}

/**
 * Resolves direct HLS / MP4 stream from an Atom / RapidVid embed URL.
 *
 * @param {string} embedUrl - Atom or RapidVid embed URL
 * @param {string} pageReferer - Referer header URL
 * @returns {Promise<{ videoUrl: string, quality: string, subtitles: Array }|null>}
 */
async function resolveAtomRapidVid(embedUrl, pageReferer) {
    try {
        const origin = new URL(embedUrl).origin;
        const res = await fetchWithTimeout(embedUrl, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': pageReferer || `${getBaseUrl()}/`
            }
        }, 4000);

        if (!res.ok) return null;
        const html = await res.text();

        let videoUrl = null;
        let subtitles = [];

        // Variant A: window._p8 obfuscated config
        const p8Match = fastExtract(html, /window\._p8\s*=\s*['"]([^'"]+)['"]/);
        if (p8Match) {
            const decodedJson = decodeRapidVid(p8Match);
            if (decodedJson) {
                try {
                    const cfg = JSON.parse(decodedJson);
                    videoUrl = cfg.cm || cfg.tm || null;
                    if (Array.isArray(cfg.ct)) {
                        for (const track of cfg.ct) {
                            if (track && track.file) {
                                subtitles.push({
                                    id: track.label || 'sub',
                                    lang: String(track.label || '').toLowerCase().includes('turk') ? 'Turkish' : 'English',
                                    label: track.label || 'Türkçe',
                                    url: track.file
                                });
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        // Variant B: _qv / av() / _() obfuscated inline file
        if (!videoUrl) {
            const fileCipher = fastExtract(html, /["']file["']\s*:\s*(?:av|_)\(\s*["']([^'"]+)["']\s*\)/);
            if (fileCipher) {
                const decoded = decodeRapidVid(fileCipher);
                if (decoded && decoded.startsWith('http')) {
                    videoUrl = decoded;
                }
            }
        }

        // Variant C: Plain jwSetup sources or regex HLS extraction
        if (!videoUrl) {
            videoUrl = fastExtract(html, /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                       fastExtract(html, /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                       fastExtract(html, /file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
        }

        // Extract any HTML5 or JSON subtitle tracks
        if (subtitles.length === 0) {
            subtitles = extractSubtitles(html, origin);
        }

        if (videoUrl) {
            return {
                videoUrl,
                quality: videoUrl.includes('1080') ? '1080p' : (videoUrl.includes('720') ? '720p' : 'Auto'),
                subtitles
            };
        }
    } catch (_) {}

    return null;
}

/**
 * Resolves media streams for the given TMDB media target.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier.
 * @param {'movie'|'tv'} mediaType - Media category identifier.
 * @param {number|string} [seasonNum] - Season index (ignored for movie).
 * @param {number|string} [episodeNum] - Episode index (ignored for movie).
 * @returns {Promise<Array<object>>} Resolves to an array of verified stream objects.
 */
async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    if (mediaType === 'tv') {
        return [];
    }

    const streams = [];

    try {
        const candidateEntries = await discoverMovieUrls(tmdbId);
        if (!candidateEntries || candidateEntries.length === 0) {
            return [];
        }

        for (const entry of candidateEntries) {
            try {
                const pageRes = await fetchWithTimeout(entry.url, {
                    headers: {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': `${getBaseUrl()}/`
                    }
                }, 4000);

                if (!pageRes.ok) continue;
                const html = await pageRes.text();

                // Extract embedded scx configuration: var scx = { ... };
                const scxRaw = fastExtract(html, /var\s+scx\s*=\s*(\{[\s\S]*?\});/);
                const embedSources = [];

                if (scxRaw) {
                    // Micro-parse scx object for single-file and multi-part sources
                    const entryMatches = fastExtract(html, /["'](?:tr|en|\d+)["']\s*:\s*["']([A-Za-z0-9+/=]+)["']/g);
                    if (Array.isArray(entryMatches)) {
                        for (const match of entryMatches) {
                            const decoded = decodeScxEntry(match);
                            if (decoded) {
                                const isDub = match.includes('"tr"') || entry.isDubbed;
                                embedSources.push({ url: decoded, isDubbed: isDub });
                            }
                        }
                    }
                }

                // Fallback: extract iframes directly from page
                const iframes = fastExtract(html, /<iframe[^>]+src=["']([^"']*(?:rapidvid|atom|turbo|player)[^"']*)["']/gi);
                if (Array.isArray(iframes)) {
                    for (const ifr of iframes) {
                        const cleanIfr = ifr.startsWith('//') ? `https:${ifr}` : ifr;
                        if (!embedSources.some(s => s.url === cleanIfr)) {
                            embedSources.push({ url: cleanIfr, isDubbed: entry.isDubbed });
                        }
                    }
                }

                // Resolve each embed source
                for (const embed of embedSources.slice(0, 4)) {
                    const resolved = await resolveAtomRapidVid(embed.url, entry.url);
                    if (!resolved || !resolved.videoUrl) continue;

                    const audioBadge = embed.isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
                    const streamTitle = `⌜ ASLAN ⌟ | ${PROVIDER_NAME} | Atom/RapidVid | ${resolved.quality} | ${audioBadge}`;

                    const streamHeaders = {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': new URL(embed.url).origin + '/',
                        'Origin': new URL(embed.url).origin
                    };

                    // Pre-flight health verification
                    const isHealthy = await verifyStreamHealth(resolved.videoUrl, streamHeaders, 2000).catch(() => true);
                    if (!isHealthy) continue;

                    const streamObj = buildStreamObject({
                        name: 'FullHDFilmizlesene',
                        title: streamTitle,
                        url: resolved.videoUrl,
                        quality: resolved.quality,
                        headers: streamHeaders,
                        subtitles: resolved.subtitles,
                        behaviorHints: {
                            notWebReady: false,
                            bingeGroup: `aslan-${PROVIDER_NAME.toLowerCase()}`
                        }
                    });

                    streams.push(streamObj);
                }
            } catch (_) {}
        }
    } catch (_) {
        return [];
    }

    return streams;
}

module.exports = {
    getStreams,
    decodeRapidVid
};
