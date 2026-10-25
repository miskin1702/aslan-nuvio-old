/**
 * Project Aslan - High-Performance Stream Utilities & Micro-Parser
 * Reference: NVIDIA Shield TV Pro Optimization (64-bit V8, <1ms regex parse budget)
 * Zero-Server-Dependency: Client-Side Execution Engine
 */

'use strict';

if (typeof require !== 'undefined') {
    try {
        const dns = require('dns');
        if (dns && typeof dns.setDefaultResultOrder === 'function') {
            dns.setDefaultResultOrder('ipv4first');
        }
    } catch (_) {}
}
const fs = typeof require !== 'undefined' ? require('fs') : null;
const path = typeof require !== 'undefined' ? require('path') : null;

let cachedActiveDomains = null;
let lastDomainRead = 0;
const ACTIVE_DOMAINS_FILE = (path && typeof __dirname !== 'undefined')
    ? path.join(__dirname, '../../data/active-domains.json')
    : null;

/**
 * Returns the current verified working domain for a provider, or falls back to default.
 * @param {string} providerId - Provider identifier (e.g. 'dizipal', 'hdfilmcehennemi')
 * @param {string} fallbackUrl - Default base URL
 * @returns {string} Active base URL
 */
function getActiveDomain(providerId, fallbackUrl) {
    const now = Date.now();
    if (cachedActiveDomains && (now - lastDomainRead < 30000)) {
        return cachedActiveDomains[providerId]?.url || fallbackUrl;
    }
    try {
        if (fs && ACTIVE_DOMAINS_FILE && fs.existsSync(ACTIVE_DOMAINS_FILE)) {
            cachedActiveDomains = JSON.parse(fs.readFileSync(ACTIVE_DOMAINS_FILE, 'utf8'));
            lastDomainRead = now;
            return cachedActiveDomains[providerId]?.url || fallbackUrl;
        }
    } catch (_) {}
    return fallbackUrl;
}


const KNOWN_TMDB_MAP = {
    '533535': { title: 'Deadpool & Wolverine', trTitle: 'Deadpool & Wolverine', imdbId: 'tt6263850', year: 2024 },
    '27205': { title: 'Inception', trTitle: 'Başlangıç', imdbId: 'tt1375666', year: 2010 },
    '1396': { title: 'Breaking Bad', trTitle: 'Breaking Bad', imdbId: 'tt0903747', year: 2008 },
    '550': { title: 'Fight Club', trTitle: 'Dövüş Kulübü', imdbId: 'tt0137523', year: 1999 },
    '1399': { title: 'Game of Thrones', trTitle: 'Taht Oyunları', imdbId: 'tt0944947', year: 2011 },
    '425127': { title: 'Hope', trTitle: 'Hope', imdbId: 'tt27369017', year: 2026 },
    '157336': { title: 'Interstellar', trTitle: 'Yıldızlararası', imdbId: 'tt0816692', year: 2014 },
    '680': { title: 'Pulp Fiction', trTitle: 'Ucuz Roman', imdbId: 'tt0110912', year: 1994 }
};

/**
 * Resolves TMDB ID to media metadata (Title, Turkish Title, IMDb ID, Year).
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier or IMDb ID
 * @param {'movie'|'tv'} [mediaType='movie'] - Media category
 * @returns {Promise<{ title: string, trTitle: string, imdbId: string, year: number|null }>}
 */
async function resolveTmdbMeta(tmdbId, mediaType = 'movie') {
    const idStr = String(tmdbId || '').trim();
    if (!idStr) {
        return { title: '', trTitle: '', imdbId: '', year: null };
    }

    if (KNOWN_TMDB_MAP[idStr]) {
        return Object.assign({}, KNOWN_TMDB_MAP[idStr]);
    }

    const typeEndpoint = mediaType === 'tv' ? 'series' : 'movie';

    if (idStr.startsWith('tt')) {
        try {
            const res = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${typeEndpoint}/${idStr}.json`, {}, 2500);
            if (res.ok) {
                const data = await res.json();
                const name = data?.meta?.name || '';
                const year = parseInt(data?.meta?.year, 10) || null;
                return { title: name, trTitle: name, imdbId: idStr, year };
            }
        } catch (_) {}
        return { title: idStr, trTitle: idStr, imdbId: idStr, year: null };
    }

    try {
        const res = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${typeEndpoint}/${idStr}.json`, {}, 2500);
        if (res.ok) {
            const data = await res.json();
            const name = data?.meta?.name || '';
            const imdb = data?.meta?.imdb_id || '';
            const year = parseInt(data?.meta?.year, 10) || null;
            return { title: name, trTitle: name, imdbId: imdb, year };
        }
    } catch (_) {}

    return { title: idStr, trTitle: idStr, imdbId: '', year: null };
}

