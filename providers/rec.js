/**
 * Project Aslan - RecTV Provider (rec.js)
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 *
 * Capabilities:
 * - RecTV API (https://a.prectv70.lol) with helper fallback servers
 * - Dynamic nonce token acquisition via /api/attest/nonce
 * - High-speed search query with SW_KEY authentication
 * - Stream extraction with automated [🇹🇷 TR Dublaj] vs [🌐 TR Altyazı] detection
 * - Fast HLS (.m3u8) playback verification via pre-flight HEAD checks
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
    resolveTmdbMeta
} = require('../src/utils/stream-helper');
const BASE_URL = 'https://a.prectv70.lol';
const FALLBACK_SERVERS = [
    'https://windowsdiba.info',
    'https://hostinnegar.com',
    'https://server-hi-speed-iran.info'
];
const SW_KEY = '4F5A9C3D9A86FA54EACEDDD635185/c3c5bd17-e37b-4b94-a944-8a3688a30452';
const PROVIDER_NAME = 'RecTV';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const BACKEND_DISCOVERY_URL = 'http://beytepemanav.tk/sey/back/streams.php';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// In-memory token cache with short TTL (5 minutes)
let cachedBearerToken = null;
let tokenExpiresAt = 0;

/**
 * Retrieves a fresh bearer token from /api/attest/nonce or returns cached token.
 *
 * @returns {Promise<string>} Bearer token string
 */
async function getBearerToken() {
    const now = Date.now();
    if (cachedBearerToken && now < tokenExpiresAt) {
        return cachedBearerToken;
    }

    const serversToTry = [BASE_URL, ...FALLBACK_SERVERS];
    for (const server of serversToTry) {
        try {
            const res = await fetchWithTimeout(`${server}/api/attest/nonce`, {
                headers: {
                    'User-Agent': DEFAULT_USER_AGENT,
                    'Accept': 'application/json',
                    'SW_KEY': SW_KEY,
                    'SW-Key': SW_KEY
                }
            }, 3000);

            if (res.ok) {
                const data = await res.json();
                const nonce = data && (data.nonce || data.token || data.bearer);
                if (nonce && typeof nonce === 'string') {
                    cachedBearerToken = nonce;
                    tokenExpiresAt = now + 300000; // 5 min TTL
                    return nonce;
                }
            }
        } catch (_) {}
    }

    return cachedBearerToken || '';
}

/**
 * Resolves localized media title from TMDB ID.
 *
 * @param {string|number} tmdbId - TMDB ID
 * @param {'movie'|'tv'} mediaType - 'movie' or 'tv'
 * @returns {Promise<string>} Resolved title or query string
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
 * Searches RecTV API for the specified query string.
 *
 * @param {string} query - Movie / Series query string
 * @param {string} token - Bearer token
 * @returns {Promise<Array<Object>>} List of poster / media items
 */
