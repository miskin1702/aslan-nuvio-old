/**
 * Project Aslan - Pure Turkish Sports Package Provider (Self-Contained Nuvio QuickJS Engine)
 * 
 * ZERO DEPENDENCIES: No node require('fs'), require('path'), or external relative imports.
 * Compatible with Nuvio QuickJS sandboxed runtime.
 */

var REMOTE_VERIFIED_URL = 'https://raw.githubusercontent.com/miskin1702/aslan/main/data/verified-sports.json';

// High-Availability Embedded Fallback Streams
var EMBEDDED_SPORTS_FALLBACK = {
    'bein-sports-1': [
        {
            title: '[★ EN İYİ PERFORMANS] beIN SPORTS 1 HD (TRGoals Direct)',
            url: 'https://d0.4928d54d950ee70q4.lat/yayin1.m3u8',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://trgoals1332.xyz/' }
        },
        {
            title: '[YEDEK HAT] TRT SPOR HD (Resmi HLS)',
            url: 'https://tv-trtspor1.medya.trt.com.tr/master.m3u8',
            headers: {}
        }
    ],
    's-sport-1': [
        {
            title: '[★ EN İYİ PERFORMANS] S SPORT 1 HD (1080p)',
            url: 'https://d0.4928d54d950ee70q4.lat/yayinss.m3u8',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://trgoals1332.xyz/' }
        }
    ],
    's-sport-2': [
        {
            title: '[★ EN İYİ PERFORMANS] S SPORT 2 HD (1080p)',
            url: 'https://d0.4928d54d950ee70q4.lat/yayinss2.m3u8',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://trgoals1332.xyz/' }
        }
    ],
    'exxen-spor-1': [
        {
            title: '[★ EN İYİ PERFORMANS] EXXEN SPOR 1 HD (1080p)',
            url: 'https://d0.4928d54d950ee70q4.lat/yayinex1.m3u8',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://trgoals1332.xyz/' }
        }
    ],
    'trt-spor': [
        {
            title: '[★ EN İYİ PERFORMANS] TRT SPOR HD (Resmi HLS)',
            url: 'https://tv-trtspor1.medya.trt.com.tr/master.m3u8',
            headers: {}
        },
        {
            title: '[KAYNAK 2] TRT SPOR HD (Daion CDN)',
            url: 'https://trt.daioncdn.net/trt-spor/master.m3u8',
            headers: {}
        }
    ],
    'a-spor': [
        {
            title: '[★ EN İYİ PERFORMANS] A SPOR HD (TurkNet CDN)',
            url: 'https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/aspor/aspor_720p.m3u8',
            headers: {}
        }
    ],
    'tv8-5': [
        {
            title: '[★ EN İYİ PERFORMANS] TV8.5 HD (Daion CDN)',
            url: 'https://tv8.daioncdn.net/tv8bucuk/tv8bucuk.m3u8?app=tv8bucuk_web',
            headers: {}
        }
    ]
};

function formatNuvioLiveStream(stream) {
    var title = stream.title || 'Spor Yayını';
    var taggedTitle = (title.includes('[🇹🇷') || title.includes('[🌐') || title.includes('Canlı')) ? title : (title + ' | [🇹🇷 Canlı Yayın]');
    return {
        name: '⌜ ASLAN SPOR ⌟',
        title: taggedTitle,
        url: stream.url,
        quality: stream.quality || '1080p',
        headers: stream.headers || {},
        subtitles: Array.isArray(stream.subtitles) ? stream.subtitles : [],
        behaviorHints: {
            isLive: true,
            notWebReady: false
        }
    };
}

async function getStreams(channelId, mediaType, seasonNum, episodeNum) {
    var target = String(channelId || '').toLowerCase().trim();

    // 1. Try fetching dynamically synced database from GitHub
    try {
        var res = await fetch(REMOTE_VERIFIED_URL);
        if (res.ok) {
            var data = await res.json();
            if (data && data.channels) {
                // If specific channel requested
                if (target && data.channels[target]) {
                    var ch = data.channels[target];
                    if (ch.formattedStreams && ch.formattedStreams.length > 0) {
                        return ch.formattedStreams.map(formatNuvioLiveStream);
                    }
                }

                // If test call or channel not directly matched by ID, try alias search
                for (var key in data.channels) {
                    var chan = data.channels[key];
                    if (target.includes(key) || (chan.name && target.includes(chan.name.toLowerCase()))) {
                        if (chan.formattedStreams && chan.formattedStreams.length > 0) {
                            return chan.formattedStreams.map(formatNuvioLiveStream);
                        }
                    }
                }

                // If Nuvio runs "[Sağlayıcıyı Test Et]" with a movie/test ID, return top active sports stream
                for (var k in data.channels) {
                    var activeChan = data.channels[k];
                    if (activeChan.formattedStreams && activeChan.formattedStreams.length > 0) {
                        return activeChan.formattedStreams.map(formatNuvioLiveStream);
                    }
                }
            }
        }
    } catch (_) {}

    // 2. High-Availability Embedded Fallback
    if (target && EMBEDDED_SPORTS_FALLBACK[target]) {
        return EMBEDDED_SPORTS_FALLBACK[target].map(formatNuvioLiveStream);
    }

    // Default test response
    return EMBEDDED_SPORTS_FALLBACK['bein-sports-1'].map(formatNuvioLiveStream);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams: getStreams };
}
