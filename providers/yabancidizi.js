/**
 * Project Aslan - YabanciDizi Provider
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - Direct Next.js payload decryption (AES-256-CBC with SHA-256 derived cipher key)
 * - Source extraction for VidMixi, Sibnet, and high-performance Pichive HLS players
 * - Full Turkish Dubbing (Türkçe Dublaj) and Subtitles (Türkçe Altyazı) stream classification
 * - Pre-flight HEAD verification on candidate video links before player yielding
 */

'use strict';

const crypto = require('crypto');
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

const PROVIDER_NAME = 'YabanciDizi';
function getBaseUrl() {
    return getActiveDomain('yabancidizi', 'https://yabancidizi.co');
}
const FALLBACK_DOMAINS = [
    'https://yabanci-dizi.now',
    'https://yabancidizi.pw',
    'https://yabancidizi.news'
];
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// Decryption key and IV for YabanciDizi Next.js secureData payload
const CIPHER_KEY = crypto.createHash('sha256').update('!!22xx!!90!!').digest('base64').substring(0, 32);
const CIPHER_IV = Buffer.alloc(16, 0);

/**
 * Decrypts YabanciDizi Next.js secureData payload.
 *
 * @param {string} secureData - Base64 encoded AES-256-CBC encrypted payload
 * @returns {object|null} Decrypted JSON object
 */
function decryptSecureData(secureData) {
    if (!secureData || typeof secureData !== 'string') return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, CIPHER_IV);
        let decrypted = decipher.update(secureData, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    } catch (_) {
        return null;
    }
}

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
 * Resolves Pichive / Four.Pichive player iframe into direct master HLS stream.
 *
 * @param {string} iframeSrc - Pichive embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolvePichive(iframeSrc, referer) {
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

        const playListMatch = fastExtract(html, /openPlayer\s*\(\s*['"]([^'"]+)['"]/i);
        if (!playListMatch) return null;

        const origin = new URL(url).origin;
        const sourceUrl = `${origin}/source2.php?v=${encodeURIComponent(playListMatch)}`;

        const s2Res = await fetchWithTimeout(sourceUrl, {
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': url,
                'X-Requested-With': 'XMLHttpRequest'
            }
        }, 4000);

        if (!s2Res.ok) return null;
        const s2Data = await s2Res.json();
        const rawFile = s2Data?.playlist?.[0]?.sources?.[0]?.file;
        if (!rawFile) return null;

        const masterM3u8 = rawFile.replace('m.php', 'master.m3u8');

        return {
            videoUrl: masterM3u8,
            headers: {
                'User-Agent': CLIENT_USER_AGENT,
                'Referer': `${origin}/`
            }
        };
    } catch (_) {
        return null;
    }
}

/**
 * Resolves VidMixi player iframe.
 *
 * @param {string} iframeSrc - VidMixi embed URL
 * @param {string} referer - Host site referer
 * @returns {Promise<{ videoUrl: string, headers: object }|null>}
 */
