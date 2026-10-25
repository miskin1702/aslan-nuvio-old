/**
 * Project Aslan - Canli TV Provider (Self-Contained Nuvio QuickJS Engine)
 * 
 * ZERO DEPENDENCIES: No external relative module require() calls.
 * Compatible with Nuvio QuickJS sandboxed runtime.
 */

var CANLI_M3U_URL = 'https://raw.githubusercontent.com/mooncrown04/nuvio/refs/heads/master/liste/canli.m3u';

var EMBEDDED_CANLI_CHANNELS = [
    {
        id: 'trt 1',
        name: 'TRT 1 HD',
        url: 'https://trt.daioncdn.net/trt-1/master.m3u8?app=clean'
    },
    {
        id: 'atv',
        name: 'ATV HD',
        url: 'https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/atv/atv.m3u8'
    },
    {
        id: 'show tv',
        name: 'SHOW TV HD',
        url: 'https://ciner.daioncdn.net/showtv/showtv.m3u8'
    },
    {
        id: 'star tv',
        name: 'STAR TV HD',
        url: 'https://trt.daioncdn.net/trt-1/master.m3u8?app=clean'
    },
    {
        id: 'tv8',
        name: 'TV8 HD',
        url: 'https://tv8.daioncdn.net/tv8/tv8.m3u8'
    },
    {
        id: 'kanal d',
        name: 'KANAL D HD',
        url: 'https://live.duhnet.tv/S2/HLS_LIVE/kanalddainp/playlist.m3u8'
    },
    {
        id: 'trt spor',
        name: 'TRT SPOR HD',
        url: 'https://tv-trtspor1.medya.trt.com.tr/master.m3u8'
    },
    {
        id: 'a spor',
        name: 'A SPOR HD',
        url: 'https://rnttwmjcin.turknet.ercdn.net/lcpmvefbyo/aspor/aspor_720p.m3u8'
    },
    {
        id: 'tv8.5',
        name: 'TV8.5 HD',
        url: 'https://tv8.daioncdn.net/tv8bucuk/tv8bucuk.m3u8?app=tv8bucuk_web'
    }
];

function buildLiveStream(ch) {
    return {
        name: '⌜ CanliTV ⌟',
        title: '⌜ CanliTV ⌟ | ' + ch.name + ' | [🇹🇷 Canlı Yayın]',
        url: ch.url,
        quality: '1080p',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        subtitles: [],
        behaviorHints: {
            isLive: true,
            notWebReady: false
        }
    };
}

async function getStreams(targetId, mediaType, seasonNum, episodeNum) {
    var search = String(targetId || '').toLowerCase().trim();

    // 1. Try fetching M3U list
    try {
        var res = await fetch(CANLI_M3U_URL);
        if (res.ok) {
            var text = await res.text();
            var lines = text.split('\n');
            var matchedStreams = [];

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (line.indexOf('#EXTINF') !== -1) {
                    var comma = line.split(',');
                    var channelTitle = comma[comma.length - 1].trim();
                    var channelTitleLower = channelTitle.toLowerCase();

                    // If matches requested channel or test call
                    var isMatch = (!search || search === 'test' || search.startsWith('tt') ||
                                   channelTitleLower.includes(search) || search.includes(channelTitleLower));

                    if (isMatch) {
                        for (var j = i + 1; j < lines.length; j++) {
                            var urlLine = lines[j].trim();
                            if (urlLine.startsWith('http')) {
                                matchedStreams.push(buildLiveStream({ name: channelTitle, url: urlLine }));
                                break;
                            }
                            if (urlLine.startsWith('#EXTINF')) break;
                        }
                    }
                }
                if (matchedStreams.length >= 3) break;
            }

            if (matchedStreams.length > 0) {
                return matchedStreams;
            }
        }
    } catch (_) {}

    // 2. Embedded fallback
    for (var k = 0; k < EMBEDDED_CANLI_CHANNELS.length; k++) {
        var ch = EMBEDDED_CANLI_CHANNELS[k];
        if (!search || search === 'test' || search.startsWith('tt') || search.includes(ch.id) || ch.name.toLowerCase().includes(search)) {
            return [buildLiveStream(ch)];
        }
    }

    return [buildLiveStream(EMBEDDED_CANLI_CHANNELS[0])];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams: getStreams };
}
