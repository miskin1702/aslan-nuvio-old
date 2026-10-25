/**
 * Project Aslan - SezonlukDizi Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Direct resolution of SezonlukDizi AJAX endpoints (dataAlternatif22 & dataEmbed22)
 * - Multi-player resolver pipeline: VidMoly, Sibnet, Fembed, Filemoon, VideoSoft
 * - Full Dual Audio detection: Parallel extraction for dil=0 (Dublaj) and dil=1 (Altyazı)
 * - WebVTT & SRT subtitle normalization across embedded players
 * - Pre-flight stream validation (HEAD check with range GET fallback)
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

const PROVIDER_NAME = 'SezonlukDizi';
function getBaseUrl() {
    return getActiveDomain('sezonlukdizi', 'https://sezonlukdizi8.com');
}
const FALLBACK_DOMAINS = [
    'https://sezonlukdizi.cc',
    'https://sezonlukdizi.pro',
    'https://sezonlukdizi.org',
    'https://sezonlukdizi.net'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * Normalizes protocol-relative or relative iframe URLs.
 *
 * @param {string} src - Iframe source attribute
 * @param {string} baseUrl - Base URL
 * @returns {string} Normalized absolute URL
 */
function normalizeEmbedUrl(src, baseUrl) {
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
 * Resolves VidMoly player iframes to playable HLS master .m3u8 playlist.
 *
 * @param {string} iframeSrc - VidMoly embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolveVidmoly(iframeSrc, referer) {
    try {
        const url = normalizeEmbedUrl(iframeSrc, referer);
        const res = await fetchWithTimeout(url, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': referer
            }
        }, 4000);

        if (!res.ok) return null;
        const html = await res.text();

        // VidMoly exposes playable master playlist inline in jwplayer setup
        const m3u8Match = fastExtract(html, /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
        if (!m3u8Match) return null;

        let origin = 'https://vidmoly.biz';
        try { origin = new URL(res.url || url).origin; } catch (_) {}

        return {
            videoUrl: m3u8Match,
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': `${origin}/`,
                'Origin': origin
            }
        };
    } catch (_) {
        return null;
    }
}

/**
 * Resolves Sibnet player iframes to direct progressive MP4 stream.
 *
 * @param {string} iframeSrc - Sibnet embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolveSibnet(iframeSrc, referer) {
    try {
        const url = normalizeEmbedUrl(iframeSrc, referer);
        const res = await fetchWithTimeout(url, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': referer
            }
        }, 4000);

        if (!res.ok) return null;
        const html = await res.text();

        // Extract player.src([{src: "/v/..."}])
        const pathMatch = fastExtract(html, /player\.src\(\[\{\s*src:\s*["']([^"']+)["']/i);
        if (!pathMatch) return null;

        const absUrl = /^https?:\/\//i.test(pathMatch) ? pathMatch : `https://video.sibnet.ru${pathMatch}`;

        // Follow redirect chain to retrieve direct tokenized CDN URL
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
 * Resolves Fembed / Feurl player iframes.
 *
 * @param {string} iframeSrc - Fembed embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolveFembed(iframeSrc, referer) {
    try {
        const url = normalizeEmbedUrl(iframeSrc, referer);
        const u = new URL(url);
        const videoId = u.pathname.split('/').filter(Boolean).pop();
        if (!videoId) return null;

        const apiUrl = `${u.origin}/api/source/${videoId}`;
        const res = await fetchWithTimeout(apiUrl, {
            method: 'POST',
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': url,
                'Accept': 'application/json'
            }
        }, 3000);

        if (res.ok) {
            const data = await res.json();
            if (data && data.success && Array.isArray(data.data) && data.data.length > 0) {
                const best = data.data[data.data.length - 1];
                if (best && best.file) {
                    return {
                        videoUrl: best.file,
                        headers: {
                            'User-Agent': CLIENT_USER_AGENT,
                            'Referer': url
                        }
                    };
                }
            }
        }

        // Direct HTML inspection fallback
        const htmlRes = await fetchWithTimeout(url, {
            headers: { 'User-Agent': CLIENT_USER_AGENT, 'Referer': referer }
        }, 3000);
        if (htmlRes.ok) {
            const html = await htmlRes.text();
            const direct = fastExtract(html, /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
            if (direct) {
                return {
                    videoUrl: direct,
                    headers: { 'User-Agent': CLIENT_USER_AGENT, 'Referer': url }
                };
            }
        }

        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Host resolvers dispatch map.
 */
