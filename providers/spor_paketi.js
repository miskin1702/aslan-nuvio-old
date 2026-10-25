/**
 * Project Aslan - Pure Turkish Sports Package Provider (Nuvio Extension)
 * 
 * Delivers verified, low-latency, freeze-free Turkish sports channels.
 * Automatically serves the highest-scoring stream as primary,
 * while grouping alternative feeds underneath for one-click manual fallback.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VERIFIED_DATA_PATH = path.join(__dirname, '../data/verified-sports.json');
const REGISTRY_PATH = path.join(__dirname, '../src/data/turkish-sports-registry.json');

let cachedDatabase = null;
let lastCacheRead = 0;
const CACHE_TTL_MS = 60000; // In-memory cache for 60 seconds

function loadVerifiedDatabase() {
    const now = Date.now();
    if (cachedDatabase && (now - lastCacheRead < CACHE_TTL_MS)) {
        return cachedDatabase;
    }

    try {
        if (fs.existsSync(VERIFIED_DATA_PATH)) {
            const raw = fs.readFileSync(VERIFIED_DATA_PATH, 'utf8');
            cachedDatabase = JSON.parse(raw);
            lastCacheRead = now;
            return cachedDatabase;
        }
    } catch (_) {}

    // Fallback to registry if verified data is not yet generated
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
            const fallbackDb = {
                updatedAt: new Date().toISOString(),
                channels: {}
            };
            for (const chan of registry.channels) {
                fallbackDb.channels[chan.id] = {
                    id: chan.id,
                    name: chan.name,
                    formattedStreams: (chan.defaultStreams || []).map((url, idx) => ({
                        name: '⌜ ASLAN SPOR ⌟',
                        title: idx === 0 ? `[★ EN İYİ PERFORMANS] ${chan.name}` : `[KAYNAK ${idx + 1}] ${chan.name}`,
                        url: url,
                        quality: '1080p',
                        isLive: true,
                        headers: {}
                    }))
                };
            }
            return fallbackDb;
        }
    } catch (_) {}

    return { channels: {} };
}

function resolveChannelKey(targetId) {
    if (!targetId) return null;
    const clean = targetId.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').trim();
    const db = loadVerifiedDatabase();

    // Exact ID match
    if (db.channels[clean]) return clean;

    // Search by name / alias match
    for (const [key, chan] of Object.entries(db.channels)) {
        const chanNameClean = (chan.name || '').toLowerCase();
        if (chanNameClean.includes(targetId.toLowerCase()) || targetId.toLowerCase().includes(key)) {
            return key;
        }
    }
    return null;
}

/**
 * Main Nuvio Provider Entry Point
 * @param {string} channelId - Canonical channel ID or query name
 * @param {string} mediaType - 'tv' or 'live'
 */
async function getStreams(channelId, mediaType = 'tv') {
    const db = loadVerifiedDatabase();
    const key = resolveChannelKey(channelId);

    if (!key || !db.channels[key]) {
        // Return default top sports stream if no specific channel is provided
        const firstActive = Object.values(db.channels).find(c => c.formattedStreams && c.formattedStreams.length > 0);
        if (firstActive) {
            return firstActive.formattedStreams.map(s => toNuvioStream(s));
        }
        return [];
    }

    const channelData = db.channels[key];
    const streams = channelData.formattedStreams || [];

    if (streams.length === 0) {
        return [];
    }

    // Convert to normalized Nuvio Stream Schema
    return streams.map(s => toNuvioStream(s));
}

function toNuvioStream(s) {
    return {
        name: s.name || '⌜ ASLAN SPOR ⌟',
        title: s.title,
        url: s.url,
        quality: s.quality || '1080p',
        headers: s.headers || {},
        behaviorHints: {
            isLive: true,
            notWebReady: false
        }
    };
}

/**
 * Export channel list for Nuvio Live Catalog & EPG
 */
function getChannelCatalog() {
    const db = loadVerifiedDatabase();
    return Object.values(db.channels).map(c => ({
        id: c.id,
        name: c.name,
        category: c.category || 'Spor',
        logo: c.logo || '',
        activeStreamsCount: (c.formattedStreams || []).length
    }));
}

module.exports = {
    getStreams,
    getChannelCatalog,
    loadVerifiedDatabase
};
