/**
 * Project Aslan - Hdfilmcehennemi Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Direct resolution of Rapidrame / Pichive player iframes to HLS .m3u8
 * - Direct resolution of VidMoly embedded video player to HLS .m3u8
 * - Unpacker for obfuscated JavaScript payloads (Dean-Edwards + characterUnmix cipher)
 * - Multi-source audio tagging: [🇹🇷 TR Dublaj] vs [🌐 TR Altyazı]
 * - Embedded subtitle track discovery (WebVTT / SRT)
 * - Movie and Television (Series) support
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
    return getActiveDomain('hdfilmcehennemi', 'https://www.hdfilmcehennemi2.biz');
}
const FALLBACK_DOMAINS = [
    'https://www.hdfilmcehennemi2.biz'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const PROVIDER_NAME = 'Hdfilmcehennemi';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * ROT13 cipher transformation.
 *
 * @param {string} str - String to rotate
 * @returns {string} ROT13 transformed string
 */
function rot13(str) {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[a-zA-Z]/g, (c) => {
        return String.fromCharCode(
            (c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26
        );
    });
}

/**
 * Character unmix algorithm using site's dynamic modulus offset.
 *
 * @param {string} value - Mixed character string
 * @returns {string} Unmixed plaintext
 */
function characterUnmix(value) {
    if (!value || typeof value !== 'string') return '';
    let unmix = '';
    for (let i = 0; i < value.length; i++) {
        const charCode = value.charCodeAt(i);
        const unmixedCode = (charCode - (399756995 % (i + 5)) + 256) % 256;
        unmix += String.fromCharCode(unmixedCode);
    }
    return unmix;
}

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
 * Decodes obfuscated Rapidrame / Pichive video URL parts.
 *
 * @param {Array<string>} parts - Array of obfuscated token chunks
 * @returns {string|null} Decoded video URL
 */
function decodeRapidrameVideoUrl(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const value = parts.join('');

    // Strategy 1: base64 -> reverse -> ROT13 -> unmix (Current Rapidrame algorithm)
    try {
        let step1 = Buffer.from(value, 'base64').toString('latin1');
        let step2 = step1.split('').reverse().join('');
        let step3 = rot13(step2);
        let result = characterUnmix(step3);
        if (result && (result.includes('.m3u8') || result.includes('/hls/') || result.includes('.mp4'))) {
            return result;
        }
    } catch (_) {}

    // Strategy 2: reverse -> ROT13 -> base64 -> unmix
    try {
        const reversed = value.split('').reverse().join('');
        let step1 = rot13(reversed);
        let step2 = Buffer.from(step1, 'base64').toString('latin1');
        let result = characterUnmix(step2);
        if (result && (result.includes('.m3u8') || result.includes('/hls/') || result.includes('.mp4'))) {
            return result;
        }
    } catch (_) {}

    // Strategy 3: reverse -> base64 -> ROT13 -> unmix
    try {
        const reversed = value.split('').reverse().join('');
        let step1 = Buffer.from(reversed, 'base64').toString('latin1');
        let step2 = rot13(step1);
        let result = characterUnmix(step2);
        if (result && (result.includes('.m3u8') || result.includes('/hls/') || result.includes('.mp4'))) {
            return result;
        }
    } catch (_) {}

    return null;
}

/**
 * Resolves media target URLs from TMDB ID.
 *
 * @param {string|number} tmdbId - TMDB ID or title
 * @param {'movie'|'tv'} mediaType - 'movie' or 'tv'
 * @param {number|string} [seasonNum] - Season index
 * @param {number|string} [episodeNum] - Episode index
 * @returns {Promise<Array<{ url: string, isDubbed: boolean }>>}
 */
