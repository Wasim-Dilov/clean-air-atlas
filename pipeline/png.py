"""Minimal RGBA PNG writer (stdlib zlib), so the pipeline needs no imaging library."""

from __future__ import annotations

import struct
import zlib

import numpy as np


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def encode_rgba(img: np.ndarray) -> bytes:
    """Encode an (H, W, 4) uint8 array as a PNG."""
    if img.dtype != np.uint8 or img.ndim != 3 or img.shape[2] != 4:
        raise ValueError("expected an (H, W, 4) uint8 array")
    h, w, _ = img.shape
    raw = np.empty((h, 1 + w * 4), dtype=np.uint8)
    raw[:, 0] = 0  # filter type: none
    raw[:, 1:] = img.reshape(h, w * 4)
    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header)
            + _chunk(b"IDAT", zlib.compress(raw.tobytes(), 9)) + _chunk(b"IEND", b""))


def decode_rgba(data: bytes) -> np.ndarray:
    """Decode a PNG written by encode_rgba (used by tests)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(h, 1 + w * 4)
    return raw[:, 1:].reshape(h, w, 4).copy()
