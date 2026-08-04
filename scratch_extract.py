"""
Pure-Python Snappy decompressor + LevelDB SSTable reader.
No external dependencies.
"""

import struct, json, os

# ── Snappy decompressor ──────────────────────────────────────────────────────

def _read_pvarint(src, pos):
    result = shift = 0
    while True:
        b = src[pos]; pos += 1
        result |= (b & 0x7f) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7

def snappy_decompress(src):
    pos = 0
    ulen, pos = _read_pvarint(src, pos)
    dst = bytearray(ulen)
    dpos = 0
    while pos < len(src):
        tag = src[pos]; pos += 1
        ttype = tag & 3
        if ttype == 0:   # literal
            llen = tag >> 2
            if llen < 60:
                length = llen + 1
            elif llen == 60:
                length = src[pos] + 1; pos += 1
            elif llen == 61:
                length = struct.unpack_from('<H', src, pos)[0] + 1; pos += 2
            elif llen == 62:
                length = (src[pos] | src[pos+1]<<8 | src[pos+2]<<16) + 1; pos += 3
            else:
                length = struct.unpack_from('<I', src, pos)[0] + 1; pos += 4
            dst[dpos:dpos+length] = src[pos:pos+length]; pos += length; dpos += length
        elif ttype == 1:  # copy 1-byte offset
            length = ((tag >> 2) & 7) + 4
            offset = ((tag & 0xe0) << 3) | src[pos]; pos += 1
            for i in range(length):
                dst[dpos] = dst[dpos - offset]; dpos += 1
        elif ttype == 2:  # copy 2-byte offset
            length = (tag >> 2) + 1
            offset = struct.unpack_from('<H', src, pos)[0]; pos += 2
            for i in range(length):
                dst[dpos] = dst[dpos - offset]; dpos += 1
        else:              # copy 4-byte offset
            length = (tag >> 2) + 1
            offset = struct.unpack_from('<I', src, pos)[0]; pos += 4
            for i in range(length):
                dst[dpos] = dst[dpos - offset]; dpos += 1
    return bytes(dst)

# ── LevelDB SSTable (LDB) reader ─────────────────────────────────────────────
# Format: sequence of data blocks + index block + footer(48 bytes)
# Footer: metaindex_handle + index_handle + padding + magic(8)

MAGIC = 0xdb4775248b80fb57

def _read_varint(data, pos):
    result = shift = 0
    while True:
        b = data[pos]; pos += 1
        result |= (b & 0x7f) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7

def _read_block_handle(data, pos):
    offset, pos = _read_varint(data, pos)
    size, pos = _read_varint(data, pos)
    return offset, size, pos

def _read_block(raw, offset, size):
    """Read a block: [size bytes of data][1 byte type][4 byte crc]"""
    block_data = raw[offset:offset+size]
    btype = raw[offset+size]  # 0=raw, 1=snappy
    if btype == 1:
        block_data = snappy_decompress(block_data)
    return block_data

def _parse_block_entries(block):
    """Parse restart-compressed block into key-value pairs."""
    # Last 4 bytes = num_restarts
    num_restarts = struct.unpack_from('<I', block, len(block)-4)[0]
    restart_offset = len(block) - 4 - 4*num_restarts
    entries = {}
    pos = 0
    last_key = b''
    while pos < restart_offset:
        shared, pos = _read_varint(block, pos)
        non_shared, pos = _read_varint(block, pos)
        value_len, pos = _read_varint(block, pos)
        key_suffix = block[pos:pos+non_shared]; pos += non_shared
        key = last_key[:shared] + key_suffix
        value = block[pos:pos+value_len]; pos += value_len
        last_key = key
        try:
            entries[key.decode('utf-8', errors='replace')] = value
        except:
            pass
    return entries

def read_ldb(path):
    with open(path, 'rb') as f:
        raw = f.read()
    # Footer is last 48 bytes
    footer = raw[-48:]
    magic = struct.unpack_from('<Q', footer, 40)[0]
    if magic != MAGIC:
        raise ValueError(f'Not an LDB file (magic={magic:#x})')
    # Read index block handle from footer (after metaindex handle)
    pos = 0
    _meta_off, _meta_sz, pos = _read_block_handle(footer, pos)
    idx_off, idx_sz, _ = _read_block_handle(footer, pos)
    # Read index block
    idx_block = _read_block(raw, idx_off, idx_sz)
    idx_entries = _parse_block_entries(idx_block)
    # Read each data block referenced by the index
    all_entries = {}
    for _key, handle_bytes in idx_entries.items():
        try:
            off, sz, _ = _read_block_handle(handle_bytes, 0)
            block = _read_block(raw, off, sz)
            all_entries.update(_parse_block_entries(block))
        except Exception as e:
            pass
    return all_entries

# ── Main ─────────────────────────────────────────────────────────────────────

EXT_STORAGE = './chrome-profile/Default/Local Extension Settings/cfjpddcmpplojnkejafaddjflcejnckc/'

all_kv = {}
for fname in sorted(os.listdir(EXT_STORAGE)):
    if not fname.endswith('.ldb'):
        continue
    path = os.path.join(EXT_STORAGE, fname)
    try:
        entries = read_ldb(path)
        print(f'{fname}: {len(entries)} entries')
        all_kv.update(entries)
    except Exception as e:
        print(f'{fname}: ERROR {e}')

print(f'\nTotal keys: {len(all_kv)}')
for k in sorted(all_kv.keys()):
    v = all_kv[k]
    print(f'  {k!r:.80} -> {v[:60]!r}')

# Find the crop dataset key
for k, v in all_kv.items():
    if 'iNatCrop' in k or 'review_status' in v.decode('utf-8', errors='replace')[:200]:
        print(f'\n*** DATASET KEY FOUND: {k}')
        text = v.decode('utf-8', errors='replace')
        print(text[:500])
        # Save full data
        with open('dataset_records.json', 'w') as f:
            f.write(text)
        print(f'Saved {len(text)} chars to dataset_records.json')