async function discoverTargetUrls(tmdbId, mediaType, seasonNum, episodeNum) {
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
                    if ((prov.includes('hdfilmcehennemi') || prov.includes('pichive')) && l.Link) {
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
        const meta = await resolveTmdbMeta(tmdbId, mediaType);
        title = meta.title || '';
        trTitle = meta.trTitle || meta.title || '';
    } catch (_) {}

    const cleanQuery = trTitle ? trTitle.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() : (title || String(tmdbId));
    if (!cleanQuery) return [];
    const BASE_URL = getBaseUrl();
    const domainsToTry = [...new Set([BASE_URL, ...FALLBACK_DOMAINS])];
    for (const domain of domainsToTry) {
        try {
            const searchUrl = `${domain}/?s=${encodeURIComponent(cleanQuery)}`;
            const sRes = await fetchWithTimeout(searchUrl, {
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Referer': `${domain}/`
                }
            }, 2000);

            if (sRes.ok) {
                const sHtml = await sRes.text();
                const matches = fastExtract(sHtml, /<a[^>]+href=["'](https?:\/\/[^"']*(?:hdfilmcehennemi)[^"']*\/(?:hd-|dizi\/)?[^"']+)["'][^>]*>/gi);
                if (Array.isArray(matches) && matches.length > 0) {
                    for (const m of matches) {
                        if (!m.includes('/page/')) {
                            let targetUrl = m;
                            if (mediaType === 'tv' && seasonNum && episodeNum) {
                                targetUrl = `${m.replace(/\/+$/, '')}-sezon-${seasonNum}-bolum-${episodeNum}/`;
                            }
                            urls.push({ url: targetUrl, isDubbed: true });
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
        let path = mediaType === 'tv' && seasonNum && episodeNum
            ? `/dizi/${slug}-sezon-${seasonNum}-bolum-${episodeNum}/`
            : `/hd-${slug}-izle/`;
        urls.push({ url: `${getBaseUrl()}${path}`, isDubbed: true });
    }

    return urls;
}

/**
 * Resolves VidMoly iframe to HLS stream.
 *
 * @param {string} iframeSrc - VidMoly embed URL
 * @param {string} pageReferer - Referer header URL
 * @param {boolean} isDubbed - Audio classification flag
 * @returns {Promise<object|null>} Stream object or null
 */
async function resolveVidMoly(iframeSrc, pageReferer, isDubbed) {
    try {
        const origin = new URL(iframeSrc).origin;
        const res = await fetchWithTimeout(iframeSrc, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': pageReferer || `${getBaseUrl()}/`
            }
        }, 3500);

        if (!res.ok) return null;
        const html = await res.text();

        // Micro-parse jwplayer sources array: sources: [{file: "..."}]
        const m3u8Url = fastExtract(html, /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) ||
                        fastExtract(html, /sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);

        if (!m3u8Url) return null;

        const subtitles = extractSubtitles(html, origin);
        const audioBadge = isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
        const streamTitle = `⌜ ASLAN ⌟ | ${PROVIDER_NAME} | VidMoly | 1080p | ${audioBadge}`;

        const headers = {
            'User-Agent': CLIENT_USER_AGENT,
            'Referer': origin + '/',
            'Origin': origin
        };

        return buildStreamObject({
            name: 'Hdfilmcehennemi',
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
 * Resolves Rapidrame / Pichive iframe to direct HLS stream.
 *
 * @param {string} iframeSrc - Rapidrame embed URL
 * @param {string} pageReferer - Referer header URL
 * @param {boolean} isDubbed - Audio classification flag
 * @returns {Promise<object|null>} Stream object or null
 */
async function resolveRapidrame(iframeSrc, pageReferer, isDubbed) {
    try {
        const origin = new URL(iframeSrc).origin;
        const res = await fetchWithTimeout(iframeSrc, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': pageReferer || `${getBaseUrl()}/`
            }
        }, 3500);

        if (!res.ok) return null;
        const html = await res.text();

        let videoUrl = null;

        // Method 1: Packed JavaScript unpacker
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.+?)',(\d+),(\d+),'([^']+)'/s);
        if (packedMatch) {
            const unpacked = unpackJS(
                packedMatch[1],
                parseInt(packedMatch[2], 10),
                parseInt(packedMatch[3], 10),
                packedMatch[4]
            );

            // Extract encoded URL parts from dc_*(["...", "..."])
            const partsMatch = unpacked.match(/dc_\w+\(\[([^\]]+)\]\)/);
            if (partsMatch) {
                const parts = partsMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, ''));
                if (parts) {
                    videoUrl = decodeRapidrameVideoUrl(parts);
                }
            }

            if (!videoUrl) {
                videoUrl = fastExtract(unpacked, /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
            }
        }

        // Method 2: JSON-LD contentUrl fallback
        if (!videoUrl) {
            const jsonLdRaw = fastExtract(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
            if (jsonLdRaw) {
                try {
                    const jsonLd = JSON.parse(jsonLdRaw);
                    if (jsonLd && jsonLd.contentUrl) {
                        videoUrl = jsonLd.contentUrl;
                    }
                } catch (_) {}
            }
        }

        // Method 3: Direct HLS m3u8 in page markup
        if (!videoUrl) {
            videoUrl = fastExtract(html, /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
                       fastExtract(html, /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        }

        if (!videoUrl) return null;

        const subtitles = extractSubtitles(html, origin);
        const audioBadge = isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
        const streamTitle = `⌜ ASLAN ⌟ | ${PROVIDER_NAME} | Rapidrame | 1080p | ${audioBadge}`;

        const headers = {
            'User-Agent': CLIENT_USER_AGENT,
            'Referer': origin + '/',
            'Origin': origin
        };

        return buildStreamObject({
            name: 'Hdfilmcehennemi',
            title: streamTitle,
            url: videoUrl,
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
 * @param {number|string} [seasonNum] - Season index (1-based), required when mediaType === 'tv'.
 * @param {number|string} [episodeNum] - Episode index (1-based), required when mediaType === 'tv'.
 * @returns {Promise<Array<object>>} Resolves to an array of verified stream objects.
 */
async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    const streams = [];

    try {
        const candidateEntries = await discoverTargetUrls(tmdbId, mediaType, seasonNum, episodeNum);
        if (!candidateEntries || candidateEntries.length === 0) {
            return [];
        }

        for (const entry of candidateEntries) {
            try {
                // If the link is already an iframe (e.g. from Seyirturk discovery)
                if (entry.url.includes('four.pichive.online') || entry.url.includes('rapidrame')) {
                    const streamObj = await resolveRapidrame(entry.url, `${getBaseUrl()}/`, entry.isDubbed);
                    if (streamObj) {
                        const isHealthy = await verifyStreamHealth(streamObj.url, streamObj.headers, 2000).catch(() => true);
                        if (isHealthy) streams.push(streamObj);
                    }
                    continue;
                }

                if (entry.url.includes('vidmoly') || entry.url.includes('vmoly')) {
                    const streamObj = await resolveVidMoly(entry.url, `${getBaseUrl()}/`, entry.isDubbed);
                    if (streamObj) {
                        const isHealthy = await verifyStreamHealth(streamObj.url, streamObj.headers, 2000).catch(() => true);
                        if (isHealthy) streams.push(streamObj);
                    }
                    continue;
                }

                // Fetch target page
                const pageRes = await fetchWithTimeout(entry.url, {
                    headers: {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': `${getBaseUrl()}/`
                    }
                }, 4000);

                if (!pageRes.ok) continue;
                const html = await pageRes.text();

                // Extract all candidate player iframes
                const iframes = fastExtract(html, /<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/gi);
                const buttonLinks = fastExtract(html, /(?:data-src|data-url|data-video)=["']([^"']+)["']/gi);
                const candidates = [
                    ...(Array.isArray(iframes) ? iframes : []),
                    ...(Array.isArray(buttonLinks) ? buttonLinks : [])
                ];

                for (const candidate of candidates.slice(0, 4)) {
                    const cleanUrl = candidate.startsWith('//') ? `https:${candidate}` : candidate;
                    let streamObj = null;

                    if (cleanUrl.includes('vidmoly') || cleanUrl.includes('vmoly')) {
                        streamObj = await resolveVidMoly(cleanUrl, entry.url, entry.isDubbed);
                    } else if (cleanUrl.includes('rapidrame') || cleanUrl.includes('pichive')) {
                        streamObj = await resolveRapidrame(cleanUrl, entry.url, entry.isDubbed);
                    }

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
    resolveVidMoly,
    resolveRapidrame
};
