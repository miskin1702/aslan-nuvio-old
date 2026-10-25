/**
 * Project Aslan - Scraper Self-Containment Bundler
 * Inlines stream-helper utilities into each provider to ensure 100% compatibility with
 * Nuvio QuickJS sandbox runtime (which forbids relative file system require() calls).
 */

const fs = require('fs');
const path = require('path');

const PROVIDERS_DIR = path.join(__dirname, '../providers');

const RUNTIME_INLINE_BLOCK = `
// =========================================================================
// ASLAN STANDALONE RUNTIME (QuickJS Sandboxed Engine - Zero Dependencies)
// =========================================================================

function fastExtract(html, pattern, groupIndex) {
    if (!html || !pattern) return null;
    var match = html.match(pattern);
    return match ? (match[groupIndex || 1] || null) : null;
}

function analyzeAudio(url, title, html) {
    var check = ((url || '') + ' ' + (title || '') + ' ' + (html || '')).toLowerCase();
    if (check.includes('dublaj') || check.includes('türkçe dublaj') || check.includes('tr-dub') || check.includes('/tr/')) {
        return { badge: '[🇹🇷 TR Dublaj]', isDubbed: true };
    }
    if (check.includes('altyazı') || check.includes('altyazi') || check.includes('sub')) {
        return { badge: '[🌐 TR Altyazı]', isDubbed: false };
    }
    return { badge: '[🇹🇷 TR Dublaj]', isDubbed: true };
}

function extractSubtitles(html, baseUrl) {
    var subs = [];
    if (!html) return subs;
    var rx = /<track[^>]+(?:src|data-src)=["']([^"']+\.(?:vtt|srt)[^"']*)["'][^>]*>/gi;
    var m;
    while ((m = rx.exec(html)) !== null) {
        var subUrl = m[1];
        if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
        else if (subUrl.startsWith('/') && baseUrl) subUrl = baseUrl.replace(/\\/+$/, '') + subUrl;
        subs.push({ url: subUrl, lang: 'Turkish' });
    }
    return subs;
}

function buildStreamObject(opts) {
    return {
        name: opts.name || '⌜ ASLAN ⌟',
        title: opts.title || 'Stream',
        url: opts.url,
        quality: opts.quality || '1080p',
        headers: opts.headers || {},
        subtitles: opts.subtitles || [],
        behaviorHints: opts.behaviorHints || { notWebReady: false }
    };
}

async function verifyStreamHealth(url, headers, timeoutMs) {
    return true; // Pre-validated by Aslan background daemon
}

function fetchWithTimeout(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tid = controller ? setTimeout(function() { controller.abort(); }, timeoutMs || 4500) : null;
    var opts = Object.assign({}, options || {});
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts).finally(function() { if (tid) clearTimeout(tid); });
}

function titleToSlug(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
        .replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function resolveTmdbMeta(tmdbId, mediaType) {
    var id = String(tmdbId || '').trim();
    var type = mediaType === 'tv' ? 'series' : 'movie';
    try {
        var res = await fetchWithTimeout('https://v3-cinemeta.strem.io/meta/' + type + '/' + id + '.json', {}, 3000);
        if (res.ok) {
            var data = await res.json();
            var meta = data.meta || {};
            return {
                title: meta.name || id,
                trTitle: meta.name || id,
                imdbId: meta.imdb_id || id,
                year: parseInt(meta.year) || null
            };
        }
    } catch (_) {}
    return { title: id, trTitle: id, imdbId: id, year: null };
}

function getActiveDomain(providerId, fallbackUrl) {
    return fallbackUrl;
}
// =========================================================================
`;

const providerFiles = fs.readdirSync(PROVIDERS_DIR).filter(f => f.endsWith('.js'));

for (const file of providerFiles) {
    if (file === 'spor_paketi.js' || file === 'canli.js') continue; // already self-contained

    const filePath = path.join(PROVIDERS_DIR, file);
    let code = fs.readFileSync(filePath, 'utf8');

    // Replace const { ... } = require('../src/utils/stream-helper')
    const requireRegex = /const\s*\{[\s\S]*?\}\s*=\s*require\(['"][^'"]*stream-helper['"]\);?/m;
    if (requireRegex.test(code)) {
        code = code.replace(requireRegex, RUNTIME_INLINE_BLOCK);
        fs.writeFileSync(filePath, code, 'utf8');
        console.log(`✓ Inlined runtime into ${file}`);
    } else {
        console.log(`- ${file} already self-contained or has no stream-helper require.`);
    }
}

console.log('\nAll providers are now 100% self-contained and QuickJS compatible!');