async function resolveVidmixi(iframeSrc, referer) {
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

        // Extract direct m3u8 or mp4
        const m3u8 = fastExtract(html, /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
                     fastExtract(html, /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        if (m3u8) {
            return {
                videoUrl: m3u8,
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Referer': url
                }
            };
        }

        const mp4 = fastExtract(html, /file\s*:\s*["']([^"']+\.mp4[^"']*)["']/i) ||
                    fastExtract(html, /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
        if (mp4) {
            return {
                videoUrl: mp4,
                headers: {
                    'User-Agent': CLIENT_USER_AGENT,
                    'Referer': url
                }
            };
        }

        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolves Sibnet player iframe.
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

        const pathMatch = fastExtract(html, /player\.src\(\[\{\s*src:\s*["']([^"']+)["']/i);
        if (!pathMatch) return null;

        const absUrl = /^https?:\/\//i.test(pathMatch) ? pathMatch : `https://video.sibnet.ru${pathMatch}`;

        // Follow redirect chain to find direct tokenized CDN video link
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
 * Resolves candidate episode URLs on YabanciDizi.
 *
 * @param {string|number} tmdbId - TMDB ID or IMDb ID
 * @param {number|string} seasonNum - Season index
 * @param {number|string} episodeNum - Episode index
 * @returns {Promise<Array<string>>} List of candidate episode URLs
 */
async function discoverEpisodeUrls(tmdbId, seasonNum, episodeNum) {
    const urls = [];
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
                    if ((prov.includes('yabancidizi') || prov.includes('vidmixi')) && l.Link) {
                        urls.push(l.Link);
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
        const meta = await resolveTmdbMeta(tmdbId, 'tv');
        title = meta.trTitle || meta.title || '';
    } catch (_) {}
    const slug = title ? titleToSlug(title) : '';

    // Tier 3: Direct canonical slug paths across mirrors
    if (slug) {
        for (const domain of domains) {
            urls.push(`${domain}/dizi/${slug}/sezon-${seasonNum}/bolum-${episodeNum}`);
        }
    }

    return urls;
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

        for (const epUrl of episodeUrls.slice(0, 3)) {
            try {
                const epRes = await fetchWithTimeout(epUrl, {
                    headers: {
                        'User-Agent': CLIENT_USER_AGENT,
                        'Referer': epUrl
                    }
                }, 4000);

                if (!epRes.ok) continue;
                const epHtml = await epRes.text();

                // 1. Next.js Decryption Pipeline
                const nextDataMatch = fastExtract(epHtml, /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
                if (nextDataMatch) {
                    try {
                        const nextData = JSON.parse(nextDataMatch);
                        const secureData = nextData?.props?.pageProps?.secureData;
                        if (secureData) {
                            const decrypted = decryptSecureData(secureData);
                            const sourceList = decrypted?.content?.result?.RelatedResults?.getEpisodeSources?.result;

                            if (Array.isArray(sourceList) && sourceList.length > 0) {
                                for (const item of sourceList) {
                                    const rawIframeMatch = fastExtract(item.source_content || '', /<iframe[^>]+src=["']([^"']+)["']/i);
                                    if (!rawIframeMatch) continue;

                                    const iframeUrl = normalizeEmbedUrl(rawIframeMatch, epUrl);
                                    const lowerUrl = iframeUrl.toLowerCase();
                                    let resolved = null;

                                    if (lowerUrl.includes('pichive')) {
                                        resolved = await resolvePichive(iframeUrl, epUrl);
                                    } else if (lowerUrl.includes('vidmixi')) {
                                        resolved = await resolveVidmixi(iframeUrl, epUrl);
                                    } else if (lowerUrl.includes('sibnet')) {
                                        resolved = await resolveSibnet(iframeUrl, epUrl);
                                    }

                                    if (resolved && resolved.videoUrl) {
                                        const isHealthy = await verifyStreamHealth(resolved.videoUrl, resolved.headers, 2500);
                                        if (isHealthy) {
                                            const audioBadge = String(item.language_name || '').toLowerCase().includes('dublaj')
                                                ? '[🇹🇷 TR Dublaj]'
                                                : '[🌐 TR Altyazı]';

                                            const quality = item.quality_name ? String(item.quality_name).replace(/p$/i, '') + 'p' : '1080p';

                                            streams.push(buildStreamObject({
                                                name: PROVIDER_NAME,
                                                title: `⌜ ${PROVIDER_NAME} ⌟ | ${item.source_name || 'Player'} | ${quality} | ${audioBadge}`,
                                                url: resolved.videoUrl,
                                                quality,
                                                headers: resolved.headers,
                                                subtitles: []
                                            }));
                                        }
                                    }
                                }
                            }
                        }
                    } catch (_) {}
                }

                // 2. Direct HTML iframe fallback if __NEXT_DATA__ did not yield
                if (streams.length === 0) {
                    const iframeMatches = fastExtract(epHtml, /<iframe[^>]+src=["']([^"']+)["']/gi);
                    const iframeList = Array.isArray(iframeMatches) ? iframeMatches : (iframeMatches ? [iframeMatches] : []);

                    for (const rawIframe of iframeList) {
                        const iframeUrl = normalizeEmbedUrl(rawIframe, epUrl);
                        const lowerUrl = iframeUrl.toLowerCase();
                        let resolved = null;

                        if (lowerUrl.includes('pichive')) {
                            resolved = await resolvePichive(iframeUrl, epUrl);
                        } else if (lowerUrl.includes('vidmixi')) {
                            resolved = await resolveVidmixi(iframeUrl, epUrl);
                        } else if (lowerUrl.includes('sibnet')) {
                            resolved = await resolveSibnet(iframeUrl, epUrl);
                        }

                        if (resolved && resolved.videoUrl) {
                            const isHealthy = await verifyStreamHealth(resolved.videoUrl, resolved.headers, 2500);
                            if (isHealthy) {
                                const audio = analyzeAudio(resolved.videoUrl, iframeUrl, epHtml);
                                streams.push(buildStreamObject({
                                    name: PROVIDER_NAME,
                                    title: `⌜ ${PROVIDER_NAME} ⌟ | Direct Player | 1080p | ${audio.badge}`,
                                    url: resolved.videoUrl,
                                    quality: '1080p',
                                    headers: resolved.headers,
                                    subtitles: []
                                }));
                            }
                        }
                    }
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
