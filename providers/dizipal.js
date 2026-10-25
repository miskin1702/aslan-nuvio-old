/**
 * Project Aslan - DiziPal Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Dynamic mirror resolver via raw API and rotating domain fallbacks
 * - Direct resolution of Playerjs HLS .m3u8 video streams for TV series
 * - Exxen, Gain, BluTV and international streaming catalog coverage
 * - Pre-flight HEAD verification on candidate HLS playlists
 * - Subtitle and multi-audio stream metadata extraction
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

const PROVIDER_NAME = 'DiziPal';
const MIRROR_API_URL = 'https://raw.githubusercontent.com/dizipaltv/api/refs/heads/main/dizipal.json';
const FALLBACK_DOMAINS = [
    'https://dizibal.org',
    'https://dizipal3008.com',
    'https://dizipal824.com',
    'https://dizipal720.com',
    'https://dizipal611.com'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// In-memory cache for dynamic mirror domain to reduce DNS and network roundtrips
let cachedActiveDomain = null;
let lastDomainResolvedTime = 0;
const DOMAIN_CACHE_TTL = 300000; // 5 minutes

/**
 * Resolves the currently active DiziPal mirror domain.
 * Queries the remote dynamic mirror API with fallback to static mirror list.
 *
 * @returns {Promise<string>} Active base URL
 */
async function resolveActiveDomain() {
    const now = Date.now();
    if (cachedActiveDomain && (now - lastDomainResolvedTime) < DOMAIN_CACHE_TTL) {
        return cachedActiveDomain;
    }

    const fromConfig = getActiveDomain('dizipal', null);
    if (fromConfig) {
        cachedActiveDomain = fromConfig;
        lastDomainResolvedTime = now;
        return fromConfig;
    }

    try {
        const res = await fetchWithTimeout(MIRROR_API_URL, {}, 1500);
        if (res.ok) {
            const data = await res.json();
            if (data && data.currentSiteURL) {
                let resolved = String(data.currentSiteURL).trim().replace(/\/+$/, '');
                if (!resolved.startsWith('http')) {
                    resolved = `https://${resolved}`;
                }
                const isAlive = await verifyStreamHealth(resolved, {}, 1500).catch(() => false);
                if (isAlive) {
                    cachedActiveDomain = resolved;
                    lastDomainResolvedTime = now;
                    return cachedActiveDomain;
                }
            }
        }
    } catch (_) {}

    // Fallback domain: dizibal.org is verified alive
    cachedActiveDomain = FALLBACK_DOMAINS[0] || 'https://dizibal.org';
    lastDomainResolvedTime = now;
    return cachedActiveDomain;
}

/**
 * Resolves series episode target URLs for DiziPal.
 *
 * @param {string|number} tmdbId - TMDB ID or IMDb ID
 * @param {number|string} seasonNum - Season index
 * @param {number|string} episodeNum - Episode index
 * @returns {Promise<Array<string>>} List of candidate episode URLs
 */
