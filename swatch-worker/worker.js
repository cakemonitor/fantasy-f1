export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;

    if (path === '/') {
      return Response.redirect(`${origin}/808080`, 302);
    }

    if (path === '/favicon.ico') {
      return new Response(null, { status: 404 });
    }

    const imgMatch = path.match(/^\/img\/([^/]+)$/);
    if (imgMatch) {
      const hex = parseHex(imgMatch[1]);
      if (!hex) return new Response('Bad Request', { status: 400 });
      return handleImage(hex);
    }

    const pageMatch = path.match(/^\/([^/]+)$/);
    if (pageMatch) {
      const hex = parseHex(pageMatch[1]);
      if (!hex) return new Response('Bad Request', { status: 400 });
      return handlePage(hex, origin);
    }

    return new Response('Not Found', { status: 404 });
  },
};

function parseHex(raw) {
  const s = raw.replace(/^#/, '');
  if (s.length === 3 && /^[0-9a-fA-F]{3}$/.test(s)) {
    return s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (s.length === 6 && /^[0-9a-fA-F]{6}$/.test(s)) {
    return s.toLowerCase();
  }
  return null;
}

function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function getContrastColor(r, g, b) {
  const toLinear = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.179 ? '#000000' : '#ffffff';
}

async function handleImage(hex) {
  const [r, g, b] = hexToRgb(hex);
  const png = await buildPng(r, g, b, 400, 400);
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function buildPng(r, g, b, width, height) {
  // Raw IDAT: height rows, each row = 1 filter byte (0) + width*3 RGB bytes
  const rawSize = height * (1 + width * 3);
  const raw = new Uint8Array(rawSize);
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[i++] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      raw[i++] = r;
      raw[i++] = g;
      raw[i++] = b;
    }
  }

  // Compress with zlib (deflate stream = RFC 1950, which PNG requires)
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB
  // bytes 10-12 are zero (compression, filter, interlace)
  const ihdrChunk = buildChunk('IHDR', ihdrData);

  const idatChunk = buildChunk('IDAT', new Uint8Array(compressed));
  const iendChunk = buildChunk('IEND', new Uint8Array(0));

  const totalLen = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const part of [sig, ihdrChunk, idatChunk, iendChunk]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function buildChunk(typeStr, data) {
  const type = new TextEncoder().encode(typeStr);
  const len = data.length;
  const chunk = new Uint8Array(4 + 4 + len + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, len);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcBytes = new Uint8Array(4 + len);
  crcBytes.set(type, 0);
  crcBytes.set(data, 4);
  view.setUint32(8 + len, crc32(crcBytes));
  return chunk;
}

function crc32(bytes) {
  // Build table
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function handlePage(hex, origin) {
  const [r, g, b] = hexToRgb(hex);
  const fg = getContrastColor(r, g, b);
  const upper = hex.toUpperCase();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team colour #${upper}</title>
<meta property="og:title" content="Team colour #${upper}">
<meta property="og:description" content="Tap to pick your own colour and share it with the group">
<meta property="og:image" content="${origin}/img/${hex}">
<meta property="og:image:width" content="400">
<meta property="og:image:height" content="400">
<meta property="og:image:type" content="image/png">
<meta property="og:url" content="${origin}/${hex}">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #${hex};
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 24px;
}
#hex-label {
  font-size: clamp(2rem, 8vw, 4rem);
  font-weight: 700;
  letter-spacing: 0.05em;
  color: ${fg};
  font-variant-numeric: tabular-nums;
}
.card {
  background: rgba(15,17,23,0.85);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 340px;
  backdrop-filter: blur(8px);
}
.picker-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
input[type="color"] {
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 6px;
  padding: 2px;
  cursor: pointer;
  background: #1e2029;
  flex-shrink: 0;
}
input[type="text"] {
  flex: 1;
  height: 44px;
  background: #1e2029;
  border: 1px solid #333;
  border-radius: 6px;
  color: #fff;
  font-size: 1rem;
  padding: 0 12px;
  font-family: inherit;
  text-transform: uppercase;
}
input[type="text"]:focus { outline: none; border-color: #e8002d; }
.btn-row {
  display: flex;
  gap: 8px;
}
.btn {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn-primary {
  background: #e8002d;
  color: #fff;
}
.btn-secondary {
  background: transparent;
  color: #ccc;
  border: 1px solid #444;
}
</style>
</head>
<body>
<div id="hex-label">#${upper}</div>
<div class="card">
  <div class="picker-row">
    <input type="color" id="picker" value="#${hex}">
    <input type="text" id="hex-input" value="${upper}" maxlength="7" placeholder="Hex colour">
  </div>
  <div class="btn-row">
    <button class="btn btn-primary" id="copy-btn">Copy link</button>
    <button class="btn btn-secondary" id="share-btn" style="display:none">Share</button>
  </div>
</div>
<script>
const picker = document.getElementById('picker');
const hexInput = document.getElementById('hex-input');
const hexLabel = document.getElementById('hex-label');
const copyBtn = document.getElementById('copy-btn');
const shareBtn = document.getElementById('share-btn');

let currentHex = '${hex}';

if (navigator.share) shareBtn.style.display = '';

function toLinear(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function getContrastLive(hex6) {
  const n = parseInt(hex6, 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.179 ? '#000000' : '#ffffff';
}

function applyHex(hex6) {
  currentHex = hex6;
  document.body.style.background = '#' + hex6;
  hexLabel.textContent = '#' + hex6.toUpperCase();
  hexLabel.style.color = getContrastLive(hex6);
}

picker.addEventListener('input', () => {
  const hex6 = picker.value.replace('#', '');
  hexInput.value = hex6.toUpperCase();
  applyHex(hex6);
});

hexInput.addEventListener('input', () => {
  let val = hexInput.value.replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(val)) {
    picker.value = '#' + val;
    applyHex(val);
  }
});

copyBtn.addEventListener('click', () => {
  const url = location.origin + '/' + currentHex;
  navigator.clipboard.writeText(url).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
  });
});

shareBtn.addEventListener('click', () => {
  navigator.share({ title: 'My team colour', url: location.origin + '/' + currentHex });
});
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
