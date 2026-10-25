"""
Inat Box / Inat TV Stream Extraction Engine & Diagnostic Architecture
Reverse engineered from inat.apk (com.bp.box)
"""

import sys
import json
import time
import base64
import secrets
import hashlib
import hmac
import urllib.request
import urllib.error
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding

# ==============================================================================
# Cryptographic Constants & Hardcoded Keys (Extracted from libmain.so & DEX)
# ==============================================================================

# Obfuscated Base PEM URL on GitHub
PEM_URL = "https://raw.githubusercontent.com/cencbit/ssl/main/certificate.pem"

# Layer 1 & 2 Keys extracted from libmain.so and certificate bootstrap
KEY_PEM_B64 = b"YTRvc2E4eDF5bDR3M3Zyaw==" # base64 for 'a4osa8x1yl4w3vrk'
KEY_PEM_LAYER1 = base64.b64decode(KEY_PEM_B64)

# Root HMAC & Layer 2 AES key derived by deriveHmk() in libmain.so
HMK_KEY = b"x7kkk0qmqz63jkj68tla517u26i92v7zqnnqddhjm"
KEY_JSON_LAYER2 = b"x7kkk0qmqz63jkj6"

DEFAULT_UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.100 Mobile Safari/537.36"
DEFAULT_REFERER = "https://google.com/"


# ==============================================================================
# Helper Functions: AES CBC Decryption & Request Signing
# ==============================================================================

def decrypt_aes_cbc(key: bytes, ciphertext: bytes, iv: bytes) -> bytes:
    """Standard AES-CBC decryption with PKCS7 unpadding."""
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    raw = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return unpadder.update(raw) + unpadder.finalize()


def q63_p_decrypt(key_str: str, payload_str: str) -> str:
    """
    Implements method Lq63;->p(String key, String ciphertext).
    Uses ISO-8859-1 encoding for key normalization and UTF-8 for final plaintext.
    """
    # Key normalization to exactly 16 bytes using '0' padding or truncation
    if len(key_str) < 16:
        key_str = key_str + ("0" * (16 - len(key_str)))
    elif len(key_str) > 16:
        key_str = key_str[:16]

    parts = payload_str.strip().split(":")
    if len(parts) < 2:
        raise ValueError(f"Invalid payload format (expected 'CIPHERTEXT:IV'): {payload_str[:50]}")

    cipher_bytes = base64.b64decode(parts[0])
    iv_bytes = base64.b64decode(parts[1])
    key_bytes = key_str.encode("iso-8859-1")

    decrypted_bytes = decrypt_aes_cbc(key_bytes, cipher_bytes, iv_bytes)
    return decrypted_bytes.decode("utf-8", errors="replace")


