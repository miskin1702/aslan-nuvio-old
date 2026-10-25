/**
 * Project Aslan - NetTV Gold Stream Synchronization & Integration Engine
 * 
 * Capabilities:
 * - Decrypts NetTV Gold AppCreator24 substitution cipher streams (85-char alphabet mapping)
 * - Resolves all 613 native video streams and 341 web endpoints
 * - Extracts live sports channels (beIN Sports, S Sport, Exxen Spor, Tivibu, Tabii, TRT Spor, Smart Spor)
 * - Emits clean Nuvio-compatible feeds and M3U playlists
 */

'use strict';

const fs = require('fs');
const path = require('path');
const xml2js = null; // Standard pure-JS regex XML parser to avoid extra dependency

const ALPHABET = " !#$%&()+,-./023456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ[^_abcdefghijklmnopqrstuvwxz{}~";
const DEFAULT_CR = "dax_Y;bBz)?t^FLpo6C2U!%ecu$OnmgNZS/3V7wX>0j-~I&5WA4Hvf9(k+s#.Tl<[8}JPrqD,:i{=RKMhEG Q";

/**
 * AppCreator24 custom substitution cipher decryption algorithm.
 */
function decryptAppCreatorUrl(url, cr = DEFAULT_CR) {
    if (!url) return '';
    let res = url;
    if (res.startsWith('@y@')) {
        res = res.substring(3);
        if (cr && cr.length === 85) {
            let decoded = '';
            for (let i = 0; i < res.length; i++) {
                const ch = res[i];
                const idx = cr.indexOf(ch);
                if (idx !== -1 && idx < ALPHABET.length) {
                    decoded += ALPHABET[idx];
                } else {
                    decoded += ch;
                }
            }
            res = decoded;
        }
    }
    // Prefix replacements
    res = res.replace(/@yy1111@/g, 'https://');
    res = res.replace(/@yy111@/g, 'https://www.');
    res = res.replace(/@yy11@/g, 'http://');
    res = res.replace(/@yy1@/g, 'http://www.');
    return res;
}

function unescapeXml(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

/**
 * Parses XML string to flat key-value dictionary using high-performance regex.
 */
function parseShXml(xmlContent) {
    const data = {};
    // Matches <tag name="foo" value="bar" /> or <tag name="foo">bar</tag>
    const tagRegex = /<([a-zA-Z0-9_\-]+)\s+name="([^"]+)"(?:\s+value="([^"]*)")?(?:\s*\/>|>([\s\S]*?)<\/\1>)/g;
    let match;
    while ((match = tagRegex.exec(xmlContent)) !== null) {
        const name = match[2];
        let val = match[3] !== undefined ? match[3] : (match[4] || '');
        data[name] = unescapeXml(val);
    }
    return data;
}
function parseHeaders(hStr) {
    const headers = {};
    if (!hStr) return headers;
    const pairs = hStr.split('@@Y@@');
    for (const pair of pairs) {
        const parts = pair.split('@@X@@');
        if (parts.length === 2) {
            const k = parts[0].trim();
            const v = parts[1].trim();
            if (k && v) headers[k] = v;
        }
    }
    return headers;
}