/**
 * Validates whether a candidate stream object strictly adheres to the Nuvio Stream schema.
 *
 * @param {object} stream - Stream object
 * @returns {{ valid: boolean, errors: Array<string> }}
 */
function validateNuvioStream(stream) {
    const errors = [];
    if (!stream || typeof stream !== 'object') {
        return { valid: false, errors: ['Stream must be a valid non-null object'] };
    }

    if (typeof stream.name !== 'string' || !stream.name.trim()) {
        errors.push('stream.name must be a non-empty string');
    }
    if (typeof stream.title !== 'string' || !stream.title.trim()) {
        errors.push('stream.title must be a non-empty string');
    }
    if (typeof stream.url !== 'string' || !/^https?:\/\//i.test(stream.url.trim())) {
        errors.push('stream.url must be a valid http/https URL string');
    }
    if (stream.quality && !['4K', '2160p', '1080p', '720p', '480p', 'Auto'].includes(stream.quality)) {
        errors.push(`invalid quality value: ${stream.quality}`);
    }
    if (stream.headers && (typeof stream.headers !== 'object' || Array.isArray(stream.headers))) {
        errors.push('stream.headers must be a dictionary object');
    }
    if (!Array.isArray(stream.subtitles)) {
        errors.push('stream.subtitles must be an array');
    } else {
        for (let i = 0; i < stream.subtitles.length; i++) {
            const sub = stream.subtitles[i];
            if (!sub || typeof sub !== 'object') {
                errors.push(`subtitles[${i}] must be an object`);
            } else if (!sub.url || typeof sub.url !== 'string' || !/^https?:\/\//i.test(sub.url)) {
                errors.push(`subtitles[${i}].url must be a valid http/https URL string`);
            }
        }
    }
    if (!stream.behaviorHints || typeof stream.behaviorHints !== 'object' || Array.isArray(stream.behaviorHints)) {
        errors.push('stream.behaviorHints must be an object');
    }

    return { valid: errors.length === 0, errors };
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * Fast Regex Micro-Parser without full DOM parsing overhead.
 * Eliminates Cheerio / JSDOM allocations for <1ms execution on Tegra X1+.
 *
 * @param {string} html - Raw HTML or text payload to inspect.
 * @param {RegExp|string} pattern - Regular expression or pattern string.
 * @param {number|null} [groupIndex=1] - Capture group index (1-based, or null/0 for full match / all matches).
 * @returns {string|Array<string>|null} Extracted string, array of strings, or null if no match.
 */
function fastExtract(html, pattern, groupIndex = 1) {
    if (typeof html !== 'string' || !html || !pattern) {
        return null;
    }

    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    if (regex.global) {
        const matches = [];
        let match;
        // Reset lastIndex for reuse
        regex.lastIndex = 0;
        while ((match = regex.exec(html)) !== null) {
            if (groupIndex === null || groupIndex === 0) {
                matches.push(match[0]);
            } else if (match[groupIndex] !== undefined) {
                matches.push(match[groupIndex]);
            } else {
                matches.push(match[0]);
            }
        }
        return matches.length > 0 ? matches : [];
    }

    const match = regex.exec(html);
    if (!match) {
        return null;
    }

    if (groupIndex === null || groupIndex === 0) {
        return match[0] || null;
    }

    return match[groupIndex] !== undefined ? match[groupIndex] : match[0];
}

/**
 * Analyzes URL, title, and HTML context to accurately tag audio language.
 *
 * @param {string} [url=''] - Media stream URL.
 * @param {string} [title=''] - Stream title or player label.
 * @param {string} [html=''] - Contextual HTML snippet around stream link.
 * @returns {{ badge: string, tag: string, isDubbed: boolean, isSubtitled: boolean, isDual: boolean, isOriginal: boolean }}
 */
function analyzeAudio(url = '', title = '', html = '') {
    const haystack = `${url} ${title} ${html}`.toLowerCase();

    const dualPattern = /\b(dual|cift-ses|çift[- ]?ses|multi[- ]?audio|multi)\b|dublaj\s*[\+&]\s*altyaz[ıi]/i;
    const dubPattern = /\b(tr[-_]?dublaj|turkce[-_]?dublaj|türkçe[-_]?dublaj|dublaj|dil=0|turkish[-_]?dub|ses[:\s]*tr)\b/i;
    const subPattern = /\b(tr[-_]?altyaz[ıi]|turkce[-_]?altyaz[ıi]|türkçe[-_]?altyaz[ıi]|altyaz[ıi]|dil=1|turkish[-_]?sub|sub[:\s]*tr|subtitles)\b/i;

    const isDual = dualPattern.test(haystack);
    const isDubbed = dubPattern.test(haystack);
    const isSubtitled = subPattern.test(haystack);

    if (isDual || (isDubbed && isSubtitled)) {
        return {
            badge: '[Dual Audio]',
            tag: 'Dual (Dublaj + Altyazı)',
            isDubbed: true,
            isSubtitled: true,
            isDual: true,
            isOriginal: false
        };
    }

    if (isDubbed) {
        return {
            badge: '[🇹🇷 TR Dublaj]',
            tag: 'Türkçe Dublaj',
            isDubbed: true,
            isSubtitled: false,
            isDual: false,
            isOriginal: false
        };
    }

    if (isSubtitled) {
        return {
            badge: '[🌐 TR Altyazı]',
            tag: 'Türkçe Altyazılı',
            isDubbed: false,
            isSubtitled: true,
            isDual: false,
            isOriginal: false
        };
    }

    return {
        badge: '[EN Orijinal]',
        tag: 'Orijinal Dil',
        isDubbed: false,
        isSubtitled: false,
        isDual: false,
        isOriginal: true
    };
}

/**
 * Extracts embedded WebVTT / SRT subtitle tracks from HTML iframe or player markup.
 *
 * @param {string} html - HTML markup or player script content.
 * @param {string} [baseUrl=''] - Base URL for relative path resolution.
 * @returns {Array<{ id: string, lang: string, label: string, url: string }>} Subtitle track descriptors.
 */
function extractSubtitles(html, baseUrl = '') {
    if (typeof html !== 'string' || !html) {
        return [];
    }

    const subtitles = [];
    const seenUrls = new Set();

    // 1. Scan HTML5 <track> tags: <track kind="subtitles" src="..." srclang="tr" label="Türkçe">
    const trackTagRegex = /<track\b[^>]*>/gi;
    let trackMatch;

    while ((trackMatch = trackTagRegex.exec(html)) !== null) {
        const tag = trackMatch[0];
        const srcMatch = tag.match(/\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
        if (!srcMatch || !srcMatch[1]) continue;

        let trackUrl = srcMatch[1].trim();
        if (trackUrl.startsWith('//')) {
            trackUrl = 'https:' + trackUrl;
        } else if (!trackUrl.startsWith('http://') && !trackUrl.startsWith('https://') && baseUrl) {
            try {
                trackUrl = new URL(trackUrl, baseUrl).href;
            } catch (e) {
                // Ignore invalid URL
            }
        }

        if (seenUrls.has(trackUrl)) continue;

        const langMatch = tag.match(/\b(?:srclang|lang)\s*=\s*["']([^"']+)["']/i);
        const labelMatch = tag.match(/\blabel\s*=\s*["']([^"']+)["']/i);

        let lang = (langMatch ? langMatch[1] : '').toLowerCase();
        let label = labelMatch ? labelMatch[1] : '';

        if (!lang) {
            if (/tur|tr|türkçe|turkce/i.test(label) || /tur|tr/i.test(trackUrl)) {
                lang = 'tr';
                label = label || 'Türkçe';
            } else if (/eng|en|english/i.test(label) || /eng|en/i.test(trackUrl)) {
                lang = 'en';
                label = label || 'English';
            } else {
                lang = 'tr';
                label = label || 'Altyazı';
            }
        } else {
            if (lang === 'tr' || lang === 'tur') {
                label = label || 'Türkçe';
            } else if (lang === 'en' || lang === 'eng') {
                label = label || 'English';
            }
        }

        seenUrls.add(trackUrl);
        subtitles.push({
            id: lang,
            lang: lang === 'tr' ? 'Turkish' : (lang === 'en' ? 'English' : lang),
            label: label,
            url: trackUrl
        });
    }

    // 2. Scan JSON player configs: tracks: [{ file: "...", label: "Turkish", kind: "thumbnails/captions" }]
    const jsonTrackRegex = /\{[^{}]*?"file"\s*:\s*"([^"]+\.(?:vtt|srt)[^"]*)"[^{}]*?\}/gi;
    let jsonMatch;

    while ((jsonMatch = jsonTrackRegex.exec(html)) !== null) {
        const snippet = jsonMatch[0];
        const fileMatch = snippet.match(/"file"\s*:\s*"([^"]+)"/i);
        if (!fileMatch) continue;

        let trackUrl = fileMatch[1].replace(/\\/g, '').trim();
        if (trackUrl.startsWith('//')) {
            trackUrl = 'https:' + trackUrl;
        } else if (!trackUrl.startsWith('http://') && !trackUrl.startsWith('https://') && baseUrl) {
            try {
                trackUrl = new URL(trackUrl, baseUrl).href;
            } catch (e) {
                // Ignore invalid URL
            }
        }

        if (seenUrls.has(trackUrl)) continue;

        const labelMatch = snippet.match(/"label"\s*:\s*"([^"]+)"/i);
        const kindMatch = snippet.match(/"kind"\s*:\s*"([^"]+)"/i);

        if (kindMatch && /thumbnails/i.test(kindMatch[1])) {
            continue; // Skip video preview scrub thumbnails
        }

        let label = labelMatch ? labelMatch[1] : '';
        let lang = 'tr';

        if (/eng|english/i.test(label) || /eng\.(?:vtt|srt)/i.test(trackUrl)) {
            lang = 'en';
            label = label || 'English';
        } else {
            label = label || 'Türkçe';
        }

        seenUrls.add(trackUrl);
        subtitles.push({
            id: lang,
            lang: lang === 'tr' ? 'Turkish' : 'English',
            label: label,
            url: trackUrl
        });
    }

    return subtitles;
}

