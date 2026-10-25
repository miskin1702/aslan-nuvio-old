/**
 * Project Aslan - FilmMakinesi Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Direct resolution of FPlayer custom HLS direct streams (.m3u8)
 * - Micro-parsing of embedded player iframes and source manifests
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
    return getActiveDomain('filmmakinesi', 'https://filmmakinesi.ch');
}
const FALLBACK_DOMAINS = [
    'https://filmmakinesi.net',
    'https://filmmakinesi.org'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/movie';
const PROVIDER_NAME = 'FilmMakinesi';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * Unpacks Dean Edwards P.A.C.K.E.R JavaScript code.
 *
 * @param {string} p - Packed payload
 * @param {number} a - Radix
 * @param {number} c - Word count
 * @param {string} k - Pipe-separated keyword list
 * @returns {string} Unpacked script
 */
function unpackJS(p, a, c, k) {
    if (!p || !k) return '';
    const dict = k.split('|');

    const toBase = (n) =>
        (n < a ? '' : toBase(Math.floor(n / a))) +
        ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));

    const table = {};
    for (let i = c - 1; i >= 0; i--) {
        const tok = toBase(i);
        table[tok] = dict[i] && dict[i].length ? dict[i] : tok;
    }

    return p.replace(/\b\w+\b/g, (w) => (Object.prototype.hasOwnProperty.call(table, w) ? table[w] : w));
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
                    if (prov.includes('filmmakinesi') && l.Link) {
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

    // Tier 2: TMDB / Cinemeta title resolution + site search
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
            const searchUrl = `${domain}/?s=${encodeURIComponent(cleanQuery)}`;
            const sRes = await fetchWithTimeout(searchUrl, {
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Referer': `${domain}/`
                }
            }, 3000);

            if (sRes.ok) {
                const sHtml = await sRes.text();
                // Micro-parse search results for /film/ links
                const matches = fastExtract(sHtml, /<a[^>]+href=["'](https?:\/\/[^"']*(?:filmmakinesi)[^"']*\/(?:film\/)[^"']+)["'][^>]*>/gi);
                if (Array.isArray(matches) && matches.length > 0) {
                    for (const m of matches) {
                        if (!m.includes('/page/')) {
                            urls.push({ url: m, isDubbed: true });
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
 * Resolves FPlayer embed / iframe to a direct HLS .m3u8 stream.
 *
 * @param {string} playerUrl - FPlayer URL or iframe target
 * @param {string} pageReferer - Referer header URL
 * @param {boolean} isDubbed - Audio classification flag
 * @returns {Promise<object|null>} Stream object or null
 */
async function resolveFPlayer(playerUrl, pageReferer, isDubbed) {
    try {
        const origin = new URL(playerUrl).origin;
        const res = await fetchWithTimeout(playerUrl, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': pageReferer || `${getBaseUrl()}/`
            }
        }, 3500);

        if (!res.ok) return null;
        const html = await res.text();

        let m3u8Url = null;

        // Method 1: Check for Dean Edwards packed script
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.+?)',(\d+),(\d+),'([^']+)'/s);
        if (packedMatch) {
            const unpacked = unpackJS(
                packedMatch[1],
                parseInt(packedMatch[2], 10),
                parseInt(packedMatch[3], 10),
                packedMatch[4]
            );
            m3u8Url = fastExtract(unpacked, /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                      fastExtract(unpacked, /sources:\s*\[\s*\{[^}]*file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        }

        // Method 2: Direct regex micro-parse on player markup
        if (!m3u8Url) {
            m3u8Url = fastExtract(html, /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                      fastExtract(html, /sources:\s*\[\s*\{[^}]*file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                      fastExtract(html, /src:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                      fastExtract(html, /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        }

        if (!m3u8Url) return null;

        const subtitles = extractSubtitles(html, origin);
        const audioBadge = isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
        const streamTitle = `⌜ ASLAN ⌟ | ${PROVIDER_NAME} | FPlayer | 1080p | ${audioBadge}`;

        const headers = {
            'User-Agent': CLIENT_USER_AGENT,
            'Referer': origin + '/',
            'Origin': origin
        };

        return buildStreamObject({
            name: 'FilmMakinesi',
            title: streamTitle,
            url: m3u8Url,
            quality: '1080p',
            headers: headers,
            subtitles: subtitles,
            behaviorHints: {
                notWebReady: false,
                bingeGroup: `aslan-${PROVIDER_NAME.toLowerCase()}`
            }
        });
    } catch (_) {
        return null;
    }
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

                // 1. Check for inline direct HLS stream
                const directM3u8 = fastExtract(html, /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
                if (directM3u8) {
                    const audioBadge = entry.isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
                    const streamTitle = `⌜ ASLAN ⌟ | ${PROVIDER_NAME} | FPlayer | 1080p | ${audioBadge}`;
                    const streamObj = buildStreamObject({
                        name: 'FilmMakinesi',
                        title: streamTitle,
                        url: directM3u8,
                        quality: '1080p',
                        headers: {
                            'User-Agent': CLIENT_USER_AGENT,
                            'Referer': entry.url
                        },
                        subtitles: extractSubtitles(html, entry.url),
                        behaviorHints: {
                            notWebReady: false,
                            bingeGroup: `aslan-${PROVIDER_NAME.toLowerCase()}`
                        }
                    });

                    const isHealthy = await verifyStreamHealth(streamObj.url, streamObj.headers, 2000).catch(() => true);
                    if (isHealthy) streams.push(streamObj);
                }

                // 2. Discover FPlayer iframes and button targets
                const iframeMatches = fastExtract(html, /<iframe[^>]+src=["']([^"']*(?:fplayer|filmmakinesi|player|embed)[^"']*)["']/gi);
                const buttonFrames = fastExtract(html, /(?:data-frame|data-src|data-url)=["']([^"']*(?:fplayer|filmmakinesi|player|embed)[^"']*)["']/gi);
                const allCandidates = [
                    ...(Array.isArray(iframeMatches) ? iframeMatches : []),
                    ...(Array.isArray(buttonFrames) ? buttonFrames : [])
                ];

                for (const playerUrl of allCandidates.slice(0, 3)) {
                    const cleanUrl = playerUrl.startsWith('//') ? `https:${playerUrl}` : playerUrl;
                    const streamObj = await resolveFPlayer(cleanUrl, entry.url, entry.isDubbed);
                    if (streamObj) {
                        const isHealthy = await verifyStreamHealth(streamObj.url, streamObj.headers, 2000).catch(() => true);
                        if (isHealthy) {
                            streams.push(streamObj);
                        }
                    }
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
    resolveFPlayer
};