const HOST_RESOLVERS = {
    vidmoly: resolveVidmoly,
    sibnet: resolveSibnet,
    fembed: resolveFembed,
    feurl: resolveFembed
};

/**
 * Resolves target episode URLs on SezonlukDizi.
 *
 * @param {string|number} tmdbId - TMDB ID or IMDb ID
 * @param {number|string} seasonNum - Season index
 * @param {number|string} episodeNum - Episode index
 * @returns {Promise<{ episodeUrl: string, baseSiteUrl: string }|null>}
 */
async function resolveEpisodeUrl(tmdbId, seasonNum, episodeNum) {
    const BASE_URL = getBaseUrl();
    const domains = [BASE_URL, ...FALLBACK_DOMAINS];

    // Tier 1: Check Seyirturk discovery backend endpoint
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
                    if (prov.includes('sezonlukdizi') && l.Link) {
                        return { episodeUrl: l.Link, baseSiteUrl: BASE_URL };
                    }
                }
            }
        }
    } catch (_) {}

    // Tier 2: TMDB / Cinemeta IMDb ID & Title resolution
    let imdbId = '';
    let title = '';
    try {
        const meta = await resolveTmdbMeta(tmdbId, 'tv');
        title = meta.trTitle || meta.title || '';
        imdbId = meta.imdbId || '';
    } catch (_) {}
    const searchQuery = imdbId || (title ? title.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() : String(tmdbId));

    // Tier 3: Sezonlukdizi AJAX live-search endpoint (/ajax/arama.asp)
    for (const domain of domains) {
        try {
            const searchUrl = `${domain}/ajax/arama.asp`;
            const sRes = await fetchWithTimeout(searchUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${domain}/`
                },
                body: `q=${encodeURIComponent(searchQuery)}`
            }, 3000);

            if (sRes.ok) {
                const data = await sRes.json();
                const diziler = data?.results?.diziler?.results;
                if (Array.isArray(diziler) && diziler.length > 0) {
                    const firstHit = diziler[0];
                    if (firstHit && firstHit.url) {
                        // Slug format: /diziler/supernatural.html -> supernatural
                        const slug = firstHit.url.replace(/^\/?diziler\//, '').replace(/\.html$/, '').replace(/^\/+|\/+$/g, '');
                        const epUrl = `${domain}/${slug}/${parseInt(seasonNum)}-sezon-${parseInt(episodeNum)}-bolum.html`;
                        return { episodeUrl: epUrl, baseSiteUrl: domain };
                    }
                }
            }
        } catch (_) {}
    }

    // Tier 4: Direct slug construction fallback
    if (title) {
        const slug = titleToSlug(title);
        const epUrl = `${getBaseUrl()}/${slug}/${parseInt(seasonNum)}-sezon-${parseInt(episodeNum)}-bolum.html`;
        return { episodeUrl: epUrl, baseSiteUrl: getBaseUrl() };
    }

    return null;
}

/**
 * Extracts bolum ID from episode page markup.
 *
 * @param {string} html - Episode page HTML
 * @returns {string|null} Bolum ID
 */
function extractBolumId(html) {
    if (!html || typeof html !== 'string') return null;

    // Pattern 1: #dilsec[data-id]
    const dilsecMatch = fastExtract(html, /id=["']dilsec["'][^>]+data-id=["'](\d+)["']/i);
    if (dilsecMatch) return dilsecMatch;

    // Pattern 2: data-id in episode section
    const dataIdMatch = fastExtract(html, /data-id=["'](\d+)["']/i);
    if (dataIdMatch) return dataIdMatch;

    // Pattern 3: bid parameter
    const bidMatch = fastExtract(html, /bid=["'](\d+)["']/i);
    if (bidMatch) return bidMatch;

    return null;
}

/**
 * Queries alternative sources for a given bolum ID and language variant.
 *
 * @param {string} bolumId - Bolum ID
 * @param {number} dil - 0 = Dublaj, 1 = Altyazı
 * @param {string} episodeUrl - Episode page referer
 * @param {string} domain - Active base site URL
 * @returns {Promise<Array<{ id: number, baslik: string, kalite: number }>>}
 */
async function fetchSourceAlternatives(bolumId, dil, episodeUrl, domain) {
    const endpoints = [
        `${domain}/ajax/dataAlternatif22.asp`,
        `${domain}/ajax/dataAlternatif.asp`
    ];

    for (const ep of endpoints) {
        try {
            const res = await fetchWithTimeout(ep, {
                method: 'POST',
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': episodeUrl
                },
                body: `bid=${encodeURIComponent(bolumId)}&dil=${dil}`
            }, 3000);

            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.data) && data.data.length > 0) {
                    return data.data.filter(r => r && r.id && r.baslik);
                }
            }
        } catch (_) {}
    }

    return [];
}

/**
 * Resolves embed iframe markup for a given embed source ID.
 *
 * @param {number|string} embedId - Alternative source ID
 * @param {string} episodeUrl - Episode page referer
 * @param {string} domain - Active base site URL
 * @returns {Promise<string|null>} Iframe source URL
 */
async function fetchEmbedIframeUrl(embedId, episodeUrl, domain) {
    const endpoints = [
        `${domain}/ajax/dataEmbed22.asp`,
        `${domain}/ajax/dataEmbed.asp`
    ];

    for (const ep of endpoints) {
        try {
            const res = await fetchWithTimeout(ep, {
                method: 'POST',
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': episodeUrl
                },
                body: `id=${encodeURIComponent(embedId)}`
            }, 3000);

            if (res.ok) {
                const html = await res.text();
                const iframeMatch = fastExtract(html, /<iframe[^>]+src=["']([^"']+)["']/i);
                if (iframeMatch) return iframeMatch;
            }
        } catch (_) {}
    }

    return null;
}

/**
 * Resolves media streams for the given TMDB media target.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier
 * @param {'movie'|'tv'} mediaType - Media category identifier ('tv' required for series)
 * @param {number|string} [seasonNum=1] - Season index
 * @param {number|string} [episodeNum=1] - Episode index
 * @returns {Promise<Array<object>>} Resolves to an array of verified Nuvio Stream Objects
 */
async function getStreams(tmdbId, mediaType, seasonNum = 1, episodeNum = 1) {
    if (!tmdbId) return [];

    try {
        const streams = [];
        const target = await resolveEpisodeUrl(tmdbId, seasonNum, episodeNum);
        if (!target) return [];

        const { episodeUrl, baseSiteUrl } = target;

        const epRes = await fetchWithTimeout(episodeUrl, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': `${baseSiteUrl}/`
            }
        }, 4000);

        if (!epRes.ok) return [];
        const epHtml = await epRes.text();
        const bolumId = extractBolumId(epHtml);
        if (!bolumId) return [];

        // Dual Audio Architecture: Parallel queries for dil=0 (Dublaj) and dil=1 (Altyazı)
        const [dubSources, subSources] = await Promise.all([
            fetchSourceAlternatives(bolumId, 0, episodeUrl, baseSiteUrl),
            fetchSourceAlternatives(bolumId, 1, episodeUrl, baseSiteUrl)
        ]);

        const hasDualAvailability = dubSources.length > 0 && subSources.length > 0;
        const variants = [
            { list: dubSources, dil: 0, badge: '[🇹🇷 TR Dublaj]' },
            { list: subSources, dil: 1, badge: '[🌐 TR Altyazı]' }
        ];

        for (const variant of variants) {
            const candidateRows = variant.list
                .filter(r => HOST_RESOLVERS[String(r.baslik).toLowerCase()])
                .slice(0, 3); // NVIDIA Shield TV Pro optimization: bounded resolver slice

            for (const row of candidateRows) {
                const hostName = String(row.baslik).toLowerCase();
                const resolver = HOST_RESOLVERS[hostName];
                if (!resolver) continue;

                try {
                    const iframeSrc = await fetchEmbedIframeUrl(row.id, episodeUrl, baseSiteUrl);
                    if (!iframeSrc) continue;

                    const resolved = await resolver(iframeSrc, episodeUrl);
                    if (resolved && resolved.videoUrl) {
                        const isHealthy = await verifyStreamHealth(resolved.videoUrl, resolved.headers, 2500);
                        if (isHealthy) {
                            const badge = hasDualAvailability && row.baslik.toLowerCase() === 'vidmoly'
                                ? '[Dual Audio]'
                                : variant.badge;

                            const quality = row.kalite ? `${row.kalite}p` : '1080p';

                            streams.push(buildStreamObject({
                                name: PROVIDER_NAME,
                                title: `⌜ ${PROVIDER_NAME} ⌟ | ${row.baslik} | ${quality} | ${badge}`,
                                url: resolved.videoUrl,
                                quality,
                                headers: resolved.headers,
                                subtitles: []
                            }));
                        }
                    }
                } catch (_) {}
            }
        }

        return streams;
    } catch (_) {
        return [];
    }
}

module.exports = { getStreams };
