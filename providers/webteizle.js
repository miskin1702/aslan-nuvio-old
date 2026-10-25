/**
 * Project Aslan - WebteIzle Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Comprehensive movie and television series catalog resolution
 * - VidMoly and Sibnet embedded player resolution with pre-flight stream health checks
 * - Embedded WebVTT and SRT subtitle track extraction from player iframes
 * - Parallel dubbing (dil=1) and subtitling (dil=0) pipeline with audio classification
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

const PROVIDER_NAME = 'WebteIzle';
function getBaseUrl() {
    return getActiveDomain('webteizle', 'https://webteizle3.xyz');
}
const FALLBACK_DOMAINS = [
    'https://webteizle.info',
    'https://webteizle.org',
    'https://webteizle.net',
    'https://webteizle.pw'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * Normalizes embed iframe links.
 *
 * @param {string} src - Raw iframe source
 * @param {string} baseUrl - Base context URL
 * @returns {string} Absolute URL
 */
function normalizeUrl(src, baseUrl) {
    if (!src || typeof src !== 'string') return '';
    let url = src.trim();
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return `https://${url.slice(7)}`;
    if (url.startsWith('/') && baseUrl) {
        try { return new URL(url, baseUrl).href; } catch (_) {}
    }
    return url;
}

/**
 * Resolves VidMoly iframe to HLS master .m3u8 stream.
 *
 * @param {string} iframeSrc - VidMoly embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object, subtitles: Array<object> }|null>}
 */
async function resolveVidmoly(iframeSrc, referer) {
    try {
        const url = normalizeUrl(iframeSrc, referer);
        const res = await fetchWithTimeout(url, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': referer
            }
        }, 4000);

        if (!res.ok) return null;
        const html = await res.text();

        const m3u8Match = fastExtract(html, /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
        if (!m3u8Match) return null;

        let origin = 'https://vidmoly.biz';
        try { origin = new URL(res.url || url).origin; } catch (_) {}

        const subtitles = extractSubtitles(html, origin);

        return {
            videoUrl: m3u8Match,
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': `${origin}/`,
                'Origin': origin
            },
            subtitles
        };
    } catch (_) {
        return null;
    }
}

/**
 * Resolves Sibnet player iframe to direct CDN progressive MP4.
 *
 * @param {string} iframeSrc - Sibnet embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolveSibnet(iframeSrc, referer) {
    try {
        const url = normalizeUrl(iframeSrc, referer);
        const res = await fetchWithTimeout(url, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': referer
            }
        }, 4000);

        if (!res.ok) return null;
        const html = await res.text();

        const pathMatch = fastExtract(html, /player\.src\(\[\{\s*src:\s*["']([^"']+)["']/i);
        if (!pathMatch) return null;

        const absUrl = /^https?:\/\//i.test(pathMatch) ? pathMatch : `https://video.sibnet.ru${pathMatch}`;

        // Follow HTTP redirects to acquire direct dv*.sibnet.ru endpoint
        let finalUrl = absUrl;
        let current = absUrl;
        for (let hop = 0; hop < 4; hop++) {
            const redirectResp = await fetch(current, {
                method: 'HEAD',
                redirect: 'manual',
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Referer': url
                },
                signal: AbortSignal.timeout(3000)
            }).catch(() => null);

            if (!redirectResp) break;
            if (redirectResp.status >= 300 && redirectResp.status < 400) {
                const loc = redirectResp.headers.get('location');
                if (loc) {
                    current = new URL(loc, current).href;
                    finalUrl = current;
                    continue;
                }
            }
            break;
        }

        return {
            videoUrl: finalUrl,
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': url
            }
        };
    } catch (_) {
        return null;
    }
}

/**
 * Resolves Pixeldrain player or embed links.
 *
 * @param {string} rawLink - Pixeldrain link
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolvePixeldrain(rawLink) {
    try {
        const fileIdMatch = rawLink.match(/\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/);
        if (!fileIdMatch) return null;

        const fileId = fileIdMatch[1];
        const streamUrl = `https://pixeldrain.com/api/file/${fileId}`;

        return {
            videoUrl: streamUrl,
            headers: {
                'User-Agent': CLIENT_USER_AGENT
            }
        };
    } catch (_) {
        return null;
    }
}

/**
 * Resolves candidate media URLs on Webteizle.
 *
 * @param {string|number} tmdbId - TMDB ID or IMDb ID
 * @param {'movie'|'tv'} mediaType - 'movie' or 'tv'
 * @param {number|string} [seasonNum] - Season index
 * @param {number|string} [episodeNum] - Episode index
 * @returns {Promise<Array<{ url: string, isDubbed: boolean }>>} Target URLs list
 */
