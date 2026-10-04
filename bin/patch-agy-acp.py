#!/usr/bin/env python3

import argparse
import dis
import importlib.util
import marshal
import os
import shutil
import stat
import struct
import tempfile
import types
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_ACP_FILE = Path.home() / ".local/opt/agy-acp/current/agy_acp_server.par"
MODULE_DIR = "google3/cloud/developer_experience/antigravity_extensions/acp_server/"
SOURCE_PATH = MODULE_DIR + "client_info.py"
SOURCE_LINE = b'      name=_text(raw, "name"),'
ZED_LINE = b"      name='zed',"


def patch_source(source: bytes) -> bytes:
    if source.count(SOURCE_LINE) == 1:
        ret = source.replace(SOURCE_LINE, ZED_LINE + b"\n" * (len(SOURCE_LINE) - len(ZED_LINE)), 1)
    elif source.count(ZED_LINE) == 1 and SOURCE_LINE not in source:
        return source
    else:
        raise ValueError("Unrecognized client_info.py identity parser; no patch applied")
    compile(ret, SOURCE_PATH, "exec")
    return ret


def patch_bytecode(payload: bytes, source: bytes) -> bytes:
    if len(payload) < 16 or payload[:4] != importlib.util.MAGIC_NUMBER:
        raise ValueError("Run this script with the CPython version matching the ACP's packaged bytecode")
    module = marshal.loads(payload[16:])
    if not isinstance(module, types.CodeType):
        raise ValueError("Invalid ACP bytecode module")
    constants = list(module.co_consts)
    parser_indices = [
        index for index, value in enumerate(constants)
        if isinstance(value, types.CodeType) and value.co_name == "parse"
    ]
    if len(parser_indices) != 1:
        raise ValueError("Unrecognized compiled identity parser")
    parser_index = parser_indices[0]
    parser = constants[parser_index]
    instructions = list(dis.get_instructions(parser))
    constructors = [
        index for index, item in enumerate(instructions)
        if item.opname == "LOAD_GLOBAL" and item.argval == "ClientInfo"
    ]
    if len(constructors) != 1:
        raise ValueError("Unrecognized compiled ClientInfo construction")
    expression_index = constructors[0] + 1
    first = instructions[expression_index]
    header = bytearray(payload[:16])
    flags = struct.unpack_from("<I", header, 4)[0]
    if flags not in (0, 1, 3):
        raise ValueError("Unrecognized Python bytecode header")
    if flags & 1:
        header[8:16] = importlib.util.source_hash(source)
    if first.opname == "LOAD_CONST" and first.argval == "zed":
        return bytes(header) + payload[16:]

    segment = instructions[expression_index:expression_index + 5]
    if (
        len(segment) != 5
        or [item.opname for item in segment]
        != ["LOAD_GLOBAL", "LOAD_FAST_BORROW", "LOAD_CONST", "CALL", "LOAD_GLOBAL"]
        or segment[0].argval != "_text"
        or segment[1].argval != "raw"
        or segment[2].argval != "name"
        or segment[3].arg != 2
        or segment[4].argval != "_text"
    ):
        raise ValueError("Compiled identity parser differs from the expected name lookup")
    constant_index = segment[2].arg
    if constant_index is None or constant_index > 255:
        raise ValueError("Unsupported client-name bytecode constant")
    start_offset = segment[0].offset
    end_offset = segment[4].offset
    if (end_offset - start_offset) % 2:
        raise ValueError("Unexpected bytecode instruction alignment")
    bytecode = bytearray(parser.co_code)
    bytecode[start_offset:end_offset] = (
        bytes([dis.opmap["LOAD_CONST"], constant_index])
        + bytes([dis.opmap["NOP"], 0]) * ((end_offset - start_offset - 2) // 2)
    )
    parser_constants = list(parser.co_consts)
    parser_constants[constant_index] = "zed"
    constants[parser_index] = parser.replace(co_code=bytes(bytecode), co_consts=tuple(parser_constants))
    ret = bytes(header) + marshal.dumps(module.replace(co_consts=tuple(constants)))
    if len(ret) != len(payload):
        raise ValueError("Compiled patch would change the PAR layout; no patch applied")
    return ret


def rewrite_member(acp_file: Path, member_name: str, original: bytes, replacement: bytes) -> None:
    if len(original) != len(replacement):
        raise ValueError("ZIP member size must remain unchanged")
    with zipfile.ZipFile(acp_file) as archive:
        target = archive.getinfo(member_name)
        if archive.read(target) != original:
            raise ValueError("ACP changed during patch preparation")
        if target.compress_type != zipfile.ZIP_STORED or target.flag_bits & 0x08:
            raise ValueError("Only stored ZIP members without data descriptors are supported")
        entries = archive.infolist()
        central_start = archive.start_dir

    with acp_file.open("r+b") as binary:
        binary.seek(target.header_offset)
        local_header = binary.read(30)
        if len(local_header) != 30 or local_header[:4] != b"PK\x03\x04":
            raise ValueError("Invalid local ZIP header")
        name_length, extra_length = struct.unpack_from("<HH", local_header, 26)
        if binary.read(name_length) != member_name.encode("ascii"):
            raise ValueError("Unexpected local ZIP member name")
        data_offset = target.header_offset + 30 + name_length + extra_length
        if struct.unpack_from("<III", local_header, 14) != (
            target.CRC, target.compress_size, target.file_size
        ):
            raise ValueError("Local ZIP metadata does not match the directory")

        binary.seek(central_start)
        central_crc_offset = None
        for entry in entries:
            entry_offset = binary.tell()
            central_header = binary.read(46)
            if len(central_header) != 46 or central_header[:4] != b"PK\x01\x02":
                raise ValueError("Invalid central ZIP header")
            name_length, extra_length, comment_length = struct.unpack_from("<HHH", central_header, 28)
            name = binary.read(name_length)
            binary.seek(extra_length + comment_length, os.SEEK_CUR)
            if entry is target:
                if name != member_name.encode("ascii"):
                    raise ValueError("Unexpected central ZIP member name")
                central_crc_offset = entry_offset + 16
                break
        if central_crc_offset is None:
            raise ValueError("ZIP member missing from the central directory")

        crc_bytes = struct.pack("<I", zlib.crc32(replacement) & 0xFFFFFFFF)
        binary.seek(data_offset)
        binary.write(replacement)
        binary.seek(target.header_offset + 14)
        binary.write(crc_bytes)
        binary.seek(central_crc_offset)
        binary.write(crc_bytes)
        binary.flush()
        os.fsync(binary.fileno())
    with zipfile.ZipFile(acp_file) as archive:
        if archive.read(member_name) != replacement:
            raise ValueError("Patched ZIP member failed verification")


def patch_acp(acp_file: Path) -> None:
    acp_file = acp_file.resolve(strict=True)
    original_stat = acp_file.stat()
    if not acp_file.is_file() or not os.access(acp_file, os.X_OK):
        raise ValueError("ACP target must be an executable file")
    with zipfile.ZipFile(acp_file) as archive:
        source = archive.read(SOURCE_PATH)
        bytecode_names = [
            name for name in archive.namelist()
            if name.startswith(MODULE_DIR + "__pycache__/client_info.") and name.endswith(".pyc")
        ]
        if len(bytecode_names) != 1:
            raise ValueError("Expected exactly one packaged client_info bytecode module")
        bytecode_name = bytecode_names[0]
        bytecode = archive.read(bytecode_name)
    patched_source = patch_source(source)
    patched_bytecode = patch_bytecode(bytecode, patched_source)
    changes = [
        (name, original, replacement)
        for name, original, replacement in (
            (SOURCE_PATH, source, patched_source),
            (bytecode_name, bytecode, patched_bytecode),
        )
        if original != replacement
    ]
    if not changes:
        print(f"Already patched to assume Zed: {acp_file}")
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = acp_file.with_name(f"{acp_file.name}.bak.{timestamp}")
    shutil.copy2(acp_file, backup)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{acp_file.name}.patch.", dir=acp_file.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(acp_file, temporary)
        for name, original, replacement in changes:
            rewrite_member(temporary, name, original, replacement)
        if temporary.stat().st_size != original_stat.st_size:
            raise ValueError("PAR file size changed unexpectedly")
        if os.geteuid() == 0:
            os.chown(backup, original_stat.st_uid, original_stat.st_gid)
            os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
        os.chmod(temporary, stat.S_IMODE(original_stat.st_mode))
        os.replace(temporary, acp_file)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Patched ACP to assume Zed: {acp_file}")
    print(f"Backup: {backup}")
    print(f"PAR layout and file size preserved ({original_stat.st_size} bytes).")


def main() -> int:
    parser = argparse.ArgumentParser(description="Patch only Antigravity ACP's client identity to Zed.")
    parser.add_argument("acp_file", nargs="?", type=Path, default=DEFAULT_ACP_FILE)
    arguments = parser.parse_args()
    try:
        patch_acp(arguments.acp_file)
    except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error)) from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
