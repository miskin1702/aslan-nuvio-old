/**
 * Project Aslan - SineWix Provider (sinewix.js)
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - SineWix EasyPlex API (https://ydfvfdizipanel.ru/public/api)
 * - Cryptographic request signing: HMAC-SHA256 signature, SHA-256 cert fingerprint, X-Nonce, X-Timestamp
 * - Emulated EasyPlex Android client headers & User-Agent
 * - MediaFire resolver extracting direct high-speed MP4 video download URLs (<1ms micro-parse)
 * - Direct server MP4 & HLS stream resolver with audio tagging ([🇹🇷 TR Dublaj] / [🌐 TR Altyazı])
 * - Full Movie & TV series (Season/Episode) stream resolution
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
    resolveTmdbMeta
} = require('../src/utils/stream-helper');

const BASE_URL = 'https://ydfvfdizipanel.ru/public/api';
const API_ENDPOINTS = [
    'https://ydfvfdizipanel.ru/public/api',
    'https://ydfvfdizipanel.ru/api'
];
const PROVIDER_NAME = 'SineWix';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';

// Mobile Security Credentials & Certificate Fingerprints
const HMAC_SECRET = '32FD53071AAF9D36080510C617DCD08B7B19A1AABA8502C1484FC4961BD630DB';
const CERT_SHA256 = 'b59172c12626fad229b3c1be79cd59ea31bb1b4f908a0250deed650ce0a40741';
const CERT_CHARS = '0301000000010000532abbf68dc43c478fedcfc102a00cb9219b646c26881729';
const APP_PACKAGE = 'com.wxsmash.game';
const EASYPLEX_USER_AGENT = 'EasyPlex (Android 11; Pixel 5; google redfin; tr)';

/**
 * Generates cryptographic headers for SineWix EasyPlex API.
 *
 * @param {'GET'|'POST'} method - HTTP method
 * @param {string} path - API endpoint path (e.g. /api/media/detail/550)
 * @param {string} [body=''] - Raw JSON body if applicable
 * @returns {Object} Request headers object
 */