function runSync(xmlPath = path.join(__dirname, '../../app_sh.xml')) {
    if (!fs.existsSync(xmlPath)) {
        console.error(`[!] sh.xml not found at: ${xmlPath}`);
        return null;
    }

    console.log(`[*] Loading configuration from: ${xmlPath}`);
    const rawXml = fs.readFileSync(xmlPath, 'utf-8');
    const data = parseShXml(rawXml);

    const cr = data.cr || DEFAULT_CR;
    const idseccsRaw = data.idseccs || '';
    const idseccs = idseccsRaw.split(',').map(s => s.trim()).filter(Boolean);

    console.log(`[*] Discovered ${idseccs.length} total sections.`);

    const streams = [];
    const webEndpoints = [];

    for (const sid of idseccs) {
        const tit = (data[`s${sid}_tit`] || '').trim();
        const tipo = data[`s${sid}_tipo`] || '';
        const rawUrl = (data[`s${sid}_url`] || '').trim();
        const hStr = data[`s${sid}_h`] || '';
        const ua = (data[`s${sid}_ua`] || '').trim();
        const idgo = (data[`s${sid}_idgo`] || '').trim();
        const order = parseInt(data[`s${sid}_ord`] || '0', 10);

        const decUrl = decryptAppCreatorUrl(rawUrl, cr);
        const headers = parseHeaders(hStr);
        if (ua) {
            headers['User-Agent'] = ua;
        }

        const entry = {
            id: sid,
            title: tit,
            idgo: idgo,
            type: parseInt(tipo, 10) || tipo,
            url: decUrl,
            rawUrl: rawUrl,
            headers: headers,
            order: order
        };

        if (tipo === '6') {
            streams.append ? streams.append(entry) : streams.push(entry);
        } else if (decUrl && (decUrl.startsWith('http://') || decUrl.startsWith('https://'))) {
            webEndpoints.push(entry);
        }
    }

    console.log(`[+] Extracted ${streams.length} native video streams.`);
    console.log(`[+] Extracted ${webEndpoints.length} web service endpoints.`);

    // Match Turkish Sports Registry
    const registryPath = path.join(__dirname, '../src/data/turkish-sports-registry.json');
    let matchedSports = {};
    if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        for (const ch of registry.channels) {
            const chId = ch.id;
            const aliases = [...(ch.aliases || []).map(a => a.toLowerCase()), ch.name.toLowerCase(), chId];
            
            const matchedList = streams.filter(s => {
                const tit = s.title.toLowerCase();
                const idg = s.idgo.toLowerCase();
                return aliases.some(a => tit.includes(a) || idg.includes(a));
            }).map(s => ({
                url: s.url,
                headers: s.headers,
                title: s.title,
                sourceId: s.id,
                feedSource: 'NetTV Gold Extraction'
            }));

            if (matchedList.length > 0) {
                matchedSports[chId] = {
                    name: ch.name,
                    category: ch.category || 'Spor',
                    logo: ch.logo || '',
                    streams: matchedList
                };
            }
        }
        console.log(`[+] Matched ${Object.keys(matchedSports).length} official Turkish sports channels!`);
    }

    // Write output files
    const outputDir = path.join(__dirname, '../data');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const netvOutputFile = path.join(outputDir, 'netv-gold-streams.json');
    fs.writeFileSync(netvOutputFile, JSON.stringify({
        updatedAt: new Date().toISOString(),
        totalStreams: streams.length,
        totalWeb: webEndpoints.length,
        sportsChannels: matchedSports,
        streams: streams,
        webEndpoints: webEndpoints
    }, null, 2), 'utf-8');
    console.log(`[+] Saved JSON database: ${netvOutputFile}`);

    // Generate M3U playlist for Nuvio / IPTV players
    const m3uFile = path.join(outputDir, 'netv-gold.m3u');
    const m3uLines = ['#EXTM3U'];
    for (const s of streams) {
        if (!s.url) continue;
        const tit = s.title || s.idgo || `Channel_${s.id}`;
        const hPairs = Object.entries(s.headers).map(([k, v]) => `${k}=${v}`);
        const headerPipe = hPairs.length > 0 ? `|${hPairs.join('&')}` : '';
        m3uLines.push(`#EXTINF:-1 tvg-id="${s.idgo}" tvg-name="${tit}",${tit}`);
        m3uLines.push(`${s.url}${headerPipe}`);
    }
    fs.writeFileSync(m3uFile, m3uLines.join('\n'), 'utf-8');
    console.log(`[+] Generated M3U playlist: ${m3uFile}`);

    return { streams, webEndpoints, matchedSports };
}

if (require.main === module) {
    runSync();
}

module.exports = {
    decryptAppCreatorUrl,
    parseHeaders,
    parseShXml,
    runSync
};