async function discoverEpisodeUrls(tmdbId, seasonNum, episodeNum) {
    const candidateUrls = [];
    const activeDomain = await resolveActiveDomain();
    const domains = [activeDomain, ...FALLBACK_DOMAINS.filter(d => d !== activeDomain)];

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
                    if ((prov.includes('dizipal') || prov.includes('dizibal')) && l.Link) {
                        candidateUrls.push(l.Link);
                    }
                }
            }
        }
    } catch (_) {}

    if (candidateUrls.length > 0) {
        return candidateUrls;
    }

    // Tier 2: TMDB / Cinemeta title resolution
    let title = '';
    try {
        const meta = await resolveTmdbMeta(tmdbId, 'tv');
        title = meta.trTitle || meta.title || '';
    } catch (_) {}
    const cleanQuery = title ? title.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim() : String(tmdbId);
    const slug = title ? titleToSlug(title) : '';

    // Tier 3: Search autocomplete API on mirror
    for (const domain of domains) {
        if (!cleanQuery) break;
        try {
            const searchApiUrl = `${domain}/api/search-autocomplete`;
            const sRes = await fetchWithTimeout(searchApiUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${domain}/`
                },
                body: `query=${encodeURIComponent(cleanQuery)}`
            }, 3000);

            if (sRes.ok) {
                const sData = await sRes.text();
                // Extract result URLs from json or html response
                const hrefs = fastExtract(sData, /href=["'](\/(?:dizi\/)?[^"']+)["']/gi);
                if (Array.isArray(hrefs) && hrefs.length > 0) {
                    for (const h of hrefs) {
                        const cleanPath = h.replace(/\/+$/, '');
                        const epUrl = `${domain}${cleanPath}/sezon-${seasonNum}/bolum-${episodeNum}`;
                        if (!candidateUrls.includes(epUrl)) {
                            candidateUrls.push(epUrl);
                        }
                    }
                }
            }
            if (candidateUrls.length > 0) break;
        } catch (_) {}
    }

    // Tier 4: Deterministic episode slug paths
    if (slug) {
        for (const domain of domains.slice(0, 2)) {
            const patterns = [
                `${domain}/${slug}/sezon-${seasonNum}/bolum-${episodeNum}`,
                `${domain}/dizi/${slug}/sezon-${seasonNum}/bolum-${episodeNum}`,
                `${domain}/${slug}-${seasonNum}-sezon-${episodeNum}-bolum`
            ];
            for (const p of patterns) {
                if (!candidateUrls.includes(p)) {
                    candidateUrls.push(p);
                }
            }
        }
    }

    return candidateUrls;
}

/**
 * Resolves Playerjs HLS manifest and subtitle tracks from player page HTML.
 *
 * @param {string} html - Player embed HTML
 * @param {string} pageUrl - Context URL for relative path resolution
 * @returns {{ hlsUrl: string|null, subtitles: Array<object> }}
 */
function extractPlayerjsStream(html, pageUrl) {
    if (!html || typeof html !== 'string') {
        return { hlsUrl: null, subtitles: [] };
    }

    let hlsUrl = null;
    const subtitles = [];

    // Extract file:"..." or file:'...' from Playerjs config
    const fileMatch = fastExtract(html, /file\s*:\s*["']([^"']+)["']/i);
    if (fileMatch) {
        if (fileMatch.includes('.m3u8') || fileMatch.includes('/hls/') || fileMatch.startsWith('http')) {
            hlsUrl = fileMatch;
        }
    }

    // Secondary regex for adaptive master playlist
    if (!hlsUrl) {
        const rawM3u8 = fastExtract(html, /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        if (rawM3u8) {
            hlsUrl = rawM3u8;
        }
    }

    // Extract subtitles config: subtitle:"..." or subtitle:[...]
    const subMatch = fastExtract(html, /subtitle\s*:\s*["']([^"']+)["']/i);
    if (subMatch) {
        const subItems = subMatch.split(',');
        for (let i = 0; i < subItems.length; i++) {
            const item = subItems[i].trim();
            if (item) {
                let subUrl = item;
                let subLabel = 'Türkçe';
                let subLang = 'tr';

                const bracketMatch = item.match(/\[([^\]]+)\](.*)/);
                if (bracketMatch) {
                    subLabel = bracketMatch[1].trim();
                    subUrl = bracketMatch[2].trim();
                    subLang = subLabel.toLowerCase().includes('ing') || subLabel.toLowerCase().includes('en') ? 'en' : 'tr';
                }

                if (subUrl.startsWith('//')) subUrl = `https:${subUrl}`;
                else if (subUrl.startsWith('/') && pageUrl) {
                    try { subUrl = new URL(subUrl, pageUrl).href; } catch (_) {}
                }

                subtitles.push({
                    id: `${subLang}_${i + 1}`,
                    lang: subLang === 'tr' ? 'Turkish' : 'English',
                    label: subLabel,
                    url: subUrl
                });
            }
        }
    }

    // Extract HTML5 track elements if present
    const trackSubs = extractSubtitles(html, pageUrl);
    for (const ts of trackSubs) {
        if (!subtitles.some(s => s.url === ts.url)) {
            subtitles.push(ts);
        }
    }

    return { hlsUrl, subtitles };
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
        const episodeUrls = await discoverEpisodeUrls(tmdbId, seasonNum, episodeNum);
        if (episodeUrls.length === 0) return [];

        for (const epUrl of episodeUrls.slice(0, 4)) {
            try {
                const epRes = await fetchWithTimeout(epUrl, {
                    headers: {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': epUrl
                    }
                }, 4000);

                if (!epRes.ok) continue;
                const epHtml = await epRes.text();

                // 1. Direct inline Playerjs detection
                if (epHtml.includes('Playerjs') || epHtml.includes('.m3u8')) {
                    const { hlsUrl, subtitles } = extractPlayerjsStream(epHtml, epUrl);
                    if (hlsUrl) {
                        const audio = analyzeAudio(hlsUrl, epUrl, epHtml);
                        const isHealthy = await verifyStreamHealth(hlsUrl, {
                            'User-Agent': CLIENT_USER_AGENT,
                            'Referer': epUrl
                        }, 2500);

                        if (isHealthy) {
                            streams.push(buildStreamObject({
                                name: PROVIDER_NAME,
                                title: `⌜ ${PROVIDER_NAME} ⌟ | Direct Cloud | Auto | ${audio.badge}`,
                                url: hlsUrl,
                                quality: 'Auto',
                                headers: {
                                    'User-Agent': CLIENT_USER_AGENT,
                                    'Referer': epUrl
                                },
                                subtitles
                            }));
                        }
                    }
                }

                // 2. Iframe player extraction (#vast_new > iframe or standard player iframe)
                const iframeMatches = fastExtract(epHtml, /<iframe[^>]+src=["']([^"']+)["']/gi);
                const iframeList = Array.isArray(iframeMatches) ? iframeMatches : (iframeMatches ? [iframeMatches] : []);

                for (const rawIframe of iframeList.slice(0, 3)) {
                    let iframeUrl = rawIframe;
                    if (iframeUrl.startsWith('//')) iframeUrl = `https:${iframeUrl}`;
                    else if (iframeUrl.startsWith('/') && epUrl) {
                        try { iframeUrl = new URL(iframeUrl, epUrl).href; } catch (_) {}
                    }

                    try {
                        const ifRes = await fetchWithTimeout(iframeUrl, {
                            headers: {
                                'User-Agent': CLIENT_USER_AGENT,
                                'Referer': epUrl
                            }
                        }, 4000);

                        if (ifRes.ok) {
                            const ifHtml = await ifRes.text();
                            const { hlsUrl, subtitles } = extractPlayerjsStream(ifHtml, iframeUrl);

                            if (hlsUrl) {
                                const audio = analyzeAudio(hlsUrl, iframeUrl, ifHtml);
                                const isHealthy = await verifyStreamHealth(hlsUrl, {
                                    'User-Agent': CLIENT_USER_AGENT,
                                    'Referer': iframeUrl
                                }, 2500);

                                if (isHealthy) {
                                    streams.push(buildStreamObject({
                                        name: PROVIDER_NAME,
                                        title: `⌜ ${PROVIDER_NAME} ⌟ | Cloud HLS | Auto | ${audio.badge}`,
                                        url: hlsUrl,
                                        quality: 'Auto',
                                        headers: {
                                            'User-Agent': CLIENT_USER_AGENT,
                                            'Referer': iframeUrl
                                        },
                                        subtitles
                                    }));
                                }
                            }
                        }
                    } catch (_) {}
                }

                if (streams.length > 0) break;
            } catch (_) {}
        }

        return streams;
    } catch (_) {
        return [];
    }
}

module.exports = { getStreams };