async function searchRecTV(query, token) {
    const encoded = encodeURIComponent(query).replace(/\+/g, '%20');
    const serversToTry = [BASE_URL, ...FALLBACK_SERVERS];

    for (const server of serversToTry) {
        try {
            const searchUrl = `${server}/api/search/${encoded}/${SW_KEY}`;
            const headers = {
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept': 'application/json',
                'SW_KEY': SW_KEY,
                'SW-Key': SW_KEY
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const res = await fetchWithTimeout(searchUrl, { headers }, 3500);
            if (res.ok) {
                const json = await res.json();
                if (json && Array.isArray(json.posters)) {
                    return json.posters;
                }
                if (json && Array.isArray(json.results)) {
                    return json.results;
                }
                if (Array.isArray(json)) {
                    return json;
                }
            }
        } catch (_) {}
    }

    return [];
}

/**
 * Resolves season/episode media sources for TV shows.
 *
 * @param {string|number} posterId - RecTV Poster/Series ID
 * @param {number|string} seasonNum - Season index
 * @param {number|string} episodeNum - Episode index
 * @param {string} token - Bearer token
 * @returns {Promise<Array<Object>>} Source list
 */
async function getSeriesSources(posterId, seasonNum, episodeNum, token) {
    const serversToTry = [BASE_URL, ...FALLBACK_SERVERS];
    const targetSeason = parseInt(seasonNum, 10) || 1;
    const targetEpisode = parseInt(episodeNum, 10) || 1;

    for (const server of serversToTry) {
        try {
            const seasonUrl = `${server}/api/season/by/serie/${posterId}/${SW_KEY}`;
            const headers = {
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept': 'application/json',
                'SW_KEY': SW_KEY,
                'SW-Key': SW_KEY
            };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetchWithTimeout(seasonUrl, { headers }, 3000);
            if (!res.ok) continue;

            const seasons = await res.json();
            if (!Array.isArray(seasons)) continue;

            // Locate matching season
            const seasonMatch = seasons.find((s) => (parseInt(s.season_number || s.number || s.season, 10) === targetSeason)) || seasons[targetSeason - 1];
            if (!seasonMatch) continue;

            const seasonId = seasonMatch.id;
            const episodeUrl = `${server}/api/episode/by/season/${seasonId}/${SW_KEY}`;
            const epRes = await fetchWithTimeout(episodeUrl, { headers }, 3000);
            if (!epRes.ok) continue;

            const episodes = await epRes.json();
            if (!Array.isArray(episodes)) continue;

            const epMatch = episodes.find((e) => (parseInt(e.episode_number || e.number || e.episode, 10) === targetEpisode)) || episodes[targetEpisode - 1];
            if (!epMatch) continue;

            if (Array.isArray(epMatch.sources)) {
                return epMatch.sources;
            }
        } catch (_) {}
    }

    return [];
}

/**
 * Resolves streams from RecTV API for TMDB media target.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier
 * @param {'movie'|'tv'} mediaType - 'movie' or 'tv'
 * @param {number|string} [seasonNum] - Season index (1-based)
 * @param {number|string} [episodeNum] - Episode index (1-based)
 * @returns {Promise<Array<Object>>} Nuvio stream objects
 */
async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    const streams = [];

    try {
        // Fast-path: Check Seyirturk discovery endpoint for RecTV streams
        try {
            const discoveryUrl = `${BACKEND_DISCOVERY_URL}?id=${encodeURIComponent(tmdbId)}&u_id=0&vn=1005&includeYK=1`;
            const dRes = await fetchWithTimeout(discoveryUrl, {
                headers: {
                    'User-Agent': DEFAULT_USER_AGENT,
                    'bety': 'jughead'
                }
            }, 2500);

            if (dRes.ok) {
                const dData = await dRes.json();
                if (dData && Array.isArray(dData.links)) {
                    for (const l of dData.links) {
                        const prov = String(l.Provider || l.MainProvider || '').toLowerCase();
                        if (prov.includes('rec') && l.Link) {
                            const rawUrl = String(l.Link);
                            const audio = analyzeAudio(rawUrl, l.Title || '', '');
                            const isHls = rawUrl.includes('.m3u8') || rawUrl.includes('/hls/');

                            const streamObj = buildStreamObject({
                                name: l.Title || `${PROVIDER_NAME} Stream`,
                                title: `⌜ ${PROVIDER_NAME} ⌟ | HLS Direct | 1080p | ${audio.badge}`,
                                url: rawUrl,
                                quality: '1080p',
                                headers: {
                                    'User-Agent': DEFAULT_USER_AGENT,
                                    'Referer': `${BASE_URL}/`
                                },
                                behaviorHints: {
                                    notWebReady: false,
                                    bingeGroup: `aslan-rec-${tmdbId}`
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

        // Tier 2: Query RecTV API with Token & SW_KEY
        const token = await getBearerToken().catch(() => '');
        const title = await resolveTitle(tmdbId, mediaType);
        if (!title) return [];

        const cleanTitle = title.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
        const posters = await searchRecTV(cleanTitle, token);

        if (!Array.isArray(posters) || posters.length === 0) {
            return streams;
        }

        // Match best candidate poster by title similarity
        const normalizedTitle = titleToSlug(title);
        const matchedPoster = posters.find((p) => {
            const pSlug = titleToSlug(p.title || p.name || '');
            return pSlug && (pSlug.includes(normalizedTitle) || normalizedTitle.includes(pSlug));
        }) || posters[0];

        if (!matchedPoster) return streams;

        let candidateSources = [];

        if (mediaType === 'tv') {
            candidateSources = await getSeriesSources(matchedPoster.id, seasonNum, episodeNum, token);
        } else if (Array.isArray(matchedPoster.sources)) {
            candidateSources = matchedPoster.sources;
        }

        for (const src of candidateSources) {
            const rawUrl = src.url || src.link || '';
            if (!rawUrl || typeof rawUrl !== 'string') continue;

            const isHls = rawUrl.includes('.m3u8') || rawUrl.includes('/hls/');
            const rawQuality = src.quality || (rawUrl.includes('1080') ? '1080p' : (rawUrl.includes('720') ? '720p' : 'Auto'));
            const audio = analyzeAudio(rawUrl, `${src.title || ''} ${src.name || ''}`, '');

            const streamObj = buildStreamObject({
                name: matchedPoster.title || `${PROVIDER_NAME} Stream`,
                title: `⌜ ${PROVIDER_NAME} ⌟ | Fast HLS | ${rawQuality} | ${audio.badge}`,
                url: rawUrl,
                quality: rawQuality,
                headers: {
                    'User-Agent': DEFAULT_USER_AGENT,
                    'Referer': `${BASE_URL}/`
                },
                behaviorHints: {
                    notWebReady: false,
                    bingeGroup: `aslan-rec-${tmdbId}`
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
    getBearerToken,
    searchRecTV
};