/**
 * Fast pre-flight HTTP verification to eliminate 404, 403, and dead streams.
 * Shield TV Pro Budget: <= 2500ms timeout per candidate link.
 *
 * @param {string} url - Target stream endpoint URL.
 * @param {Record<string, string>} [headers={}] - Optional request headers (Referer, User-Agent, Origin).
 * @param {number} [timeoutMs=2500] - Hard deadline timeout in milliseconds.
 * @returns {Promise<boolean>} True if stream returns 2xx or 3xx; false if dead or timed out.
 */
async function verifyStreamHealth(url, headers = {}, timeoutMs = 2500) {
    if (typeof url !== 'string' || !url.startsWith('http')) {
        return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const mergedHeaders = Object.assign({
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': '*/*'
    }, headers);

    try {
        // Attempt fast HEAD check
        const response = await fetch(url, {
            method: 'HEAD',
            headers: mergedHeaders,
            signal: controller.signal,
            redirect: 'follow'
        });

        clearTimeout(timeoutId);

        // 405 Method Not Allowed: Some CDNs block HEAD, try Range GET
        if (response.status === 405) {
            return await verifyRangeGet(url, mergedHeaders, timeoutMs);
        }

        return response.status >= 200 && response.status < 400;
    } catch (e) {
        clearTimeout(timeoutId);
        // Fallback check on abort or HEAD rejection if not network failure
        return false;
    }
}

/**
 * Fallback Range GET check for CDNs that reject HTTP HEAD requests with 405.
 *
 * @private
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function verifyRangeGet(url, headers, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(timeoutMs, 2000));

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: Object.assign({}, headers, { 'Range': 'bytes=0-1' }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response.status === 200 || response.status === 206 || response.status === 302;
    } catch (e) {
        clearTimeout(timeoutId);
        return false;
    }
}

/**
 * Normalizes quality string into standard format: 4K, 1080p, 720p, 480p, Auto.
 *
 * @param {string} quality - Raw quality indicator.
 * @returns {string} Normalized quality.
 */
function normalizeQuality(quality) {
    if (!quality) return 'Auto';
    const q = String(quality).toLowerCase();
    if (/2160|4k|uhd/i.test(q)) return '4K';
    if (/1080|fhd/i.test(q)) return '1080p';
    if (/720|hd/i.test(q)) return '720p';
    if (/480|sd/i.test(q)) return '480p';
    return 'Auto';
}

/**
 * Builds and normalizes a Nuvio-compliant Stream Object.
 *
 * @param {object} params
 * @param {string} params.name - Media title (e.g., Movie or Series title).
 * @param {string} params.title - Formatted stream card label.
 * @param {string} params.url - Direct video stream or HLS playlist URL.
 * @param {string} [params.quality='Auto'] - Video quality level (4K, 1080p, 720p, etc.).
 * @param {Record<string, string>} [params.headers] - HTTP playback headers.
 * @param {Array<object>} [params.subtitles] - Subtitle tracks.
 * @param {object} [params.behaviorHints] - Playback hints.
 * @returns {object} Formatted Nuvio Stream Object.
 */
function buildStreamObject({
    name = 'Stream',
    title = '',
    url,
    quality = 'Auto',
    headers = {},
    subtitles = [],
    behaviorHints = {}
}) {
    if (!url || typeof url !== 'string') {
        throw new Error('buildStreamObject requires a valid stream URL string.');
    }

    const audioInfo = analyzeAudio(url, title);
    let finalTitle = title ? title.trim() : '';

    // If title doesn't already contain an audio badge, append the detected audio badge
    if (!finalTitle.includes('[') && !finalTitle.includes('Dublaj') && !finalTitle.includes('Altyazı')) {
        finalTitle = finalTitle ? `${finalTitle} | ${audioInfo.badge}` : audioInfo.badge;
    }

    const normalizedQuality = normalizeQuality(quality);

    const mergedHeaders = Object.assign({
        'User-Agent': DEFAULT_USER_AGENT
    }, headers);

    const defaultBehaviorHints = Object.assign({
        notWebReady: false
    }, behaviorHints);

    return {
        name: String(name),
        title: finalTitle,
        url: url.trim(),
        quality: normalizedQuality,
        headers: mergedHeaders,
        subtitles: Array.isArray(subtitles) ? subtitles : [],
        behaviorHints: defaultBehaviorHints
    };
}

/**
 * Resilient fetch with customizable timeout for zero-server execution.
 *
 * @param {string} url - Target URL.
 * @param {RequestInit} [options={}] - Standard fetch options.
 * @param {number} [timeoutMs=8000] - Timeout in milliseconds.
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const opts = Object.assign({}, options, {
        signal: controller.signal
    });

    return fetch(url, opts).finally(() => {
        clearTimeout(timeoutId);
    });
}

/**
 * Converts Turkish characters and special symbols to an ASCII slug.
 *
 * @param {string} text - Raw title string.
 * @returns {string} URL-safe slug.
 */
function titleToSlug(text) {
    if (!text || typeof text !== 'string') return '';
    return text.toLowerCase()
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
        .replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/â/g, 'a').replace(/û/g, 'u').replace(/î/g, 'i')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Module export for CommonJS and browser/Nuvio sandbox support
const StreamHelper = {
    DEFAULT_USER_AGENT,
    fastExtract,
    analyzeAudio,
    extractSubtitles,
    verifyStreamHealth,
    buildStreamObject,
    normalizeQuality,
    fetchWithTimeout,
    titleToSlug,
    resolveTmdbMeta,
    validateNuvioStream,
    getActiveDomain,
    KNOWN_TMDB_MAP
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = StreamHelper;
}

if (typeof globalThis !== 'undefined') {
    globalThis.StreamHelper = StreamHelper;
}