function createSignedHeaders(method = 'GET', path = '', body = '') {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(18).toString('base64');
    const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');

    // Extract path starting with /api/
    const apiIndex = path.indexOf('/api/');
    const canonicalPath = apiIndex !== -1 ? path.substring(apiIndex) : (path.startsWith('/') ? path : `/${path}`);

    // Canonical string: METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
    const canonicalString = `${method.toUpperCase()}\n${canonicalPath}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const hmacHex = crypto.createHmac('sha256', HMAC_SECRET).update(canonicalString).digest('hex');
    const signature = `sha256=${hmacHex}`;

    return {
        'User-Agent': EASYPLEX_USER_AGENT,
        'Accept': 'application/json',
        'packagename': APP_PACKAGE,
        'X-App-Id': APP_PACKAGE,
        'X-Platform': 'android',
        'X-Client-Build': '1',
        'X-Device-Id': '8fe21e37-8a1c-45f0-9085-b992892f8d07',
        'signature': CERT_CHARS,
        'hash256': CERT_SHA256,
        'X-App-Signing-Sha256': CERT_SHA256,
        'X-Timestamp': String(timestamp),
        'X-Nonce': nonce,
        'X-Signature': signature
    };
}

/**
 * Resolves localized media title from TMDB ID.
 *
 * @param {string|number} tmdbId - TMDB ID
 * @param {'movie'|'tv'} mediaType - 'movie' or 'tv'
 * @returns {Promise<string>} Localized name or string ID
 */
async function resolveTitle(tmdbId, mediaType) {
    try {
        const meta = await resolveTmdbMeta(tmdbId, mediaType);
        return meta.trTitle || meta.title || String(tmdbId);
    } catch (_) {
        return String(tmdbId);
    }
}

/**
 * Resolves direct download link from a MediaFire URL via fast regex micro-parsing.
 *
 * @param {string} mediafireUrl - MediaFire link
 * @returns {Promise<string|null>} Direct MP4 download URL or null
 */
async function resolveMediaFire(mediafireUrl) {
    if (!mediafireUrl || typeof mediafireUrl !== 'string') return null;

    try {
        const cleanUrl = mediafireUrl.startsWith('//') ? `https:${mediafireUrl}` : mediafireUrl;
        const res = await fetchWithTimeout(cleanUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
            }
        }, 3500);

        if (!res.ok) return null;
        const html = await res.text();

        // High-speed regex extraction of downloadButton link (<1ms budget)
        let directUrl = fastExtract(html, /<a\b[^>]*\bid=["']downloadButton["'][^>]*\bhref=["']([^"']+)["']/i);
        if (!directUrl) {
            directUrl = fastExtract(html, /aria-label=["']Download file["'][^>]*href=["'](https?:\/\/[^"']+)["']/i);
        }
        if (!directUrl) {
            directUrl = fastExtract(html, /href=["'](https?:\/\/(?:download\d*\.mediafire\.com|download\.mediafire\.com)[^"']+)["']/i);
        }

        return directUrl || null;
    } catch (_) {
        return null;
    }
}

/**
 * Queries SineWix API for movie media details.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier
 * @returns {Promise<Object|null>} Movie detail object
 */
async function fetchMovieDetails(tmdbId) {
    for (const baseUrl of API_ENDPOINTS) {
        try {
            const path = `${baseUrl}/media/detail/${tmdbId}`;
            const headers = createSignedHeaders('GET', path);
            const res = await fetchWithTimeout(path, { headers }, 3500);
            if (res.ok) {
                const data = await res.json();
                if (data && (data.videos || data.id)) return data;
            }
        } catch (_) {}
    }
    return null;
}

/**
 * Queries SineWix API for series media details.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier
 * @returns {Promise<Object|null>} Series detail object
 */
async function fetchSeriesDetails(tmdbId) {
    for (const baseUrl of API_ENDPOINTS) {
        try {
            const path = `${baseUrl}/series/show/${tmdbId}`;
            const headers = createSignedHeaders('GET', path);
            const res = await fetchWithTimeout(path, { headers }, 3500);
            if (res.ok) {
                const data = await res.json();
                if (data && (data.seasons || data.id)) return data;
            }
        } catch (_) {}
    }
    return null;
}

/**
 * Queries SineWix API search endpoint by title.
 *
 * @param {string} query - Clean media title
 * @returns {Promise<Array<Object>>} Search results
 */
async function searchSineWix(query) {
    const encoded = encodeURIComponent(query);
    for (const baseUrl of API_ENDPOINTS) {
        try {
            const path = `${baseUrl}/search/${encoded}`;
            const headers = createSignedHeaders('GET', path);
            const res = await fetchWithTimeout(path, { headers }, 3500);
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.search)) return data.search;
                if (Array.isArray(data)) return data;
            }
        } catch (_) {}
    }
    return [];
}

/**
 * Resolves media streams from SineWix API for given target.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier
 * @param {'movie'|'tv'} mediaType - 'movie' or 'tv'
 * @param {number|string} [seasonNum] - Season index (1-based)
 * @param {number|string} [episodeNum] - Episode index (1-based)
 * @returns {Promise<Array<Object>>} Resolved Nuvio Stream Objects
 */
async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    const streams = [];

    try {
        // Fast-path: Check Seyirturk backend discovery for pre-resolved SineWix links
        try {
            const discoveryUrl = `${BACKEND_DISCOVERY_URL}?id=${encodeURIComponent(tmdbId)}&u_id=0&vn=1005&includeYK=1`;
            const dRes = await fetchWithTimeout(discoveryUrl, {
                headers: {
                    'User-Agent': EASYPLEX_USER_AGENT,
                    'bety': 'jughead'
                }
            }, 2500);

            if (dRes.ok) {
                const dData = await dRes.json();
                if (dData && Array.isArray(dData.links)) {
                    for (const l of dData.links) {
                        const prov = String(l.Provider || l.MainProvider || '').toLowerCase();
                        if (prov.includes('sinewix') && l.Link) {
                            let streamUrl = String(l.Link);
                            if (streamUrl.includes('mediafire.com')) {
                                const directMf = await resolveMediaFire(streamUrl);
                                if (directMf) streamUrl = directMf;
                            }

                            const audio = analyzeAudio(streamUrl, l.Title || '', '');
                            const streamObj = buildStreamObject({
                                name: l.Title || `${PROVIDER_NAME} Stream`,
                                title: `⌜ ${PROVIDER_NAME} ⌟ | Direct MP4 | 1080p | ${audio.badge}`,
                                url: streamUrl,
                                quality: '1080p',
                                headers: {
                                    'User-Agent': EASYPLEX_USER_AGENT,
                                    'Referer': `${BASE_URL}/`
                                },
                                behaviorHints: {
                                    notWebReady: false,
                                    bingeGroup: `aslan-sinewix-${tmdbId}`
                                }
                            });

                            const isHealthy = await verifyStreamHealth(streamObj.url, streamObj.headers, 2000).catch(() => true);
                            if (isHealthy) {
                                streams.push(streamObj);
                            }
                        }
                    }
                }
            }
        } catch (_) {}

        if (streams.length > 0) {
            return streams;
        }

        // Tier 2: Query SineWix API by TMDB ID
        let mediaData = null;
        if (mediaType === 'tv') {
            mediaData = await fetchSeriesDetails(tmdbId);
        } else {
            mediaData = await fetchMovieDetails(tmdbId);
        }

        // Tier 3: Search fallback by title if direct TMDB lookup misses
        if (!mediaData) {
            const title = await resolveTitle(tmdbId, mediaType);
            if (title) {
                const cleanQuery = title.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
                const searchResults = await searchSineWix(cleanQuery);
                if (Array.isArray(searchResults) && searchResults.length > 0) {
                    const normalizedTitle = titleToSlug(title);
                    const matched = searchResults.find((item) => {
                        const iSlug = titleToSlug(item.title || item.name || '');
                        return iSlug && (iSlug.includes(normalizedTitle) || normalizedTitle.includes(iSlug));
                    }) || searchResults[0];

                    if (matched && matched.id) {
                        if (mediaType === 'tv') {
                            mediaData = await fetchSeriesDetails(matched.id);
                        } else {
                            mediaData = await fetchMovieDetails(matched.id);
                        }
                    }
                }
            }
        }

        if (!mediaData) {
            return streams;
        }

        // Extract video entries from movie or season/episode
        let videoEntries = [];

        if (mediaType === 'tv') {
            const targetSeason = parseInt(seasonNum, 10) || 1;
            const targetEpisode = parseInt(episodeNum, 10) || 1;

            if (Array.isArray(mediaData.seasons)) {
                const seasonObj = mediaData.seasons.find((s) => (parseInt(s.season_number || s.number, 10) === targetSeason)) || mediaData.seasons[targetSeason - 1];
                if (seasonObj && Array.isArray(seasonObj.episodes)) {
                    const epObj = seasonObj.episodes.find((e) => (parseInt(e.episode_number || e.number, 10) === targetEpisode)) || seasonObj.episodes[targetEpisode - 1];
                    if (epObj && Array.isArray(epObj.videos)) {
                        videoEntries = epObj.videos;
                    }
                }
            }
        } else if (Array.isArray(mediaData.videos)) {
            videoEntries = mediaData.videos;
        }

        for (const video of videoEntries) {
            let streamUrl = video.link || video.url || '';
            if (!streamUrl || typeof streamUrl !== 'string') continue;

            // Handle MediaFire links
            if (streamUrl.includes('mediafire.com')) {
                const resolvedMf = await resolveMediaFire(streamUrl);
                if (resolvedMf) {
                    streamUrl = resolvedMf;
                }
            }

            const serverName = video.server || (streamUrl.includes('mediafire.com') ? 'MediaFire' : 'Direct Server');
            const audio = analyzeAudio(streamUrl, `${video.lang || ''} ${video.name || ''}`, '');
            const rawQuality = video.hd || (streamUrl.includes('1080') ? '1080p' : (streamUrl.includes('720') ? '720p' : 'Auto'));

            const streamObj = buildStreamObject({
                name: mediaData.title || mediaData.name || `${PROVIDER_NAME} Stream`,
                title: `⌜ ${PROVIDER_NAME} ⌟ | ${serverName} | ${rawQuality} | ${audio.badge}`,
                url: streamUrl,
                quality: rawQuality,
                headers: {
                    'User-Agent': EASYPLEX_USER_AGENT,
                    'Referer': `${BASE_URL}/`
                },
                behaviorHints: {
                    notWebReady: false,
                    bingeGroup: `aslan-sinewix-${tmdbId}`
                }
            });

            const isHealthy = await verifyStreamHealth(streamObj.url, streamObj.headers, 2000).catch(() => true);
            if (isHealthy) {
                streams.push(streamObj);
            }
        }
    } catch (_) {
        return [];
    }

    return streams;
}

module.exports = {
    getStreams,
    resolveMediaFire,
    createSignedHeaders
};