def generate_hmac_headers(method: str, path: str, body: bytes = b"") -> dict:
    """
    Implements Ly41;->c HMAC-SHA256 request interceptor.
    Canonical string: METHOD + '\n' + PATH + '\n' + TIMESTAMP + '\n' + NONCE + '\n' + BODY_SHA256
    """
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)  # 32 lowercase hex characters
    body_sha256 = hashlib.sha256(body).hexdigest()

    canonical = f"{method.upper()}\n{path}\n{ts}\n{nonce}\n{body_sha256}"
    signature = hmac.new(HMK_KEY, canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    return {
        "X-Ts": ts,
        "X-Nc": nonce,
        "X-Sg": signature,
        "User-Agent": DEFAULT_UA,
        "Referer": DEFAULT_REFERER,
        "X-Requested-With": "XMLHttpRequest"
    }


# ==============================================================================
# Core Resolution Pipelines
# ==============================================================================

def fetch_root_config() -> dict:
    """
    Downloads and decrypts the root configuration from certificate.pem.
    """
    req = urllib.request.Request(PEM_URL, headers={"User-Agent": "speedrestapi"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        pem_text = resp.read().decode("utf-8").strip()

    # Strip PEM framing if present
    clean_b64 = pem_text.replace("-----BEGIN CERTIFICATE-----", "")\
                        .replace("-----END CERTIFICATE-----", "")\
                        .replace("\r", "").replace("\n", "").strip()

    parts = clean_b64.split(":")
    raw_cipher = base64.b64decode(parts[0])
    raw_iv = base64.b64decode(parts[1])

    # Layer 1 Decryption
    dec1 = decrypt_aes_cbc(KEY_PEM_LAYER1, raw_cipher, raw_iv).decode("latin-1")

    # Layer 2 Decryption
    parts2 = dec1.split(":")
    raw_cipher2 = base64.b64decode(parts2[0])
    raw_iv2 = base64.b64decode(parts2[1])

    json_str = decrypt_aes_cbc(KEY_JSON_LAYER2, raw_cipher2, raw_iv2).decode("utf-8")
    return json.loads(json_str)


def fetch_sports_channels(base_url: str = "https://sprboxs.bar") -> list:
    """
    Fetches and decrypts the sports channels catalogue from spor_v3.php.
    """
    path = "/CDN/001/SPR/v2/spor_v3.php"
    url = f"{base_url}{path}"
    headers = generate_hmac_headers("GET", path)

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw_text = resp.read().decode("utf-8").strip()

    # Outer AES layer with KEY_PEM_LAYER1
    parts1 = raw_text.split(":")
    d1 = decrypt_aes_cbc(KEY_PEM_LAYER1, base64.b64decode(parts1[0]), base64.b64decode(parts1[1])).decode("latin-1")

    # Inner AES layer with KEY_JSON_LAYER2
    parts2 = d1.split(":")
    json_bytes = decrypt_aes_cbc(KEY_JSON_LAYER2, base64.b64decode(parts2[0]), base64.b64decode(parts2[1]))
    return json.loads(json_bytes.decode("utf-8"))


def resolve_channel_stream(channel_obj: dict) -> str:
    """
    Resolves the live stream URL for a given channel object using the q63 pipeline.
    """
    ch_url = channel_obj.get("cUrl", "")
    ch_reg_raw = channel_obj.get("cReg", "[]")
    reg_list = json.loads(ch_reg_raw) if isinstance(ch_reg_raw, str) else ch_reg_raw

    if not reg_list:
        return ch_url

    reg_entry = reg_list[0]
    regex1 = reg_entry.get("Regex1", "")
    regex2 = reg_entry.get("Regex2", "")
    regex2p = reg_entry.get("Regex2p", "")
    host = reg_entry.get("Host", "")

    # Extract URL path for HMAC calculation
    # e.g., 'https://str.sprboxs.bar/CLF2/?static=cer' -> '/CLF2/'
    url_path = urllib.parse.urlparse(ch_url).path
    headers = generate_hmac_headers("GET", url_path)
    if host:
        headers["Host"] = host

    # Retrieve encrypted token
    req = urllib.request.Request(ch_url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        encrypted_token = resp.read().decode("utf-8").strip()

    # Layer 1 decryption (Regex1)
    layer1_out = q63_p_decrypt(regex1, encrypted_token)

    # Layer 2 decryption (Regex2 or fallback to Regex2p)
    try:
        layer2_out = q63_p_decrypt(regex2, layer1_out)
    except Exception:
        layer2_out = q63_p_decrypt(regex2p, layer1_out)

    # Verification / Signature stripping (Ly41;->d)
    # The last 64 characters contain HMAC-SHA256 checksum; the prefix is the target stream URL
    if len(layer2_out) > 64:
        stream_url = layer2_out[:-64]
    else:
        stream_url = layer2_out

    return stream_url


if __name__ == "__main__":
    print("[*] Inat Box Reverse Engineering Diagnostic Engine")
    try:
        print("[+] Fetching root configuration...")
        root_cfg = fetch_root_config()
        print(f"[+] Root Config Active: DC1={root_cfg.get('DC1')}, DC5(IP)={root_cfg.get('DC5')}")
    except Exception as e:
        print(f"[-] Root config fetch failed: {e}")

    try:
        print("[+] Fetching sports channels...")
        channels = fetch_sports_channels()
        print(f"[+] Successfully fetched {len(channels)} sports channels.")
        for idx, ch in enumerate(channels[:5]):
            print(f"    [{idx+1}] {ch.get('chName')} ({ch.get('chType')}) -> {ch.get('cUrl')}")
    except Exception as e:
        print(f"[-] Sports channel fetch failed (Cloudflare 1106 / Firewall): {e}")