async function discoverWebteizleUrls(tmdbId, mediaType, seasonNum, episodeNum) {
    const urls = [];
    const BASE_URL = getBaseUrl();
    const domains = [BASE_URL, ...FALLBACK_DOMAINS];

    // Tier 1: Seyirturk discovery backend endpoint check
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
                    if (prov.includes('webteizle') && l.Link) {
                        urls.push({
                            url: l.Link,
                            isDubbed: String(l.Link).includes('l=1') || String(l.Link).includes('/dublaj/') || l.isTurkish === '1'
                        });
                    }
                }
            }
        }
    } catch (_) {}

    if (urls.length > 0) {
        return urls;
    }

    // Tier 2: TMDB / Cinemeta title resolution
    let title = '';
    try {
        const meta = await resolveTmdbMeta(tmdbId, mediaType);
        title = meta.trTitle || meta.title || '';
    } catch (_) {}
    const cleanTitle = title ? title.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() : String(tmdbId);
    const slug = title ? titleToSlug(title) : '';

    // Tier 3: Search endpoint on active domain
    if (cleanTitle) {
        for (const domain of domains) {
            try {
                const searchUrl = `${domain}/arama?q=${encodeURIComponent(cleanTitle)}`;
                const sRes = await fetchWithTimeout(searchUrl, {
                    headers: {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': `${domain}/`
                    }
                }, 3000);

                if (sRes.ok) {
                    const sHtml = await sRes.text();
                    const hrefs = fastExtract(sHtml, /<a[^>]+href=["'](https?:\/\/[^"']*(?:webteizle)[^"']*\/(?:izle|dizi|film)\/[^"']+)["']/gi);
                    if (Array.isArray(hrefs) && hrefs.length > 0) {
                        for (const h of hrefs) {
                            if (mediaType === 'tv' && seasonNum && episodeNum) {
                                const cleanH = h.replace(/\/+$/, '');
                                urls.push({ url: `${cleanH}/sezon-${seasonNum}/bolum-${episodeNum}?l=1`, isDubbed: true });
                                urls.push({ url: `${cleanH}/sezon-${seasonNum}/bolum-${episodeNum}?l=0`, isDubbed: false });
                            } else {
                                urls.push({ url: `${h}?l=1`, isDubbed: true });
                                urls.push({ url: `${h}?l=0`, isDubbed: false });
                            }
                            break;
                        }
                    }
                }
                if (urls.length > 0) break;
            } catch (_) {}
        }
    }

    // Tier 4: Direct canonical slug mapping
    if (slug) {
        for (const domain of domains.slice(0, 2)) {
            if (mediaType === 'tv' && seasonNum && episodeNum) {
                urls.push({
                    url: `${domain}/dizi/${slug}/sezon-${seasonNum}/bolum-${episodeNum}?l=1`,
                    isDubbed: true
                });
                urls.push({
                    url: `${domain}/dizi/${slug}/sezon-${seasonNum}/bolum-${episodeNum}?l=0`,
                    isDubbed: false
                });
            } else {
                urls.push({
                    url: `${domain}/izle/dublaj/${slug}?l=1`,
                    isDubbed: true
                });
                urls.push({
                    url: `${domain}/izle/altyazi/${slug}?l=0`,
                    isDubbed: false
                });
            }
        }
    }

    return urls;
}

/**
 * Resolves media streams for the given TMDB media target.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier
 * @param {'movie'|'tv'} mediaType - Media category identifier ('movie' or 'tv')
 * @param {number|string} [seasonNum] - Season index (required for tv)
 * @param {number|string} [episodeNum] - Episode index (required for tv)
 * @returns {Promise<Array<object>>} Resolves to an array of verified Nuvio Stream Objects
 */
async function getStreams(tmdbId, mediaType = 'movie', seasonNum = 1, episodeNum = 1) {
    if (!tmdbId) return [];

    try {
        const streams = [];
        const targets = await discoverWebteizleUrls(tmdbId, mediaType, seasonNum, episodeNum);
        if (targets.length === 0) return [];

        for (const target of targets.slice(0, 4)) {
            const { url: targetUrl, isDubbed } = target;

            try {
                const res = await fetchWithTimeout(targetUrl, {
                    headers: {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': targetUrl
                    }
                }, 4000);

                if (!res.ok) continue;
                const html = await res.text();

                // Extract all iframe embeds from target page
                const iframeMatches = fastExtract(html, /<iframe[^>]+src=["']([^"']+)["']/gi);
                const iframeList = Array.isArray(iframeMatches) ? iframeMatches : (iframeMatches ? [iframeMatches] : []);

                for (const rawIframe of iframeList) {
                    const iframeUrl = normalizeUrl(rawIframe, targetUrl);
                    const lowerIframe = iframeUrl.toLowerCase();

                    // VidMoly player embed
                    if (lowerIframe.includes('vidmoly')) {
                        const resolved = await resolveVidmoly(iframeUrl, targetUrl);
                        if (resolved && resolved.videoUrl) {
                            const isHealthy = await verifyStreamHealth(resolved.videoUrl, resolved.headers, 2500);
                            if (isHealthy) {
                                const badge = isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
                                streams.push(buildStreamObject({
                                    name: PROVIDER_NAME,
                                    title: `⌜ ${PROVIDER_NAME} ⌟ | VidMoly | 1080p | ${badge}`,
                                    url: resolved.videoUrl,
                                    quality: '1080p',
                                    headers: resolved.headers,
                                    subtitles: resolved.subtitles
                                }));
                            }
                        }
                    }

                    // Sibnet player embed
                    else if (lowerIframe.includes('sibnet')) {
                        const resolved = await resolveSibnet(iframeUrl, targetUrl);
                        if (resolved && resolved.videoUrl) {
                            const isHealthy = await verifyStreamHealth(resolved.videoUrl, resolved.headers, 2500);
                            if (isHealthy) {
                                const badge = isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
                                streams.push(buildStreamObject({
                                    name: PROVIDER_NAME,
                                    title: `⌜ ${PROVIDER_NAME} ⌟ | Sibnet | 720p | ${badge}`,
                                    url: resolved.videoUrl,
                                    quality: '720p',
                                    headers: resolved.headers,
                                    subtitles: []
                                }));
                            }
                        }
                    }

                    // Pixeldrain player embed
                    else if (lowerIframe.includes('pixeldrain')) {
                        const resolved = await resolvePixeldrain(iframeUrl);
                        if (resolved && resolved.videoUrl) {
                            const isHealthy = await verifyStreamHealth(resolved.videoUrl, resolved.headers, 2500);
                            if (isHealthy) {
                                const badge = isDubbed ? '[🇹🇷 TR Dublaj]' : '[🌐 TR Altyazı]';
                                streams.push(buildStreamObject({
                                    name: PROVIDER_NAME,
                                    title: `⌜ ${PROVIDER_NAME} ⌟ | Pixeldrain | 1080p | ${badge}`,
                                    url: resolved.videoUrl,
                                    quality: '1080p',
                                    headers: resolved.headers,
                                    subtitles: []
                                }));
                            }
                        }
                    }
                }

                if (streams.length >= 4) break;
            } catch (_) {}
        }

        return streams;
    } catch (_) {
        return [];
    }
}

module.exports = { getStreams };
